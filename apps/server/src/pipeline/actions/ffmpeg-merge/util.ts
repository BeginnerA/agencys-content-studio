/** 数值参数：params → defaults.video（settings）→ fallback */
export function numParam(v: unknown, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fb
}

/** [M11] 数值收敛（先下限后上限；hi < lo 时以 hi 收口——如极短片 fade 上限） */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi)
}

/** [M11] 保留 3 位小数（ffmpeg 参数文本防浮点尾数） */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
