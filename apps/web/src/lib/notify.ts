import type { Router } from 'vue-router'
import { settingsApi } from './api'
import { studioOn } from './socket'

/**
 * 浏览器通知：仅后台标签页（document.hidden）推送
 * run 终态 / 闸门到达 / 批次收敛；Notification 不可用 / 权限未授予 → 全静默（零报错）。
 * 事件载体零服务端改动（payload 已含 runId/stepKey/message/batchId/status/finished/total）。
 */

/** settings key 'notify'（缺省全开；与设置页「通知」Tab 同构） */
export interface NotifyPrefs {
  enabled: boolean
  /** 运行终态（完成 / 失败） */
  run_terminal: boolean
  /** 闸门到达（等待审阅） */
  gate: boolean
  /** 批次收敛（完成 / 部分失败 / 失败） */
  batch: boolean
}

/** 缺省全开（settings 无 'notify' 键或读取失败时的回落） */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  enabled: true,
  run_terminal: true,
  gate: true,
  batch: true,
}

/** 惰性一次性缓存（读取失败默认全开）；设置页保存后调 invalidateNotifyPrefs 失效 */
let prefs: NotifyPrefs | null = null

async function readPrefs(): Promise<NotifyPrefs> {
  if (prefs) return prefs
  try {
    const r = await settingsApi.list()
    const raw = r.items.find((it) => it.key === 'notify')?.value
    prefs = {
      ...DEFAULT_NOTIFY_PREFS,
      ...(raw && typeof raw === 'object' ? (raw as Partial<NotifyPrefs>) : {}),
    }
  } catch {
    prefs = { ...DEFAULT_NOTIFY_PREFS }
  }
  return prefs
}

/** 设置页保存后调用（缓存失效，下一事件重读） */
export function invalidateNotifyPrefs(): void {
  prefs = null
}

/** 当前权限状态（设置页展示用） */
export function notifyPermission():
  'granted' | 'default' | 'denied' | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/** 请求权限（设置页按钮；需用户手势触发） */
export async function requestNotifyPermission(): Promise<string> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

function canPush(): boolean {
  return (
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted' &&
    document.hidden
  )
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 条件推送：权限 + 后台 + 开关全满足才发；点击聚焦并跳转（tag 同实体去重） */
async function maybePush(
  router: Router,
  pick: (p: NotifyPrefs) => boolean,
  title: string,
  body: string,
  tag: string,
  url: string,
): Promise<void> {
  if (!canPush()) return
  const p = await readPrefs()
  if (!p.enabled || !pick(p) || !canPush()) return // await 后复核（读取期间可能已切回前台）
  try {
    const n = new Notification(title, { body: body || undefined, tag })
    n.onclick = () => {
      window.focus()
      void router.push(url)
      n.close()
    }
  } catch {
    /* 构造失败（如部分环境需 Service Worker）静默 */
  }
}

const BATCH_LABEL: Record<string, string> = {
  completed: '完成',
  partial_failed: '部分失败',
  failed: '失败',
}

let inited = false

/** App.vue 挂载调用（幂等；订阅四类事件） */
export function initNotify(router: Router): void {
  if (inited) return
  inited = true
  studioOn('run.completed', (p) => {
    void maybePush(
      router,
      (n) => n.run_terminal,
      `运行 #${p.runId} 已完成`,
      '',
      `run-${p.runId}`,
      `/runs/${p.runId}`,
    )
  })
  studioOn('run.failed', (p) => {
    void maybePush(
      router,
      (n) => n.run_terminal,
      `运行 #${p.runId} 失败：${p.stepKey}`,
      p.error ? clip(p.error, 100) : '',
      `run-${p.runId}`,
      `/runs/${p.runId}`,
    )
  })
  studioOn('run.gate', (p) => {
    void maybePush(
      router,
      (n) => n.gate,
      `运行 #${p.runId} 等待审阅`,
      p.message ? clip(p.message, 100) : `步骤 ${p.stepKey}`,
      `run-${p.runId}`,
      `/runs/${p.runId}`,
    )
  })
  studioOn('batch.updated', (p) => {
    const label = BATCH_LABEL[p.status]
    if (!label) return // running 中段更新 / 用户主动取消（cancelled）不打扰
    void maybePush(
      router,
      (n) => n.batch,
      `批次 #${p.batchId} ${label}`,
      `${p.finished}/${p.total}`,
      `batch-${p.batchId}`,
      `/batches/${p.batchId}`,
    )
  })
}
