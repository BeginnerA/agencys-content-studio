import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { count, eq } from 'drizzle-orm'
import { db } from '../db'
import { genTasks, settings } from '../db/schema'
import { WORKSPACE_DIR } from '../env'
import { refreshGlobalConcurrency } from '../pipeline/engine'
import { resolveFfmpeg } from '../services/ffmpeg'
import { clearBrandAsset, getBrandAssetInfo, isBrandSlot, uploadBrandAsset, type BrandSlot } from '../services/brand-assets'
import { createLogger } from '../logger'
import { HttpError, h, wb } from './helpers'

const log = createLogger('route:system')

export const systemRoutes = new Hono()

/** GET /api/v1/health —— 进程存活 + 依赖探测 */
systemRoutes.get('/health', async (c) => {
  const ffmpeg = resolveFfmpeg()
  const ffmpegState = ffmpeg ? 'ok' : 'missing'
  return c.json({
    ok: true,
    db: 'ok',
    ffmpeg: ffmpegState,
    ffmpegPath: ffmpeg,
    workspace: WORKSPACE_DIR,
    ts: Date.now(),
  })
})

/** GET /api/v1/system/status —— 运行态（任务统计/队列深度） */
systemRoutes.get('/system/status', async (c) => {
  try {
    const byStatus = await db
      .select({ status: genTasks.status, n: count() })
      .from(genTasks)
      .groupBy(genTasks.status)
    const tasks = Object.fromEntries(byStatus.map((r) => [r.status, r.n]))
    return c.json({ ok: true, tasks, ts: Date.now() })
  } catch (err) {
    log.error('status query failed', err)
    return c.json({ ok: false, tasks: {}, error: (err as Error).message }, 500)
  }
})

// GET /settings —— 全部 KV（value 为解析后的 JSON）
systemRoutes.get('/settings', h(async (c) => {
  const rows = await db.select().from(settings)
  return c.json({
    items: rows.map((r) => ({ key: r.key, value: safeParseJson(r.value), updatedAt: r.updatedAt })),
  })
}))

// PUT /settings/:key —— upsert（body 即 value JSON；64KB 字节上限）
systemRoutes.put('/settings/:key', h(async (c) => {
  const key = c.req.param('key') ?? ''
  if (!/^[\w.-]+$/.test(key)) {
    throw new HttpError(400, 'bad_key', 'key 仅允许字母/数字/下划线/点/中划线')
  }
  const text = await c.req.text()
  if (Buffer.byteLength(text, 'utf8') > 65536) throw new HttpError(400, 'too_large', 'value 超 64KB 上限')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'bad_json', 'value 需为合法 JSON')
  }
  const t = Date.now()
  const existing = await db.select({ id: settings.id }).from(settings).where(eq(settings.key, key)).limit(1)
  if (existing[0]) {
    await db.update(settings).set({ value: JSON.stringify(value), updatedAt: t }).where(eq(settings.key, key))
  } else {
    await db.insert(settings).values({ key, value: JSON.stringify(value), updatedAt: t })
  }
  // [M21 C6] concurrency 配置即改即生效：刷新引擎内存缓存（否则运行中进程持续读旧上限，重启才变）
  if (key === 'concurrency') await refreshGlobalConcurrency()
  return c.json({ ok: true, key, updatedAt: t })
}))

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// ---------- [M19] 平台品牌资产（BRAND_DIR；水印/片头/片尾，非项目资产） ----------

/** slot 路径参数校验（watermark|intro|outro） */
function brandSlotParam(c: { req: { param: (name: string) => string | undefined } }): BrandSlot {
  const slot = c.req.param('slot') ?? ''
  if (!isBrandSlot(slot)) throw new HttpError(400, 'bad_slot', 'slot 需为 watermark|intro|outro')
  return slot
}

// POST /settings/brand/assets/:slot —— multipart 上传（watermark 须图片 / intro|outro 须视频；≤200MB）
// 落 BRAND_DIR/{slot}-{ts}-{sanitizeName} → settings.brand[slot].file 更新；响应 { brand }
systemRoutes.post('/settings/brand/assets/:slot', h(async (c) => {
  const slot = brandSlotParam(c)
  const ct = c.req.header('content-type') ?? ''
  if (!ct.includes('multipart/form-data')) throw new HttpError(400, 'bad_form', '需 multipart/form-data 上传（字段名 file）')
  const form = await c.req.formData().catch(() => {
    throw new HttpError(400, 'bad_form', '非 multipart/form-data 请求')
  })
  const fileRaw = form.get('file')
  if (!fileRaw || typeof fileRaw === 'string') throw new HttpError(400, 'no_file', '未收到文件（字段名 file）')
  const file = fileRaw as File
  if (file.size > 200 * 1024 * 1024) throw new HttpError(413, 'too_large', '单文件超过 200MB 上限')
  const buf = new Uint8Array(await file.arrayBuffer())
  if (buf.byteLength === 0) throw new HttpError(400, 'no_file', '文件内容为空')
  const brand = await wb(() => uploadBrandAsset(slot, { name: file.name || `${slot}-${Date.now()}`, data: buf }))
  return c.json({ ok: true, brand, note: '品牌素材已更新（重新合成后生效）' }, 201)
}))

// GET /settings/brand/assets/:slot —— 预览（流式回传当前文件；无引用/文件缺失 → 404）
systemRoutes.get('/settings/brand/assets/:slot', h(async (c) => {
  const slot = brandSlotParam(c)
  const info = await getBrandAssetInfo(slot)
  if (!info) throw new HttpError(404, 'not_found', `品牌素材 ${slot} 未上传`)
  const stream = Readable.toWeb(createReadStream(info.path)) as ReadableStream
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': info.mime, 'Cache-Control': 'no-cache' },
  })
}))

// DELETE /settings/brand/assets/:slot —— 清除引用（仅删 file 键；磁盘文件保留）
systemRoutes.delete('/settings/brand/assets/:slot', h(async (c) => {
  const slot = brandSlotParam(c)
  const brand = await wb(() => clearBrandAsset(slot))
  return c.json({ ok: true, brand, note: '品牌素材已清除（重新合成后生效；磁盘文件保留）' })
}))
