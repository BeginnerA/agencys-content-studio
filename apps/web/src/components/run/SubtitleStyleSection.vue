<script setup lang="ts">
/**
 * 合成设置 · 字幕样式节（自 ComposeSettingsModal.vue 原样搬出，行为零变更）：
 * run 级 brand.subtitle 覆盖（开关 + 9 字段表单）；状态真源在本组件，
 * 初值经 subtitle prop 回填（immediate watch = 原 onMounted fillSubForm 时序），
 * 提交经父级共享 wrap（busy 互斥 / notice / emit changed 全部同源）。
 */
import { ref, watch } from 'vue'
import { composeApi } from '../../lib/api'
import type { SubtitleStyleConfig } from '../../lib/types'
import Icon from '../common/Icon.vue'

const props = defineProps<{
  runId: number
  busy: boolean
  wrap: (fn: () => Promise<void>, okMsg: string) => Promise<void>
  /** 父级拉取 config 后下发（undefined=未加载/失败不回填；null=清除态回填关） */
  subtitle: SubtitleStyleConfig | null | undefined
}>()

/** 表单缺省值（与服务端 buildSubtitleStyle 公式基线一致；仅展示用） */
const SUB_DEFAULTS = {
  font: 'Noto Sans CJK SC',
  size: 1.8, // %
  color: '#FFFFFF',
  outlineColor: '#000000',
  outline: 0.09, // %
  shadow: 0,
  marginV: 2, // %
  alignment: 2 as 2 | 5 | 8,
  bold: false,
}

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
/** run 级是否已持久化字幕配置（决定「清除」按钮可用态） */
const subPersisted = ref(false)

/** 存储值 → 显示百分比（0.018 → 1.8；容忍脏数据） */
function showPct(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? +(v * 100).toFixed(3)
    : fallback
}

/** 显示百分比 → 存储值（1.8 → 0.018；前端温和 clamp，服务端硬 clamp 兜底） */
function storePct(v: number, lo: number, hi: number): number {
  const c = Math.min(hi, Math.max(lo, Number(v) || 0))
  return Number((c / 100).toFixed(5))
}

/** run 级配置回填（缺省字段用展示默认值；null/undefined → 开关关） */
function fillSubForm(s: SubtitleStyleConfig | null | undefined) {
  const cfg = s && typeof s === 'object' ? s : undefined
  subPersisted.value = !!cfg
  subOn.value = !!cfg
  subFont.value =
    typeof cfg?.font === 'string' && cfg.font ? cfg.font : SUB_DEFAULTS.font
  subSize.value = showPct(cfg?.size_pct, SUB_DEFAULTS.size)
  subColor.value =
    typeof cfg?.color === 'string' ? cfg.color : SUB_DEFAULTS.color
  subOutlineColor.value =
    typeof cfg?.outline_color === 'string'
      ? cfg.outline_color
      : SUB_DEFAULTS.outlineColor
  subOutline.value = showPct(cfg?.outline_pct, SUB_DEFAULTS.outline)
  subShadow.value =
    typeof cfg?.shadow === 'number' && Number.isFinite(cfg.shadow)
      ? cfg.shadow
      : SUB_DEFAULTS.shadow
  subMarginV.value = showPct(cfg?.margin_v_pct, SUB_DEFAULTS.marginV)
  subAlign.value =
    cfg?.alignment === 5 || cfg?.alignment === 8 ? cfg.alignment : 2
  subBold.value = cfg?.bold === true
}

watch(
  () => props.subtitle,
  (s) => {
    if (s !== undefined) fillSubForm(s)
  },
  { immediate: true },
)

/** 保存字幕样式：开关开 → 提交 patch；开关关 → 清除 run 级覆盖（null 回落继承） */
function saveSubtitle() {
  void props.wrap(
    async () => {
      if (!subOn.value) {
        await composeApi.updateConfig(props.runId, {
          brand: { subtitle: null },
        })
        fillSubForm(undefined)
        return
      }
      const patch: SubtitleStyleConfig = {
        font: subFont.value.trim() || undefined,
        size_pct: storePct(subSize.value, 0.8, 6),
        color: subColor.value,
        outline_color: subOutlineColor.value,
        outline_pct: storePct(subOutline.value, 0, 0.5),
        shadow: Math.round(
          Math.min(8, Math.max(0, Number(subShadow.value) || 0)),
        ),
        margin_v_pct: storePct(subMarginV.value, 0, 10),
        alignment: subAlign.value,
        bold: subBold.value,
      }
      await composeApi.updateConfig(props.runId, { brand: { subtitle: patch } })
      fillSubForm(patch)
    },
    subOn.value
      ? '字幕样式已保存（重新合成后生效）'
      : '字幕样式覆盖已清除（回落项目/平台配置）',
  )
}

/** 恢复表单为默认基线（不提交；保存后生效） */
function resetSubForm() {
  fillSubForm(undefined)
  subOn.value = true
}
</script>

