import { z } from 'zod'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, creationMessages, creationSessions, genTasks, pipelineRuns, pipelineSteps, projects } from '../../db/schema'
import { resolveEndpoint } from '../../adapters/provider'
import { mapResolution } from '../../adapters/video-capabilities'
import { engine } from '../../pipeline/engine'
import { loadTemplate } from '../../pipeline/loader'
import { createRunRow } from '../run-create'
import { writeTextAsset } from '../storage'
import { checkBudget } from '../budget'
import { confirmationSchema, creationPlanSchema, CreationError, hashJson } from './contract'
import { assertRecipeSources, recipeOf, recipeSchema, type CreationRecipe } from './recipe'
import { preflightPlan, type CreationPreflight } from './preflight'
import { projectMetaFromRow, renderMetaNotes, sanitizeProjectMeta } from './project-meta'
import { activeProject, creationWrite, parseJson, sessionRow } from './store'

/**
 * [M40] 确认即立项：点「开始制作」前项目一直为 draft 影子态，本函数在同一事务里
 * 把立项信息（名称/载体/模板/标签/简介）按「用户覆盖 > 草稿行现值 > 规则派生」写入并转 active。
 * 覆盖值不改 planHash（立项信息不是执行数据），因此改项目名称不会作废已确认的方案。
 */

export async function confirmCreation(id: number, raw: unknown): Promise<{ runId: number }> {
  const request = confirmationSchema.parse(raw)
  const result = await creationWrite(async () => {
    const s = await sessionRow(id)
    if (request.planRevision !== s.planRevision || request.planHash !== s.planHash) throw new CreationError('stale_plan', '方案已更新，请刷新并确认最新版本', 409)
    if (s.runId) return { runId: s.runId, start: false }
    await activeProject(s.projectId)
    if (s.status !== 'ready' || !s.plan || !s.preflight) throw new CreationError('not_ready', '请先完成有效方案和预检', 409)
    const plan = creationPlanSchema.parse(JSON.parse(s.plan))
    const pf = await preflightPlan(s.projectId, plan)
    if (!pf.ready || !pf.execution) throw new CreationError(pf.issues[0]?.code ?? 'preflight_failed', pf.issues[0]?.message ?? '预检未通过', 409)
    if (hashJson({ plan, execution: pf.execution }) !== s.planHash) throw new CreationError('configuration_changed', '配置或价格已变化，请重新预检并确认最新方案', 409)
    if (pf.estimate.unpriced.length && !request.acceptUnpriced) throw new CreationError('unpriced', '存在未知价格，请显式接受未计价项后再确认', 409)
    // [M43] 画质选择：防篡改 hash 校验（默认档位）之后才覆写——选档不豁免配置漂移复查；
    // 仅预检透出的已背书档可选（无视频能力/越界一律拒绝，不静默回落），经适配器同源归一后随 recipe 冻结执行。
    if (request.resolution) {
      const opts = pf.resolutionOptions
      const vp = pf.execution.endpoints.video
      if (!opts || !vp || !opts.choices.includes(request.resolution)) throw new CreationError('resolution_unsupported', '该画质档不在当前视频模型的已背书档位内，请刷新后重选', 422)
      pf.execution.resolution = mapResolution(vp.provider, request.resolution, vp.model)
    }
    return db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, s.projectId), isNull(projects.deletedAt)))
      if (!project) throw new CreationError('project_deleted', '项目已删除，不能启动', 409)
      // [M40] 立项：智能填写（已含规划时写入的草稿行值）+ 用户覆盖，逐项过真源校验；非法值回落且可见
      const base = projectMetaFromRow({ name: project.name, genre: project.genre, templateKey: project.templateKey, tags: parseJson<string[]>(project.tags, []), brief: project.brief }, plan)
      const { meta, notes } = sanitizeProjectMeta(request.project, plan, base)
      await tx.update(projects).set({ name: meta.name, genre: meta.genre, templateKey: meta.templateKey, tags: JSON.stringify(meta.tags), brief: meta.brief, status: 'active', updatedAt: Date.now() }).where(eq(projects.id, project.id))
      const claimed = await tx.update(creationSessions).set({ status: 'starting', startKey: request.idempotencyKey })
        .where(and(eq(creationSessions.id, id), eq(creationSessions.status, 'ready'), eq(creationSessions.planHash, request.planHash), eq(creationSessions.planRevision, request.planRevision), isNull(creationSessions.runId))).returning()
      if (!claimed.length) throw new CreationError('conflict', '方案已被确认或修改，请刷新', 409)
      const contents = [plan.script, JSON.stringify(plan.lines), JSON.stringify(plan.shots)]
      const specs = [{ name: '已批准脚本.md', purpose: 'script', format: 'markdown' }, { name: '已批准台词.json', purpose: 'lines', format: 'lines-json' }, { name: '已批准分镜.json', purpose: 'storyboard', format: 'storyboard-json' }]
      const sources = []
      for (let i = 0; i < specs.length; i++) {
        const a = await writeTextAsset(s.projectId, { ...specs[i]!, content: contents[i]!, params: { creationSessionId: id, revision: s.planRevision } }, tx)
        sources.push({ id: a.id, hash: hashJson(contents[i]) })
      }
      // [M42] 审阅闸：勾选即用变体模板（同构步骤 + 画面/首帧后 gate）；模板哈希随所选键重算，
      // planHash 不受该标志影响（启动方式不是执行数据，与立项覆盖同一先例）。
      const templateKey = request.reviewGate ? 'easy-video-review' : 'easy-video'
      const recipe = recipeSchema.parse({ ...pf.execution, sessionId: id, sources, templateHash: hashJson(loadTemplate(templateKey)) })
      const run = await createRunRow({ projectId: s.projectId, templateKey, creationSessionId: id, input: {
        script: [sources[0]!.id], lines: [sources[1]!.id], shots: [sources[2]!.id], recipe: JSON.stringify(recipe), motion: plan.mode === 'dynamic', i2v: recipe.videoMode === 'i2v',
      } }, tx)
      await tx.update(assets).set({ runId: run.id }).where(eq(assets.id, sources[0]!.id))
      await tx.update(creationSessions).set({ approvedPlan: JSON.stringify(recipe), status: 'started', runId: run.id, updatedAt: Date.now(), error: null }).where(eq(creationSessions.id, id))
      await tx.insert(creationMessages).values({ sessionId: id, role: 'assistant', content: '方案已确认，正在自动制作。取消只停止后续提交，在途请求仍可能计费。', payload: JSON.stringify({ kind: 'run', runId: run.id }), createdAt: Date.now() })
      // [M40] 立项字段被真源修正过 → 补一条可见消息（不静默降级；无调整不打扰）
      if (notes.length) await tx.insert(creationMessages).values({ sessionId: id, role: 'assistant', content: `已创建项目《${meta.name}》。${renderMetaNotes(notes).trim()}`, payload: JSON.stringify({ kind: 'project', projectId: project.id, notes }), createdAt: Date.now() })
      else await tx.insert(creationMessages).values({ sessionId: id, role: 'assistant', content: `已创建项目《${meta.name}》（载体：${meta.genre} · 模板：${meta.templateKey}），可在项目页随时调整。`, payload: JSON.stringify({ kind: 'project', projectId: project.id, notes: [] }), createdAt: Date.now() })
      return { runId: run.id, start: true }
    })
  })
  if (result.start) engine.startRun(result.runId)
  return { runId: result.runId }
}

