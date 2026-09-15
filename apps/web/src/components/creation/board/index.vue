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
import { computed, ref } from 'vue'
import { useBoardViewport } from '../../../lib/board-viewport'
import type { CanvasDocNode, CanvasGroup } from '../../../lib/types'
import Icon from '../../common/Icon.vue'
import { DEFAULT_H, NODE_W, PAD, bezier } from './internals'
import type { BoardEmits, BoardProps, EdgePath } from './internals'
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
const { viewportEl, pan, zoom, onWheel } = vp

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


// ---- 边路径（锚点：源右中 → 目标左中）----
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

// ---- 交互（M28 拆分：模式机/键盘/连线逻辑见 use-board-interactions.ts）----
const {
  mode, spaceDown, dragGroup, boxRect, boxStyle,
  linkFrom, hotPort, linkPath,
  onViewportPointerDown, onNodePointerDown, onOutPortPointerDown, onViewportPointerMove, onViewportPointerUp,
  onGroupBarPointerDown, onDblClick, onDragOver, onDrop,
  fitView, centerWorld, centerOn,
} = useBoardInteractions(props, emit, {
  vp, viewportEl, nodeById, nodeXY, nodeH, membersOf, editingGroupId, openGroupMenu,
})

defineExpose({ fit: fitView, centerWorld, centerOn })
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

      <EdgeLayer :edge-paths="edgePaths" :link-path="linkPath" :svg-box="svgBox" @select-edge="emit('selectEdge', $event)" />
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
