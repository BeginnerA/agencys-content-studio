/**
 * chain 段间「对话内批准续跑」（G1）：用户在 chain-await 批准卡点「继续下一段」→ 校验会话链态 →
 * 调编排器 requestNextSegment 单段推进（预算/输入/幂等与自动级联同源）→ 回写对话留痕（可见不静默）。
 * 红线：不新造编排算法、不触碰 easy 批准链；批准动作同受会话态闸（started + workflowId + chain 决策）与编排器下游存在性幂等守卫约束，零新付费面。
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { creationMessages, creationSessions } from '../../db/schema'
import { WorkflowError, requestNextSegment, type AdvanceOutcome } from '../workflow'
import { ContinuityError, ApprovalSchema } from '../continuity/contract'
import { CreationError } from './contract'
import { routeDecisionOf } from './route-execution'
import { creationWrite, sessionRow } from './store'

const advanceSchema = z.object({
  idempotencyKey: z.string().min(8).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  // 下一推进位置的已冻结承接包批准（仅用户请求 schema 接入；批准定位校验在编排器 requestNextSegment 内）
  continuityApproval: ApprovalSchema.optional(),
}).strict()

/**
 * 批准并推进链的下一段。返回 { outcome, runId? }（outcome = advanced|done|blocked|inflight）。
 * 路由层随后回读 creationDetail 刷新 sideCards（chainAwaiting 自然回落）。
 */
export async function advanceChainSegment(id: number, raw: unknown): Promise<{ outcome: AdvanceOutcome['kind']; runId?: number }> {
  const request = advanceSchema.parse(raw)
  void request.idempotencyKey // 契约保留键：并发/连点由编排器下游存在性幂等守卫兜底（不重复建同 seq run、不重复计费）
  const s0 = await sessionRow(id)
  const decision = routeDecisionOf(s0)
  if (!decision || decision.mode !== 'chain') throw new CreationError('not_chain', '当前会话不是链式执行，无需逐段批准', 409)
  if (!s0.workflowId) throw new CreationError('no_workflow', '会话未关联编排链，无法续跑', 409)
  if (s0.status !== 'started') throw new CreationError('bad_state', '仅制作中的链可批准续跑', 409)

  let outcome: AdvanceOutcome
  try {
    // 批准透传给编排器——批准哈希在 requestNextSegment 内绑定 session/workflow/nextSeq/previousRun
    // 定位（assertApprovalMatchesTransition），旧 key 幂等语义不变（同 seq 存在性守卫兜底并发/连点）。
    outcome = await requestNextSegment(s0.workflowId, { continuityApproval: request.continuityApproval })
  } catch (err) {
    if (err instanceof ContinuityError) throw err // 404/409/413 + operationId 原样上抛，不糊成 503
    if (err instanceof WorkflowError) throw new CreationError(err.code, err.message, 409)
    throw new CreationError('chain_advance_failed', err instanceof Error ? err.message : '续跑启动失败', 503)
  }

  await creationWrite(async () => {
    const now = Date.now()
    if (outcome.kind === 'advanced') {
      // 会话 runId 追随当前段 run（进度卡/取消随最新在制段落；链起点 run 已归档于 runHistory 之外不改语义）
      await db.update(creationSessions).set({ runId: outcome.runId, updatedAt: now }).where(eq(creationSessions.id, id))
      await db.insert(creationMessages).values({ sessionId: id, role: 'assistant', agentRole: decision.roleKey, content: `已批准，启动下一段制作（run #${outcome.runId}）。`, payload: JSON.stringify({ kind: 'chain-advance', workflowId: s0.workflowId, runId: outcome.runId }), createdAt: now })
    } else if (outcome.kind === 'done') {
      await db.insert(creationMessages).values({ sessionId: id, role: 'assistant', agentRole: decision.roleKey, content: '全部段落已完成，编排链结束。', payload: JSON.stringify({ kind: 'chain-done', workflowId: s0.workflowId }), createdAt: now })
    } else if (outcome.kind === 'blocked') {
      const why = outcome.reason === 'budget' ? '预算闸门拦截' : outcome.reason === 'input' ? '下一段必填输入未满足' : '段落失败或链状态已变化'
      await db.insert(creationMessages).values({ sessionId: id, role: 'assistant', agentRole: decision.roleKey, content: `未能继续下一段：${why}。请核对后重试，或到链详情处理。`, payload: JSON.stringify({ kind: 'chain-blocked', workflowId: s0.workflowId, reason: outcome.reason }), createdAt: now })
    }
    // inflight：下一段已在途（幂等命中）→ 不落新留痕，避免重复噪声
  })

  return { outcome: outcome.kind, ...(outcome.kind === 'advanced' ? { runId: outcome.runId } : {}) }
}
