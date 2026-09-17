/**
 * [M19] 品牌公共表单状态（BrandSettings 拆分：M26 红线纯重构，函数体逐字搬移）
 * 水印参数 + 片头尾开关 + 字幕样式的响应式表单；fill/collect 逻辑供三 scope 复用。
 */
import { ref } from 'vue'
import type { BrandConfig, SubtitleStyleConfig, WatermarkPosition } from '../../lib/types'
import { SUB_DEFAULTS, marginOf, pctShow, pctStore, posOf } from './brand-form-helpers'

export function useBrandForm() {
  const wmEnabled = ref(true)
  const wmPosition = ref<WatermarkPosition>('br')
  const wmOpacity = ref(90) // 显示 %（存储 0.05–1）
  const wmWidth = ref(15) // 显示 %（存储 0.03–0.5）
  const wmMargin = ref(24)

  const introEnabled = ref(true)
  const outroEnabled = ref(true)

  const subOn = ref(false)
  const subFont = ref(SUB_DEFAULTS.font)
  const subSize = ref(SUB_DEFAULTS.size)
  const subColor = ref(SUB_DEFAULTS.color)
  const subOutlineColor = ref(SUB_DEFAULTS.outlineColor)
  const subOutline = ref(SUB_DEFAULTS.outline)
  const subShadow = ref(SUB_DEFAULTS.shadow)
  const subMarginV = ref(SUB_DEFAULTS.marginV)
  const subAlign = ref<2 | 5 | 8>(SUB_DEFAULTS.alignment)
  const subBold = ref(SUB_DEFAULTS.bold)
  const subPersisted = ref(false)

  function fillSubForm(s: SubtitleStyleConfig | null | undefined) {
    const cfg = s && typeof s === 'object' ? s : undefined
    subPersisted.value = !!cfg
    subOn.value = !!cfg
    subFont.value = typeof cfg?.font === 'string' && cfg.font ? cfg.font : SUB_DEFAULTS.font
    subSize.value = pctShow(cfg?.size_pct, SUB_DEFAULTS.size)
    subColor.value = typeof cfg?.color === 'string' ? cfg.color : SUB_DEFAULTS.color
    subOutlineColor.value = typeof cfg?.outline_color === 'string' ? cfg.outline_color : SUB_DEFAULTS.outlineColor
    subOutline.value = pctShow(cfg?.outline_pct, SUB_DEFAULTS.outline)
    subShadow.value = typeof cfg?.shadow === 'number' && Number.isFinite(cfg.shadow) ? cfg.shadow : SUB_DEFAULTS.shadow
    subMarginV.value = pctShow(cfg?.margin_v_pct, SUB_DEFAULTS.marginV)
    subAlign.value = cfg?.alignment === 5 || cfg?.alignment === 8 ? cfg.alignment : 2
    subBold.value = cfg?.bold === true
  }

  function collectSub(): SubtitleStyleConfig {
    return {
      font: subFont.value.trim() || undefined,
      size_pct: pctStore(subSize.value, 0.8, 6),
      color: subColor.value,
      outline_color: subOutlineColor.value,
      outline_pct: pctStore(subOutline.value, 0, 0.5),
      shadow: Math.round(Math.min(8, Math.max(0, Number(subShadow.value) || 0))),
      margin_v_pct: pctStore(subMarginV.value, 0, 10),
      alignment: subAlign.value,
      bold: subBold.value,
    }
  }

  /** 从品牌配置回填公共表单（platform/project） */
  function fillCommon(b: BrandConfig) {
    wmEnabled.value = b.watermark ? b.watermark.enabled !== false : true
    wmPosition.value = posOf(b.watermark?.position)
    wmOpacity.value = pctShow(b.watermark?.opacity, 90)
    wmWidth.value = pctShow(b.watermark?.width_pct, 15)
    wmMargin.value = marginOf(b.watermark?.margin_px)
    introEnabled.value = b.intro ? b.intro.enabled !== false : true
    outroEnabled.value = b.outro ? b.outro.enabled !== false : true
    fillSubForm(b.subtitle && typeof b.subtitle === 'object' ? b.subtitle : undefined)
  }

  return {
    wmEnabled,
    wmPosition,
    wmOpacity,
    wmWidth,
    wmMargin,
    introEnabled,
    outroEnabled,
    subOn,
    subFont,
    subSize,
    subColor,
    subOutlineColor,
    subOutline,
    subShadow,
    subMarginV,
    subAlign,
    subBold,
    subPersisted,
    fillSubForm,
    collectSub,
    fillCommon,
  }
}
