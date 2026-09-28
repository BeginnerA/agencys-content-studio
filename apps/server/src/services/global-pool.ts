import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets } from '../db/schema'
import { HttpError } from '../routes/helpers'

/**
 * [M52] 全局素材池（M52 spec §M52.1）：
 * 虚拟项目 #0 作为全局实体（characters.projectId=null）的参考图文件域——assets.project_id
 * NOT NULL 且 SQLite 改列需重建表，故用保留 id 0 做纯约定（零 DDL）。
 * 池资产 = 有意跨项目共享的参考图；文件落 PROJECTS_DIR/0/<subDir>/，缩略/文件流端点按 relPath 服务零改动可用。
 * 隔离语义：项目私有资产依旧项目内可见；池是唯一跨项目注入例外（收口在 asset-ref.assetToDataUri 归属判定）。
 */
export const GLOBAL_POOL_ID = 0

/** 池上传 purpose 白名单（参考图三类 + 通用 source；其余拒绝防池目录滥用） */
export const GLOBAL_POOL_PURPOSES = ['reference_character', 'reference_scene', 'reference_prop', 'source'] as const

/**
 * 参考图挂接归属守卫（五通道单一真源：POST/PUT entities、ref-images 上传、ref-assets 联动）：
 * 项目域 → 资产须全部属该项目（与 assertProjectAssets 同口径）；
 * 全局域（projectId=null）→ 资产须全部属全局素材池（M52 放开：此前一律 400 拒绝）。
 * 非法/越权 → HttpError 400 bad_ref_assets。
 */
export async function assertRefAssetsForScope(
  projectId: number | null,
  ids: unknown[],
  what = 'ref_asset_ids',
): Promise<number[]> {
  const nums = ids.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new HttpError(400, 'bad_ref_assets', `${what} 包含非法资产 id`)
  }
  const scopeId = projectId ?? GLOBAL_POOL_ID
  if (nums.length === 0) return []
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(inArray(assets.id, nums), eq(assets.projectId, scopeId), isNull(assets.deletedAt)))
  const found = new Set(rows.map((r) => r.id))
  const missing = nums.filter((n) => !found.has(n))
  if (missing.length > 0) {
    const msg =
      projectId === null
        ? `全局素材仅可挂全局素材池资产（项目资产不越界入全局）：${missing.join(', ')}`
        : `资产不存在或不属于本项目: ${missing.join(', ')}`
    throw new HttpError(400, 'bad_ref_assets', msg)
  }
  return nums
}
