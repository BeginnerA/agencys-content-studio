<script setup lang="ts">
/** [M23-D11] AI 编排建议面板（仅展示 + 定位；执行始终由用户手动发起）。 */
import Icon from '../../components/common/Icon.vue'
import Modal from '../../components/common/Modal.vue'
import type { CanvasAdviceKind } from '../../lib/types'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{
  cv: Pick<
    CanvasViewState,
    | 'showAdvice'
    | 'adviceBusy'
    | 'adviceError'
    | 'adviceResult'
    | 'openAdvice'
    | 'locateAdvice'
  >
}>()
const cv = props.cv

/** 建议类型 → 图标/文案（对齐服务端 canvas-advice.md 输出契约；raw = 降级原文） */
const KIND_ICON: Record<CanvasAdviceKind, string> = {
  structure: 'flow',
  connect: 'link',
  config: 'sliders',
  generate: 'sparkles',
  cleanup: 'trash',
  raw: 'doc',
}
const KIND_TEXT: Record<CanvasAdviceKind, string> = {
  structure: '结构',
  connect: '连线',
  config: '配置',
  generate: '生成',
  cleanup: '清理',
  raw: '建议',
}
</script>

<template>
  <Modal
    v-if="cv.showAdvice"
    title="AI 编排建议"
    :width="680"
    @close="cv.showAdvice = false"
  >
    <div v-if="cv.adviceBusy" class="ad-loading muted">
      <Icon name="sparkles" :size="14" />
      <span>正在分析画布（节点 / 连线 / 就绪状态）…</span>
    </div>
    <div v-else-if="cv.adviceError" class="ad-err">
      <Icon name="alert" :size="13" />
      <span>{{ cv.adviceError }}</span>
    </div>
    <template v-else-if="cv.adviceResult">
      <div class="muted mini ad-hint">
        建议由所选 LLM 供应商基于画布现状生成；仅供人工采纳，不会自动改动画布。
      </div>
      <div v-if="!cv.adviceResult.advice.length" class="muted ad-empty">
        暂无建议（画布状态良好，或模型未给出可执行项）。
      </div>
      <ol v-else class="ad-list">
        <li v-for="(a, i) in cv.adviceResult.advice" :key="i" class="ad-item">
          <span class="ad-kind" :class="a.kind">
            <Icon :name="KIND_ICON[a.kind] ?? 'doc'" :size="11" />
            {{ KIND_TEXT[a.kind] ?? a.kind }}
          </span>
          <div class="ad-main">
            <div class="ad-title">{{ a.title }}</div>
            <div class="ad-detail">{{ a.detail }}</div>
          </div>
          <button
            v-if="a.targetNodeId"
            type="button"
            class="btn sm"
            title="关闭面板并定位到该节点"
            @click="cv.locateAdvice(a.targetNodeId)"
          >
            <Icon name="eye" :size="11" /> 定位
          </button>
        </li>
      </ol>
    </template>
    <template #footer>
      <span v-if="cv.adviceResult" class="ad-usage muted">
        {{ cv.adviceResult.provider }}/{{ cv.adviceResult.model }}
        <template v-if="cv.adviceResult.usage">
          · 用量 {{ cv.adviceResult.usage.tokensIn }}↑
          {{ cv.adviceResult.usage.tokensOut }}↓
        </template>
        · {{ cv.adviceResult.mode === 'raw' ? '降级原文' : '结构化' }}
      </span>
      <button type="button" class="btn" @click="cv.showAdvice = false">
        关闭
      </button>
      <button
        type="button"
        class="btn primary"
        :disabled="cv.adviceBusy"
        @click="cv.openAdvice"
      >
        <Icon name="refresh" :size="12" /> 重新生成
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.mini {
  font-size: 11px;
}

.ad-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 22px 0;
}

.ad-err {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--bad);
  font-size: 12.5px;
  padding: 8px 0;
  word-break: break-all;
}

.ad-hint {
  margin-bottom: 8px;
}

.ad-empty {
  padding: 16px 0;
  text-align: center;
}

.ad-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ad-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  background: var(--panel-2, var(--panel));
}

.ad-kind {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  margin-top: 1px;
}

.ad-kind.generate {
  color: var(--accent);
  border-color: rgb(129 140 248 / 45%);
}

.ad-kind.connect {
  color: var(--ok);
  border-color: rgb(34 197 94 / 40%);
}

.ad-kind.cleanup {
  color: var(--warn);
  border-color: rgb(251 191 36 / 45%);
}

.ad-main {
  flex: 1;
  min-width: 0;
}

.ad-title {
  font-size: 12.5px;
  font-weight: 600;
}

.ad-detail {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.65;
  margin-top: 2px;
  word-break: break-word;
}

.ad-usage {
  margin-right: auto;
  font-size: 11px;
}
</style>
