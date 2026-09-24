<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'

/**
 * 确认卡「清晰度」选择（独立轻组件：确认卡本体已近红线长度，同 CreationReviewGate 先例）。
 * 仅透出服务端预检已背书档位（preflight.resolutionOptions.choices）；不选 = 模型默认档（confirm 不传键，
 * 请求体与旧版逐字一致）。改档不触发重新规划（画质不入 planHash——成立前提是价格表无档位维度）。
 * 文案红线：不承诺「更高画质不加价」——视频按秒计价，实际计费以供应商对所选档为准。
 */
defineProps<{ modelValue: string; options: { choices: string[]; default: string } }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()
</script>

<template>
  <div class="ec-res">
    <label class="ec-res-row">
      <span class="ec-res-lbl"><Icon name="film" :size="13" /> 清晰度</span>
      <select
        class="ec-res-select"
        :value="modelValue"
        :aria-label="'视频清晰度档位，当前' + (modelValue || '模型默认')"
        @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">模型默认（{{ options.default }}）</option>
        <option v-for="c in options.choices" :key="c" :value="c">
          {{ c }}{{ c === options.default ? '（模型默认）' : '' }}
        </option>
      </select>
    </label>
    <p class="ec-res-hint">仅可选当前视频模型已核实的档位；视频按秒计价，实际计费以供应商对所选档位的定价为准。</p>
  </div>
</template>

<style scoped>
/* 与 .ec-gate 同族版式：主控件与说明分行，触控区 ≥44px */
.ec-res {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
}

.ec-res-row {
  font-size: 13px;
  color: var(--text);
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  line-height: 1.5;
}

.ec-res-lbl {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  font-weight: 600;
}

.ec-res-lbl .ic {
  color: var(--accent-h);
}

.ec-res-select {
  flex: none;
  width: auto; /* 覆盖全局 select{width:100%} */
  font-size: 12.5px;
  padding: 6px 8px;
  border-radius: 7px;
  background: var(--raised);
  border: 1px solid var(--border-strong);
  color: var(--text);
  min-height: 44px;
}

.ec-res-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.ec-res-hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.55;
}
</style>
