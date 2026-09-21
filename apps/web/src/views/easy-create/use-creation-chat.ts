import { computed, reactive } from 'vue'
import { creationChatApi, newRequestKey } from '../../lib/api'
import { ApiError } from '../../lib/api/core'
import { studioOff, studioOn } from '../../lib/socket'
import {
  REF_DEFAULT_ROLE,
  REF_MAX_COUNT,
  REF_MAX_PER_KIND,
  refKindByExt,
} from '../../lib/types'
import type {
  Asset,
  CreationDeleteResult,
  CreationDetail,
  CreationProjectMeta,
  CreationSessionListItem,
  CreationMode,
  CreationRefKind,
  CreationRefRole,
} from '../../lib/types'

// ===== [M30] 轻松创作状态机（模块级单例：列表页与详情页共享，切页不丢在途状态） =====

const RUNNING = new Set([
  'queued',
  'running',
  'pending',
  'processing',
  'waiting_input',
])

/** [M31] composer 待采纳参考附件（本地项；上传后回填 assetId/hash/thumbUrl）。
 *  [M31+] 两类来源：上传项持有 file；「从素材选取」项无 file，凭 sourceAssetId 走 from-asset 登记（改用途/重试同源）。 */
export interface AttachmentItem {
  clientId: string
  file?: File
  name: string
  kind: CreationRefKind
  role: CreationRefRole
  assetId?: number
  hash?: string
  thumbUrl?: string | null
  uploading: boolean
  error?: string
  /** 素材库源资产 id（仅从素材选取项；服务端去重后可能对应不同会话资产） */
  sourceAssetId?: number
}

function isPollable(d: CreationDetail | null): boolean {
  if (!d) return false
  const runActive =
    !!d.progress &&
    (RUNNING.has(d.progress.status) || d.progress.status === 'processing')
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
  // [M31] 参考附件托盘（仅当前会话；切会话/离开即清空，避免旧素材错挂新会话）
  attachments: [] as AttachmentItem[],
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
  syncProjectDraft()
}

// 确认幂等键：同一 planHash+revision 复用，重试点击不新起 run；方案变化后重置
const confirmKey = reactive<{ hash: string; revision: number; key: string }>({
  hash: '',
  revision: 0,
  key: '',
})
function syncConfirmKey(): void {
  const s = state.detail?.session
  const hash = s?.planHash ?? ''
  if (
    confirmKey.hash === hash &&
    confirmKey.revision === (s?.planRevision ?? 0)
  )
    return
  confirmKey.hash = hash
  confirmKey.revision = s?.planRevision ?? 0
  confirmKey.key = hash ? newRequestKey('cfm') : ''
}

// ===== [M40] 立项信息可编辑态：默认用平台智能填写值（Tier A），用户改过的字段确认后随 confirm 提交（Tier B 可覆盖） =====
export const projectDraft = reactive({
  name: '',
  genre: '',
  templateKey: '',
  tagsText: '',
  brief: '',
  /** 用户改过任一项 → true：服务端回读不再覆盖本地编辑；确认成功后重置 */
  dirty: false,
})

