<script setup lang="ts">
import { onMounted, ref, computed, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Modal from '../components/Modal.vue'
import Icon from '../components/Icon.vue'
import AssetGrid from '../components/AssetGrid.vue'
import RunFormModal from '../components/RunFormModal.vue'
import BatchFormModal from '../components/BatchFormModal.vue'
import ProjectDangerModal from '../components/ProjectDangerModal.vue'
import ProjectFormModal from '../components/ProjectFormModal.vue'
import PublishModal from '../components/PublishModal.vue'
import { batchApi, projectApi, publicationApi, templateApi, uploadFiles } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import { schedulePendingRefresh } from '../lib/pending'
import type { Asset, Batch, ProjectDetail, Publication, Run, TemplateMeta } from '../lib/types'
import { runStatus, fmtTime, fmtMs, fmtQty, purposeText, batchStatus, inputSummary, PLATFORM_TEXT } from '../lib/format'
import { getSocket, studioOff, studioOn } from '../lib/socket'

const route = useRoute()
const router = useRouter()
const projectId = Number(route.params.id)

// ===== 页内 Tab（?tab= 深链接，默认「运行」） =====
const TABS = [
  { key: 'runs', label: '运行', icon: 'bolt' },
  { key: 'assets', label: '资产', icon: 'photo' },
  { key: 'pubs', label: '发布', icon: 'external' },
] as const
type TabKey = (typeof TABS)[number]['key']

function initTab(): TabKey {
  const q = route.query.tab
  return typeof q === 'string' && TABS.some((t) => t.key === q) ? (q as TabKey) : 'runs'
}

const activeTab = ref<TabKey>(initTab())

function switchTab(t: TabKey) {
  activeTab.value = t
  void router.replace({ query: t === 'runs' ? {} : { tab: t } })
}

// 浏览器前进/后退同步 Tab
watch(
  () => route.query.tab,
  () => {
    const t = initTab()
    if (t !== activeTab.value) activeTab.value = t
  },
)

// ===== 数据：核心（项目/运行/批次）、资产、发布 分组加载，错误互不拖累 =====
const project = ref<ProjectDetail | null>(null)
const runs = ref<Run[]>([])
const batches = ref<Batch[]>([])
const assets = ref<Asset[]>([])
const pubs = ref<Publication[]>([])
const pubSummary = ref({ views: 0, interactions: 0 })

const coreLoading = ref(true)
// 资产列表延迟到「资产」Tab 首次激活时加载（初始不进入加载态）
const assetLoading = ref(false)
const assetTotal = ref(0)
const pubLoading = ref(true)
const coreErr = ref('')
const assetErr = ref('')
const pubErr = ref('')

async function loadCore(opts: { silent?: boolean } = {}) {
  if (!opts.silent) coreLoading.value = true
  coreErr.value = ''
  try {
    const [p, r, b] = await Promise.all([
      projectApi.detail(projectId),
      projectApi.runs(projectId),
      batchApi.list(`?project_id=${projectId}`),
    ])
    // 接口返回 { project } 包装（与 runApi.detail 同构）
    project.value = p.project
    runs.value = r.items
    batches.value = b.items
  } catch (e) {
    coreErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    coreLoading.value = false
  }
}

let assetsLoaded = false

async function loadAssets(opts: { silent?: boolean } = {}) {
  if (!opts.silent) assetLoading.value = true
  assetErr.value = ''
  try {
    const a = await projectApi.assets(projectId, `?limit=${ASSET_LIMIT}`)
    assets.value = a.items
    assetTotal.value = a.total
    assetsLoaded = true
  } catch (e) {
    assetErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    assetLoading.value = false
  }
}

async function loadPubs(opts: { silent?: boolean } = {}) {
  if (!opts.silent) pubLoading.value = true
  pubErr.value = ''
  try {
    const pub = await publicationApi.list(`?project_id=${projectId}`)
    pubs.value = pub.items
    pubSummary.value = pub.summary
  } catch (e) {
    pubErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    pubLoading.value = false
  }
}

onMounted(() => {
  void loadCore()
  // 资产列表延迟加载：默认「运行」Tab 用不到；深链接 ?tab=assets 时立即拉取
  if (activeTab.value === 'assets') void loadAssets()
  void loadPubs()
  void loadTplMetas()
  const s = getSocket()
  s.emit('join', `project:${projectId}`)
  // 事件定向刷新：step 事件只刷运行区（高频）；run 终态追加刷资产区（可能新增产物）；
  // run.gate（进入闸门）立即刷新——页内 banner 与侧栏待审阅角标同步
  const onStep = () => {
    void loadCore({ silent: true })
    schedulePendingRefresh()
  }
  const onSettled = () => {
    void loadCore({ silent: true })
    // 资产区仅在已加载过后才跟随刷新（未打开过则不触发无谓请求）
    if (assetsLoaded) void loadAssets({ silent: true })
    schedulePendingRefresh()
  }
  const onGate = () => {
    void loadCore({ silent: true })
    schedulePendingRefresh()
  }
  studioOn('run.step', onStep)
  studioOn('run.completed', onSettled)
  studioOn('run.failed', onSettled)
  studioOn('run.gate', onGate)
  onBeforeUnmount(() => {
    studioOff('run.step', onStep)
    studioOff('run.completed', onSettled)
    studioOff('run.failed', onSettled)
    studioOff('run.gate', onGate)
    s.emit('leave', `project:${projectId}`)
  })
})

// 「资产」Tab 首次激活时懒加载（此后常驻；刷新按钮与 run 终态事件兜底更新）
watch(activeTab, (t) => {
  if (t === 'assets' && !assetsLoaded) void loadAssets()
})

// ===== 运行筛选 / 分页（前端分页；接口上限 100 在页脚明示） =====
const RUN_FILTERS = [
  { v: 'all', t: '全部' },
  { v: 'waiting', t: '待审阅' },
  { v: 'active', t: '进行中' },
  { v: 'completed', t: '已完成' },
  { v: 'failed', t: '失败' },
  { v: 'cancelled', t: '已取消' },
] as const
type RunFilter = (typeof RUN_FILTERS)[number]['v']

const RUN_LIMIT = 100
const BATCH_LIMIT = 100
const PAGE_SIZE = 20
// ?filter= 深链接（项目卡片待审阅角标直达；页内切换筛选不回写 URL）
function initFilter(): RunFilter {
  const q = route.query.filter
  return typeof q === 'string' && RUN_FILTERS.some((f) => f.v === q) ? (q as RunFilter) : 'all'
}
const runFilter = ref<RunFilter>(initFilter())
const rowPage = ref(1)

/** 状态匹配（筛选作用于运行记录；批次行在其批内有匹配记录时入列） */
function runMatch(r: Run, f: RunFilter): boolean {
  if (f === 'all') return true
  if (f === 'waiting') return r.status === 'waiting_input'
  if (f === 'active') return r.status === 'queued' || r.status === 'running'
  return r.status === f
}

// ===== KPI 指标条 =====
const runningCount = computed(() => runs.value.filter((r) => r.status === 'running').length)
const waitingRuns = computed(() => runs.value.filter((r) => r.status === 'waiting_input'))
const assetCount = computed(() => project.value?.assetCount ?? assets.value.length)

/** 指标卡入口：切到「运行」并套用筛选 */
function gotoRuns(f: RunFilter) {
  runFilter.value = f
  switchTab('runs')
}

function cntOf(key: TabKey): number {
  if (key === 'runs') return runs.value.length
  if (key === 'assets') return assetCount.value
  return pubs.value.length
}

// ===== 批次与运行：合并为单一列表（批内运行并入批次行，按需展开） =====
/** 批内子运行按批次分组（升序：批内序号）；仅含加载窗口内记录 */
const childrenByBatch = computed(() => {
  const m = new Map<number, Run[]>()
  for (const r of runs.value) {
    if (r.batchId === null) continue
    const list = m.get(r.batchId)
    if (list) list.push(r)
    else m.set(r.batchId, [r])
  }
  for (const list of m.values()) list.sort((a, b) => (a.batchSeq ?? a.id) - (b.batchSeq ?? b.id))
  return m
})

const batchIdSet = computed(() => new Set(batches.value.map((b) => b.id)))

/** 独立运行（不属于已加载批次；批次在窗口外的孤儿运行也保留展示，避免记录消失） */
const standaloneRuns = computed(() =>
  runs.value.filter((r) => r.batchId === null || !batchIdSet.value.has(r.batchId)),
)

interface TopRow {
  kind: 'batch' | 'run'
  ts: number
  batch: Batch | null
  run: Run | null
}

/** 顶层级行：批次 + 独立运行，按创建时间倒序混排 */
const topRows = computed<TopRow[]>(() => {
  const f = runFilter.value
  const rows: TopRow[] = []
  for (const b of batches.value) {
    if (f === 'all' || (childrenByBatch.value.get(b.id) ?? []).some((r) => runMatch(r, f))) {
      rows.push({ kind: 'batch', ts: b.createdAt, batch: b, run: null })
    }
  }
  for (const r of standaloneRuns.value) {
    if (runMatch(r, f)) rows.push({ kind: 'run', ts: r.createdAt, batch: null, run: r })
  }
  return rows.sort((a, b) => b.ts - a.ts)
})

const rowPageCount = computed(() => Math.max(1, Math.ceil(topRows.value.length / PAGE_SIZE)))

/** 展开态批次的子运行（筛选生效时仅展示匹配项） */
function visibleChildren(b: Batch): Run[] {
  const list = childrenByBatch.value.get(b.id) ?? []
  const f = runFilter.value
  return f === 'all' ? list : list.filter((r) => runMatch(r, f))
}

const expanded = ref<Set<number>>(new Set())

function toggleBatch(id: number) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}

