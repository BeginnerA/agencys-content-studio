/**
 * [M19] 平台品牌资产服务（BRAND_DIR 文件 + settings.brand[slot].file 引用）。
 * - 上传：kindByExt 校验（watermark 须 image / intro|outro 须 video）→ 落 BRAND_DIR/{slot}-{ts}-{sanitize}
 *   → settings.brand[slot].file 更新（同槽旧文件保留磁盘——与 DELETE「不物理删」语义一致）
 * - 预览：settings 引用 → BRAND_DIR 存在性（无引用/文件缺失 → null，路由层 404）
 * - 清除：仅删 file 键（保留槽内其他参数；磁盘文件保留）
 * - 槽参数（position/opacity/intro.enabled 等）走既有 PUT /settings/:key（brand 整体写）；
 *   本服务只管「文件键」通道（multipart 上传/流式预览/引用清除）。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { settings } from '../db/schema'
import { BRAND_DIR } from '../env'
import { readPlatformBrand, type BrandConfig } from './brand-config'
import { WorkbenchError } from './shot'
import { kindByExt, mimeOfExt, sanitizeName } from './storage'

/** 品牌素材槽（水印/片头/片尾） */
export const BRAND_SLOTS = ['watermark', 'intro', 'outro'] as const
export type BrandSlot = (typeof BRAND_SLOTS)[number]

export function isBrandSlot(v: string): v is BrandSlot {
  return (BRAND_SLOTS as readonly string[]).includes(v)
}

/** 槽位素材类型：水印 = 图片；片头/片尾 = 视频 */
export function slotKindOf(slot: BrandSlot): 'image' | 'video' {
  return slot === 'watermark' ? 'image' : 'video'
}

/** settings.brand 整体回写（KV upsert；镜像 system.ts PUT /settings/:key 语义） */
async function writePlatformBrand(brand: BrandConfig): Promise<void> {
  const t = Date.now()
  const value = JSON.stringify(brand)
  const existing = await db.select({ id: settings.id }).from(settings).where(eq(settings.key, 'brand')).limit(1)
  if (existing[0]) await db.update(settings).set({ value, updatedAt: t }).where(eq(settings.key, 'brand'))
  else await db.insert(settings).values({ key: 'brand', value, updatedAt: t })
}

/**
 * 上传品牌资产：kind 校验 → 落 BRAND_DIR/{slot}-{ts}-{sanitizeName} → settings.brand[slot].file 更新。
 * 返回更新后的品牌全量（响应 { brand }）；kind 不符 → WorkbenchError('bad_kind')。
 */
export async function uploadBrandAsset(
  slot: BrandSlot,
  file: { name: string; data: Uint8Array },
): Promise<BrandConfig> {
  const ext = extname(file.name)
  const want = slotKindOf(slot)
  if (kindByExt(ext) !== want) {
    throw new WorkbenchError(
      'bad_kind',
      `文件类型不符（${slot} 需${want === 'image' ? '图片' : '视频'}，得到${ext ? ` ${ext}` : '未知类型'}）`,
    )
  }
  const fileName = `${slot}-${Date.now()}-${sanitizeName(file.name || `${slot}${ext || '.bin'}`)}`
  writeFileSync(join(BRAND_DIR, fileName), file.data)
  const brand = (await readPlatformBrand()) as Record<string, unknown>
  const cur = brand[slot]
  brand[slot] = cur && typeof cur === 'object' && !Array.isArray(cur)
    ? { ...(cur as Record<string, unknown>), file: fileName }
    : { file: fileName }
  await writePlatformBrand(brand as BrandConfig)
  return brand as BrandConfig
}

/** 预览信息：settings 引用 + BRAND_DIR 存在性（无引用/文件缺失 → null） */
export async function getBrandAssetInfo(
  slot: BrandSlot,
): Promise<{ path: string; fileName: string; mime: string } | null> {
  const brand = await readPlatformBrand()
  const f = brand[slot]?.file
  if (typeof f !== 'string' || !f.trim()) return null
  const fileName = f.trim()
  const path = join(BRAND_DIR, fileName)
  if (!existsSync(path)) return null
  return { path, fileName, mime: mimeOfExt(extname(fileName)) }
}

/** 清除品牌资产引用（仅删 file 键；槽内其他参数与磁盘文件保留） */
export async function clearBrandAsset(slot: BrandSlot): Promise<BrandConfig> {
  const brand = (await readPlatformBrand()) as Record<string, unknown>
  const cur = brand[slot]
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    delete (cur as Record<string, unknown>)['file']
  }
  await writePlatformBrand(brand as BrandConfig)
  return brand as BrandConfig
}
