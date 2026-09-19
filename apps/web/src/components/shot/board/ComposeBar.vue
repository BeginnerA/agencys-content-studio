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
  <!-- [M11→redesign] 转场设置段：作为工作台控制条（.wb-strip）左段呈现；合成设置按钮已归入右侧工具簇 -->
  <div v-if="sb.compose" class="wb-grp">
    <span class="wb-lb"><Icon name="film" :size="12" /> 转场</span>
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
      class="wb-ab pri"
      :class="{ on: sb.cfgDirty }"
      :disabled="!sb.canOperate || sb.cfgBusy || !sb.cfgDirty"
      @click="saveTransition"
    >
      保存设置
    </button>
  </div>
</template>

<style scoped>
/* 转场段：与宿主 .wb-strip 弹性对齐（根元素同时受父级 scoped 样式约束） */
.wb-grp {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.wb-lb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

/* 与 board/index.vue 的 .wb-ab 同一套动作按钮视觉（scoped 各自持有，避免全局污染） */
.wb-ab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}

.wb-ab .ic {
  flex: none;
}

.wb-ab:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
}

.wb-ab:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.wb-ab:focus-visible {
  outline: 2px solid var(--accent-h);
  outline-offset: 1px;
}

.wb-ab.pri.on {
  background: var(--grad-brand);
  border-color: rgb(99 102 241 / 65%);
  color: #fff;
}

.wb-ab.pri.on:hover:not(:disabled) {
  filter: brightness(1.08);
  color: #fff;
  border-color: rgb(99 102 241 / 65%);
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
  background: var(--bg); /* 同宿主控制条 strip：比 --code-bg 更深一档保证输入框可辨 */
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