<template>
  <div class="bg-sec">
    <label class="bg-ck">
      <input v-model="subOn" type="checkbox" :disabled="busy" />
      <span class="bg-lb"
        >自定义字幕样式<span class="muted bg-lb-tip"
          >run 级覆盖；未启用时继承项目/平台配置或默认（字号 1.8% 高 /
          底边距 2%）</span
        ></span
      >
    </label>

    <div class="st-grid" :class="{ off: !subOn }">
      <div class="st-row">
        <span class="st-lb">字体</span>
        <input
          v-model="subFont"
          type="text"
          class="st-txt grow"
          spellcheck="false"
          placeholder="Noto Sans CJK SC"
          :disabled="busy || !subOn"
        />
      </div>
      <div class="st-row">
        <span class="st-lb">字号</span>
        <input
          v-model.number="subSize"
          type="number"
          class="st-num"
          min="0.8"
          max="6"
          step="0.1"
          :disabled="busy || !subOn"
        />
        <span class="muted">%</span>
        <span class="st-lb st-lb-2">描边</span>
        <input
          v-model.number="subOutline"
          type="number"
          class="st-num"
          min="0"
          max="0.5"
          step="0.01"
          :disabled="busy || !subOn"
        />
        <span class="muted">%</span>
        <span class="st-lb st-lb-2">阴影</span>
        <input
          v-model.number="subShadow"
          type="number"
          class="st-num"
          min="0"
          max="8"
          step="1"
          :disabled="busy || !subOn"
        />
      </div>
      <div class="st-row">
        <span class="st-lb">字色</span>
        <input
          v-model="subColor"
          type="color"
          class="st-color"
          :disabled="busy || !subOn"
        />
        <span class="muted mono">{{ subColor.toUpperCase() }}</span>
        <span class="st-lb st-lb-2">描边色</span>
        <input
          v-model="subOutlineColor"
          type="color"
          class="st-color"
          :disabled="busy || !subOn"
        />
        <span class="muted mono">{{
          subOutlineColor.toUpperCase()
        }}</span>
      </div>
      <div class="st-row">
        <span class="st-lb">底边距</span>
        <input
          v-model.number="subMarginV"
          type="number"
          class="st-num"
          min="0"
          max="10"
          step="0.5"
          :disabled="busy || !subOn"
        />
        <span class="muted">%</span>
        <span class="st-lb st-lb-2">对齐</span>
        <select
          v-model.number="subAlign"
          class="st-sel"
          :disabled="busy || !subOn"
        >
          <option :value="2">底部居中</option>
          <option :value="5">中部居中</option>
          <option :value="8">顶部居中</option>
        </select>
      </div>
      <div class="st-row">
        <label class="bg-ck">
          <input
            v-model="subBold"
            type="checkbox"
            :disabled="busy || !subOn"
          />
          <span class="muted">加粗</span>
        </label>
      </div>
    </div>

    <div class="bg-row">
      <button
        class="btn sm"
        :class="{ primary: subOn }"
        :disabled="busy || (!subOn && !subPersisted)"
        @click="saveSubtitle"
      >
        <Icon name="check" :size="12" />
        {{ subOn ? '保存样式' : '清除覆盖（用继承）' }}
      </button>
      <button
        class="btn sm"
        :disabled="busy || !subOn"
        @click="resetSubForm"
      >
        恢复默认
      </button>
      <span class="muted bg-lb-tip"
        >保存后重新合成生效；字号占成片高度百分比</span
      >
    </div>
  </div>
</template>

<style scoped>
/* 共享布局类自带一份（父级同名规则仅命中子组件根元素，内部元素需子级作用域） */
.bg-sec {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.bg-lb {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12.5px;
}

.bg-lb-tip {
  margin-left: 8px;
  font-weight: 400;
  font-size: 11.5px;
}

.bg-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grow {
  flex: 1;
}

.bg-ck {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

/* ===== 字幕样式表单 ===== */

.st-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  transition: opacity 0.15s;
}

.st-grid.off {
  opacity: 0.55;
}

.st-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.st-lb {
  min-width: 44px;
  font-size: 12px;
  color: var(--text-2);
}

.st-lb-2 {
  margin-left: 10px;
}

.st-txt {
  /* 覆盖全局 input width:100%（行内伸缩布局） */
  width: auto;
  min-width: 180px;
  padding: 3px 8px;
  font-size: 12.5px;
}

.st-num {
  /* 覆盖全局 input width:100% */
  width: 68px;
  padding: 3px 7px;
  font-size: 12.5px;
}

.st-sel {
  /* 覆盖全局 select width:100%：按内容宽收缩 */
  width: auto;
  max-width: 140px;
  padding: 3px 8px;
  font-size: 12.5px;
}

.st-color {
  width: 34px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  cursor: pointer;
}
</style>
