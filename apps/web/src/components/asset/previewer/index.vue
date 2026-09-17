<script setup lang="ts">
// 统一资产预览查看器：图片（缩放/平移）/ 视频 / 音频 / Markdown / JSON / 纯文本 / 未知兜底
// 设计：沉浸式弹窗（与 Modal 体例同源），多资产可切换（← →），操作统一收敛顶栏（复制/下载/新标签）
// ---- [M28] 已拆分：交互逻辑经 use-asset-previewer.ts 装配（行为零变更）----
import type { Asset } from '../../../lib/types'
import { fmtDur, fmtSize } from '../../../lib/format'
import Icon from '../../common/Icon.vue'
import MarkdownPreview from '../../common/MarkdownPreview.vue'
import { useAssetPreviewer } from './use-asset-previewer'

const props = defineProps<{ assets: Asset[]; index?: number }>()
const emit = defineEmits<{ close: []; changed: [asset: Asset] }>()

// ---- M28 装配：状态/操作经 composable；模板标识符解构直用 ----
const { MIN_SCALE, MAX_SCALE, idx, cur, hasPrev, hasNext, vkind, isTextLike, tooBig, TYPE_ICON, kindLabel, compliance, complianceLabel, complianceTip, metaLine, text, textLoading, textErr, jsonHtml, jsonBad, copied, copyText, scale, tx, ty, dragging, imgErr, stageEl, onImgLoad, resetImage, onWheel, zoomBy, toggleDouble, onPointerDown, onPointerMove, onPointerUp, checkBusy, checkMsg, doCheck, tagDraft, tagBusy, tagErr, curTags, addTag, removeTag, prev, next, downloadHref } = useAssetPreviewer(props, emit)
</script>

<template>
  <Teleport to="body">
    <div class="mask" @click.self="emit('close')">
      <div v-if="cur" class="viewer panel" role="dialog" aria-modal="true" :aria-label="`资产预览：${cur.name}`">
        <!-- 顶栏：身份 + 操作 -->
        <header class="head">
          <Icon :name="TYPE_ICON[vkind]" :size="15" class="type-ic" />
          <span class="nm" :title="cur.name">{{ cur.name }}</span>
          <span class="badge">{{ kindLabel }}</span>
          <!-- [M24] 合规审核徽章（params.compliance；悬停看命中数与时间） -->
          <span v-if="compliance" class="badge" :class="`comp-${compliance.status}`" :title="complianceTip">{{ complianceLabel }}</span>
          <span v-if="assets.length > 1" class="count mono">{{ idx + 1 }} / {{ assets.length }}</span>
          <div class="ops">
            <button
              v-if="cur.kind === 'image'"
              class="btn sm"
              :disabled="checkBusy"
              title="重新检测图片有效性（黑图 / 纯色空白 / 损坏；结果写入资产元数据）"
              @click="doCheck"
            >
              <Icon name="refresh" :size="12" /> {{ checkBusy ? '检测中…' : '重新检测' }}
            </button>
            <button
              v-if="isTextLike && !tooBig"
              class="btn sm"
              :disabled="textLoading || !!textErr || !text"
              @click="copyText"
            >
              <Icon :name="copied ? 'check' : 'copy'" :size="12" /> {{ copied ? '已复制' : '复制' }}
            </button>
            <a class="btn sm" :href="downloadHref(cur)" :download="cur.name">
              <Icon name="download" :size="12" /> 下载
            </a>
            <a class="btn sm" :href="cur.urls.file" target="_blank" rel="noopener" title="浏览器新标签打开原文">
              <Icon name="external" :size="12" /> 新标签
            </a>
            <button class="icon-btn" aria-label="关闭预览" @click="emit('close')">
              <Icon name="x" :size="15" :stroke-width="2" />
            </button>
          </div>
        </header>

        <!-- 舞台 -->
        <div class="stagewrap">
          <div ref="stageEl" class="stage" :class="`stage-${vkind}`">
            <!-- 图片：滚轮缩放 / 拖拽平移 / 双击复位 -->
            <template v-if="vkind === 'image'">
              <img
                v-if="!imgErr"
                :src="cur.urls.file"
                :alt="cur.name"
                class="imgbox"
                :class="{ grab: scale > 1, grabbing: dragging }"
                :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
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
                <a class="btn sm" :href="cur.urls.file" target="_blank" rel="noopener">新标签重试</a>
              </div>
              <div v-if="!imgErr" class="zoombar">
                <button class="icon-btn" aria-label="缩小" :disabled="scale <= MIN_SCALE" @click="zoomBy(1 / 1.25)">
                  <Icon name="zoom-out" :size="14" />
                </button>
                <span class="zval mono">{{ Math.round(scale * 100) }}%</span>
                <button class="icon-btn" aria-label="放大" :disabled="scale >= MAX_SCALE" @click="zoomBy(1.25)">
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
                <a class="btn primary" :href="downloadHref(cur)" :download="cur.name">下载查看</a>
              </div>
              <div v-else-if="textLoading" class="midwrap">
                <div class="spin" aria-hidden="true" />
                <div class="muted">加载中…</div>
              </div>
              <div v-else-if="textErr" class="midwrap">
                <div class="err-text">{{ textErr }}</div>
                <a class="btn sm" :href="cur.urls.file" target="_blank" rel="noopener">新标签打开</a>
              </div>
              <div v-else class="doc">
                <MarkdownPreview v-if="vkind === 'markdown'" :source="text" />
                <template v-else-if="vkind === 'json'">
                  <div v-if="jsonBad" class="jsonhint">JSON 解析失败，按原文展示</div>
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
                <a class="btn primary" :href="downloadHref(cur)" :download="cur.name">下载文件</a>
                <a class="btn" :href="cur.urls.file" target="_blank" rel="noopener">新标签打开</a>
              </div>
            </div>
          </div>

          <button v-if="hasPrev" class="nav prev" aria-label="上一个资产" @click="prev">
            <Icon name="chevron-left" :size="18" />
          </button>
          <button v-if="hasNext" class="nav next" aria-label="下一个资产" @click="next">
            <Icon name="chevron-right" :size="18" />
          </button>
        </div>

        <!-- 底栏：元信息 + 提示词快照 -->
        <footer class="foot">
          <div class="metaline mono">{{ metaLine }}</div>
          <div class="tagedit">
            <span class="tglb">标签</span>
            <span v-for="t in curTags" :key="t" class="tgchip">
              {{ t }}
              <button class="tgx" type="button" :disabled="tagBusy" :aria-label="`删除标签 ${t}`" @click="removeTag(t)">
                <Icon name="x" :size="10" :stroke-width="2.6" />
              </button>
            </span>
            <input
              v-model="tagDraft"
              type="text"
              class="tginput"
              placeholder="输入后回车添加"
              aria-label="新增标签"
              :disabled="tagBusy"
              @keydown.enter.prevent="addTag"
            />
            <span v-if="tagErr" class="err-text">{{ tagErr }}</span>
          </div>
          <div v-if="checkMsg" class="chk" :class="{ bad: checkMsg.startsWith('检测失败') }">{{ checkMsg }}</div>
          <details v-if="cur.prompt" class="prmt">
            <summary>提示词快照（可复制溯源）</summary>
            <pre class="prebox">{{ cur.prompt }}</pre>
          </details>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgb(3 6 14 / 72%);
  backdrop-filter: blur(5px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 120;
  animation: fade-in 0.15s ease-out;
}

