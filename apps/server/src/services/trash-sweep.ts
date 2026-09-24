// 回收站保留期自动清理：settings 'trash' 策略解析 + 过期选择纯函数 + 批量 purge。
import { eq, isNotNull } from 'drizzle-orm'
import { db } from '../db'
import { canvases, settings } from '../db/schema'
import { createLogger } from '../logger'
import { purgeCanvas } from './creation/canvas'

const log = createLogger('trash-sweep')

export interface TrashPolicy {
  /** 保留天数（1-365，clamp） */
  retentionDays: number
  /** 自动清理开关（false 时 purgeExpiredCanvases 直接跳过） */
  autoPurge: boolean
}

export const TRASH_DEFAULTS: TrashPolicy = { retentionDays: 30, autoPurge: true }
export const TRASH_RETENTION_RANGE = { lo: 1, hi: 365 } as const

const DAY_MS = 86_400_000

/** 宽容解析 settings 'trash' 值（坏形态 → 默认；越界 → clamp；探针直测） */
export function parseTrashPolicy(raw: unknown): TrashPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...TRASH_DEFAULTS }
  const o = raw as Record<string, unknown>
  let retentionDays = TRASH_DEFAULTS.retentionDays
  const rd = o['retentionDays']
  if (typeof rd === 'number' && Number.isFinite(rd)) {
    retentionDays = Math.min(TRASH_RETENTION_RANGE.hi, Math.max(TRASH_RETENTION_RANGE.lo, Math.round(rd)))
  }
  const autoPurge = typeof o['autoPurge'] === 'boolean' ? o['autoPurge'] : TRASH_DEFAULTS.autoPurge
  return { retentionDays, autoPurge }
}

/** 读生效策略：settings.key='trash' → 内置默认（concurrency 先例） */
export async function resolveTrashPolicy(): Promise<TrashPolicy> {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, 'trash')).limit(1)
    if (rows[0]) {
      try {
        return parseTrashPolicy(JSON.parse(rows[0].value))
      } catch {
        /* JSON 损坏 → 默认 */
      }
    }
  } catch {
    /* settings 表缺失 → 默认 */
  }
  return { ...TRASH_DEFAULTS }
}

/** 过期选择纯函数：deletedAt 非空且严格早于 now − retentionDays×86400_000 */
export function selectExpiredCanvases(rows: Array<{ id: number; deletedAt: number | null }>, now: number, retentionDays: number): number[] {
  const cutoff = now - retentionDays * DAY_MS
  return rows.filter((r) => r.deletedAt != null && r.deletedAt < cutoff).map((r) => r.id)
}

/** 批量清理过期软删画布（跨项目全表扫；逐个复用 purgeCanvas 级联）。返回清理数。 */
export async function purgeExpiredCanvases(): Promise<number> {
  const policy = await resolveTrashPolicy()
  if (!policy.autoPurge) return 0
  const rows = await db.select({ id: canvases.id, deletedAt: canvases.deletedAt }).from(canvases).where(isNotNull(canvases.deletedAt))
  const ids = selectExpiredCanvases(rows, Date.now(), policy.retentionDays)
  for (const id of ids) await purgeCanvas(id)
  if (ids.length > 0) log.info(`回收站过期清理：${ids.length} 个画布（保留期 ${policy.retentionDays} 天）→ [${ids.join(', ')}]`)
  return ids.length
}
