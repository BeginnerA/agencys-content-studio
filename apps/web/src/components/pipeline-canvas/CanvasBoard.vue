<script setup lang="ts">
/**
 * [M15] 画布渲染层（手绘零依赖；spec §2.4）
 * - 世界层单容器 transform: translate(pan) scale(zoom)；节点 = 绝对定位 HTML 卡；边 = SVG 三次贝塞尔
 * - 布局：层号 = sched 边拓扑最长路径松弛（防环最多 n 轮）；层内按 seq 垂直堆叠居中
 * - pan = 视口 pointer capture（节点卡 @pointerdown.stop）；缩放 = 滚轮光标锚定 [0.3, 2.5]；键盘 +/-/0
 * - 数据层 props 全量替换不影响视图状态（pan/zoom 为组件内 ref；跨目标切换由父级 :key 重建）
 * - [M23] 编辑模式（editMode 仅模板画布编辑态）：节点右缘输出口拖拽连线（window pointermove/up +
 *   elementFromPoint 落点检测；临时线世界坐标 = (clientX-rect.left-pan)/zoom）；sched 边点选 + Del 删除
 *   → emit connect / delEdge（链路语义校验与 after 物化由父级编辑层应用）
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { CanvasBoardNode, CanvasEdge } from '../../lib/types'
import { fmtMs } from '../../lib/format'
import Icon from '../common/Icon.vue'
import { NODE_H, NODE_W, PAD, useCanvasLayout, type EdgePath } from './use-canvas-layout'
import { badgeClass, cardClass, hasChips, iconOf, statusText, taskText } from './canvas-card-helpers'

const props = defineProps<{
  nodes: CanvasBoardNode[]
  edges: CanvasEdge[]
  selectedKey: string | null
  mode: 'run' | 'template'
  /** [M23] 编辑模式：输出口拖拽连线 + 调度边点选/删除（仅模板画布编辑态传 true） */
  editMode?: boolean
}>()
const emit = defineEmits<{
  select: [key: string]
  /** [M23] 拖拽连线完成（上游 → 下游；合法性由父级编辑层校验/拒绝） */
  connect: [from: string, to: string]
  /** [M23] 调度边删除（Del 键；after 移除语义由父级应用） */
  delEdge: [from: string, to: string]
}>()

// ---- 缩放区间常量（布局常量 NODE_W/NODE_H/COL_GAP/ROW_GAP/PAD 见 use-canvas-layout）----
const ZOOM_MIN = 0.3
const ZOOM_MAX = 2.5

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// ---- 布局 / 边路径（纯派生，逐字迁至 use-canvas-layout）----
const { layout, worldW, worldH, nodeStyle, edgePaths } = useCanvasLayout(props)

// ---- pan / zoom ----
const viewport = ref<HTMLElement | null>(null)
const pan = ref({ x: 40, y: 40 })
const zoom = ref(1)
let dragging = false
let dragMoved = false
let lastX = 0
let lastY = 0

function onPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0 && ev.button !== 1) return
  dragging = true
  dragMoved = false
  lastX = ev.clientX
  lastY = ev.clientY
  ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
}
function onPointerMove(ev: PointerEvent): void {
  if (!dragging) return
  const dx = ev.clientX - lastX
  const dy = ev.clientY - lastY
  if (dx || dy) dragMoved = true
  pan.value = { x: pan.value.x + dx, y: pan.value.y + dy }
  lastX = ev.clientX
  lastY = ev.clientY
}
function onPointerUp(ev: PointerEvent): void {
  if (!dragging) return
  dragging = false
  const el = ev.currentTarget as HTMLElement
  if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
  if (!dragMoved) {
    selEdge.value = null // [M23] 点空白 = 取消边选中 / 取消节点选中（拖动不触发）
    emit('select', '')
  }
}

