import { reactive } from 'vue'
import { creationChatApi, newRequestKey } from '../../lib/api/creation-chat'
import { advanceChain as advanceChainEntry } from '../../lib/continuity-entry'
import type { CreationDetail } from '../../lib/types/creation-chat'
import type { Approval } from '../../lib/types/continuity'

// ===== chain 段间「对话内批准续跑」独立 composable（M64 G1）=====
// 不塞进 use-creation-chat.ts（其已近 800 行工程红线），与返修/附件同范式抽离；仅经 s.advanceChain 转发。

interface Host {
  currentId: number
  detail: CreationDetail | null
  error: string
}

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

/**
 * 批准并推进链的下一段：一次点击 = 一个幂等键（同链同一在制段签名复用，连点不重复起段/计费；
 * 服务端另有编排器下游存在性守卫兜底）。成功后 commit 最新快照（chainAwaiting 卡随投影自然回落）。
 */
export function createChainAdvance(
  host: Host,
  hooks: {
    commit: (id: number, detail: CreationDetail) => void
    polling: () => void
  },
  api: Pick<typeof creationChatApi, 'advanceChain'> = creationChatApi,
) {
  const state = reactive({ busy: false })
  let ticket = { signature: '', key: '' }
  // 请求所有权令牌：与「当前停在哪个会话」解耦——切会话/离开只让在途请求失去写回资格，
  // 不能反过来决定 busy 的释放（否则离开页面时 finally 跳过释放，单例里的续段按钮永久置灰）
  let epoch = 0
  const live = (token: number, id: number): boolean =>
    token === epoch && host.currentId === id

  async function advanceChain(
    continuity: { approval?: Approval | null; requiresApproval?: boolean } = {},
  ): Promise<boolean> {
    const id = host.currentId
    const d = host.detail
    const wfId = d?.session.workflowId
    if (!id || !wfId || state.busy) return false
    // 签名含 workflowId + 当前 runId：批准推进到新段后 runId 变 → 下一段批准换新键；连点（态未刷新）复用同键不重复起段
    const signature = JSON.stringify([id, wfId, d?.session.runId ?? 0])
    if (signature !== ticket.signature)
      ticket = { signature, key: newRequestKey('chg') }
    const token = ++epoch
    state.busy = true
    host.error = ''
    try {
      // M70：requestKey 由 adapter 再叠加 approvalHash（换包绝不沿用旧键）；
      // requiresApproval（当前段声明承接）但未冻结批准 → adapter 直接返回 sent:false，零请求。
      const outcome = await advanceChainEntry(
        { chat: { advanceChain: api.advanceChain } },
        {
          sessionId: id,
          keyBase: ticket.key,
          approval: continuity.approval ?? null,
          requiresApproval: continuity.requiresApproval === true,
        },
      )
      if (!outcome.sent) {
        if (live(token, id)) host.error = outcome.message
        return false
      }
      const detail = outcome.result as CreationDetail
      hooks.commit(id, detail)
      if (!live(token, id)) return false
      hooks.polling()
      ticket = { signature: '', key: '' }
      return true
    } catch (e) {
      if (live(token, id)) host.error = message(e)
      return false
    } finally {
      // busy 由请求自身释放（不看会话身份）：reset() 已置 false 时无害；未 reset 时避免卡死
      state.busy = false
    }
  }

  /** 切会话 / 离开详情页：在途请求失去写回资格，并强制释放续段置灰（按钮态不跨会话继承） */
  function reset(): void {
    epoch++
    state.busy = false
    ticket = { signature: '', key: '' }
  }

  return { advanceBusy: state, advanceChain, reset }
}
