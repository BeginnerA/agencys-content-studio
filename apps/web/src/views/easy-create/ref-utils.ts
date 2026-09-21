/**
 * [M26-split] 轻松创作对话面板「参考素材」纯函数工具（自 ConversationPanel.vue 原样搬出，行为零变更）：
 * 消息 → 参考素材展示元信息（类型图标 / 角色标签 / 文件名 / 缩略图端点）判定。
 */
import { REF_ROLE_LABELS } from '../../lib/types'
import type { CreationChatMessage, CreationRefKind } from '../../lib/types'

export function kindIcon(kind: CreationRefKind): string {
  return kind === 'image' ? 'photo' : kind === 'video' ? 'film' : 'doc'
}

export const isAttachment = (m: CreationChatMessage): boolean =>
  m.payload?.kind === 'attachment' && typeof m.payload.assetId === 'number'

export const refAssetId = (m: CreationChatMessage): number =>
  m.payload?.assetId ?? 0

export const refKind = (m: CreationChatMessage): CreationRefKind =>
  m.payload?.ref?.kind ?? 'image'

export const refRoleLabel = (m: CreationChatMessage): string => {
  const role = m.payload?.ref?.role
  return role ? REF_ROLE_LABELS[role] : '参考'
}

// 文件名：剥离服务端消息前缀「已上传参考素材：」，回退整句
export const refName = (m: CreationChatMessage): string =>
  m.content.replace(/^已上传参考素材：/, '').trim() || m.content

// 图片/视频走后端缩略图端点（与方案卡同源 ?v=2 破缓存）；音频无缩略图 → 图标
export const refThumb = (m: CreationChatMessage): string | null =>
  refKind(m) === 'image' || refKind(m) === 'video'
    ? `/api/v1/assets/${refAssetId(m)}/thumb?v=2`
    : null
