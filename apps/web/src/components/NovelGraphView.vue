<script setup lang="ts">
/**
 * 小说改编看板 · 段② 事件图谱（NovelBoard 拆分：纯重构，逻辑/模板/样式逐字搬移）
 * 表 ↔ SVG 视图切换（布局服务端算好，前端零计算）+ 拖拽 pan + 滚轮 zoom + 事件级编辑。
 * 依赖：props.board（读 graph.doc / graph.layout / graph.name / graph.asset_id）；保存后 emit('reload') 由父级拉取。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { assetApi } from '../lib/api'
import type { NovelBoardData, NovelBoardGraphDoc } from '../lib/types'
import Modal from './common/Modal.vue'
import Icon from './common/Icon.vue'

const props = defineProps<{ board: NovelBoardData | null }>()
const emit = defineEmits<{ reload: [] }>()

type NovelCharacter = NonNullable<
  NonNullable<NovelBoardGraphDoc['characters']>[number]
>
type NovelKeyEvent = NonNullable<
  NonNullable<NovelBoardGraphDoc['key_events']>[number]
>

const graph = computed(() => props.board?.graph?.doc ?? null)
const layout = computed(() => props.board?.graph?.layout ?? null)
const charList = computed<NovelCharacter[]>(() => graph.value?.characters ?? [])
const eventList = computed<NovelKeyEvent[]>(() => graph.value?.key_events ?? [])

// ---------- 图谱视图：表 ↔ SVG（布局服务端算好，前端零计算） ----------

const graphView = ref<'table' | 'svg'>('table')
/** 选中事件节点 id（'event:名'）：SVG 点击 → 表行高亮 */
const selectedEvent = ref('')
const nodeById = computed(
  () => new Map((layout.value?.nodes ?? []).map((n) => [n.id, n])),
)

/** 视口（viewBox 四元组；fit = 布局全幅，pan/zoom 只改这四个数） */
const vb = ref({ x: 0, y: 0, w: 800, h: 500 })
function resetView(): void {
  const L = layout.value
  if (!L) return
  vb.value = { x: 0, y: 0, w: L.width, h: L.height }
}
watch(layout, (L) => {
  selectedEvent.value = ''
  if (L) resetView()
})

