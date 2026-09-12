<script setup lang="ts">
// 统一资产预览查看器：图片（缩放/平移）/ 视频 / 音频 / Markdown / JSON / 纯文本 / 未知兜底
// 设计：沉浸式弹窗（与 Modal 体例同源），多资产可切换（← →），操作统一收敛顶栏（复制/下载/新标签）
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { assetApi } from '../lib/api'
import type { Asset } from '../lib/types'
import { KIND_TEXT, fmtDur, fmtSize, fmtTime, parseAssetQuality, purposeText, qualityText } from '../lib/format'
import Icon from './Icon.vue'
import MarkdownPreview from './MarkdownPreview.vue'

const props = defineProps<{ assets: Asset[]; index?: number }>()
const emit = defineEmits<{ close: []; changed: [asset: Asset] }>()

const MAX_TEXT = 1.5 * 1024 * 1024 // 文本预览上限：超出只提供下载
const JSON_PARSE_MAX = 512 * 1024 // 超过不做格式化/着色，防卡顿
const MIN_SCALE = 1
const MAX_SCALE = 8

const idx = ref(Math.min(Math.max(props.index ?? 0, 0), Math.max(props.assets.length - 1, 0)))
const cur = computed<Asset | null>(() => props.assets[idx.value] ?? null)
const hasPrev = computed(() => idx.value > 0)
const hasNext = computed(() => idx.value < props.assets.length - 1)

// ===== 类型分派：ext 优先判文本子类型，其次按 kind =====
type ViewKind = 'image' | 'video' | 'audio' | 'markdown' | 'json' | 'text' | 'file'

function viewKindOf(a: Asset): ViewKind {
  const ext = (a.ext ?? '').toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'json') return 'json'
  if (['txt', 'yaml', 'yml', 'csv', 'log', 'ini', 'toml'].includes(ext)) return 'text'
  if (a.kind === 'image') return 'image'
  if (a.kind === 'video') return 'video'
  if (a.kind === 'audio') return 'audio'
  if (a.kind === 'text') return 'text'
  return 'file'
}

const vkind = computed<ViewKind>(() => (cur.value ? viewKindOf(cur.value) : 'file'))
const isTextLike = computed(() => ['markdown', 'json', 'text'].includes(vkind.value))
const tooBig = computed(() => (cur.value?.fileSize ?? 0) > MAX_TEXT)

const TYPE_ICON: Record<ViewKind, string> = {
  image: 'photo',
  video: 'video',
  audio: 'speaker-wave',
  markdown: 'doc',
  json: 'doc',
  text: 'doc',
  file: 'doc',
}

const kindLabel = computed(() => {
  const a = cur.value
  if (!a) return ''
  return KIND_TEXT[a.kind] ?? a.kind
})

const metaLine = computed(() => {
  const a = cur.value
  if (!a) return ''
  const parts: string[] = []
  if (a.purpose) parts.push(purposeText(a.purpose))
  if (a.ext) parts.push(a.ext.toUpperCase())
  parts.push(fmtSize(a.fileSize))
  // 尺寸优先取资产元数据；缺失时用图片实测值补显
  const dims = a.width && a.height
    ? `${a.width}×${a.height}`
    : naturalSize.value
      ? `${naturalSize.value.w}×${naturalSize.value.h}`
      : null
  if (dims) parts.push(dims)
  if (a.duration) parts.push(fmtDur(a.duration))
  parts.push(fmtTime(a.createdAt))
  return parts.join(' · ')
})

// ===== 文本类加载（md/json/txt/yaml/csv…） =====
const text = ref('')
const textLoading = ref(false)
const textErr = ref('')
const jsonHtml = ref('')
const jsonBad = ref(false)

async function loadText() {
  const a = cur.value
  if (!a || !isTextLike.value) return
  text.value = ''
  jsonHtml.value = ''
  jsonBad.value = false
  textErr.value = ''
  if ((a.fileSize ?? 0) > MAX_TEXT) return
  textLoading.value = true
  try {
    const res = await fetch(a.urls.file)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = await res.text()
    text.value = raw
    if (vkind.value === 'json') buildJsonHtml(raw)
  } catch (e) {
    textErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    textLoading.value = false
  }
}

