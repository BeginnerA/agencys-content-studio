import { Hono } from 'hono'
import { statSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Readable } from 'node:stream'
import { db } from '../db'
import { assets } from '../db/schema'
import { absPathOf, importFiles, mimeOfExt } from '../services/storage'
import { HttpError, h, idParam, notFound } from './helpers'

export const assetsRoutes = new Hono()

// GET /projects/:id/assets —— 项目资产列表（?kind=&purpose=&tag=）
assetsRoutes.get('/projects/:id/assets', h(async (c) => {
  const projectId = idParam(c)
  const kind = c.req.query('kind')
  const purpose = c.req.query('purpose')
  const tag = c.req.query('tag')
  const conds = [eq(assets.projectId, projectId), isNull(assets.deletedAt)]
  if (kind) conds.push(eq(assets.kind, kind))
  if (purpose) conds.push(eq(assets.purpose, purpose))
  let rows = await db.select().from(assets).where(and(...conds)).orderBy(desc(assets.updatedAt))
  if (tag) {
    rows = rows.filter((a) => {
      try { return (JSON.parse(a.tags) as string[]).includes(tag) } catch { return false }
    })
  }
  return c.json({ items: rows.map(toAssetView) })
}))

// POST /projects/:id/imports —— 批量上传素材（multipart；sha256 去重）
assetsRoutes.post('/projects/:id/imports', h(async (c) => {
  const projectId = idParam(c)
  const form = await c.req.formData().catch(() => { throw new HttpError(400, 'bad_form', '非 multipart/form-data 请求') })
  const purpose = typeof form.get('purpose') === 'string' ? String(form.get('purpose')) : 'source'
  if (!/^[\w-]+$/.test(purpose)) throw new HttpError(400, 'bad_purpose', `purpose 非法: ${purpose}`)
  const files: Array<{ name: string; data: Uint8Array }> = []
  let total = 0
  for (const [field, value] of form.entries()) {
    if (field === 'purpose') continue
    if (typeof value === 'string') continue
    const file = value as File
    total += file.size
    if (total > 512 * 1024 * 1024) throw new HttpError(413, 'too_large', '单次上传超过 512MB 上限')
    const buf = new Uint8Array(await file.arrayBuffer())
    if (buf.byteLength === 0) continue
    files.push({ name: file.name || `upload-${Date.now()}`, data: buf })
  }
  if (files.length === 0) throw new HttpError(400, 'no_files', '未收到文件')
  const created = await importFiles(projectId, files, { purpose })
  return c.json({ items: created.map(toAssetView), duplicated: created.length < files.length }, 201)
}))

// GET /assets/:id —— 资产详情
assetsRoutes.get('/assets/:id', h(async (c) => {
  const a = await findAsset(idParam(c))
  if (!a) return notFound(c, `资产 ${c.req.param('id')}`)
  return c.json({ asset: toAssetView(a) })
}))

// GET /assets/:id/file —— 文件流（支持 Range，?download=1 触发附件）
assetsRoutes.get('/assets/:id/file', h(async (c) => {
  const a = await findAsset(idParam(c))
  if (!a) return notFound(c, `资产 ${c.req.param('id')}`)
  if (!a.relPath) throw new HttpError(404, 'no_file', '该资产无本地文件')
  const abs = absPathOf(a.relPath)
  let size: number
  try { size = statSync(abs).size } catch { throw new HttpError(404, 'no_file', `文件缺失: ${a.relPath}`) }

  const mime = a.mime ?? mimeOfExt(`.${a.ext ?? ''}`)
  const download = c.req.query('download') === '1'
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  }
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`

  const range = c.req.header('range')
  let start = 0
  let end = size - 1
  let status = 200
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!m) throw new HttpError(416, 'bad_range', `不支持的 Range: ${range}`)
    if (m[1]) start = Number(m[1])
    if (m[2]) end = Math.min(Number(m[2]), size - 1)
    if (start > end || start >= size) throw new HttpError(416, 'bad_range', `Range 越界: ${range}`)
    status = 206
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  headers['Content-Length'] = String(end - start + 1)
  const stream = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream
  return new Response(stream, { status, headers })
}))

// GET /assets/:id/thumb —— 缩略图（M1 图片资产直接回原图，后续 sharp 生成）
assetsRoutes.get('/assets/:id/thumb', h(async (c) => {
  const a = await findAsset(idParam(c))
  if (!a) return notFound(c, `资产 ${c.req.param('id')}`)
  if (a.kind !== 'image' || !a.relPath) throw new HttpError(404, 'no_thumb', '非图片资产暂无缩略图')
  const abs = absPathOf(a.relPath)
  if (!exists(abs)) throw new HttpError(404, 'no_file', `文件缺失: ${a.relPath}`)
  return new Response(Readable.toWeb(createReadStream(abs)), {
    headers: { 'Content-Type': a.mime ?? 'image/png', 'Cache-Control': 'private, max-age=86400' },
  })
}))

// PATCH /assets/:id —— name / is_favorite / tags
assetsRoutes.patch('/assets/:id', h(async (c) => {
  const a = await findAsset(idParam(c))
  if (!a) return notFound(c, `资产 ${c.req.param('id')}`)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (body['name'] !== undefined) {
    if (typeof body['name'] !== 'string' || !body['name'].trim()) throw new HttpError(400, 'bad_name', 'name 非法')
    patch['name'] = body['name'].trim()
  }
  if (body['is_favorite'] !== undefined) patch['isFavorite'] = body['is_favorite'] ? 1 : 0
  if (body['tags'] !== undefined) {
    if (!Array.isArray(body['tags'])) throw new HttpError(400, 'bad_tags', 'tags 需为字符串数组')
    patch['tags'] = JSON.stringify(body['tags'])
  }
  const rows = await db.update(assets).set(patch).where(eq(assets.id, a.id)).returning()
  return c.json({ asset: toAssetView(rows[0]!) })
}))

// DELETE /assets/:id —— 逻辑删除（物理文件留待 GC）
assetsRoutes.delete('/assets/:id', h(async (c) => {
  const a = await findAsset(idParam(c))
  if (!a) return notFound(c, `资产 ${c.req.param('id')}`)
  await db.update(assets).set({ deletedAt: Date.now(), updatedAt: Date.now() }).where(eq(assets.id, a.id))
  return c.json({ ok: true })
}))

async function findAsset(id: number) {
  const rows = await db.select().from(assets).where(and(eq(assets.id, id), isNull(assets.deletedAt))).limit(1)
  return rows[0] ?? null
}

function exists(p: string): boolean {
  try { statSync(p); return true } catch { return false }
}

function toAssetView(a: typeof assets.$inferSelect): Record<string, unknown> {
  let params: unknown = null
  if (a.params) { try { params = JSON.parse(a.params) } catch { params = null } }
  let tags: unknown = []
  if (a.tags) { try { tags = JSON.parse(a.tags) } catch { tags = [] } }
  return {
    id: a.id,
    projectId: a.projectId,
    stepId: a.stepId,
    taskId: a.taskId,
    kind: a.kind,
    purpose: a.purpose,
    name: a.name,
    mime: a.mime,
    ext: a.ext,
    fileSize: a.fileSize,
    width: a.width,
    height: a.height,
    duration: a.duration,
    prompt: a.prompt,
    params,
    tags,
    isFavorite: a.isFavorite,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    urls: {
      file: `/api/v1/assets/${a.id}/file`,
      thumb: a.kind === 'image' ? `/api/v1/assets/${a.id}/thumb` : null,
    },
  }
}