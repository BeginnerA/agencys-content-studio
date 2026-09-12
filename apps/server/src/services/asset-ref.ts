import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { assets } from '../db/schema'
import { absPathOf, mimeOfExt } from './storage'

/** 单张参考图内联上限（超限跳过该图并记日志，不使任务失败） */
export const MAX_REF_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * 资产图片 → base64 data URI（供参考图 / 首帧注入，本地单机无公网图床故内联）。
 *
 * 调用方契约：**明确提供了图但本函数抛错 → 调用方跳过该图 + 记日志，不使任务失败**。
 * 缓存：同 run 内同图多镜复用（Map 由调用方持有，step 级）。
 */
export async function assetToDataUri(assetId: number, cache?: Map<number, string>): Promise<string> {
  const cached = cache?.get(assetId)
  if (cached !== undefined) return cached

  const row = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  const asset = row[0]
  if (!asset) throw new Error(`资产 ${assetId} 不存在`)
  if (asset.kind !== 'image') throw new Error(`资产 ${assetId} 非图片（kind=${asset.kind}）`)
  if (!asset.relPath) throw new Error(`资产 ${assetId} 无本地文件`)

  const data = readFileSync(absPathOf(asset.relPath))
  if (data.byteLength > MAX_REF_IMAGE_BYTES) {
    const mb = (data.byteLength / (1024 * 1024)).toFixed(1)
    throw new Error(`资产 ${assetId} 图片 ${mb}MB 超上限 8MB`)
  }

  // mime 链：资产行 mime（须 image/ 前缀）→ 扩展名推断（须 image/ 前缀）→ 兜底 image/png
  let mime = asset.mime && asset.mime.startsWith('image/') ? asset.mime : ''
  if (!mime) {
    const ext = '.' + (asset.ext || extname(asset.relPath).slice(1))
    const byExt = mimeOfExt(ext)
    mime = byExt.startsWith('image/') ? byExt : 'image/png'
  }
  const uri = `data:${mime};base64,${data.toString('base64')}`
  cache?.set(assetId, uri)
  return uri
}
