/**
 * 发布节奏模板 → 排期日期展开（Tier A，纯日期数学，零 LLM / 零网络）。
 * 修复「日更 7 天要手算 7 个未来时间戳、逐条建 7 次」的手工会填。产出仅时间戳数组，
 * 由上层预览后再批量落库；本服务不写库、不触发（触发仍由调度器到点幂等执行，引擎零触碰）。
 * 时间粒度以 UTC 毫秒加法计（中国无夏令时，日粒度加 24h 等价保时刻；weekdays 判定取 getUTCDay，探针确定）。
 */

const DAY = 86_400_000

export type Cadence =
  | { kind: 'daily' }
  | { kind: 'interval'; intervalDays: number } // 2–30
  | { kind: 'weekly'; weekdays: number[] } // 0–6（Sun–Sat），startAt 之后向后命中这些 weekday

export interface ExpandInput {
  startAt: number
  count: number // 1–60
  cadence: Cadence
}

export interface ExpandResult {
  timestamps: number[]
  errors: string[]
}

/**
 * 展开节奏为升序未来时间戳数组。校验违规 → errors 非空且 timestamps 空（不抛）；
 * 合法 → 丢弃早于 `now - 60_000` 的时间戳（对齐单条建「未来时间」校验），返回不短于剩余数。
 */
export function expandCadence(input: ExpandInput): ExpandResult {
  const errors: string[] = []
  const startAt = input?.startAt
  const count = input?.count
  const cadence = input?.cadence

  if (typeof startAt !== 'number' || !Number.isFinite(startAt)) errors.push('startAt 需为有限数（ms 时间戳）')
  if (!Number.isInteger(count) || count < 1 || count > 60) errors.push('count 需为 1–60 的整数')
  if (!cadence || typeof cadence !== 'object' || typeof cadence.kind !== 'string') {
    errors.push('cadence 非法（需 kind: daily|interval|weekly）')
  } else if (cadence.kind === 'interval') {
    if (!Number.isInteger(cadence.intervalDays) || cadence.intervalDays < 2 || cadence.intervalDays > 30) {
      errors.push('intervalDays 需为 2–30 的整数')
    }
  } else if (cadence.kind === 'weekly') {
    const wd = cadence.weekdays
    if (!Array.isArray(wd) || wd.length === 0 || wd.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      errors.push('weekdays 需为 0–6 的非空整数数组')
    }
  } else if (cadence.kind !== 'daily') {
    errors.push('cadence.kind 未支持')
  }

  if (errors.length > 0) return { timestamps: [], errors }

  const out: number[] = []
  if (cadence.kind === 'daily') {
    for (let i = 0; i < count; i++) out.push(startAt + i * DAY)
  } else if (cadence.kind === 'interval') {
    for (let i = 0; i < count; i++) out.push(startAt + i * cadence.intervalDays * DAY)
  } else {
    // weekly：从 startAt 起逐向后日扫描，命中 weekdays 集合即取（保 startAt 的时:分）
    const set = new Set(cadence.weekdays)
    for (let d = 0; out.length < count && d < 400; d++) {
      const t = startAt + d * DAY
      if (set.has(new Date(t).getUTCDay())) out.push(t)
    }
  }

  const floor = Date.now() - 60_000
  return { timestamps: out.filter((t) => t >= floor), errors: [] }
}
