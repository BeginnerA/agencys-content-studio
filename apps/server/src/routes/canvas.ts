import { Hono } from 'hono'
import { buildRunCanvas, buildTemplateCanvas } from '../services/canvas'
import { HttpError, h, idParam, notFound } from './helpers'

/**
 * [M15] 流水线画布路由（纯读两枚；所有写操作走既有 run/task 端点）：
 * - GET /runs/:id/canvas     运行画布（节点/边/操作可用性；模板取 run 快照）
 * - GET /templates/:key/canvas 模板设计态画布（节点/边；无运行字段）
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
