<script setup lang="ts">
/**
 * [M15] 流水线画布页（spec §2.4）
 * - 模式：运行画布（?run=）/ 模板画布（?template=）/ [M23] 全景（?overview=1）；三 query 互斥 run > template > overview；均无 → 空态引导
 * - 数据：canvasApi.run / canvasApi.template / [M23] canvasApi.overview（项目级聚合）；socket 手动 join/leave run room（runId 可切换，不用 useStudio 单例）
 * - 实时：run.step / run.gate / run.completed / run.failed / task.updated / [M23] batch.updated → 350ms 防抖全量对账（按当前 tab 分派）
 * - 操作：顶栏取消/续跑/启动运行；[M23] 模板态画布内编辑（本地草稿层：拖拽连线/删边/Del 键 + 导出草案/保存为新模板）；节点抽屉操作 → refresh 立即重拉（全部复用既有端点）
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CanvasBoard from '../../components/pipeline-canvas/CanvasBoard.vue'
import CanvasDrawer from '../../components/pipeline-canvas/drawer/index.vue'
import OverviewPanel from '../../components/pipeline-canvas/overview/index.vue'
import Icon from '../../components/common/Icon.vue'
import RunFormModal from '../../components/run/RunFormModal.vue'
import CanvasGuide from './CanvasGuide.vue'
import CanvasDesignModals from './CanvasDesignModals.vue'
import { canvasApi, projectApi, runApi, templateApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import { fmtTime, runStatus, skipReasonText } from '../../lib/format'
import type {
  CanvasBoardNode, CanvasOverview, EditNodeState, Project, Run, RunCanvas, RunCanvasNode, StepOverride,
  TemplateCanvas, TemplateCanvasNode, TemplateMeta,
} from '../../lib/types'
import { useCanvasEdit } from './use-canvas-edit'
import { useCanvasDesign } from './use-canvas-design'
import { useCanvasRealtime } from './use-canvas-realtime'

const route = useRoute()
const router = useRouter()

// ===== 目标解析（route.query 为单一真源）=====
type TabKey = 'run' | 'template' | 'overview'
const tab = ref<TabKey>('run')
const runId = ref<number | null>(null)
const tplKey = ref<string | null>(null)
const empty = computed(() => runId.value == null && tplKey.value == null)

// ===== 数据层 =====
const runCanvas = ref<RunCanvas | null>(null)
const tplCanvas = ref<TemplateCanvas | null>(null)
/** [M23] 全景聚合（项目级；tab='overview' 时加载） */
const overview = ref<CanvasOverview | null>(null)
const overviewLoading = ref(false)
const loading = ref(false)
const err = ref('')

// ===== [M23] 画布内编辑（模板态本地草稿层；E3）=====
const edit = useCanvasEdit(tplCanvas)
const { editMode, dirty: editDirty, overriddenCount: editCount } = edit

// ===== 视图状态（数据全量替换时保留：选中/抽屉；pan/zoom 在 Board 内）=====
const selectedKey = ref<string | null>(null)
const drawerOpen = ref(false)
const boardRef = ref<InstanceType<typeof CanvasBoard> | null>(null)

// ===== 目录（顶栏下拉 + 空态引导）=====
const runs = ref<Run[]>([])
const tplMetas = ref<TemplateMeta[]>([])
const projects = ref<Project[]>([])
const listErr = ref('')
const projectId = ref<number | null>(null)
const showStart = ref(false)

function syncFromQuery(): void {
  const q = route.query
  const r = typeof q.run === 'string' && /^\d+$/.test(q.run) ? Number(q.run) : null
  const t = typeof q.template === 'string' && q.template ? q.template : null
  const ov = q.overview === '1'
  if (r != null) {
    tab.value = 'run'
    if (r !== runId.value) resetView()
    runId.value = r
    tplKey.value = null
    void loadRun()
  } else if (t != null) {
    tab.value = 'template'
    if (t !== tplKey.value) resetView()
    tplKey.value = t
    runId.value = null
    void loadTpl()
  } else if (ov) {
    // [M23] 全景：无画布目标（项目选择器仍复用顶栏 selProject）
    const wasOv = tab.value === 'overview'
    tab.value = 'overview'
    runId.value = null
    tplKey.value = null
    if (!wasOv) resetView()
    void loadOverview()
  } else {
    runId.value = null
    tplKey.value = null
  }
}