function applyZoom(nz: number, cx: number, cy: number): void {
  const z = clamp(nz, ZOOM_MIN, ZOOM_MAX)
  if (Math.abs(z - zoom.value) < 1e-4) return
  const k = z / zoom.value
  pan.value = { x: cx - (cx - pan.value.x) * k, y: cy - (cy - pan.value.y) * k }
  zoom.value = z
}
function onWheel(ev: WheelEvent): void {
  ev.preventDefault()
  const el = viewport.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  applyZoom(zoom.value * Math.exp(-ev.deltaY * 0.0012), ev.clientX - rect.left, ev.clientY - rect.top)
}
function zoomBy(f: number): void {
  const el = viewport.value
  if (!el) return
  applyZoom(zoom.value * f, el.clientWidth / 2, el.clientHeight / 2)
}
function fit(): void {
  const el = viewport.value
  if (!el) return
  const vw = el.clientWidth
  const vh = el.clientHeight
  if (!vw || !vh) return
  const z = clamp(Math.min(vw / worldW.value, vh / worldH.value), ZOOM_MIN, 1)
  zoom.value = z
  pan.value = { x: (vw - worldW.value * z) / 2, y: (vh - worldH.value * z) / 2 }
}
function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === '+' || ev.key === '=') zoomBy(1.2)
  else if (ev.key === '-' || ev.key === '_') zoomBy(1 / 1.2)
  else if (ev.key === '0') fit()
  else if ((ev.key === 'Delete' || ev.key === 'Backspace') && props.editMode && selEdge.value) {
    // [M23] 删除选中调度边（仍存在才 emit；after 移除语义由父级应用）
    const cur = selEdge.value
    if (props.edges.some((e) => e.type === 'sched' && e.from === cur.from && e.to === cur.to)) {
      emit('delEdge', cur.from, cur.to)
    }
    selEdge.value = null
    ev.preventDefault()
    return
  } else return
  ev.preventDefault()
}
defineExpose({ fit })

// ---- [M23] 编辑模式：拖拽连线 / 边选择 / 删除 ----
const selEdge = ref<{ from: string; to: string } | null>(null)
const connectFrom = ref<string | null>(null)
const connectPos = ref({ x: 0, y: 0 })
const dropKey = ref<string | null>(null)

/** 客户端坐标 → 世界坐标（临时线 / 落点高亮绘制用） */
function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const el = viewport.value
  if (!el) return { x: 0, y: 0 }
  const rect = el.getBoundingClientRect()
  return { x: (clientX - rect.left - pan.value.x) / zoom.value, y: (clientY - rect.top - pan.value.y) / zoom.value }
}

/** elementFromPoint 落点检测：取最近节点卡的 data-node-key */
function nodeKeyAt(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
  return el?.closest<HTMLElement>('[data-node-key]')?.dataset['nodeKey'] ?? null
}

function onPortDown(ev: PointerEvent, key: string): void {
  ev.stopPropagation()
  ev.preventDefault()
  connectFrom.value = key
  connectPos.value = toWorld(ev.clientX, ev.clientY)
  dropKey.value = null
  window.addEventListener('pointermove', onConnectMove)
  window.addEventListener('pointerup', onConnectUp)
}
function onConnectMove(ev: PointerEvent): void {
  if (connectFrom.value == null) return
  connectPos.value = toWorld(ev.clientX, ev.clientY)
  const k = nodeKeyAt(ev.clientX, ev.clientY)
  dropKey.value = k && k !== connectFrom.value ? k : null
}
function onConnectUp(ev: PointerEvent): void {
  window.removeEventListener('pointermove', onConnectMove)
  window.removeEventListener('pointerup', onConnectUp)
  const from = connectFrom.value
  connectFrom.value = null
  dropKey.value = null
  if (from == null) return
  const to = nodeKeyAt(ev.clientX, ev.clientY)
  if (to && to !== from) emit('connect', from, to)
}

