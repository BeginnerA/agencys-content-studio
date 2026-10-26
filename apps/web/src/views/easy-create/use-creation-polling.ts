/**
 * 会话详情刷新：轮询兜底 + Socket 事件即时重拉。
 *
 * 从 use-creation-chat.ts 外抽（该文件有 ≤800 行工程红线），行为逐字不变：
 * 运行中每 4s 拉一次详情（断线/漏事件仍能收敛），run 相关事件到达时立即重拉
 * （审阅闸门不必等下一轮轮询）。刷新动作由调用方注入，本模块只负责节流/接线。
 */
import { studioOn } from '../../lib/socket'
import type { CreationDetail } from '../../lib/types'

// waiting_input 不在本集合内：它是「等用户决策」而不是「等在途请求」，已挂起闸门时继续 4s 轮询只会空转（见 isPollable 的 parked 分支）
export const RUNNING_STATUSES = new Set([
  'queued',
  'running',
  'pending',
  'processing',
])

export function createPolling(opts: {
  detailOf: () => CreationDetail | null
  currentIdOf: () => number
  refresh: (id: number) => void
}) {
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let wired = false

  function isPollable(d: CreationDetail | null): boolean {
    if (!d) return false
    const p = d.progress
    // 投影带 review = 闸门真的在等用户点按钮 → 不轮询；waiting_input 但无待审步骤 = 决策后的瞬时态（run 行比步骤行晚一步更新），继续轮询至收敛
    const parked = !!p && p.status === 'waiting_input' && !!p.review
    const runActive =
      !!p &&
      !parked &&
      (RUNNING_STATUSES.has(p.status) ||
        p.status === 'processing' ||
        p.status === 'waiting_input')
    const starting = d.session.status === 'starting'
    return (
      (runActive || starting || d.session.status === 'planning') && !d.result
    )
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function tickPoll(): void {
    if (!isPollable(opts.detailOf())) {
      stopPolling()
      return
    }
    opts.refresh(opts.currentIdOf())
  }

  /** 运行中：Socket 事件即时重拉 + 定时兜底（断线/漏事件仍能收敛，刷新页面不中止后端制作） */
  function ensurePolling(): void {
    if (isPollable(opts.detailOf()) && !pollTimer)
      pollTimer = setInterval(tickPoll, 4000)
    if (!isPollable(opts.detailOf())) stopPolling()
  }

  function onRunEvent(): void {
    const p = opts.detailOf()?.progress
    if (p && opts.currentIdOf()) opts.refresh(opts.currentIdOf())
  }

  function wireSocket(): void {
    if (wired) return
    wired = true
    studioOn('run.completed', onRunEvent)
    studioOn('run.failed', onRunEvent)
    studioOn('run.step', onRunEvent)
    // 闸门挂起：不靠下一轮轮询，事件到达即重拉（审阅面板即时出现）
    studioOn('run.gate', onRunEvent)
    studioOn('task.updated', onRunEvent)
  }

  return { ensurePolling, stopPolling, wireSocket }
}
