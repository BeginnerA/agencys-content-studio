import type { WatermarkPosition } from '../../../services/brand-config'

/** [M19] 水印 overlay 定位表达式（九宫格 + 边距；margin 已整数化）：tl=24:24 / mc=(W-w)/2:(H-h)/2 … */
export function watermarkOverlayXY(position: WatermarkPosition, marginPx: number): string {
  const m = Math.round(marginPx)
  const row = position.charAt(0)
  const col = position.charAt(1)
  const x = col === 'l' ? `${m}` : col === 'c' ? '(W-w)/2' : `W-w-${m}`
  const y = row === 't' ? `${m}` : row === 'm' ? '(H-h)/2' : `H-h-${m}`
  return `${x}:${y}`
}
