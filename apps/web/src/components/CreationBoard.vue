<script setup lang="ts">
/**
 * [M16/M17] 创作画布渲染层（手绘零依赖；spec §2.5）
 * - 世界层 translate(pan) scale(zoom)；边 = SVG 三次贝塞尔；节点 = 绝对定位卡片（宽 220）
 * - 模式机：box（空白左键框选）/ pan（空格+左键 / 中键）/ node（多选整组拖拽）/ link（输出口→输入口）
 * - 键盘：Del 删除 · Ctrl+Z/Y 撤销重做 · Ctrl+D 复制 · Ctrl+A 全选 · 方向键微移 · 空格平移 · F 适应 · Esc 取消
 * - 落点：空白双击建生成节点；drop 文件由父级上传后建素材节点（本组件只报世界坐标与文件）
 * - 视口：useBoardViewport（初始 = 画布持久化；settled 后 emit，父级防抖 PATCH）
 * - [M17] 选择模型破坏性变更：空白左键拖 = 框选（全包含判定）；平移改空格/中键（spec §2.4，README 明示）
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useBoardViewport, type ContentBounds } from '../lib/board-viewport'
import type {
  AnyNodeSpec,
  CanvasDocEdge,
  CanvasDocNode,
  CanvasGroup,
  CanvasViewport,
  CreationNodeSpec,
} from '../lib/types'
import { fmtMs } from '../lib/format'
import Icon from './Icon.vue'

const props = defineProps<{
  nodes: CanvasDocNode[]
  edges: CanvasDocEdge[]
  groups: CanvasGroup[]
  selectedIds: number[]
  selectedEdgeId: number | null
  initialViewport: CanvasViewport | null
}>()
const emit = defineEmits<{
  select: [ids: number[]]
  selectEdge: [id: number | null]
  moved: [moves: Array<{ id: number; x: number; y: number }>]
  nudge: [moves: Array<{ id: number; x: number; y: number }>]
  connect: [p: { from: number; to: number; port: string }]
  'create-node': [p: { x: number; y: number }]
  'drop-files': [p: { files: File[]; x: number; y: number }]
  'drop-asset': [p: { assetId: number; x: number; y: number }]
  'drop-entity': [p: { entityId: number; x: number; y: number }]
  'viewport-settled': [v: CanvasViewport]
  'delete-selected': []
  'copy-selected': []
  'group-create': []
  'group-patch': [gid: number, patch: { title?: string; color?: string | null; collapsed?: boolean }]
  'group-delete': [gid: number]
  undo: []
  redo: []
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

/** 拖拽中的整组本地即时偏移（优先于渲染）；抬起 emit 后由父级乐观更新替换 */
const dragGroup = ref<{ ids: number[]; dx: number; dy: number; moved: boolean } | null>(null)
function nodeXY(n: CanvasDocNode): { x: number; y: number } {
  const d = dragGroup.value
  if (d?.moved && d.ids.includes(n.id)) return { x: n.x + d.dx, y: n.y + d.dy }
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

// ---- [M18] 分组：成员派生 / 折叠隐藏 / 包围盒 / 组条交互 ----
function membersOf(gid: number): CanvasDocNode[] {
  return props.nodes.filter((n) => n.groupId === gid)
}
const hiddenNodeIds = computed<Set<number>>(() => {
  const s = new Set<number>()
  for (const g of props.groups) {
    if (g.collapsed) for (const n of props.nodes) if (n.groupId === g.id) s.add(n.id)
  }
  return s
})
function isNodeHidden(n: CanvasDocNode): boolean {
  return hiddenNodeIds.value.has(n.id)
}
const renderNodes = computed(() => props.nodes.filter((n) => isNodeHidden(n) === false))
/** 组包围盒（世界坐标；含成员实测尺寸 + 顶部组条空间；空组用锚点默认 240×120） */
function groupBox(g: CanvasGroup): { x: number; y: number; w: number; h: number } {
  const ms = membersOf(g.id)
  if (ms.length === 0) return { x: g.x, y: g.y, w: 240, h: 120 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of ms) {
    const p = nodeXY(n)
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + NODE_W)
    maxY = Math.max(maxY, p.y + nodeH(n))
  }
  return { x: minX - 12, y: minY - 34, w: maxX - minX + 24, h: maxY - minY + 46 }
}
function groupFrameStyle(g: CanvasGroup): Record<string, string> {
  const b = groupBox(g)
  if (g.collapsed) return { left: `${b.x}px`, top: `${b.y}px`, width: '220px', height: '32px' }
  return { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }
}
function isGroupSelected(g: CanvasGroup): boolean {
  const ms = membersOf(g.id)
  return ms.length > 0 && ms.every((n) => props.selectedIds.includes(n.id))
}
const editingGroupId = ref<number | null>(null)
const editingTitle = ref('')
const openGroupMenu = ref<number | null>(null)
const GROUP_COLORS = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink', 'gray']
function startRename(g: CanvasGroup): void {
  editingGroupId.value = g.id
  editingTitle.value = g.title
  openGroupMenu.value = null
}
function commitRename(g: CanvasGroup): void {
  if (editingGroupId.value !== g.id) return
  editingGroupId.value = null
  const t = editingTitle.value.trim()
  if (t && t !== g.title) emit('group-patch', g.id, { title: t })
}
function toggleCollapse(g: CanvasGroup): void {
  emit('group-patch', g.id, { collapsed: !g.collapsed })
  openGroupMenu.value = null
}
function toggleGroupMenu(g: CanvasGroup): void {
  openGroupMenu.value = openGroupMenu.value === g.id ? null : g.id
}
function setGroupColor(g: CanvasGroup, color: string | null): void {
  emit('group-patch', g.id, { color })
  openGroupMenu.value = null
}
function ungroup(g: CanvasGroup): void {
  emit('group-delete', g.id)
  openGroupMenu.value = null
}
function onGroupBarPointerDown(ev: PointerEvent, g: CanvasGroup): void {
  if (ev.button !== 0 || spaceDown.value) return
  if (editingGroupId.value === g.id) return
  ev.stopPropagation()
  const ids = membersOf(g.id).map((n) => n.id)
  emit('select', ids)
  openGroupMenu.value = null
  if (!ids.length) return
  mode.value = 'node'
  drag = { ids }
  dragPx = { cx: ev.clientX, cy: ev.clientY }
  dragGroup.value = null
  viewportEl.value?.setPointerCapture(ev.pointerId)
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
    if (hiddenNodeIds.value.has(e.from) || hiddenNodeIds.value.has(e.to)) continue // [M18] 折叠组成员：相关边隐藏
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
function cancelLink(): void {
  linkFrom.value = null
  linkCur.value = null
  hotPort.value = null
}

// ---- 模式机（pointer 统一在视口捕获：box / pan / node / link）----
type Mode = 'idle' | 'pan' | 'node' | 'link' | 'box'
const mode = ref<Mode>('idle')
const spaceDown = ref(false)
let panMoved = false
let drag: { ids: number[] } | null = null
let dragPx: { cx: number; cy: number } | null = null
let boxStart: { x: number; y: number } | null = null
let boxMoved = false
const boxRect = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

function onViewportPointerDown(ev: PointerEvent): void {
  if (ev.button === 1 || (ev.button === 0 && spaceDown.value)) {
    // 平移：中键 / 空格+左键（spec §2.4）
    ev.preventDefault()
    mode.value = 'pan'
    panMoved = false
    vp.beginPan(ev)
    ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
    return
  }
  if (ev.button !== 0) return
  // 空白左键 = 框选（M17 破坏性变更：原为平移）
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  mode.value = 'box'
  boxMoved = false
  boxStart = { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
  boxRect.value = null
  ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
}

function onNodePointerDown(ev: PointerEvent, n: CanvasDocNode): void {
  if (ev.button !== 0 || spaceDown.value) return // 空格按住 = 平移（不拦截，冒泡到视口）
  ev.stopPropagation()
  mode.value = 'node'
  const cur = props.selectedIds
  const inSel = cur.includes(n.id)
  if (ev.shiftKey && !inSel) {
    emit('select', [...cur, n.id])
    drag = { ids: [n.id] } // 加选并单拖新节点
  } else if (ev.shiftKey && inSel) {
    emit('select', cur.filter((id) => id !== n.id)) // 减选
    drag = { ids: cur.filter((id) => id !== n.id) }
  } else if (inSel) {
    drag = { ids: [...cur] } // 多拖：拖动任一选中 = 整组
  } else {
    emit('select', [n.id])
    drag = { ids: [n.id] }
  }
  dragPx = { cx: ev.clientX, cy: ev.clientY }
  dragGroup.value = null
  viewportEl.value?.setPointerCapture(ev.pointerId)
}

function onOutPortPointerDown(ev: PointerEvent, n: CanvasDocNode): void {
  if (ev.button !== 0) return
  ev.stopPropagation()
  mode.value = 'link'
  linkFrom.value = n.id
  linkCur.value = vp.screenToWorld(ev.clientX, ev.clientY)
  hotPort.value = null
  viewportEl.value?.setPointerCapture(ev.pointerId)
}

function onViewportPointerMove(ev: PointerEvent): void {
  if (mode.value === 'pan') {
    if (vp.movePan(ev)) panMoved = true
  } else if (mode.value === 'node' && drag && dragPx) {
    const px = ev.clientX - dragPx.cx
    const py = ev.clientY - dragPx.cy
    if (!dragGroup.value?.moved && Math.abs(px) + Math.abs(py) < 4) return
    dragGroup.value = { ids: drag.ids, dx: px / zoom.value, dy: py / zoom.value, moved: true }
  } else if (mode.value === 'link') {
    linkCur.value = vp.screenToWorld(ev.clientX, ev.clientY)
    const t = (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-in-port]') as HTMLElement | null) ?? null
    hotPort.value = t ? `${t.dataset.nodeId}:${t.dataset.port}` : null
  } else if (mode.value === 'box' && boxStart) {
    const el = viewportEl.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const y = ev.clientY - rect.top
    if (!boxMoved && Math.abs(x - boxStart.x) + Math.abs(y - boxStart.y) < 4) return
    boxMoved = true
    boxRect.value = { x1: boxStart.x, y1: boxStart.y, x2: x, y2: y }
  }
}

function onViewportPointerUp(ev: PointerEvent): void {
  const el = ev.currentTarget as HTMLElement
  if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
  if (mode.value === 'link') {
    const t = (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-in-port]') as HTMLElement | null) ?? null
    const from = linkFrom.value
    if (t && from != null) {
      const to = Number(t.dataset.nodeId)
      const port = t.dataset.port ?? ''
      if (Number.isInteger(to) && to !== from && port) emit('connect', { from, to, port })
    }
    cancelLink()
  } else if (mode.value === 'node' && drag) {
    const d = dragGroup.value
    if (d?.moved) {
      const sel = new Set(d.ids)
      const moves = props.nodes
        .filter((n) => sel.has(n.id))
        .map((n) => ({ id: n.id, x: Math.round(n.x + d.dx), y: Math.round(n.y + d.dy) }))
      if (moves.length) emit('moved', moves)
    }
    drag = null
    dragPx = null
    dragGroup.value = null
  } else if (mode.value === 'pan') {
    if (!panMoved) {
      emit('select', [])
      emit('selectEdge', null)
    }
  } else if (mode.value === 'box') {
    if (boxMoved && boxRect.value) {
      const el2 = viewportEl.value
      const br = boxRect.value
      if (el2) {
        const rect = el2.getBoundingClientRect()
        const w1 = vp.screenToWorld(rect.left + Math.min(br.x1, br.x2), rect.top + Math.min(br.y1, br.y2))
        const w2 = vp.screenToWorld(rect.left + Math.max(br.x1, br.x2), rect.top + Math.max(br.y1, br.y2))
        const hits = props.nodes
          .filter((n) => {
            const p = nodeXY(n)
            return p.x >= w1.x && p.y >= w1.y && p.x + NODE_W <= w2.x && p.y + nodeH(n) <= w2.y
          })
          .map((n) => n.id)
        emit('select', ev.shiftKey ? [...new Set([...props.selectedIds, ...hits])] : hits)
      }
    } else {
      emit('select', [])
      emit('selectEdge', null)
    }
    boxRect.value = null
    boxStart = null
    boxMoved = false
  }
  mode.value = 'idle'
}

const boxStyle = computed(() => {
  const b = boxRect.value
  if (!b) return undefined
  return {
    left: `${Math.min(b.x1, b.x2)}px`,
    top: `${Math.min(b.y1, b.y2)}px`,
    width: `${Math.abs(b.x2 - b.x1)}px`,
    height: `${Math.abs(b.y2 - b.y1)}px`,
  }
})

// ---- 键盘（快捷键全集；输入框聚焦时除 Esc 全部让行）----
const ARROW: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}
function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"]')
}
function onKeyDown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    // Esc 不被输入框吞：取消连线/框选，否则清空选中
    if (mode.value === 'link') {
      cancelLink()
      return
    }
    if (mode.value === 'box') {
      boxRect.value = null
      boxStart = null
      boxMoved = false
      return
    }
    if (props.selectedIds.length) emit('select', [])
    return
  }
  if (isEditable(ev.target)) return
  if (ev.code === 'Space') {
    if (!ev.repeat) spaceDown.value = true
    ev.preventDefault()
    return
  }
  const mod = ev.ctrlKey || ev.metaKey
  const key = ev.key.toLowerCase()
  if (mod && key === 'z' && !ev.shiftKey) {
    ev.preventDefault()
    emit('undo')
    return
  }
  if ((mod && key === 'z' && ev.shiftKey) || (mod && key === 'y')) {
    ev.preventDefault()
    emit('redo')
    return
  }
  if (mod && key === 'd') {
    ev.preventDefault()
    emit('copy-selected')
    return
  }
  if (mod && key === 'g') {
    // [M18] Ctrl+G 成组（须 ≥2 选中；解组走组条菜单）
    ev.preventDefault()
    if (props.selectedIds.length >= 2) emit('group-create')
    return
  }
  if (mod && key === 'a') {
    ev.preventDefault()
    emit('select', props.nodes.map((n) => n.id))
    return
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (props.selectedIds.length) {
      ev.preventDefault()
      emit('delete-selected')
    }
    return
  }
  if (key === 'f' && !mod) {
    fitView()
    return
  }
  const dir = ARROW[ev.key]
  if (dir && props.selectedIds.length) {
    ev.preventDefault()
    const step = ev.shiftKey ? 1 : 10
    const sel = new Set(props.selectedIds)
    const moves = props.nodes
      .filter((n) => sel.has(n.id))
      .map((n) => ({ id: n.id, x: n.x + dir[0] * step, y: n.y + dir[1] * step }))
    if (moves.length) emit('nudge', moves)
  }
}
function onKeyUp(ev: KeyboardEvent): void {
  if (ev.code === 'Space') spaceDown.value = false
}
onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
})

