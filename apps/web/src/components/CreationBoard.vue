<script setup lang="ts">
/**
 * [M16] 创作画布渲染层（手绘零依赖；spec §2.5）
 * - 世界层 translate(pan) scale(zoom)；边 = SVG 三次贝塞尔；节点 = 绝对定位卡片（宽 220）
 * - 模式机：pan（空白拖）/ 节点拖拽（卡片 pointerdown，本地即时 + 抬起 emit 落库）/ 连线（输出口 → 目标输入口）
 * - 落点：空白双击建生成节点；drop 文件由父级上传后建素材节点（本组件只报世界坐标与文件）
 * - 视口：useBoardViewport（初始 = 画布持久化；settled 后 emit，父级防抖 PATCH）
 */
import { computed, ref } from 'vue'
import { useBoardViewport, type ContentBounds } from '../lib/board-viewport'
import type { CanvasDocEdge, CanvasDocNode, CanvasViewport } from '../lib/types'
import { fmtMs } from '../lib/format'
import Icon from './Icon.vue'

const props = defineProps<{
  nodes: CanvasDocNode[]
  edges: CanvasDocEdge[]
  selectedId: number | null
  selectedEdgeId: number | null
  initialViewport: CanvasViewport | null
}>()
const emit = defineEmits<{
  select: [id: number | null]
  selectEdge: [id: number | null]
  'node-moved': [p: { id: number; x: number; y: number }]
  connect: [p: { from: number; to: number; port: string }]
  'create-node': [p: { x: number; y: number }]
  'drop-files': [p: { files: File[]; x: number; y: number }]
  'drop-asset': [p: { assetId: number; x: number; y: number }]
  'viewport-settled': [v: CanvasViewport]
}>()

// ---- 常量（spec：节点卡宽 220）----
const NODE_W = 220
const DEFAULT_H = 140
const PAD = 70
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// ---- 视口 ----
const vp = useBoardViewport({
  initial: props.initialViewport,
  onSettled: (v) => emit('viewport-settled', v),
})
const { viewportEl, pan, zoom, onWheel } = vp

// ---- 数据索引与位置 ----
const nodeById = computed(() => new Map(props.nodes.map((n) => [n.id, n])))

/** 拖拽中的本地即时位置（优先于渲染）；抬起 emit 后由父级乐观更新替换 */
const dragPos = ref<{ id: number; x: number; y: number } | null>(null)
function nodeXY(n: CanvasDocNode): { x: number; y: number } {
  if (dragPos.value && dragPos.value.id === n.id) return { x: dragPos.value.x, y: dragPos.value.y }
  return { x: n.x, y: n.y }
}
function nodeStyle(n: CanvasDocNode): Record<string, string> {
  const p = nodeXY(n)
  const h = nodeHeights.value[n.id]
  return { left: `${p.x}px`, top: `${p.y}px`, width: `${NODE_W}px`, ...(h ? {} : { minHeight: `${DEFAULT_H}px` }) }
}

/** 节点实测高度（边锚点 / 包围盒；ResizeObserver 式 ref 回调，值同则不动避免循环） */
const nodeHeights = ref<Record<number, number>>({})
function setNodeEl(id: number, el: unknown): void {
  const h = (el as HTMLElement | null)?.offsetHeight
  if (h && nodeHeights.value[id] !== h) nodeHeights.value = { ...nodeHeights.value, [id]: h }
}
function nodeH(n: CanvasDocNode): number {
  return nodeHeights.value[n.id] ?? DEFAULT_H
}

// ---- 边路径（锚点：源右中 → 目标左中）----
interface EdgePath {
  id: number
  d: string
  port: string
  sel: boolean
}
function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(48, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}
const edgePaths = computed<EdgePath[]>(() => {
  const out: EdgePath[] = []
  for (const e of props.edges) {
    const a = nodeById.value.get(e.from)
    const b = nodeById.value.get(e.to)
    if (!a || !b) continue
    const pa = nodeXY(a)
    const pb = nodeXY(b)
    out.push({
      id: e.id,
      d: bezier(pa.x + NODE_W, pa.y + nodeH(a) / 2, pb.x, pb.y + nodeH(b) / 2),
      port: e.port,
      sel: e.id === props.selectedEdgeId,
    })
  }
  return out
})

