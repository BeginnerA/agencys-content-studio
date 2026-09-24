import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  assertVersionOwned,
  downstreamImpact,
  listVersions,
  lockCanvasInput,
  ProvenanceError,
  readVersionContent,
  restoreAssetTextVersion,
  restoreEntityVersion,
  currentRevision,
  unlockCanvasInput,
  listCanvasInputLocks,
} from '../services/provenance'
import type { ContentVersion } from '../db/schema'
import { HttpError, h, idParam } from './helpers'
import { toAssetView } from './assets'

/**
 * 版本与追溯路由：对象版本列表 / 版本内容 / 还原 / 下游影响。
 * 只读 + 显式还原；不提供任何自动生成/返修入口（影响仅报告）。
 */
export const versionsRoutes = new Hono()

interface ContentVersionView {
  id: number
  objKind: string
  objId: number
  revision: number
  payloadKind: string
  sha256: string | null
  label: string | null
  source: string
  isCurrent: boolean
  createdAt: number
}

function toVersionView(v: ContentVersion): ContentVersionView {
  return {
    id: v.id,
    objKind: v.objKind,
    objId: v.objId,
    revision: v.revision,
    payloadKind: v.payloadKind,
    sha256: v.sha256,
    label: v.label,
    source: v.source,
    isCurrent: false,
    createdAt: v.createdAt,
  }
}

async function mapProvenance<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ProvenanceError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400
      throw new HttpError(status, err.code, err.message)
    }
    throw err
  }
}

// GET /assets/:id/versions —— 文本资产版本列表（含当前版本号）
versionsRoutes.get('/assets/:id/versions', h(async (c) => {
  const id = idParam(c)
  const rows = await listVersions('asset', id)
  const rev = await currentRevision('asset', id)
  return c.json({ items: rows.map((v) => ({ ...toVersionView(v), isCurrent: v.revision === rev })), currentRevision: rev })
}))

// GET /assets/:id/versions/:versionId —— 版本内容（文本）
versionsRoutes.get('/assets/:id/versions/:versionId/content', h(async (c) => {
  const id = idParam(c)
  const versionId = Number(c.req.param('versionId'))
  if (!Number.isInteger(versionId) || versionId <= 0) throw new HttpError(400, 'bad_id', 'versionId 非法')
  return mapProvenance(async () => {
    await assertVersionOwned(versionId, 'asset', id)
    const content = await readVersionContent(versionId)
    if (content.kind !== 'text') throw new HttpError(400, 'bad_version', '该版本非文本内容')
    return c.json({ content: content.text })
  })
}))

// POST /assets/:id/versions/:versionId/restore —— 还原文本资产到历史版本（生成新版本，保留历史，不动下游）
versionsRoutes.post('/assets/:id/versions/:versionId/restore', h(async (c) => {
  const id = idParam(c)
  const versionId = Number(c.req.param('versionId'))
  if (!Number.isInteger(versionId) || versionId <= 0) throw new HttpError(400, 'bad_id', 'versionId 非法')
  return mapProvenance(async () => {
    await assertVersionOwned(versionId, 'asset', id)
    const asset = await restoreAssetTextVersion(id, versionId)
    const revision = await currentRevision('asset', id)
    return c.json({ asset: toAssetView(asset), revision })
  })
}))

// GET /assets/:id/impact —— 文本资产下游影响（消费它的执行清单）
versionsRoutes.get('/assets/:id/impact', h(async (c) => {
  const id = idParam(c)
  const rows = await downstreamImpact({ objKind: 'asset', objId: id })
  return c.json({ items: rows, total: rows.length })
}))

// GET /entities/:id/versions —— 实体档案版本列表
versionsRoutes.get('/entities/:id/versions', h(async (c) => {
  const id = idParam(c)
  const rows = await listVersions('entity', id)
  const rev = await currentRevision('entity', id)
  return c.json({ items: rows.map((v) => ({ ...toVersionView(v), isCurrent: v.revision === rev })), currentRevision: rev })
}))

// GET /entities/:id/versions/:versionId/content —— 实体版本快照（字段 JSON）
versionsRoutes.get('/entities/:id/versions/:versionId/content', h(async (c) => {
  const id = idParam(c)
  const versionId = Number(c.req.param('versionId'))
  if (!Number.isInteger(versionId) || versionId <= 0) throw new HttpError(400, 'bad_id', 'versionId 非法')
  return mapProvenance(async () => {
    await assertVersionOwned(versionId, 'entity', id)
    const content = await readVersionContent(versionId)
    if (content.kind !== 'json') throw new HttpError(400, 'bad_version', '该版本非实体快照')
    return c.json({ doc: content.doc })
  })
}))

// POST /entities/:id/versions/:versionId/restore —— 还原实体档案到历史版本
versionsRoutes.post('/entities/:id/versions/:versionId/restore', h(async (c) => {
  const id = idParam(c)
  const versionId = Number(c.req.param('versionId'))
  if (!Number.isInteger(versionId) || versionId <= 0) throw new HttpError(400, 'bad_id', 'versionId 非法')
  return mapProvenance(async () => {
    await assertVersionOwned(versionId, 'entity', id)
    await restoreEntityVersion(id, versionId)
    const revision = await currentRevision('entity', id)
    return c.json({ ok: true, revision })
  })
}))

// GET /entities/:id/impact —— 实体下游影响
versionsRoutes.get('/entities/:id/impact', h(async (c) => {
  const id = idParam(c)
  const rows = await downstreamImpact({ objKind: 'entity', objId: id })
  return c.json({ items: rows, total: rows.length })
}))

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_json', '请求体需为 JSON 对象')
  return body as Record<string, unknown>
}

// ---------- 锁定下次执行输入（画布 gen 节点 spec.pin；三操作分离之锁版，不改选片/内容/不触发生成） ----------

// GET /canvas/nodes/:id/input-locks —— 当前锁定清单
versionsRoutes.get('/canvas/nodes/:id/input-locks', h(async (c) => {
  const id = idParam(c)
  return mapProvenance(async () => c.json({ items: await listCanvasInputLocks(id) }))
}))

// POST /canvas/nodes/:id/input-lock —— 锁定/更新 { upstreamNodeId, assetId }
versionsRoutes.post('/canvas/nodes/:id/input-lock', h(async (c) => {
  const id = idParam(c)
  const body = await readJson(c)
  return mapProvenance(async () => {
    const items = await lockCanvasInput(id, Number(body['upstreamNodeId']), Number(body['assetId']))
    return c.json({ items })
  })
}))

// DELETE /canvas/nodes/:id/input-lock —— 解除锁定 { upstreamNodeId }（回落最新/采纳）
versionsRoutes.delete('/canvas/nodes/:id/input-lock', h(async (c) => {
  const id = idParam(c)
  const body = await readJson(c)
  return mapProvenance(async () => {
    const items = await unlockCanvasInput(id, Number(body['upstreamNodeId']))
    return c.json({ items })
  })
}))
