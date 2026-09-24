<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'

/**
 * 确认卡「应用品牌风格」开关（独立轻组件：确认卡本体已近红线长度，同 CreationResolution/ReviewGate 先例）。
 * 默认继承平台/项目已配品牌（水印 / 片头 / 片尾 / 字幕样式）；取消勾选 = 本次成片逐次不叠加品牌。
 * 开关不入 planHash（是启动方式而非执行数据）：改勾选不作废已确认方案、不触发重新规划、零计费。
 * 仅当预检 brandSummary.available 为真时由父组件渲染（未配品牌不打扰，成片逐字节不变）。
 */
const props = defineProps<{
  modelValue: boolean
  /** 预检品牌摘要； 前的旧存 preflight JSON 或预检失败→ null（此时本组件不渲染） */
  summary: { available: boolean; watermark: boolean; intro: boolean; outro: boolean; subtitle: boolean } | null
  /** 方案已批准的背景乐段数（参考托盘音频 role:'bgm'）；>0 时给一行可发现性提示 */
  bgmCount?: number
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

// 将应用的叠加项摘要（据预检 brandSummary 实际命中槽位，不夸大）
const slots = computed(() => {
  const s = props.summary
  if (!s) return ''
  const parts: string[] = []
  if (s.watermark) parts.push('水印')
  if (s.intro) parts.push('片头')
  if (s.outro) parts.push('片尾')
  if (s.subtitle) parts.push('字幕样式')
  return parts.join(' · ')
})
</script>

<template>
  <div v-if="summary?.available" class="ec-brand">
    <label class="ec-brand-row">
      <input
        :checked="modelValue"
        type="checkbox"
        :aria-label="'应用品牌风格：' + slots"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      <span><Icon name="palette" :size="13" /> 应用品牌风格（{{ slots }}）</span>
    </label>
    <p class="ec-brand-hint">
      {{
        modelValue
          ? '成片将叠加平台/项目已配置的品牌元素；不改动方案、不影响计费。'
          : '已关闭：本次成片不含品牌水印 / 片头尾与自定义字幕样式（不影响方案确认与计费）。'
      }}
    </p>
    <p v-if="bgmCount" class="ec-brand-hint">背景音乐：{{ bgmCount }} 段（来自参考托盘音频，将混入成片）</p>
  </div>
</template>

<style scoped>
/* 与 .ec-gate / .ec-res 同族版式：主控件与说明分行，触控区 ≥44px，不靠颜色单独传达含义 */
.ec-brand {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
}

.ec-brand-row {
  font-size: 13px;
  color: var(--text);
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  line-height: 1.5;
}

.ec-brand-row span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.ec-brand-row .ic {
  color: var(--accent-h);
}

.ec-brand-row input {
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: var(--accent);
}

.ec-brand-hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.55;
}
</style>
