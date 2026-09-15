<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AspectDeriveModal from '../components/AspectDeriveModal.vue'
import GateDialog from '../components/GateDialog.vue'
import TaskPanel from '../components/TaskPanel.vue'
import ShotBoard from '../components/ShotBoard.vue'
import NovelBoard from '../components/NovelBoard.vue'
import AssetPreviewer from '../components/AssetPreviewer.vue'
import Icon from '../components/Icon.vue'
import ExportWizardModal from '../components/ExportWizardModal.vue'
import PublishModal from '../components/PublishModal.vue'
import RunFormModal from '../components/RunFormModal.vue'
import RerunModal from '../components/RerunModal.vue'
import { assetApi, exportApi, publicationApi, runApi, shotApi, statsApi, templateApi } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import type {
  Asset, ExportAssetLite, Publication, RerunResult, RunAssetLite, RunDetail, RunStep, ShotBoardCompose,
  TemplateDetail, TemplateMeta, UsageSummary,
} from '../lib/types'
import {
  fmtCost, fmtMs, fmtQty, fmtSize, fmtTime, PLATFORM_TEXT, runStatus, skipReasonText, stepStatus,
} from '../lib/format'
import { useStudio } from '../lib/socket'
import type { StudioEventMap } from '../lib/socket'

const route = useRoute()
const router = useRouter()
const runId = Number(route.params.id)

const detail = ref<RunDetail | null>(null)
const tpl = ref<TemplateDetail | null>(null)
const err = ref('')
const busy = ref(false)

// 闸门状态
const gateStep = ref<RunStep | null>(null)
const gateMessage = ref('')
const gateText = ref('')
const gateTextName = ref('')

// 日志
const showLog = ref(false)
const logText = ref('')
const autoScroll = ref(true)
const logEl = ref<HTMLElement | null>(null)

const run = computed(() => detail.value?.run ?? null)
const steps = computed(() => detail.value?.steps ?? [])
const canCancel = computed(() => {
  const s = run.value?.status
  return s === 'queued' || s === 'running' || s === 'waiting_input'
})
const canResume = computed(() => {
  const s = run.value?.status
  return s === 'failed' || s === 'cancelled'
})
const hasTasks = computed(() => steps.value.some((s) => s.actionKey === 'ai_image'))
const active = computed(() => run.value?.status === 'running' || run.value?.status === 'queued')

// [M2] 当前闸门的免审按钮文案（模板 gate.skip_label）；模板不可达时隐藏
const gateSkipLabel = computed(() => {
  const step = gateStep.value
  if (!step) return undefined
  const def = tpl.value?.steps.find((d) => d.key === step.stepKey)
  return def?.gate?.skip_label
})

// [M2] 并行执行提示：同一时刻 ≥2 步骤处于执行/待审状态（引擎就绪集并发 ≤2）
const parallelHint = computed(() => {
  const actives = steps.value.filter((s) => s.status === 'running' || s.status === 'waiting_input')
  return actives.length >= 2 ? `并行执行中：${actives.length} 步并发推进` : ''
})

// [M2] 快照差异：run 启动时的模板版本 vs 当前文件（版本号 + stepKey 集比对；无差异不显示）
const snapshot = computed(() => {
  const r = run.value
  if (!r || r.templateVersion === undefined) return null
  const cur = tpl.value
  const runKeys = steps.value.map((s) => s.stepKey)
  let added: string[] = []
  let removed: string[] = []
  if (cur) {
    const runSet = new Set(runKeys)
    const fileKeys = cur.steps.map((s) => s.key)
    const fileSet = new Set(fileKeys)
    added = fileKeys.filter((k) => !runSet.has(k))
    removed = runKeys.filter((k) => !fileSet.has(k))
  }
  const versionDiff = cur ? r.templateVersion !== cur.version : false
  if (!versionDiff && added.length === 0 && removed.length === 0) return null
  return { rv: r.templateVersion, curV: cur?.version, added, removed }
})

function snapshotTip(s: NonNullable<typeof snapshot.value>): string {
  const parts = [`运行使用启动时快照 v${s.rv}，运行中不受模板编辑影响`]
  if (s.curV !== undefined && s.curV !== s.rv) parts.push(`当前文件版本 v${s.curV}`)
  if (s.added.length) parts.push(`文件新增步骤：${s.added.join('、')}`)
  if (s.removed.length) parts.push(`快照含步骤：${s.removed.join('、')}`)
  return parts.join('；')
}

/** 模板 gate message 的 {input.x} 插值（离线回填场景） */
function interpolate(msg: string, input: Record<string, unknown>): string {
  return msg.replace(/\{input\.([\w-]+)\}/g, (_, k: string) => String(input[k] ?? ''))
}

