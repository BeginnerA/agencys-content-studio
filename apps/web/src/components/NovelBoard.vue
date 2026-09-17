<script setup lang="ts">
/**
 * [M9] 小说改编看板（spec §3.8）
 * 挂载：RunDetailView 步骤卡内（actionKey === 'text_split'）
 * 只读看板四段：① 章节表 ② 事件图谱 ③ 分集规划 ④ 改编剧本
 * 刷新约定：挂载拉取 + task.updated 防抖合并 + step 非终态 3s 轮询（终态即停）→ watch(step.status) 兜底
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { assetApi, novelApi } from '../lib/api'
import { taskStatus } from '../lib/format'
import type { StatusMeta } from '../lib/format'
import type {
  Asset, NovelBoardData, NovelBoardGraphDoc, NovelBoardPlanDoc, RunStep, TaskStatus,
} from '../lib/types'
import { studioOff, studioOn } from '../lib/socket'
import type { StudioEventMap } from '../lib/socket'
import AssetPreviewer from './asset/previewer/index.vue'
import Modal from './common/Modal.vue'
import Icon from './common/Icon.vue'

const props = defineProps<{ runId: number; step: RunStep }>()

const board = ref<NovelBoardData | null>(null)
const loading = ref(false)
const refreshing = ref(false)
const err = ref('')
let timer: number | undefined
let reloadTimer: number | undefined

type NovelCharacter = NonNullable<NonNullable<NovelBoardGraphDoc['characters']>[number]>
type NovelKeyEvent = NonNullable<NonNullable<NovelBoardGraphDoc['key_events']>[number]>
type NovelEpisode = NonNullable<NonNullable<NovelBoardPlanDoc['episodes']>[number]>

const split = computed(() => board.value?.split ?? null)
const chapters = computed(() => split.value?.chapters ?? [])
const manifest = computed(() => split.value?.manifest ?? null)
const graph = computed(() => board.value?.graph?.doc ?? null)
const plan = computed(() => board.value?.plan?.doc ?? null)
const charList = computed<NovelCharacter[]>(() => graph.value?.characters ?? [])
const eventList = computed<NovelKeyEvent[]>(() => graph.value?.key_events ?? [])
const episodes = computed<NovelEpisode[]>(() => plan.value?.episodes ?? [])
const scripts = computed(() => board.value?.scripts ?? [])
const events = computed(() => board.value?.events ?? null)

const summary = computed(() => {
  const m = manifest.value
  if (!m) return '等待切分产物'
  const parts = [`章节 ${m.selected ?? chapters.value.length}/${m.total ?? chapters.value.length}`]
  // [M25·G6] 多部合并摘要：N 部 · M 章
  if (m.per_source && m.books?.length) parts.unshift(`${m.books.length} 部 · ${m.total ?? chapters.value.length} 章`)
  if (events.value) {
    parts.push(`事件 ${events.value.done}/${events.value.total}${events.value.failed ? ` · 失败 ${events.value.failed}` : ''}`)
  }
  if (scripts.value.length) parts.push(`剧本 ${scripts.value.length} 集`)
  return parts.join(' · ')
})

const REGEX_SOURCE_TEXT: Record<string, string> = { user: '用户正则', ai: 'AI 正则', default: '默认识别' }
const regexSource = computed(() => {
  const s = manifest.value?.regex_source
  return s ? (REGEX_SOURCE_TEXT[s] ?? s) : null
})

const waitText = computed(() => {
  if (!board.value && loading.value) return '载入中…'
  const st = props.step.status
  if (st === 'failed') return '章节切分失败（详见步骤错误信息）'
  if (st === 'running') return '章节切分执行中…'
  if (st === 'waiting_input') return '等待审阅放行…'
  return '暂未产出章节（等待执行 / 产物缺失）'
})

/** 事件任务状态徽标（未知值 → 原样文本） */
function eventMeta(s: string): StatusMeta {
  return taskStatus(s as TaskStatus)
}

/** 集覆盖章展示（>6 章折叠为首尾区间） */
function epChaptersText(ep: NovelEpisode): string {
  const chs = ep.chapters ?? []
  if (!chs.length) return '—'
  if (chs.length > 6) return `${chs[0] ?? '?'}–${chs[chs.length - 1] ?? '?'}（${chs.length} 章）`
  return chs.join(',')
}

