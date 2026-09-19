/**
 * [M19] 多画幅共用常量与前端镜像工具（spec §2.3 ⑤）
 * - 选项与服务端 compose-config.ASPECTS / ASPECT_STRATEGIES 同值（新增比例两处同步）
 * - resolveAspectSize / isSameAspect 为 ffmpeg-merge 同名纯函数的镜像，**仅用于 UI 目标尺寸预览与置灰判定**，
 *   真实派生尺寸由服务端计算（本文件不参与编码链路）
 */
import type { AspectStrategy, AspectValue } from './types'

/** 可选发布画幅（label 面向分发场景） */
export const ASPECT_OPTIONS: Array<{
  value: AspectValue
  label: string
  short: string
}> = [
  { value: '9:16', label: '竖屏 9:16（抖音 / 快手 / Shorts）', short: '9:16' },
  { value: '1:1', label: '方形 1:1（信息流封面位）', short: '1:1' },
  { value: '4:5', label: '竖版图文 4:5（小红书 / Instagram）', short: '4:5' },
  { value: '16:9', label: '横屏 16:9（B 站 / 西瓜 / 视频号）', short: '16:9' },
]

/** 画幅适配策略说明（crop 默认） */
export const ASPECT_STRATEGY_OPTIONS: Array<{
  value: AspectStrategy
  label: string
  hint: string
}> = [
  {
    value: 'crop',
    label: '居中裁切',
    hint: '填满目标画幅，裁掉多余边缘（不留黑边，可能丢画面上下/左右内容）',
  },
  {
    value: 'pad',
    label: '等比补边',
    hint: '完整保留画面，不足处补黑边（有效画面变小）',
  },
]

const ASPECT_SET = new Set<string>(ASPECT_OPTIONS.map((o) => o.value))

export function isKnownAspect(v: unknown): v is AspectValue {
  return typeof v === 'string' && ASPECT_SET.has(v)
}

export function aspectLabel(v: string): string {
  return ASPECT_OPTIONS.find((o) => o.value === v)?.short ?? v
}

/** '9:16' → 比值（非法 → null） */
function ratioOf(aspect: string): { aw: number; ah: number } | null {
  const parts = aspect.split(':').map((n) => Number(n))
  const aw = parts[0] ?? 0
  const ah = parts[1] ?? 0
  if (!Number.isFinite(aw) || !Number.isFinite(ah) || aw <= 0 || ah <= 0)
    return null
  return { aw, ah }
}

/** 画幅 slug（文件名 / tags 用）：'9:16' → '9x16' */
export function aspectSlug(aspect: string): string {
  return aspect.replace(':', 'x')
}

/** slug → 画幅（tags 反解；未知 → null） */
export function aspectOfSlug(slug: string): AspectValue | null {
  const v = slug.replace('x', ':')
  return isKnownAspect(v) ? v : null
}

/** 与源同比例 → 无需派生（镜像服务端 1e-6 容差） */
export function isSameAspect(w: number, h: number, aspect: string): boolean {
  const r = ratioOf(aspect)
  if (!r || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
    return false
  return Math.abs(w / h - r.aw / r.ah) < 1e-6
}

/**
 * 派生画幅目标尺寸（镜像服务端 resolveAspectSize）：
 * 以高为基准 w = round(srcH × aw/ah)；超宽则改以宽为基准（保证不放大）；结果向下取偶（yuv420p）
 */
export function resolveAspectSize(
  srcW: number,
  srcH: number,
  aspect: string,
): { w: number; h: number } | null {
  const r = ratioOf(aspect)
  if (
    !r ||
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    srcW <= 0 ||
    srcH <= 0
  )
    return null
  let w = Math.round(srcH * (r.aw / r.ah))
  let h = srcH
  if (w > srcW) {
    w = srcW
    h = Math.round(srcW * (r.ah / r.aw))
  }
  const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)
  return { w: even(w), h: even(h) }
}
