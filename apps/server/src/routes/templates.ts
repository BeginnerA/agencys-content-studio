import { Hono } from 'hono'
import { listTemplates, loadTemplate } from '../pipeline/loader'
import { HttpError, h } from './helpers'

export const templatesRoutes = new Hono()

// GET /templates —— 模板清单（扫描 workspace/templates）
templatesRoutes.get('/templates', (c) => {
  return c.json({ items: listTemplates() })
})

// GET /templates/:key —— 完整模板（含步骤/gate/batch，供前端渲染流程）
templatesRoutes.get('/templates/:key', h((c) => {
  const key = c.req.param('key') ?? ''
  try {
    return c.json({ template: loadTemplate(key) })
  } catch (err) {
    throw new HttpError(404, 'template_not_found', (err as Error).message)
  }
}))