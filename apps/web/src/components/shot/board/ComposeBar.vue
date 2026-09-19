<script setup lang="ts">
import Icon from '../../common/Icon.vue'
import { TRANSITIONS } from './internals'
import type { ShotBoardApi, ShotBoardState } from './use-shot-board'

const props = defineProps<{
  sb: ShotBoardState
  saveTransition: ShotBoardApi['saveTransition']
}>()
const sb = props.sb
</script>

<template>
  <div v-if="sb.compose" class="wb-sb.compose">
    <Icon name="film" :size="12" />
    <span class="muted">转场</span>
    <select
      v-model="sb.cfgTransition"
      class="wb-sel"
      :disabled="!sb.canOperate || sb.cfgBusy"
    >
      <option v-for="t in TRANSITIONS" :key="t.value" :value="t.value">
        {{ t.label }}
      </option>
    </select>
    <input
      v-model.number="sb.cfgDur"
      type="number"
      class="wb-num"
      min="0.1"
      max="2"
      step="0.1"
      :disabled="!sb.canOperate || sb.cfgBusy || sb.cfgTransition === 'none'"
      :title="
        sb.cfgTransition === 'none'
          ? '当前为硬切，无需转场时长'
          : '转场时长（0.1–2 秒）'
      "
    />
    <span class="muted">s</span>
    <button
      class="btn sm"
      :class="{ primary: sb.cfgDirty }"
      :disabled="!sb.canOperate || sb.cfgBusy || !sb.cfgDirty"
      @click="saveTransition"
    >
      保存设置
    </button>
    <button
      class="btn sm push"
      :disabled="!sb.canOperate"
      :title="
        sb.bgm
          ? `合成设置（当前配乐：${sb.bgm.name}）`
          : '合成设置：配乐 / 音效 / 字幕样式 / 水印与片头尾 / 多画幅'
      "
      @click="sb.composeSettingsOpen = true"
    >
      <Icon name="sliders" :size="12" /> 合成设置
    </button>
  </div>
</template>

<style scoped>
/* [M11] 合成设置行（转场 / 配乐） */
.wb-compose {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}

.wb-compose .push {
  margin-left: auto;
}

.wb-sel {
  /* 覆盖全局 select{width:100%}：转场下拉按内容宽收缩，避免独占整行挤出配乐按钮（M11 实弹修复） */
  width: auto;
  max-width: 132px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 7px;
  color: inherit;
  font-size: 12px;
  padding: 2px 6px;
  outline: none;
}

.wb-num {
  width: 64px;
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
  font-family: inherit;
}

.wb-num:disabled {
  opacity: 0.5;
}
</style>