function onEdgeClick(e: EdgePath): void {
  if (!props.editMode || e.type !== 'sched') return
  selEdge.value = { from: e.from, to: e.to }
}
function isEdgeSel(e: EdgePath): boolean {
  const s = selEdge.value
  return !!s && e.type === 'sched' && s.from === e.from && s.to === e.to
}

/** 拖拽临时线（输出口锚点 → 指针世界坐标；锚点 = 卡右中） */
const tempPath = computed(() => {
  const from = connectFrom.value
  if (from == null) return ''
  const p = layout.value.pos.get(from)
  if (!p) return ''
  const x1 = PAD + p.x + NODE_W
  const y1 = PAD + p.y + NODE_H / 2
  const x2 = connectPos.value.x
  const y2 = connectPos.value.y
  const dx = Math.max(48, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
})

// 退出编辑模式 → 清边选中（选中态不跨模式残留）
watch(
  () => props.editMode,
  (v) => {
    if (!v) selEdge.value = null
  },
)

// 首次数据到达时补一次全图居中（挂载时数据常未到，空布局 fit 无意义；此后刷新不重置）
let fitted = false
function fitOnce(): void {
  if (fitted || !props.nodes.length) return
  fitted = true
  fit()
}
onMounted(() => requestAnimationFrame(fitOnce))
watch(
  () => props.nodes.length,
  () => requestAnimationFrame(fitOnce),
)

// 节点卡辅助（iconOf/cardClass/badgeClass/statusText/taskText/hasChips）逐字迁至 ./canvas-card-helpers
</script>

<template>
  <div
    ref="viewport"
    class="cv-viewport"
    tabindex="0"
    aria-label="流水线画布（拖动平移 / 滚轮缩放 / 方向键外快捷键 +/-/0）"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
    @keydown="onKeydown"
  >
    <div
      class="cv-world"
      :style="{
        width: `${worldW}px`,
        height: `${worldH}px`,
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
      }"
    >
      <svg
        class="cv-edges"
        :class="{ editable: editMode }"
        :width="worldW"
        :height="worldH"
        :viewBox="`0 0 ${worldW} ${worldH}`"
      >
        <defs>
          <marker
            id="cv-arrow-sched"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(148 163 184 / 55%)" />
          </marker>
          <marker
            id="cv-arrow-data"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ok)" />
          </marker>
        </defs>
        <path
          v-for="e in edgePaths"
          :key="e.k"
          :d="e.d"
          class="cv-edge"
          :class="[e.type, { flowing: e.flowing, sel: isEdgeSel(e) }]"
          :marker-end="e.type === 'sched' ? 'url(#cv-arrow-sched)' : 'url(#cv-arrow-data)'"
          @pointerdown.stop
          @click.stop="onEdgeClick(e)"
        />
        <!-- [M23] 拖拽连线临时线（无箭头；指针穿透） -->
        <path v-if="tempPath" :d="tempPath" class="cv-edge temp" />
      </svg>

      <button
        v-for="n in nodes"
        :key="n.key"
        type="button"
        class="cnode"
        :class="[cardClass(n), { sel: n.key === selectedKey, drop: n.key === dropKey }]"
        :style="nodeStyle(n.key)"
        :title="n.title"
        :data-node-key="n.key"
        @pointerdown.stop
        @click="emit('select', n.key)"
      >
        <span class="cn-top">
          <Icon :name="iconOf(n.action)" :size="13" />
          <span class="cn-title">{{ n.title }}</span>
          <span v-if="n.status" class="badge" :class="badgeClass(n)">{{ statusText(n) }}</span>
          <span v-else-if="n.gateMessage" class="cn-gate" title="人工闸门"><Icon name="alert" :size="12" /></span>
        </span>
        <span class="cn-meta">
          <span class="mono">#{{ n.seq + 1 }}</span>
          <span class="mono cn-act">{{ n.action }}</span>
          <span v-if="n.durationMs != null">{{ fmtMs(n.durationMs) }}</span>
          <span v-if="(n.attempts ?? 0) > 1">尝试 {{ n.attempts }}</span>
          <span v-if="n.whenText" :title="n.whenText">条件</span>
          <span v-if="n.batchField" :title="`批量字段：${n.batchField}`">批量</span>
        </span>
        <span v-if="hasChips(n)" class="cn-chips">
          <span
            v-if="taskText(n)"
            class="cn-chip"
            :class="{ bad: ((n.tasks?.failed ?? 0) + (n.tasks?.cancelled ?? 0)) > 0 }"
          >{{ taskText(n) }}</span>
          <span v-if="n.assetCount" class="cn-chip ok">产物 {{ n.assetCount }}</span>
          <span v-if="n.skipText" class="cn-chip">{{ n.skipText }}</span>
          <span
            v-if="n.status === 'waiting_input' && n.gateMessage"
            class="cn-chip warn"
            :title="n.gateMessage"
          >闸门待审</span>
          <span v-if="n.hasError" class="cn-chip bad">错误</span>
        </span>
        <!-- [M23] 编辑模式输出口：拖拽到任一节点 = 新增调度依赖（上游 → 下游） -->
        <span
          v-if="editMode"
          class="cn-port"
          title="拖拽到下游节点 = 新增调度依赖"
          @pointerdown="onPortDown($event, n.key)"
        />
      </button>
    </div>

    <!-- 图例（左下角；不拦截拖拽） -->
    <div class="cv-legend" aria-hidden="true">
      <span class="lg">
        <svg width="26" height="8" viewBox="0 0 26 8"><path d="M1 4h24" stroke="rgb(148 163 184 / 55%)" stroke-width="2" /></svg>
        调度依赖
      </span>
      <span class="lg">
        <svg width="26" height="8" viewBox="0 0 26 8">
          <path d="M1 4h24" stroke="var(--ok)" stroke-width="2" stroke-dasharray="5 4" />
        </svg>
        数据引用
      </span>
    </div>

    <!-- [M23] 编辑模式提示（底部居中；指针穿透） -->
    <div v-if="editMode" class="cv-edit-hint">
      拖拽节点右缘圆点连线（上游 → 下游） · 点选调度边后 Del 删除
    </div>

    <!-- 缩放控制（右下角；@pointerdown.stop 防误触 pan/取消选中） -->
    <div class="cv-zoombar" @pointerdown.stop>
      <button type="button" class="zb" title="缩小（-）" @click="zoomBy(1 / 1.25)">
        <Icon name="zoom-out" :size="13" />
      </button>
      <button type="button" class="pct" title="适应视图（0）" @click="fit">{{ Math.round(zoom * 100) }}%</button>
      <button type="button" class="zb" title="放大（+）" @click="zoomBy(1.25)">
        <Icon name="zoom-in" :size="13" />
      </button>
      <button type="button" class="zb zb-fit" title="适应视图（0）" @click="fit">适应</button>
    </div>
  </div>
