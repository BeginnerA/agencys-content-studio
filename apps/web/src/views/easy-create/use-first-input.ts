import { computed, reactive, watch } from 'vue'
import { creationChatApi, newRequestKey } from '../../lib/api/creation-chat'
import { REF_VALID_ROLES } from '../../lib/types/creation-chat'
import type { CreationDetail } from '../../lib/types/creation-chat'
import type { AttachmentItem } from './use-creation-chat'

interface Ticket {
  sessionId: number
  createKey: string
  content: string
  messageKey: string
  sent: { content: string; attachments: number[] } | null
}
interface Host {
  currentId: number
  attachments: AttachmentItem[]
  error: string
  notice: string
}
type Phase = 'idle' | 'creating' | 'uploading' | 'sending' | 'paused' | 'uncertain' | 'failed' | 'clarify'
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (id: number) => `ec-first-input:${id || 'new'}`
const keyValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,120}$/.test(value)
const positive = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0

/** 首轮提交票据只保存元信息；生命周期独立于路由，任何自动续步均受 epoch 保护。 */
export function createFirstInput(host: Host, hooks: {
  commit: (id: number, detail: CreationDetail) => void
  upload: (item: AttachmentItem) => Promise<void>
  polling: () => void
}, api: Pick<typeof creationChatApi, 'create' | 'detail' | 'send'> = creationChatApi, storage: () => StoragePort = () => sessionStorage) {
  const state = reactive({ ticket: null as Ticket | null, phase: 'idle' as Phase, warning: '' })
  const busy = computed(() => ['creating', 'uploading', 'sending'].includes(state.phase))
  const locked = computed(() => busy.value || state.phase === 'uncertain' || state.ticket?.sessionId === 0)
  const active = computed(() => !!state.ticket && state.ticket.sessionId === host.currentId)
  let epoch = 0
  let restoring = false
  const live = (token: number, t: Ticket) => token === epoch && state.ticket === t && host.currentId === t.sessionId
  const message = (e: unknown) => e instanceof Error ? e.message : String(e)
  function removeRecord(id: number) {
    try { storage().removeItem(storageKey(id)) } catch { /* 本地存储可能被浏览器禁用 */ }
  }
  function save() {
    if (restoring || !state.ticket || state.ticket.sessionId !== host.currentId) return
    const items = host.attachments.map(({ clientId, name, kind, role, assetId, hash, sourceAssetId }) => ({ clientId, name, kind, role, assetId, hash, sourceAssetId }))
    try { storage().setItem(storageKey(state.ticket.sessionId), JSON.stringify({ version: 1, ticket: state.ticket, items })) }
    catch { state.warning = '浏览器未能保存草稿；刷新后本地未上传文件需重新选择。' }
  }
  watch(() => [state.ticket, host.attachments], save, { deep: true, flush: 'sync' })

  function restore(id: number): boolean {
    try {
      const value = JSON.parse(storage().getItem(storageKey(id)) ?? 'null')
      const t = value?.ticket
      if (value?.version !== 1 || !t || t.sessionId !== id || !keyValid(t.createKey) || !keyValid(t.messageKey) || typeof t.content !== 'string' || t.content.length > 6000 || !Array.isArray(value.items) || value.items.length > 12) return false
      if (t.sent && (typeof t.sent.content !== 'string' || t.sent.content.length > 6000 || !Array.isArray(t.sent.attachments) || !t.sent.attachments.every(positive))) return false
      const items: AttachmentItem[] = []
      for (const item of value.items) {
        if (!item || typeof item.clientId !== 'string' || typeof item.name !== 'string' || !Object.hasOwn(REF_VALID_ROLES, item.kind) || !REF_VALID_ROLES[item.kind as keyof typeof REF_VALID_ROLES].includes(item.role)) return false
        items.push({ clientId: item.clientId, name: item.name, kind: item.kind, role: item.role, assetId: positive(item.assetId) ? item.assetId : undefined, hash: typeof item.hash === 'string' ? item.hash : undefined, sourceAssetId: positive(item.sourceAssetId) ? item.sourceAssetId : undefined, uploading: false, error: !positive(item.assetId) && !positive(item.sourceAssetId) ? '本地文件未保存，请重新选择此文件或移除' : undefined })
      }
      restoring = true
      state.ticket = { sessionId: id, createKey: t.createKey, messageKey: t.messageKey, content: t.content, sent: t.sent ? { content: t.sent.content, attachments: t.sent.attachments } : null }
      host.attachments = items
      state.phase = t.sent ? 'uncertain' : 'paused'
      state.warning = '草稿已恢复。请核对参考后手动继续，不会自动开始收费规划。'
      return true
    } catch { return false }
    finally { restoring = false }
  }
  function clear(id: number) {
    removeRecord(id)
    if (state.ticket?.sessionId === id) {
      state.ticket = null
      state.phase = 'idle'
      state.warning = ''
    }
  }
  function pause() {
    save()
    epoch++
    state.phase = state.ticket?.sent ? 'uncertain' : state.ticket ? 'paused' : 'idle'
  }
  function detach() {
    pause()
    state.ticket = null
    state.phase = 'idle'
    state.warning = ''
  }
  function setContent(content: string) {
    if (active.value && state.ticket && !locked.value) state.ticket.content = content.slice(0, 6000)
  }
  function home() {
    detach()
    host.currentId = 0
    host.attachments = []
    state.warning = ''
    restore(0)
  }
  function activate(detail: CreationDetail) {
    const id = detail.session.id
    if (state.ticket?.sessionId === id) return
    epoch++
    state.ticket = null
    state.phase = 'idle'
    if (detail.session.plan || detail.session.runId) { removeRecord(id); return }
    if (restore(id)) return
    const initial = detail.session.initialDraft
    if (!initial) return
    const lastInput = [...detail.messages].reverse().find((m) => m.payload?.kind === 'input')
    restoring = true
    state.ticket = { sessionId: id, createKey: initial.requestKey, content: lastInput?.content ?? initial.content, messageKey: lastInput?.requestKey ?? newRequestKey('first'), sent: lastInput ? { content: lastInput.content, attachments: lastInput.payload?.attachments ?? [] } : null }
    // 无本地记录时只恢复服务端已登记引用；不推断已丢失的文件字节。
    const selected = lastInput?.payload?.attachments
    const refs = new Map<number, NonNullable<CreationDetail['messages'][number]['payload']>['ref']>()
    for (const m of detail.messages) {
      const r = m.payload?.kind === 'attachment' ? m.payload.ref : null
      if (r && (!selected || selected.includes(r.assetId))) refs.set(r.assetId, r)
    }
    host.attachments = [...refs.values()].flatMap((r) => r ? [{ clientId: `restored-${r.assetId}`, name: `参考 #${r.assetId}`, kind: r.kind, role: r.role, assetId: r.assetId, hash: r.hash, sourceAssetId: r.assetId, uploading: false }] : [])
    restoring = false
    state.phase = lastInput ? 'uncertain' : 'paused'
    observe(detail)
    save()
  }
  function reconcileAttachments(detail: CreationDetail) {
    for (const item of host.attachments) {
      if (!item.assetId) continue
      const r = [...detail.messages].reverse().find((m) => m.payload?.kind === 'attachment' && m.payload.ref?.assetId === item.assetId)?.payload?.ref
      if (!r || r.kind !== item.kind || r.role !== item.role || r.hash !== item.hash) {
        item.assetId = undefined
        item.error = '登记信息与草稿不一致，请重新登记或移除'
      }
    }
  }
  function settle(detail: CreationDetail): boolean {
    const t = state.ticket
    if (!t) return !!detail.session.plan
    if (detail.session.status === 'planning') { state.phase = 'uncertain'; host.notice = '请求已接收，正在规划。请更新状态。'; return false }
    if (detail.session.error) { state.phase = 'failed'; host.error = detail.session.error; return false }
    if (detail.session.plan || detail.session.runId) {
      clear(t.sessionId)
      host.attachments = []
      return true
    }
    const reply = [...detail.messages].reverse().find((m) => m.role === 'assistant')
    if (reply?.payload?.kind === 'clarify') {
      t.sent = null
      t.messageKey = newRequestKey('first')
      t.content = ''
      state.phase = 'clarify'
      host.notice = '请回答追问；本轮参考已保留，回答后会再次调用规划模型。'
      save()
      return true
    }
    state.phase = 'uncertain'
    host.error = '已找到发送记录，但完成状态尚不明确。请更新状态，不要重新规划。'
    return false
  }
  function observe(detail: CreationDetail) {
    if (busy.value || state.ticket?.sessionId !== detail.session.id || !state.ticket.sent) return
    if (detail.messages.some((m) => m.requestKey === state.ticket?.messageKey)) settle(detail)
  }
  async function start(content: string): Promise<number | null> {
    if (busy.value || host.currentId) return null
    if (!state.ticket) state.ticket = { sessionId: 0, createKey: newRequestKey('draft'), content: content.trim(), messageKey: newRequestKey('first'), sent: null }
    const t = state.ticket
    // 创建响应不明时仍重用原始内容和键；不创建第二个会话。
    const token = epoch
    state.phase = 'creating'; host.error = ''; save()
    try {
      const detail = await api.create(t.content, t.createKey, true)
      if (!live(token, t)) return null
      removeRecord(0)
      t.sessionId = detail.session.id
      host.currentId = t.sessionId
      hooks.commit(t.sessionId, detail)
      state.phase = 'paused'; save()
      return t.sessionId
    } catch (e) { if (live(token, t)) { host.error = message(e); state.phase = 'paused' }; return null }
  }
  async function submit(content: string, replan = false): Promise<boolean> {
    const t = state.ticket
    if (!t || !t.sessionId || busy.value || host.currentId !== t.sessionId) return false
    const token = epoch
    state.phase = 'uploading'; host.error = ''; host.notice = ''
    try {
      // 任何重试先回读；读取失败即停止，不盲目创建新收费请求。
      const before = await api.detail(t.sessionId)
      if (!live(token, t)) return false
      hooks.commit(t.sessionId, before)
      if (before.session.plan || before.session.runId) return settle(before)
      const accepted = before.messages.some((m) => m.requestKey === t.messageKey)
      if (accepted) {
        if (!replan || !before.session.error || before.session.status === 'planning') return settle(before)
        t.sent = null
        t.messageKey = newRequestKey('first')
      } else if (before.session.status === 'planning') {
        state.phase = 'uncertain'; host.error = '该会话已有规划在途，请稍后更新状态。'; return false
      }
      if (!t.sent) t.content = content.trim()
      if (!t.content) { state.phase = 'paused'; return false }
      reconcileAttachments(before)
      for (const item of host.attachments) {
        if (!live(token, t)) return false
        if (!item.assetId || item.error) await hooks.upload(item)
        if (!live(token, t)) return false
        save()
        if (!item.assetId || item.error) {
          state.phase = 'paused'; host.error = '参考上传已暂停；请重试失败项，或明确移除后继续。'; return false
        }
      }
      const ids = [...new Set(host.attachments.map((a) => a.assetId!))]
      if (t.sent && (t.sent.content !== t.content || JSON.stringify(t.sent.attachments) !== JSON.stringify(ids))) {
        state.phase = 'uncertain'; host.error = '结果不明的提交不能更改输入，请恢复原参考后核对。'; return false
      }
      t.sent = { content: t.content, attachments: ids }
      state.phase = 'sending'; save()
      const detail = await api.send(t.sessionId, t.sent.content, t.messageKey, t.sent.attachments)
      if (!live(token, t)) return false
      hooks.commit(t.sessionId, detail)
      return settle(detail)
    } catch (e) {
      if (live(token, t)) { state.phase = t.sent ? 'uncertain' : 'paused'; host.error = `${message(e)}。草稿已保留，请先更新状态或手动继续。` }
      return false
    } finally { if (token === epoch) { save(); hooks.polling() } }
  }
  return { state, busy, locked, active, start, submit, activate, observe, pause, detach, home, clear, save, setContent }
}
