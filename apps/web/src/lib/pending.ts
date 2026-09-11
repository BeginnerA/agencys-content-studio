/**
 * 全局「待审阅」角标状态（跨路由共享单例）。
 * 数据源：GET /api/v1/runs?status=waiting_input（全库聚合；人工闸门场景远低于接口 limit 100）。
 * 刷新触发：应用启动 / 路由切换（App.vue）/ 页面重新可见 / 30s 定时兜底 / 项目页事件（schedulePendingRefresh）。
 */
import { reactive } from 'vue'
import { runApi } from './api'

const POLL_MS = 30_000

export const pending = reactive({
  byProject: {} as Record<number, number>,
  total: 0,
  /** 首次拉取完成前不渲染角标，避免闪现又消失 */
  loaded: false,
})

let inflight: Promise<void> | null = null
let debounceTimer: number | undefined
let pollTimer: number | undefined
let visibilityHandler: (() => void) | undefined
let running = false

/** 立即刷新（并发合并：同一时刻只发一个请求；失败静默——角标是辅助信息，等服务端恢复后自然追上） */
export function refreshPending(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const { items } = await runApi.list('?status=waiting_input')
      const byProject: Record<number, number> = {}
      for (const r of items) byProject[r.projectId] = (byProject[r.projectId] ?? 0) + 1
      pending.byProject = byProject
      pending.total = items.length
      pending.loaded = true
    } catch {
      // 静默：等待下次触发
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 防抖刷新（高频事件源用，如 run.step） */
export function schedulePendingRefresh(delay = 900): void {
  if (debounceTimer) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined
    void refreshPending()
  }, delay)
}

/** 某项目待审阅数（0 表示无） */
export function pendingOf(projectId: number): number {
  return pending.byProject[projectId] ?? 0
}

/** 启动全局 watcher（单例）：首拉 + 30s 轮询（仅前台）+ 重新可见时拉。返回停止函数 */
export function startPendingWatcher(): () => void {
  if (running) return () => {}
  running = true
  void refreshPending()
  pollTimer = window.setInterval(() => {
    if (!document.hidden) void refreshPending()
  }, POLL_MS)
  visibilityHandler = () => {
    if (!document.hidden) void refreshPending()
  }
  document.addEventListener('visibilitychange', visibilityHandler)
  return () => {
    running = false
    if (pollTimer) window.clearInterval(pollTimer)
    pollTimer = undefined
    if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = undefined
  }
}
