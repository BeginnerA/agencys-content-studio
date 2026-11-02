/**
 * route 执行分派：template / chain / synth 三种新执行形态的「确认才立项 → 起执行」。
 * 与 easy 批准链彻底分道——easy 的 recipe 冻结 / planHash / 逐镜续跑逻辑逐字不触碰（execution.ts confirmEasy）。
 * 计费安全三闸在此同样成立：① preflightDecision 结构闸（模板漂移/输入非法/synth YAML 不过 → 拒）；② checkBudget 项目级硬闸；
 * ③ 「确认才立项」：status ready→starting 条件更新（decisionHash + decisionRevision 乐观锁）作幂等与防 TOCTOU。
 * 物化输入只引用会话可用素材（归一层已剔幽灵 id）；synth 临时模板仿制 key 落盘、visibility:conversation 不进专业选择器、随会话删除回收。
 */
import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { creationMessages, creationSessions, projects, type CreationSession } from '../../db/schema'
import { engine } from '../../pipeline/engine'
import { saveTemplate } from '../../pipeline/loader'
import { createRunRow, InvalidRunInputError } from '../run-create'
import { checkBudget } from '../budget'
import { createLogger } from '../../logger'
import { activateWorkflowIn, createWorkflow, prepareFirstSegment, WorkflowError, type WorkflowSegment } from '../workflow'
import { readContext } from '../continuity/context'
import { assertRouteApprovalTarget } from '../continuity/route-bridge'
import { workflowContinuityEnabled } from '../continuity/workflow-bridge'
import { ApprovalSchema, ContinuityError, type Approval } from '../continuity/contract'
import { CreationError, PROJECT_GENRE_VALUES, hashJson, projectMetaInputSchema, type ProjectGenre, type ProjectMeta } from './contract'
import { agentDecisionSchema, type AgentDecision } from './agent/decision-schema'
import { toWorkflowToken } from './agent/normalize'
import { buildTemplateCatalog, preflightDecision } from './agent-run'
import { materializeRouteInputs } from './route-inputs'
import { sanitizeProjectMeta, renderMetaNotes } from './project-meta'
import { activeProject, creationWrite, parseJson, sessionRow } from './store'

const log = createLogger('creation-route')

const routeConfirmationSchema = z.object({
  decisionRevision: z.number().int().positive(),
  decisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  acceptUnpriced: z.boolean().default(false),
  project: projectMetaInputSchema.optional(),
  // 已冻结承接包批准（仅用户请求 schema 接入；LLM 决策契约 strict 不收此键）
  continuityApproval: ApprovalSchema.optional(),
}).strict()

/** 会话当前是否为「可 route 确认」态：agentMode=1 且 decision 已落且 mode≠easy（easy 走 confirmEasy 原路） */
export function routeDecisionOf(s: CreationSession): AgentDecision | null {
  if (s.agentMode !== 1 || !s.decision) return null
  const parsed = agentDecisionSchema.safeParse(parseJson<unknown>(s.decision, null))
  return parsed.success && parsed.data.mode !== 'easy' ? parsed.data : null
}

/** 输入物化抽至 route-inputs.ts（确认侧与连续性定位侧同源，见 route-inputs.ts 头注）。 */

/** route 立项：草稿行现值投影为 base（无 CreationPlan）→ 用户覆盖经 sanitizeProjectMeta；模板取真实执行目标 */
function routeBaseMeta(project: { name: string; genre: string; templateKey: string; brief: string | null; tags: string }, execKey: string | null, rationale: string): ProjectMeta {
  const tags = parseJson<string[]>(project.tags, []).filter((t) => typeof t === 'string' && t.trim())
  return {
    name: (project.name || '轻松创作项目').trim().slice(0, 60) || '轻松创作项目',
    genre: (PROJECT_GENRE_VALUES.includes(project.genre as ProjectGenre) ? project.genre : 'other') as ProjectGenre,
    templateKey: execKey || project.templateKey || 'other',
    tags: tags.length ? tags.slice(0, 6) : ['轻松创作'],
    brief: (project.brief || '').trim().slice(0, 500) || rationale.trim().slice(0, 500) || '轻松创作会话',
  }
}

/** WorkflowError / InvalidRunInputError → CreationError（保持路由层错误契约统一，code 透传，绝不糊成 503）；
 *  ContinuityError 原样透传（路由层按 404/409/413 + operationId 呈现，绝不糊成 503）。 */