// ---- 连线中（临时贝塞尔跟随光标；世界坐标）----
const linkFrom = ref<number | null>(null)
const linkCur = ref<{ x: number; y: number } | null>(null)
/** hover 的输入端口（`nodeId:port`） */
const hotPort = ref<string | null>(null)
const linkPath = computed<string | null>(() => {
  if (linkFrom.value == null || !linkCur.value) return null
  const n = nodeById.value.get(linkFrom.value)
  if (!n) return null
  const p = nodeXY(n)
  return bezier(p.x + NODE_W, p.y + nodeH(n) / 2, linkCur.value.x, linkCur.value.y)
})

// ---- 模式机（pointer 统一在视口捕获：pan / node / link）----
type Mode = 'idle' | 'pan' | 'node' | 'link'
let mode: Mode = 'idle'
let panMoved = false
let nodeMoved = false
let dragId: number | null = null
let dragFrom = { cx: 0, cy: 0, ox: 0, oy: 0 }

function onViewportPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0 && ev.button !== 1) return
  mode = 'pan'
  panMoved = false
  vp.beginPan(ev)
  ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
}

function onNodePointerDown(ev: PointerEvent, n: CanvasDocNode): void {
  if (ev.button !== 0) return
  ev.stopPropagation()
  mode = 'node'
  nodeMoved = false
  dragId = n.id
  const p = nodeXY(n)
  dragFrom = { cx: ev.clientX, cy: ev.clientY, ox: p.x, oy: p.y }
  viewportEl.value?.setPointerCapture(ev.pointerId)
}

function onOutPortPointerDown(ev: PointerEvent, n: CanvasDocNode): void {
  if (ev.button !== 0) return
  ev.stopPropagation()
  mode = 'link'
  linkFrom.value = n.id
  linkCur.value = vp.screenToWorld(ev.clientX, ev.clientY)
  hotPort.value = null
  viewportEl.value?.setPointerCapture(ev.pointerId)
}

function onViewportPointerMove(ev: PointerEvent): void {
  if (mode === 'pan') {
    if (vp.movePan(ev)) panMoved = true
  } else if (mode === 'node' && dragId != null) {
    const dx = ev.clientX - dragFrom.cx
    const dy = ev.clientY - dragFrom.cy
    if (!nodeMoved && Math.abs(dx) + Math.abs(dy) < 4) return
    nodeMoved = true
    dragPos.value = {
      id: dragId,
      x: dragFrom.ox + dx / zoom.value,
      y: dragFrom.oy + dy / zoom.value,
    }
  } else if (mode === 'link') {
    linkCur.value = vp.screenToWorld(ev.clientX, ev.clientY)
    const t = (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-in-port]') as HTMLElement | null) ?? null
    hotPort.value = t ? `${t.dataset.nodeId}:${t.dataset.port}` : null
  }
}

function onViewportPointerUp(ev: PointerEvent): void {
  const el = ev.currentTarget as HTMLElement
  if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
  if (mode === 'link') {
    const t = (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-in-port]') as HTMLElement | null) ?? null
    const from = linkFrom.value
    if (t && from != null) {
      const to = Number(t.dataset.nodeId)
      const port = t.dataset.port ?? ''
      if (Number.isInteger(to) && to !== from && port) emit('connect', { from, to, port })
    }
    linkFrom.value = null
    linkCur.value = null
    hotPort.value = null
  } else if (mode === 'node') {
    if (nodeMoved && dragPos.value) {
      emit('node-moved', { ...dragPos.value })
      emit('select', dragPos.value.id)
    } else if (dragId != null) {
      emit('select', dragId)
    }
    dragPos.value = null
    dragId = null
  } else if (mode === 'pan') {
    if (!panMoved) {
      emit('select', null)
      emit('selectEdge', null)
    }
  }
  mode = 'idle'
}

// ---- 双击空白建生成节点 / drop 文件 ----
function onDblClick(ev: MouseEvent): void {
  const p = vp.screenToWorld(ev.clientX, ev.clientY)
  emit('create-node', { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - 60) })
}
function onDragOver(ev: DragEvent): void {
  ev.preventDefault()
}
function onDrop(ev: DragEvent): void {
  ev.preventDefault()
  const p = vp.screenToWorld(ev.clientX, ev.clientY)
  const x = Math.round(p.x - NODE_W / 2)
  const y = Math.round(p.y - 60)
  // 素材面板拖入（assetId）优先；否则按本地文件处理（由父级上传后建节点）
  const assetRaw = ev.dataTransfer?.getData('text/acs-asset-id')
  if (assetRaw) {
    const assetId = Number(assetRaw)
    if (Number.isInteger(assetId) && assetId > 0) emit('drop-asset', { assetId, x, y })
    return
  }
  const files = Array.from(ev.dataTransfer?.files ?? [])
  if (!files.length) return
  emit('drop-files', { files, x, y })
}