type DisplayRow =
  | { key: string; kind: 'batch'; batch: Batch }
  | { key: string; kind: 'child'; run: Run }
  | { key: string; kind: 'run'; run: Run }
  | { key: string; kind: 'note'; text: string; batchId: number }

/** 当前页显示行（展开的批内子运行与加载窗口提示行紧随批次行） */
const pagedRows = computed<DisplayRow[]>(() => {
  const out: DisplayRow[] = []
  for (const t of topRows.value.slice((rowPage.value - 1) * PAGE_SIZE, rowPage.value * PAGE_SIZE)) {
    if (t.kind === 'batch' && t.batch) {
      const b = t.batch
      out.push({ key: `b-${b.id}`, kind: 'batch', batch: b })
      if (!expanded.value.has(b.id)) continue
      const kids = visibleChildren(b)
      for (const r of kids) out.push({ key: `c-${r.id}`, kind: 'child', run: r })
      if (!kids.length) {
        out.push({
          key: `n-${b.id}`,
          kind: 'note',
          text: '批内运行不在加载窗口内（仅加载最近 100 次运行）',
          batchId: b.id,
        })
      } else if (runFilter.value === 'all' && kids.length < b.total) {
        out.push({ key: `n-${b.id}`, kind: 'note', text: `仅载入 ${kids.length}/${b.total} 项，更早记录见批次详情`, batchId: b.id })
      }
    } else if (t.run) {
      out.push({ key: `r-${t.run.id}`, kind: 'run', run: t.run })
    }
  }
  return out
})

