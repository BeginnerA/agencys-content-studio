import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import type { CanvasNode } from '../db/schema'
import { characters, projects } from '../db/schema'
import { assertProjectAssets } from '../pipeline/refs'
import { attachRefAssets, type EntityKind } from '../services/character'
import {
  addAssetNode,
  addEdge,
  addEntityNode,
  addGenNode,
  addRunNode,
  addTextNode,
  assertRestorableSource,
  buildCanvasDoc,
  buildTemplateDraft,
  claimNodeTasks,
  createCanvas,
  deleteCanvas,
  deleteEdge,
  deleteNode,
  duplicateCanvas,
  extractTextNode,
  findCanvas,
  findNode,
  listCanvases,
  updateCanvas,
  updateNode,
} from '../services/creation'
import { startCanvasNodeRun } from '../services/creation-gen'
import { exportCanvas } from '../services/creation-export'
import { arrangeNodes, batchNodes, chainNodes, copyNodes, deleteNodes, promptExpandNode, runCanvasNodes } from '../services/creation-ops'
import { HttpError, h, idParam, notFound } from './helpers'

/**
 * [M16/M17] 创作画布路由（M16 既有 14 枚超集 + M17 新增 9 枚 = 23 枚）：
 * - 文档 CRUD：画布/节点/边（服务端全量校验——端口矩阵 v2 / 环检测 / 项目域资产 / [M17] from 侧类型）；
 * - [M17] 节点类型扩展：text / entity / run（全型节点建/改/删）；extract 文本提取；
 * - [M17] 批量操控：batch（预校验回滚）/ delete / copy / chain（规则串联）/ arrange（整理·对齐·分布）/ canvases/run（批量执行）；
 * - 执行入口 run（variants 1-4 超集；readiness 不过 → 400 附问题清单）；任务取消复用 POST /tasks/:id/cancel；
 * - [M17] 产出与辅助：export（zip 打包 → archive 资产）/ prompt-expand（AI 扩写，未配置 LLM → 400 引导 Settings）；
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

// POST /canvases/:id/nodes —— 建节点：
//   { kind:'asset', assetId, x, y } / { kind:'gen', spec, x, y }（M16）
//   [M17] { kind:'text', spec:{text}, x, y } / { kind:'entity', entityId, x, y } / { kind:'run', runId, x, y }
//   [M17] 可选 restoreFromNodeId：撤销删除重建时认领已删节点任务历史（仅 gen；源节点须已删）→ { node, claimed }
creationRoutes.post('/canvases/:id/nodes', h(async (c) => {
  const canvas = await findCanvas(idParam(c))
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  const body = await readJson(c)
  const kind = body['kind']
  // [M17] 快照重建认领前置校验：失败 → 400 且不建节点（避免残留；文案与 claimNodeTasks 同源）
  const restoreFrom = body['restoreFromNodeId']
  const doClaim = restoreFrom !== undefined && restoreFrom !== null
  if (doClaim) {
    if (kind !== 'gen') throw new HttpError(400, 'bad_restore', '仅生成节点可认领任务历史')
    await assertRestorableSource(restoreFrom)
  }
  let node: CanvasNode
  if (kind === 'asset') {
    node = await addAssetNode(canvas, body['assetId'], body['x'], body['y'], body['title'])
  } else if (kind === 'gen') {
    node = await addGenNode(canvas, body['spec'], body['x'], body['y'], body['title'])
  } else if (kind === 'text') {
    node = await addTextNode(canvas, body['spec'], body['x'], body['y'], body['title'])
  } else if (kind === 'entity') {
    node = await addEntityNode(canvas, body['entityId'], body['x'], body['y'], body['title'])
  } else if (kind === 'run') {
    node = await addRunNode(canvas, body['runId'], body['x'], body['y'], body['title'])
  } else {
    throw new HttpError(400, 'bad_kind', `kind 非法（asset|gen|text|entity|run）: ${String(kind)}`)
  }
  if (!doClaim) return c.json({ node }, 201)
  const claimed = await claimNodeTasks(canvas, node, restoreFrom)
  return c.json({ node, claimed }, 201)
}))

// PATCH /nodes/:id —— 更新 { x?, y?, title?, spec?, seq?, adoptedTaskId? }（spec 合法校验；gen/text 可改 spec）
creationRoutes.patch('/nodes/:id', h(async (c) => {
  const body = await readJson(c)
  const node = await updateNode(idParam(c), {
    x: body['x'],
    y: body['y'],
    title: body['title'],
    spec: body['spec'],
    seq: body['seq'],
    adoptedTaskId: body['adoptedTaskId'],
  })
  if (!node) return notFound(c, `节点 ${c.req.param('id')}`)
  return c.json({ node })
}))

// DELETE /nodes/:id —— 删节点（级联其全部连线）
creationRoutes.delete('/nodes/:id', h(async (c) => {
  const okDel = await deleteNode(idParam(c))
  if (!okDel) return notFound(c, `节点 ${c.req.param('id')}`)
  return c.json({ ok: true })
}))

// [M17] POST /nodes/:id/extract —— 提取文本节点 { x?, y? }（gen: spec.prompt；asset: 文本资产全文）
// 宽容读体：缺省位置 = 源节点右侧偏移（web 常无 body 调用）
creationRoutes.post('/nodes/:id/extract', h(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const node = await extractTextNode(idParam(c), body['x'], body['y'])
  if (!node) return notFound(c, `节点 ${c.req.param('id')}`)
  return c.json({ node }, 201)
}))

// [M17] POST /canvases/:id/nodes/batch —— 批量部分更新 { updates:[{id,x?,y?,title?,spec?,seq?,adoptedTaskId?}] }
//（预校验全量合法才写；spec 校验同 PATCH → 失败零写入）
creationRoutes.post('/canvases/:id/nodes/batch', h(async (c) => {
  const canvas = await findCanvas(idParam(c))
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  const body = await readJson(c)
  const { updated } = await batchNodes(canvas, body['updates'])
  return c.json({ ok: true, updated })
}))

// [M17] POST /canvases/:id/nodes/delete —— 批量删除 { ids }（级联边）→ { deleted, edges }
creationRoutes.post('/canvases/:id/nodes/delete', h(async (c) => {
  const canvas = await findCanvas(idParam(c))
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  const body = await readJson(c)
  const { deleted, edges } = await deleteNodes(canvas, body['ids'])
  return c.json({ deleted, edges })
}))

// [M17] POST /canvases/:id/nodes/copy —— 批量复制 { ids, offset? }（深拷；集合内部边重映射）→ { nodes, edges }
creationRoutes.post('/canvases/:id/nodes/copy', h(async (c) => {
  const canvas = await findCanvas(idParam(c))
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  const body = await readJson(c)
  const { nodes, edges } = await copyNodes(canvas, body['ids'], body['offset'])
  return c.json({ nodes, edges }, 201)
}))

// [M17] POST /canvases/:id/nodes/chain —— 规则式串联 { ids } → { created, skipped:[{from,to,reason}] }
creationRoutes.post('/canvases/:id/nodes/chain', h(async (c) => {
  const canvas = await findCanvas(idParam(c))
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  const body = await readJson(c)
  const { created, skipped } = await chainNodes(canvas, body['ids'])
  return c.json({ created, skipped })
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

// POST /nodes/:id/run —— 执行 gen 节点 { variants?: 1-4 }（readiness/spec 不过 → 400 附问题；成功 → N 任务入队）
// 宽容读体：M16 旧调用不带 body（默认 ×1）；响应保留 taskId（= 首条）+ taskIds 超集
creationRoutes.post('/nodes/:id/run', h(async (c) => {
  const id = idParam(c)
  const node = await findNode(id)
  if (!node) return notFound(c, `节点 ${id}`)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const variantsRaw = body['variants']
  let variants = 1
  if (variantsRaw !== undefined && variantsRaw !== null) {
    const v = Number(variantsRaw)
    if (!Number.isInteger(v) || v < 1 || v > 4) throw new HttpError(400, 'bad_variants', 'variants 需为 1-4 的整数')
    variants = v
  }
  const { taskId, taskIds } = await startCanvasNodeRun(id, variants)
  return c.json({ ok: true, taskId, taskIds })
}))

// [M17] POST /nodes/:id/prompt-expand —— AI 扩写 { instruction? } → { prompt, provider, model }（不落库；未配置 LLM → 400 引导 Settings）
creationRoutes.post('/nodes/:id/prompt-expand', h(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const result = await promptExpandNode(idParam(c), body['instruction'])
  if (!result) return notFound(c, `节点 ${c.req.param('id')}`)
  return c.json(result)
}))

// [M17] POST /canvases/:id/arrange —— 整理/对齐/分布 { mode, nodeIds?, sortBy? } → { updated, positions }
creationRoutes.post('/canvases/:id/arrange', h(async (c) => {
  const canvas = await findCanvas(idParam(c))
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  const body = await readJson(c)
  const { updated, positions } = await arrangeNodes(canvas, {
    mode: body['mode'],
    nodeIds: body['nodeIds'],
    sortBy: body['sortBy'],
  })
  return c.json({ updated, positions })
}))

// [M17] POST /canvases/:id/run —— 批量执行 { nodeIds?, variants? } → { started, skipped:[{nodeId,problems}] }
//（只入队就绪节点；不级联等待）
creationRoutes.post('/canvases/:id/run', h(async (c) => {
  const canvas = await findCanvas(idParam(c))
  if (!canvas) return notFound(c, `画布 ${c.req.param('id')}`)
  // 宽容读体：web 全量执行不带 body（缺省 = 全画布）；variants/nodeIds 非法 → runCanvasNodes 领域错误 400
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const { started, skipped } = await runCanvasNodes(canvas, { nodeIds: body['nodeIds'], variants: body['variants'] })
  return c.json({ started, skipped })
}))

// [M17] POST /canvases/:id/export —— 打包导出 { nodeIds? }（zip → archive 资产；下载复用 GET /assets/:id/file?download=1）
creationRoutes.post('/canvases/:id/export', h(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const result = await exportCanvas(idParam(c), body['nodeIds'])
  if (!result) return notFound(c, `画布 ${c.req.param('id')}`)
  return c.json(
    { asset: { id: result.asset.id, name: result.asset.name, size: result.asset.fileSize }, stats: result.stats },
    201,
  )
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
