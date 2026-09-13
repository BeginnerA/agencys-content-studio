import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { characters, projects } from '../db/schema'
import { assertProjectAssets } from '../pipeline/refs'
import { attachRefAssets, type EntityKind } from '../services/character'
import {
  addAssetNode,
  addEdge,
  addGenNode,
  buildCanvasDoc,
  buildTemplateDraft,
  createCanvas,
  deleteCanvas,
  deleteEdge,
  deleteNode,
  duplicateCanvas,
  findCanvas,
  findNode,
  listCanvases,
  updateCanvas,
  updateNode,
} from '../services/creation'
import { startCanvasNodeRun } from '../services/creation-gen'
import { HttpError, h, idParam, notFound } from './helpers'

/**
 * [M16] 创作画布路由（14 枚）：
 * - 文档 CRUD：画布/节点/边（服务端全量校验——端口矩阵 / 环检测 / 项目域资产）；
 * - 执行入口 run（readiness 不过 → 400 附问题清单）；任务取消复用 POST /tasks/:id/cancel；
 * - 沉淀：duplicate（深拷）/ template-draft（低保真导出 + 既有校验自检）；
 * - 联动：/entities/:id/ref-assets（画布产物并集挂接实体，复用 attachRefAssets）。
 */
export const creationRoutes = new Hono()

// GET /projects/:id/canvases —— 画布列表（含节点数/更新时间）
creationRoutes.get('/projects/:id/canvases', h(async (c) => {
  const items = await listCanvases(idParam(c))
  return c.json({ items })
}))

// POST /projects/:id/canvases —— 新建画布 { name? }
creationRoutes.post('/projects/:id/canvases', h(async (c) => {
  const projectId = idParam(c)
  const exists = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!exists[0]) return notFound(c, `项目 ${projectId}`)
  const body = await readJson(c)
  const name = body['name']
  if (name !== undefined && name !== null && typeof name !== 'string') {
    throw new HttpError(400, 'bad_name', 'name 需为字符串')
  }
  const canvas = await createCanvas(projectId, typeof name === 'string' ? name : undefined)
  return c.json({ canvas }, 201)
}))

// GET /canvases/:id —— 画布文档（全量读模型：节点/边/状态派生/readiness 预检）
creationRoutes.get('/canvases/:id', h(async (c) => {
  const doc = await buildCanvasDoc(idParam(c))
  if (!doc) return notFound(c, `画布 ${c.req.param('id')}`)
  return c.json(doc)
}))

// PATCH /canvases/:id —— 改名 / 存视口 { name?, viewport? }
creationRoutes.patch('/canvases/:id', h(async (c) => {
  const body = await readJson(c)
  const canvas = await updateCanvas(idParam(c), { name: body['name'], viewport: body['viewport'] })
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  return c.json({ canvas })
}))

// DELETE /canvases/:id —— 删画布（级联节点 + 边；进行中任务由执行器自然宽限失败）
creationRoutes.delete('/canvases/:id', h(async (c) => {
  const okDel = await deleteCanvas(idParam(c))
  if (!okDel) return notFound(c, `画布 ${c.req.param('id')}`)
  return c.json({ ok: true })
}))

// POST /canvases/:id/nodes —— 建节点：{ kind:'asset', assetId, x, y } 或 { kind:'gen', spec, x, y }
creationRoutes.post('/canvases/:id/nodes', h(async (c) => {
  const canvas = await findCanvas(idParam(c))
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  const body = await readJson(c)
  const kind = body['kind']
  if (kind === 'asset') {
    const node = await addAssetNode(canvas, body['assetId'], body['x'], body['y'], body['title'])
    return c.json({ node }, 201)
  }
  if (kind === 'gen') {
    const node = await addGenNode(canvas, body['spec'], body['x'], body['y'], body['title'])
    return c.json({ node }, 201)
  }
  throw new HttpError(400, 'bad_kind', `kind 非法（asset|gen）: ${String(kind)}`)
}))

