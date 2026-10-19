/**
 * 轻松创作（智能创作）对话面板「消息署名」纯函数（自 ConversationPanel.vue 原样搬出，行为零变更）：
 * 按消息 role / payload.kind / roleName 判定气泡显示名与头像图标。M63 Agent 多角色署名：助手发言
 * 优先用服务端下发的 roleName，无角色历史消息回落「策划助手」；system 留痕按类型给来源标签（审阅/返修/合成/换角）。
 */
import { CREATION_ROLE_LABELS, creationSystemLabel } from '../../lib/types'
import type { CreationChatMessage } from '../../lib/types'

export function whoLabel(m: CreationChatMessage): string {
  if (m.role === 'system') {
    if (m.payload?.kind === 'handoff') return '智能编队'
    return creationSystemLabel(m.payload?.kind)
  }
  if (m.role === 'user') return CREATION_ROLE_LABELS.user
  return m.roleName || CREATION_ROLE_LABELS.assistant
}

export function avatarIcon(m: CreationChatMessage): string {
  if (m.role === 'user') return 'users'
  if (m.role !== 'system') return 'wand'
  const kind = m.payload?.kind
  return kind === 'rework' || kind === 'rework_plan' || kind === 'recompose'
    ? 'pencil'
    : 'eye'
}