function resetView(): void {
  selectedKey.value = null
  drawerOpen.value = false
  logText.value = ''
  // [M23] 切换画布目标 → 静默重置编辑草稿（脏确认仅用于顶栏「退出编辑」）
  edit.exit()
  // 清数据：Board 以空数据重建 → 首次数据到达时自动 fit（避免残留上一目标的图与视口）
  runCanvas.value = null
  tplCanvas.value = null
}

watch(() => route.query, syncFromQuery)

// ===== 数据拉取（静默对账）=====
async function loadRun(silent = false): Promise<void> {
  const id = runId.value
  if (id == null) return
  if (!silent) {
    loading.value = true
    err.value = ''
  }
  try {
    const data = await canvasApi.run(id)
    if (runId.value === id) {
      runCanvas.value = data
      err.value = ''
    }
  } catch (e) {
    if (!silent && runId.value === id) err.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (!silent) loading.value = false
  }
}

async function loadTpl(): Promise<void> {
  const key = tplKey.value
  if (!key) return
  loading.value = true
  err.value = ''
  try {
    const data = await canvasApi.template(key)
    if (tplKey.value === key) tplCanvas.value = data
  } catch (e) {
    if (tplKey.value === key) {
      tplCanvas.value = null
      err.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    loading.value = false
  }
}

/** [M23] 全景聚合（项目级；silent：socket 事件触发的对账刷新） */
async function loadOverview(silent = false): Promise<void> {
  const pid = projectId.value
  if (pid == null) {
    if (!silent) overview.value = null
    return
  }
  if (!silent) {
    overviewLoading.value = true
    err.value = ''
  }
  try {
    const data = await canvasApi.overview(pid)
    if (projectId.value === pid && tab.value === 'overview') {
      overview.value = data
      err.value = ''
    }
  } catch (e) {
    if (!silent && tab.value === 'overview') err.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (!silent) overviewLoading.value = false
  }
}

async function loadLists(): Promise<void> {
  try {
    const [r, t, p] = await Promise.all([runApi.list(), templateApi.list(), projectApi.list()])
    runs.value = r.items
    tplMetas.value = t.items
    projects.value = p.items
    if (projectId.value == null) projectId.value = projects.value[0]?.id ?? null
    // [M23] 深链进入（?overview=1）：项目就绪后补首载
    if (tab.value === 'overview' && overview.value == null) void loadOverview()
    listErr.value = ''
  } catch (e) {
    listErr.value = e instanceof Error ? e.message : String(e)
  }
}

// ===== 实时 / socket 房间 / 日志（M26 拆分：./use-canvas-realtime）=====
const { logText, loadLog } = useCanvasRealtime({ tab, runId, drawerOpen, loadRun, loadOverview })

// ===== Board 数据归一化（run / template 两态 → CanvasBoardNode）=====
const boardNodes = computed<CanvasBoardNode[]>(() => {
  if (runId.value != null && runCanvas.value) {
    return runCanvas.value.nodes.map((n) => ({
      key: n.key,
      seq: n.seq,
      action: n.action,
      title: n.title,
      status: n.status,
      durationMs: n.durationMs,
      attempts: n.attempts,
      tasks: n.tasks,
      gateMessage: n.gate?.message ?? null,
      skipText: n.skippedReason ? skipReasonText(n.skippedReason) : null,
      hasError: !!n.error,
      assetCount: n.assetIds.length,
    }))
  }
  if (tplKey.value != null && tplCanvas.value) {
    return tplCanvas.value.nodes.map((n) => ({
      key: n.key,
      seq: n.seq,
      action: n.action,
      // [M23] 编辑草稿 overlay：标题即时生效（未编辑 → 恒原值）
      title: edit.titleOf(n),
      gateMessage: n.gate?.message ?? null,
      whenText: whenSummary(n),
      batchField: n.batch?.field ?? null,
    }))
  }
  return []
})

const boardEdges = computed(() => {
  if (runId.value != null) return runCanvas.value?.edges ?? []
  // [M23-E4] 模板态：本地草稿边叠加（连线/删边即时可见；退出编辑即还原）
  return tplCanvas.value ? edit.edgesOf(tplCanvas.value.edges) : []
})

function whenSummary(n: TemplateCanvasNode): string | null {
  if (n.when) return Array.isArray(n.when) ? n.when.join(' ∧ ') : n.when
  if (n.whenAny?.length) return n.whenAny.join(' ∨ ')
  return null
}

// ===== 选中与抽屉 =====
const selRunNode = computed<RunCanvasNode | null>(() => {
  if (runId.value == null || !selectedKey.value || !runCanvas.value) return null
  return runCanvas.value.nodes.find((n) => n.key === selectedKey.value) ?? null
})
const selTplNode = computed<TemplateCanvasNode | null>(() => {
  if (tplKey.value == null || !selectedKey.value || !tplCanvas.value) return null
  return tplCanvas.value.nodes.find((n) => n.key === selectedKey.value) ?? null
})
const drawerSel = computed(() =>
  selRunNode.value
    ? ({ mode: 'run', node: selRunNode.value } as const)
    : selTplNode.value
      ? ({ mode: 'template', node: selTplNode.value } as const)
      : null,
)

// ===== [M23] 编辑装配（编辑区视图 + patch 回流；E3）=====
const editNode = computed<EditNodeState | null>(() => {
  if (tab.value !== 'template' || !editMode.value || !selTplNode.value) return null
  return edit.nodeState(selTplNode.value)
})

function onEdit(key: string, patch: StepOverride): void {
  edit.setPatch(key, patch)
}

function toggleEdit(): void {
  if (editMode.value) void exitEdit()
  else editMode.value = true
}

async function exitEdit(): Promise<void> {
  if (editDirty.value) {
    const ok = await confirmDialog({
      title: '退出编辑',
      message: '有未保存的修改，退出将丢弃这些修改（编辑为本地草稿，不影响原模板文件）。',
      confirmText: '退出并丢弃',
      danger: true,
    })
    if (!ok) return
  }
  edit.exit()
}

async function resetEdits(): Promise<void> {
  const ok = await confirmDialog({
    title: '重置修改',
    message: `将丢弃 ${editCount.value} 个步骤的编辑草稿，恢复到模板原值。`,
    confirmText: '重置',
    danger: true,
  })
  if (!ok) return
  edit.clearAll()
}

// ===== [M23] 轻提示 + [M23-E4] 设计态编排（连线/删边/落盘通道：草案预览 / 保存为新模板）——M26 拆分：./use-canvas-design =====
const {
  toastMsg,
  boardEdit,
  onConnect,
  onDelEdge,
  showDraft,
  draftBusy,
  draftYaml,
  draftValidation,
  openDraftModal,
  copyDraftYaml,
  showSave,
  saveBusy,
  saveKey,
  saveErr,
  openSaveModal,
  draftToSave,
  doSave,
} = useCanvasDesign({ edit, tab, tplKey, onSaved: loadLists })

function onSelect(key: string): void {
  if (!key) {
    selectedKey.value = null
    drawerOpen.value = false
    return
  }
  selectedKey.value = key
  drawerOpen.value = true
  if (runId.value != null && !logText.value) void loadLog()
}

function onDrawerRefresh(): void {
  if (runId.value != null) {
    void loadRun(true)
    void loadLog()
  }
}

// ===== 顶栏操作 =====
const curRun = computed(() => (runId.value != null ? runCanvas.value?.run ?? null : null))
const cancelBusy = ref(false)
const resumeBusy = ref(false)

async function cancelRun(): Promise<void> {
  const id = runId.value
  if (id == null) return
  const ok = await confirmDialog({
    title: '取消运行',
    message: `确认取消 run #${id}？当前步骤产物会保留。`,
    confirmText: '取消运行',
    danger: true,
  })
  if (!ok) return
  cancelBusy.value = true
  try {
    await runApi.cancel(id)
    await loadRun(true)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    cancelBusy.value = false
  }
}

async function resumeRun(): Promise<void> {
  const id = runId.value
  if (id == null) return
  const ok = await confirmDialog({
    title: '断点续跑',
    message: `将从 run #${id} 的失败 / 未完成步骤创建续跑 run（已成功步骤产物复用，不重复执行）。`,
    confirmText: '开始续跑',
  })
  if (!ok) return
  resumeBusy.value = true
  try {
    const res = await runApi.resume(id)
    goRun(res.run.id)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    resumeBusy.value = false
  }
}

// ===== 导航辅助 =====
function goRun(id: number): void {
  void router.replace({ query: { run: String(id) } })
}
function goTemplate(key: string): void {
  void router.replace({ query: { template: key } })
}
/** [M23] 全景批次头 → 批次详情页 */
function goBatch(id: number): void {
  void router.push(`/batches/${id}`)
}
function clearTarget(): void {
  void router.replace({ query: {} })
}
function fitView(): void {
  boardRef.value?.fit()
}

function goBack(): void {
  // 优先回到模板页；若 history 中无上一页（直接访问 /canvas），则 fallback 到模板页
  if (window.history.length > 1) router.back()
  else void router.push('/templates')
}

function showTab(t: TabKey): void {
  tab.value = t
  if (t === 'run') {
    const id = runId.value ?? runs.value[0]?.id ?? null
    if (id != null) goRun(id)
    else void router.replace({ query: {} })
  } else if (t === 'template') {
    const k = tplKey.value ?? tplMetas.value[0]?.key ?? null
    if (k) goTemplate(k)
    else void router.replace({ query: {} })
  } else {
    // [M23] 全景：项目选择器复用 selProject（本地状态，不进路由）
    void router.replace({ query: { overview: '1' } })
  }
}

// ===== 下拉绑定（值经路由回写）=====
const selRunId = computed({
  get: () => (runId.value == null ? '' : String(runId.value)),
  set: (v: string) => {
    const id = Number(v)
    if (Number.isFinite(id) && id > 0) goRun(id)
  },
})
const selTplKey = computed({
  get: () => tplKey.value ?? '',
  set: (v: string) => {
    if (v) goTemplate(v)
  },
})
const selProject = computed({
  get: () => (projectId.value == null ? '' : String(projectId.value)),
  set: (v: string) => {
    const id = Number(v)
    if (Number.isFinite(id) && id > 0) {
      projectId.value = id
      // [M23] 全景态切换项目 → 重拉聚合
      if (tab.value === 'overview') void loadOverview()
    }
  },
})

// ===== 模板模式：启动运行（既有 RunFormModal，需先选项目）=====
function openStart(): void {
  if (!tplKey.value || projectId.value == null) return
  showStart.value = true
}
function onStarted(id: number): void {
  showStart.value = false
  goRun(id)
}

/** [M16] 抽屉「送入创作画布」→ 跳转创作画布（带上项目与目标画布） */
function onOpenCreationCanvas(canvasId: number): void {
  const pid = runCanvas.value?.run.projectId
  if (pid == null) return
  void router.push({ path: '/creation', query: { project: String(pid), canvas: String(canvasId) } })
}

// ===== 生命周期（socket 订阅与清理由 ./use-canvas-realtime 负责）=====
onMounted(() => {
  void loadLists()
  syncFromQuery()
})
</script>

<template>
  <div class="cv-page">
    <!-- ===== 顶栏 ===== -->
    <div class="cv-bar">
      <button type="button" class="btn sm" title="返回上一页" @click="goBack">
        <Icon name="arrow-left" :size="13" />
      </button>
      <div class="tabs" role="tablist" aria-label="运行画布 / 模板画布 / 全景切换">
        <button
          type="button"
          class="tab"
          role="tab"
          :aria-selected="tab === 'run'"
          :class="{ on: tab === 'run' }"
          @click="showTab('run')"
        >
          <Icon name="flow" :size="13" /> 运行画布
        </button>
        <button
          type="button"
          class="tab"
          role="tab"
          :aria-selected="tab === 'template'"
          :class="{ on: tab === 'template' }"
          @click="showTab('template')"
        >
          <Icon name="doc" :size="13" /> 模板画布
        </button>
        <button
          type="button"
          class="tab"
          role="tab"
          :aria-selected="tab === 'overview'"
          :class="{ on: tab === 'overview' }"
          @click="showTab('overview')"
        >
          <Icon name="map" :size="13" /> 全景
        </button>
      </div>

      <template v-if="tab === 'run'">
        <select v-model="selRunId" class="sel" aria-label="选择运行" :disabled="!runs.length">
          <option value="" disabled>选择运行…</option>
          <option v-for="r in runs" :key="r.id" :value="String(r.id)">
            #{{ r.id }} · {{ r.templateKey }} · {{ runStatus(r.status).text }} · {{ fmtTime(r.createdAt) }}
          </option>
        </select>
        <template v-if="curRun">
          <span class="badge" :class="curRun.status">{{ runStatus(curRun.status).text }}</span>
          <span class="muted mono">#{{ curRun.id }}</span>
        </template>
        <button
          v-if="runCanvas?.runActions.canCancel"
          type="button"
          class="btn sm danger"
          :disabled="cancelBusy"
          @click="cancelRun"
        >
          <Icon name="stop" :size="12" /> {{ cancelBusy ? '处理中…' : '取消运行' }}
        </button>
        <button
          v-if="runCanvas?.runActions.canResume"
          type="button"
          class="btn sm primary"
          :disabled="resumeBusy"
          @click="resumeRun"
        >
          <Icon name="play" :size="12" /> {{ resumeBusy ? '处理中…' : '断点续跑' }}
        </button>
      </template>

      <template v-else-if="tab === 'template'">
        <select v-model="selTplKey" class="sel" aria-label="选择模板" :disabled="!tplMetas.length">
          <option value="" disabled>选择模板…</option>
          <option v-for="t in tplMetas" :key="t.key" :value="t.key">{{ t.name }}（v{{ t.version }}）</option>
        </select>
        <select v-model="selProject" class="sel" aria-label="选择启动项目" :disabled="!projects.length">
          <option value="" disabled>选择项目…</option>
          <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
        </select>
        <button
          type="button"
          class="btn sm primary"
          :disabled="!tplKey || !selProject"
          title="以当前模板启动新运行（需先选项目）"
          @click="openStart"
        >
          <Icon name="play" :size="12" /> 启动运行
        </button>

        <!-- [M23] 画布内编辑（本地草稿） -->
        <button
          v-if="!editMode"
          type="button"
          class="btn sm"
          title="进入画布内编辑（本地草稿，不改动原模板文件）"
          @click="toggleEdit"
        >
          <Icon name="pencil" :size="12" /> 编辑
        </button>
        <template v-else>
          <span class="edit-flag">编辑中</span>
          <span v-if="editDirty" class="edit-dirty">有未保存修改（{{ editCount }} 步）</span>
          <button v-if="editDirty" type="button" class="btn sm" title="丢弃全部编辑草稿" @click="resetEdits">
            <Icon name="undo" :size="12" /> 重置修改
          </button>
          <!-- [M23] E4 落盘通道：草案预览（不落盘）/ 保存为新模板（原文件零触碰） -->
          <button
            v-if="editDirty"
            type="button"
            class="btn sm"
            :disabled="draftBusy"
            title="以受控 edits 生成新模板 YAML 预览（不落盘）"
            @click="openDraftModal"
          >
            <Icon name="doc" :size="12" /> {{ draftBusy ? '生成中…' : '导出草案' }}
          </button>
          <button
            v-if="editDirty"
            type="button"
            class="btn sm primary"
            :disabled="draftBusy"
            title="落盘为新模板文件（key 冲突自动后缀避让；原模板不被修改）"
            @click="openSaveModal"
          >
            <Icon name="download" :size="12" /> 保存为新模板
          </button>
          <button type="button" class="btn sm" title="退出编辑（有修改时需确认）" @click="toggleEdit">
            <Icon name="check" :size="12" /> 退出编辑
          </button>
        </template>
      </template>

      <template v-else>
        <select v-model="selProject" class="sel" aria-label="选择项目" :disabled="!projects.length">
          <option value="" disabled>选择项目…</option>
          <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
        </select>
        <span v-if="overview" class="muted mono">{{ overview.stats.runCount }} 条运行 · {{ overview.batches.length }} 个批次</span>
        <span v-else-if="overviewLoading" class="muted">加载中…</span>
      </template>

      <span class="sp" />
      <span v-if="listErr" class="muted" :title="listErr">目录加载失败</span>
      <span v-if="loading" class="muted">加载中…</span>
      <button type="button" class="btn sm" title="适应视图（0）" @click="fitView">
        <Icon name="zoom-in" :size="12" /> 适应视图
      </button>
    </div>

    <div v-if="err" class="errbar">
      <Icon name="alert" :size="13" />
      <span class="eb-t">{{ err }}</span>
      <button type="button" class="btn sm" @click="clearTarget">返回选择</button>
    </div>

    <!-- ===== 舞台（Board + Drawer 覆盖层）===== -->
    <div class="cv-stage">
      <!-- [M23] 全景（项目级聚合：跨批次/跨模板） -->
      <div v-if="tab === 'overview'" class="ov-wrap">
        <OverviewPanel v-if="overview" :data="overview" @open-run="goRun" @open-batch="goBatch" @reload="loadOverview()" />
        <div v-else class="ov-ph muted">
          {{ overviewLoading ? '加载中…' : projectId == null ? '暂无项目（先在项目页创建一个项目）' : '暂无全景数据' }}
        </div>
      </div>

      <CanvasGuide v-else-if="empty" :runs="runs" :tpl-metas="tplMetas" @open-run="goRun" @open-template="goTemplate" />

      <CanvasBoard
        v-else
        :key="`${tab}:${runId ?? tplKey ?? ''}`"
        ref="boardRef"
        :nodes="boardNodes"
        :edges="boardEdges"
        :selected-key="selectedKey"
        :mode="tab === 'template' ? 'template' : 'run'"
        :edit-mode="boardEdit"
        @select="onSelect"
        @connect="onConnect"
        @del-edge="onDelEdge"
      />

      <CanvasDrawer
        v-if="!empty && drawerOpen && drawerSel"
        :run-id="runId"
        :sel="drawerSel"
        :log="logText"
        :project-id="runCanvas?.run.projectId ?? null"
        :edit-node="editNode"
        @close="drawerOpen = false"
        @refresh="onDrawerRefresh"
        @open-canvas="onOpenCreationCanvas"
        @edit="onEdit"
      />
    </div>

    <!-- 模板画布：启动运行（既有表单，initialTemplateKey 预填直达） -->
    <RunFormModal
      v-if="showStart && projectId != null"
      :project-id="projectId"
      :initial-template-key="tplKey ?? undefined"
      @done="onStarted"
      @close="showStart = false"
    />

    <!-- [M23] 设计态落盘 Modal 组（草案预览 / 保存为新模板 / 轻提示）——M26 拆分：./CanvasDesignModals.vue -->
    <CanvasDesignModals
      v-model:save-key="saveKey"
      :show-draft="showDraft"
      :draft-validation="draftValidation"
      :draft-yaml="draftYaml"
      :show-save="showSave"
      :save-err="saveErr"
      :save-busy="saveBusy"
      :toast-msg="toastMsg"
      @close-draft="showDraft = false"
      @copy="copyDraftYaml"
      @save-from-draft="draftToSave"
      @close-save="showSave = false"
      @save="doSave"
    />
  </div>
</template>

<style scoped>
.cv-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: calc(100vh - 44px);
  min-height: 420px;
}

.cv-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sel {
  width: auto;
  max-width: 320px;
  padding: 5px 8px;
  font-size: 12px;
}

.sp {
  flex: 1;
}

.errbar {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--bad);
  background: var(--bad-weak);
  border: 1px solid rgb(248 113 113 / 30%);
  border-radius: 9px;
  padding: 7px 12px;
  font-size: 12.5px;
}

.eb-t {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.cv-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg);
}

/* [M23] 全景容器 / 占位 */
.ov-wrap {
  height: 100%;
  min-height: 0;
}

.ov-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
}

/* [M23] 编辑标记（顶栏） */
.edit-flag {
  font-size: 11px;
  color: var(--warn);
  border: 1px solid rgb(251 191 36 / 35%);
  border-radius: 999px;
  padding: 1px 8px;
}

.edit-dirty {
  font-size: 11.5px;
  color: var(--warn);
}

/* [M23] 空态引导样式已随 CanvasGuide.vue 拆出；草案/保存 Modal 与轻提示样式已随 CanvasDesignModals.vue 拆出 */
</style>
