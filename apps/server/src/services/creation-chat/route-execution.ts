/**
 * route 执行分派（M63 切片 3）：template / chain / synth 三种新执行形态的「确认才立项 → 起执行」。
 * 与 easy 批准链彻底分道——easy 的 recipe 冻结 / planHash / 逐镜续跑逻辑逐字不触碰（execution.ts confirmEasy）。
 * 计费安全三闸在此同样成立：① preflightDecision 结构闸（模板漂移/输入非法/synth YAML 不过 → 拒）；② checkBudget 项目级硬闸；
 * ③ M40「确认才立项」：status ready→starting 条件更新（decisionHash + decisionRevision 乐观锁）作幂等与防 TOCTOU。
 * 物化输入只引用会话可用素材（归一层已剔幽灵 id）；synth 临时模板仿制 key 落盘、visibility:conversation 不进专业选择器、随会话删除回收。
 */
import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { creationMessages, creationSessions, projects, type CreationSession } from '../../db/schema'
import { engine } from '../../pipeline/engine'
import { saveTemplate } from '../../pipeline/loader'
import { createRunRow } from '../run-create'
import { checkBudget } from '../budget'
import { WorkflowError, createWorkflow, setWorkflowStatus, startWorkflow, type WorkflowSegment } from '../workflow'
import { CreationError, PROJECT_GENRE_VALUES, hashJson, projectMetaInputSchema, type ProjectGenre, type ProjectMeta } from './contract'
import { agentDecisionSchema, type AgentDecision, type InputSpecItem } from './agent/decision-schema'
import { toWorkflowToken } from './agent/normalize'
import { buildTemplateCatalog, preflightDecision } from './agent-run'
import { sanitizeProjectMeta, renderMetaNotes } from './project-meta'
import { activeProject, creationWrite, parseJson, sessionRow } from './store'

const routeConfirmationSchema = z.object({
  decisionRevision: z.number().int().positive(),
  decisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  acceptUnpriced: z.boolean().default(false),
  project: projectMetaInputSchema.optional(),
}).strict()

/** 会话当前是否为「可 route 确认」态：agentMode=1 且 decision 已落且 mode≠easy（easy 走 confirmEasy 原路） */
export function routeDecisionOf(s: CreationSession): AgentDecision | null {
  if (s.agentMode !== 1 || !s.decision) return null
  const parsed = agentDecisionSchema.safeParse(parseJson<unknown>(s.decision, null))
  return parsed.success && parsed.data.mode !== 'easy' ? parsed.data : null
}

/** 输入物化：InputSpecItem → 具体值（default/prev 不参与——prev 仅链内运行期由 orchestrator 解析） */
function materialize(spec: Record<string, InputSpecItem>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, item] of Object.entries(spec)) {
    switch (item.kind) {
      case 'text': out[field] = item.value; break
      case 'number': out[field] = item.value; break
      case 'boolean': out[field] = item.value; break
      case 'asset': out[field] = item.assetId; break
      case 'assets': out[field] = item.assetIds; break
      case 'default':
      case 'prev': break
    }
  }
  return out
}

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

/** WorkflowError → CreationError（保持路由层错误契约统一，code 透传） */
function asCreationError(err: unknown): CreationError {
  if (err instanceof CreationError) return err
  if (err instanceof WorkflowError) return new CreationError(err.code, err.message, 409)
  return new CreationError('route_start_failed', err instanceof Error ? err.message : '执行启动失败', 503)
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
  const input = materialize(decision.templateRun!.inputSpec)
  const result = await creationWrite(() => db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(and(eq(projects.id, s.projectId), isNull(projects.deletedAt)))
    if (!project) throw new CreationError('project_deleted', '项目已删除，不能启动', 409)
    const base = routeBaseMeta(project, tplKey, decision.rationale)
    const { meta, notes } = sanitizeProjectMeta(request.project, null, base)
    await tx.update(projects).set({ name: meta.name, genre: meta.genre, templateKey: meta.templateKey, tags: JSON.stringify(meta.tags), brief: meta.brief, status: 'active', updatedAt: Date.now() }).where(eq(projects.id, project.id))
    const claimed = await tx.update(creationSessions).set({ status: 'starting', startKey: request.idempotencyKey })
      .where(and(eq(creationSessions.id, id), eq(creationSessions.status, 'ready'), eq(creationSessions.decisionHash, request.decisionHash), eq(creationSessions.planRevision, request.decisionRevision), isNull(creationSessions.runId))).returning()
    if (!claimed.length) throw new CreationError('conflict', '计划已被确认或修改，请刷新', 409)
    const run = await createRunRow({ projectId: s.projectId, templateKey: tplKey, input, creationSessionId: id, chainKind: 'route' }, tx)
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
    const input = materialize(synth.inputSpec)
    const result = await creationWrite(() => db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, s.projectId), isNull(projects.deletedAt)))
      if (!project) throw new CreationError('project_deleted', '项目已删除，不能启动', 409)
      const base = routeBaseMeta(project, synth.templateKey, decision.rationale)
      const { meta, notes } = sanitizeProjectMeta(request.project, null, base)
      await tx.update(projects).set({ name: meta.name, genre: meta.genre, templateKey: meta.templateKey, tags: JSON.stringify(meta.tags), brief: meta.brief, status: 'active', updatedAt: Date.now() }).where(eq(projects.id, project.id))
      const claimed = await tx.update(creationSessions).set({ status: 'starting', startKey: request.idempotencyKey })
        .where(and(eq(creationSessions.id, id), eq(creationSessions.status, 'ready'), eq(creationSessions.decisionHash, request.decisionHash), eq(creationSessions.planRevision, request.decisionRevision), isNull(creationSessions.runId))).returning()
      if (!claimed.length) throw new CreationError('conflict', '计划已被确认或修改，请刷新', 409)
      const run = await createRunRow({ projectId: s.projectId, templateKey: synth.templateKey, input, creationSessionId: id, chainKind: 'route' }, tx)
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