// ---------- 数据加载 ----------

async function load() {
  loading.value = true
  err.value = ''
  try {
    board.value = await novelApi.board(props.runId)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/** 手动刷新（头条按钮 busy 态，与后台轮询互不干扰） */
async function manualRefresh() {
  refreshing.value = true
  try {
    await load()
  } finally {
    refreshing.value = false
  }
}

// ---------- 实时刷新 ----------

/** 轮询停止条件（终态） */
const FINAL_STATUS = new Set(['succeeded', 'skipped', 'failed', 'cancelled'])

/** task.updated 高频 → 防抖合并刷新（500ms 尾沿；轮询与 step.status watch 兜底） */
function scheduleReload() {
  if (reloadTimer) window.clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(() => {
    reloadTimer = undefined
    void load()
  }, 500)
}

function onTaskUpdated(p: StudioEventMap['task.updated']) {
  if (p.runId !== props.runId) return
  scheduleReload()
}

onMounted(() => {
  void load()
  studioOn('task.updated', onTaskUpdated)
  timer = window.setInterval(() => {
    if (!FINAL_STATUS.has(props.step.status)) void load()
  }, 3000)
})

onBeforeUnmount(() => {
  studioOff('task.updated', onTaskUpdated)
  if (timer) window.clearInterval(timer)
  if (reloadTimer) window.clearTimeout(reloadTimer)
})

watch(
  () => props.step.status,
  () => {
    void load()
  },
)

// ---------- 产物预览（章节 / 剧本资产） ----------

const previewOpen = ref(false)
const previewAssets = ref<Asset[]>([])
const previewIndex = ref(0)
const previewBusy = ref(false)

async function openAsset(assetId: number) {
  if (!assetId || previewBusy.value) return
  previewBusy.value = true
  err.value = ''
  try {
    const { asset } = await assetApi.detail(assetId)
    previewAssets.value = [asset]
    previewIndex.value = 0
    previewOpen.value = true
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewBusy.value = false
  }
}

// ---------- [M25·G3] 图谱视图：表 ↔ SVG（布局服务端算好，前端零计算） ----------

const graphView = ref<'table' | 'svg'>('table')
const layout = computed(() => board.value?.graph?.layout ?? null)
/** 选中事件节点 id（'event:名'）：SVG 点击 → 表行高亮 */
const selectedEvent = ref('')
const nodeById = computed(() => new Map((layout.value?.nodes ?? []).map((n) => [n.id, n])))

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
  vb.value = { ...vb.value, x: panning.vx - (e.clientX - panning.px) * scale, y: panning.vy - (e.clientY - panning.py) * scale }
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
  void nextTick(() => document.getElementById(`nb-ev-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
}

// ---------- [M25·G5] 事件级编辑：结构化表单 → 序列化回 graph JSON → PATCH content ----------

const editIdx = ref(-1)
const editForm = ref({ name: '', chapters: '', summary: '', intensity: 3, kind: '' })
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
  const gid = board.value?.graph?.asset_id
  if (!doc || !gid || editIdx.value < 0) return
  const name = editForm.value.name.trim()
  const chapters = editForm.value.chapters.split(/[,，\s]+/).filter(Boolean).map(Number)
  if (!name) {
    editErr.value = '事件名不能为空'
    return
  }
  if (!chapters.length || chapters.some((n) => !Number.isInteger(n) || n <= 0)) {
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
            intensity: Math.min(5, Math.max(1, Math.round(editForm.value.intensity) || 3)),
            kind: editForm.value.kind.trim() || undefined,
          }
        : e,
    )
    await assetApi.updateContent(gid, JSON.stringify({ ...doc, key_events: events }, null, 2))
    editIdx.value = -1
    await load()
  } catch (e) {
    editErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    editSaving.value = false
  }
}
</script>

<template>
  <div class="nb">
    <!-- 头条：统计 + 正则来源徽标 + 刷新 -->
    <div class="nb-head">
      <span class="nb-title"><Icon name="doc" :size="13" /> 小说改编看板</span>
      <span class="muted nb-sum">{{ summary }}</span>
      <span v-if="regexSource" class="nb-tag" :class="manifest?.regex_source" title="章节切分正则来源">
        切分：{{ regexSource }}
      </span>
      <span class="grow" />
      <button class="btn sm" :disabled="refreshing" @click="manualRefresh">
        <Icon name="refresh" :size="12" :class="{ 'nb-rot': refreshing }" /> 刷新
      </button>
    </div>

    <div v-if="step.status === 'waiting_input'" class="nb-hint">
      <Icon name="clock" :size="12" /> 切分产物已就绪，等待审阅放行后进入事件提取
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>

    <div v-if="board && !board.found" class="empty nb-empty">该 run 无章节切分步骤</div>

    <div v-else-if="!split" class="nb-wait muted">
      <Icon name="clock" :size="12" /> {{ waitText }}
    </div>

    <template v-else>
      <!-- 段① 章节表 -->
      <div class="nb-sec">
        <div class="nb-shead">
          章节
          <span class="muted">
            {{ chapters.length }} 章<template v-if="manifest?.range"> · 范围 {{ manifest.range }}</template><template v-if="manifest?.reels?.length"> · {{ manifest.reels.length }} 卷</template>
          </span>
        </div>
        <div class="nb-table ch" :class="{ src: manifest?.per_source }">
          <div class="nb-tr nb-th">
            <span>#</span><span>标题</span><span>卷</span><template v-if="manifest?.per_source"><span>部</span></template><span class="nb-right">字数</span><span>事件</span>
          </div>
          <div v-for="c in chapters" :key="c.asset_id" class="nb-tr">
            <span class="mono muted">{{ c.index }}</span>
            <button
              class="nb-link"
              :title="c.name || `预览第 ${c.index} 章`"
              :disabled="previewBusy || !c.asset_id"
              @click="openAsset(c.asset_id)"
            >
              {{ c.title || `第${c.index}章` }}
            </button>
            <span class="muted nb-ell" :title="c.reel ?? ''">{{ c.reel ?? '—' }}</span>
            <span v-if="manifest?.per_source" class="muted nb-ell" :title="c.source_book ?? ''">{{ c.source_book ?? '—' }}</span>
            <span class="mono muted nb-right">{{ c.chars }}</span>
            <span>
              <span v-if="c.event_status" class="badge" :class="eventMeta(c.event_status).cls">
                {{ eventMeta(c.event_status).text }}
              </span>
              <span v-else class="muted">—</span>
            </span>
          </div>
        </div>
      </div>

      <!-- 段② 事件图谱 -->
      <div v-if="graph" class="nb-sec">
        <div class="nb-shead">
          事件图谱
          <span v-if="board?.graph" class="muted">{{ board.graph.name }}</span>
          <span class="grow" />
          <!-- [M25·G3] 视图切换（layout=null 脏 doc 降级：只留表视图） -->
          <div v-if="layout" class="nb-seg" role="tablist" aria-label="图谱视图切换">
            <button class="nb-segb" :class="{ on: graphView === 'table' }" @click="graphView = 'table'">表</button>
            <button class="nb-segb" :class="{ on: graphView === 'svg' }" @click="graphView = 'svg'">图形</button>
          </div>
        </div>
        <p v-if="graph.overview" class="nb-overview">{{ graph.overview }}</p>
        <div v-if="charList.length" class="nb-chars">
          <div v-for="(ch, i) in charList" :key="`${ch.name}-${i}`" class="nb-char">
            <div class="nb-crow">
              <span class="nb-cname">{{ ch.name ?? '—' }}</span>
              <span v-if="ch.role" class="nb-chip">{{ ch.role }}</span>
            </div>
            <div v-if="ch.arc" class="muted nb-arc" :title="ch.arc">{{ ch.arc }}</div>
          </div>
        </div>
        <!-- [M25·G3] SVG 自绘：服务端坐标，fit + 拖拽 pan + 滚轮 zoom；事件节点点击→表行高亮 -->
        <div
          v-if="graphView === 'svg' && layout"
          class="nb-svgwrap"
          @pointerdown="onPanDown"
          @pointermove="onPanMove"
          @pointerup="onPanUp"
          @pointercancel="onPanUp"
          @wheel="onWheel"
        >
          <svg :viewBox="`${vb.x} ${vb.y} ${vb.w} ${vb.h}`" class="nb-svg" :aria-label="`事件图谱，${layout.nodes.length} 个节点`">
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
          <button class="nb-fitbtn" title="重置缩放与平移" @click.stop="resetView()">
            <Icon name="refresh" :size="12" /> 适应
          </button>
        </div>
        <div v-if="graphView === 'table' && eventList.length" class="nb-table ev">
          <div class="nb-tr nb-th">
            <span>#</span><span>事件</span><span>涉及章</span><span>强度</span><span>类型</span><span />
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
            <span class="mono muted nb-ell">{{ ev.chapters?.length ? ev.chapters.join(',') : '—' }}</span>
            <span class="nb-dots" :title="`强度 ${ev.intensity ?? '—'}/5`">
              <span v-for="n in 5" :key="n" class="nb-dot" :class="{ on: (ev.intensity ?? 0) >= n }" />
            </span>
            <span class="muted nb-ell">{{ ev.kind ?? '—' }}</span>
            <button class="nb-ico" title="编辑事件（结构化表单）" @click="startEditEvent(i)">
              <Icon name="pencil" :size="12" />
            </button>
          </div>
        </div>
      </div>

      <!-- 段③ 分集规划 -->
      <div v-if="episodes.length" class="nb-sec">
        <div class="nb-shead">
          分集规划 <span class="muted">{{ episodes.length }} 集</span>
        </div>
        <div class="nb-eps">
          <div v-for="ep in episodes" :key="ep.ep ?? 0" class="nb-ep">
            <div class="nb-ephead">
              <span class="nb-epno mono">E{{ String(ep.ep ?? 0).padStart(2, '0') }}</span>
              <span class="nb-eptitle">{{ ep.title || `第 ${ep.ep ?? '?'} 集` }}</span>
              <span class="grow" />
              <span class="muted mono" :title="`覆盖章 ${(ep.chapters ?? []).join(', ')}`">章 {{ epChaptersText(ep) }}</span>
            </div>
            <div v-if="ep.synopsis" class="nb-syn">{{ ep.synopsis }}</div>
            <div v-if="ep.opening_hook" class="nb-hook">
              <span class="nb-hk">开钩</span><span class="nb-hkt">{{ ep.opening_hook }}</span>
            </div>
            <div v-if="ep.ending_hook" class="nb-hook end">
              <span class="nb-hk">尾钩</span><span class="nb-hkt">{{ ep.ending_hook }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 段④ 改编剧本 -->
      <div v-if="scripts.length" class="nb-sec">
        <div class="nb-shead">
          改编剧本 <span class="muted">{{ scripts.length }} 集</span>
        </div>
        <div class="nb-scripts">
          <button
            v-for="sc in scripts"
            :key="sc.asset_id"
            class="nb-script"
            :disabled="previewBusy"
            :title="`预览 ${sc.name}`"
            @click="openAsset(sc.asset_id)"
          >
            <Icon name="doc" :size="12" />
            <span class="nb-sname">{{ sc.name }}</span>
            <span v-if="sc.ep !== null" class="muted mono">E{{ String(sc.ep).padStart(2, '0') }}</span>
          </button>
        </div>
      </div>
    </template>

    <AssetPreviewer v-if="previewOpen" :assets="previewAssets" :index="previewIndex" @close="previewOpen = false" @changed="(a: Asset) => { const i = previewAssets.findIndex((x) => x.id === a.id); if (i >= 0) previewAssets[i] = a }" />

    <!-- [M25·G5] 事件级编辑：结构化表单 → 序列化回 graph JSON → PATCH content -->
    <Modal v-if="editIdx >= 0" title="编辑事件" :width="480" @close="editIdx = -1">
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
        <textarea v-model="editForm.summary" rows="3" placeholder="一句话概述该事件" />
      </label>
      <div class="nb-frow">
        <label class="nb-fld">
          强度（1–5）
          <input v-model.number="editForm.intensity" type="number" min="1" max="5" step="1" />
        </label>
        <label class="nb-fld">
          类型
          <input v-model="editForm.kind" type="text" placeholder="如：转折 / 高潮" />
        </label>
      </div>
      <div v-if="editErr" class="err-text">{{ editErr }}</div>
      <template #footer>
        <button class="btn" :disabled="editSaving" @click="editIdx = -1">取消</button>
        <button class="btn primary" :disabled="editSaving" @click="saveEventEdit">
          <Icon name="check" :size="13" /> {{ editSaving ? '保存中…' : '保存' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.nb {
  margin-top: 10px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.nb-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}

.nb-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}

.nb-sum {
  font-size: 12px;
}

/* 正则来源徽标三态：user=ok / ai=accent / default=素色 */
.nb-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  border-radius: 999px;
  padding: 1px 9px;
  border: 1px solid var(--border);
  background: var(--code-bg);
  color: var(--text-3);
}

.nb-tag.user {
  color: var(--ok);
  background: var(--ok-weak);
  border-color: rgb(34 197 94 / 22%);
}

.nb-tag.ai {
  color: var(--accent-h);
  background: rgb(99 102 241 / 12%);
  border-color: rgb(99 102 241 / 24%);
}

.nb-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-weak);
  border: 1px solid rgb(245 158 11 / 20%);
  border-radius: 8px;
  padding: 5px 10px;
  margin: 6px 0;
}

.nb-wait {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  padding: 14px 0;
}

.nb-empty {
  padding: 14px 0;
}

.nb-rot {
  animation: nb-spin 0.9s linear infinite;
}

@keyframes nb-spin {
  to {
    transform: rotate(360deg);
  }
}

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

/* ---------- 通用表格（章节 / 关键事件） ---------- */
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

/* [M25·G6] 章节表：per_source 时加「部」列 */
.nb-table.ch .nb-tr {
  grid-template-columns: 36px minmax(0, 1fr) 92px 52px 64px;
}

.nb-table.ch.src .nb-tr {
  grid-template-columns: 36px minmax(0, 1fr) 80px 80px 52px 64px;
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

.nb-right {
  text-align: right;
}

.nb-ell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nb-link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent-h);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.15s;
}

.nb-link:hover {
  color: #fff;
  text-decoration: underline;
}

.nb-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  text-decoration: none;
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

/* ---------- 分集卡片 ---------- */
.nb-eps {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 8px;
}

.nb-ep {
  border: 1px solid var(--border);
  background: var(--panel-2);
  border-radius: 10px;
  padding: 8px 10px;
  min-width: 0;
  transition: border-color 0.15s;
}

.nb-ep:hover {
  border-color: var(--border-strong);
}

.nb-ephead {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.nb-epno {
  flex: none;
  font-size: 11px;
  color: var(--text-2);
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 6px;
}

.nb-eptitle {
  font-weight: 600;
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nb-ephead .muted {
  flex: none;
  font-size: 11px;
}

.nb-syn {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.55;
  margin-top: 5px;
}

.nb-hook {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.5;
  margin-top: 5px;
}

.nb-hk {
  flex: none;
  font-size: 10.5px;
  color: var(--warn);
  background: var(--warn-weak);
  border: 1px solid rgb(245 158 11 / 22%);
  border-radius: 6px;
  padding: 0 6px;
}

.nb-hook.end .nb-hk {
  color: var(--accent-h);
  background: rgb(99 102 241 / 12%);
  border-color: rgb(99 102 241 / 24%);
}

.nb-hkt {
  min-width: 0;
}

/* ---------- 剧本列表 ---------- */
.nb-scripts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.nb-script {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  border-radius: 8px;
  padding: 5px 10px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.nb-script:hover {
  border-color: var(--accent);
  color: var(--accent-h);
}

.nb-script:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.nb-sname {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .nb-rot {
    animation: none;
  }

  .nb-ep,
  .nb-link,
  .nb-script {
    transition: none;
  }
}

/* ---------- [M25·G3] 视图切换段控件 ---------- */
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
  transition: color 0.15s, background 0.15s;
}

.nb-segb + .nb-segb {
  border-left: 1px solid var(--border);
}

.nb-segb.on {
  color: var(--accent-h);
  background: rgb(99 102 241 / 12%);
}

/* ---------- [M25·G3] SVG 图谱：fit + 拖拽 pan + 滚轮 zoom ---------- */
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
  transition: stroke 0.15s, filter 0.15s;
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
  transition: color 0.15s, border-color 0.15s;
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

/* ---------- [M25·G5] 事件行编辑按钮 + 表单 ---------- */
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
  transition: color 0.15s, background 0.15s;
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