function buildJsonHtml(raw: string) {
  if (raw.length > JSON_PARSE_MAX) {
    jsonHtml.value = escapeHtml(raw)
    return
  }
  try {
    jsonHtml.value = highlightJson(JSON.stringify(JSON.parse(raw), null, 2))
  } catch {
    jsonBad.value = true
    jsonHtml.value = escapeHtml(raw)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 轻量 JSON 着色：先转义后着色（键/字符串/数字/布尔/null 五类 token），不引额外依赖 */
function highlightJson(src: string): string {
  return escapeHtml(src).replace(
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m: string, str: string | undefined, colon: string | undefined) => {
      if (str !== undefined) {
        return colon ? `<span class="jk">${str}</span><span class="jp">${colon}</span>` : `<span class="js">${str}</span>`
      }
      if (m === 'true' || m === 'false') return `<span class="jb">${m}</span>`
      if (m === 'null') return `<span class="jn">${m}</span>`
      return `<span class="jnum">${m}</span>`
    },
  )
}

const copied = ref(false)
let copyTimer: number | undefined

async function copyText() {
  if (!text.value) return
  try {
    await navigator.clipboard.writeText(text.value)
    copied.value = true
    if (copyTimer) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copied.value = false), 2000)
  } catch {
    textErr.value = '复制失败，请手动选择文本复制'
  }
}

// ===== 图片缩放 / 平移（transform 以舞台中心为原点） =====
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const dragging = ref(false)
const imgErr = ref(false)
const naturalSize = ref<{ w: number; h: number } | null>(null)
const stageEl = ref<HTMLElement | null>(null)
let dragStart = { x: 0, y: 0, tx: 0, ty: 0 }

function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth && img.naturalHeight) naturalSize.value = { w: img.naturalWidth, h: img.naturalHeight }
}

function resetImage() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
  dragging.value = false
}

/** 以 (px,py)（相对舞台中心）为锚点缩放到 next */
function zoomAt(next: number, px = 0, py = 0) {
  const s0 = scale.value
  const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
  if (s1 === s0) return
  if (s1 === MIN_SCALE) {
    tx.value = 0
    ty.value = 0
  } else {
    const k = s1 / s0
    tx.value = px - (px - tx.value) * k
    ty.value = py - (py - ty.value) * k
  }
  scale.value = s1
}

function onWheel(e: WheelEvent) {
  const rect = stageEl.value?.getBoundingClientRect()
  if (!rect) return
  const px = e.clientX - rect.left - rect.width / 2
  const py = e.clientY - rect.top - rect.height / 2
  zoomAt(scale.value * (e.deltaY < 0 ? 1.18 : 1 / 1.18), px, py)
}

function zoomBy(f: number) {
  zoomAt(scale.value * f)
}

function toggleDouble() {
  if (scale.value > 1) resetImage()
  else zoomAt(2)
}

function onPointerDown(e: PointerEvent) {
  if (scale.value <= 1) return
  dragging.value = true
  dragStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  tx.value = dragStart.tx + (e.clientX - dragStart.x)
  ty.value = dragStart.ty + (e.clientY - dragStart.y)
}

function onPointerUp() {
  dragging.value = false
}

// ===== [M12] 图像有效性重检（写回 params.quality；结果同步宿主） =====
const checkBusy = ref(false)
const checkMsg = ref('')

async function doCheck() {
  const a = cur.value
  if (!a || a.kind !== 'image' || checkBusy.value) return
  checkBusy.value = true
  checkMsg.value = ''
  try {
    const r = await assetApi.check(a.id)
    checkMsg.value = `检测完成：${qualityText(parseAssetQuality(r.asset)?.reason)}`
    emit('changed', r.asset)
  } catch (e) {
    checkMsg.value = `检测失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    checkBusy.value = false
  }
}

// ===== 多资产切换 / 键盘 =====
function prev() {
  if (hasPrev.value) idx.value -= 1
}

function next() {
  if (hasNext.value) idx.value += 1
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
    return
  }
  if (e.key === 'ArrowLeft') prev()
  if (e.key === 'ArrowRight') next()
}

/** 下载链接（?download=1 触发附件，见 assets 路由契约） */
function downloadHref(a: Asset | null): string {
  if (!a) return '#'
  const u = a.urls.file
  return u + (u.includes('?') ? '&' : '?') + 'download=1'
}

watch(idx, () => {
  resetImage()
  imgErr.value = false
  naturalSize.value = null
  copied.value = false
  checkMsg.value = ''
  void loadText()
})

let prevOverflow = ''
onMounted(() => {
  window.addEventListener('keydown', onKey)
  prevOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  void loadText()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.body.style.overflow = prevOverflow
  if (copyTimer) window.clearTimeout(copyTimer)
})
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