// ---- fit / 暴露 ----
function contentBounds(): ContentBounds | null {
  if (!props.nodes.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of props.nodes) {
    const p = nodeXY(n)
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + NODE_W)
    maxY = Math.max(maxY, p.y + nodeH(n))
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
function fitView(): void {
  vp.fit(contentBounds())
}
/** 视口中心的世界坐标（拖入素材的「视口中心」落点） */
function centerWorld(): { x: number; y: number } {
  const el = viewportEl.value
  if (!el) return { x: 200, y: 160 }
  const rect = el.getBoundingClientRect()
  const p = vp.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - 60) }
}
defineExpose({ fit: fitView, centerWorld })

// ---- 世界层 SVG 画布盒（覆盖节点 + 留白；viewBox 用世界坐标直通）----
const svgBox = computed(() => {
  let minX = 0
  let minY = 0
  let maxX = 900
  let maxY = 640
  for (const n of props.nodes) {
    const p = nodeXY(n)
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + NODE_W)
    maxY = Math.max(maxY, p.y + nodeH(n))
  }
  return { x: minX - PAD, y: minY - PAD, w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 }
})

// ---- 节点卡辅助 ----
const PORT_TEXT: Record<string, string> = {
  reference: '参考图',
  first_frame: '首帧',
  last_frame: '尾帧',
  source: '源图（编辑底图）',
}
const TASK_CLS: Record<string, string> = {
  pending: 'pending',
  processing: 'processing',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
}
const TASK_TEXT: Record<string, string> = {
  pending: '等待',
  processing: '生成中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}
function stText(n: CanvasDocNode): string {
  return n.status && n.status !== 'idle' ? (TASK_TEXT[n.status] ?? n.status) : ''
}
function stCls(n: CanvasDocNode): string {
  return n.status ? (TASK_CLS[n.status] ?? 'pending') : ''
}
function cardCls(n: CanvasDocNode): Record<string, boolean> {
  return {
    asset: n.kind === 'asset',
    gen: n.kind === 'gen',
    sel: n.id === props.selectedId,
    busy: n.status === 'processing' || n.status === 'pending',
    bad: n.status === 'failed',
    ok: n.status === 'succeeded',
  }
}
function inputPortsOf(n: CanvasDocNode): string[] {
  if (n.kind !== 'gen' || !n.spec) return []
  const ports: string[] = ['reference']
  if (n.spec.genKind === 'video') ports.push('first_frame', 'last_frame')
  if (n.spec.edit) ports.push('source')
  return ports
}
function genIcon(n: CanvasDocNode): string {
  if (!n.spec) return 'alert'
  if (n.spec.edit) return 'brush'
  return n.spec.genKind === 'video' ? 'video' : 'photo'
}
function thumbOf(n: CanvasDocNode): string | null {
  const a = n.asset
  if (!a || a.kind !== 'image') return null
  return a.urls.thumb ?? a.urls.file
}
function metaText(n: CanvasDocNode): string {
  const t = n.latestTask
  if (!t) return ''
  if (t.status === 'succeeded' && t.completedAt) return fmtMs(t.completedAt - t.createdAt)
  if (t.status === 'failed' && t.attempts > 1) return `尝试 ${t.attempts}`
  return ''
}
</script>

<template>
  <div
    ref="viewportEl"
    class="cb-viewport"
    :class="{ linking: linkFrom != null }"
    tabindex="0"
    aria-label="创作画布（拖动平移 / 滚轮缩放 / 双击空白建节点 / 拖入素材）"
    @pointerdown="onViewportPointerDown"
    @pointermove="onViewportPointerMove"
    @pointerup="onViewportPointerUp"
    @pointercancel="onViewportPointerUp"
    @wheel="onWheel"
    @dblclick="onDblClick"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <div
      class="cb-world"
      :style="{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }"
    >
      <svg
        class="cb-edges"
        :width="svgBox.w"
        :height="svgBox.h"
        :viewBox="`${svgBox.x} ${svgBox.y} ${svgBox.w} ${svgBox.h}`"
        :style="{ left: `${svgBox.x}px`, top: `${svgBox.y}px` }"
      >
        <defs>
          <marker
            id="cb-arrow"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(148 163 184 / 60%)" />
          </marker>
          <marker
            id="cb-arrow-sel"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent-h)" />
          </marker>
        </defs>
        <g v-for="e in edgePaths" :key="e.id">
          <path :d="e.d" class="cb-edge-hit" @pointerdown.stop="emit('selectEdge', e.id)" />
          <path
            :d="e.d"
            class="cb-edge"
            :class="{ sel: e.sel }"
            :port="e.port"
            :marker-end="e.sel ? 'url(#cb-arrow-sel)' : 'url(#cb-arrow)'"
          />
        </g>
        <path v-if="linkPath" :d="linkPath" class="cb-edge tmp" />
      </svg>

      <div
        v-for="n in nodes"
        :key="n.id"
        :ref="(el) => setNodeEl(n.id, el)"
        class="cnode"
        :class="cardCls(n)"
        :style="nodeStyle(n)"
        :title="n.title"
        @pointerdown="onNodePointerDown($event, n)"
        @dblclick.stop
      >
        <span
          v-for="(p, i) in inputPortsOf(n)"
          :key="p"
          class="port in"
          :class="{ hot: hotPort === `${n.id}:${p}` }"
          :data-in-port="p"
          :data-node-id="n.id"
          :data-port="p"
          :style="{ top: `${46 + i * 22}px` }"
          :title="`输入：${PORT_TEXT[p] ?? p}`"
          @pointerdown.stop
          @dblclick.stop
        />
        <span
          class="port out"
          :title="'拖拽到目标节点的输入端口以连线'"
          @pointerdown="onOutPortPointerDown($event, n)"
          @dblclick.stop
        />

        <template v-if="n.kind === 'asset'">
          <div class="cn-media">
            <img v-if="thumbOf(n)" :src="thumbOf(n)!" draggable="false" alt="" loading="lazy" />
            <span v-else class="cn-ph">
              <Icon :name="n.asset?.kind === 'video' ? 'video' : 'photo'" :size="20" />
              <em>{{ n.asset ? n.asset.name : '资产缺失' }}</em>
            </span>
          </div>
          <div class="cn-foot">
            <Icon name="photo" :size="11" />
            <span class="cn-title">{{ n.title }}</span>
          </div>
        </template>

        <template v-else>
          <div class="cn-head">
            <Icon :name="genIcon(n)" :size="13" />
            <span class="cn-title">{{ n.title }}</span>
            <span v-if="stText(n)" class="badge" :class="stCls(n)">{{ stText(n) }}</span>
          </div>
          <div class="cn-prompt" :title="n.spec?.prompt ?? ''">
            {{ n.spec ? n.spec.prompt || '（空 prompt）' : n.specError ?? 'spec 缺失' }}
          </div>
          <div v-if="thumbOf(n)" class="cn-media">
            <img :src="thumbOf(n)!" draggable="false" alt="" loading="lazy" />
          </div>
          <div v-if="n.readiness && !n.readiness.ready" class="cn-warn" :title="n.readiness.problems.join('；')">
            <Icon name="alert" :size="11" /> {{ n.readiness.problems.length }} 项未就绪
          </div>
          <div v-else-if="metaText(n)" class="cn-meta mono">{{ metaText(n) }}</div>
          <div v-if="n.latestTask?.errorMsg" class="cn-err" :title="n.latestTask.errorMsg">
            {{ n.latestTask.errorMsg }}
          </div>
        </template>
      </div>
    </div>

    <!-- 缩放控制（右下角；不拦截视口手势） -->
    <div class="cb-zoombar" @pointerdown.stop @dblclick.stop>
      <button type="button" class="zb" title="缩小" @click="vp.zoomBy(1 / 1.25)">
        <Icon name="zoom-out" :size="13" />
      </button>
      <button type="button" class="pct" title="适应视图" @click="fitView">{{ Math.round(zoom * 100) }}%</button>
      <button type="button" class="zb" title="放大" @click="vp.zoomBy(1.25)">
        <Icon name="zoom-in" :size="13" />
      </button>
      <button type="button" class="zb zb-fit" title="适应视图" @click="fitView">适应</button>
    </div>

    <div class="cb-hint" aria-hidden="true">
      双击空白建生成节点 · 素材拖入画布 · 端口拖拽连线 · 滚轮缩放 / 空白拖拽平移
    </div>
  </div>
