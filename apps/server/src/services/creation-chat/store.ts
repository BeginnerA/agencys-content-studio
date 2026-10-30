import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { creationMessages, creationSessions, genTasks, pipelineRuns, pipelineSteps, projects, usageRecords, type CreationSession, type PipelineRun } from '../../db/schema'
import { CreationError, initialDraftSchema } from './contract'
import { jsonRecord, loadCreationProjection } from './projection'
import { planningProgress } from './planning-progress'
import { agentDecisionSchema } from './agent/decision-schema'
import { getRole } from './agent/roles'
import { computeSideCards } from './side-cards'
import { checkBudget } from '../budget'
import { readWorkflowContinuityBlock } from '../continuity/workflow-bridge'
import type { TargetRequest } from '../continuity/contract'
import { getWorkflow, parseSegments, setWorkflowStatus } from '../workflow'

/** 只串行化短数据库操作；模型/媒体调用不占锁。数据库条件更新仍是最终仲裁。 */
let tail: Promise<unknown> = Promise.resolve()
export function creationWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn)
  tail = next.catch(() => undefined)
  return next
}
export async function sessionRow(id: number): Promise<CreationSession> {
  const [session] = await db.select().from(creationSessions).where(eq(creationSessions.id, id))
  if (!session) throw new CreationError('not_found', '创作会话不存在', 404)
  return session
}
export async function activeProject(id: number): Promise<void> {
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt)))
  if (!project) throw new CreationError('project_deleted', '项目不存在或已删除，无法新增制作', 409)
}
export const parseJson = <T>(raw: string | null, fallback: T): T => {
  try { return raw ? JSON.parse(raw) as T : fallback } catch { return fallback }
}

async function runProjection(session: CreationSession, run: PipelineRun) {
  const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, run.id)).orderBy(asc(pipelineSteps.seq))
  const tasks = await db.select().from(genTasks).where(eq(genTasks.runId, run.id))
  return loadCreationProjection(session, run, steps, tasks)
}

