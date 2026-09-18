import { computed, reactive } from 'vue'
import { creationChatApi, newRequestKey } from '../../lib/api'
import { ApiError } from '../../lib/api/core'
import { studioOff, studioOn } from '../../lib/socket'
import type { CreationDetail, CreationSessionListItem, CreationMode } from '../../lib/types'

// ===== [M30] 轻松创作状态机（模块级单例：列表页与详情页共享，切页不丢在途状态） =====

const RUNNING = new Set(['queued', 'running', 'pending', 'processing', 'waiting_input'])

function isPollable(d: CreationDetail | null): boolean {
  if (!d) return false
  const runActive = !!d.progress && (RUNNING.has(d.progress.status) || d.progress.status === 'processing')
  const starting = d.session.status === 'starting'
  return (runActive || starting) && !d.result
}

const state = reactive({
  currentId: 0,
  detail: null as CreationDetail | null,
  sessions: [] as CreationSessionListItem[],
  loadingList: false,
  loadingDetail: false,
  busySend: false,
  busyAction: false,
  error: '',
  notice: '',
})

let pollTimer: ReturnType<typeof setInterval> | null = null
let wired = false

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : String(e)
}

/** 提交响应：仅当仍停留在同一会话时写入，防止旧请求覆盖新会话（异步竞态红线） */
function commit(id: number, detail: CreationDetail): void {
  if (id !== state.currentId) return
  state.detail = detail
  syncConfirmKey()
}

// 确认幂等键：同一 planHash+revision 复用，重试点击不新起 run；方案变化后重置
const confirmKey = reactive<{ hash: string; revision: number; key: string }>({ hash: '', revision: 0, key: '' })
function syncConfirmKey(): void {
  const s = state.detail?.session
  const hash = s?.planHash ?? ''
  if (confirmKey.hash === hash && confirmKey.revision === (s?.planRevision ?? 0)) return
  confirmKey.hash = hash
  confirmKey.revision = s?.planRevision ?? 0
  confirmKey.key = hash ? newRequestKey('cfm') : ''
}

async function fetchDetail(id: number): Promise<void> {
  try {
    const detail = await creationChatApi.detail(id)
    commit(id, detail)
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
  }
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function tickPoll(): void {
  if (!isPollable(state.detail)) {
    stopPolling()
    return
  }
  void fetchDetail(state.currentId)
}

/** 运行中：Socket 事件即时重拉 + 定时兜底（断线/漏事件仍能收敛，刷新页面不中止后端制作） */
function ensurePolling(): void {
  if (isPollable(state.detail) && !pollTimer) pollTimer = setInterval(tickPoll, 4000)
  if (!isPollable(state.detail)) stopPolling()
}

function onRunEvent(): void {
  const p = state.detail?.progress
  if (p && state.currentId) void fetchDetail(state.currentId)
}

function wireSocket(): void {
  if (wired) return
  wired = true
  studioOn('run.completed', onRunEvent)
  studioOn('run.failed', onRunEvent)
  studioOn('run.step', onRunEvent)
  studioOn('task.updated', onRunEvent)
}

// ===== 公开动作 =====

async function loadSessions(): Promise<void> {
  state.loadingList = true
  state.error = ''
  try {
    state.sessions = (await creationChatApi.list()).items
  } catch (e) {
    state.error = errText(e)
  } finally {
    state.loadingList = false
  }
}

async function open(id: number): Promise<void> {
  wireSocket()
  state.currentId = id
  state.detail = null
  state.error = ''
  state.notice = ''
  confirmKey.hash = ''
  state.loadingDetail = true
  try {
    const detail = await creationChatApi.detail(id)
    commit(id, detail)
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
  } finally {
    if (id === state.currentId) state.loadingDetail = false
    ensurePolling()
  }
}

/** 首次发送一句话：自动建草稿项目 + 会话 + 规划（可能产生 LLM 费用） */
async function startIdea(content: string): Promise<number | null> {
  state.busySend = true
  state.error = ''
  try {
    const detail = await creationChatApi.create(content, newRequestKey('new'))
    state.currentId = detail.session.id
    state.detail = detail
    syncConfirmKey()
    wireSocket()
    ensurePolling()
    return detail.session.id
  } catch (e) {
    state.error = errText(e)
    return null
  } finally {
    state.busySend = false
  }
}

async function send(content: string): Promise<void> {
  const id = state.currentId
  if (!id || state.busySend) return
  state.busySend = true
  state.error = ''
  try {
    const detail = await creationChatApi.send(id, content, newRequestKey('msg'))
    commit(id, detail)
    ensurePolling()
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
  } finally {
    state.busySend = false
  }
}

async function refreshPreflight(): Promise<void> {
  const id = state.currentId
  if (!id || state.busyAction) return
  state.busyAction = true
  state.error = ''
  try {
    commit(id, await creationChatApi.preflight(id))
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
  } finally {
    state.busyAction = false
  }
}

async function confirm(acceptUnpriced: boolean): Promise<number | null> {
  const s = state.detail?.session
  const id = state.currentId
  if (!s || !id || s.status !== 'ready' || !s.planHash || state.busyAction) return null
  if (!confirmKey.key || confirmKey.hash !== s.planHash || confirmKey.revision !== s.planRevision) syncConfirmKey()
  state.busyAction = true
  state.error = ''
  try {
    const { runId } = await creationChatApi.confirm(id, {
      planRevision: s.planRevision,
      planHash: s.planHash,
      idempotencyKey: confirmKey.key,
      acceptUnpriced,
    })
    await fetchDetail(id)
    ensurePolling()
    return runId
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
    return null
  } finally {
    state.busyAction = false
  }
}

async function cancel(): Promise<void> {
  const id = state.currentId
  if (!id || state.busyAction) return
  state.busyAction = true
  state.error = ''
  try {
    commit(id, await creationChatApi.cancel(id))
    ensurePolling()
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
  } finally {
    state.busyAction = false
  }
}

async function retry(verifiedFailedTaskIds: number[]): Promise<number | null> {
  const s = state.detail?.session
  const p = state.detail?.progress
  const id = state.currentId
  if (!s || !p || !id || !s.planHash || state.busyAction) return null
  state.busyAction = true
  state.error = ''
  try {
    const { runId } = await creationChatApi.retry(id, {
      planRevision: s.planRevision,
      planHash: s.planHash,
      idempotencyKey: newRequestKey('rt'),
      acceptUnpriced: true,
      runId: p.runId,
      verifiedFailedTaskIds,
    })
    await fetchDetail(id)
    ensurePolling()
    return runId
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
    return null
  } finally {
    state.busyAction = false
  }
}

function leave(): void {
  stopPolling()
  state.currentId = 0
}

const modeLabel = computed<CreationMode | null>(() => state.detail?.session.plan?.mode ?? null)

export function useEasyCreate() {
  return {
    state,
    confirmKey,
    modeLabel,
    canConfirm: computed(() => state.detail?.session.status === 'ready' && !!state.detail?.session.preflight?.execution),
    hasUnpriced: computed(() => (state.detail?.session.preflight?.estimate.unpriced.length ?? 0) > 0),
    loadSessions,
    open,
    startIdea,
    send,
    refreshPreflight,
    confirm,
    cancel,
    retry,
    leave,
    ensurePolling,
    stopPolling,
    errText,
  }
}
