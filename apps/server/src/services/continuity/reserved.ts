import { isNull, notInArray, sql, type SQL } from 'drizzle-orm'
import { assets } from '../../db/schema'

export const RESERVED_PURPOSES = ['continuity_entry', 'continuity_context', 'continuity_use'] as const

export function isContinuityPurpose(purpose: string | null): boolean {
  return purpose !== null && RESERVED_PURPOSES.some(p => p === purpose)
}

/**
 * 普通素材面排除保留 purpose 的 SQL 条件（NULL 安全，可直接并入 and 条件组）。
 * 裸 `purpose NOT IN (...)` 对 purpose 为 NULL 的行按 SQL 三值逻辑判为 UNKNOWN，会把「未标注用途」的资产整体隐藏——
 * 列表因此返回空、分页与总数一起失真。未标注不属于保留清单，故显式放行 NULL。
 */
export function excludeReservedPurpose(): SQL {
  return sql`(${isNull(assets.purpose)} OR ${notInArray(assets.purpose, [...RESERVED_PURPOSES])})`
}