</template>

<style scoped>
.cv-viewport {
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

.cv-viewport:active {
  cursor: grabbing;
}

.cv-world {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  background-image: radial-gradient(circle, rgb(148 163 184 / 15%) 1px, transparent 1.3px);
  background-size: 26px 26px;
  will-change: transform;
}

.cv-edges {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}

.cv-edge {
  fill: none;
  stroke-width: 1.6;
}

.cv-edge.sched {
  stroke: rgb(148 163 184 / 55%);
}

.cv-edge.data {
  stroke: var(--ok);
  stroke-width: 1.4;
  stroke-dasharray: 6 5;
  opacity: 0.72;
}

/* running 节点入边流动动画（sched 边） */
.cv-edge.flowing {
  stroke: var(--run);
  stroke-dasharray: 7 5;
  animation: cv-flow 0.9s linear infinite;
}

@keyframes cv-flow {
  to {
    stroke-dashoffset: -24;
  }
}

/* ---- [M23] 编辑模式：sched 边点选 / 临时线 ---- */
.cv-edges.editable .cv-edge.sched {
  pointer-events: stroke;
  cursor: pointer;
}

.cv-edges.editable .cv-edge.sched:hover {
  stroke: rgb(148 163 184 / 92%);
  stroke-width: 2.4;
}

.cv-edge.sel,
.cv-edges.editable .cv-edge.sched.sel {
  stroke: var(--accent);
  stroke-width: 2.6;
}

.cv-edge.temp {
  stroke: var(--accent);
  stroke-width: 2;
  stroke-dasharray: 6 5;
  pointer-events: none;
}

/* ---- 节点卡 ---- */
.cnode {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 5px;
  height: 96px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--border-strong);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.cnode:hover {
  border-color: rgb(148 163 184 / 55%);
  box-shadow: 0 6px 16px rgb(0 0 0 / 22%);
}

.cnode.sel {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}

/* [M23] 连线拖拽悬停落点高亮 */
.cnode.drop {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgb(129 140 248 / 30%);
}

.cnode.running {
  border-left-color: var(--run);
  background: linear-gradient(90deg, rgb(129 140 248 / 10%), var(--panel) 55%);
  animation: cv-pulse 1.6s ease-in-out infinite;
}

.cnode.gate {
  border-left-color: var(--warn);
  background: linear-gradient(90deg, rgb(251 191 36 / 10%), var(--panel) 55%);
}

.cnode.failed {
  border-left-color: var(--bad);
  background: linear-gradient(90deg, rgb(248 113 113 / 10%), var(--panel) 55%);
}

.cnode.ok {
  border-left-color: var(--ok);
}

.cnode.skip {
  border-left-color: rgb(148 163 184 / 45%);
  opacity: 0.72;
}

.cnode.cancel {
  border-left-color: var(--text-3);
  opacity: 0.72;
}

@keyframes cv-pulse {
  50% {
    box-shadow: 0 0 0 3px rgb(129 140 248 / 16%);
  }
}

.cn-top {
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

.cn-top .badge {
  flex: none;
}

.cn-gate {
  flex: none;
  color: var(--warn);
  display: flex;
}

.cn-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
}

.cn-act {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cn-chips {
  display: flex;
  gap: 4px;
  overflow: hidden;
}

.cn-chip {
  flex: none;
  font-size: 10.5px;
  line-height: 1.5;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-2);
  white-space: nowrap;
}

.cn-chip.bad {
  color: var(--bad);
  border-color: rgb(248 113 113 / 42%);
}

.cn-chip.warn {
  color: var(--warn);
  border-color: rgb(251 191 36 / 42%);
}

.cn-chip.ok {
  color: var(--ok);
  border-color: rgb(34 197 94 / 35%);
}

/* [M23] 编辑模式输出口（卡内侧右缘——.cnode overflow:hidden 不得放在卡外） */
.cn-port {
  position: absolute;
  right: 4px;
  top: 50%;
  width: 14px;
  height: 14px;
  margin-top: -7px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  background: var(--panel);
  cursor: crosshair;
  opacity: 0.72;
  transition: opacity 0.15s, transform 0.15s;
  touch-action: none;
}

.cn-port:hover {
  opacity: 1;
  transform: scale(1.18);
}

/* [M23] 编辑模式提示（底部居中胶囊；指针穿透） */
.cv-edit-hint {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  max-width: calc(100% - 460px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-2);
  background: rgb(15 23 42 / 84%);
  border: 1px solid rgb(129 140 248 / 45%);
  border-radius: 999px;
  padding: 5px 14px;
  pointer-events: none;
}

/* ---- 图例 / 缩放栏 ---- */
.cv-legend {
  position: absolute;
  left: 14px;
  bottom: 14px;
  display: flex;
  gap: 14px;
  font-size: 11px;
  color: var(--text-3);
  background: rgb(15 23 42 / 84%);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 5px 11px;
  pointer-events: none;
}

.lg {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cv-zoombar {
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
</style>