function asCreationError(err: unknown): CreationError | ContinuityError {
  if (err instanceof ContinuityError) return err
  if (err instanceof CreationError) return err
  if (err instanceof WorkflowError) return new CreationError(err.code, err.message, 409)
  if (err instanceof InvalidRunInputError) return new CreationError(err.code, err.message, 409)
  return new CreationError('route_start_failed', err instanceof Error ? err.message : '执行启动失败', 503)
}

/**
 * route 连续性批准注入（与 workflow withWorkflowApproval 同口径）：决策声明启用 with_continuity 而无批准
 * → ContinuityError 409 continuity_gaps_unaccepted；携批准 → 服务端权威追加槽位（with_continuity=true +
 * continuity_context=批准包资产，调用方伪造/漏带均以服务端为准）。
 */
function withRouteApproval(raw: Record<string, unknown>, approval: Approval | undefined): Record<string, unknown> {
  if (approval) return { ...raw, with_continuity: true, continuity_context: [approval.document.assetId] }
  if (workflowContinuityEnabled(raw)) throw new ContinuityError('continuity_gaps_unaccepted', 409)
  return raw
}

/**
 * route 确认入口。dispatcher（execution.ts confirmCreation）在检出 route 会话时调用。
 * 单次调用完成：复查结构闸 → 预算硬闸 → 按 mode 分派执行 → 落 started 态 + 对话留痕。
 */
export async function confirmRoute(id: number, raw: unknown): Promise<{ runId: number; workflowId?: number }> {
  const request = routeConfirmationSchema.parse(raw)
  const s0 = await sessionRow(id)
  const decision = routeDecisionOf(s0)
  if (!decision) throw new CreationError('not_ready', '当前没有可确认的调度计划，请先完成对话规划', 409)
  // 批准包必须恰指本会话当前决策位置（kind=route + sessionId/decisionRevision/decisionHash 全匹配），
  // 否则 409 continuity_context_changed。置于幂等早退之前：过期 decision / 另一会话 / 异种包在回放路径同样被拒。
  if (request.continuityApproval) {
    const doc = await readContext(s0.projectId, request.continuityApproval, db)
    assertRouteApprovalTarget(doc, id, s0.planRevision, s0.decisionHash)
  }
  if (s0.runId) return { runId: s0.runId, ...(s0.workflowId ? { workflowId: s0.workflowId } : {}) }
  await activeProject(s0.projectId)
  if (s0.status !== 'ready' || s0.decisionHash !== request.decisionHash || s0.planRevision !== request.decisionRevision) {
    throw new CreationError('stale_plan', '执行计划已更新，请刷新并确认最新版本', 409)
  }
  // 结构闸复查：模板目录漂移 / 输入非法 / synth YAML 不过 → 拒绝确认（决策后平台资产可能已变）
  const pf = preflightDecision(decision, buildTemplateCatalog())
  if (!pf.ready) throw new CreationError(pf.issues[0]?.code ?? 'preflight_failed', pf.issues[0]?.message ?? '调度计划预检未通过', 409)
  // 预算硬闸（项目级 cap；route 无逐项成本模型时至少守全局熔断，与 startWorkflow 首段同口径）
  const budget = await checkBudget({ projectId: s0.projectId })
  if (budget) throw new CreationError(budget.code, budget.message, 409)

  if (decision.mode === 'chain' && decision.chain) return startChain(id, s0, decision, request)
  if (decision.mode === 'synth' && decision.synth) return startSynth(id, s0, decision, request)
  if (decision.mode === 'template' && decision.templateRun) return startTemplate(id, s0, decision, request)
  throw new CreationError('route_invalid', '调度计划形态不受支持，请重新规划', 409)
}