export async function creationDetail(id: number) {
  const session = await sessionRow(id)
  const [project] = await db.select().from(projects).where(eq(projects.id, session.projectId))
  const messages = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, id)).orderBy(asc(creationMessages.id))
  const [run] = session.runId ? await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, session.runId)) : []
  const projection = run && run.projectId === session.projectId ? await runProjection(session, run) : null
  const usages = await db.select().from(usageRecords).where(eq(usageRecords.projectId, session.projectId))
  const planning = usages.filter((u) => u.kind === 'llm' && parseJson<Record<string, unknown>>(u.meta, {}).sessionId === id)
  const initial = messages.map((m) => initialDraftSchema.safeParse(jsonRecord(m.payload))).find((p) => p.success)
  // Agent 决策旁注：解析 decision 列；仅 route 形态（mode≠easy）暴露调度语义供 decisionCard 渲染
  const decisionParsed = agentDecisionSchema.safeParse(parseJson<unknown>(session.decision, null))
  const decision = decisionParsed.success ? decisionParsed.data : null
  const decisionMode = decision && decision.mode !== 'easy' ? decision.mode : null
  const preflightReady = parseJson<{ ready?: boolean } | null>(session.preflight, null)?.ready === true
  const confirmable = session.status === 'ready' && preflightReady
  const runStatus = projection?.progress?.status ?? null
  // 纯图片反推交付判定：最新一条 assistant 消息携非空 imageAnalysis（是否抬为右侧成果卡由 computeSideCards 统一按状态门控）
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const lastAssistantPayload = parseJson<{ imageAnalysis?: unknown; kind?: string; questions?: unknown } | null>(lastAssistant?.payload ?? null, null)
  const hasReverseDeliverable = Array.isArray(lastAssistantPayload?.imageAnalysis) && (lastAssistantPayload!.imageAnalysis as unknown[]).length > 0
  // 待你补充态：最新一条 assistant 为 clarify 且携追问（右侧下一步卡据此取代固定 guide）
  const awaitingClarify = lastAssistantPayload?.kind === 'clarify' && Array.isArray(lastAssistantPayload?.questions) && (lastAssistantPayload!.questions as unknown[]).length > 0
  // chain 段间待续跑投影：纯读派生——active 正常等待（既有口径逐字不变）或 paused 且明确 continuity input
  // 阻塞 → 出批准卡（不回写会话态）；budget/failure 一律不伪装待承接。
  let chainAwaiting = false
  let chainContinuityBlock: { code: string; target: Extract<TargetRequest, { kind: 'workflow' }> } | null = null
  if (session.workflowId && decisionMode === 'chain' && session.status === 'started') {
    const wf = await getWorkflow(session.workflowId)
    const wfRuns = wf
      ? await db.select({ seq: pipelineRuns.workflowSeq, status: pipelineRuns.status }).from(pipelineRuns).where(eq(pipelineRuns.workflowId, session.workflowId))
      : []
    if (wf && wf.status === 'active') {
      const total = parseSegments(wf.segments).length
      const startedSeqs = new Set(wfRuns.map((r) => r.seq ?? 0))
      const doneSeqs = wfRuns.filter((r) => r.status === 'completed').map((r) => r.seq ?? 0)
      const maxDone = doneSeqs.length ? Math.max(...doneSeqs) : -1
      chainAwaiting = maxDone >= 0 && maxDone + 1 < total && !startedSeqs.has(maxDone + 1)
    } else if (wf && wf.status === 'paused') {
      // M70：链曾因输入/预算阻塞过 → paused；仅当「最新落定段已完成 + 未熔断 + 只读定位确有 continuity 阻塞」
      // 才视为等待批准。段失败/取消（不自动重试语义）与预算熔断都不得伪装成「待你批准续跑」。
      const settled = [...wfRuns].filter((r) => ['completed', 'failed', 'cancelled'].includes(r.status))
        .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0]
      if (settled && settled.status === 'completed' && !(await checkBudget({ projectId: session.projectId }))) {
        const block = await readWorkflowContinuityBlock(session.projectId, session.workflowId, db)
        if (block) { chainAwaiting = true; chainContinuityBlock = block }
      }
    }
  }
  const sideCards = computeSideCards({
    status: session.status,
    agentMode: session.agentMode === 1,
    decisionMode,
    hasPlan: !!session.plan,
    confirmable,
    workflowId: session.workflowId ?? null,
    chainAwaiting,
    hasRun: !!run,
    runStatus,
    hasReview: !!projection?.progress?.review,
    hasResult: !!projection?.result,
    hasArtifacts: !!projection && (projection.artifacts.documents.length > 0 || projection.artifacts.shots.length > 0),
    hasReverseDeliverable,
    awaitingClarify,
  })
  return {
    session: {
      id, projectId: session.projectId, status: session.status, plan: parseJson(session.plan, null),
      planRevision: session.planRevision, planHash: session.planHash, preflight: parseJson(session.preflight, null),
      runId: session.runId, runHistory: parseJson(session.runHistory, []), error: session.error,
      // Agent 化旁注：agentMode 标记新会话；decision 为归一后权威决策（含 roleKey/team/rationale/各模式执行体），legacy 无 decision 时为 null
      agentMode: session.agentMode === 1, decision,
      // route 确认闸真源：decisionHash 参与确认（语义同 planHash，改动即作废旧确认）；easy/legacy 为 null
      decisionHash: session.decisionHash ?? null,
      workflowId: session.workflowId ?? null,
      // chain 段间待批投影：awaiting = active 正常等待或 paused 且明确 continuity input 阻塞；
      // continuityBlock 仅 paused 阻塞时携带（code + 待批目标签名），active 等待/熔断/失败恒为 null
      chainAwaiting,
      chainContinuityBlock,
      // 规划在途进度（内存旁信道）：阶段 + 已进行秒数；非 planning 态恒为 null，不残留旧进度
      planning: session.status === 'planning' ? planningProgress(id) : null,
      initialDraft: initial?.success && initial.data.deferPlanning ? { content: initial.data.content, requestKey: initial.data.requestKey } : null,
      createdAt: session.createdAt, updatedAt: session.updatedAt, projectDeleted: !project || project.deletedAt !== null,
      // 立项预览：未转正项目以 draft 影子态存在（不进项目列表），确认时才写入完整信息并转正
      project: project
        ? {
            id: project.id, name: project.name, genre: project.genre, templateKey: project.templateKey,
            tags: parseJson<string[]>(project.tags, []), brief: project.brief ?? '',
            status: project.status, isDraft: project.status === 'draft' && project.deletedAt === null,
          }
        : null,
    },
    // 角色署名：助手消息带 agentRole（注册表 key）+ roleName（中文名）；无角色的历史消息两者皆 null，前端回落「策划助手」
    messages: messages.filter((m) => jsonRecord(m.payload).kind !== 'initial_draft').map((m) => ({ id: m.id, role: m.role, content: m.content, payload: parseJson(m.payload, null), requestKey: m.requestKey, agentRole: m.agentRole ?? null, roleName: m.agentRole ? getRole(m.agentRole)?.name ?? null : null, createdAt: m.createdAt })),
    planningUsage: { cost: planning.reduce((n, u) => n + (u.cost ?? 0), 0), unpriced: planning.filter((u) => u.cost === null).length },
    progress: projection?.progress ?? null,
    artifacts: projection?.artifacts ?? { shots: [], documents: [] },
    result: projection?.result ?? null,
    // 服务端权威卡片流：前端组件注册表按序渲染，显隐裁决权在后端
    sideCards,
  }
}

