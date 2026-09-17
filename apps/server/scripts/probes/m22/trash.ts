/** M22[P0] trash：策略解析 + 过期边界（断言体逐字搬自原 probe-m22.ts） */
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, TRASH_DEFAULTS, parseTrashPolicy, resolveTrashPolicy, selectExpiredCanvases } = ctx
  check(TRASH_DEFAULTS.retentionDays === 30 && TRASH_DEFAULTS.autoPurge === true, '内置缺省 = 30 天 + 自动开启')
  check(parseTrashPolicy(undefined).retentionDays === 30, '非对象输入 → 默认 30')
  check(parseTrashPolicy('broken').autoPurge === true, '坏 JSON 形态 → autoPurge 默认 true')
  check(parseTrashPolicy({ retentionDays: 0 }).retentionDays === 1, 'retentionDays=0 → clamp 到 1')
  check(parseTrashPolicy({ retentionDays: 999 }).retentionDays === 365, 'retentionDays=999 → clamp 到 365')
  check(parseTrashPolicy({ retentionDays: Number.NaN }).retentionDays === 30, 'NaN → 默认 30')
  check(parseTrashPolicy({ retentionDays: 'x' }).retentionDays === 30, '非法类型 → 默认 30')
  check(parseTrashPolicy({ autoPurge: false }).autoPurge === false, 'autoPurge=false 尊重')
  check((await resolveTrashPolicy()).retentionDays === 30, 'resolveTrashPolicy 空表缺省 = 30（settings 表就绪）')

  const DAY = 86_400_000
  const now = 1_800_000_000_000
  const rows = [
    { id: 1, deletedAt: null }, // 正常画布
    { id: 2, deletedAt: now - 31 * DAY }, // 过期（30 天）
    { id: 3, deletedAt: now - 30 * DAY }, // 恰 30 天 → 未过期（严格小于）
    { id: 4, deletedAt: now - 1000 }, // 刚删
  ]
  const ids30 = selectExpiredCanvases(rows, now, 30)
  check(ids30.length === 1 && ids30[0] === 2, '30 天：仅 31 天前软删者过期（null/恰边界/新删不选）')
  const ids1 = selectExpiredCanvases(rows, now, 1)
  check(ids1.length === 2 && ids1[0] === 2 && ids1[1] === 3, '1 天：31/30 天前过期；刚删（1000ms）不过期')
  const ids365 = selectExpiredCanvases([{ id: 5, deletedAt: now - 366 * DAY }], now, 365)
  check(ids365.length === 1 && ids365[0] === 5, '365 天：366 天前过期')
}
