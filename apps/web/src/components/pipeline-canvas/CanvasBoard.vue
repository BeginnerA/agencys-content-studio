<script setup lang="ts">
/**
 * 画布渲染层（手绘零依赖；spec §2.4）
 * - 世界层单容器 transform: translate(pan) scale(zoom)；节点 = 绝对定位 HTML 卡；边 = SVG 三次贝塞尔
 * - 布局：层号 = sched 边拓扑最长路径松弛（防环最多 n 轮）；层内按 seq 垂直堆叠居中
 * - pan = 视口 pointer capture（节点卡 @pointerdown.stop）；缩放 = 滚轮光标锚定 [0.3, 2.5]；键盘 +/-/0
 * - 数据层 props 全量替换不影响视图状态（pan/zoom 为组件内 ref；跨目标切换由父级 :key 重建）
 * - 编辑模式（editMode 仅模板画布编辑态）：节点右缘输出口拖拽连线（window pointermove/up +
 *   elementFromPoint 落点检测；临时线世界坐标 = (clientX-rect.left-pan)/zoom）；sched 边点选 + Del 删除
 *   → emit connect / delEdge（链路语义校验与 after 物化由父级编辑层应用）
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { CanvasBoardNode, CanvasEdge } from '../../lib/types'
import { fmtMs } from '../../lib/format'
import Icon from '../common/Icon.vue'
import CanvasLegend from './CanvasLegend.vue'
import {
  NODE_H,
  NODE_W,
  PAD,
  useCanvasLayout,
  type EdgePath,
} from './use-canvas-layout'
import {
  badgeClass,
  cardClass,
  hasChips,
  iconOf,
  statusText,
  taskText,
} from './canvas-card-helpers'

const props = defineProps<{
  nodes: CanvasBoardNode[]
  edges: CanvasEdge[]
  selectedKey: string | null
  mode: 'run' | 'template'
  /** 编辑模式：输出口拖拽连线 + 调度边点选/删除（仅模板画布编辑态传 true） */
  editMode?: boolean
}>()
const emit = defineEmits<{
  select: [key: string]
  /** 拖拽连线完成（上游 → 下游；合法性由父级编辑层校验/拒绝） */
  connect: [from: string, to: string]
  /** 调度边删除（Del 键；after 移除语义由父级应用） */
  delEdge: [from: string, to: string]
}>()

// ---- 缩放区间常量（布局常量 NODE_W/NODE_H/COL_GAP/ROW_GAP/PAD 见 use-canvas-layout）----
const ZOOM_MIN = 0.3
const ZOOM_MAX = 2.5

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v))

// ---- 布局 / 边路径（纯派生，逐字迁至 use-canvas-layout）----
const { layout, worldW, worldH, nodeStyle, edgePaths } = useCanvasLayout(props)

// ---- pan / zoom ----
const viewport = ref<HTMLElement | null>(null)
const pan = ref({ x: 40, y: 40 })
const zoom = ref(1)

/** 背景点阵网格：铺满整个视口并随 pan/zoom 同步（世界层尺寸仅包围盒，网格挂世界上会留白） */
const gridStyle = computed(() => ({
  backgroundImage: `radial-gradient(circle, rgb(148 163 184 / 15%) ${
    1 * zoom.value
  }px, transparent ${1.3 * zoom.value}px)`,
  backgroundSize: `${26 * zoom.value}px ${26 * zoom.value}px`,
  backgroundPosition: `${pan.value.x}px ${pan.value.y}px`,
}))
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
    selEdge.value = null // 点空白 = 取消边选中 / 取消节点选中（拖动不触发）
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
  applyZoom(
    zoom.value * Math.exp(-ev.deltaY * 0.0012),
    ev.clientX - rect.left,
    ev.clientY - rect.top,
  )
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
  else if (
    (ev.key === 'Delete' || ev.key === 'Backspace') &&
    props.editMode &&
    selEdge.value
  ) {
    // 删除选中调度边（仍存在才 emit；after 移除语义由父级应用）
    const cur = selEdge.value
    if (
      props.edges.some(
        (e) => e.type === 'sched' && e.from === cur.from && e.to === cur.to,
      )
    ) {
      emit('delEdge', cur.from, cur.to)
    }
    selEdge.value = null
    ev.preventDefault()
    return
  } else return
  ev.preventDefault()
}
defineExpose({ fit })

// ---- 编辑模式：拖拽连线 / 边选择 / 删除 ----
const selEdge = ref<{ from: string; to: string } | null>(null)
const connectFrom = ref<string | null>(null)
const connectPos = ref({ x: 0, y: 0 })
const dropKey = ref<string | null>(null)

/** 客户端坐标 → 世界坐标（临时线 / 落点高亮绘制用） */
function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const el = viewport.value
  if (!el) return { x: 0, y: 0 }
  const rect = el.getBoundingClientRect()
  return {
    x: (clientX - rect.left - pan.value.x) / zoom.value,
    y: (clientY - rect.top - pan.value.y) / zoom.value,
  }
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