export async function listCreationSessions() {
  const rows = await db.select({ session: creationSessions, name: projects.name, run: pipelineRuns }).from(creationSessions)
    .innerJoin(projects, and(eq(projects.id, creationSessions.projectId), isNull(projects.deletedAt)))
    // 会话 status 是控制态（started 后不回写）；带出 run 真实状态供列表派生「已完成/失败/取消」显示
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, creationSessions.runId))
    .orderBy(desc(creationSessions.updatedAt)).limit(100)
  return Promise.all(rows.map(async ({ session, name, run }) => ({
    id: session.id, projectId: session.projectId, name, status: session.status, runId: session.runId, updatedAt: session.updatedAt,
    runStatus: run?.projectId !== session.projectId ? null : run.status === 'completed' ? (await runProjection(session, run)).progress.status : run.status,
    // 「待确认」须真的可确认：status=ready 但预检未过（缺配置/超预算）时置 false，前端据此改显「待完善配置」，不再误导
    confirmable: session.status === 'ready' && parseJson<{ ready?: boolean } | null>(session.preflight, null)?.ready === true,
  })))
}

export async function notifyCreationSettled(runId: number): Promise<void> {
  await db.update(creationSessions).set({ updatedAt: Date.now() }).where(eq(creationSessions.runId, runId))
  await notifyChainSegmentAwaiting(runId)
}

/**
 * chain 段间「待续跑批准」留痕：编排 run 落定（completed）且属 autoAdvance=0 对话链、仍有后续段时，
 * 向所属创作会话追加一条「第 n 段已完成·待批准」助手消息（幂等：同 workflow+seq 只落一条）。
 * 纯 creation-chat 层旁路，不改编排器核心（advanceWorkflow 对 autoAdvance=0 仅发段完成事件、保持 active）。
 */
async function notifyChainSegmentAwaiting(runId: number): Promise<void> {
  const [run] = await db.select({ workflowId: pipelineRuns.workflowId, status: pipelineRuns.status, seq: pipelineRuns.workflowSeq }).from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  if (!run || run.workflowId == null || run.status !== 'completed') return
  const [session] = await db.select().from(creationSessions).where(eq(creationSessions.workflowId, run.workflowId)).limit(1)
  if (!session || session.status !== 'started') return
  const wf = await getWorkflow(run.workflowId)
  if (!wf || wf.autoAdvance === 1) return // 自动级联链段间不停等批准
  const total = parseSegments(wf.segments).length
  const seq = run.seq ?? 0
  if (seq + 1 >= total) return // 末段落定：无后续段可批准
  const dup = (await db.select({ payload: creationMessages.payload }).from(creationMessages).where(eq(creationMessages.sessionId, session.id)))
    .some((m) => { const p = parseJson<Record<string, unknown>>(m.payload, {}); return p['kind'] === 'chain-await' && p['workflowId'] === run.workflowId && p['seq'] === seq })
  if (dup) return
  const decision = agentDecisionSchema.safeParse(parseJson<unknown>(session.decision, null))
  const agentRole = decision.success && decision.data.mode === 'chain' ? decision.data.roleKey : null
  await db.insert(creationMessages).values({ sessionId: session.id, role: 'assistant', agentRole, content: `第 ${seq + 1} 段已完成（共 ${total} 段）。请在右侧核对成果后批准继续下一段（段间不自动级联计费）。`, payload: JSON.stringify({ kind: 'chain-await', workflowId: run.workflowId, seq, nextSeq: seq + 1, totalSegments: total }), createdAt: Date.now() })
}

