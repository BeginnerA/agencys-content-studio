<script setup lang="ts">
/**
 * [M15] 流水线画布页（spec §2.4）
 * - 模式：运行画布（?run=）/ 模板画布（?template=）；两 query 互斥 run 优先；均无 → 空态引导
 * - 数据：canvasApi.run / canvasApi.template；socket 手动 join/leave run room（runId 可切换，不用 useStudio 单例）
 * - 实时：run.step / run.gate / run.completed / run.failed / task.updated / step.log → 350ms 防抖全量对账
 * - 操作：顶栏取消/续跑/启动运行；节点抽屉操作 → refresh 立即重拉（全部复用既有端点）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CanvasBoard from '../../components/pipeline-canvas/CanvasBoard.vue'
import CanvasDrawer from '../../components/pipeline-canvas/drawer/index.vue'
import Icon from '../../components/common/Icon.vue'
import RunFormModal from '../../components/run/RunFormModal.vue'
import { canvasApi, projectApi, runApi, templateApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import { fmtTime, runStatus, skipReasonText } from '../../lib/format'
import { getSocket, studioOff, studioOn } from '../../lib/socket'
import type { StudioEventMap } from '../../lib/socket'
import type {
  CanvasBoardNode, Project, Run, RunCanvas, RunCanvasNode, TemplateCanvas, TemplateCanvasNode, TemplateMeta,
} from '../../lib/types'

const route = useRoute()
const router = useRouter()

// ===== 目标解析（route.query 为单一真源）=====
const tab = ref<'run' | 'template'>('run')
const runId = ref<number | null>(null)
const tplKey = ref<string | null>(null)
const empty = computed(() => runId.value == null && tplKey.value == null)

// ===== 数据层 =====
const runCanvas = ref<RunCanvas | null>(null)
const tplCanvas = ref<TemplateCanvas | null>(null)
const loading = ref(false)
const err = ref('')

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
  } else {
    runId.value = null
    tplKey.value = null
  }
}

function resetView(): void {
  selectedKey.value = null
  drawerOpen.value = false
  logText.value = ''
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

async function loadLists(): Promise<void> {
  try {
    const [r, t, p] = await Promise.all([runApi.list(), templateApi.list(), projectApi.list()])
    runs.value = r.items
    tplMetas.value = t.items
    projects.value = p.items
    if (projectId.value == null) projectId.value = projects.value[0]?.id ?? null
    listErr.value = ''
  } catch (e) {
    listErr.value = e instanceof Error ? e.message : String(e)
  }
}

// ===== 实时（350ms 防抖 + in-flight 合并；数据全量替换，视图状态独立）=====
let refreshTimer: number | null = null
let refreshing = false
let refreshDirty = false

function scheduleRefresh(): void {
  if (refreshTimer != null) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    if (refreshing) {
      refreshDirty = true
      return
    }
    refreshing = true
    void loadRun(true).finally(() => {
      refreshing = false
      if (refreshDirty) {
        refreshDirty = false
        scheduleRefresh()
      }
    })
  }, 350)
}

// ===== socket 房间（runId 可切换 → 手动 join/leave，不用 useStudio 单例）=====
const socket = getSocket()
let joinedRun: number | null = null

function joinRunRoom(id: number): void {
  if (joinedRun === id) return
  if (joinedRun != null) socket.emit('leave', `run:${joinedRun}`)
  socket.emit('join', `run:${id}`)
  joinedRun = id
}
function leaveRunRoom(): void {
  if (joinedRun != null) {
    socket.emit('leave', `run:${joinedRun}`)
    joinedRun = null
  }
}
watch(runId, (id) => {
  if (id != null) joinRunRoom(id)
  else leaveRunRoom()
})

function onRunEvent(p: { runId: number }): void {
  if (runId.value != null && p.runId === runId.value) scheduleRefresh()
}
function onTaskEvent(p: StudioEventMap['task.updated']): void {
  if (runId.value != null && (p.runId == null || p.runId === runId.value)) scheduleRefresh()
}
function onLogEvent(p: StudioEventMap['step.log']): void {
  if (runId.value != null && p.runId === runId.value && drawerOpen.value) scheduleLogRefresh()
}

// ===== 日志（抽屉打开时按节流拉取；抽屉内再按 [stepKey] 过滤）=====
const logText = ref('')
let logTimer: number | null = null
let logFetching = false

async function loadLog(): Promise<void> {
  const id = runId.value
  if (id == null || logFetching) return
  logFetching = true
  try {
    const r = await runApi.log(id, 800)
    if (runId.value === id) logText.value = r.log
  } catch {
    // 宽容：日志不可读不阻塞抽屉
  } finally {
    logFetching = false
  }
}
function scheduleLogRefresh(): void {
  if (logTimer != null) return
  logTimer = window.setTimeout(() => {
    logTimer = null
    void loadLog()
  }, 1200)
}

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
      title: n.title,
      gateMessage: n.gate?.message ?? null,
      whenText: whenSummary(n),
      batchField: n.batch?.field ?? null,
    }))
  }
  return []
})

const boardEdges = computed(() =>
  runId.value != null ? runCanvas.value?.edges ?? [] : tplCanvas.value?.edges ?? [],
)

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

function showTab(t: 'run' | 'template'): void {
  tab.value = t
  if (t === 'run') {
    const id = runId.value ?? runs.value[0]?.id ?? null
    if (id != null) goRun(id)
    else void router.replace({ query: {} })
  } else {
    const k = tplKey.value ?? tplMetas.value[0]?.key ?? null
    if (k) goTemplate(k)
    else void router.replace({ query: {} })
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
    if (Number.isFinite(id) && id > 0) projectId.value = id
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

// ===== 生命周期 =====
onMounted(() => {
  void loadLists()
  syncFromQuery()
  studioOn('run.step', onRunEvent)
  studioOn('run.gate', onRunEvent)
  studioOn('run.completed', onRunEvent)
  studioOn('run.failed', onRunEvent)
  studioOn('task.updated', onTaskEvent)
  studioOn('step.log', onLogEvent)
})

onBeforeUnmount(() => {
  studioOff('run.step', onRunEvent)
  studioOff('run.gate', onRunEvent)
  studioOff('run.completed', onRunEvent)
  studioOff('run.failed', onRunEvent)
  studioOff('task.updated', onTaskEvent)
  studioOff('step.log', onLogEvent)
  leaveRunRoom()
  if (refreshTimer != null) window.clearTimeout(refreshTimer)
  if (logTimer != null) window.clearTimeout(logTimer)
})
</script>

<template>
  <div class="cv-page">
    <!-- ===== 顶栏 ===== -->
    <div class="cv-bar">
      <button type="button" class="btn sm" title="返回上一页" @click="goBack">
        <Icon name="arrow-left" :size="13" />
      </button>
      <div class="tabs" role="tablist" aria-label="运行画布 / 模板画布切换">
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

      <template v-else>
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
      <div v-if="empty" class="cv-guide">
        <div class="gd-card panel">
          <Icon name="flow" :size="30" />
          <div class="gd-t">流水线画布</div>
          <p class="muted gd-desc">
            选择一条运行查看实时流水线（状态 / 闸门 / 任务 / 产物，可直接操作），
            或选择一个模板预览编排设计（调度依赖 / 数据引用 / 条件与闸门）。
          </p>
          <div class="gd-sec">
            <div class="gd-h">最近运行</div>
            <div v-if="runs.length" class="chips">
              <button
                v-for="r in runs.slice(0, 8)"
                :key="r.id"
                type="button"
                class="chip chipbtn"
                @click="goRun(r.id)"
              >
                #{{ r.id }} · {{ r.templateKey }} · {{ runStatus(r.status).text }}
              </button>
            </div>
            <div v-else class="muted">暂无运行记录（可从项目页启动一条）</div>
          </div>
          <div class="gd-sec">
            <div class="gd-h">模板</div>
            <div v-if="tplMetas.length" class="chips">
              <button
                v-for="t in tplMetas"
                :key="t.key"
                type="button"
                class="chip chipbtn"
                @click="goTemplate(t.key)"
              >
                {{ t.name }}
              </button>
            </div>
            <div v-else class="muted">workspace/templates 下暂无模板</div>
          </div>
        </div>
      </div>

      <CanvasBoard
        v-else
        :key="`${tab}:${runId ?? tplKey ?? ''}`"
        ref="boardRef"
        :nodes="boardNodes"
        :edges="boardEdges"
        :selected-key="selectedKey"
        :mode="tab"
        @select="onSelect"
      />

      <CanvasDrawer
        v-if="!empty && drawerOpen && drawerSel"
        :run-id="runId"
        :sel="drawerSel"
        :log="logText"
        :project-id="runCanvas?.run.projectId ?? null"
        @close="drawerOpen = false"
        @refresh="onDrawerRefresh"
        @open-canvas="onOpenCreationCanvas"
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

.cv-guide {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  overflow-y: auto;
}

.gd-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 640px;
  padding: 26px 28px;
}

.gd-t {
  font-size: 18px;
  font-weight: 700;
}

.gd-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
}

.gd-sec {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 6px;
}

.gd-h {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.chipbtn {
  cursor: pointer;
  font: inherit;
}

.chipbtn:hover {
  border-color: var(--accent);
  color: #fff;
}
</style>