let panning: { px: number; py: number; vx: number; vy: number } | null = null
function onPanDown(e: PointerEvent): void {
  panning = { px: e.clientX, py: e.clientY, vx: vb.value.x, vy: vb.value.y }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function onPanMove(e: PointerEvent): void {
  if (!panning) return
  const scale = vb.value.w / (e.currentTarget as HTMLElement).clientWidth
  vb.value = {
    ...vb.value,
    x: panning.vx - (e.clientX - panning.px) * scale,
    y: panning.vy - (e.clientY - panning.py) * scale,
  }
}
function onPanUp(): void {
  panning = null
}
function onWheel(e: WheelEvent): void {
  const L = layout.value
  if (!L) return
  e.preventDefault()
  const k = e.deltaY > 0 ? 1.15 : 1 / 1.15
  const w = Math.min(L.width * 4, Math.max(L.width * 0.15, vb.value.w * k))
  const h = w * (vb.value.h / vb.value.w)
  const cx = vb.value.x + vb.value.w / 2
  const cy = vb.value.y + vb.value.h / 2
  vb.value = { x: cx - w / 2, y: cy - h / 2, w, h }
}

function onNodeClick(id: string, kind: string): void {
  if (kind !== 'event') return
  selectedEvent.value = id
  graphView.value = 'table'
  void nextTick(() =>
    document
      .getElementById(`nb-ev-${id}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
  )
}

// ---------- 事件级编辑：结构化表单 → 序列化回 graph JSON → PATCH content ----------

const editIdx = ref(-1)
const editForm = ref({
  name: '',
  chapters: '',
  summary: '',
  intensity: 3,
  kind: '',
})
const editErr = ref('')
const editSaving = ref(false)

function startEditEvent(i: number): void {
  const ev = eventList.value[i]
  if (!ev) return
  editIdx.value = i
  editForm.value = {
    name: ev.name ?? '',
    chapters: (ev.chapters ?? []).join(', '),
    summary: ev.summary ?? '',
    intensity: typeof ev.intensity === 'number' ? ev.intensity : 3,
    kind: ev.kind ?? '',
  }
  editErr.value = ''
}

async function saveEventEdit(): Promise<void> {
  const doc = graph.value
  const gid = props.board?.graph?.asset_id
  if (!doc || !gid || editIdx.value < 0) return
  const name = editForm.value.name.trim()
  const chapters = editForm.value.chapters
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map(Number)
  if (!name) {
    editErr.value = '事件名不能为空'
    return
  }
  if (
    !chapters.length ||
    chapters.some((n) => !Number.isInteger(n) || n <= 0)
  ) {
    editErr.value = '涉及章需为逗号分隔的正整数（与保存服务端契约同口径）'
    return
  }
  editSaving.value = true
  editErr.value = ''
  try {
    const events = (doc.key_events ?? []).map((e, i) =>
      i === editIdx.value
        ? {
            ...e,
            name,
            chapters,
            summary: editForm.value.summary.trim(),
            intensity: Math.min(
              5,
              Math.max(1, Math.round(editForm.value.intensity) || 3),
            ),
            kind: editForm.value.kind.trim() || undefined,
          }
        : e,
    )
    await assetApi.updateContent(
      gid,
      JSON.stringify({ ...doc, key_events: events }, null, 2),
    )
    editIdx.value = -1
    emit('reload')
  } catch (e) {
    editErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    editSaving.value = false
  }
}
</script>

<template>
  <!-- 段② 事件图谱 -->
  <div v-if="graph" class="nb-sec">
    <div class="nb-shead">
      事件图谱
      <span v-if="board?.graph" class="muted">{{ board.graph.name }}</span>
      <span class="grow" />
      <!-- 视图切换（layout=null 脏 doc 降级：只留表视图） -->
      <div
        v-if="layout"
        class="nb-seg"
        role="tablist"
        aria-label="图谱视图切换"
      >
        <button
          class="nb-segb"
          :class="{ on: graphView === 'table' }"
          @click="graphView = 'table'"
        >
          表
        </button>
        <button
          class="nb-segb"
          :class="{ on: graphView === 'svg' }"
          @click="graphView = 'svg'"
        >
          图形
        </button>
      </div>
    </div>
    <p v-if="graph.overview" class="nb-overview">{{ graph.overview }}</p>
    <div v-if="charList.length" class="nb-chars">
      <div v-for="(ch, i) in charList" :key="`${ch.name}-${i}`" class="nb-char">
        <div class="nb-crow">
          <span class="nb-cname">{{ ch.name ?? '—' }}</span>
          <span v-if="ch.role" class="nb-chip">{{ ch.role }}</span>
        </div>
        <div v-if="ch.arc" class="muted nb-arc" :title="ch.arc">
          {{ ch.arc }}
        </div>
      </div>
    </div>
    <!-- SVG 自绘：服务端坐标，fit + 拖拽 pan + 滚轮 zoom；事件节点点击→表行高亮 -->
    <div
      v-if="graphView === 'svg' && layout"
      class="nb-svgwrap"
      @pointerdown="onPanDown"
      @pointermove="onPanMove"
      @pointerup="onPanUp"
      @pointercancel="onPanUp"
      @wheel="onWheel"
    >
      <svg
        :viewBox="`${vb.x} ${vb.y} ${vb.w} ${vb.h}`"
        class="nb-svg"
        :aria-label="`事件图谱，${layout.nodes.length} 个节点`"
      >
        <line
          v-for="(l, i) in layout.links"
          :key="`lk-${i}`"
          :x1="nodeById.get(l.source)?.x"
          :y1="nodeById.get(l.source)?.y"
          :x2="nodeById.get(l.target)?.x"
          :y2="nodeById.get(l.target)?.y"
          class="nb-edge"
          :class="l.kind"
        />
        <g
          v-for="n in layout.nodes"
          :key="n.id"
          class="nb-node"
          :class="[n.kind, { sel: selectedEvent === n.id }]"
          @click.stop="onNodeClick(n.id, n.kind)"
        >
          <circle :cx="n.x" :cy="n.y" :r="n.r" />
          <text :x="n.x" :y="n.y + n.r + 14">{{ n.label }}</text>
        </g>
      </svg>
      <button
        class="nb-fitbtn"
        title="重置缩放与平移"
        @click.stop="resetView()"
      >
        <Icon name="refresh" :size="12" /> 适应
      </button>
    </div>
    <div v-if="graphView === 'table' && eventList.length" class="nb-table ev">
      <div class="nb-tr nb-th">
        <span>#</span><span>事件</span><span>涉及章</span><span>强度</span
        ><span>类型</span><span />
      </div>
      <div
        v-for="(ev, i) in eventList"
        :id="`nb-ev-event:${ev.name}`"
        :key="ev.id ?? i"
        class="nb-tr"
        :class="{ 'nb-sel': selectedEvent === `event:${ev.name}` }"
        :title="ev.summary ?? ''"
      >
        <span class="mono muted">{{ ev.id ?? i + 1 }}</span>
        <span class="nb-ell">{{ ev.name ?? '—' }}</span>
        <span class="mono muted nb-ell">{{
          ev.chapters?.length ? ev.chapters.join(',') : '—'
        }}</span>
        <span class="nb-dots" :title="`强度 ${ev.intensity ?? '—'}/5`">
          <span
            v-for="n in 5"
            :key="n"
            class="nb-dot"
            :class="{ on: (ev.intensity ?? 0) >= n }"
          />
        </span>
        <span class="muted nb-ell">{{ ev.kind ?? '—' }}</span>
        <button
          class="nb-ico"
          title="编辑事件（结构化表单）"
          @click="startEditEvent(i)"
        >
          <Icon name="pencil" :size="12" />
        </button>
      </div>
    </div>
  </div>

  <!-- 事件级编辑：结构化表单 → 序列化回 graph JSON → PATCH content -->
  <Modal
    v-if="editIdx >= 0"
    title="编辑事件"
    :width="480"
    @close="editIdx = -1"
  >
    <label class="nb-fld">
      事件名
      <input v-model="editForm.name" type="text" placeholder="如：初遇" />
    </label>
    <label class="nb-fld">
      涉及章（逗号分隔正整数）
      <input v-model="editForm.chapters" type="text" placeholder="1, 3, 5" />
    </label>
    <label class="nb-fld">
      摘要
      <textarea
        v-model="editForm.summary"
        rows="3"
        placeholder="一句话概述该事件"
      />
    </label>
    <div class="nb-frow">
      <label class="nb-fld">
        强度（1–5）
        <input
          v-model.number="editForm.intensity"
          type="number"
          min="1"
          max="5"
          step="1"
        />
      </label>
      <label class="nb-fld">
        类型
        <input
          v-model="editForm.kind"
          type="text"
          placeholder="如：转折 / 高潮"
        />
      </label>
    </div>
    <div v-if="editErr" class="err-text">{{ editErr }}</div>
    <template #footer>
      <button class="btn" :disabled="editSaving" @click="editIdx = -1">
        取消
      </button>
      <button class="btn primary" :disabled="editSaving" @click="saveEventEdit">
        <Icon name="check" :size="13" /> {{ editSaving ? '保存中…' : '保存' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
/* ---------- 段容器 ---------- */
.nb-sec {
  margin-top: 4px;
}

.nb-shead {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  margin: 9px 0 5px;
}

.nb-shead .muted {
  font-weight: 400;
  font-size: 11.5px;
}

/* ---------- 通用表格（关键事件；与章节表同规则） ---------- */
.nb-table {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  overflow: hidden;
}

.nb-tr {
  display: grid;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-size: 12px;
  border-top: 1px solid var(--border);
  min-width: 0;
}

.nb-tr:first-child {
  border-top: none;
}

.nb-table.ev .nb-tr {
  grid-template-columns: 44px minmax(0, 1fr) 84px 62px 56px 30px;
}

.nb-th {
  color: var(--text-3);
  font-size: 11px;
  background: var(--code-bg);
}

.nb-tr:not(.nb-th):hover {
  background: rgb(148 163 184 / 6%);
}

.nb-ell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 事件图谱：overview / 角色卡 / 强度点 ---------- */
.nb-overview {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.6;
  margin: 4px 0 6px;
}

.nb-chars {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  margin: 6px 0;
}

.nb-char {
  border: 1px solid var(--border);
  background: var(--panel-2);
  border-radius: 10px;
  padding: 7px 9px;
  min-width: 0;
}

.nb-crow {
  display: flex;
  align-items: center;
  gap: 6px;
}

.nb-cname {
  font-weight: 600;
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nb-chip {
  flex: none;
  font-size: 10.5px;
  color: var(--accent-h);
  background: rgb(99 102 241 / 12%);
  border: 1px solid rgb(99 102 241 / 22%);
  border-radius: 999px;
  padding: 0 7px;
}

.nb-arc {
  font-size: 11.5px;
  line-height: 1.5;
  margin-top: 3px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.nb-dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.nb-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--border-strong);
}

.nb-dot.on {
  background: var(--accent-h);
}

/* ---------- 视图切换段控件 ---------- */
.nb-seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.nb-segb {
  border: none;
  background: var(--code-bg);
  color: var(--text-3);
  font-size: 11.5px;
  font-family: inherit;
  padding: 2px 10px;
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
}

.nb-segb + .nb-segb {
  border-left: 1px solid var(--border);
}

.nb-segb.on {
  color: var(--accent-h);
  background: rgb(99 102 241 / 12%);
}

/* ---------- SVG 图谱：fit + 拖拽 pan + 滚轮 zoom ---------- */
.nb-svgwrap {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  height: 360px;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}

.nb-svgwrap:active {
  cursor: grabbing;
}

.nb-svg {
  width: 100%;
  height: 100%;
  display: block;
  user-select: none;
}

.nb-edge {
  stroke: var(--border-strong);
  stroke-width: 1.5;
}

.nb-edge.sequence {
  stroke: var(--accent);
  stroke-width: 2;
  opacity: 0.75;
}

.nb-node {
  cursor: pointer;
}

.nb-node circle {
  stroke: var(--border-strong);
  stroke-width: 1.5;
  transition:
    stroke 0.15s,
    filter 0.15s;
}

.nb-node.event circle {
  fill: rgb(99 102 241 / 28%);
}

.nb-node.character circle {
  fill: rgb(148 163 184 / 22%);
}

.nb-node:hover circle,
.nb-node.sel circle {
  stroke: var(--accent-h);
  stroke-width: 2.5;
  filter: drop-shadow(0 0 6px rgb(99 102 241 / 45%));
}

.nb-node text {
  font-size: 12px;
  fill: var(--text-2);
  text-anchor: middle;
  pointer-events: none;
}

.nb-node.sel text {
  fill: var(--text);
  font-weight: 600;
}

.nb-fitbtn {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  background: var(--code-bg);
  color: var(--text-2);
  font-size: 11.5px;
  font-family: inherit;
  border-radius: 7px;
  padding: 3px 8px;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s;
}

.nb-fitbtn:hover {
  color: var(--accent-h);
  border-color: var(--accent);
}

/* SVG 选中事件 → 表行高亮 */
.nb-tr.nb-sel {
  background: rgb(99 102 241 / 12%);
  box-shadow: inset 2px 0 0 var(--accent-h);
}

/* ---------- 事件行编辑按钮 + 表单 ---------- */
.nb-ico {
  border: none;
  background: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--text-3);
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
}

.nb-ico:hover {
  color: var(--accent-h);
  background: var(--hover);
}

.nb-fld {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: var(--text-2);
  margin-bottom: 10px;
}

.nb-fld input,
.nb-fld textarea {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 12.5px;
  font-family: inherit;
  padding: 6px 9px;
}

.nb-fld input:focus,
.nb-fld textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.nb-frow {
  display: grid;
  grid-template-columns: 130px minmax(0, 1fr);
  gap: 10px;
}
</style>
