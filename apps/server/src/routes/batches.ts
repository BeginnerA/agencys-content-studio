/**
 * 批次 REST（E1）：创建/列表/详情/取消/删除
 * - POST /projects/:id/batches：校验 → 落批 + N run → 首轮 pump
 */
import { Hono } from 'hono'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { batches, pipelineRuns, projects } from '../db/schema'
import { cancelBatch, createBatch, summarizeBatch, toBatchView } from '../services/batch'
import { isRunDeletable, purgeRunRecords, removeRunLogFiles } from '../services/run-delete'
import { engine } from '../pipeline/engine'
import { InvalidRunInputError } from '../services/run-create'
import { BudgetBlockedError } from '../services/budget'
import { HttpError, h, idParam, notFound } from './helpers'

export const batchesRoutes = new Hono()

// POST /projects/:id/batches —— 创建批次（校验 → 落批 + N run → 首轮 pump）
batchesRoutes.post('/projects/:id/batches', h(async (c) => {
  const projectId = idParam(c)
  const projRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1)
  if (!projRows[0]) return notFound(c, `项目 ${projectId}`)
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const templateKey = typeof body['template_key'] === 'string' ? body['template_key'] : projRows[0].templateKey
  const inputs = body['inputs']
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new HttpError(400, 'bad_input', 'inputs 需为非空数组（批量输入组）')
  }
  const schedule = body['schedule'] as { max_concurrent?: unknown } | undefined
  if (schedule?.max_concurrent !== undefined) {
    const mc = schedule.max_concurrent
    if (typeof mc !== 'number' || !Number.isInteger(mc) || mc < 1 || mc > 3) {
      throw new HttpError(400, 'bad_schedule', 'schedule.max_concurrent 需为 1–3 的整数')
    }
  }
  try {
    const { batch, runIds } = await createBatch({
      projectId,
      templateKey,
      name: typeof body['name'] === 'string' ? body['name'] : undefined,
      schedule: schedule as { max_concurrent?: number } | undefined,
      inputs: inputs as Array<Record<string, unknown>>,
    })
    return c.json({ batch: toBatchView(batch), runIds }, 201)
  } catch (err) {
    if (err instanceof InvalidRunInputError) throw new HttpError(400, err.code, err.message)
    // [审计G3] 预算闸门拦截（createBatch 单一真源抛出）→ 409，与 runs POST / resume 同口径
    if (err instanceof BudgetBlockedError) throw new HttpError(409, err.code, err.message)
    throw err
  }
}))

// GET /batches —— 列表（?project_id=&status=）
batchesRoutes.get('/batches', h(async (c) => {
  const conds = []
  const projectId = c.req.query('project_id')
  if (projectId) conds.push(eq(batches.projectId, Number(projectId)))
  const status = c.req.query('status')
  if (status) conds.push(eq(batches.status, status))
  const rows = await db
    .select()
    .from(batches)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(batches.createdAt))
    .limit(100)
  return c.json({ items: rows.map(toBatchView) })
}))

// GET /batches/:id —— 详情（batch + runs 摘要含成本）
batchesRoutes.get('/batches/:id', h(async (c) => {
  const detail = await summarizeBatch(idParam(c))
  if (!detail) return notFound(c, `批次 ${c.req.param('id')}`)
  return c.json({
    batch: toBatchView(detail.batch),
    runs: detail.runs.map((r) => ({
      id: r.id,
      batchSeq: r.batchSeq,
      status: r.status,
      error: r.error,
      input: safeParse(r.input),
      cost: r.cost,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
    })),
  })
}))

// POST /batches/:id/cancel —— 取消（幂等）
batchesRoutes.post('/batches/:id/cancel', h(async (c) => {
  const batchId = idParam(c)
  await cancelBatch(batchId)
  const fresh = (await db.select().from(batches).where(eq(batches.id, batchId)).limit(1))[0]
  if (!fresh) return notFound(c, `批次 ${batchId}`)
  return c.json({ batch: toBatchView(fresh) })
}))

// DELETE /batches/:id —— 删除批次（批次 + 批内全部 run 记录；仅终态可删，产物资产与用量流水保留）
batchesRoutes.delete('/batches/:id', h(async (c) => {
  const batchId = idParam(c)
  const batch = (await db.select().from(batches).where(eq(batches.id, batchId)).limit(1))[0]
  if (!batch) return notFound(c, `批次 ${batchId}`)
  const runs = await db
    .select({ id: pipelineRuns.id, status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.batchId, batchId))
  const active = runs.filter((r) => !isRunDeletable(r.status, engine.isRunning(r.id)))
  if (active.length) {
    throw new HttpError(409, 'batch_running', `批内还有 ${active.length} 个未完成运行，请先取消批次后再删除`)
  }
  const purged = await purgeRunRecords(runs.map((r) => r.id))
  await db.delete(batches).where(eq(batches.id, batchId))
  removeRunLogFiles(runs.map((r) => r.id))
  return c.json({ ok: true, batchId, ...purged })
}))

/** input 快照解析（宽容：失败原样返回） */
function safeParse(s: string | null): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