// ---- 选中联动（节点选中 → 下游/上游 key 集；边选中 → 两端 key 集）----
const relOut = computed(() => {
  const s = new Set<string>()
  const k = props.selectedKey
  if (k) for (const e of props.edges) if (e.from === k) s.add(e.to)
  return s
})
const relInn = computed(() => {
  const s = new Set<string>()
  const k = props.selectedKey
  if (k) for (const e of props.edges) if (e.to === k) s.add(e.from)
  return s
})
const relPair = computed(() => {
  const s = new Set<string>()
  const p = selEdge.value
  if (p) {
    s.add(p.from)
    s.add(p.to)
  }
  return s
})

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
    :style="gridStyle"
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
          :class="[
            e.type,
            {
              flowing: e.flowing,
              sel: isEdgeSel(e),
              'rel-out': !!selectedKey && e.from === selectedKey,
              'rel-in': !!selectedKey && e.to === selectedKey,
            },
          ]"
          :marker-end="
            e.type === 'sched' ? 'url(#cv-arrow-sched)' : 'url(#cv-arrow-data)'
          "
          @pointerdown.stop
          @click.stop="onEdgeClick(e)"
        />
        <!-- 拖拽连线临时线（无箭头；指针穿透） -->
        <path v-if="tempPath" :d="tempPath" class="cv-edge temp" />
      </svg>

      <button
        v-for="n in nodes"
        :key="n.key"
        type="button"
        class="cnode"
        :class="[
          cardClass(n),
          {
            sel: n.key === selectedKey,
            drop: n.key === dropKey,
            'rel-out': relOut.has(n.key),
            'rel-in': relInn.has(n.key),
            rel: relPair.has(n.key),
          },
        ]"
        :style="nodeStyle(n.key)"
        :title="n.title"
        :data-node-key="n.key"
        @pointerdown.stop
        @click="emit('select', n.key)"
      >
        <span class="cn-top">
          <Icon :name="iconOf(n.action)" :size="13" />
          <span class="cn-title">{{ n.title }}</span>
          <span v-if="n.status" class="badge" :class="badgeClass(n)">{{
            statusText(n)
          }}</span>
          <span v-else-if="n.gateMessage" class="cn-gate" title="人工闸门"
            ><Icon name="alert" :size="12"
          /></span>
        </span>
        <span class="cn-meta">
          <span class="mono">#{{ n.seq + 1 }}</span>
          <span class="mono cn-act">{{ n.action }}</span>
          <span v-if="n.durationMs != null">{{ fmtMs(n.durationMs) }}</span>
          <span v-if="(n.attempts ?? 0) > 1">尝试 {{ n.attempts }}</span>
          <span v-if="n.whenText" :title="n.whenText">条件</span>
          <span v-if="n.batchField" :title="`批量字段：${n.batchField}`"
            >批量</span
          >
        </span>
        <span v-if="hasChips(n)" class="cn-chips">
          <span
            v-if="taskText(n)"
            class="cn-chip"
            :class="{
              bad: (n.tasks?.failed ?? 0) + (n.tasks?.cancelled ?? 0) > 0,
            }"
            >{{ taskText(n) }}</span
          >
          <span v-if="n.assetCount" class="cn-chip ok"
            >产物 {{ n.assetCount }}</span
          >
          <span v-if="n.skipText" class="cn-chip">{{ n.skipText }}</span>
          <span
            v-if="n.status === 'waiting_input' && n.gateMessage"
            class="cn-chip warn"
            :title="n.gateMessage"
            >闸门待审</span
          >
          <span v-if="n.hasError" class="cn-chip bad">错误</span>
        </span>
        <!-- 编辑模式输出口：拖拽到任一节点 = 新增调度依赖（上游 → 下游） -->
        <span
          v-if="editMode"
          class="cn-port"
          title="拖拽到下游节点 = 新增调度依赖"
          @pointerdown="onPortDown($event, n.key)"
        />
      </button>
    </div>

    <!-- 图例（左下角；不拦截拖拽）——拆至 CanvasLegend（红线恢复，行为零变更） -->
    <CanvasLegend />

    <!-- 编辑模式提示（底部居中；指针穿透） -->
    <div v-if="editMode" class="cv-edit-hint">
      拖拽节点右缘圆点连线（上游 → 下游） · 点选调度边后 Del 删除
    </div>

    <!-- 缩放控制（右下角；@pointerdown.stop 防误触 pan/取消选中） -->
    <div class="cv-zoombar" @pointerdown.stop>
      <button
        type="button"
        class="zb"
        title="缩小（-）"
        @click="zoomBy(1 / 1.25)"
      >
        <Icon name="zoom-out" :size="13" />
      </button>
      <button type="button" class="pct" title="适应视图（0）" @click="fit">
        {{ Math.round(zoom * 100) }}%
      </button>
      <button type="button" class="zb" title="放大（+）" @click="zoomBy(1.25)">
        <Icon name="zoom-in" :size="13" />
      </button>
      <button
        type="button"
        class="zb zb-fit"
        title="适应视图（0）"
        @click="fit"
      >
        适应
      </button>
    </div>
  </div>
</template>

<style scoped src="./CanvasBoard.css"></style>
