import { watch, type Ref } from 'vue'
import type { useEasyCreate } from './use-creation-chat'

type Easy = ReturnType<typeof useEasyCreate>

/**
 * 首轮票据 ↔ 可见草稿的双向同步（自 ConversationPanel.vue 搬出，行为一致并修复「发送后输入框未清空」）：
 * - 未发送的暂停草稿：回填 ticket.content 供用户编辑后手动继续；
 * - 票据一旦进入「已发送」态：立即腾空输入框。正常「生成方案」流程由 open() 内 first.submit 自动提交，
 *   不经组件 submit()（submitting 未置位），而 ticket.content 为崩溃恢复/幂等比对刻意保留原值——
 *   不主动清空就会在规划等待期让用户看到刚发出的文字仍留在框内（即「发送后内容没清除」的错觉）。
 * - 反向：draft 变化回写 setContent（提交在途 submitting 冻结，防回填）。
 */
export function useDraftTicketSync(s: Easy, draft: Ref<string>, submitting: Ref<boolean>): void {
  watch(
    () => [s.first.state.ticket?.content, !!s.first.state.ticket?.sent] as const,
    ([content, sent], previous) => {
      if (submitting.value) return
      if (sent) {
        draft.value = ''
        return
      }
      if (s.first.active.value && content !== undefined) draft.value = content
      else if (previous?.[0] !== undefined) draft.value = ''
    },
    { immediate: true },
  )
  watch(
    draft,
    (value) => {
      if (!submitting.value) s.first.setContent(value)
    },
    { flush: 'sync' },
  )
}
