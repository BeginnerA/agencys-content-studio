import { eq } from 'drizzle-orm'
import { db } from '../db'
import { settings } from '../db/schema'

// ===== 全局并发上限（settings 'concurrency' → env → 默认 3；1–6 clamp） =====

const DEFAULT_GLOBAL_MAX = 3
const GLOBAL_MAX_RANGE = { lo: 1, hi: 6 } as const

function clampGlobalMax(n: number): number {
  return Math.min(GLOBAL_MAX_RANGE.hi, Math.max(GLOBAL_MAX_RANGE.lo, Math.round(n)))
}

/** 解析生效的全局并发上限：settings.key='concurrency' {max} → env CSTUDIO_GLOBAL_MAX_CONCURRENT → 默认 3 */
export async function resolveConcurrencyMax(): Promise<number> {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, 'concurrency')).limit(1)
    if (rows[0]) {
      try {
        const n = Number((JSON.parse(rows[0].value) as { max?: unknown }).max)
        if (Number.isFinite(n)) return clampGlobalMax(n)
      } catch {
        /* JSON 损坏 → 继续兜底 */
      }
    }
  } catch {
    /* settings 表缺失 → 兜底 */
  }
  const envRaw = process.env.CSTUDIO_GLOBAL_MAX_CONCURRENT
  if (envRaw?.trim()) {
    const n = Number(envRaw)
    if (Number.isFinite(n)) return clampGlobalMax(n)
  }
  return DEFAULT_GLOBAL_MAX
}

/** 生效上限缓存（引擎 startRun 的同步闸门经 currentGlobalMax 读取）；由 refreshGlobalConcurrency 刷新 */
let cachedGlobalMax = DEFAULT_GLOBAL_MAX

/** 刷新并返回生效上限（启动 / pumpGlobal 每轮调用） */
export async function refreshGlobalConcurrency(): Promise<number> {
  cachedGlobalMax = await resolveConcurrencyMax()
  return cachedGlobalMax
}

/** 当前生效上限（同步读缓存；诊断 / 探针用） */
export function currentGlobalMax(): number {
  return cachedGlobalMax
}
