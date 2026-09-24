import { Hono } from 'hono'
import { buildRunCanvas, buildTemplateCanvas } from '../services/canvas'
import { buildCanvasOverview } from '../services/canvas-overview'
import { HttpError, h, idParam, notFound } from './helpers'

/**
 * 流水线画布路由（纯读；所有写操作走既有 run/task 端点）：
 * - GET /runs/:id/canvas     运行画布（节点/边/操作可用性；模板取 run 快照）
 * - GET /templates/:key/canvas 模板设计态画布（节点/边；无运行字段）
 * - GET /canvas/overview 全景聚合（批次分组 + 独立 run + 项目统计；E1/E2）
 */
export const canvasRoutes = new Hono()

canvasRoutes.get('/runs/:id/canvas', h(async (c) => {
  const data = await buildRunCanvas(idParam(c))
  if (!data) return notFound(c, `run ${c.req.param('id')}`)
  return c.json(data)
}))

canvasRoutes.get('/templates/:key/canvas', h(async (c) => {
  const key = c.req.param('key') ?? ''
  try {
    return c.json(await buildTemplateCanvas(key))
  } catch (err) {
    throw new HttpError(404, 'template_not_found', (err as Error).message)
  }
}))

// GET /canvas/overview —— 全景聚合（?project_id= 必填；project 缺失 → 404）
canvasRoutes.get('/canvas/overview', h(async (c) => {
  const raw = c.req.query('project_id')
  const projectId = raw != null && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new HttpError(400, 'bad_project_id', 'project_id 需为正整数')
  }
  const data = await buildCanvasOverview(projectId)
  if (!data) return notFound(c, `项目 ${projectId}`)
  return c.json(data)
}))