export async function cancelCreation(id: number): Promise<void> {
  const s = await sessionRow(id)
  if (s.runId) await engine.cancelRun(s.runId)
}

export const retryCreationSchema = confirmationSchema.extend({
  runId: z.number().int().positive(),
  /** 用户已在供应商侧核实失败且愿意重新提交的任务；已知外部 ID 默认仅恢复查询。 */
  verifiedFailedTaskIds: z.array(z.number().int().positive()).max(100).default([]),
}).strict()
interface RetryLink { from: number; to: number; key: string }
export async function retryCreation(id: number, raw: unknown): Promise<{ runId: number }> {
  const request = retryCreationSchema.parse(raw)
  const result = await creationWrite(async () => {
    const s = await sessionRow(id)
    const history = parseJson<RetryLink[]>(s.runHistory, [])
    const prior = history.find((r) => r.key === request.idempotencyKey)
    if (prior) {
      if (prior.from !== request.runId) throw new CreationError('idempotency_conflict', '恢复请求键冲突', 409)
      return { runId: prior.to, start: false }
    }
    if (s.runId !== request.runId || s.planHash !== request.planHash || s.planRevision !== request.planRevision) throw new CreationError('stale_run', '运行或方案已变化，请刷新', 409)
    await activeProject(s.projectId)
    const [src] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, request.runId))
    if (!src || !['failed', 'cancelled'].includes(src.status) || engine.isRunning(src.id)) throw new CreationError('busy', '请等待在途任务结束后恢复', 409)
    const recipe = recipeOf(src)!
    await assertRecipeSources(src, recipe)
    for (const [service, pin] of Object.entries(recipe.endpoints)) {
      try { await resolveEndpoint(service as 'audio' | 'image' | 'video', pin.provider, pin) }
      catch { throw new CreationError('configuration_changed', '已批准实例不可用或配置已变化，请复制需求重新规划', 409) }
    }
    // [M42] 模板哈希按 run 自身模板键校验（review 变体恢复不被误拦；原 easy-video 会话因模板未变仍通过）
    if (recipe.templateHash !== hashJson(loadTemplate(src.templateKey))) throw new CreationError('template_changed', '模板已变化，请复制需求重新规划', 409)
    const tasks = await db.select().from(genTasks).where(eq(genTasks.runId, src.id))
    const uncertain = tasks.filter((t) => t.status !== 'succeeded' && t.attempts > 0)
    if (request.verifiedFailedTaskIds.some((tid) => !uncertain.some((t) => t.id === tid))) throw new CreationError('bad_task', '核验任务不属于当前待恢复任务', 422)
    if (uncertain.some((t) => !t.taskId && !request.verifiedFailedTaskIds.includes(t.id))) throw new CreationError('needs_verification', '存在受理状态不明的请求，请先在供应商侧核验，不能自动重复提交', 409)
    const pf = parseJson<CreationPreflight>(s.preflight, {} as CreationPreflight)
    if (pf.estimate.unpriced.length && !request.acceptUnpriced) throw new CreationError('unpriced', '恢复仍有未计价项，请显式接受', 409)
    const budget = await checkBudget({ projectId: s.projectId, estimatedCost: remainingCost(recipe, tasks) })
    if (budget) throw new CreationError(budget.code, budget.message, 409)
    const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, src.id)).orderBy(asc(pipelineSteps.seq))
    return db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, s.projectId), isNull(projects.deletedAt)))
      if (!project) throw new CreationError('project_deleted', '项目已删除', 409)
      const claim = await tx.update(creationSessions).set({ status: 'starting' }).where(and(eq(creationSessions.id, id), eq(creationSessions.runId, src.id), eq(creationSessions.status, 'started'))).returning()
      if (!claim.length) throw new CreationError('conflict', '会话已被恢复，请刷新', 409)
      const newRun = await createRunRow({ projectId: src.projectId, templateKey: src.templateKey, input: JSON.parse(src.input), creationSessionId: id }, tx)
      for (const step of steps) {
        const keep = ['succeeded', 'skipped'].includes(step.status)
        const [created] = await tx.insert(pipelineSteps).values({ runId: newRun.id, seq: step.seq, stepKey: step.stepKey, actionKey: step.actionKey, title: step.title,
          status: keep ? step.status : 'pending', input: keep ? step.input : null, output: keep ? step.output : null, attempts: keep ? step.attempts : 0, createdAt: Date.now(), updatedAt: Date.now() }).returning()
        for (const task of tasks.filter((t) => t.stepId === step.id)) {
          const { id: _id, ...copy } = task
          const verified = request.verifiedFailedTaskIds.includes(task.id)
          await tx.insert(genTasks).values({ ...copy, runId: newRun.id, stepId: created!.id, status: task.status === 'succeeded' ? 'succeeded' : 'pending',
            attempts: verified ? 0 : task.attempts, taskId: verified ? null : task.taskId, errorMsg: null, createdAt: Date.now(), updatedAt: Date.now() })
        }
      }
      history.push({ from: src.id, to: newRun.id, key: request.idempotencyKey })
      await tx.update(creationSessions).set({ status: 'started', runId: newRun.id, runHistory: JSON.stringify(history), updatedAt: Date.now() }).where(eq(creationSessions.id, id))
      await tx.insert(creationMessages).values({ sessionId: id, role: 'assistant', content: '已从断点恢复，成功任务将复用。有外部任务编号的未完成视频仅恢复查询，除非你明确核实失败并授权重新提交。', payload: JSON.stringify({ kind: 'retry', runId: newRun.id, verifiedFailedTaskIds: request.verifiedFailedTaskIds }), createdAt: Date.now() })
      return { runId: newRun.id, start: true }
    })
  })
  if (result.start) engine.startRun(result.runId)
  return { runId: result.runId }
}

function remainingCost(recipe: CreationRecipe, tasks: Array<{ kind: string; status: string; params: string | null }>): number {
  const done = (kind: string, key: string, id: string) => tasks.some((t) => t.kind === kind && t.status === 'succeeded' && parseJson<Record<string, unknown>>(t.params, {})[key] === id)
  let cost = recipe.plan.lines.filter((l) => !done('audio', 'lineId', l.id)).reduce((n, l) => n + l.text.length * (recipe.endpoints.audio.unitPrice ?? 0), 0)
  for (const s of recipe.plan.shots) {
    if (!done('image', 'shotId', s.id)) cost += recipe.endpoints.image?.unitPrice ?? 0
    if (!done('video', 'shotId', s.id)) cost += (recipe.endpoints.video?.unitPrice ?? 0) * (recipe.requestDurations[s.id] ?? 0)
  }
  return cost
}
