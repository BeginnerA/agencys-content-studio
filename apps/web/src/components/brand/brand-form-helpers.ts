/**
 * [M19] 品牌设置纯逻辑辅助（BrandSettings 拆分：M26 红线纯重构，函数体逐字搬移）
 * 无响应式依赖：类型守卫 / 百分比换算 / 位置规范化 / 常量表 / 品牌浅合并 / 槽文件路径。
 * 供 use-brand-form / use-brand-run 与 BrandSettings.vue 共用。
 */
import type {
  BrandConfig,
  BrandSlotKey,
  WatermarkPosition,
} from '../../lib/types'

export const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export function normBrand(v: unknown): BrandConfig {
  return isObj(v) ? (v as BrandConfig) : {}
}

export const WM_POSITIONS: Array<{ v: WatermarkPosition; t: string }> = [
  { v: 'tl', t: '左上' },
  { v: 'tc', t: '上中' },
  { v: 'tr', t: '右上' },
  { v: 'ml', t: '左中' },
  { v: 'mc', t: '正中' },
  { v: 'mr', t: '右中' },
  { v: 'bl', t: '左下' },
  { v: 'bc', t: '下中' },
  { v: 'br', t: '右下' },
]

/** 存储值 → 显示百分比（容忍脏数据） */
export function pctShow(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? +(v * 100).toFixed(3)
    : fallback
}
/** 显示百分比 → 存储值（前端温和 clamp，服务端硬 clamp 兜底） */
export function pctStore(v: number, lo: number, hi: number): number {
  const c = Math.min(hi, Math.max(lo, Number(v) || 0))
  return Number((c / 100).toFixed(5))
}
export function posOf(v: unknown): WatermarkPosition {
  return WM_POSITIONS.some((p) => p.v === v) ? (v as WatermarkPosition) : 'br'
}
export function marginOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.round(Math.min(200, Math.max(0, v)))
    : 24
}

/** 字幕样式表单（与服务端 buildSubtitleStyle 公式基线一致的展示默认值） */
export const SUB_DEFAULTS = {
  font: 'Noto Sans CJK SC',
  size: 1.8,
  color: '#FFFFFF',
  outlineColor: '#000000',
  outline: 0.09,
  shadow: 0,
  marginV: 2,
  alignment: 2 as 2 | 5 | 8,
  bold: false,
}

/** 前端镜像 mergeBrand：槽内字段级浅合并（展示用） */
export function mergeFront(...layers: unknown[]): BrandConfig {
  const out: BrandConfig = {}
  for (const layer of layers) {
    if (!isObj(layer)) continue
    const l = layer as BrandConfig
    if (isObj(l.subtitle)) out.subtitle = { ...out.subtitle, ...l.subtitle }
    if (isObj(l.watermark)) out.watermark = { ...out.watermark, ...l.watermark }
    if (isObj(l.intro)) out.intro = { ...out.intro, ...l.intro }
    if (isObj(l.outro)) out.outro = { ...out.outro, ...l.outro }
  }
  return out
}

export function fileOf(b: BrandConfig, slot: BrandSlotKey): string {
  const f = b[slot]?.file
  return typeof f === 'string' ? f : ''
}

export const SLOT_TEXT: Record<BrandSlotKey, string> = {
  watermark: '水印',
  intro: '片头',
  outro: '片尾',
}
