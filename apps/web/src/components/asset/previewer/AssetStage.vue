<script setup lang="ts">
/**
 * 资产预览器 · 舞台分支（自 previewer/index.vue 原样搬出，行为零变更）：
 * 图片（缩放/平移/复位）/ 视频 / 音频 / 文本类（markdown/json/纯文本 + 编辑态）/ 兜底。
 * 状态真源仍在父级 use-asset-previewer composable：数据经 props 直传，
 * draft / imgErr 经 defineModel 双向；交互函数经函数 props 直传（stageEl 量测仍指父级 .stage）。
 */
import type { Asset } from '../../../lib/types'
import { fmtDur, fmtSize } from '../../../lib/format'
import Icon from '../../common/Icon.vue'
import MarkdownPreview from '../../common/MarkdownPreview.vue'

defineProps<{
  cur: Asset
  vkind: string
  isTextLike: boolean
  tooBig: boolean
  editing: boolean
  editSaving: boolean
  text: string
  textLoading: boolean
  textErr: string
  jsonHtml: string
  jsonBad: boolean
  scale: number
  tx: number
  ty: number
  dragging: boolean
  MIN_SCALE: number
  MAX_SCALE: number
  downloadHref: (a: Asset) => string
  onImgLoad: (e: Event) => void
  onWheel: (e: WheelEvent) => void
  onPointerDown: (e: PointerEvent) => void
  onPointerMove: (e: PointerEvent) => void
  onPointerUp: () => void
  zoomBy: (f: number) => void
  toggleDouble: () => void
  resetImage: () => void
}>()

/** 编辑草稿：真源在 composable 的 draft ref */
const draft = defineModel<string>('draft', { required: true })
/** 图片加载失败标记：@error 置位复位逻辑与母本一致 */
const imgErr = defineModel<boolean>('imgErr', { required: true })
</script>

<template>
  <!-- 图片：滚轮缩放 / 拖拽平移 / 双击复位 -->
  <template v-if="vkind === 'image'">
    <img
      v-if="!imgErr"
      :src="cur.urls.file"
      :alt="cur.name"
      class="imgbox"
      :class="{ grab: scale > 1, grabbing: dragging }"
      :style="{
        transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
      }"
      draggable="false"
      @error="imgErr = true"
      @load="onImgLoad"
      @dblclick="toggleDouble"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    />
    <div v-else class="midwrap">
      <Icon name="photo" :size="38" class="big-ic" />
      <div>图片加载失败</div>
      <a
        class="btn sm"
        :href="cur.urls.file"
        target="_blank"
        rel="noopener"
        >新标签重试</a
      >
    </div>
    <div v-if="!imgErr" class="zoombar">
      <button
        class="icon-btn"
        aria-label="缩小"
        :disabled="scale <= MIN_SCALE"
        @click="zoomBy(1 / 1.25)"
      >
        <Icon name="zoom-out" :size="14" />
      </button>
      <span class="zval mono">{{ Math.round(scale * 100) }}%</span>
      <button
        class="icon-btn"
        aria-label="放大"
        :disabled="scale >= MAX_SCALE"
        @click="zoomBy(1.25)"
      >
        <Icon name="zoom-in" :size="14" />
      </button>
      <button
        class="icon-btn"
        aria-label="复位缩放"
        :disabled="scale === 1 && tx === 0 && ty === 0"
        @click="resetImage"
      >
        <Icon name="arrow-path" :size="14" />
      </button>
    </div>
  </template>

  <!-- 视频 -->
  <video
    v-else-if="vkind === 'video'"
    :key="cur.id"
    class="vid"
    :src="cur.urls.file"
    controls
    playsinline
    preload="metadata"
  />

  <!-- 音频 -->
  <div v-else-if="vkind === 'audio'" class="midwrap">
    <Icon name="speaker-wave" :size="42" class="big-ic" />
    <div class="fname">{{ cur.name }}</div>
    <div class="muted mono">{{ fmtDur(cur.duration) }}</div>
    <audio :src="cur.urls.file" controls class="audio" />
  </div>

  <!-- 文本类：markdown / json / 纯文本 -->
  <template v-else-if="isTextLike">
    <div v-if="tooBig" class="midwrap">
      <Icon name="doc" :size="38" class="big-ic" />
      <div>文件较大（{{ fmtSize(cur.fileSize) }}），不内联预览</div>
      <a
        class="btn primary"
        :href="downloadHref(cur)"
        :download="cur.name"
        >下载查看</a
      >
    </div>
    <div v-else-if="textLoading" class="midwrap">
      <div class="spin" aria-hidden="true" />
      <div class="muted">加载中…</div>
    </div>
    <div v-else-if="textErr" class="midwrap">
      <div class="err-text">{{ textErr }}</div>
      <a
        class="btn sm"
        :href="cur.urls.file"
        target="_blank"
        rel="noopener"
        >新标签打开</a
      >
    </div>
    <!-- 编辑态：textarea + markdown 分栏实时预览（对齐 GateDialog 编辑器先例） -->
    <div
      v-else-if="editing"
      class="editwrap"
      :class="{ split: vkind === 'markdown' }"
    >
      <textarea
        v-model="draft"
        class="editbox mono"
        spellcheck="false"
        aria-label="编辑资产内容"
        :disabled="editSaving"
      />
      <div v-if="vkind === 'markdown'" class="editprev doc">
        <MarkdownPreview :source="draft" />
      </div>
    </div>
    <div v-else class="doc">
      <MarkdownPreview v-if="vkind === 'markdown'" :source="text" />
      <template v-else-if="vkind === 'json'">
        <div v-if="jsonBad" class="jsonhint">
          JSON 解析失败，按原文展示
        </div>
        <pre class="prebox json" v-html="jsonHtml" />
      </template>
      <pre v-else class="prebox">{{ text }}</pre>
    </div>
  </template>

  <!-- 兜底：暂不支持内联预览的格式 -->
  <div v-else class="midwrap">
    <Icon name="doc" :size="38" class="big-ic" />
    <div class="fname">{{ cur.name }}</div>
    <div class="muted">该格式暂不支持内联预览</div>
    <div class="fbtns">
      <a
        class="btn primary"
        :href="downloadHref(cur)"
        :download="cur.name"
        >下载文件</a
      >
      <a
        class="btn"
        :href="cur.urls.file"
        target="_blank"
        rel="noopener"
        >新标签打开</a
      >
    </div>
  </div>