</template>

<style scoped>
.cb-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
  outline: none;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.cb-viewport:active {
  cursor: grabbing;
}

.cb-viewport.linking {
  cursor: crosshair;
}

.cb-world {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
  background-image: radial-gradient(circle, rgb(148 163 184 / 15%) 1px, transparent 1.3px);
  background-size: 26px 26px;
  will-change: transform;
}

.cb-edges {
  position: absolute;
  pointer-events: none;
  overflow: visible;
}

.cb-edge {
  fill: none;
  stroke: rgb(148 163 184 / 58%);
  stroke-width: 1.7;
}

.cb-edge.sel {
  stroke: var(--accent-h);
  stroke-width: 2.4;
}

.cb-edge.tmp {
  stroke: var(--accent-h);
  stroke-width: 1.8;
  stroke-dasharray: 6 5;
  animation: cb-dash 0.8s linear infinite;
}

@keyframes cb-dash {
  to {
    stroke-dashoffset: -22;
  }
}

.cb-edge-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  pointer-events: stroke;
  cursor: pointer;
}

/* ---- 节点卡 ---- */
.cnode {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--border-strong);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
  cursor: grab;
  transition: border-color 0.15s, box-shadow 0.15s;
  touch-action: none;
}

.cnode:hover {
  border-color: rgb(148 163 184 / 55%);
  box-shadow: 0 6px 16px rgb(0 0 0 / 22%);
}

