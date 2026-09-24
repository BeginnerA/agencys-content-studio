/** 画幅字符串 'a:b' → 比值（非法入参抛错；服务层入口已先校验枚举） */
function aspectRatio(aspect: string): { aw: number; ah: number } {
  const [aw, ah] = aspect.split(':').map((n) => Number(n))
  if (!aw || !ah || aw <= 0 || ah <= 0) throw new Error(`非法画幅：${aspect}`)
  return { aw, ah }
}

/**
 * 派生画幅尺寸（纯函数；A 派生端点与 B 多路渲染同源）：
 * 以高为基准 w = round(srcH × aw/ah)；w 超宽则改为以宽为基准（**保证不放大**）；
 * 结果向下取偶（libx264 yuv420p 要求宽高均为偶数，取偶只会变小不会变大）。
 */
export function resolveAspectSize(srcW: number, srcH: number, aspect: string): { w: number; h: number } {
  const { aw, ah } = aspectRatio(aspect)
  let w = Math.round(srcH * (aw / ah))
  let h = srcH
  if (w > srcW) {
    w = srcW
    h = Math.round(srcW * (ah / aw))
  }
  const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)
  return { w: even(w), h: even(h) }
}

/** 画幅几何滤镜串：crop 居中裁切 / pad 等比缩小后补黑边（尺寸需先经 resolveAspectSize） */
export function aspectGeometryFilter(strategy: string, w: number, h: number): string {
  return strategy === 'pad'
    ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
    : `crop=${w}:${h}:(iw-${w})/2:(ih-${h})/2,setsar=1`
}

/** 与主画幅同比例 → 无需派生（重复编码无意义） */
export function isSameAspect(w: number, h: number, aspect: string): boolean {
  const { aw, ah } = aspectRatio(aspect)
  return Math.abs(w / h - aw / ah) < 1e-6
}
