import { Hono } from 'hono'
import { extname } from 'node:path'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets } from '../db/schema'
import { kindByExt, importFiles } from '../services/storage'
import { scheduleImageCheck } from '../services/image-check'
import { GLOBAL_POOL_ID, GLOBAL_POOL_PURPOSES } from '../services/global-pool'
import { toAssetView } from './assets'
import { HttpError, h } from './helpers'

/**
 * 全局素材池端点：/global/assets。
 * 池 = 虚拟项目 #0（GLOBAL_POOL_ID），承载全局实体（projectId=null）的参考图；
 * 列表/上传均强制 project_id=0，不接受任意归属参数。文件流/缩略复用 /assets/:id/*（按 relPath 服务）。
 */
export const globalPoolRoutes = new Hono()

/** 池上传单文件上限（对齐实体参考图上传 10MB） */
const MAX_POOL_UPLOAD_BYTES = 10 * 1024 * 1024

// GET /global/assets —— 池资产列表（?kind=&purpose=；返回 {items,total}）
globalPoolRoutes.get(
  '/global/assets',
  h(async (c) => {
    const kind = c.req.query('kind')
    const purpose = c.req.query('purpose')
    const conds = [eq(assets.projectId, GLOBAL_POOL_ID), isNull(assets.deletedAt)]
    if (kind) conds.push(eq(assets.kind, kind))
    if (purpose) conds.push(eq(assets.purpose, purpose))
    const rows = await db.select().from(assets).where(and(...conds)).orderBy(desc(assets.updatedAt))
    return c.json({ items: rows.map(toAssetView), total: rows.length })
  }),
)

// POST /global/assets —— 批量上传入池（multipart，字段 file 可多张；仅图片；sha256 去重）
globalPoolRoutes.post(
  '/global/assets',
  h(async (c) => {
    const form = await c.req.formData().catch(() => {
      throw new HttpError(400, 'bad_form', '非 multipart/form-data 请求')
    })
    const purpose = typeof form.get('purpose') === 'string' ? String(form.get('purpose')) : 'source'
    if (!(GLOBAL_POOL_PURPOSES as readonly string[]).includes(purpose)) {
      throw new HttpError(400, 'bad_purpose', `purpose 非法: ${purpose}（可选 ${GLOBAL_POOL_PURPOSES.join('、')}）`)
    }
    const files: Array<{ name: string; data: Uint8Array }> = []
    for (const entry of form.getAll('file')) {
      if (typeof entry === 'string' || !(entry instanceof File)) continue
      if (kindByExt(extname(entry.name)) !== 'image') throw new HttpError(400, 'not_image', '全局素材池仅支持图片文件（png/jpg/jpeg/webp/gif/bmp）')
      if (entry.size > MAX_POOL_UPLOAD_BYTES) throw new HttpError(413, 'too_large', `「${entry.name}」超过 10MB 单文件上限`)
      const buf = new Uint8Array(await entry.arrayBuffer())
      if (buf.byteLength === 0) continue
      files.push({ name: entry.name || `pool-${Date.now()}`, data: buf })
    }
    if (files.length === 0) throw new HttpError(400, 'no_files', '未收到文件（字段名 file）')
    const created = await importFiles(GLOBAL_POOL_ID, files, { purpose })
    for (const a of created) scheduleImageCheck(a)
    return c.json({ items: created.map(toAssetView), duplicated: created.length < files.length }, 201)
  }),
)