watch(runFilter, () => {
  rowPage.value = 1
})

watch(topRows, () => {
  if (rowPage.value > rowPageCount.value) rowPage.value = rowPageCount.value
})

// ===== 资产筛选（接口上限 200 在网格下方明示） =====
const ASSET_LIMIT = 200
const purposeFilter = ref('all')

const purposes = computed(() => {
  const set = new Set(assets.value.map((a) => a.purpose))
  return ['all', ...set]
})

const filteredAssets = computed(() =>
  purposeFilter.value === 'all' ? assets.value : assets.value.filter((a) => a.purpose === purposeFilter.value),
)

// ===== 上传素材 =====
const showUpload = ref(false)
const uploadPurpose = ref('source')
const uploadFilesSel = ref<File[]>([])
const uploading = ref(false)
const uploadErr = ref('')

function onUploadChange(e: Event) {
  const input = e.target as HTMLInputElement
  uploadFilesSel.value = input.files ? Array.from(input.files) : []
}

async function doUpload() {
  if (!uploadFilesSel.value.length) return
  uploading.value = true
  uploadErr.value = ''
  try {
    await uploadFiles(projectId, uploadPurpose.value, uploadFilesSel.value)
    uploadFilesSel.value = []
    showUpload.value = false
    await loadAssets({ silent: true })
    await loadCore({ silent: true })
  } catch (e) {
    uploadErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    uploading.value = false
  }
}

