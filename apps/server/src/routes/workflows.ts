/**
 * 自动编排链 REST（挂 /api/v1，spec §2.3）
 * - CRUD：列表 / 详情 / 建 / 改 / 删 / 克隆（I2）
 * - 状态转移：start / pause / resume
 * P0 骨架：start 仅置 active（首段 run 创建 + 级联于 P1 实装）；改 segments 的 active 守卫在此层。
 */
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { projects } from '../db/schema'
import {
  cloneWorkflow,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  parseSegments,
  resumeWorkflow,
  setWorkflowStatus,
  startWorkflow,
  toWorkflowView,
  updateWorkflow,
  validateWorkflowChainDoc,
  WorkflowError,
  type WorkflowSegment,
} from '../services/workflow'
import { HttpError, h, idParam, notFound } from './helpers'

export const workflowsRoutes = new Hono()

// GET /workflows —— 列表（?project_id=&status=）
workflowsRoutes.get('/workflows', h(async (c) => {
  const projectId = c.req.query('project_id')
  const status = c.req.query('status')
  const items = await listWorkflows({
    projectId: projectId ? Number(projectId) : undefined,
    status: status || undefined,
  })
  return c.json({ items: items.map(toWorkflowView) })
}))

// GET /workflows/:id —— 详情
workflowsRoutes.get('/workflows/:id', h(async (c) => {
  const row = await getWorkflow(idParam(c))
  if (!row) return notFound(c, `编排链 ${c.req.param('id')}`)
  return c.json({ workflow: toWorkflowView(row) })
}))

// POST /projects/:id/workflows —— 建链
workflowsRoutes.post('/projects/:id/workflows', h(async (c) => {
  const projectId = idParam(c)
  const projRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1)
  if (!projRows[0]) return notFound(c, `项目 ${projectId}`)

  const body = await readJson(c)
  const segments = readSegments(body['segments'])
  const valid = validateWorkflowChainDoc(segments)
  if (!valid.ok) {
    throw new HttpError(400, 'bad_chain', valid.errors.join('；'))
  }
  const name = typeof body['name'] === 'string' ? body['name'] : ''
  const autoAdvance = body['auto_advance'] === 1 || body['auto_advance'] === true ? 1 : 0
  const budgetCap = readBudgetCap(body['budget_cap'])
  const note = typeof body['note'] === 'string' ? body['note'] : null

  const row = await createWorkflow({ projectId, name, segments, autoAdvance, budgetCap, note })
  return c.json({ workflow: toWorkflowView(row), warnings: valid.warnings }, 201)
}))

// PATCH /workflows/:id —— 改名 / segments / autoAdvance / budgetCap / note
workflowsRoutes.patch('/workflows/:id', h(async (c) => {
  const id = idParam(c)
  const cur = await getWorkflow(id)
  if (!cur) return notFound(c, `编排链 ${id}`)
  const body = await readJson(c)

  const patch: Parameters<typeof updateWorkflow>[1] = {}
  if (typeof body['name'] === 'string') patch.name = body['name']
  if (body['auto_advance'] !== undefined) patch.autoAdvance = body['auto_advance'] === 1 || body['auto_advance'] === true ? 1 : 0
  if (body['budget_cap'] !== undefined) patch.budgetCap = readBudgetCap(body['budget_cap'])
  if (body['note'] !== undefined) patch.note = typeof body['note'] === 'string' ? body['note'] : null
  if (body['segments'] !== undefined) {
    // active 链改 segments 需先 draft|paused
    if (cur.status === 'active') {
      throw new HttpError(409, 'active_locked', 'active 链不可直接改 segments，请先 pause')
    }
    const segs = readSegments(body['segments'])
    const valid = validateWorkflowChainDoc(segs)
    if (!valid.ok) throw new HttpError(400, 'bad_chain', valid.errors.join('；'))
    patch.segments = segs
  }

  const row = await updateWorkflow(id, patch)
  return c.json({ workflow: toWorkflowView(row!) })
}))

// DELETE /workflows/:id —— 删除（仅 draft|done|cancelled）
workflowsRoutes.delete('/workflows/:id', h(async (c) => {
  const id = idParam(c)
  const cur = await getWorkflow(id)
  if (!cur) return notFound(c, `编排链 ${id}`)
  if (!['draft', 'done', 'cancelled'].includes(cur.status)) {
    throw new HttpError(409, 'not_deletable', `status=${cur.status} 的链不可删除（仅 draft|done|cancelled）`)
  }
  await deleteWorkflow(id)
  return c.json({ ok: true })
}))

// POST /workflows/:id/clone —— 克隆为 draft（I2 编排层引用复用）
workflowsRoutes.post('/workflows/:id/clone', h(async (c) => {
  const id = idParam(c)
  const cur = await getWorkflow(id)
  if (!cur) return notFound(c, `编排链 ${id}`)
  const row = await cloneWorkflow(id)
  return c.json({ workflow: toWorkflowView(row!) }, 201)
}))

// POST /workflows/:id/start —— 显式创建并启动首段 run（draft|paused→active）
workflowsRoutes.post('/workflows/:id/start', h(async (c) => {
  const id = idParam(c)
  try {
    const { workflow, runId } = await startWorkflow(id)
    return c.json({ workflow: toWorkflowView(workflow), runId })
  } catch (err) {
    if (err instanceof WorkflowError) throw new HttpError(err.code === 'not_found' ? 404 : 409, err.code, err.message)
    throw err
  }
}))

// POST /workflows/:id/pause
workflowsRoutes.post('/workflows/:id/pause', h(async (c) => {
  const id = idParam(c)
  const cur = await getWorkflow(id)
  if (!cur) return notFound(c, `编排链 ${id}`)
  const row = await setWorkflowStatus(id, 'paused')
  return c.json({ workflow: toWorkflowView(row!) })
}))

// POST /workflows/:id/resume —— paused → active 并重新驱动推进（断点恢复）
workflowsRoutes.post('/workflows/:id/resume', h(async (c) => {
  const id = idParam(c)
  try {
    const row = await resumeWorkflow(id)
    return c.json({ workflow: toWorkflowView(row) })
  } catch (err) {
    if (err instanceof WorkflowError) throw new HttpError(err.code === 'not_found' ? 404 : 409, err.code, err.message)
    throw err
  }
}))

// ========== 辅助 ==========

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad_json', '请求体需为对象')
  }
  return body as Record<string, unknown>
}

/** 解析并结构校验 segments（模板合法性校验 validateWorkflowChainDoc 于 P1 接入） */
function readSegments(v: unknown): WorkflowSegment[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new HttpError(400, 'bad_segments', 'segments 需为非空数组')
  }
  const segs = parseSegments(JSON.stringify(v))
  for (const s of segs) {
    if (!s || typeof s.templateKey !== 'string' || !s.templateKey.trim()) {
      throw new HttpError(400, 'bad_segments', '每段需含非空 templateKey')
    }
  }
  return segs
}

function readBudgetCap(v: unknown): number | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'bad_budget_cap', 'budget_cap 需为非负数或 null')
  return n
}