/** template：立项 active + createRunRow（单发）+ engine.startRun；确认闸幂等由 status ready→starting 条件更新保证 */
async function startTemplate(id: number, s: CreationSession, decision: AgentDecision, request: z.infer<typeof routeConfirmationSchema>): Promise<{ runId: number }> {
  const tplKey = decision.templateRun!.templateKey
  const input = withRouteApproval(materializeRouteInputs(decision.templateRun!.inputSpec), request.continuityApproval)
  const result = await creationWrite(() => db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(and(eq(projects.id, s.projectId), isNull(projects.deletedAt)))
    if (!project) throw new CreationError('project_deleted', '项目已删除，不能启动', 409)
    const base = routeBaseMeta(project, tplKey, decision.rationale)
    const { meta, notes } = sanitizeProjectMeta(request.project, null, base)
    await tx.update(projects).set({ name: meta.name, genre: meta.genre, templateKey: meta.templateKey, tags: JSON.stringify(meta.tags), brief: meta.brief, status: 'active', updatedAt: Date.now() }).where(eq(projects.id, project.id))
    const claimed = await tx.update(creationSessions).set({ status: 'starting', startKey: request.idempotencyKey })
      .where(and(eq(creationSessions.id, id), eq(creationSessions.status, 'ready'), eq(creationSessions.decisionHash, request.decisionHash), eq(creationSessions.planRevision, request.decisionRevision), isNull(creationSessions.runId))).returning()
    if (!claimed.length) throw new CreationError('conflict', '计划已被确认或修改，请刷新', 409)
    const run = await createRunRow({ projectId: s.projectId, templateKey: tplKey, input, creationSessionId: id, chainKind: 'route', continuityApproval: request.continuityApproval }, tx)
    await tx.update(creationSessions).set({ status: 'started', runId: run.id, decisionHash: hashJson(decision), updatedAt: Date.now(), error: null }).where(eq(creationSessions.id, id))
    await tx.insert(creationMessages).values({ sessionId: id, role: 'assistant', agentRole: decision.roleKey, content: `已按调度计划启动制作（模板「${tplKey}」）。${renderMetaNotes(notes).trim()}`, payload: JSON.stringify({ kind: 'run', runId: run.id, mode: 'template', templateKey: tplKey }), createdAt: Date.now() })
    return { runId: run.id, start: true }
  }))
  if (result.start) engine.startRun(result.runId)
  return { runId: result.runId }
}

/** synth：saveTemplate 落临时模板（仿制 key，visibility:conversation）→ 同 template 起 run；起 run 前失败则回滚删除临时件 */
async function startSynth(id: number, s: CreationSession, decision: AgentDecision, request: z.infer<typeof routeConfirmationSchema>): Promise<{ runId: number }> {
  const synth = decision.synth!
  saveTemplate(synth.templateKey, synth.yaml)
  try {
    const input = withRouteApproval(materializeRouteInputs(synth.inputSpec), request.continuityApproval)
    const result = await creationWrite(() => db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, s.projectId), isNull(projects.deletedAt)))
      if (!project) throw new CreationError('project_deleted', '项目已删除，不能启动', 409)
      const base = routeBaseMeta(project, synth.templateKey, decision.rationale)
      const { meta, notes } = sanitizeProjectMeta(request.project, null, base)
      await tx.update(projects).set({ name: meta.name, genre: meta.genre, templateKey: meta.templateKey, tags: JSON.stringify(meta.tags), brief: meta.brief, status: 'active', updatedAt: Date.now() }).where(eq(projects.id, project.id))
      const claimed = await tx.update(creationSessions).set({ status: 'starting', startKey: request.idempotencyKey })
        .where(and(eq(creationSessions.id, id), eq(creationSessions.status, 'ready'), eq(creationSessions.decisionHash, request.decisionHash), eq(creationSessions.planRevision, request.decisionRevision), isNull(creationSessions.runId))).returning()
      if (!claimed.length) throw new CreationError('conflict', '计划已被确认或修改，请刷新', 409)
      const run = await createRunRow({ projectId: s.projectId, templateKey: synth.templateKey, input, creationSessionId: id, chainKind: 'route', continuityApproval: request.continuityApproval }, tx)
      await tx.update(creationSessions).set({ status: 'started', runId: run.id, decisionHash: hashJson(decision), updatedAt: Date.now(), error: null }).where(eq(creationSessions.id, id))
      await tx.insert(creationMessages).values({ sessionId: id, role: 'assistant', agentRole: decision.roleKey, content: `已按临时编排计划启动制作（${synth.stepCount} 步）。${renderMetaNotes(notes).trim()}`, payload: JSON.stringify({ kind: 'run', runId: run.id, mode: 'synth', templateKey: synth.templateKey }), createdAt: Date.now() })
      return { runId: run.id, start: true }
    }))
    if (result.start) engine.startRun(result.runId)
    return { runId: result.runId }
  } catch (err) {
    // 起 run 事务失败 → 临时模板成为孤儿件，best-effort 删除（不掩盖原始错误）
    try { (await import('../../pipeline/loader')).deleteTemplate(synth.templateKey) } catch { /* 孤儿件留待会话删除回收 */ }
    throw err
  }
}

