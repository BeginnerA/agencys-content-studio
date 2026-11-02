/**
 * M70 连续性生命周期守卫（Task 10 · 设计 §12 删除、清理与完整性）。
 *
 * 三个守卫共用一条纪律：调用方必须把「当前执行器」显式传进来——认领、回写、删库
 * 都在同一个写事务里复查，避免 check-then-act 之间被并发操作穿透。
 *
 * - assertContinuityProjectWritable：项目不存在 / 已软删 / 已归档 → 404 continuity_source_invalid。
 *   归档是 DELETE /projects/:id 的产品软删路径（status='archived'），与 deletedAt 一样拒绝新写；
 *   轻松创作的影子项目 status='draft' 照常放行。读路径（resolveUnit/list/get/readContext/preview）
 *   保持可解释，不受本守卫影响。
 * - assertContinuityPurgeAllowed：仍有 extracting / dispatching 活动台账 → 409 continuity_in_flight。
 *   项目彻底删除与影子项目清理共用，事务内外各查一次（事务内查询才是最终仲裁）。
 * - assertUnitsUnreferenced：要移除的单元只要仍有任一 continuity 登记（任意 rowType / status，
 *   含 draft / failed / superseded 与 prepared / completed 承接）→ 409 continuity_entry_referenced。
 *   草稿没有删除入口，即便 latestRunId / contentAssetId 已清也不能把台账归属删成悬空。
 *
 * 保留 purpose 名单的唯一真源是 reserved.ts（Task1），本文件只做再导出，不维护第二份名单。
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { contentContinuityRecords as records, projects } from '../../db/schema'
import { ContinuityError, type Executor } from './contract'
import { RESERVED_PURPOSES, isContinuityPurpose } from './reserved'

export { isContinuityPurpose, RESERVED_PURPOSES }

/** 活动写入状态：正在提取 / 正在派发。项目清理与影子清理一律拒绝，等操作落定。 */
export const CONTINUITY_ACTIVE_STATUSES = ['extracting', 'dispatching'] as const

/** 项目可写性（存在、未软删且未归档）。认领/回写事务的第一道守卫。 */
export async function assertContinuityProjectWritable(ex: Executor, projectId: number): Promise<void> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new ContinuityError('continuity_source_invalid', 400)
  const [row] = await ex.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt), ne(projects.status, 'archived'))).limit(1)
  if (!row) throw new ContinuityError('continuity_source_invalid', 404)
}

/** 项目彻底删除 / 影子项目清理放行检查：任何在途台账都会让删除半途而废，直接拒绝。 */
export async function assertContinuityPurgeAllowed(ex: Executor, projectId: number): Promise<void> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new ContinuityError('continuity_source_invalid', 400)
  const [active] = await ex.select({ id: records.id }).from(records)
    .where(and(eq(records.projectId, projectId), inArray(records.status, [...CONTINUITY_ACTIVE_STATUSES]))).limit(1)
  if (active) throw new ContinuityError('continuity_in_flight', 409)
}

/** 剧集缩容 / 删剧 / 删集前置检查：目标单元仍有任一连续性登记时拒绝，避免悬空归属。
 * 判据按设计 §12 字面「仍有 continuity 登记或被引用」——不区分 rowType / status（draft 亦拦）。 */
export async function assertUnitsUnreferenced(ex: Executor, projectId: number, episodeIds: number[]): Promise<void> {
  const ids = [...new Set(episodeIds.filter(id => Number.isSafeInteger(id) && id > 0))]
  if (ids.length === 0) return
  const [blocking] = await ex.select({ id: records.id }).from(records).where(and(
    eq(records.projectId, projectId),
    inArray(records.unitId, ids),
  )).limit(1)
  if (blocking) throw new ContinuityError('continuity_entry_referenced', 409)
}
