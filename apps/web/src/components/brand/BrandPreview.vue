<script setup lang="ts">
/**
 * [M20] 品牌效果预览
 * 在模拟视频帧上实时呈现字幕样式 + 水印位置 + 片头片尾状态，
 * 帮助用户在配置时直观看到合成后的真实效果。
 */
import { computed } from 'vue'
import { brandAssetApi } from '../../lib/api'
import type {
  BrandConfig,
  BrandMaterialSlot,
  SubtitleStyleConfig,
  WatermarkPosition,
} from '../../lib/types'
import Icon from '../common/Icon.vue'

const props = defineProps<{
  brand: BrandConfig
  /** 水印文件路径（platform scope 上传后的文件名） */
  wmFile?: string
  /** 预览时间戳（用于刷新缓存） */
  wmPreviewTs?: number
  /** [M20 fix] 片头/片尾文件路径（实时预览用，因 brand.intro.file 可能未随表单变化同步） */
  introFile?: string
  outroFile?: string
}>()

// ---------- 字幕样式计算 ----------

const SUB_DEFAULTS = {
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

const subCfg = computed<SubtitleStyleConfig | null>(
  () => props.brand.subtitle ?? null,
)

/** 预览帧高度（px）——用于将 pct 配置换算为像素 */
const FRAME_H = 270 // 16:9 帧，高度 270px

const subStyle = computed(() => {
  const s = subCfg.value
  const sizePct = s?.size_pct ?? SUB_DEFAULTS.size
  const marginPct = s?.margin_v_pct ?? SUB_DEFAULTS.marginV
  const outlinePct = s?.outline_pct ?? SUB_DEFAULTS.outline
  // [M20 fix] size_pct/margin_v_pct/outline_pct 均为「视频高度百分比」
  // 合成基线 1080p：px = val/100 × 1080；预览帧按 FRAME_H 等比缩放
  const PREVIEW_SCALE = FRAME_H / 1080
  const fontSize = Math.max(
    10,
    Math.round((sizePct / 100) * 1080 * PREVIEW_SCALE),
  )
  const marginV = Math.round((marginPct / 100) * 1080 * PREVIEW_SCALE)
  const outlinePx = Math.max(
    0,
    Math.round((outlinePct / 100) * 1080 * PREVIEW_SCALE),
  )
  const shadowRaw = s?.shadow ?? SUB_DEFAULTS.shadow
  const shadowPx = Math.max(0, Math.round(shadowRaw * PREVIEW_SCALE))
  const color = s?.color ?? SUB_DEFAULTS.color
  const outlineColor = s?.outline_color ?? SUB_DEFAULTS.outlineColor
  const align = s?.alignment ?? SUB_DEFAULTS.alignment
  const bold = s?.bold ?? SUB_DEFAULTS.bold
  const font = s?.font || SUB_DEFAULTS.font

  // 垂直位置：2=底部、5=中部、8=顶部
  // [M20 fix] 水平居中 translateX(-50%) 由 CSS .bp-sub 提供；
  // 仅 align=5（中部）需叠加 translateY，其余不设 inline transform 以免覆盖 CSS
  let top: string | undefined
  let bottom: string | undefined
  let extraTransform = ''
  if (align === 8) {
    top = `${marginV}px`
  } else if (align === 5) {
    top = '50%'
    extraTransform = 'translateX(-50%) translateY(-50%)'
  } else {
    bottom = `${marginV}px`
  }

  const style: Record<string, string> = {
    fontSize: `${fontSize}px`,
    color,
    fontFamily: `${font}, sans-serif`,
    fontWeight: bold ? '700' : '400',
    textShadow: outlinePx
      ? `-${outlinePx}px 0 ${outlineColor}, ${outlinePx}px 0 ${outlineColor}, 0 -${outlinePx}px ${outlineColor}, 0 ${outlinePx}px ${outlineColor}`
      : 'none',
    lineHeight: '1.3',
    letterSpacing: '0.02em',
  }
  if (top) style.top = top
  if (bottom) style.bottom = bottom
  if (extraTransform) style.transform = extraTransform
  if (shadowPx > 0) {
    style.textShadow =
      (style.textShadow ? style.textShadow + ', ' : '') +
      `0 ${shadowPx}px ${shadowPx * 2}px rgba(0,0,0,0.7)`
  }
  return style
})

const subAlignClass = computed(() => {
  const a = subCfg.value?.alignment ?? SUB_DEFAULTS.alignment
  return a === 8 ? 'pv-top' : a === 5 ? 'pv-mid' : 'pv-bot'
})

// ---------- 水印位置计算 ----------

const wmCfg = computed(() => props.brand.watermark ?? null)
// [M20 fix2] 水印来源两态：项目资产 asset_id（优先）或平台品牌文件 file
const wmAssetIdResolved = computed(() => {
  const v = wmCfg.value?.asset_id
  return typeof v === 'number' && v > 0 ? v : 0
})
// [M20 fix] wmEnabled 优先用 wmFile prop（实时表单联动），回退到 brand 内的已保存来源
const wmEnabled = computed(
  () =>
    wmCfg.value?.enabled !== false &&
    !!(wmAssetIdResolved.value > 0 || props.wmFile || wmCfg.value?.file),
)
const wmOpacity = computed(() => {
  const v = wmCfg.value?.opacity
  return typeof v === 'number' ? Math.round(v * 100) : 90
})
const wmWidthPct = computed(() => {
  const v = wmCfg.value?.width_pct
  return typeof v === 'number' ? Math.round(v * 100) : 15
})
const wmMarginPx = computed(() => {
  const v = wmCfg.value?.margin_px
  return typeof v === 'number' ? v : 24
})

/** 九宫格 → CSS 定位 */
const wmPosStyle = computed(() => {
  const pos: WatermarkPosition = wmCfg.value?.position ?? 'br'
  const m = wmMarginPx.value
  const style: Record<string, string> = { position: 'absolute' }
  // 水平
  if (pos.endsWith('l')) style.left = `${m}px`
  else if (pos.endsWith('r')) style.right = `${m}px`
  else {
    style.left = '50%'
    style.transform = 'translateX(-50%)'
  }
  // 垂直
  if (pos.startsWith('t')) style.top = `${m}px`
  else if (pos.startsWith('b')) style.bottom = `${m}px`
  else {
    style.top = '50%'
    style.transform =
      (style.transform ? style.transform + ' ' : '') + 'translateY(-50%)'
  }
  return style
})

const wmFileResolved = computed(() => props.wmFile || wmCfg.value?.file || '')
const wmUrl = computed(() => {
  // 资产来源走资产文件端点（asset_id 优先，与合成端 resolveMaterialPath 语义一致）
  if (wmAssetIdResolved.value > 0)
    return `/api/v1/assets/${wmAssetIdResolved.value}/file`
  return wmFileResolved.value
    ? brandAssetApi.fileUrl('watermark', props.wmPreviewTs ?? 0)
    : ''
})

// ---------- 片头片尾状态 ----------

/** [M20 fix2] 片段槽是否生效（来源两态：asset_id 优先 → file；enabled=false 强制禁用） */
function slotOn(
  cfg: BrandMaterialSlot | null | undefined,
  fileProp: string | undefined,
): boolean {
  if (cfg?.enabled === false) return false
  return !!(
    fileProp ||
    cfg?.file ||
    (typeof cfg?.asset_id === 'number' && cfg.asset_id > 0)
  )
}
const introOn = computed(() => slotOn(props.brand.intro, props.introFile))
const outroOn = computed(() => slotOn(props.brand.outro, props.outroFile))
</script>

<template>
  <div class="bp-wrap">
    <div class="bp-head">
      <Icon name="eye" :size="13" />
      <span>效果预览</span>
      <span class="muted bp-tip">模拟视频帧（16:9）上的实际呈现</span>
    </div>

    <!-- 模拟视频帧 -->
    <div class="bp-frame">
      <!-- 背景：模拟视频内容 -->
      <div class="bp-bg">
        <div class="bp-scene">
          <div class="bp-mountain" />
          <div class="bp-mountain bp-m2" />
          <div class="bp-sun" />
        </div>
      </div>

      <!-- 片头标记 -->
      <div v-if="introOn" class="bp-badge bp-intro">
        <Icon name="play" :size="9" /> 片头
      </div>

      <!-- 片尾标记 -->
      <div v-if="outroOn" class="bp-badge bp-outro">
        片尾 <Icon name="stop" :size="9" />
      </div>

      <!-- 水印 -->
      <img
        v-if="wmEnabled && wmUrl"
        class="bp-wm"
        :src="wmUrl"
        alt="水印预览"
        :style="{
          ...wmPosStyle,
          opacity: wmOpacity / 100,
          width: `${wmWidthPct}%`,
        }"
      />

      <!-- 字幕 -->
      <div
        v-if="subCfg"
        class="bp-sub"
        :class="subAlignClass"
        :style="subStyle"
      >
        这是一段示例字幕文字
      </div>
      <div
        v-else
        class="bp-sub bp-bot"
        style="
          font-size: 14px;
          color: #fff;
          text-shadow:
            -1px 0 #000,
            1px 0 #000,
            0 -1px #000,
            0 1px #000;
        "
      >
        未配置字幕样式（用默认）
      </div>
    </div>

    <!-- 状态摘要 -->
    <div class="bp-summary">
      <span class="bp-chip" :class="{ on: !!subCfg }"
        >字幕 {{ subCfg ? '已配置' : '默认' }}</span
      >
      <span class="bp-chip" :class="{ on: wmEnabled }"
        >水印 {{ wmEnabled ? '已启用' : '未启用' }}</span
      >
      <span class="bp-chip" :class="{ on: introOn }"
        >片头 {{ introOn ? '已配置' : '未配置' }}</span
      >
      <span class="bp-chip" :class="{ on: outroOn }"
        >片尾 {{ outroOn ? '已配置' : '未配置' }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.bp-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bp-head {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
}

.bp-tip {
  font-weight: 400;
  font-size: 11.5px;
}

.bp-frame {
  position: relative;
  aspect-ratio: 16 / 9;
  width: 100%;
  max-width: 420px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: #0a0e1a;
}

/* 模拟场景：山 + 太阳 */
.bp-bg {
  position: absolute;
  inset: 0;
}

.bp-scene {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    170deg,
    #1a1a3e 0%,
    #2d1b4e 35%,
    #4a2c6e 55%,
    #1e3a5f 80%,
    #0d1b2a 100%
  );
}

