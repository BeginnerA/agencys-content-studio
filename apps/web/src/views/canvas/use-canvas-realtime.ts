/**
 * [M15] 画布页实时层（views/canvas/index.vue 拆分：M26 红线纯重构，逻辑逐字搬移）
 * 350ms 防抖 + in-flight 合并对账 / runId 可切换手动 join-leave run 房间 / 抽屉日志节流拉取 / socket 订阅生命周期。
 * 依赖注入：tab、runId、drawerOpen、loadRun、loadOverview（数据层由页面提供）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { runApi } from '../../lib/api'
import { getSocket, studioOff, studioOn } from '../../lib/socket'
import type { StudioEventMap } from '../../lib/socket'

export function useCanvasRealtime(opts: {
  tab: Ref<'run' | 'template' | 'overview'>
  runId: Ref<number | null>
  drawerOpen: Ref<boolean>
  loadRun: (silent?: boolean) => Promise<void>
  loadOverview: (silent?: boolean) => Promise<void>
}) {
  const { tab, runId, drawerOpen, loadRun, loadOverview } = opts

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
      const task = tab.value === 'overview' ? loadOverview(true) : loadRun(true)
      void task.finally(() => {
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
    else if (tab.value === 'overview') scheduleRefresh()
  }
  function onTaskEvent(p: StudioEventMap['task.updated']): void {
    if (runId.value != null && (p.runId == null || p.runId === runId.value))
      scheduleRefresh()
    else if (tab.value === 'overview') scheduleRefresh()
  }
  /** [M23] 批次头变更（计数/状态）→ 全景对账 */
  function onBatchEvent(): void {
    if (tab.value === 'overview') scheduleRefresh()
  }
  function onLogEvent(p: StudioEventMap['step.log']): void {
    if (runId.value != null && p.runId === runId.value && drawerOpen.value)
      scheduleLogRefresh()
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

  onMounted(() => {
    studioOn('run.step', onRunEvent)
    studioOn('run.gate', onRunEvent)
    studioOn('run.completed', onRunEvent)
    studioOn('run.failed', onRunEvent)
    studioOn('task.updated', onTaskEvent)
    studioOn('step.log', onLogEvent)
    studioOn('batch.updated', onBatchEvent)
  })

  onBeforeUnmount(() => {
    studioOff('run.step', onRunEvent)
    studioOff('run.gate', onRunEvent)
    studioOff('run.completed', onRunEvent)
    studioOff('run.failed', onRunEvent)
    studioOff('task.updated', onTaskEvent)
    studioOff('step.log', onLogEvent)
    studioOff('batch.updated', onBatchEvent)
    leaveRunRoom()
    if (refreshTimer != null) window.clearTimeout(refreshTimer)
    if (logTimer != null) window.clearTimeout(logTimer)
  })

  return { logText, loadLog }
}
