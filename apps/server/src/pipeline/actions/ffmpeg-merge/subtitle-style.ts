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

/** 分层排版：命名样式组字号（与 buildSubtitleStyle 同式；作用于该路真实高度，PlayRes=输出尺寸即像素） */
export function assStyleFontSize(cfg: SubtitleStyleConfig, height: number): number {
  return Math.max(16, Math.round(height * (cfg.size_pct ?? 0.04)))
}

/**
 * 分层排版：ASS 具名 Style 行（Default 之外的 Title1… 追加行，23 字段与 subtitle-ass Format 行同序）。
 * 缺省字段回落基线观感（白字黑描边 0.0009/底部对齐/不加粗）；边距公式与 Default 行同源（W×0.05 / H×0.02）。
 * alignment 直传 cfg 值（本机 libass 实测标准 numpad：1-3 底/4-6 中/7-9 顶；缺省回落 2 底部基线）。
 * forceFontSize（可选）：正整数时取代 cfg 公式字号（Default 行沿用调用方 force_style 同源基线 fontSize 时用）。
 * 仅多 Style 场景调用，Default 行生成链不动（零 diff 红线）。
 */
export function assStyleRow(name: string, cfg: SubtitleStyleConfig, width: number, height: number, forceFontSize?: number): string {
  const marginL = Math.round(width * 0.05)
  const marginV = Math.round(height * (cfg.margin_v_pct ?? 0.02))
  const outline = Math.max(1, Math.round(height * (cfg.outline_pct ?? 0.0009)))
  const primary = cfg.color ? toAssColor(cfg.color) : '&H00FFFFFF'
  const outlineColor = cfg.outline_color ? toAssColor(cfg.outline_color) : '&H00000000'
  const fontSize = typeof forceFontSize === 'number' && Number.isInteger(forceFontSize) && forceFontSize > 0 ? forceFontSize : assStyleFontSize(cfg, height)
  return `Style: ${[
    name, cfg.font || 'Noto Sans CJK SC', fontSize, primary, '&H000000FF', outlineColor, '&H00000000',
    cfg.bold ? 1 : 0, 0, 0, 0, 100, 100, 0, 0, 1, outline, cfg.shadow ?? 0, cfg.alignment ?? 2, marginL, marginL, marginV, 1,
  ].join(',')}`
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
