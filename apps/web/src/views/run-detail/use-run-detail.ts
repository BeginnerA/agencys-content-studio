/** [M28] 运行详情核心：数据流 / 闸门 / 日志 / 防抖刷新 / socket 实时；loadBadges 等附加数据经 deps 延迟注入。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { assetApi, runApi, shotApi, templateApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import { useStudio } from '../../lib/socket'
import type { StudioEventMap } from '../../lib/socket'
import type {
  Asset,
  RunDetail,
  RunStep,
  ShotBoardCompose,
  TemplateDetail,
} from '../../lib/types'

export function useRunDetail(deps: {
  loadBadges: () => Promise<void>
  loadExtras: (projectId: number) => Promise<void>
  refreshExtras: () => void
  loadTplMetas: () => Promise<void>
}) {
  const { loadBadges, loadExtras, refreshExtras, loadTplMetas } = deps

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
  const hasTasks = computed(() =>
    steps.value.some((s) => s.actionKey === 'ai_image'),
  )
  const active = computed(
    () => run.value?.status === 'running' || run.value?.status === 'queued',
  )

  // [M2] 当前闸门的免审按钮文案（模板 gate.skip_label）；模板不可达时隐藏
  const gateSkipLabel = computed(() => {
    const step = gateStep.value
    if (!step) return undefined
    const def = tpl.value?.steps.find((d) => d.key === step.stepKey)
    return def?.gate?.skip_label
  })

  // [M2] 并行执行提示：同一时刻 ≥2 步骤处于执行/待审状态（引擎就绪集并发 ≤2）
  const parallelHint = computed(() => {
    const actives = steps.value.filter(
      (s) => s.status === 'running' || s.status === 'waiting_input',
    )
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
    if (s.curV !== undefined && s.curV !== s.rv)
      parts.push(`当前文件版本 v${s.curV}`)
    if (s.added.length) parts.push(`文件新增步骤：${s.added.join('、')}`)
    if (s.removed.length) parts.push(`快照含步骤：${s.removed.join('、')}`)
    return parts.join('；')
  }

  /** 模板 gate message 的 {input.x} 插值（离线回填场景） */
  function interpolate(msg: string, input: Record<string, unknown>): string {
    return msg.replace(/\{input\.([\w-]+)\}/g, (_, k: string) =>
      String(input[k] ?? ''),
    )
  }

  async function loadGate() {
    gateStep.value = null
    gateText.value = ''
    const step = steps.value.find((s) => s.status === 'waiting_input')
    if (!step || !run.value) return
    // 消息优先取模板定义（服务端事件已解析；此处静态插值）
    const stepDef = tpl.value?.steps.find((d) => d.key === step.stepKey)
    gateMessage.value = interpolate(
      stepDef?.gate?.message ?? `请审阅「${step.title}」的产物`,
      run.value.input,
    )
    const assetId = (step.output?.asset_ids as number[] | undefined)?.[0]
    if (!assetId) return
    gateStep.value = step
    try {
      const { asset: a } = await assetApi.detail(assetId)
      if (
        a.kind === 'text' ||
        a.purpose === 'script' ||
        a.purpose === 'storyboard'
      ) {
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
      if (autoScroll.value && logEl.value)
        logEl.value.scrollTop = logEl.value.scrollHeight
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
      const body: Record<string, unknown> = {
        step_key: gateStep.value.stepKey,
        decision: action,
      }
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

  // ===== socket 实时 =====
  const studio = useStudio(runId)
  function onStep(p: StudioEventMap['run.step']) {
    if (p.runId !== runId) return
    const local = steps.value.find((s) => s.id === p.step.id)
    if (local && p.step.status) {
      local.status = p.step.status as RunStep['status']
      // [M4] server run.step 不含 attempts（删除旧 p.step.attempts 行）；详细状态由 loadDetail 兜底
      if (
        p.step.status === 'waiting_input' ||
        p.step.status === 'succeeded' ||
        p.step.status === 'skipped'
      ) {
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
      const list = await Promise.all(
        ids.map((id) => assetApi.detail(id).then((r) => r.asset)),
      )
      previewAssets.value = list
      previewStart.value = Math.max(0, ids.indexOf(firstId))
      previewOpen.value = true
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    } finally {
      previewBusy.value = null
    }
  }
  let extrasLoaded = false

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
      message:
        '将重新执行合成（镜头选择 / 分镜 / 时长的最新值生效）；已成功的镜头步骤全部跳过。',
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
  // 弹窗内级联/单步两个入口的可用性（openRerun 时快照，避免模板对可空 rerunStep 的窄化问题）
  const rerunAllowSingle = ref(false)
  const rerunAllowCascade = ref(false)

  /** 可单步重跑：run 收敛（completed/failed）+ 目标步 succeeded/failed + 除目标外无 failed */
  function canRerunStep(s: RunStep): boolean {
    const rs = run.value?.status
    if (rs !== 'completed' && rs !== 'failed') return false
    if (s.status !== 'succeeded' && s.status !== 'failed') return false
    return !steps.value.some((x) => x.id !== s.id && x.status === 'failed')
  }

  /** 可级联重跑（入口可见性启发式）：run 收敛 + 目标步 succeeded/failed + 存在下游步；真实门禁（范围外 failed / 上游未就绪）以服务端 preview 为准 */
  function canCascadeStep(s: RunStep): boolean {
    const rs = run.value?.status
    if (rs !== 'completed' && rs !== 'failed') return false
    if (s.status !== 'succeeded' && s.status !== 'failed') return false
    return steps.value.some((x) => x.seq > s.seq)
  }

  function openRerun(s: RunStep) {
    notice.value = ''
    rerunStep.value = s
    rerunAllowSingle.value = canRerunStep(s)
    rerunAllowCascade.value = canCascadeStep(s)
  }

  /** 弹窗提交成功：关闭 + 展示服务端 note + 刷新（run 已重新入队） */
  function onRerunDone(result: { note: string }) {
    rerunStep.value = null
    notice.value = result.note
    void loadDetail()
  }

  return {
    route,
    router,
    runId,
    detail,
    tpl,
    err,
    busy,
    gateStep,
    gateMessage,
    gateText,
    gateTextName,
    showLog,
    logText,
    autoScroll,
    logEl,
    run,
    steps,
    canCancel,
    canResume,
    hasTasks,
    active,
    gateSkipLabel,
    parallelHint,
    snapshot,
    snapshotTip,
    interpolate,
    loadGate,
    loadDetail,
    scheduleDetailRefresh,
    runDetailRefresh,
    loadLog,
    scheduleLogRefresh,
    toggleLog,
    decide,
    cancelRun,
    resumeRun,
    studio,
    onStep,
    onTerminal,
    onGate,
    onLog,
    previewAssets,
    previewOpen,
    previewStart,
    previewBusy,
    openAssetPreview,
    WB_ACTIONS,
    composeInfo,
    onComposeInfo,
    recomposeStep,
    rerunStep,
    rerunAllowSingle,
    rerunAllowCascade,
    notice,
    canRerunStep,
    canCascadeStep,
    openRerun,
    onRerunDone,
  }
}
export type RunDetailApi = ReturnType<typeof useRunDetail>