/** 标签文本 → 数组（支持中英文逗号/顿号分隔；去空去重） */
export function parseTagsText(text: string): string[] {
  const out: string[] = []
  for (const t of text.split(/[,，、]/)) {
    const v = t.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** 服务端智能填写值回同步到编辑态（用户未改动时才覆盖，避免冲掉正在输入的内容） */
function syncProjectDraft(): void {
  const p = state.detail?.session.project
  if (!p) {
    projectDraft.dirty = false
    return
  }
  if (projectDraft.dirty) return
  projectDraft.name = p.name
  projectDraft.genre = p.genre
  projectDraft.templateKey = p.templateKey
  projectDraft.tagsText = p.tags.join('，')
  projectDraft.brief = p.brief
}

/** 可编辑窗口：仅未立项（draft 影子态）且方案就绪时展示编辑区 */
const projectEditable = computed(
  () => state.detail?.session.project?.isDraft === true,
)

/** 确认时携带的覆盖值：只提交与平台智能填写值不同的字段；全无改动 → undefined（沿用服务端值） */
function projectOverrides(): Partial<CreationProjectMeta> | undefined {
  const p = state.detail?.session.project
  if (!p || !p.isDraft || !projectDraft.dirty) return undefined
  const o: Partial<CreationProjectMeta> = {}
  if (projectDraft.name.trim() && projectDraft.name.trim() !== p.name)
    o.name = projectDraft.name.trim()
  if (projectDraft.genre && projectDraft.genre !== p.genre)
    o.genre = projectDraft.genre
  if (projectDraft.templateKey && projectDraft.templateKey !== p.templateKey)
    o.templateKey = projectDraft.templateKey
  const tags = parseTagsText(projectDraft.tagsText)
  if (tags.length && tags.join(',') !== p.tags.join(',')) o.tags = tags
  if (projectDraft.brief.trim() && projectDraft.brief.trim() !== p.brief)
    o.brief = projectDraft.brief.trim()
  return Object.keys(o).length ? o : undefined
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
  if (isPollable(state.detail) && !pollTimer)
    pollTimer = setInterval(tickPoll, 4000)
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
  projectDraft.dirty = false
  state.attachments = []
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

/** 首次发送一句话：建会话 + 影子草稿项目（对用户隐身，不立项）并规划（会产生 LLM 费用） */
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
  // [M31] 本条消息采纳已上传成功的参考附件（上传中/失败的项保留，不静默丢参考）
  const sentAssetIds = state.attachments
    .filter((a) => a.assetId && !a.error)
    .map((a) => a.assetId!)
  try {
    const detail = await creationChatApi.send(
      id,
      content,
      newRequestKey('msg'),
      sentAssetIds,
    )
    commit(id, detail)
    if (id === state.currentId)
      state.attachments = state.attachments.filter((a) => !a.assetId || a.error)
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
  if (!s || !id || s.status !== 'ready' || !s.planHash || state.busyAction)
    return null
  if (
    !confirmKey.key ||
    confirmKey.hash !== s.planHash ||
    confirmKey.revision !== s.planRevision
  )
    syncConfirmKey()
  state.busyAction = true
  state.error = ''
  try {
    const { runId } = await creationChatApi.confirm(id, {
      planRevision: s.planRevision,
      planHash: s.planHash,
      idempotencyKey: confirmKey.key,
      acceptUnpriced,
      // [M40] 确认才立项：携带用户覆盖过的立项字段（不入 planHash，非法值服务端回落真源并在对话中说明）
      ...(projectOverrides() ? { project: projectOverrides() } : {}),
    })
    await fetchDetail(id)
    // [M40] 立项已随确认完成：编辑态交回服务端真值（转正后的项目信息只读展示）
    projectDraft.dirty = false
    syncProjectDraft()
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
  state.attachments = []
}

/**
 * [M40+] 删除会话（清理「聊了一半放弃」的记录）。
 * 服务端判定删除范围：未立项 → 连同影子项目一并回收（不留不可见行）；已立项 → 只删对话记录，项目保留。
 * 返回服务端结果供页面如实转告（失败时写 state.error，不假称已删）。
 */
async function removeSession(id: number): Promise<CreationDeleteResult | null> {
  state.error = ''
  try {
    const res = await creationChatApi.remove(id)
    state.sessions = state.sessions.filter((x) => x.id !== id)
    if (state.currentId === id) {
      stopPolling()
      state.currentId = 0
      state.detail = null
    }
    return res
  } catch (e) {
    state.error = errText(e)
    return null
  }
}

// ===== [M31] 参考附件登记（composer：上传或从素材选取 → 落当前会话项目；不计费、不触发规划） =====
let attSeq = 0
async function uploadItem(item: AttachmentItem): Promise<void> {
  const id = state.currentId
  if (!id) {
    item.error = '请先发送一句话创建会话后再上传参考'
    item.uploading = false
    return
  }
  if (!item.file && !item.sourceAssetId) {
    item.error = '参考项缺少文件或素材来源，无法登记'
    item.uploading = false
    return
  }
  item.uploading = true
  item.error = undefined
  try {
    const res = item.file
      ? await creationChatApi.uploadAttachment(id, item.file, item.role)
      : await creationChatApi.attachAsset(id, item.sourceAssetId!, item.role)
    // 异步竞态：仅当该项仍在当前托盘且未切会话时回填
    if (state.currentId === id && state.attachments.includes(item)) {
      item.assetId = res.assetId
      item.hash = res.hash
      item.thumbUrl = res.thumbUrl
      item.name = res.name
      item.kind = res.kind
      item.role = res.role
    }
  } catch (e) {
    if (state.attachments.includes(item)) item.error = errText(e)
  } finally {
    if (state.attachments.includes(item)) item.uploading = false
  }
}

/** 选择文件：预校验类型/大小/数量 → 按 kind 默认用途上传 */
async function addAttachment(file: File): Promise<void> {
  const kind = refKindByExt(file.name)
  if (!kind) {
    state.error = `参考仅支持图片 / 视频 / 音频：${file.name}`
    return
  }
  if (file.size === 0) {
    state.error = `参考文件为空：${file.name}`
    return
  }
  if (file.size > REF_MAX_PER_KIND[kind]) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'
    state.error = `${label}参考超过 ${Math.floor(REF_MAX_PER_KIND[kind] / 1024 / 1024)}MB 上限：${file.name}`
    return
  }
  if (state.attachments.length >= REF_MAX_COUNT) {
    state.error = `参考素材最多 ${REF_MAX_COUNT} 个`
    return
  }
  const item: AttachmentItem = {
    clientId: `att${++attSeq}_${Date.now()}`,
    file,
    name: file.name,
    kind,
    role: REF_DEFAULT_ROLE[kind],
    uploading: false,
  }
  state.attachments.push(item)
  // 必须通过响应式代理回填上传态（push 后读回数组元素为 reactive 代理；直接改 push 前的 raw 引用不触发 set 陷阱，UI 会永久停在「上传中」）
  await uploadItem(state.attachments[state.attachments.length - 1]!)
}

/** [M31+] 从素材选取：存量资产登记为参考（服务端同规则校验 kind/大小/用途；跨项目自动复制，sha256 去重） */
async function addAssetReference(asset: Asset): Promise<void> {
  const kind = asset.kind as CreationRefKind
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') {
    state.error = `参考仅支持图片 / 视频 / 音频素材：${asset.name}`
    return
  }
  if (state.attachments.some((a) => a.sourceAssetId === asset.id)) {
    state.notice = `该素材已在参考托盘：${asset.name}`
    return
  }
  if (state.attachments.length >= REF_MAX_COUNT) {
    state.error = `参考素材最多 ${REF_MAX_COUNT} 个`
    return
  }
  const item: AttachmentItem = {
    clientId: `att${++attSeq}_${Date.now()}`,
    name: asset.name,
    kind,
    role: REF_DEFAULT_ROLE[kind],
    uploading: false,
    sourceAssetId: asset.id,
  }
  state.attachments.push(item)
  await uploadItem(state.attachments[state.attachments.length - 1]!)
}

/** 更改用途：已上传项按新 role 重新登记（上传项同内容按 sha256 去重；素材选取项凭 sourceAssetId 再次 attach，仅更新登记 role） */
async function changeAttachmentRole(
  clientId: string,
  role: CreationRefRole,
): Promise<void> {
  const item = state.attachments.find((a) => a.clientId === clientId)
  if (!item || item.role === role) return
  item.role = role
  if (item.assetId) {
    item.assetId = undefined
    item.hash = undefined
    item.thumbUrl = null
    await uploadItem(item)
  }
}

function removeAttachment(clientId: string): void {
  const i = state.attachments.findIndex((a) => a.clientId === clientId)
  if (i >= 0) state.attachments.splice(i, 1)
}

function retryAttachment(clientId: string): void {
  const item = state.attachments.find((a) => a.clientId === clientId)
  if (item) void uploadItem(item)
}

const uploadingAttachments = computed(() =>
  state.attachments.some((a) => a.uploading),
)
const readyAttachmentCount = computed(
  () => state.attachments.filter((a) => a.assetId && !a.error).length,
)

const modeLabel = computed<CreationMode | null>(
  () => state.detail?.session.plan?.mode ?? null,
)

export function useEasyCreate() {
  return {
    state,
    confirmKey,
    projectDraft,
    projectEditable,
    modeLabel,
    canConfirm: computed(
      () =>
        state.detail?.session.status === 'ready' &&
        !!state.detail?.session.preflight?.execution,
    ),
    hasUnpriced: computed(
      () =>
        (state.detail?.session.preflight?.estimate.unpriced.length ?? 0) > 0,
    ),
    loadSessions,
    open,
    startIdea,
    send,
    refreshPreflight,
    confirm,
    cancel,
    retry,
    leave,
    removeSession,
    addAttachment,
    addAssetReference,
    changeAttachmentRole,
    removeAttachment,
    retryAttachment,
    uploadingAttachments,
    readyAttachmentCount,
    ensurePolling,
    stopPolling,
    errText,
  }
}
