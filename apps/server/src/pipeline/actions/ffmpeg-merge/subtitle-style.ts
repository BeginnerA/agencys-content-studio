import type { SubtitleStyleConfig } from '../../../services/brand-config'

/** 字幕 ASS 风格缺省（字号/边距按输出高度自适应；模板可用 defaults.video.subtitle_style 整体覆盖）。
 * size_pct 由 0.018 提到 0.04：修复前 subtitles 吃 SRT 时 FontSize 被 libass 按默认小 PlayResY
 * 二次放大（≈×3），0.018 实得 ≈0.055 观感；改显式 PlayRes 的 ASS 后 FontSize 即真实像素，需按真实
 * 比例取竖屏短视频通用字号（≈4% 高，1280→51px），否则字幕过小。clamp 区间 0.008–0.06 不变。 */
export function defaultSubtitleStyle(height: number): string {
  const fontSize = Math.max(16, Math.round(height * 0.04))
  const marginV = Math.round(height * 0.02)
  const outline = Math.max(1, Math.round(height * 0.0009))
  return (
    `FontName=Noto Sans CJK SC,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,` +
    `OutlineColour=&H00000000,BorderStyle=1,Outline=${outline},Shadow=0,MarginV=${marginV}`
  )
}

/** '#RRGGBB' → ASS 颜色 '&HAABBGGRR'（A=00 不透明） */
export function toAssColor(hex: string): string {
  return `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase()
}

/**
 * 字幕样式结构化组装：基线 = defaultSubtitleStyle 现公式（字段序一致），cfg 已定义字段逐项覆盖。
 * 零漂移红线：buildSubtitleStyle(H, {}) === defaultSubtitleStyle(H)（逐字相等）。
 * alignment/bold 缺省不输出（追加于末尾，不影响基线串）。
 */
export function buildSubtitleStyle(height: number, cfg: SubtitleStyleConfig = {}): string {
  const font = cfg.font ?? 'Noto Sans CJK SC'
  const fontSize = Math.max(16, Math.round(height * (cfg.size_pct ?? 0.04)))
  const primary = cfg.color ? toAssColor(cfg.color) : '&H00FFFFFF'
  const outlineColor = cfg.outline_color ? toAssColor(cfg.outline_color) : '&H00000000'
  const outline = Math.max(1, Math.round(height * (cfg.outline_pct ?? 0.0009)))
  const shadow = cfg.shadow ?? 0
  const marginV = Math.round(height * (cfg.margin_v_pct ?? 0.02))
  let s =
    `FontName=${font},FontSize=${fontSize},PrimaryColour=${primary},` +
    `OutlineColour=${outlineColor},BorderStyle=1,Outline=${outline},Shadow=${shadow},MarginV=${marginV}`
  if (cfg.alignment !== undefined) s += `,Alignment=${cfg.alignment}`
  if (cfg.bold !== undefined) s += `,Bold=${cfg.bold ? 1 : 0}`
  return s
}
