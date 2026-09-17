import { Hono } from 'hono'
import { readFileSync, statSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm'
import { Readable } from 'node:stream'
import { db } from '../db'
import { assets } from '../db/schema'
import { absPathOf, importFiles, mimeOfExt, withUtf8Charset, writeTextAsset } from '../services/storage'
import { FetchGuardError, fetchSourceText } from '../services/fetch-source'
import { ContentEditError, updateAssetContent } from '../services/asset-content'
import { ensureThumb } from '../services/thumb'
import { checkAndRecordAsset, scheduleImageCheck } from '../services/image-check'
import { cleanupVersions, gcProject } from '../services/version-cleanup'
import { HttpError, h, idParam, notFound } from './helpers'

export const assetsRoutes = new Hono()

// GET /projects/:id/assets —— 项目资产列表（?kind=&purpose=&tag=&limit=&offset=；返回 {items,total}）
// limit 缺省时保持全量返回（兼容旧调用方）；显式传参时 clamp 1..500（默认 200）
assetsRoutes.get('/projects/:id/assets', h(async (c) => {
  const projectId = idParam(c)
  const kind = c.req.query('kind')
  const purpose = c.req.query('purpose')
  const tag = c.req.query('tag')
  const limitRaw = c.req.query('limit')
  const offsetRaw = c.req.query('offset')
  const hasLimit = limitRaw !== undefined
  const limitNum = Number(limitRaw)
  const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(Math.floor(limitNum), 500) : 200
  const offsetNum = Number(offsetRaw)
  const offset = Number.isFinite(offsetNum) && offsetNum > 0 ? Math.floor(offsetNum) : 0
  const conds = [eq(assets.projectId, projectId), isNull(assets.deletedAt)]
  if (kind) conds.push(eq(assets.kind, kind))
  if (purpose) conds.push(eq(assets.purpose, purpose))
  // [M21] tag 过滤下推 SQL（json_each 展开数组做 JSON 精确成员匹配——含引号/反斜杠/跨元素拼接串均无误配漏配；
  // json_valid 守卫防历史脏数据炸查询）——修复 limit/offset 后内存过滤的分页错位
  if (tag) {
    conds.push(sql`json_valid(${assets.tags}) AND EXISTS (SELECT 1 FROM json_each(${assets.tags}) WHERE json_each.value = ${tag})`)
  }
  const where = and(...conds)
  const total = Number((await db.select({ n: count() }).from(assets).where(where))[0]?.n ?? 0)
  let query = db.select().from(assets).where(where).orderBy(desc(assets.updatedAt)).$dynamic()
  if (hasLimit) query = query.limit(limit).offset(offset)
  const rows = await query
  return c.json({ items: rows.map(toAssetView), total })
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
  // [M12] 写时图像有效性检测（仅图片；fire-and-forget 不阻断）
  for (const a of created) scheduleImageCheck(a)
  return c.json({ items: created.map(toAssetView), duplicated: created.length < files.length }, 201)
}))

// POST /projects/:id/fetch-source —— [M25·G8] URL 抓正文→ source 资产（spec §2.8：SSRF 守卫 + 限额；400 守卫/过短，502 抓取失败）
assetsRoutes.post('/projects/:id/fetch-source', h(async (c) => {
  const projectId = idParam(c)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  if (typeof body['url'] !== 'string' || !body['url'].trim()) throw new HttpError(400, 'bad_url', 'url 需为非空字符串')
  let fetched: { text: string; title: string; finalUrl: string }
  try {
    fetched = await fetchSourceText(body['url'].trim())
  } catch (err) {
    if (err instanceof FetchGuardError) {
      // 错误面表口径：抓取失败/非 2xx → 502；守卫拒绝/内容过短 → 400
      const status = err.code === 'fetch_failed' || err.code === 'bad_status' ? 502 : 400
      throw new HttpError(status, err.code, err.message)
    }
    throw err
  }
  const host = (() => { try { return new URL(fetched.finalUrl).hostname } catch { return 'web' } })()
  const rawName = (fetched.title || host).slice(0, 60).replace(/[\\/:*?"<>|\r\n]/g, ' ').trim() || host
  const asset = await writeTextAsset(projectId, {
    name: `${rawName}.md`,
    content: fetched.text,
    purpose: 'source',
    params: { fetched: { url: fetched.finalUrl, chars: fetched.text.length, at: Date.now() } },
    tags: ['url_fetch'],
  })
  // 文件名经 sanitizeName 可能与展示 name 不同，视图对齐展示名
  return c.json({ asset: { ...toAssetView(asset), name: asset.name } }, 201)
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

  const mime = withUtf8Charset(a.mime ?? mimeOfExt(`.${a.ext ?? ''}`))
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

// GET /assets/:id/thumb —— 缩略图（图片/视频 ffmpeg 生成 480px WebP 磁盘缓存）
// 图片：生成失败回退原图；视频：生成失败 404（避免把整个视频流当作缩略图下发）
assetsRoutes.get('/assets/:id/thumb', h(async (c) => {
  const a = await findAsset(idParam(c))
  if (!a) return notFound(c, `资产 ${c.req.param('id')}`)
  const isVideo = a.kind === 'video'
  if ((!isVideo && a.kind !== 'image') || !a.relPath) throw new HttpError(404, 'no_thumb', '非图片/视频资产暂无缩略图')
  const thumb = await ensureThumb(a)
  if (thumb) {
    const buf = readFileSync(thumb)
    return new Response(buf, {
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': String(buf.byteLength),
        'Cache-Control': 'private, max-age=86400',
      },
    })
  }
  if (isVideo) throw new HttpError(404, 'no_thumb', '视频封面生成失败')
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

// PATCH /assets/:id/content —— [M25·G2] 文本资产内容覆写（spec §2.3：白名单 purpose + JSON 契约校验 + 原子覆盖）
assetsRoutes.patch('/assets/:id/content', h(async (c) => {
  const id = idParam(c)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  if (typeof body['content'] !== 'string') throw new HttpError(400, 'bad_content', 'content 需为字符串')
  try {
    const updated = await updateAssetContent(id, body['content'])
    return c.json({ asset: toAssetView(updated) })
  } catch (err) {
    if (err instanceof ContentEditError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'too_large' ? 413 : 400
      throw new HttpError(status, err.code, err.message)
    }
    throw err
  }
}))

// DELETE /assets/:id —— 逻辑删除（物理文件留待 GC）
assetsRoutes.delete('/assets/:id', h(async (c) => {
  const a = await findAsset(idParam(c))
  if (!a) return notFound(c, `资产 ${c.req.param('id')}`)
  await db.update(assets).set({ deletedAt: Date.now(), updatedAt: Date.now() }).where(eq(assets.id, a.id))
  return c.json({ ok: true })
}))

// POST /assets/:id/check —— [M12] 单资产图像有效性检测（同步；仅图片；结果写 params.quality）
assetsRoutes.post('/assets/:id/check', h(async (c) => {
  const a = await findAsset(idParam(c))
  if (!a) return notFound(c, `资产 ${c.req.param('id')}`)
  if (a.kind !== 'image') throw new HttpError(400, 'bad_kind', '仅图片资产支持检测')
  const updated = await checkAndRecordAsset(a.id)
  if (!updated) return notFound(c, `资产 ${c.req.param('id')}`)
  return c.json({ asset: toAssetView(updated) })
}))

// POST /projects/:id/assets/cleanup-versions —— [M12] 项目级版本组批量清理（保留最新/收藏/在用；软删可回溯）
assetsRoutes.post('/projects/:id/assets/cleanup-versions', h(async (c) => {
  const projectId = idParam(c)
  const result = await cleanupVersions({ projectId })
  return c.json({
    ok: true,
    groups: result.groups,
    cleaned: result.cleaned,
    kept: result.kept,
    note: `已清理 ${result.cleaned} 个历史版本，保留 ${result.kept} 个（最新 / 收藏 / 在用）`,
  })
}))

// POST /projects/:id/assets/gc —— [M12] 回收空间（删除已清理资产的物理文件；不可逆；行保留）
assetsRoutes.post('/projects/:id/assets/gc', h(async (c) => {
  const projectId = idParam(c)
  const result = await gcProject(projectId)
  return c.json({
    ok: true,
    files: result.files,
    freed_bytes: result.freedBytes,
    note: `已回收 ${result.files} 个文件，释放 ${result.freedBytes} 字节`,
  })
}))

async function findAsset(id: number) {
  const rows = await db.select().from(assets).where(and(eq(assets.id, id), isNull(assets.deletedAt))).limit(1)
  return rows[0] ?? null
}

function exists(p: string): boolean {
  try { statSync(p); return true } catch { return false }
}

export function toAssetView(a: typeof assets.$inferSelect): Record<string, unknown> {
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
      // v=2：早期缩略图端点直接回原图（客户端可能缓存 24h），版本参数强制失效旧缓存
      thumb: a.kind === 'image' || a.kind === 'video' ? `/api/v1/assets/${a.id}/thumb?v=2` : null,
    },
  }
}