async function loadGate() {
  gateStep.value = null
  gateText.value = ''
  const step = steps.value.find((s) => s.status === 'waiting_input')
  if (!step || !run.value) return
  // 消息优先取模板定义（服务端事件已解析；此处静态插值）
  const stepDef = tpl.value?.steps.find((d) => d.key === step.stepKey)
  gateMessage.value = interpolate(stepDef?.gate?.message ?? `请审阅「${step.title}」的产物`, run.value.input)
  const assetId = (step.output?.asset_ids as number[] | undefined)?.[0]
  if (!assetId) return
  gateStep.value = step
  try {
    const { asset: a } = await assetApi.detail(assetId)
    if (a.kind === 'text' || a.purpose === 'script' || a.purpose === 'storyboard') {
      gateTextName.value = a.name
      const res = await fetch(a.urls.file)
      if (res.ok) gateText.value = await res.text()
    }
  } catch {
    // 产物不可读则只显示操作按钮
  }
}

async function loadDetail() {
  err.value = ''
  try {
    const d = await runApi.detail(runId)
    detail.value = d
    // 模板详情仅按需拉取（含 gate 消息定义）
    if (!tpl.value || tpl.value.key !== d.run.templateKey) {
      try {
        const t = await templateApi.detail(d.run.templateKey)
        tpl.value = t.template
      } catch {
        tpl.value = null
      }
    }
    void loadGate()
    void loadBadges()
    // [M4] 附加数据仅初载一次（后续由显式刷新点驱动，避免 step 事件高频重复拉取）
    if (!extrasLoaded) {
      extrasLoaded = true
      void loadExtras(d.run.projectId)
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

// 事件风暴防抖：run.step 高频触发（每任务 ≥2 事件）时合并为单次刷新
// 350ms 尾沿触发 + in-flight 合并（刷新期间到来的事件等本轮结束后再补一次）
let detailRefreshTimer: number | undefined
let detailRefreshing = false
let detailDirty = false

function scheduleDetailRefresh(delay = 350) {
  if (detailRefreshTimer) window.clearTimeout(detailRefreshTimer)
  detailRefreshTimer = window.setTimeout(() => {
    detailRefreshTimer = undefined
    void runDetailRefresh()
  }, delay)
}

async function runDetailRefresh() {
  if (detailRefreshing) {
    detailDirty = true
    return
  }
  detailRefreshing = true
  try {
    await loadDetail()
  } finally {
    detailRefreshing = false
    if (detailDirty) {
      detailDirty = false
      void runDetailRefresh()
    }
  }
}

let logTimer: number | undefined
let logThrottle: number | undefined
async function loadLog() {
  try {
    const res = await runApi.log(runId, 400)
    logText.value = res.log
    if (autoScroll.value && logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  } catch {
    // 日志缺失不打扰
  }
}

/** step.log 事件高频（ffmpeg 逐行输出）→ 节流合并刷新（800ms 窗口） */
function scheduleLogRefresh() {
  if (logThrottle) return
  logThrottle = window.setTimeout(() => {
    logThrottle = undefined
    if (showLog.value) void loadLog()
  }, 800)
}

function toggleLog() {
  showLog.value = !showLog.value
  if (showLog.value) void loadLog()
}

async function decide(
  action: 'approve' | 'reject' | 'skip' | 'abort',
  payload: { note?: string; textOverride?: string },
) {
  if (!gateStep.value) return
  busy.value = true
  err.value = ''
  try {
    const body: Record<string, unknown> = { step_key: gateStep.value.stepKey, decision: action }
    if (payload.note) body.note = payload.note
    if (payload.textOverride) body.text_override = payload.textOverride
    const res = await runApi.gate(runId, body)
    detail.value = res
    void loadGate()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function cancelRun() {
  const ok = await confirmDialog({
    title: '取消运行',
    message: `确认取消 run #${runId}？当前步骤产物会保留。`,
    confirmText: '取消运行',
    danger: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await runApi.cancel(runId)
    await loadDetail()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function resumeRun() {
  const ok = await confirmDialog({
    title: '断点续跑',
    message: '将新建一个 run，跳过已成功步骤继续执行。',
    confirmText: '开始续跑',
  })
  if (!ok) return
  busy.value = true
  try {
    const res = await runApi.resume(runId)
    router.push(`/runs/${res.run.id}`)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

// ===== 完成态「下一步建议」接力（模板元数据 next 声明） =====
const tplMetas = ref<TemplateMeta[]>([])
const showRelay = ref(false)
const relayTplKey = ref('')

/** 挂载时拉一次模板元数据（读取 next 推荐与短名；失败静默，接力条自然隐藏） */
async function loadTplMetas() {
  try {
    const res = await templateApi.list()
    tplMetas.value = res.items
  } catch {
    // 元数据不可达不阻断主视图
  }
}

/** 模板 key → 短名（未载/未知 key 回退原 key） */
function tplName(key: string): string {
  return tplMetas.value.find((t) => t.key === key)?.name ?? key
}

/** 完成态：当前模板声明的推荐下游（引用不存在/未加载的 key 静默过滤） */
const nextOptions = computed(() => {
  const r = run.value
  if (!r || r.status !== 'completed') return []
  const cur = tplMetas.value.find((t) => t.key === r.templateKey)
  return (cur?.next ?? [])
    .map((k) => tplMetas.value.find((t) => t.key === k))
    .filter((t): t is TemplateMeta => !!t)
})

/** 点击接力 chip：以目标模板打开启动表单（initialTemplateKey 直达表单段） */
function openRelay(key: string) {
  relayTplKey.value = key
  showRelay.value = true
}

/**
 * 接力创建成功 → 跳到新 run。
 * RouterView 无 key：同路由仅参数变化会复用本组件（runId 为静态快照），
 * 故用整页跳转保证新 run 从零初始化（socket/日志/模板详情全部重载）。
 */
function onRelayDone(id: number) {
  showRelay.value = false
  window.location.href = `/runs/${id}`
}

// ===== socket 实时 =====
const studio = useStudio(runId)
function onStep(p: StudioEventMap['run.step']) {
  if (p.runId !== runId) return
  const local = steps.value.find((s) => s.id === p.step.id)
  if (local && p.step.status) {
    local.status = p.step.status as RunStep['status']
    // [M4] server run.step 不含 attempts（删除旧 p.step.attempts 行）；详细状态由 loadDetail 兜底
    if (p.step.status === 'waiting_input' || p.step.status === 'succeeded' || p.step.status === 'skipped') {
      scheduleDetailRefresh()
    }
  }
}
function onTerminal(p: StudioEventMap['run.completed' | 'run.failed']) {
  if (p.runId === runId) {
    void runDetailRefresh()
    refreshExtras()
  }
}
function onGate(p: StudioEventMap['run.gate']) {
  if (p.runId === runId) scheduleDetailRefresh()
}
function onLog(p: StudioEventMap['step.log']) {
  if (showLog.value) scheduleLogRefresh()
}

onMounted(() => {
  void runDetailRefresh()
  void loadTplMetas()
  studio.join()
  studio.on('run.step', onStep)
  studio.on('run.completed', onTerminal)
  studio.on('run.failed', onTerminal)
  studio.on('run.gate', onGate)
  studio.on('step.log', onLog)
  logTimer = window.setInterval(() => {
    if (showLog.value && active.value) void loadLog()
  }, 2500)
})

onBeforeUnmount(() => {
  studio.leave()
  if (logTimer) window.clearInterval(logTimer)
  if (logThrottle) window.clearTimeout(logThrottle)
  if (detailRefreshTimer) window.clearTimeout(detailRefreshTimer)
})

// ===== 步骤块渲染辅助 =====
function nodeClass(s: RunStep): string {
  if (s.status === 'running') return 'running'
  if (s.status === 'waiting_input') return 'gate'
  if (s.status === 'failed') return 'failed'
  if (s.status === 'succeeded') return 'ok'
  if (s.status === 'skipped') return 'skip'
  if (s.status === 'cancelled') return 'cancel'
  return 'idle'
}

/** [M2] 跳过原因（output.skipped.reason）；succeeded 且带 skipped 记录 = 免审放行 */
function skipInfo(s: RunStep): { text: string; userSkip: boolean } | null {
  const reason = (s.output as { skipped?: { reason?: string } } | null)?.skipped?.reason
  if (s.status === 'skipped') return { text: skipReasonText(reason ?? 'skipped'), userSkip: false }
  if (s.status === 'succeeded' && reason === 'user_skip') return { text: '免审放行', userSkip: true }
  return null
}

function assetIds(s: RunStep): number[] {
  const out = s.output?.asset_ids
  return Array.isArray(out) ? (out as number[]) : []
}

// ===== 产物预览（统一 AssetPreviewer：批量拉详情后内联查看，不再新开标签） =====
const previewAssets = ref<Asset[]>([])
const previewOpen = ref(false)
const previewStart = ref(0)
const previewBusy = ref<number | null>(null) // 正在拉取详情的资产 id

async function openAssetPreview(ids: number[], firstId: number) {
  if (previewBusy.value !== null || !ids.length) return
  previewBusy.value = firstId
  err.value = ''
  try {
    const list = await Promise.all(ids.map((id) => assetApi.detail(id).then((r) => r.asset)))
    previewAssets.value = list
    previewStart.value = Math.max(0, ids.indexOf(firstId))
    previewOpen.value = true
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewBusy.value = null
  }
}

function inputPretty(s: RunStep): string {
  if (!s.input) return '—'
  return JSON.stringify(s.input, null, 1)
}

function outputPretty(s: RunStep): string {
  if (!s.output) return '—'
  return JSON.stringify(s.output, null, 1)
}

const ACTION_ICON: Record<string, string> = {
  manual_ingest: 'inbox',
  ai_text: 'pencil',
  ai_image: 'photo',
  ffmpeg_merge: 'film',
  ai_video: 'video',
  memory_write: 'sparkles',
  memory_recall: 'search',
  character_sync: 'users',
}

function iconOf(key: string): string {
  return ACTION_ICON[key] ?? 'doc'
}

// [M3] 记忆/角色步骤徽标：读产物资产 params 组装（轻量、失败静默、按 step:asset 缓存）
const BADGE_ACTIONS = new Set(['memory_write', 'memory_recall', 'character_sync'])
const badges = ref<Record<number, string>>({})
const badgeCache = new Set<string>()

async function loadBadges() {
  // 先收集待拉取项（缓存命中/无产物同步跳过），再并发拉取（替代串行 for-await）
  const todo: Array<{ sid: number; aid: number; key: string; action: string }> = []
  for (const s of steps.value) {
    if (!BADGE_ACTIONS.has(s.actionKey)) continue
    const aid = assetIds(s)[0]
    if (!aid) continue
    const key = `${s.id}:${aid}`
    if (badgeCache.has(key)) continue
    todo.push({ sid: s.id, aid, key, action: s.actionKey })
  }
  if (!todo.length) return
  const next: Record<number, string> = { ...badges.value }
  await Promise.all(todo.map(async ({ sid, aid, key, action }) => {
    try {
      const { asset: a } = await assetApi.detail(aid)
      const p = (a.params ?? {}) as Record<string, unknown>
      if (action === 'memory_recall') {
        const top = typeof p['topScore'] === 'number' ? (p['topScore'] as number).toFixed(2) : null
        next[sid] = `召回 ${p['count'] ?? 0} 条${top ? ` · top ${top}` : ''}`
      } else if (action === 'memory_write') {
        const nm = typeof p['name'] === 'string' && p['name'] ? (p['name'] as string) : '（匿名）'
        next[sid] = `记忆已写 ${nm}`
      } else {
        next[sid] = `建档 ${p['created'] ?? 0} 新增 / ${p['updated'] ?? 0} 更新`
      }
      badgeCache.add(key)
    } catch {
      // 产物不可读 → 不显示徽标
    }
  }))
  badges.value = next
}

// ===== [M4] 导出包 / 本 run 成本 / 发布记录 =====
const showExport = ref(false)
const showPublish = ref(false)
const exportsList = ref<ExportAssetLite[]>([])
const costUsage = ref<UsageSummary | null>(null)
const publications = ref<Publication[]>([])
const runAssets = ref<RunAssetLite[]>([])
let extrasLoaded = false

const COST_KIND_TEXT: Record<string, string> = { llm: 'LLM', image: '图像', video: '视频', tts: '配音' }

/** 本 run 附加数据（四路并行：导出包 / 用量聚合 / run 发布记录（服务端 run_id 过滤）/ run 产物） */
async function loadExtras(projectId: number) {
  try {
    const [ex, us, pub, ra] = await Promise.all([
      exportApi.list(`?run_id=${runId}`),
      statsApi.usage(`?run_id=${runId}&group_by=kind`),
      publicationApi.list(`?project_id=${projectId}&run_id=${runId}`),
      exportApi.runAssets(runId),
    ])
    exportsList.value = ex.items
    costUsage.value = us
    publications.value = pub.items
    runAssets.value = ra.items
  } catch (e) {
    // 附加数据失败不阻断主视图（成本/导出/发布为辅助信息）
    console.warn('loadExtras 失败', e)
  }
}

/** 显式刷新（导出完成 / 发布登记 / run 终态） */
function refreshExtras() {
  const pid = detail.value?.run.projectId
  if (pid !== undefined) void loadExtras(pid)
}

/** 发布记录资产名（run 产物内查找；软删/跨 run 资产回退 #id） */
function assetNameOf(id: number | null): string {
  if (id === null) return '—'
  return runAssets.value.find((a) => a.id === id)?.name ?? `#${id}`
}

/** 「标记发布」预选：run 内最新视频（通常是成片） */
const publishCandidate = computed<number | null>(() => {
  const vids = runAssets.value.filter((a) => a.kind === 'video')
  const last = vids[vids.length - 1]
  return last ? last.id : null
})

// ===== [M19] 成片多画幅派生（A 路径：对最新 final_video 二次编码） =====
const deriveOpen = ref(false)
/** 有 final_video 产物才可派生 */
const hasFinalVideo = computed(() => runAssets.value.some((a) => a.purpose === 'final_video'))
/** 派生完成 → 刷新 run 产物（项目资产已新行，导出/发布候选跟着更新） */
function onDerived() {
  refreshExtras()
}

function onExportDone() {
  showExport.value = false
  refreshExtras()
}

async function removeExport(ex: ExportAssetLite) {
  const ok = await confirmDialog({
    title: '删除导出包',
    message: `删除导出包「${ex.name}」？`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await assetApi.remove(ex.id)
    refreshExtras()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
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
    refreshExtras()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

function onPubSaved() {
  showPublish.value = false
  refreshExtras()
}

// ===== [M7] 镜头工作台集成（步骤卡内嵌 + compose 卡重新合成 / stale 徽标） =====
const WB_ACTIONS = new Set(['ai_image', 'ai_video'])
const composeInfo = ref<ShotBoardCompose | null>(null)

/** 工作台上抛的合成新鲜度（多工作台步骤同源同值，非 null 覆盖即可） */
function onComposeInfo(info: ShotBoardCompose | null) {
  if (info) composeInfo.value = info
}

/** compose 卡「重新合成」（与工作台头条同源端点；succeeded 镜头步骤全跳过） */
async function recomposeStep(s: RunStep) {
  const ok = await confirmDialog({
    title: '重新合成',
    message: '将重新执行合成（镜头选择 / 分镜 / 时长的最新值生效）；已成功的镜头步骤全部跳过。',
    confirmText: '重新合成',
  })
  if (!ok) return
  busy.value = true
  err.value = ''
  try {
    await shotApi.recompose(runId, s.stepKey)
    await loadDetail()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

// ===== [M11] 引擎级单步重跑（显示条件对齐服务端 assertRepairable） =====
const rerunStep = ref<RunStep | null>(null)
const notice = ref('')

/** 可重跑：run 收敛（completed/failed）+ 目标步 succeeded/failed + 除目标外无 failed */
function canRerunStep(s: RunStep): boolean {
  const rs = run.value?.status
  if (rs !== 'completed' && rs !== 'failed') return false
  if (s.status !== 'succeeded' && s.status !== 'failed') return false
  return !steps.value.some((x) => x.id !== s.id && x.status === 'failed')
}

function openRerun(s: RunStep) {
  notice.value = ''
  rerunStep.value = s
}

/** 弹窗提交成功：关闭 + 展示服务端 note + 刷新（run 已重新入队） */
function onRerunDone(result: RerunResult) {
  rerunStep.value = null
  notice.value = result.note
  void loadDetail()
}
</script>

<template>
  <div>
    <div class="page-h">
      <RouterLink :to="`/projects/${run?.projectId ?? ''}`" class="back">
        <Icon name="arrow-left" :size="14" /> 项目
      </RouterLink>
      <h1>Run #{{ runId }}</h1>
      <span v-if="run" class="badge" :class="run.status">{{ runStatus(run.status).text }}</span>
      <span v-if="run" class="sub">{{ tplName(run.templateKey) }}</span>
      <span v-if="snapshot" class="badge skip" :title="snapshotTip(snapshot)">快照 v{{ snapshot.rv }}</span>
      <span v-if="run?.summary?.durationMs" class="sub muted">{{ fmtMs(run.summary.durationMs) }}</span>
      <div style="margin-left: auto; display: flex; gap: 8px">
        <button class="btn" title="在流水线画布中查看（节点状态 / 闸门 / 任务 / 产物，可就地操作）" @click="router.push(`/canvas?run=${runId}`)">
          <Icon name="flow" :size="14" /> 画布视图
        </button>
        <button v-if="canCancel" class="btn danger" :disabled="busy" @click="cancelRun">取消运行</button>
        <button v-if="canResume" class="btn primary" :disabled="busy" @click="resumeRun">
          <Icon name="refresh" :size="14" /> 断点续跑
        </button>
        <button class="btn" :disabled="!runAssets.length" title="选择产物打包下载" @click="showExport = true">
          <Icon name="download" :size="14" /> 导出发布包
        </button>
        <button class="btn" @click="toggleLog">
          <Icon :name="showLog ? 'x' : 'doc'" :size="14" /> {{ showLog ? '隐藏日志' : '运行日志' }}
        </button>
      </div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="notice" class="notice-box"><Icon name="check" :size="12" /> {{ notice }}</div>
    <div v-if="!run" class="empty">{{ err || '加载中…' }}</div>

    <template v-if="run">
      <div v-if="run.error" class="errbox">{{ run.error }}</div>

      <!-- 完成态「下一步建议」：模板 next 声明的下游模板，点击一键接力 -->
      <div v-if="nextOptions.length" class="nextbar panel">
        <span class="nb-t"><Icon name="sparkles" :size="13" /> 下一步建议</span>
        <button v-for="t in nextOptions" :key="t.key" type="button" class="nb-chip" @click="openRelay(t.key)">
          去「{{ t.name }}」<Icon name="chevron-right" :size="11" :stroke-width="2.2" />
        </button>
      </div>

      <!-- 闸门审阅 -->
      <div v-if="parallelHint && !gateStep" class="phint">
        <Icon name="refresh" :size="13" /> {{ parallelHint }}（引擎并发上限 2）
      </div>
      <GateDialog
        v-if="gateStep"
        :step-title="gateStep.title"
        :message="gateMessage"
        :artifact-text="gateText || undefined"
        :artifact-name="gateTextName"
        :skip-label="gateSkipLabel"
        :busy="busy"
        @decided="decide"
      />

      <div class="cols">
        <!-- 步骤时间线 -->
        <div class="timeline panel">
          <div v-for="s in steps" :key="s.id" class="st" :class="[nodeClass(s), { dim: s.status === 'pending' }]">
            <div class="rail">
              <div class="dot"><Icon :name="iconOf(s.actionKey)" :size="14" /></div>
              <div class="line" />
            </div>
            <div class="card">
              <div class="head">
                <span class="tt">{{ s.title }}</span>
                <span class="badge" :class="s.status === 'waiting_input' ? 'waiting_input' : s.status">
                  {{ stepStatus(s.status).text }}
                </span>
                <span v-if="skipInfo(s)" class="badge skip" :class="{ ghost: !skipInfo(s)?.userSkip }">
                  {{ skipInfo(s)?.text }}
                </span>
                <span class="muted mono" style="font-size: 11px">{{ s.actionKey }}</span>
                <span v-if="badges[s.id]" class="badge mem">{{ badges[s.id] }}</span>
              </div>
              <div v-if="skipInfo(s)?.userSkip" class="skipnote muted">免审放行：产物已保留，下游正常执行</div>
              <div v-if="s.error" class="serr mono">{{ s.error }}</div>
              <div class="meta muted">
                第 {{ s.seq + 1 }} 步 · 尝试 {{ s.attempts }}
                <template v-if="s.startedAt"> · {{ fmtTime(s.startedAt) }}</template>
                <template v-if="s.completedAt"> → {{ fmtTime(s.completedAt) }}</template>
              </div>

              <!-- [M7] 镜头级轻工作台（ai_image / ai_video 步骤卡内嵌） -->
              <ShotBoard
                v-if="WB_ACTIONS.has(s.actionKey)"
                :run-id="runId"
                :project-id="run?.projectId ?? 0"
                :step="s"
                :active="active"
                @changed="loadDetail()"
                @compose="onComposeInfo"
              />

              <!-- [M9] 小说改编看板（text_split 步骤卡内嵌，只读） -->
              <NovelBoard v-if="s.actionKey === 'text_split'" :run-id="runId" :step="s" />

              <!-- [M7] 合成步骤：重新合成 + stale 徽标（数据来自工作台上抛） -->
              <div v-if="s.actionKey === 'ffmpeg_merge'" class="compose-ops">
                <span
                  v-if="composeInfo?.stale === true"
                  class="badge warn-c"
                  title="镜头选择 / 分镜 / 时长有更新，重新合成后生效"
                >
                  待重新合成
                </span>
                <span v-else-if="composeInfo?.stale === false" class="badge ok-c" title="成片与当前选择一致">
                  合成已最新
                </span>
                <button class="btn sm" :disabled="busy || active" @click="recomposeStep(s)">
                  <Icon name="film" :size="12" /> 重新合成
                </button>
                <!-- [M19] A 路径：对已有成片二次派生其他发布画幅 -->
                <button
                  class="btn sm"
                  :disabled="busy || active || !hasFinalVideo"
                  :title="hasFinalVideo ? '从成片再编码一份 9:16 / 1:1 / 4:5 / 16:9 产物（不动原片）' : '尚未合成成片，无法派生'"
                  @click="deriveOpen = true"
                >
                  <Icon name="crop" :size="12" /> 派生画幅
                </button>
              </div>

              <!-- [M11] 单步重跑（显示条件对齐服务端 assertRepairable：run 收敛 + 目标步收敛 + 无其他 failed） -->
              <div v-if="canRerunStep(s)" class="rerun-ops">
                <button
                  class="btn sm"
                  :disabled="busy"
                  title="重跑该步骤：可复用成功子任务（0 调用）或全量重跑（计费）"
                  @click="openRerun(s)"
                >
                  <Icon name="refresh" :size="12" /> 重跑
                </button>
              </div>

              <details v-if="s.output && assetIds(s).length" class="prods">
                <summary>产物（{{ assetIds(s).length }} 项）</summary>
                <div class="links">
                  <button
                    v-for="aid in assetIds(s)"
                    :key="aid"
                    class="prod"
                    :disabled="previewBusy !== null"
                    :title="previewBusy === aid ? '正在载入资产…' : '内联预览资产'"
                    @click="openAssetPreview(assetIds(s), aid)"
                  >
                    <Icon name="eye" :size="11" />
                    {{ previewBusy === aid ? '载入中…' : `资产 #${aid}` }}
                  </button>
                </div>
              </details>
              <details class="raw">
                <summary>输入 / 输出快照</summary>
                <pre>{{ inputPretty(s) }}</pre>
                <pre v-if="s.output">{{ outputPretty(s) }}</pre>
              </details>
            </div>
          </div>

          <div v-if="!steps.length" class="empty">该 run 尚无步骤记录</div>
        </div>

        <!-- 右栏：日志 + 任务 -->
        <div class="right">
          <div v-if="showLog" class="panel logbox">
            <div class="lhead">
              <span class="lt">运行日志</span>
              <label class="autosc"><input v-model="autoScroll" type="checkbox" /> 自动滚动</label>
            </div>
            <pre ref="logEl" class="log mono">{{ logText || '（暂无日志）' }}</pre>
          </div>

          <TaskPanel v-if="hasTasks" :run-id="runId" :active="active" class="tpanel-wrap" @changed="loadDetail()" />

          <!-- [M4] 本 run 成本（usage_records 聚合，按 kind） -->
          <div class="panel mini">
            <div class="lhead">
              <span class="lt">本 run 成本</span>
              <span class="muted mono">{{ costUsage ? fmtCost(costUsage.totals.cost) : '—' }}</span>
            </div>
            <div v-if="costUsage?.items.length" class="mrows">
              <div v-for="it in costUsage.items" :key="it.key" class="mrow">
                <span class="chip">{{ COST_KIND_TEXT[it.key] ?? it.key }}</span>
                <span class="muted mono">{{ fmtQty(it.quantity) }}</span>
                <span class="grow" />
                <span v-if="it.unpriced" class="badge skip">未计价 {{ it.unpriced }}</span>
                <span class="mono">{{ fmtCost(it.cost) }}</span>
              </div>
            </div>
            <div v-else class="empty" style="padding: 10px 0">暂无用量记录</div>
          </div>

          <!-- [M4] 导出包（purpose=export 资产） -->
          <div class="panel mini">
            <div class="lhead">
              <span class="lt">导出包</span>
              <button class="btn sm" :disabled="!runAssets.length" @click="showExport = true">
                <Icon name="download" :size="12" /> 新建
              </button>
            </div>
            <div v-if="exportsList.length" class="mrows">
              <div v-for="ex in exportsList" :key="ex.id" class="mrow">
                <span class="enm" :title="ex.name">{{ ex.name }}</span>
                <span class="muted">{{ fmtSize(ex.fileSize) }}</span>
                <span class="grow" />
                <a class="btn sm" :href="exportApi.fileUrl(ex.id, true)"><Icon name="download" :size="12" /> 下载</a>
                <button class="btn sm danger" @click="removeExport(ex)">删除</button>
              </div>
            </div>
            <div v-else class="empty" style="padding: 10px 0">还没有导出包——选择产物一键打包下载</div>
          </div>

          <!-- [M4] 发布记录（本 run 登记） -->
          <div class="panel mini">
            <div class="lhead">
              <span class="lt">发布记录</span>
              <button class="btn sm" @click="showPublish = true">
                <Icon name="plus" :size="12" :stroke-width="2.2" /> 标记发布
              </button>
            </div>
            <div v-if="publications.length" class="mrows">
              <div v-for="pub in publications" :key="pub.id" class="mrow">
                <span class="badge">{{ PLATFORM_TEXT[pub.platform] ?? pub.platform }}</span>
                <span class="muted">{{ assetNameOf(pub.assetId) }}</span>
                <span class="muted">{{ pub.publishedAt ? fmtTime(pub.publishedAt) : '—' }}</span>
                <span class="muted mono">播放 {{ pub.metrics?.views ?? 0 }}</span>
                <span class="grow" />
                <a v-if="pub.url" :href="pub.url" target="_blank" rel="noopener" title="打开链接">
                  <Icon name="external" :size="12" />
                </a>
                <button class="btn sm danger" @click="removePub(pub)">删除</button>
              </div>
            </div>
            <div v-else class="empty" style="padding: 10px 0">未登记发布——发布后回来标记，积累复盘数据</div>
          </div>
        </div>
      </div>
    </template>

    <!-- [M4] 单 run 导出向导 / 标记发布 -->
    <ExportWizardModal v-if="showExport" :run-id="runId" @done="onExportDone" @close="showExport = false" />
    <!-- [M19] 成片多画幅派生（A 路径） -->
    <AspectDeriveModal
      v-if="deriveOpen"
      :run-id="runId"
      :project-id="run?.projectId ?? 0"
      :run-assets="runAssets"
      @changed="onDerived"
      @close="deriveOpen = false"
    />
    <PublishModal
      v-if="showPublish"
      :project-id="run?.projectId ?? 0"
      :run-id="runId"
      :asset-options="runAssets.map((a) => ({ id: a.id, name: a.name }))"
      :default-asset-id="publishCandidate"
      @done="onPubSaved"
      @close="showPublish = false"
    />

    <!-- [M11] 单步重跑弹窗 -->
    <RerunModal
      v-if="rerunStep"
      :run-id="runId"
      :step="rerunStep"
      @close="rerunStep = null"
      @done="onRerunDone"
    />

    <!-- 完成态接力：以推荐模板直达启动表单（initialTemplateKey 命中直接进表单段） -->
    <RunFormModal
      v-if="showRelay && run"
      :project-id="run.projectId"
      :initial-template-key="relayTplKey"
      @done="onRelayDone"
      @close="showRelay = false"
    />

    <!-- 产物统一预览 -->
    <AssetPreviewer v-if="previewOpen" :assets="previewAssets" :index="previewStart" @close="previewOpen = false" />
  </div>
</template>

<style scoped>
.errbox {
  background: var(--bad-weak);
  color: var(--bad);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  margin-bottom: 14px;
  word-break: break-all;
}

/* [M2] 并行执行提示条 */
.phint {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--run);
  background: var(--run-weak);
  border: 1px solid rgb(129 140 248 / 22%);
  border-radius: 8px;
  padding: 6px 12px;
  margin-bottom: 12px;
}

.skipnote {
  font-size: 11.5px;
  margin-top: 6px;
}

/* [M2] 并行执行提示条 */
.phint {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--run);
  background: var(--run-weak);
  border: 1px solid rgb(129 140 248 / 22%);
  border-radius: 8px;
  padding: 6px 12px;
  margin-bottom: 12px;
}

.skipnote {
  font-size: 11.5px;
  margin-top: 6px;
}

/* 完成态「下一步建议」接力条（模板元数据 next 声明） */
.nextbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
}

.nb-t {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}

.nb-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid rgb(99 102 241 / 26%);
  background: var(--accent-weak);
  color: var(--accent);
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.nb-chip:hover {
  border-color: rgb(99 102 241 / 45%);
  background: rgb(99 102 241 / 24%);
}

.cols {
  display: grid;
  /* minmax(0,…)：避免右栏任务长 prompt（nowrap）经 auto min 撑破轨道致整页横滚（M11 实弹修复） */
  grid-template-columns: minmax(0, 1fr) 400px;
  gap: 16px;
  align-items: start;
}

.right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: sticky;
  top: 16px;
}

.timeline {
  padding: 10px 14px;
}

.st {
  display: flex;
  gap: 12px;
}

.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 28px;
}

.dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgb(148 163 184 / 13%);
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  z-index: 1;
  border: 1px solid rgb(148 163 184 / 14%);
}

.line {
  width: 2px;
  flex: 1;
  min-height: 12px;
  background: var(--border);
}

.st:last-child .line {
  display: none;
}

.st.ok .dot {
  background: var(--ok-weak);
  color: var(--ok);
  border-color: rgb(34 197 94 / 25%);
}

/* [M2] skipped：中性灰，虚线标记「无产物经过」 */
.st.skip .dot {
  background: rgb(148 163 184 / 7%);
  color: var(--text-3);
  border-color: rgb(148 163 184 / 18%);
  border-style: dashed;
}

.st.skip .line {
  background-image: linear-gradient(90deg, transparent 30%, var(--border) 31%, var(--border) 69%, transparent 70%);
  background-size: 6px 2px;
  background-repeat: repeat-x;
  background-position: 0 60%;
}

.st.running .dot {
  background: var(--run-weak);
  color: var(--run);
  border-color: rgb(129 140 248 / 30%);
  animation: pulse 1.2s infinite;
}

.st.failed .dot {
  background: var(--bad-weak);
  color: var(--bad);
  border-color: rgb(248 113 113 / 26%);
}

.st.gate .dot {
  background: var(--warn-weak);
  color: var(--warn);
  border-color: rgb(245 158 11 / 28%);
  box-shadow: 0 0 0 4px rgb(245 158 11 / 10%);
}

.st.cancel .dot {
  background: rgb(148 163 184 / 9%);
  color: var(--text-3);
  border-color: rgb(148 163 184 / 16%);
}

@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}

.card {
  flex: 1;
  padding: 10px 4px 14px;
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tt {
  font-weight: 600;
  font-size: 14px;
}

.serr {
  margin-top: 8px;
  background: var(--bad-weak);
  color: var(--bad);
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.meta {
  font-size: 11.5px;
  margin-top: 4px;
}

.prods {
  margin-top: 6px;
  font-size: 12.5px;
}

.prods summary,
.raw summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 12px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 5px;
}

.prod {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  background: var(--accent-weak);
  border: 1px solid transparent;
  color: var(--accent-h);
  padding: 2px 9px;
  border-radius: 999px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.prod:hover {
  border-color: rgb(99 102 241 / 45%);
  color: #fff;
}

.prod:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.raw {
  margin-top: 5px;
}

.raw pre {
  background: var(--code-bg);
  color: #b9c7dc;
  font-size: 11px;
  border-radius: 8px;
  border: 1px solid var(--border);
  padding: 8px 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 4px 0 0;
}

/* [M3] 记忆/角色徽标：品牌靛蓝，与状态徽标区分 */
.badge.mem {
  background: var(--accent-weak);
  color: var(--accent);
  border-color: rgb(99 102 241 / 26%);
}

/* [M7] 合成步骤操作行：重新合成 + stale 徽标 */
.compose-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

/* [M11] 单步重跑按钮行 + 成功 notice */
.rerun-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.notice-box {
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--ok-weak);
  color: var(--ok);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12.5px;
  margin-bottom: 12px;
  word-break: break-all;
}

.badge.warn-c {
  background: var(--warn-weak);
  color: var(--warn);
  border-color: rgb(245 158 11 / 24%);
}

.badge.ok-c {
  background: var(--ok-weak);
  color: var(--ok);
  border-color: rgb(34 197 94 / 22%);
}

.dim {
  opacity: 0.55;
}

.logbox {
  padding: 10px 14px;
}

.lhead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.lt {
  font-weight: 600;
  font-size: 13px;
}

.autosc {
  font-size: 11.5px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 4px;
}

.log {
  margin: 0;
  max-height: 420px;
  overflow-y: auto;
  background: var(--code-bg);
  color: #b9c7dc;
  font-size: 11px;
  line-height: 1.6;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-all;
}

.tpanel-wrap {
  max-height: 360px;
  overflow-y: auto;
}

/* [M4] 右栏辅助面板（成本 / 导出包 / 发布记录） */
.mini {
  padding: 10px 14px;
}

.mrows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.mrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.grow {
  flex: 1;
}

.enm {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1080px) {
  .cols {
    grid-template-columns: minmax(0, 1fr);
  }

  .right {
    position: static;
  }
}
</style>