.cnode.sel {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}

.cnode.busy {
  border-left-color: var(--run);
  animation: cb-pulse 1.6s ease-in-out infinite;
}

.cnode.ok {
  border-left-color: var(--ok);
}

.cnode.bad {
  border-left-color: var(--bad);
}

@keyframes cb-pulse {
  50% {
    box-shadow: 0 0 0 3px rgb(129 140 248 / 16%);
  }
}

.cn-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--text-2);
}

.cn-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 12.5px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cn-head .badge {
  flex: none;
}

.cn-prompt {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}

.cn-media {
  height: 88px;
  border-radius: 7px;
  overflow: hidden;
  background: var(--bg);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
}

.cn-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cn-ph {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  color: var(--text-3);
}

.cn-ph em {
  font-size: 10.5px;
  font-style: normal;
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cn-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
  min-width: 0;
}

.cn-warn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--warn);
}

.cn-meta {
  font-size: 10.5px;
  color: var(--text-3);
}

.cn-err {
  font-size: 10.5px;
  color: var(--bad);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 端口 ---- */
.port {
  position: absolute;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--panel-2);
  border: 2px solid rgb(148 163 184 / 70%);
  z-index: 2;
}

.port.in {
  left: -7px;
  cursor: crosshair;
}

.port.in:hover,
.port.in.hot {
  border-color: var(--accent-h);
  background: var(--accent-h);
  transform: scale(1.25);
}

.port.out {
  right: -7px;
  top: 50%;
  margin-top: -5px;
  cursor: crosshair;
}

.port.out:hover {
  border-color: var(--ok);
  background: var(--ok);
  transform: scale(1.25);
}

/* ---- 缩放栏 / 提示 ---- */
.cb-zoombar {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 3px;
  box-shadow: 0 6px 18px rgb(0 0 0 / 30%);
}

.zb {
  display: flex;
  align-items: center;
  border: none;
  background: none;
  color: var(--text-2);
  padding: 4px 7px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}

.zb:hover {
  background: var(--hover);
  color: #fff;
}

.zb-fit {
  font-size: 11px;
}

.pct {
  min-width: 40px;
  border: none;
  background: none;
  font: inherit;
  font-size: 11px;
  color: var(--text-2);
  text-align: center;
  cursor: pointer;
  padding: 4px 2px;
  border-radius: 6px;
}

.pct:hover {
  background: var(--hover);
  color: #fff;
}

.cb-hint {
  position: absolute;
  left: 14px;
  bottom: 14px;
  font-size: 11px;
  color: var(--text-3);
  background: rgb(15 23 42 / 84%);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 5px 11px;
  pointer-events: none;
}
</style>