/**
 * chain：一个事务内完成「项目转正 + ready→starting 认领 + 建链 + 建首段 queued run + 链置 active + 会话绑定 + 留痕」，
 * 提交后才拉起执行（与 confirmEasy / rework apply 的「事务内立项、提交后起跑」同律）。
 * 为什么必须同事务（CodeReview #8）：旧版先置 starting 再建链再起跑、workflowId 起完段才回写，
 * 建链异常会遗留永久锁死会话的 starting，起跑后崩溃会留下「链与 run 已在库、会话无关联」的孤儿运行——
 * 用户再确认即二次建链二次计费。同事务后：任一环节失败整体回滚（零孤儿、零计费）；提交成功则关联与 run
 * 已持久，崩溃窗口交由既有 queued 恢复 + 30s 全局泵兜底，启动对账据关联认领而不重跑立项。
 * 首段输入/预算闸复用编排服务 prepareFirstSegment（与专业链同源，不另判一套）；段间默认不自动级联计费。
 */
async function startChain(id: number, s: CreationSession, decision: AgentDecision, request: z.infer<typeof routeConfirmationSchema>): Promise<{ runId: number; workflowId: number }> {
  const segments: WorkflowSegment[] = decision.chain!.map((seg) => {
    const spec: Record<string, string> = {}
    for (const [k, v] of Object.entries(seg.inputSpec)) { const t = toWorkflowToken(v); if (t !== undefined) spec[k] = t }
    return { templateKey: seg.templateKey, inputSpec: Object.keys(spec).length ? spec : undefined }
  })
  // 事务外先过只读段闸（模板可载 / 必填输入 / 预算熔断 + 批准槽位注入）：不过则连链都不建。
  // 批准透传给 prepareFirstSegment（与专业链首段同源）——声明启用而无批准 409；带批准由服务端追加槽位。
  const gate = await prepareFirstSegment({ projectId: s.projectId, segments: JSON.stringify(segments) },
    { continuityApproval: request.continuityApproval }).catch((err) => { throw asCreationError(err) })
  const committed = await creationWrite(() => db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(and(eq(projects.id, s.projectId), isNull(projects.deletedAt)))
    if (!project) throw new CreationError('project_deleted', '项目已删除，不能启动', 409)
    const base = routeBaseMeta(project, decision.chain![0]!.templateKey, decision.rationale)
    const { meta } = sanitizeProjectMeta(request.project, null, base)
    await tx.update(projects).set({ name: meta.name, genre: meta.genre, templateKey: meta.templateKey, tags: JSON.stringify(meta.tags), brief: meta.brief, status: 'active', updatedAt: Date.now() }).where(eq(projects.id, project.id))
    const claimed = await tx.update(creationSessions).set({ status: 'starting', startKey: request.idempotencyKey })
      .where(and(eq(creationSessions.id, id), eq(creationSessions.status, 'ready'), eq(creationSessions.decisionHash, request.decisionHash), eq(creationSessions.planRevision, request.decisionRevision), isNull(creationSessions.runId))).returning()
    if (!claimed.length) throw new CreationError('conflict', '计划已被确认或修改，请刷新', 409)
    const wf = await createWorkflow({ projectId: s.projectId, name: meta.name, segments, autoAdvance: 0, note: decision.rationale }, tx)
    const run = await createRunRow({ projectId: s.projectId, templateKey: gate.templateKey, input: gate.inputs, creationSessionId: id, chainKind: 'route', workflowId: wf.id, workflowSeq: 0, continuityApproval: request.continuityApproval }, tx)
    // active 与建 run 同批落库：绝不留「有 queued run 却仍 draft」的死角（advanceWorkflow 只认 active 链，draft 会让链永久卡住）
    await activateWorkflowIn(tx, wf.id)
    await tx.update(creationSessions).set({ status: 'started', workflowId: wf.id, runId: run.id, decisionHash: hashJson(decision), updatedAt: Date.now(), error: null }).where(eq(creationSessions.id, id))
    await tx.insert(creationMessages).values({ sessionId: id, role: 'assistant', agentRole: decision.roleKey, content: `已创建 ${segments.length} 段编排链并把首段排入执行队列。段间将暂停回对话请求你的批准（安全默认，不自动级联计费）。`, payload: JSON.stringify({ kind: 'chain-start', workflowId: wf.id, runId: run.id, mode: 'chain', segments: decision.chain!.map((x) => x.templateKey) }), createdAt: Date.now() })
    return { runId: run.id, workflowId: wf.id }
  })).catch((err) => { throw asCreationError(err) })
  // 提交后拉起：抛错不改已提交事实（run 留在 queued，boot 恢复与全局泵自会接住）——比回滚更诚实，也更不会二次计费
  try {
    engine.startRun(committed.runId)
  } catch (err) {
    log.warn(`chain 首段拉起失败，交由 queued 恢复兜底：run ${committed.runId}`, err)
  }
  return committed
}