// ---- 双击空白建生成节点 / drop 文件 ----
function onDblClick(ev: MouseEvent): void {
  if (spaceDown.value) return
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
  // 素材面板拖入（assetId / entityId）优先；否则按本地文件处理（由父级上传后建节点）
  const assetRaw = ev.dataTransfer?.getData('text/acs-asset-id')
  if (assetRaw) {
    const assetId = Number(assetRaw)
    if (Number.isInteger(assetId) && assetId > 0) emit('drop-asset', { assetId, x, y })
    return
  }
  const entityRaw = ev.dataTransfer?.getData('text/acs-entity-id')
  if (entityRaw) {
    const entityId = Number(entityRaw)
    if (Number.isInteger(entityId) && entityId > 0) emit('drop-entity', { entityId, x, y })
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
/** [M17] 使世界坐标 (x,y) 居中（总览聚焦 / 定位；不改缩放） */
function centerOn(x: number, y: number): void {
  const el = viewportEl.value
  if (!el) return
  pan.value = { x: el.clientWidth / 2 - x * zoom.value, y: el.clientHeight / 2 - y * zoom.value }
}
defineExpose({ fit: fitView, centerWorld, centerOn })

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
  prompt: '提示词（文本节点）',
  video: '视频输入（合成）',
  audio: '音频输入（合成）',
  text: '文本素材（LLM）',
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
const RUN_CLS: Record<string, string> = {
  queued: 'pending',
  running: 'processing',
  waiting_input: 'pending',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
}
const RUN_TEXT: Record<string, string> = {
  queued: '排队',
  running: '运行中',
  waiting_input: '待输入',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}
const ENTITY_KIND_TEXT: Record<string, string> = { character: '角色', scene: '场景', prop: '道具' }

function stText(n: CanvasDocNode): string {
  return n.status && n.status !== 'idle' ? (TASK_TEXT[n.status] ?? n.status) : ''
}
function stCls(n: CanvasDocNode): string {
  return n.status ? (TASK_CLS[n.status] ?? 'pending') : ''
}
function runText(n: CanvasDocNode): string {
  return n.kind === 'run' && n.run ? (RUN_TEXT[n.run.status] ?? n.run.status) : ''
}
function runCls(n: CanvasDocNode): string {
  return n.kind === 'run' && n.run ? (RUN_CLS[n.run.status] ?? 'pending') : ''
}
function cardCls(n: CanvasDocNode): Record<string, boolean> {
  const runSt = n.run?.status
  return {
    asset: n.kind === 'asset',
    gen: n.kind === 'gen',
    sel: props.selectedIds.includes(n.id),
    busy: n.status === 'processing' || n.status === 'pending' || runSt === 'running' || runSt === 'queued' || runSt === 'waiting_input',
    bad: n.status === 'failed' || runSt === 'failed',
    ok: n.status === 'succeeded' || runSt === 'completed',
  }
}
/** spec 类型守卫：是否 gen 规范（含 genKind） */
function asGenSpec(s: AnyNodeSpec | null): CreationNodeSpec | null {
  return s && typeof s === 'object' && 'genKind' in s ? (s as CreationNodeSpec) : null
}
function inputPortsOf(n: CanvasDocNode): string[] {
  if (n.kind !== 'gen') return []
  const spec = asGenSpec(n.spec)
  if (!spec) return []
  if (spec.genKind === 'compose') return ['video', 'audio']
  if (spec.genKind === 'audio') return ['prompt']
  if (spec.genKind === 'llm') return ['reference', 'text', 'prompt']
  const ports = ['reference']
  if (spec.genKind === 'video') ports.push('first_frame', 'last_frame')
  if (spec.edit) ports.push('source')
  ports.push('prompt')
  return ports
}
function hasOutPort(n: CanvasDocNode): boolean {
  return n.kind !== 'run'
}
function genIcon(n: CanvasDocNode): string {
  if (n.kind === 'text') return 'doc'
  if (n.kind === 'entity') return 'users'
  if (n.kind !== 'gen') return 'alert'
  const spec = asGenSpec(n.spec)
  if (!spec) return 'alert'
  if (spec.edit) return 'brush'
  if (spec.genKind === 'video') return 'video'
  if (spec.genKind === 'audio') return 'speaker-wave'
  if (spec.genKind === 'compose') return 'film'
  if (spec.genKind === 'llm') return 'sparkles'
  return 'photo'
}
function isAudio(n: CanvasDocNode): boolean {
  return asGenSpec(n.spec)?.genKind === 'audio'
}
function isLlm(n: CanvasDocNode): boolean {
  return asGenSpec(n.spec)?.genKind === 'llm'
}
function isTextAsset(n: CanvasDocNode): boolean {
  return n.asset?.kind === 'text'
}
function specLine(n: CanvasDocNode): string {
  const spec = asGenSpec(n.spec)
  if (!spec) return n.specError ?? 'spec 缺失'
  if (spec.genKind === 'compose') {
    const parts = [spec.resolution, spec.fps != null ? `${spec.fps}fps` : null].filter(Boolean)
    return parts.length ? parts.join(' · ') : '（连线驱动合成）'
  }
  return spec.prompt || '（空 prompt）'
}
function promptTitle(n: CanvasDocNode): string {
  return asGenSpec(n.spec)?.prompt ?? ''
}
function textBody(n: CanvasDocNode): string {
  const s = n.spec
  return s && 'text' in s ? s.text || '（空文本）' : n.specError ?? 'spec 缺失'
}
function kindText(k: string): string {
  return ENTITY_KIND_TEXT[k] ?? k
}
function thumbOf(n: CanvasDocNode): string | null {
  const a = n.asset
  if (!a || a.kind !== 'image') return null
  return a.urls.thumb ?? a.urls.file
}
function entityThumb(n: CanvasDocNode): string | null {
  const a = n.entity?.asset
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
    :class="{ linking: linkFrom != null, grabbing: spaceDown || mode === 'pan' }"
    tabindex="0"
    aria-label="创作画布（左拖框选 / 空格或中键拖动平移 / 滚轮缩放 / 双击空白建节点 / 拖入素材）"
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
      <!-- [M18] 分组层：成员派生包围盒框 + 顶部组条（折叠/重命名/改色/解组/拖拽移组）-->
      <div
        v-for="g in groups"
        :key="`g${g.id}`"
        class="cgroup"
        :class="[g.color ? `cg-${g.color}` : '', { collapsed: g.collapsed, sel: isGroupSelected(g) }]"
        :style="groupFrameStyle(g)"
      >
        <div class="cgroup-bar" @pointerdown="onGroupBarPointerDown($event, g)" @dblclick.stop="startRename(g)">
          <button class="cgroup-tri" :title="g.collapsed ? '展开' : '折叠'" @pointerdown.stop @click.stop="toggleCollapse(g)">
            {{ g.collapsed ? '▸' : '▾' }}
          </button>
          <input
            v-if="editingGroupId === g.id"
            v-model="editingTitle"
            class="cgroup-rename"
            @pointerdown.stop
            @keydown.enter.prevent="commitRename(g)"
            @keydown.esc.prevent="editingGroupId = null"
            @blur="commitRename(g)"
          />
          <span v-else class="cgroup-title">{{ g.title }}</span>
          <span class="cgroup-count">{{ membersOf(g.id).length }}</span>
          <button class="cgroup-menu-btn" title="组操作" @pointerdown.stop @click.stop="toggleGroupMenu(g)">⋯</button>
          <div v-if="openGroupMenu === g.id" class="cgroup-menu" @pointerdown.stop @dblclick.stop>
            <div class="cgroup-colors">
              <button class="cgroup-dot cg-none" :class="{ on: !g.color }" title="默认" @click="setGroupColor(g, null)" />
              <button
                v-for="c in GROUP_COLORS"
                :key="c"
                class="cgroup-dot"
                :class="[`cg-${c}`, { on: g.color === c }]"
                :title="c"
                @click="setGroupColor(g, c)"
              />
            </div>
            <button class="cgroup-act" @click="ungroup(g)">解组</button>
          </div>
        </div>
      </div>
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
        v-for="n in renderNodes"
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
          v-if="hasOutPort(n)"
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
            <span v-if="n.seq != null" class="cn-seq">#{{ n.seq }}</span>
            <Icon name="photo" :size="11" />
            <span class="cn-title">{{ n.title }}</span>
          </div>
        </template>

        <template v-else-if="n.kind === 'text'">
          <div class="cn-head">
            <span v-if="n.seq != null" class="cn-seq">#{{ n.seq }}</span>
            <Icon name="doc" :size="13" />
            <span class="cn-title">{{ n.title }}</span>
          </div>
          <div class="cn-prompt">{{ textBody(n) }}</div>
          <div v-if="n.readiness && !n.readiness.ready" class="cn-warn" :title="n.readiness.problems.join('；')">
            <Icon name="alert" :size="11" /> {{ n.readiness.problems.length }} 项未就绪
          </div>
        </template>

        <template v-else-if="n.kind === 'entity'">
          <div class="cn-head">
            <span v-if="n.seq != null" class="cn-seq">#{{ n.seq }}</span>
            <Icon name="users" :size="13" />
            <span class="cn-title">{{ n.title }}</span>
            <span v-if="n.entity" class="cn-kind">{{ kindText(n.entity.kind) }}</span>
          </div>
          <div v-if="entityThumb(n)" class="cn-media">
            <img :src="entityThumb(n)!" draggable="false" alt="" loading="lazy" />
          </div>
          <div class="cn-meta">参考图 {{ n.entity?.refCount ?? 0 }} 张</div>
          <div v-if="n.readiness && !n.readiness.ready" class="cn-warn" :title="n.readiness.problems.join('；')">
            <Icon name="alert" :size="11" /> {{ n.readiness.problems.length }} 项未就绪
          </div>
        </template>

        <template v-else-if="n.kind === 'run'">
          <div class="cn-head">
            <span v-if="n.seq != null" class="cn-seq">#{{ n.seq }}</span>
            <Icon name="play_circle" :size="13" />
            <span class="cn-title">{{ n.title }}</span>
            <span v-if="runText(n)" class="badge" :class="runCls(n)">{{ runText(n) }}</span>
          </div>
          <div class="cn-meta mono">{{ n.run?.templateKey ?? '运行缺失' }}</div>
          <div v-if="n.run" class="cn-meta mono">步骤 {{ n.run.steps.succeeded }}/{{ n.run.steps.total }}</div>
        </template>

        <template v-else>
          <div class="cn-head">
            <span v-if="n.seq != null" class="cn-seq">#{{ n.seq }}</span>
            <Icon :name="genIcon(n)" :size="13" />
            <span class="cn-title">{{ n.title }}</span>
            <span v-if="stText(n)" class="badge" :class="stCls(n)">{{ stText(n) }}</span>
          </div>
          <div class="cn-prompt" :title="promptTitle(n)">{{ specLine(n) }}</div>
          <div v-if="thumbOf(n)" class="cn-media">
            <img :src="thumbOf(n)!" draggable="false" alt="" loading="lazy" />
          </div>
          <div v-else-if="isAudio(n)" class="cn-media cn-audio">
            <Icon name="speaker-wave" :size="18" />
            <em>音频</em>
          </div>
          <div v-else-if="isTextAsset(n) || (isLlm(n) && n.status === 'succeeded')" class="cn-media cn-audio">
            <Icon name="doc" :size="18" />
            <em>文本产物</em>
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

    <!-- 框选矩形（视口坐标；左拖 = 框选，全包含判定） -->
    <div v-if="boxRect" class="cb-box" :style="boxStyle" />

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
      左拖框选 · 空格/中键拖平移 · 滚轮缩放 · 双击空白建节点 · 拖入素材 · Del 删除 · Ctrl+Z 撤销
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
  cursor: default;
  user-select: none;
  touch-action: none;
}

/* 平移模式（空格按住 / 中键拖）光标 */
.cb-viewport.grabbing {
  cursor: grab;
}

.cb-viewport.grabbing:active {
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

/* 框选矩形 */
.cb-box {
  position: absolute;
  border: 1px solid var(--accent-h);
  background: rgb(99 102 241 / 14%);
  border-radius: 2px;
  pointer-events: none;
  z-index: 3;
}

/* ---- [M18] 分组框与组条（spec §2.6⑩）---- */
.cgroup {
  position: absolute;
  box-sizing: border-box;
  border: 1.5px solid rgb(var(--cg, 148 163 184) / 55%);
  border-radius: 12px;
  background: rgb(var(--cg, 148 163 184) / 7%);
  pointer-events: none; /* 框体不拦截：穿框仍可点节点 / 空白框选 */
  z-index: 0;
}

.cgroup.sel {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.cgroup.collapsed {
  background: transparent;
}

.cgroup-bar {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  max-width: 100%;
  padding: 0 6px 0 3px;
  border-radius: 10px 0 10px 0;
  background: rgb(var(--cg, 100 116 139) / 92%);
  color: #fff;
  pointer-events: auto;
  cursor: grab;
  user-select: none;
}

.cgroup-tri {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.cgroup-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cgroup-rename {
  flex: 1;
  min-width: 40px;
  font-size: 12px;
  padding: 1px 4px;
  border: 1px solid rgb(255 255 255 / 55%);
  border-radius: 5px;
  background: rgb(255 255 255 / 92%);
  color: var(--text);
}

.cgroup-count {
  flex: none;
  font-size: 10.5px;
  font-weight: 700;
  background: rgb(255 255 255 / 22%);
  border-radius: 8px;
  padding: 0 6px;
  font-variant-numeric: tabular-nums;
}

.cgroup-menu-btn {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.cgroup-menu-btn:hover {
  background: rgb(255 255 255 / 22%);
}

.cgroup-menu {
  position: absolute;
  top: 26px;
  right: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 156px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 10px 26px rgb(0 0 0 / 30%);
  pointer-events: auto;
}

.cgroup-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.cgroup-colors .cgroup-dot {
  width: 15px;
  height: 15px;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 40%);
  border-radius: 50%;
  background: rgb(var(--cg, 148 163 184));
  cursor: pointer;
}

.cgroup-colors .cgroup-dot.cg-none {
  background: transparent;
  box-shadow: inset 0 0 0 1px rgb(148 163 184 / 60%);
}

.cgroup-colors .cgroup-dot.on {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.cgroup-act {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.cgroup-act:hover {
  border-color: var(--bad);
  color: var(--bad);
}

/* 分组配色（--cg = rgb 三元组；与后端白名单一致）*/
.cg-red { --cg: 239 68 68; }
.cg-orange { --cg: 249 115 22; }
.cg-amber { --cg: 245 158 11; }
.cg-yellow { --cg: 234 179 8; }
.cg-green { --cg: 34 197 94; }
.cg-teal { --cg: 20 184 166; }
.cg-blue { --cg: 59 130 246; }
.cg-purple { --cg: 168 85 247; }
.cg-pink { --cg: 236 72 153; }
.cg-gray { --cg: 107 114 128; }

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

/* 故事板序号徽标（[M17] seq） */
.cn-seq {
  flex: none;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--accent-h);
  background: rgb(99 102 241 / 14%);
  border-radius: 5px;
  padding: 1px 5px;
  font-variant-numeric: tabular-nums;
}

/* 实体类型徽标 */
.cn-kind {
  flex: none;
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0 5px;
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

/* 音频占位（无缩略图） */
.cn-audio {
  flex-direction: column;
  gap: 5px;
  color: var(--text-3);
}

.cn-audio em {
  font-size: 10.5px;
  font-style: normal;
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