// ===== 启动流水线 / 批量运行 =====
const showRunForm = ref(false)
const showBatch = ref(false)

function onRunCreated(runId: number) {
  showRunForm.value = false
  void loadCore({ silent: true })
  router.push(`/runs/${runId}`)
}

function onBatchCreated(batchId: number) {
  showBatch.value = false
  router.push(`/batches/${batchId}`)
}

// ===== 发布记录 =====
const showPublish = ref(false)
const editingPub = ref<Publication | null>(null)

/** 发布记录的资产名（复用已加载 assets；找不到回退 #id） */
function assetNameOf(id: number | null): string {
  if (id === null) return '—'
  return assets.value.find((a) => a.id === id)?.name ?? `#${id}`
}

function openPublish(pub: Publication | null) {
  editingPub.value = pub
  showPublish.value = true
}

async function removePub(pub: Publication) {
  const ok = await confirmDialog({
    title: '删除发布记录',
    message: `删除这条发布记录（${PLATFORM_TEXT[pub.platform] ?? pub.platform}）？`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await publicationApi.remove(pub.id)
    await loadPubs({ silent: true })
  } catch (e) {
    pubErr.value = e instanceof Error ? e.message : String(e)
  }
}

function onPubSaved() {
  showPublish.value = false
  void loadPubs({ silent: true })
}

// ===== [优化] 编辑项目 / 模板短名 =====
const showEdit = ref(false)
const tplMetas = ref<TemplateMeta[]>([])

// ===== 危险操作（归档 / 彻底删除） =====
const showDanger = ref(false)

/** 模板元数据静默加载（短名展示；失败回退裸 key） */
async function loadTplMetas() {
  try {
    const t = await templateApi.list()
    tplMetas.value = t.items
  } catch {
    // 静默
  }
}

/** 模板 key → 短名（未载/未知 key 回退原 key） */
function tplName(key: string): string {
  return tplMetas.value.find((t) => t.key === key)?.name ?? key
}

/** 默认模板透传给运行入口（启动/批量弹窗预选与徽章） */
const defaultTplKey = computed(() => project.value?.templateKey ?? undefined)

function onEdited() {
  showEdit.value = false
  void loadCore({ silent: true })
}

/** 归档 / 彻底删除完成：返回项目列表 */
function onDeleted() {
  showDanger.value = false
  void router.push('/')
}

/** runs 行内错误摘要 */
function errOf(r: Run): string {
  if (r.status !== 'failed') return ''
  const s = r.error ?? ''
  return s.length > 90 ? s.slice(0, 90) + '…' : s
}
</script>

<template>
  <div>
    <div class="page-h">
      <RouterLink to="/" class="back"><Icon name="arrow-left" :size="14" /> 项目</RouterLink>
      <h1>{{ project?.name ?? `项目 #${projectId}` }}</h1>
      <span v-if="project" class="badge" :class="project.status === 'active' ? 'completed' : 'cancelled'">
        {{ project.status === 'active' ? '进行中' : '已归档' }}
      </span>
      <span v-if="project?.templateKey" class="sub">默认模板：{{ tplName(project.templateKey) }}</span>
      <div style="margin-left: auto; display: flex; gap: 8px">
        <button class="btn" :disabled="!project" @click="showEdit = true">
          <Icon name="pencil" :size="14" /> 编辑
        </button>
        <button class="btn" @click="showUpload = true">
          <Icon name="upload" :size="14" /> 上传素材
        </button>
        <button class="btn" @click="showBatch = true">
          <Icon name="bolt" :size="14" /> 批量运行
        </button>
        <button class="btn primary" @click="showRunForm = true">
          <Icon name="bolt" :size="14" /> 启动流水线
        </button>
        <button
          class="btn"
          :disabled="!project"
          title="归档 / 彻底删除项目"
          aria-label="归档 / 彻底删除项目"
          @click="showDanger = true"
        >
          <Icon name="trash" :size="14" />
        </button>
      </div>
    </div>

    <div v-if="coreErr && !project" class="err-text">{{ coreErr }}</div>
    <div v-if="coreLoading && !project" class="empty">加载中…</div>

    <template v-if="project">
      <div class="brief muted">{{ project.brief }}</div>

      <!-- KPI 指标条：状态快照，点击直达对应筛选 / 分区 -->
      <div class="stat-strip">
        <button class="stat panel" type="button" title="按「进行中」查看运行" @click="gotoRuns('active')">
          <span class="v">{{ runningCount }}</span>
          <span class="k">运行中</span>
        </button>
        <button
          class="stat panel"
          :class="{ attention: waitingRuns.length > 0 }"
          type="button"
          title="按「待审阅」查看运行"
          @click="gotoRuns('waiting')"
        >
          <span class="v">{{ waitingRuns.length }}</span>
          <span class="k">待审阅</span>
        </button>
        <button class="stat panel" type="button" title="查看资产" @click="switchTab('assets')">
          <span class="v">{{ assetCount }}</span>
          <span class="k">资产</span>
        </button>
        <button class="stat panel" type="button" title="查看发布记录" @click="switchTab('pubs')">
          <span class="v">{{ pubs.length }}</span>
          <span class="k">已发布</span>
          <span v-if="pubSummary.views || pubSummary.interactions" class="extra">
            播放 {{ fmtQty(pubSummary.views) }} · 互动 {{ fmtQty(pubSummary.interactions) }}
          </span>
        </button>
      </div>

      <!-- 页内 Tab（?tab= 深链接） -->
      <div class="tabs" role="tablist" aria-label="项目分区">
        <button
          v-for="t in TABS"
          :id="`ptab-${t.key}`"
          :key="t.key"
          class="tab"
          role="tab"
          :aria-selected="activeTab === t.key"
          :class="{ on: activeTab === t.key }"
          @click="switchTab(t.key)"
        >
          <Icon :name="t.icon" :size="13" :strokeWidth="1.8" />
          {{ t.label }}
          <span class="cnt">{{ cntOf(t.key) }}</span>
        </button>
      </div>

      <!-- 运行 -->
      <section v-show="activeTab === 'runs'" role="tabpanel" aria-labelledby="ptab-runs">
        <!-- 待审阅置顶：唯一阻塞项，直达 gate 处理 -->
        <div v-if="waitingRuns.length" class="gate-banner panel">
          <div class="gb-h">
            <Icon name="clock" :size="14" />
            有 {{ waitingRuns.length }} 个运行等待审阅
          </div>
          <div v-for="r in waitingRuns" :key="r.id" class="gb-row">
            <span class="mono">Run #{{ r.id }}</span>
            <span class="muted">{{ tplName(r.templateKey) }}</span>
            <span class="muted">停在 {{ r.currentStepKey ?? '—' }}</span>
            <RouterLink class="gb-go" :to="`/runs/${r.id}`">去审阅 →</RouterLink>
          </div>
        </div>

        <div v-if="coreErr" class="err-text">{{ coreErr }}</div>

        <!-- 批次与运行：单表合并（批次行可展开批内运行；子运行并入批次行下） -->
        <div class="panel block">
          <div class="bh">
            <span class="bt">批次与运行</span>
            <span class="muted">{{ topRows.length }} 条记录</span>
            <select v-model="runFilter" class="filter" aria-label="按状态筛选运行">
              <option v-for="f in RUN_FILTERS" :key="f.v" :value="f.v">{{ f.t }}</option>
            </select>
          </div>
          <table class="tbl">
            <thead>
              <tr>
                <th>批次 / 运行</th>
                <th>状态</th>
                <th>模板</th>
                <th>摘要 / 进度</th>
                <th>时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in pagedRows" :key="row.key">
                <!-- 批次行：点击展开/收起批内运行，「详情 →」进批次页 -->
                <tr v-if="row.kind === 'batch'" class="rrow batch" @click="toggleBatch(row.batch.id)">
                  <td>
                    <button
                      class="bexp"
                      type="button"
                      :aria-expanded="expanded.has(row.batch.id)"
                      :aria-label="`展开或收起批次「${row.batch.name}」的批内运行`"
                      :title="expanded.has(row.batch.id) ? '收起批内运行' : '展开批内运行'"
                    >
                      <Icon name="chevron-right" :size="12" :stroke-width="2.2" />
                      <span class="bname">{{ row.batch.name }}</span>
                    </button>
                  </td>
                  <td><span class="badge" :class="batchStatus(row.batch.status).cls">{{ batchStatus(row.batch.status).text }}</span></td>
                  <td class="tkey">{{ tplName(row.batch.templateKey) }}</td>
                  <td class="mono muted">
                    {{ row.batch.finished }}/{{ row.batch.total }} 完成
                    <template v-if="row.batch.failed"> · <span class="em">失败 {{ row.batch.failed }}</span></template>
                    <template v-else-if="row.batch.succeeded"> · 成功 {{ row.batch.succeeded }}</template>
                  </td>
                  <td class="muted" style="white-space: nowrap">更新 {{ fmtTime(row.batch.updatedAt) }}</td>
                  <td @click.stop><RouterLink class="muted" :to="`/batches/${row.batch.id}`">详情 →</RouterLink></td>
                </tr>

                <!-- 批内子运行：缩进 + 批内序号，点击进运行详情 -->
                <tr v-else-if="row.kind === 'child'" class="rrow child" @click="router.push(`/runs/${row.run.id}`)">
                  <td class="mono cid">└ #{{ row.run.id }}</td>
                  <td><span class="badge" :class="row.run.status">{{ runStatus(row.run.status).text }}</span></td>
                  <td class="muted mono tkey">批内 #{{ row.run.batchSeq ?? '—' }}</td>
                  <td class="sum">
                    <span v-if="errOf(row.run)" class="em" :title="row.run.error ?? ''">{{ errOf(row.run) }}</span>
                    <span v-else class="muted">{{ inputSummary(row.run.input) }}</span>
                  </td>
                  <td class="muted" style="white-space: nowrap">
                    {{ fmtTime(row.run.startedAt ?? row.run.createdAt) }}
                    <template v-if="row.run.completedAt">→ {{ fmtTime(row.run.completedAt) }}</template>
                  </td>
                  <td><span class="muted">详情 →</span></td>
                </tr>

                <!-- 独立运行行 -->
                <tr v-else-if="row.kind === 'run'" class="rrow" @click="router.push(`/runs/${row.run.id}`)">
                  <td class="mono">{{ row.run.id }}</td>
                  <td><span class="badge" :class="row.run.status">{{ runStatus(row.run.status).text }}</span></td>
                  <td class="tkey">{{ tplName(row.run.templateKey) }}</td>
                  <td class="sum">
                    <span v-if="errOf(row.run)" class="em" :title="row.run.error ?? ''">{{ errOf(row.run) }}</span>
                    <span v-else-if="row.run.summary?.durationMs" class="muted">共 {{ row.run.summary.stepCount }} 步 · {{ fmtMs(row.run.summary.durationMs) }}</span>
                    <span v-else-if="row.run.status === 'running'" class="muted run-flash">执行中…</span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td class="muted" style="white-space: nowrap">
                    {{ fmtTime(row.run.startedAt ?? row.run.createdAt) }}
                    <template v-if="row.run.completedAt">→ {{ fmtTime(row.run.completedAt) }}</template>
                  </td>
                  <td><span class="muted">详情 →</span></td>
                </tr>

                <!-- 加载窗口提示行 -->
                <tr v-else-if="row.kind === 'note'">
                  <td colspan="6">
                    <div class="note">
                      {{ row.text }}
                      <RouterLink :to="`/batches/${row.batchId}`">批次详情 →</RouterLink>
                    </div>
                  </td>
                </tr>
              </template>
              <tr v-if="!pagedRows.length">
                <td colspan="6">
                  <div class="empty" style="padding: 18px 0">
                    {{ runs.length || batches.length ? '该筛选条件下暂无记录' : '尚未运行——点右上「启动流水线」开始' }}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="topRows.length > PAGE_SIZE" class="pager">
            <button class="btn sm" :disabled="rowPage <= 1" @click="rowPage--">上一页</button>
            <span class="muted mono">第 {{ rowPage }} / {{ rowPageCount }} 页</span>
            <button class="btn sm" :disabled="rowPage >= rowPageCount" @click="rowPage++">下一页</button>
          </div>
          <div v-if="runs.length >= RUN_LIMIT" class="muted trunc">仅显示最近 {{ RUN_LIMIT }} 次运行（接口上限）</div>
          <div v-if="batches.length >= BATCH_LIMIT" class="muted trunc">仅显示最近 {{ BATCH_LIMIT }} 个批次（接口上限）</div>
        </div>
      </section>

      <!-- 资产 -->
      <section v-show="activeTab === 'assets'" role="tabpanel" aria-labelledby="ptab-assets">
        <div class="panel block">
          <div class="bh">
            <span class="bt">资产</span>
            <span class="muted">{{ filteredAssets.length }} 个</span>
            <div style="margin-left: auto; display: flex; gap: 8px; align-items: center">
              <select v-model="purposeFilter" style="width: 150px" aria-label="按用途筛选资产">
                <option value="all">全部用途</option>
                <template v-for="p in purposes" :key="p">
                  <option v-if="p !== 'all'" :value="p">
                    {{ purposeText(p) }}
                  </option>
                </template>
              </select>
              <button class="btn sm" @click="loadAssets()">刷新</button>
            </div>
          </div>
          <div v-if="assetErr" class="err-text">{{ assetErr }}</div>
          <AssetGrid :assets="filteredAssets" :loading="assetLoading" />
          <div v-if="assetTotal > assets.length" class="muted trunc">仅显示前 {{ assets.length }} 个资产（共 {{ assetTotal }} 个）</div>
        </div>
      </section>

      <!-- 发布 -->
      <section v-show="activeTab === 'pubs'" role="tabpanel" aria-labelledby="ptab-pubs">
        <div class="panel block">
          <div class="bh">
            <span class="bt">发布记录</span>
            <span class="muted">已发布 {{ pubs.length }} 条 · 播放 {{ pubSummary.views }} · 互动 {{ pubSummary.interactions }}</span>
            <button class="btn sm" style="margin-left: auto" @click="openPublish(null)">
              <Icon name="plus" :size="12" :stroke-width="2.2" /> 标记发布
            </button>
          </div>
          <div v-if="pubErr" class="err-text">{{ pubErr }}</div>
          <div v-if="pubLoading && !pubs.length" class="empty" style="padding: 16px 0">加载中…</div>
          <table v-else-if="pubs.length" class="tbl">
            <thead>
              <tr>
                <th>平台</th>
                <th>资产</th>
                <th>日期</th>
                <th>播放 / 点赞 / 评论 / 收藏 / 转发</th>
                <th>链接</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="pub in pubs" :key="pub.id">
                <td><span class="badge">{{ PLATFORM_TEXT[pub.platform] ?? pub.platform }}</span></td>
                <td class="muted">{{ assetNameOf(pub.assetId) }}</td>
                <td class="muted">{{ pub.publishedAt ? fmtTime(pub.publishedAt) : '—' }}</td>
                <td class="mono" style="font-size: 12px">
                  {{ pub.metrics?.views ?? 0 }} / {{ pub.metrics?.likes ?? 0 }} / {{ pub.metrics?.comments ?? 0 }} /
                  {{ pub.metrics?.favorites ?? 0 }} / {{ pub.metrics?.shares ?? 0 }}
                </td>
                <td>
                  <a v-if="pub.url" :href="pub.url" target="_blank" rel="noopener"><Icon name="external" :size="12" /> 打开</a>
                  <span v-else class="muted">—</span>
                </td>
                <td>
                  <div class="ops">
                    <button class="btn sm" @click="openPublish(pub)">编辑</button>
                    <button class="btn sm danger" @click="removePub(pub)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty" style="padding: 16px 0">还没有发布记录——发布后回来登记，积累复盘数据</div>
        </div>
      </section>
    </template>

    <!-- 启动 run -->
    <RunFormModal
      v-if="showRunForm"
      :project-id="projectId"
      :default-template-key="defaultTplKey"
      @done="onRunCreated"
      @close="showRunForm = false"
    />

    <!-- 上传素材 -->
    <Modal v-if="showUpload" title="上传素材（入库为资产，sha256 去重）" :width="520" @close="showUpload = false">
      <label class="fld">
        用途
        <select v-model="uploadPurpose">
          <option value="source">素材 source（设定/参考底稿）</option>
          <option value="reference_character">角色参考 reference_character</option>
          <option value="brief">题材简报 brief</option>
          <option value="archive">归档 archive</option>
        </select>
      </label>
      <label class="fld">
        文件（可多选）
        <input type="file" multiple @change="onUploadChange" />
      </label>
      <div v-if="uploadFilesSel.length" class="muted">{{ uploadFilesSel.length }} 个文件待上传</div>
      <div v-if="uploadErr" class="err-text">{{ uploadErr }}</div>
      <template #footer>
        <button class="btn" @click="showUpload = false">取消</button>
        <button class="btn primary" :disabled="uploading || !uploadFilesSel.length" @click="doUpload">
          {{ uploading ? '上传中…' : '上传' }}
        </button>
      </template>
    </Modal>

    <!-- [M4] 批量创建 -->
    <BatchFormModal
      v-if="showBatch"
      :project-id="projectId"
      :default-template-key="defaultTplKey"
      @done="onBatchCreated"
      @close="showBatch = false"
    />

    <!-- [优化] 编辑项目 -->
    <ProjectFormModal v-if="showEdit && project" :project="project" @done="onEdited" @close="showEdit = false" />

    <!-- 危险操作：归档 / 彻底删除 -->
    <ProjectDangerModal
      v-if="showDanger && project"
      :project="project"
      @archived="onDeleted"
      @purged="onDeleted"
      @close="showDanger = false"
    />

    <!-- [M4] 标记发布 / 编辑回填 -->
    <PublishModal
      v-if="showPublish"
      :project-id="projectId"
      :asset-options="assets.map((a) => ({ id: a.id, name: a.name }))"
      :publication="editingPub"
      @done="onPubSaved"
      @close="showPublish = false"
    />
  </div>
</template>

<style scoped>
.brief {
  margin: -6px 0 16px;
}

/* ---------- KPI 指标条 ---------- */
.stat-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.stat {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  column-gap: 8px;
  row-gap: 1px;
  padding: 10px 14px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.12s;
}

.stat:hover {
  border-color: rgb(99 102 241 / 45%);
  transform: translateY(-1px);
}

.stat .v {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.stat .k {
  font-size: 12.5px;
  color: var(--text-2);
}

.stat .extra {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.stat.attention {
  border-color: rgb(245 158 11 / 45%);
  background: linear-gradient(180deg, var(--warn-weak), transparent 78%), var(--panel);
}

.stat.attention .v {
  color: var(--warn);
}

/* ---------- 页内 Tab（全局原语 .tabs / .tab / .cnt，此处仅补间距） ---------- */
.tabs {
  margin: 0 0 14px;
}

/* ---------- 待审阅置顶 ---------- */
.gate-banner {
  margin-bottom: 14px;
  padding: 10px 14px 8px;
  border-color: rgb(245 158 11 / 40%);
  background: linear-gradient(180deg, var(--warn-weak), transparent 82%), var(--panel);
}

.gb-h {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--warn);
}

.gb-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  padding: 3px 0 0 21px;
}

.gb-go {
  margin-left: auto;
  font-size: 12.5px;
}

/* ---------- 区块 ---------- */
.block {
  padding: 12px 16px 16px;
  margin-bottom: 18px;
}

.bh {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.bt {
  font-weight: 600;
  font-size: 14px;
}

.filter {
  margin-left: auto;
  width: 122px;
  padding: 3px 8px;
  font-size: 12px;
}

.rrow {
  cursor: pointer;
}

/* ---------- 批次行（可展开）/ 批内子运行行 ---------- */
.rrow.batch td {
  background: rgb(148 163 184 / 6%);
}

.rrow.batch:hover td {
  background: var(--hover);
}

.bexp {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.bexp .ic {
  color: var(--text-3);
  transition: transform 0.15s ease-out;
}

.bexp[aria-expanded='true'] .ic {
  transform: rotate(90deg);
}

.bname {
  font-weight: 600;
}

.child .cid {
  padding-left: 26px;
}

.tkey {
  font-size: 12px;
}

.note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  font-size: 12.5px;
  color: var(--text-3);
}

@media (prefers-reduced-motion: reduce) {
  .bexp .ic {
    transition: none;
  }
}

.sum {
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.em {
  color: var(--bad);
}

.run-flash {
  animation: blink 1.2s infinite;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 10px;
}

.trunc {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.ops {
  display: flex;
  gap: 6px;
}

@media (max-width: 860px) {
  .stat-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@keyframes blink {
  50% {
    opacity: 0.4;
  }
}
</style>