/** chain：立项 active + createWorkflow（autoAdvance=0 段间安全默认）+ startWorkflow（首段，orchestrator 自管锁与计费闸，非事务） */
async function startChain(id: number, s: CreationSession, decision: AgentDecision, request: z.infer<typeof routeConfirmationSchema>): Promise<{ runId: number; workflowId: number }> {
  const segments: WorkflowSegment[] = decision.chain!.map((seg) => {
    const spec: Record<string, string> = {}
    for (const [k, v] of Object.entries(seg.inputSpec)) { const t = toWorkflowToken(v); if (t !== undefined) spec[k] = t }
    return { templateKey: seg.templateKey, inputSpec: Object.keys(spec).length ? spec : undefined }
  })
  const result = await creationWrite(async () => {
    const [project] = await db.select().from(projects).where(and(eq(projects.id, s.projectId), isNull(projects.deletedAt)))
    if (!project) throw new CreationError('project_deleted', '项目已删除，不能启动', 409)
    const base = routeBaseMeta(project, decision.chain![0]!.templateKey, decision.rationale)
    const { meta } = sanitizeProjectMeta(request.project, null, base)
    await db.update(projects).set({ name: meta.name, genre: meta.genre, templateKey: meta.templateKey, tags: JSON.stringify(meta.tags), brief: meta.brief, status: 'active', updatedAt: Date.now() }).where(eq(projects.id, project.id))
    const claimed = await db.update(creationSessions).set({ status: 'starting', startKey: request.idempotencyKey })
      .where(and(eq(creationSessions.id, id), eq(creationSessions.status, 'ready'), eq(creationSessions.decisionHash, request.decisionHash), eq(creationSessions.planRevision, request.decisionRevision), isNull(creationSessions.runId))).returning()
    if (!claimed.length) throw new CreationError('conflict', '计划已被确认或修改，请刷新', 409)
    const wf = await createWorkflow({ projectId: s.projectId, name: meta.name, segments, autoAdvance: 0, note: decision.rationale })
    let started: { runId: number }
    try {
      started = await startWorkflow(wf.id)
    } catch (err) {
      await setWorkflowStatus(wf.id, 'cancelled').catch(() => undefined)
      await db.update(creationSessions).set({ status: 'ready', updatedAt: Date.now() }).where(and(eq(creationSessions.id, id), eq(creationSessions.status, 'starting')))
      throw asCreationError(err)
    }
    await db.update(creationSessions).set({ status: 'started', workflowId: wf.id, runId: started.runId, updatedAt: Date.now(), error: null }).where(eq(creationSessions.id, id))
    await db.insert(creationMessages).values({ sessionId: id, role: 'assistant', agentRole: decision.roleKey, content: `已创建 ${segments.length} 段编排链并启动首段制作。段间将暂停回对话请求你的批准（安全默认，不自动级联计费）。`, payload: JSON.stringify({ kind: 'chain-start', workflowId: wf.id, runId: started.runId, mode: 'chain', segments: decision.chain!.map((x) => x.templateKey) }), createdAt: Date.now() })
    return { runId: started.runId, workflowId: wf.id }
  })
  return { runId: result.runId, workflowId: result.workflowId }
}
