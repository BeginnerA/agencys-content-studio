import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { creationMessages, pipelineRuns, pipelineSteps } from '../../db/schema'
import { engine } from '../../pipeline/engine'
import { CreationError, gateDecisionSchema } from './contract'
import { creationWrite, sessionRow } from './store'
import { assertRecipeSources, recipeOf } from './recipe'
import { loadCreationProjection } from './projection'

/**
 * [M42] 会话侧闸门决策代理（中途审阅暂停，配合 easy-video-review 变体模板）。
 * - 只接受本会话自己的 run（runId + 项目归属双校验）；不改引擎 gate 语义，仅前置校验 + 决策落库留痕
 * - 幂等：同 idempotencyKey 重复提交直接返回，不重复决策（决策消息记 requestKey）
 * - reject = 该阶段整体重做（图片/视频再生成，计费风险由前端二次确认承担）；服务端不承诺"只重做部分镜头"
 * - 决策消息用 system 角色：进对话流展示（store 不过滤），但不混入后续规划的 LLM 消息上下文
 *   （planning 以 role != 'system' 选取 recent，与 initial_draft 同一先例）。
 */
export async function decideCreationGate(id: number, raw: unknown): Promise<void> {
  const request = gateDecisionSchema.parse(raw)
  const prepared = await creationWrite(async () => {
    const s = await sessionRow(id)
    if (!s.runId) throw new CreationError('no_run', '会话尚未开始制作，没有待审阅内容', 409)
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, s.runId))
    if (!run || run.projectId !== s.projectId) throw new CreationError('bad_run', '制作记录归属异常，无法执行审阅决策', 409)
    const prior = await db.select().from(creationMessages)
      .where(and(eq(creationMessages.sessionId, id), eq(creationMessages.requestKey, request.idempotencyKey)))
    if (prior.length) return null
    const [step] = await db.select().from(pipelineSteps)
      .where(and(eq(pipelineSteps.runId, run.id), eq(pipelineSteps.stepKey, request.stepKey)))
    if (run.status !== 'waiting_input' || step?.status !== 'waiting_input') {
      throw new CreationError('not_waiting', `步骤「${request.stepKey}」不在等待审阅状态（当前 ${run.status}），请刷新核对最新进度`, 409)
    }
    const recipe = recipeOf(run)
    const finalDialogue = recipe?.plan.performance === 'dialogue' && step.stepKey === 'compose'
    if (finalDialogue && request.decision === 'approve') {
      await assertRecipeSources(run, recipe)
      const projected = await loadCreationProjection(s, run, [step], [])
      if (!projected.progress.review?.videoId) throw new CreationError('delivery_missing', '本轮成片缺失或未通过对白技术检查，不能批准交付', 409)
    }
    return { runId: run.id, stepTitle: step.title ?? request.stepKey, finalDialogue }
  })
  if (!prepared) return
  try {
    if (request.decision === 'approve') await engine.approveGate(prepared.runId, request.stepKey, { note: request.note })
    else await engine.rejectGate(prepared.runId, request.stepKey, { note: request.note })
  } catch (err) {
    throw new CreationError('gate_failed', `审阅决策未完成（${err instanceof Error ? err.message : '状态已变化'}），请刷新核对当前状态后再重试；本次操作不会自动重复`, 409)
  }
  const content = request.decision === 'approve'
    ? `已按你的审阅继续制作（「${prepared.stepTitle}」通过）。`
    : prepared.finalDialogue
      ? `未接受本轮人物对白：成片和原声已保留，未发起任何生成。可选择局部返修或本地重合成，之后仍需重新审阅。`
      : `已驳回「${prepared.stepTitle}」：该阶段将整体重做，会再次调用图片/视频生成，可能产生费用。`
  await creationWrite(() => db.insert(creationMessages).values({
    sessionId: id, role: 'system', content, requestKey: request.idempotencyKey,
    payload: JSON.stringify({ kind: 'gate', runId: prepared.runId, stepKey: request.stepKey, decision: request.decision, note: request.note ?? null }),
    createdAt: Date.now(),
  }))
}