.viewer {
  width: min(94vw, 1080px);
  height: min(92vh, 820px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: pop-in 0.18s ease-out;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
}

@keyframes pop-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.98);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mask,
  .viewer {
    animation: none;
  }
}

/* ---------- 顶栏 ---------- */
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  min-height: 48px;
  flex: none;
}

.type-ic {
  color: var(--accent-h);
}

.nm {
  font-weight: 600;
  font-size: 13.5px;
  max-width: 36%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  color: var(--text-3);
  font-size: 11.5px;
}

/* [M24] 合规徽章三态（配色对齐全局 badge 语义：ok/warn/bad） */
.comp-pass {
  background: var(--ok-weak);
  color: var(--ok);
}

.comp-warn {
  background: rgb(245 158 11 / 12%);
  color: #d97706;
}

.comp-block {
  background: var(--bad-weak);
  color: var(--bad);
}

.ops {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

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

.head .icon-btn:hover {
  color: var(--bad);
}

/* ---------- 舞台 ---------- */
.stagewrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

.stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background:
    radial-gradient(900px 420px at 50% -10%, rgb(139 92 246 / 5%), transparent 60%),
    var(--code-bg);
}

.stage.stage-markdown,
.stage.stage-json,
.stage.stage-text {
  overflow-y: auto;
  align-items: flex-start;
  padding: 18px 22px;
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

/* ---------- 资产切换 ---------- */
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  background: rgb(10 14 24 / 62%);
  backdrop-filter: blur(4px);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  z-index: 2;
}

.nav:hover {
  color: #fff;
  border-color: rgb(99 102 241 / 60%);
  background: var(--raised);
}

.nav.prev {
  left: 12px;
}

.nav.next {
  right: 12px;
}

/* ---------- 底栏 ---------- */
.foot {
  border-top: 1px solid var(--border);
  padding: 8px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
  max-height: 32%;
  overflow-y: auto;
}

.metaline {
  font-size: 11.5px;
  color: var(--text-3);
}

/* [M21] 标签编辑（回车添加 / chip × 删除；变更即存） */
.tagedit {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.tglb {
  color: var(--text-3);
  font-size: 11.5px;
}

.tgchip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11.5px;
  line-height: 18px;
  padding: 0 6px 0 9px;
  border-radius: 999px;
  background: var(--chip-bg);
  color: var(--text-2);
}

.tgx {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
}

.tgx:hover {
  color: var(--bad);
  background: var(--hover);
}

.tgx:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tginput {
  width: 150px;
  font-size: 11.5px;
  padding: 3px 8px;
}

/* [M12] 重检结果（成功绿 / 失败红） */
.chk {
  font-size: 11.5px;
  color: var(--ok);
}

.chk.bad {
  color: var(--bad);
}

.prmt summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 12px;
}

.prmt .prebox {
  margin-top: 6px;
  max-height: 140px;
  overflow-y: auto;
  font-size: 11.5px;
}
</style>
