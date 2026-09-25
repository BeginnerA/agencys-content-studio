import { computed, reactive } from 'vue'
import { createFirstInput } from './use-first-input'
import { createRework } from './use-rework'
import { createAttachments, type AttachmentItem } from './use-creation-attachments'
import { creationChatApi, newRequestKey } from '../../lib/api'
import { ApiError } from '../../lib/api/core'
import { studioOff, studioOn } from '../../lib/socket'
import type {
  CreationCandidateStep,
  CreationDeleteResult,
  CreationDetail,
  CreationGateDecision,
  CreationProjectMeta,
  CreationSessionListItem,
  CreationMode,
} from '../../lib/types'

// 附件视图模型迁移至 use-creation-attachments；此处再导出保持 use-first-input 等既有 import 路径不变
export type { AttachmentItem } from './use-creation-attachments'

// ===== 轻松创作状态机（模块级单例：列表页与详情页共享，切页不丢在途状态） =====

// waiting_input 不在本集合内：它是「等用户决策」而不是「等在途请求」，已挂起闸门时继续 4s 轮询只会空转（见 isPollable 的 parked 分支）
const RUNNING = new Set(['queued', 'running', 'pending', 'processing'])

function isPollable(d: CreationDetail | null): boolean {
  if (!d) return false
  const p = d.progress
  // 投影带 review = 闸门真的在等用户点按钮 → 不轮询；waiting_input 但无待审步骤 = 决策后的瞬时态（run 行比步骤行晚一步更新），继续轮询至收敛
  const parked = !!p && p.status === 'waiting_input' && !!p.review
  const runActive =
    !!p &&
    !parked &&
    (RUNNING.has(p.status) || p.status === 'processing' || p.status === 'waiting_input')
  const starting = d.session.status === 'starting'
  return (runActive || starting || d.session.status === 'planning') && !d.result
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
  // 已改选版本但还未重新合成（选片零计费、不改成片，需提示用户再走一次本地合成）
  selectionDirty: false,
  // 参考附件托盘（仅当前会话；切会话/离开即清空，避免旧素材错挂新会话）
  attachments: [] as AttachmentItem[],
  // [batch5] 首轮预设选择（风格 ≤6 / 角色 ≤4）：项目级软提示旁信道，切会话 / 回首页即清
  stylePresetIds: [] as number[],
  characterPresetIds: [] as number[],
})

// 附件域抽为 composable：与主状态机共享同一 reactive state；uploadItem 经此反向注入 first-input 的上传钩子（闭包惰性取 attachments，构造后恒可解析）
const first = createFirstInput(state, { commit, upload: (item) => attachments.uploadItem(item), polling: ensurePolling })
// 局部返修独立成 composable（不继续膨胀本文件）：解析预览 / 确认闸 / 幂等键全在其内，切会话与离开时 reset
const rework = createRework(state, { commit, polling: ensurePolling })
const attachments = createAttachments(state, { viewEpoch: () => viewEpoch, commit, first, errText })
let viewEpoch = 0
let autoFirstId = 0
let pollTimer: ReturnType<typeof setInterval> | null = null
let wired = false
let retryTicket = { signature: '', key: '' }
let sendTicket = { signature: '', key: '' }
let gateTicket = { signature: '', key: '' }
let selectionTicket = { signature: '', key: '' }
let recomposeTicket = { signature: '', key: '' }

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : String(e)
}

