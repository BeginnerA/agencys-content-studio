/**
 * 时码单一真源：秒 ↔ 帧 ↔ HH:MM:SS:FF（非丢帧 NDF）。
 * EDL / FCPXML / OTIO 三格式化器共用，避免各自换算漂移。
 * 帧率取 params.timeline.fps（默认 25）；NDF 下每「秒」恰为 round(fps) 帧，
 * 时码不进位丢帧补偿（EDL CMX3600 常规口径）。
 */

/** 帧率归一（非法/0 → 25）；换算基数用整帧率（25/24/30），非整数帧率就近取整展示 */
export function fpsBase(fps: number): number {
  const f = Math.round(fps)
  return f > 0 ? f : 25
}

/** 秒 → 帧（就近舍入到整帧，负值收敛 0） */
export function secToFrames(sec: number, fps: number): number {
  const f = fpsBase(fps)
  return Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * f))
}

/** 帧 → 秒 */
export function framesToSec(frames: number, fps: number): number {
  return frames / fpsBase(fps)
}

/** 帧 → HH:MM:SS:FF（NDF）；小时不设 24 上限（EDL 允许累计时码跨日） */
export function framesToTimecode(frames: number, fps: number): string {
  const f = fpsBase(fps)
  const total = Math.max(0, Math.round(frames))
  const p2 = (x: number): string => String(x).padStart(2, '0')
  const hours = Math.floor(total / (f * 3600))
  const minutes = Math.floor(total / (f * 60)) % 60
  const seconds = Math.floor(total / f) % 60
  const ff = total % f
  return `${p2(hours)}:${p2(minutes)}:${p2(seconds)}:${p2(ff)}`
}

/** 秒 → HH:MM:SS:FF */
export function secToTimecode(sec: number, fps: number): string {
  return framesToTimecode(secToFrames(sec, fps), fps)
}
