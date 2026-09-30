<script setup lang="ts">
/**
 * 创作画布渲染层（手绘零依赖；spec §2.5）
 * - 世界层 translate(pan) scale(zoom)；边 = SVG 三次贝塞尔；节点 = 绝对定位卡片（宽 220）
 * - 模式机：box（空白左键框选）/ pan（空格+左键 / 中键）/ node（多选整组拖拽）/ link（输出口→输入口）
 * - 键盘：Del 删除 · Ctrl+Z/Y 撤销重做 · Ctrl+D 复制 · Ctrl+A 全选 · 方向键微移 · 空格平移 · F 适应 · Esc 取消
 * - 落点：空白双击建生成节点；drop 文件由父级上传后建素材节点（本组件只报世界坐标与文件）
 * - 视口：useBoardViewport（初始 = 画布持久化；settled 后 emit，父级防抖 PATCH）
 * - 选择模型破坏性变更：空白左键拖 = 框选（全包含判定）；平移改空格/中键（spec §2.4，README 明示）
 * - 渲染虚拟化：renderNodes / edgePaths 按可见世界矩形裁剪（半屏外扩；尺寸未实测 → 全量兜底）；
 *   几何计算与交互仍用全量 props.nodes（框选 / Ctrl+A / 方向键保真，spec §2.2）
 * - 缩放栏 / 操作指南悬浮件拆至 BoardHud.vue（行为零变更）
 */
import { computed, ref } from 'vue'
import { useBoardViewport } from '../../../lib/board-viewport'
import type { CanvasDocNode, CanvasGroup } from '../../../lib/types'
import { DEFAULT_H, NODE_W, PAD, bezier } from './internals'
import type { BoardEmits, BoardProps, EdgePath } from './internals'
import BoardHud from './BoardHud.vue'
import EdgeLayer from './EdgeLayer.vue'
import NodeLayer from './NodeLayer.vue'
import { useBoardInteractions } from './use-board-interactions'

const props = defineProps<BoardProps>()
const emit = defineEmits<BoardEmits>()

// ---- 视口 ----
const vp = useBoardViewport({
  initial: props.initialViewport,
  onSettled: (v) => emit('viewport-settled', v),
})
const { viewportEl, pan, zoom, onWheel, viewW, viewH } = vp

/** 背景点阵网格：铺满整个视口并随 pan/zoom 同步（世界层 width/height=0，网格挂世界上不可见） */
const gridStyle = computed(() => ({
  backgroundImage: `radial-gradient(circle, rgb(148 163 184 / 15%) ${
    1 * zoom.value
  }px, transparent ${1.3 * zoom.value}px)`,
  backgroundSize: `${26 * zoom.value}px ${26 * zoom.value}px`,
  backgroundPosition: `${pan.value.x}px ${pan.value.y}px`,
}))

// ---- 数据索引与位置 ----
const nodeById = computed(() => new Map(props.nodes.map((n) => [n.id, n])))

function nodeXY(n: CanvasDocNode): { x: number; y: number } {
  const d = dragGroup.value
  if (d?.moved && d.ids.includes(n.id)) return { x: n.x + d.dx, y: n.y + d.dy }
  return { x: n.x, y: n.y }
}
function nodeStyle(n: CanvasDocNode): Record<string, string> {
  const p = nodeXY(n)
  const h = nodeHeights.value[n.id]
  return {
    left: `${p.x}px`,
    top: `${p.y}px`,
    width: `${NODE_W}px`,
    ...(h ? {} : { minHeight: `${DEFAULT_H}px` }),
  }
}

/** 节点实测高度（边锚点 / 包围盒；ResizeObserver 式 ref 回调，值同则不动避免循环） */
const nodeHeights = ref<Record<number, number>>({})
function setNodeEl(id: number, el: unknown): void {
  const h = (el as HTMLElement | null)?.offsetHeight
  if (h && nodeHeights.value[id] !== h)
    nodeHeights.value = { ...nodeHeights.value, [id]: h }
}
function nodeH(n: CanvasDocNode): number {
  return nodeHeights.value[n.id] ?? DEFAULT_H
}

