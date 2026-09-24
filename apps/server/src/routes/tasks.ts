import { Hono } from 'hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { assets, genTasks, pipelineRuns, pipelineSteps } from '../db/schema'
import { engine } from '../pipeline/engine'
import { isAmbiguousSubmitted, isCreationTemplate } from '../services/creation-chat/recipe'
import { HttpError, h, idParam, notFound } from './helpers'

export const tasksRoutes = new Hono()

// GET /tasks —— 任务列表（?run_id=&status=&kind=）
tasksRoutes.get('/tasks', h(async (c) => {
  const conds = []
  const runId = c.req.query('run_id')
  if (runId) conds.push(eq(genTasks.runId, Number(runId)))
  const status = c.req.query('status')
  if (status) conds.push(eq(genTasks.status, status))
  const kind = c.req.query('kind')
  if (kind) conds.push(eq(genTasks.kind, kind))
  const rows = await db
    .select()
    .from(genTasks)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(genTasks.createdAt))
    .limit(200)
  // 批量拉取结果资产快照（替代逐任务查询，避免 N+1）
  const assetIds = [...new Set(rows.map((t) => t.resultAssetId).filter((id): id is number => typeof id === 'number'))]
  const assetRows = assetIds.length
    ? await db.select().from(assets).where(inArray(assets.id, assetIds))
    : []
  const assetMap = new Map(assetRows.map((a) => [a.id, assetSnapshotOf(a)]))
  const items = rows.map((t) => taskView(t, t.resultAssetId ? assetMap.get(t.resultAssetId) ?? null : null))
  return c.json({ items })
}))

// GET /tasks/:id —— 任务详情（含 result_asset 快照）
tasksRoutes.get('/tasks/:id', h(async (c) => {
  const rows = await db.select().from(genTasks).where(eq(genTasks.id, idParam(c))).limit(1)
  const t = rows[0]
  if (!t) return notFound(c, `task ${c.req.param('id')}`)
  let resultAsset: AssetSnapshot | null = null
  if (t.resultAssetId) {
    const aRows = await db.select().from(assets).where(eq(assets.id, t.resultAssetId)).limit(1)
    if (aRows[0]) resultAsset = assetSnapshotOf(aRows[0])
  }
  return c.json({ task: taskView(t, resultAsset) })
}))

// POST /tasks/:id/retry —— 重试：attempts 归零 → 步骤回 pending → run 复位并续跑（succeeded 步骤跳过）
tasksRoutes.post('/tasks/:id/retry', h(async (c) => {
  const rows = await db.select().from(genTasks).where(eq(genTasks.id, idParam(c))).limit(1)
  const t = rows[0]
  if (!t) return notFound(c, `task ${c.req.param('id')}`)
  if (!['failed', 'cancelled'].includes(t.status)) {
    throw new HttpError(400, 'bad_status', `仅 failed/cancelled 可重试（当前 ${t.status}）`)
  }
  if (!t.stepId || !t.runId) throw new HttpError(400, 'no_step', '任务未关联 run/step，无法重试')
  const runRows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, t.runId)).limit(1)
  const run = runRows[0]
  if (!run) return notFound(c, `run ${t.runId}`)
  // [方案C] 轻松创作 run：仅「受理状态不明」任务（已提交无任务号/产物，可能已计费）阻断就地重试 → 引导会话核验；
  // 其余失败（纯本地校验失败、有外部 taskId 仅恢复查询、已有产物）放行，与 resume 委派 retryCreation 同口径。
  if (isCreationTemplate(run.templateKey) && isAmbiguousSubmitted(t)) {
    throw new HttpError(409, 'creation_confirmation_required', '该任务受理状态不明（已提交但无外部任务号/产物），可能已被供应商计费，请在轻松创作会话中核验后恢复，避免重复计费')
  }
  if (run.status === 'completed') throw new HttpError(400, 'bad_status', '所属 run 已完成，无需重试')
  if (run.status === 'waiting_input') throw new HttpError(400, 'bad_status', '所属 run 正等待闸门，先处理闸门')
  if (run.status === 'running') throw new HttpError(400, 'bad_status', '所属 run 正在执行，无法重试')

  const now = Date.now()
  await db.update(genTasks).set({ status: 'pending', attempts: 0, errorMsg: null, updatedAt: now }).where(eq(genTasks.id, t.id))
  const stepRows = await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, t.stepId)).limit(1)
  const step = stepRows[0]
  if (step && step.status !== 'succeeded') {
    await db.update(pipelineSteps).set({ status: 'pending', error: null, updatedAt: now }).where(eq(pipelineSteps.id, step.id))
  }
  if (['failed', 'cancelled', 'queued'].includes(run.status)) {
    await db.update(pipelineRuns).set({ status: 'queued', error: null, updatedAt: now }).where(eq(pipelineRuns.id, run.id))
    engine.startRun(run.id)
  }
  return c.json({ ok: true, note: '任务已重新入队；所属 run 正在续跑（成功步骤将跳过，其余失败任务不受影响）' })
}))

// POST /tasks/:id/cancel —— 取消（尽力而为：同步生成无法中断已发出的请求，完成后会校验 run 状态回写失败）
tasksRoutes.post('/tasks/:id/cancel', h(async (c) => {
  const rows = await db.select().from(genTasks).where(eq(genTasks.id, idParam(c))).limit(1)
  const t = rows[0]
  if (!t) return notFound(c, `task ${c.req.param('id')}`)
  if (!['pending', 'processing'].includes(t.status)) {
    throw new HttpError(400, 'bad_status', `仅 pending/processing 可取消（当前 ${t.status}）`)
  }
  await db
    .update(genTasks)
    .set({ status: 'cancelled', errorMsg: 'user cancelled', completedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(genTasks.id, t.id))
  return c.json({ ok: true })
}))

/** 任务视图所需的资产快照字段 */
interface AssetSnapshot {
  id: number
  name: string
  kind: string
  purpose: string | null
  fileUrl: string
}

function assetSnapshotOf(a: typeof assets.$inferSelect): AssetSnapshot {
  return { id: a.id, name: a.name, kind: a.kind, purpose: a.purpose, fileUrl: `/api/v1/assets/${a.id}/file` }
}

function taskView(t: typeof genTasks.$inferSelect, resultAsset: AssetSnapshot | null): Record<string, unknown> {
  let params: unknown = null
  if (t.params) {
    try { params = JSON.parse(t.params) } catch { params = null }
  }
  return {
    id: t.id,
    projectId: t.projectId,
    runId: t.runId,
    stepId: t.stepId,
    kind: t.kind,
    provider: t.provider,
    model: t.model,
    taskId: t.taskId, // 第三方任务 id（ai_video 轮询溯源）
    // [方案C] 受理状态不明标记（单一真源谓词）：前端轻松创作 run 据此逐任务隐显「重试」
    ambiguous: isAmbiguousSubmitted(t),
    status: t.status,
    attempts: t.attempts,
    errorMsg: t.errorMsg,
    prompt: t.prompt,
    params,
    resultAsset,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    completedAt: t.completedAt,
  }
}