/** 提交响应：仅当仍停留在同一会话时写入，防止旧请求覆盖新会话（异步竞态红线） */
function commit(id: number, detail: CreationDetail): void {
  if (id !== state.currentId) return
  state.detail = detail
  // run 一旦重新推进（含本地重合成），选定版本正在落到新成片上 → 摘掉「待重新合成」提示
  if (RUNNING.has(detail.progress?.status ?? '')) state.selectionDirty = false
  first.observe(detail)
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

// ===== 立项信息可编辑态：默认用平台智能填写值（Tier A），用户改过的字段确认后随 confirm 提交（Tier B 可覆盖） =====
export const projectDraft = reactive({
  name: '',
  genre: '',
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
  const tags = parseTagsText(projectDraft.tagsText)
  if (tags.length && tags.join(',') !== p.tags.join(',')) o.tags = tags
  if (projectDraft.brief.trim() && projectDraft.brief.trim() !== p.brief)
    o.brief = projectDraft.brief.trim()
  return Object.keys(o).length ? o : undefined
}

async function fetchDetail(id: number): Promise<void> {
  const token = viewEpoch
  const prior = state.detail
  try {
    const detail = await creationChatApi.detail(id)
    if (token === viewEpoch && prior === state.detail && !first.busy.value) commit(id, detail)
  } catch (e) {
    if (token === viewEpoch && id === state.currentId) state.error = errText(e)
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
  // 闸门挂起：不靠下一轮轮询，事件到达即重拉（审阅面板即时出现）
  studioOn('run.gate', onRunEvent)
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
  if (id !== state.currentId) {
    first.detach()
    rework.reset()
    viewEpoch++
    autoFirstId = 0
    state.currentId = id
    state.detail = null
    state.attachments = []
    state.stylePresetIds = []
    state.characterPresetIds = []
    state.busySend = false
    state.busyAction = false
    state.error = ''; state.notice = ''
    confirmKey.hash = ''
    retryTicket = { signature: '', key: '' }
    sendTicket = { signature: '', key: '' }
    gateTicket = { signature: '', key: '' }
    selectionTicket = { signature: '', key: '' }
    recomposeTicket = { signature: '', key: '' }
    state.selectionDirty = false
    projectDraft.dirty = false
  }
  const token = viewEpoch
  const auto = autoFirstId === id
  autoFirstId = 0
  state.loadingDetail = true
  try {
    const detail = await creationChatApi.detail(id)
    if (token !== viewEpoch || id !== state.currentId) return
    first.activate(detail)
    commit(id, detail)
    if (auto && first.active.value) void first.submit(first.state.ticket!.content)
  } catch (e) {
    if (token === viewEpoch && id === state.currentId) state.error = errText(e)
  } finally {
    if (token === viewEpoch && id === state.currentId) state.loadingDetail = false
    ensurePolling()
  }
}

/** 首页先取得零模型调用草稿；详情接收同一票据后才上传并提交规划。 */
async function startIdea(content: string): Promise<number | null> {
  const id = await first.start(content)
  if (id) autoFirstId = id
  return id
}

function enterHome(): void {
  leave()
  first.home()
  state.detail = null
  state.error = ''; state.notice = ''
}

async function send(content: string, replan = false): Promise<boolean> {
  if (first.active.value) return first.submit(content, replan)
  const id = state.currentId
  const token = viewEpoch
  if (!id || state.busySend) return false
  if (!state.detail?.session.runId && state.attachments.some((a) => a.uploading || a.error || !a.assetId)) {
    state.error = '请先重试失败的参考项，或明确移除后再发送。'
    return false
  }
  state.busySend = true
  state.error = ''
  // 本条消息采纳已上传成功的参考附件（上传中/失败的项保留，不静默丢参考）
  const sentAssetIds = state.detail?.session.runId ? [] : [...new Set(state.attachments
    .filter((a) => a.assetId && !a.error)
    .map((a) => a.assetId!))]
  const signature = JSON.stringify([id, content.trim(), sentAssetIds])
  if (signature !== sendTicket.signature) sendTicket = { signature, key: newRequestKey('msg') }
  try {
    const detail = await creationChatApi.send(
      id,
      content,
      sendTicket.key,
      sentAssetIds,
      { stylePresetIds: state.stylePresetIds, characterPresetIds: state.characterPresetIds },
    )
    if (token !== viewEpoch || id !== state.currentId) return false
    commit(id, detail)
    ensurePolling()
    if (detail.session.error || detail.session.status === 'planning') {
      if (id === state.currentId) state.error = detail.session.error || '请求已接收，正在规划；请更新状态，不要重复发送。'
      return false
    }
    if (id === state.currentId && (detail.session.plan || detail.session.runId)) state.attachments = []
    sendTicket = { signature: '', key: '' }
    return true
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
    return false
  } finally {
    if (token === viewEpoch) state.busySend = false
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

async function confirm(acceptUnpriced: boolean, reviewGate = false, resolution?: string, brandApply = true, subtitleBurn = true): Promise<number | null> {
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
      // 确认才立项：携带用户覆盖过的立项字段（不入 planHash，非法值服务端回落真源并在对话中说明）
      ...(projectOverrides() ? { project: projectOverrides() } : {}),
      // 勾选审阅 → 服务端改用同构变体模板；不勾选不传该键（缺省 false，请求体与旧版逐字一致）
      ...(reviewGate ? { reviewGate: true } : {}),
      // 画质选择：不选不传键（服务端用模型默认档，请求体与旧版逐字一致）；不入 planHash，改档不触发重新规划
      ...(resolution ? { resolution } : {}),
      // 品牌叠加：默认继承（true）不传该键（请求体与旧版逐字一致）；仅逐次关闭时传 false。不入 planHash、零计费
      ...(brandApply === false ? { brandApply: false } : {}),
      // 字幕烧录：默认烧（true）不传该键；仅逐次关闭时传 false（成片不含硬字幕、字幕文件仍生成）。不入 planHash、零计费
      ...(subtitleBurn === false ? { subtitleBurn: false } : {}),
    })
    await fetchDetail(id)
    // 立项已随确认完成：编辑态交回服务端真值（转正后的项目信息只读展示）
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

async function retry(verifiedFailedTaskIds: number[], acceptUnpriced = false, acceptConfigDrift = false): Promise<number | null> {
  const s = state.detail?.session
  const p = state.detail?.progress
  const id = state.currentId
  if (!s || !p || !id || !s.planHash || state.busyAction || !p.recovery.resumable) return null
  const token = viewEpoch
  const drift = p.recovery.configDrift ?? []
  if (drift.some((d) => d.to === null)) {
    state.error = '当前无可用配置，请检查实例是否启用、协议是否合格及凭据是否可用，再更新状态。'
    return null
  }
  if (p.recovery.requiredTaskIds.some((taskId) => !verifiedFailedTaskIds.includes(taskId)) || (p.recovery.unpriced.length && !acceptUnpriced) || (drift.length && !acceptConfigDrift)) {
    state.error = '请完成任务核实、未计价及配置变化确认后恢复。'
    return null
  }
  const verified = [...new Set(verifiedFailedTaskIds)].sort((a, b) => a - b)
  const signature = JSON.stringify([id, p.runId, s.planRevision, s.planHash, p.status, p.uncertainTasks, verified, acceptUnpriced, drift, acceptConfigDrift])
  if (signature !== retryTicket.signature) retryTicket = { signature, key: newRequestKey('rt') }
  state.busyAction = true
  state.error = ''
  try {
    const { runId } = await creationChatApi.retry(id, {
      planRevision: s.planRevision,
      planHash: s.planHash,
      idempotencyKey: retryTicket.key,
      acceptUnpriced,
      runId: p.runId,
      verifiedFailedTaskIds: verified,
      ...(drift.length && acceptConfigDrift ? { acceptConfigDrift: true } : {}),
    })
    if (token !== viewEpoch || id !== state.currentId) return null
    await fetchDetail(id)
    if (token !== viewEpoch || id !== state.currentId) return null
    ensurePolling()
    return runId
  } catch (e) {
    if (token === viewEpoch && id === state.currentId) {
      state.error = errText(e)
      if (e instanceof ApiError && e.code === 'configuration_changed') await fetchDetail(id)
    }
    return null
  } finally {
    if (token === viewEpoch && id === state.currentId) state.busyAction = false
  }
}

/**
 * 审阅决策：approve 继续制作；reject = 该阶段整体重做（再次调用图片/视频生成，调用方必须已二次确认费用）。
 * 同签名（会话+run+步骤+决策+意见）复用幂等键：连点不重复决策；改意见或改决策即新键（与 retry 同一先例）。
 */
async function decideGate(
  stepKey: string,
  decision: CreationGateDecision,
  note?: string,
): Promise<boolean> {
  const p = state.detail?.progress
  const id = state.currentId
  if (!id || !p?.review || state.busyAction) return false
  const signature = JSON.stringify([id, p.runId, stepKey, decision, note?.trim() ?? ''])
  if (signature !== gateTicket.signature) gateTicket = { signature, key: newRequestKey('gate') }
  state.busyAction = true
  state.error = ''
  try {
    commit(id, await creationChatApi.gate(id, {
      stepKey,
      decision,
      ...(note?.trim() ? { note: note.trim() } : {}),
      idempotencyKey: gateTicket.key,
    }))
    // 决策后 run 已转 queued/running（驳回重跑同理）：恢复轮询把新进度接回来
    ensurePolling()
    gateTicket = { signature: '', key: '' }
    return true
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
    return false
  } finally {
    state.busyAction = false
  }
}

/**
 * 选定某镜的在用版本（零计费、不触发执行）：只提交这一镜的改动，
 * 未提及镜头由服务端按在用值补全（子集替换语义不外露）；成功后需再走重新合成才落到成片。
 */
async function applySelection(
  stepKey: CreationCandidateStep,
  shotId: string,
  assetId: number,
): Promise<boolean> {
  const id = state.currentId
  const runId = state.detail?.progress?.runId
  if (!id || !runId || state.busyAction) return false
  const signature = JSON.stringify([id, runId, stepKey, shotId, assetId])
  if (signature !== selectionTicket.signature) selectionTicket = { signature, key: newRequestKey('sel') }
  state.busyAction = true
  state.error = ''
  try {
    commit(id, await creationChatApi.selectShots(id, {
      stepKey,
      picks: [{ shot_id: shotId, asset_id: assetId }],
      idempotencyKey: selectionTicket.key,
    }))
    if (id === state.currentId) state.selectionDirty = true
    state.notice = '已选定该版本；重新合成后成片才会用上这一版。'
    selectionTicket = { signature: '', key: '' }
    return true
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
    return false
  } finally {
    state.busyAction = false
  }
}

/**
 * 本地重新合成：仅重置合成步（不调用任何付费生成模型），但会重跑一段本地处理。
 * 成功后作废幂等键：下一次主动重合成必须是真的再次执行（与审阅决策同一先例）。
 */
async function recompose(): Promise<boolean> {
  const id = state.currentId
  const runId = state.detail?.progress?.runId
  if (!id || !runId || state.busyAction) return false
  const signature = JSON.stringify([id, runId, 'recompose'])
  if (signature !== recomposeTicket.signature) recomposeTicket = { signature, key: newRequestKey('rec') }
  state.busyAction = true
  state.error = ''
  try {
    commit(id, await creationChatApi.recompose(id, { idempotencyKey: recomposeTicket.key }))
    if (id === state.currentId) state.selectionDirty = false
    ensurePolling()
    recomposeTicket = { signature: '', key: '' }
    return true
  } catch (e) {
    if (id === state.currentId) state.error = errText(e)
    return false
  } finally {
    state.busyAction = false
  }
}

async function refreshStatus(): Promise<void> {
  const id = state.currentId
  if (!id || state.loadingDetail) return
  state.loadingDetail = true
  try { await fetchDetail(id); ensurePolling() }
  finally { if (id === state.currentId) state.loadingDetail = false }
}

function leave(): void {
  first.detach()
  rework.reset()
  viewEpoch++
  autoFirstId = 0
  state.busySend = false
  state.busyAction = false
  retryTicket = { signature: '', key: '' }
  sendTicket = { signature: '', key: '' }
  gateTicket = { signature: '', key: '' }
  selectionTicket = { signature: '', key: '' }
  recomposeTicket = { signature: '', key: '' }
  state.selectionDirty = false
  stopPolling()
  state.currentId = 0
  state.attachments = []
  state.stylePresetIds = []
  state.characterPresetIds = []
}

/**
 * 删除会话（清理「聊了一半放弃」的记录）。
 * 服务端判定删除范围：未立项 → 连同影子项目一并回收（不留不可见行）；已立项 → 只删对话记录，项目保留。
 * 返回服务端结果供页面如实转告（失败时写 state.error，不假称已删）。
 */
async function removeSession(id: number): Promise<CreationDeleteResult | null> {
  state.error = ''
  try {
    const res = await creationChatApi.remove(id)
    first.clear(id)
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

// 参考附件登记与逐镜绑定域已抽至 use-creation-attachments.ts（createAttachments）；本文件仅经 attachments.* 转发，行为逐字不变

const modeLabel = computed<CreationMode | null>(
  () => state.detail?.session.plan?.mode ?? null,
)

export function useEasyCreate() {
  return {
    state,
    first,
    rework,
    attachmentsLocked: attachments.attachmentsLocked,
    enterHome,
    replaceAttachmentFile: attachments.replaceAttachmentFile,
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
    refreshStatus,
    confirm,
    cancel,
    retry,
    decideGate,
    applySelection,
    recompose,
    leave,
    removeSession,
    addAttachment: attachments.addAttachment,
    addAssetReference: attachments.addAssetReference,
    changeAttachmentRole: attachments.changeAttachmentRole,
    setAttachmentShot: attachments.setAttachmentShot,
    removeAttachment: attachments.removeAttachment,
    retryAttachment: attachments.retryAttachment,
    uploadingAttachments: attachments.uploadingAttachments,
    readyAttachmentCount: attachments.readyAttachmentCount,
    ensurePolling,
    stopPolling,
    errText,
  }
}