.bp-mountain {
  position: absolute;
  bottom: 0;
  left: -10%;
  width: 60%;
  height: 55%;
  background: linear-gradient(160deg, #2a3d5c, #1a2740);
  clip-path: polygon(0% 100%, 50% 15%, 100% 100%);
}

.bp-mountain.bp-m2 {
  left: 35%;
  width: 75%;
  height: 65%;
  background: linear-gradient(200deg, #1e3050, #0f1f35);
  clip-path: polygon(0% 100%, 45% 10%, 100% 100%);
}

.bp-sun {
  position: absolute;
  top: 18%;
  right: 22%;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    #ffd280 30%,
    #ff9e40 70%,
    transparent 100%
  );
  box-shadow: 0 0 20px 8px rgba(255, 180, 80, 0.25);
}

/* 水印 */
.bp-wm {
  max-height: 22%;
  object-fit: contain;
  pointer-events: none;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
}

/* 字幕 */
.bp-sub {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  white-space: nowrap;
  pointer-events: none;
  padding: 0 8px;
}

.bp-sub.pv-bot {
  bottom: 20px;
}
.bp-sub.pv-mid {
  top: 50%; /* transform 由 inline style 控制（含 translateX(-50%) 水平居中） */
}
.bp-sub.pv-top {
  top: 12px;
}

/* 片头片尾标记 */
.bp-badge {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
  pointer-events: none;
}

.bp-intro {
  top: 6px;
  left: 6px;
  background: rgba(34, 197, 94, 0.85);
  color: #fff;
}

.bp-outro {
  top: 6px;
  right: 6px;
  background: rgba(239, 68, 68, 0.85);
  color: #fff;
}

/* 状态摘要 */
.bp-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.bp-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-weak, #f1f5f9);
  color: var(--muted, #64748b);
  border: 1px solid var(--border, #e2e8f0);
}

.bp-chip.on {
  background: var(--ok-weak, #dcfce7);
  color: var(--ok, #16a34a);
  border-color: var(--ok, #16a34a);
}
</style>