</template>

<style scoped>
/* 缩放条按钮沿用（基式自父级逐字副本；.head .icon-btn:hover 不属本组件语境，不带入） */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  transition: all 0.15s;
  flex: none;
}

.icon-btn:hover {
  color: #fff;
  background: var(--hover);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  background: none;
}

.imgbox {
  max-width: 100%;
  max-height: 100%;
  user-select: none;
  touch-action: none;
  transform-origin: center;
  will-change: transform;
}

.imgbox.grab {
  cursor: grab;
}

.imgbox.grabbing {
  cursor: grabbing;
}

.vid {
  max-width: 100%;
  max-height: 100%;
  border-radius: 6px;
  background: #000;
}

.midwrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-2);
  text-align: center;
  padding: 24px;
}

.big-ic {
  color: var(--text-3);
}

.fname {
  font-size: 13px;
  color: var(--text);
  word-break: break-all;
  max-width: min(560px, 80%);
}

.audio {
  width: min(420px, 70%);
  margin-top: 6px;
}

.fbtns {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.spin {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------- 文本容器 ---------- */
.doc {
  width: min(880px, 100%);
  margin: 0 auto;
}

.prebox {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 12px;
  line-height: 1.65;
  color: #c7d3e6;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.jsonhint {
  font-size: 12px;
  color: var(--warn);
  margin-bottom: 8px;
}

/* JSON 着色（v-html 内容需 :deep 穿透） */
.json :deep(.jk) {
  color: var(--run);
}

.json :deep(.js) {
  color: var(--ok);
}

.json :deep(.jnum) {
  color: var(--warn);
}

.json :deep(.jb) {
  color: var(--accent-h);
}

.json :deep(.jn) {
  color: var(--text-3);
  font-style: italic;
}

.json :deep(.jp) {
  color: var(--text-3);
}

/* ---------- 图片缩放条 ---------- */
.zoombar {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 2px;
  background: rgb(10 14 24 / 68%);
  border: 1px solid var(--border);
  backdrop-filter: blur(4px);
  border-radius: 999px;
  padding: 3px 6px;
  z-index: 2;
}

.zval {
  font-size: 11px;
  color: var(--text-2);
  min-width: 42px;
  text-align: center;
}

/* G2 编辑态：单栏 textarea；markdown 双栏（左编辑右预览） */
.editwrap {
  width: min(980px, 100%);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.editwrap.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: start;
}

.editbox {
  width: 100%;
  min-height: 340px;
  background: var(--code-bg);
  color: #c7d3e6;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 12.5px;
  line-height: 1.7;
  resize: vertical;
}

.editbox:focus {
  outline: none;
  border-color: rgb(99 102 241 / 60%);
}

.editprev {
  overflow-y: auto;
  max-height: 62vh;
  margin: 0;
}
</style>