// ---- 分组：嵌套递归派生 / 折叠隐藏 / 包围盒 / 组条交互 ----
/** 直接子组 */
function childGroupsOf(gid: number): CanvasGroup[] {
  return props.groups.filter((g) => g.parentId === gid)
}
/** 全部后代组 id（不含自身；栈式遍历 + 守卫防环） */
function descGroupIds(gid: number): number[] {
  const out: number[] = []
  const stack = [gid]
  let guard = 0
  while (stack.length && guard < 1000) {
    const cur = stack.pop() as number
    for (const c of childGroupsOf(cur)) {
      out.push(c.id)
      stack.push(c.id)
    }
    guard += 1
  }
  return out
}
/** 组子树全部成员节点（自身直接成员 + 全部后代组成员） */
function descendantNodesOf(gid: number): CanvasDocNode[] {
  const gset = new Set([gid, ...descGroupIds(gid)])
  return props.nodes.filter((n) => n.groupId != null && gset.has(n.groupId))
}
function descNodeIds(gid: number): number[] {
  return descendantNodesOf(gid).map((n) => n.id)
}
/** 组渲染深度（顶层 0；父链守卫防环） */
function groupDepth(g: CanvasGroup): number {
  let d = 0
  let cur = g.parentId
  let guard = 0
  while (cur != null && guard < 100) {
    d += 1
    cur = props.groups.find((x) => x.id === cur)?.parentId ?? null
    guard += 1
  }
  return d
}
/** 折叠组隐藏全部后代组框（父组折叠 → 整个子树收起，含子组） */
const hiddenGroupIds = computed<Set<number>>(() => {
  const s = new Set<number>()
  for (const g of props.groups) {
    if (!g.collapsed) continue
    for (const x of descGroupIds(g.id)) s.add(x)
  }
  return s
})
/** 渲染顺序：嵌套深度升序（祖先背景先画、后代后画；同深度保持原序）；折叠组的后代组框跳过 */
const renderGroups = computed(() =>
  [...props.groups]
    .filter((g) => !hiddenGroupIds.value.has(g.id))
    .sort((a, b) => groupDepth(a) - groupDepth(b)),
)
const hiddenNodeIds = computed<Set<number>>(() => {
  const s = new Set<number>()
  // 折叠组隐藏自身成员 + 全部后代组成员
  const gset = new Set<number>()
  for (const g of props.groups) {
    if (!g.collapsed) continue
    gset.add(g.id)
    for (const x of descGroupIds(g.id)) gset.add(x)
  }
  if (!gset.size) return s
  for (const n of props.nodes)
    if (n.groupId != null && gset.has(n.groupId)) s.add(n.id)
  return s
})
function isNodeHidden(n: CanvasDocNode): boolean {
  return hiddenNodeIds.value.has(n.id)
}
/** 虚拟化可见世界矩形（半屏外扩 VIEW_MARGIN；尺寸未实测 → null 全量兜底，spec §2.2） */
const VIEW_MARGIN = 0.5
const visibleWorld = computed<{
  x1: number
  y1: number
  x2: number
  y2: number
} | null>(() => {
  const vw = viewW.value
  const vh = viewH.value
  if (!vw || !vh) return null
  const x1 = -pan.value.x / zoom.value
  const y1 = -pan.value.y / zoom.value
  const x2 = (vw - pan.value.x) / zoom.value
  const y2 = (vh - pan.value.y) / zoom.value
  const mx = (x2 - x1) * VIEW_MARGIN
  const my = (y2 - y1) * VIEW_MARGIN
  return { x1: x1 - mx, y1: y1 - my, x2: x2 + mx, y2: y2 + my }
})
/** 节点矩形 × 可见矩形相交判定（不可见节点高度兜底 DEFAULT_H） */
function inView(n: CanvasDocNode): boolean {
  const r = visibleWorld.value
  if (!r) return true
  const p = nodeXY(n)
  return (
    p.x + NODE_W >= r.x1 && p.x <= r.x2 && p.y + nodeH(n) >= r.y1 && p.y <= r.y2
  )
}
const renderNodes = computed(() =>
  props.nodes.filter((n) => isNodeHidden(n) === false && inView(n)),
)
/** 空子树组锚点（拖拽中随 dragGroup 即时偏移） */
function groupAnchor(g: CanvasGroup): { x: number; y: number } {
  const d = dragGroup.value
  if (d?.moved && d.gids?.includes(g.id))
    return { x: g.x + d.dx, y: g.y + d.dy }
  return { x: g.x, y: g.y }
}
/** 组包围盒（世界坐标；递归成员实测尺寸 + 顶部组条空间；空子树用锚点默认 240×120） */
function groupBox(g: CanvasGroup): {
  x: number
  y: number
  w: number
  h: number
} {
  const ms = descendantNodesOf(g.id)
  if (ms.length === 0) {
    const a = groupAnchor(g)
    return { x: a.x, y: a.y, w: 240, h: 120 }
  }
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
  return {
    x: minX - 12,
    y: minY - 34,
    w: maxX - minX + 24,
    h: maxY - minY + 46,
  }
}
function groupFrameStyle(g: CanvasGroup): Record<string, string> {
  const b = groupBox(g)
  if (g.collapsed)
    return { left: `${b.x}px`, top: `${b.y}px`, width: '220px', height: '32px' }
  return {
    left: `${b.x}px`,
    top: `${b.y}px`,
    width: `${b.w}px`,
    height: `${b.h}px`,
  }
}
function isGroupSelected(g: CanvasGroup): boolean {
  const ms = descendantNodesOf(g.id)
  return ms.length > 0 && ms.every((n) => props.selectedIds.includes(n.id))
}
const editingGroupId = ref<number | null>(null)
const editingTitle = ref('')
const openGroupMenu = ref<number | null>(null)
const GROUP_COLORS = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'gray',
]
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
// 移组：候选 = 同画布非自身非后代（防环）；null = 提升顶层
function parentCandidates(g: CanvasGroup): CanvasGroup[] {
  const bad = new Set([g.id, ...descGroupIds(g.id)])
  return props.groups.filter((x) => !bad.has(x.id))
}
function moveIntoGroup(g: CanvasGroup, parent: CanvasGroup): void {
  emit('group-patch', g.id, { parentId: parent.id })
  openGroupMenu.value = null
}
function moveToTopLevel(g: CanvasGroup): void {
  emit('group-patch', g.id, { parentId: null })
  openGroupMenu.value = null
}