// PATCH /nodes/:id —— 更新 { x?, y?, title?, spec? }（spec 合法校验；素材节点不可改 spec）
creationRoutes.patch('/nodes/:id', h(async (c) => {
  const body = await readJson(c)
  const node = await updateNode(idParam(c), { x: body['x'], y: body['y'], title: body['title'], spec: body['spec'] })
  if (!node) return notFound(c, `节点 ${c.req.param('id')}`)
  return c.json({ node })
}))

// DELETE /nodes/:id —— 删节点（级联其全部连线）
creationRoutes.delete('/nodes/:id', h(async (c) => {
  const okDel = await deleteNode(idParam(c))
  if (!okDel) return notFound(c, `节点 ${c.req.param('id')}`)
  return c.json({ ok: true })
}))

// POST /canvases/:id/edges —— 建边 { from, to, port }（端口矩阵 + 环检测）
creationRoutes.post('/canvases/:id/edges', h(async (c) => {
  const canvas = await findCanvas(idParam(c))
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  const body = await readJson(c)
  const edge = await addEdge(canvas, body['from'], body['to'], body['port'])
  return c.json({ edge }, 201)
}))

// DELETE /edges/:id —— 删边
creationRoutes.delete('/edges/:id', h(async (c) => {
  const okDel = await deleteEdge(idParam(c))
  if (!okDel) return notFound(c, `连线 ${c.req.param('id')}`)
  return c.json({ ok: true })
}))

// POST /nodes/:id/run —— 执行 gen 节点（readiness/spec 不过 → 400 附问题；成功 → 任务入队）
creationRoutes.post('/nodes/:id/run', h(async (c) => {
  const id = idParam(c)
  const node = await findNode(id)
  if (!node) return notFound(c, `节点 ${id}`)
  const { taskId } = await startCanvasNodeRun(id)
  return c.json({ ok: true, taskId })
}))

// POST /canvases/:id/duplicate —— 复制画布 { name? }（节点 id 映射后重建边）
creationRoutes.post('/canvases/:id/duplicate', h(async (c) => {
  const body = await readJson(c)
  const name = body['name']
  if (name !== undefined && name !== null && typeof name !== 'string') {
    throw new HttpError(400, 'bad_name', 'name 需为字符串')
  }
  const canvas = await duplicateCanvas(idParam(c), typeof name === 'string' ? name : undefined)
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  return c.json({ canvas }, 201)
}))

// POST /canvases/:id/template-draft —— 模板草案 { key? } → { yaml, validation }
creationRoutes.post('/canvases/:id/template-draft', h(async (c) => {
  const body = await readJson(c)
  const key = body['key']
  if (key !== undefined && key !== null && typeof key !== 'string') {
    throw new HttpError(400, 'bad_key', 'key 需为字符串')
  }
  const draft = await buildTemplateDraft(idParam(c), typeof key === 'string' ? key : undefined)
  if (!draft) return notFound(c, `画布 ${c.req.param('id')}`)
  return c.json(draft)
}))

// POST /entities/:id/ref-assets —— 联动：资产并集挂接实体 { asset_ids }（项目域校验；全局实体拒绝）
creationRoutes.post('/entities/:id/ref-assets', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(characters).where(eq(characters.id, id)).limit(1)
  const cur = rows[0]
  if (!cur) return notFound(c, `素材 ${id}`)
  if (cur.projectId === null) {
    throw new HttpError(400, 'bad_ref_assets', '全局素材库不接受项目资产引用（请在项目素材页操作）')
  }
  const body = await readJson(c)
  const rawIds = body['asset_ids']
  if (!Array.isArray(rawIds)) throw new HttpError(400, 'bad_asset_ids', 'asset_ids 需为正整数数组')
  const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  if (ids.length === 0) throw new HttpError(400, 'bad_asset_ids', 'asset_ids 需为正整数数组')
  const verified = await assertProjectAssets(cur.projectId, ids, 'asset_ids')
  const added = await attachRefAssets(cur.projectId, cur.name, verified, cur.kind as EntityKind)
  return c.json({ ok: true, added })
}))

/** 请求体 JSON 对象读取（非对象 → 400） */
async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad_json', '请求体需为 JSON 对象')
  }
  return body as Record<string, unknown>
}
