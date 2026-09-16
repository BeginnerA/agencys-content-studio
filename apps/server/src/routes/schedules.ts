/**
 * [M20] 排产计划 + 预算 REST（B1/B4/B5）
 * - 排产：CRUD + 日历视图 + 手动触发/重置
 * - 预算：读取/保存配置 + 概览 + 告警历史
 */
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { projects, schedules } from '../db/schema'
import {
  cancelSchedule,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  resetSchedule,
  scheduleCalendar,
} from '../services/schedule'
import {
  budgetOverview,
  checkAlerts,
  listAlerts,
  loadBudget,
  saveBudget,
} from '../services/budget'
import { HttpError, h, idParam, notFound } from './helpers'

export const schedulesRoutes = new Hono()

// ========== 排产计划 ==========

// GET /schedules —— 列表（?project_id=&status=）
schedulesRoutes.get('/schedules', h(async (c) => {
  const projectId = c.req.query('project_id')
  const status = c.req.query('status')
  const items = await listSchedules({
    projectId: projectId ? Number(projectId) : undefined,
    status: status || undefined,
  })
  return c.json({ items: items.map(toScheduleView) })
}))

// GET /schedules/calendar —— 日历视图（?project_id=&from=&to=）
schedulesRoutes.get('/schedules/calendar', h(async (c) => {
  const projectId = c.req.query('project_id')
  const from = Number(c.req.query('from') ?? Date.now() - 30 * 86_400_000)
  const to = Number(c.req.query('to') ?? Date.now() + 60 * 86_400_000)
  const items = await scheduleCalendar({
    projectId: projectId ? Number(projectId) : undefined,
    from,
    to,
  })
  return c.json({ items })
}))

// GET /schedules/:id —— 详情
schedulesRoutes.get('/schedules/:id', h(async (c) => {
  const row = await getSchedule(idParam(c))
  if (!row) return notFound(c, `计划 ${c.req.param('id')}`)
  return c.json({ schedule: toScheduleView(row) })
}))

// POST /projects/:id/schedules —— 创建
schedulesRoutes.post('/projects/:id/schedules', h(async (c) => {
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
  const name = typeof body['name'] === 'string' ? body['name'] : ''
  const templateKey = typeof body['template_key'] === 'string' ? body['template_key'] : projRows[0].templateKey
  const scheduledAt = Number(body['scheduled_at'])
  if (!Number.isInteger(scheduledAt) || scheduledAt < Date.now() - 60_000) {
    throw new HttpError(400, 'bad_scheduled_at', 'scheduled_at 需为未来时间戳（ms）')
  }
  const inputTemplate = body['input_template']
  if (!Array.isArray(inputTemplate) || !inputTemplate.length) {
    throw new HttpError(400, 'bad_input_template', 'input_template 需为非空数组')
  }

  const row = await createSchedule({
    projectId,
    name,
    templateKey,
    scheduledAt,
    inputTemplate: inputTemplate as Array<Record<string, unknown>>,
    note: typeof body['note'] === 'string' ? body['note'] : undefined,
  })
  return c.json({ schedule: toScheduleView(row) }, 201)
}))

// POST /schedules/:id/cancel —— 取消
schedulesRoutes.post('/schedules/:id/cancel', h(async (c) => {
  await cancelSchedule(idParam(c))
  const row = await getSchedule(idParam(c))
  return c.json({ schedule: toScheduleView(row!) })
}))

// POST /schedules/:id/reset —— 重置为 pending（重新触发）
schedulesRoutes.post('/schedules/:id/reset', h(async (c) => {
  await resetSchedule(idParam(c))
  const row = await getSchedule(idParam(c))
  return c.json({ schedule: toScheduleView(row!) })
}))

// DELETE /schedules/:id —— 删除（仅非 pending）
schedulesRoutes.delete('/schedules/:id', h(async (c) => {
  await deleteSchedule(idParam(c))
  return c.json({ ok: true })
}))

// ========== 预算 ==========

// GET /budget —— 预算概览
schedulesRoutes.get('/budget', h(async (c) => {
  const overview = await budgetOverview()
  return c.json(overview)
}))

// PUT /budget —— 保存预算配置
schedulesRoutes.put('/budget', h(async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const cfg = body as Record<string, unknown>
  // 基础校验
  if (cfg.projects !== undefined && (typeof cfg.projects !== 'object' || cfg.projects === null)) {
    throw new HttpError(400, 'bad_budget', 'budget.projects 需为对象')
  }
  if (cfg.global !== undefined && (typeof cfg.global !== 'object' || cfg.global === null)) {
    throw new HttpError(400, 'bad_budget', 'budget.global 需为对象')
  }
  await saveBudget(cfg as Parameters<typeof saveBudget>[0])
  const fresh = await loadBudget()
  return c.json({ budget: fresh })
}))

// GET /budget/alerts —— 告警历史
schedulesRoutes.get('/budget/alerts', h(async (c) => {
  const projectId = c.req.query('project_id')
  const items = await listAlerts({
    projectId: projectId ? Number(projectId) : undefined,
  })
  return c.json({ items })
}))

// POST /budget/check —— 手动检查预算（供前端 run 创建前调用）
schedulesRoutes.post('/budget/check', h(async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const projectId = Number(body['project_id'])
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new HttpError(400, 'bad_input', 'project_id 必填')
  }
  const estimatedCost = typeof body['estimated_cost'] === 'number' ? body['estimated_cost'] : 0
  // 注意：这里不直接拦截，只返回检查结果供前端决策
  const { checkBudget } = await import('../services/budget')
  const result = await checkBudget({ projectId, estimatedCost })
  return c.json({ allowed: result === null, reason: result })
}))

// POST /budget/check-alerts —— 手动触发告警检查
schedulesRoutes.post('/budget/check-alerts', h(async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const projectId = Number(body['project_id'])
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new HttpError(400, 'bad_input', 'project_id 必填')
  }
  await checkAlerts({ projectId })
  return c.json({ ok: true })
}))

// ========== 辅助 ==========

function toScheduleView(s: typeof schedules.$inferSelect): Record<string, unknown> {
  let inputTemplate: unknown = {}
  try { inputTemplate = JSON.parse(s.inputTemplate) } catch { /* 损坏保持原值 */ }
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    templateKey: s.templateKey,
    cronExpr: s.cronExpr,
    scheduledAt: s.scheduledAt,
    status: s.status,
    lastTriggeredAt: s.lastTriggeredAt,
    lastBatchId: s.lastBatchId,
    inputTemplate,
    note: s.note,
    isActive: s.isActive,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}
