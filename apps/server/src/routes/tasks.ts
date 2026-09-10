import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { assets, genTasks, pipelineRuns, pipelineSteps } from '../db/schema'
import { engine } from '../pipeline/engine'
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
  const items = []
  for (const t of rows) items.push(await withAsset(t))
  return c.json({ items })
}))

// GET /tasks/:id —— 任务详情（含 result_asset 快照）
tasksRoutes.get('/tasks/:id', h(async (c) => {
  const rows = await db.select().from(genTasks).where(eq(genTasks.id, idParam(c))).limit(1)
  const t = rows[0]
  if (!t) return notFound(c, `task ${c.req.param('id')}`)
  return c.json({ task: await withAsset(t) })
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

async function withAsset(t: typeof genTasks.$inferSelect): Promise<Record<string, unknown>> {
  let resultAsset: unknown = null
  if (t.resultAssetId) {
    const rows = await db.select().from(assets).where(eq(assets.id, t.resultAssetId)).limit(1)
    const a = rows[0]
    if (a) resultAsset = { id: a.id, name: a.name, kind: a.kind, purpose: a.purpose, fileUrl: `/api/v1/assets/${a.id}/file` }
  }
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