import { reactive } from 'vue'
import { creationChatApi, newRequestKey } from '../../lib/api/creation-chat'
import type { CreationDetail } from '../../lib/types/creation-chat'

// ===== chain 段间「对话内批准续跑」独立 composable（M64 G1）=====
// 不塞进 use-creation-chat.ts（其已近 800 行工程红线），与返修/附件同范式抽离；仅经 s.advanceChain 转发。

interface Host {
  currentId: number
  detail: CreationDetail | null
  error: string
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 批准并推进链的下一段：一次点击 = 一个幂等键（同链同一在制段签名复用，连点不重复起段/计费；
 * 服务端另有编排器下游存在性守卫兜底）。成功后 commit 最新快照（chainAwaiting 卡随投影自然回落）。
 */
export function createChainAdvance(host: Host, hooks: {
  commit: (id: number, detail: CreationDetail) => void
  polling: () => void
}, api: Pick<typeof creationChatApi, 'advanceChain'> = creationChatApi) {
  const state = reactive({ busy: false })
  let ticket = { signature: '', key: '' }

  async function advanceChain(): Promise<boolean> {
    const id = host.currentId
    const d = host.detail
    const wfId = d?.session.workflowId
    if (!id || !wfId || state.busy) return false
    // 签名含 workflowId + 当前 runId：批准推进到新段后 runId 变 → 下一段批准换新键；连点（态未刷新）复用同键不重复起段
    const signature = JSON.stringify([id, wfId, d?.session.runId ?? 0])
    if (signature !== ticket.signature) ticket = { signature, key: newRequestKey('chg') }
    state.busy = true
    host.error = ''
    try {
      const detail = await api.advanceChain(id, { idempotencyKey: ticket.key })
      hooks.commit(id, detail)
      hooks.polling()
      ticket = { signature: '', key: '' }
      return true
    } catch (e) {
      if (host.currentId === id) host.error = message(e)
      return false
    } finally {
      if (host.currentId === id) state.busy = false
    }
  }

  return { advanceBusy: state, advanceChain }
}