// ---- 边路径（锚点：源右中 → 目标左中）----
const edgePaths = computed<EdgePath[]>(() => {
  const out: EdgePath[] = []
  // 虚拟化：任一端可见才渲染（两端均不可见 → 裁掉，spec §2.2）
  const visIds = new Set(renderNodes.value.map((n) => n.id))
  for (const e of props.edges) {
    const a = nodeById.value.get(e.from)
    const b = nodeById.value.get(e.to)
    if (!a || !b) continue
    if (hiddenNodeIds.value.has(e.from) || hiddenNodeIds.value.has(e.to))
      continue // 折叠组成员：相关边隐藏
    if (!visIds.has(e.from) && !visIds.has(e.to)) continue
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
  return {
    x: minX - PAD,
    y: minY - PAD,
    w: maxX - minX + PAD * 2,
    h: maxY - minY + PAD * 2,
  }
})

// ---- 交互（拆至：模式机/键盘/连线逻辑见 use-board-interactions.ts）----
const {
  mode,
  spaceDown,
  dragGroup,
  boxRect,
  boxStyle,
  linkFrom,
  hotPort,
  linkPath,
  onViewportPointerDown,
  onNodePointerDown,
  onOutPortPointerDown,
  onViewportPointerMove,
  onViewportPointerUp,
  onGroupBarPointerDown,
  onDblClick,
  onDragOver,
  onDrop,
  fitView,
  centerWorld,
  centerOn,
} = useBoardInteractions(props, emit, {
  vp,
  viewportEl,
  nodeById,
  nodeXY,
  nodeH,
  descNodeIds,
  descGroupIds,
  editingGroupId,
  openGroupMenu,
})

defineExpose({ fit: fitView, centerWorld, centerOn })
</script>

<template>
  <div
    ref="viewportEl"
    class="cb-viewport"
    :style="gridStyle"
    :class="{
      linking: linkFrom != null,
      grabbing: spaceDown || mode === 'pan',
    }"
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
      <!-- 分组层：递归包围盒框 + 顶部组条（折叠/重命名/改色/移组/解组；深度升序渲染）-->
      <div
        v-for="g in renderGroups"
        :key="`g${g.id}`"
        class="cgroup"
        :class="[
          g.color ? `cg-${g.color}` : '',
          { collapsed: g.collapsed, sel: isGroupSelected(g) },
        ]"
        :style="groupFrameStyle(g)"
      >
        <div
          class="cgroup-bar"
          @pointerdown="onGroupBarPointerDown($event, g)"
          @dblclick.stop="startRename(g)"
        >
          <button
            class="cgroup-tri"
            :title="g.collapsed ? '展开' : '折叠'"
            @pointerdown.stop
            @click.stop="toggleCollapse(g)"
          >
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
          <span class="cgroup-count">{{ descendantNodesOf(g.id).length }}</span>
          <button
            class="cgroup-menu-btn"
            title="组操作"
            @pointerdown.stop
            @click.stop="toggleGroupMenu(g)"
          >
            ⋯
          </button>
          <div
            v-if="openGroupMenu === g.id"
            class="cgroup-menu"
            @pointerdown.stop
            @dblclick.stop
          >
            <div class="cgroup-colors">
              <button
                class="cgroup-dot cg-none"
                :class="{ on: !g.color }"
                title="默认"
                @click="setGroupColor(g, null)"
              />
              <button
                v-for="c in GROUP_COLORS"
                :key="c"
                class="cgroup-dot"
                :class="[`cg-${c}`, { on: g.color === c }]"
                :title="c"
                @click="setGroupColor(g, c)"
              />
            </div>
            <button
              v-if="g.parentId != null"
              class="cgroup-act"
              @click="moveToTopLevel(g)"
            >
              移出到顶层
            </button>
            <div class="cgroup-h">移入组</div>
            <div class="cgroup-parents">
              <button
                v-for="p in parentCandidates(g)"
                :key="p.id"
                class="cgroup-act"
                @click="moveIntoGroup(g, p)"
              >
                {{ p.title }}
              </button>
              <div v-if="!parentCandidates(g).length" class="mini muted">
                无可选目标组
              </div>
            </div>
            <button class="cgroup-act" @click="ungroup(g)">解组</button>
          </div>
        </div>
      </div>

      <EdgeLayer
        :edge-paths="edgePaths"
        :link-path="linkPath"
        :svg-box="svgBox"
        @select-edge="emit('selectEdge', $event)"
      />
      <NodeLayer
        :render-nodes="renderNodes"
        :selected-ids="props.selectedIds"
        :hot-port="hotPort"
        :node-style="nodeStyle"
        :set-node-el="setNodeEl"
        @node-pointerdown="onNodePointerDown"
        @out-pointerdown="onOutPortPointerDown"
      />
    </div>

    <!-- 框选矩形（视口坐标；左拖 = 框选，全包含判定） -->
    <div v-if="boxRect" class="cb-box" :style="boxStyle" />

    <!-- 缩放栏 + 操作指南：拆至 BoardHud.vue（zoomBy/fitView 函数 props 直传） -->
    <BoardHud :zoom="zoom" :zoom-by="vp.zoomBy" :fit-view="fitView" />
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
  container: canvas-viewport / inline-size;
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
  will-change: transform;
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

