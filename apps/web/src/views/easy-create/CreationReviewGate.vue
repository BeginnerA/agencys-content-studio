<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'

/**
 * 确认卡「首帧后暂停审阅」勾选（独立轻组件：确认卡本体已近红线长度）。
 * 勾选 = 本次改用带闸门的同构变体模板（easy-video-review）；不勾选即免审（不声明 skip_label，行为与旧版逐字一致）。
 * 费用语义如实说明：闸门只推迟高费用生成，不减少任何计费。
 */
const props = defineProps<{ modelValue: boolean; dynamic: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

// 闸门的实际停靠点按镜头模式而异：动态模式审完首帧才开始算视频秒数的付费镜头；静态模式审完图文才配音与合成
const gateHint = () =>
  props.dynamic
    ? '确认前只生成图文画面与动态首帧；动态镜头等按秒计费的高费用生成在你确认之后才开始。'
    : '确认前只生成图文画面；配音与成片合成在你确认之后才执行。'
</script>

<template>
  <div class="ec-gate">
    <label class="ec-gate-row">
      <input
        :checked="modelValue"
        type="checkbox"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      <span><Icon name="eye" :size="13" /> 生成首帧后暂停，我确认画面后再继续（推荐用于重要成片）</span>
    </label>
    <p class="ec-gate-hint">{{ gateHint() }}</p>
  </div>
</template>

<style scoped>
/* 主控件与说明分行，触控区 ≥44px，不靠颜色单独传达含义 */
.ec-gate {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
}

.ec-gate-row {
  font-size: 13px;
  color: var(--text);
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  line-height: 1.5;
}

.ec-gate-row span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.ec-gate-row input {
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: var(--accent);
}

.ec-gate-hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.55;
}
</style>