/**
 * 启动时对账控制态；从不重新发起规划、建 run 或拉起媒体执行（零计费、零网络）。
 * planning → draft：规划被打断，原语义逐字不变。
 * starting → 依持久关联核对（CodeReview P1#8 的兜底面）：route chain 现已把「建链 + 建首段 queued run +
 * 绑会话 workflowId/runId」压进同一事务，正常不会再漏出 starting；这里覆盖旧版遗留与任何未预期残留，
 * 并且只核对、不重跑：
 *   ① 关联里有 run → 认领（started + runId + 对话留痕）：已提交的立项不该被重启推翻，更不该二次建链二次计费；
 *   ② 关联里无 run → 仍为 draft 的链从未起段，作废它（免得与再确认新建的链并存），会话回 ready 由用户显式再确认；
 *   ③ 无任何可核关联（旧版崩溃残留）→ 同样解锁（starting 会永久拒规划/绑素材/删除），
 *      但 error 明示「可能已计费，请核验」——不替用户假定安全。
 */
export async function reconcileCreationSessions(): Promise<void> {
  await db.update(creationSessions).set({ status: 'draft', error: '规划被服务重启中断，可能已计费。请核验后发送新消息重试', preflight: null, updatedAt: Date.now() }).where(eq(creationSessions.status, 'planning'))
  const stuck = await db.select().from(creationSessions).where(eq(creationSessions.status, 'starting'))
  for (const s of stuck) {
    // 关联核对顺序：会话自带 runId 优先；否则取该链 seq 最小的段落 run（首段认领即恢复「制作中」真相）
    let adoptedRunId: number | null = s.runId == null ? null : (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.id, s.runId)).limit(1))[0]?.id ?? null
    if (adoptedRunId == null && s.workflowId != null) {
      adoptedRunId = (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.workflowId, s.workflowId)).orderBy(asc(pipelineRuns.workflowSeq), asc(pipelineRuns.id)).limit(1))[0]?.id ?? null
    }
    if (adoptedRunId != null) {
      const [owned] = await db.update(creationSessions).set({ status: 'started', runId: adoptedRunId, error: null, updatedAt: Date.now() })
        .where(and(eq(creationSessions.id, s.id), eq(creationSessions.status, 'starting'))).returning()
      if (!owned) continue // 已被别的路径落定（并发窗口）：不重复留痕
      await db.insert(creationMessages).values({ sessionId: s.id, role: 'system', content: '服务重启打断了启动动作：已按编排链关联认领既有运行，未重复建任务、未重复计费。', payload: JSON.stringify({ kind: 'reconcile', adoptedRunId, workflowId: s.workflowId }), createdAt: Date.now() })
      continue
    }
    const draftChain = s.workflowId != null ? await getWorkflow(s.workflowId) : null
    const cancelledDraft = !!draftChain && draftChain.status === 'draft'
    if (cancelledDraft) await setWorkflowStatus(s.workflowId!, 'cancelled')
    const error = cancelledDraft
      ? '服务重启打断了启动动作，该编排链尚未起任何段落，已作废未启动的草稿链。请重新确认启动。'
      : '服务重启打断了启动动作，且无可核对的执行关联（可能已计费）。请先核验运行/编排链列表，再重新确认启动。'
    const [released] = await db.update(creationSessions).set({ status: s.decision || s.plan ? 'ready' : 'draft', error, updatedAt: Date.now() })
      .where(and(eq(creationSessions.id, s.id), eq(creationSessions.status, 'starting'))).returning()
    if (!released) continue
    await db.insert(creationMessages).values({ sessionId: s.id, role: 'system', content: error, payload: JSON.stringify({ kind: 'reconcile', workflowId: s.workflowId ?? null, cancelledDraft }), createdAt: Date.now() })
  }
}