/* ---- 分组框与组条（spec §2.6⑩）---- */
.cgroup {
  position: absolute;
  box-sizing: border-box;
  border: 1.5px solid rgb(var(--cg, 148 163 184) / 55%);
  border-radius: 12px;
  background: rgb(var(--cg, 148 163 184) / 7%);
  pointer-events: none; /* 框体不拦截：穿框仍可点节点 / 空白框选 */
  /* 不设 z-index：避免创建层叠上下文把菜单 z:5 锁在内部（被节点层盖住→点击穿透选节点）；组框仍按 DOM 序垫底 */
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

/* 移组区：小标题 + 候选列表（防溢出滚动） */
.cgroup-h {
  font-size: 11px;
  color: var(--text-3);
}

.cgroup-parents {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 132px;
  overflow-y: auto;
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
.cg-red {
  --cg: 239 68 68;
}
.cg-orange {
  --cg: 249 115 22;
}
.cg-amber {
  --cg: 245 158 11;
}
.cg-yellow {
  --cg: 234 179 8;
}
.cg-green {
  --cg: 34 197 94;
}
.cg-teal {
  --cg: 20 184 166;
}
.cg-blue {
  --cg: 59 130 246;
}
.cg-purple {
  --cg: 168 85 247;
}
.cg-pink {
  --cg: 236 72 153;
}
.cg-gray {
  --cg: 107 114 128;
}

.cb-viewport:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
</style>
