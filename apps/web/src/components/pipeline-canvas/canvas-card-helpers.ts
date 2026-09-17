/**
 * [M15] 流水线画布节点卡辅助（CanvasBoard 拆分：M26 红线纯重构，函数体逐字搬移）
 * 纯展示派生（图标 / 卡片类 / 状态徽标 / 任务计数文案）；无响应式依赖。
 */
import type { CanvasBoardNode } from '../../lib/types'
import { stepStatus } from '../../lib/format'

const ACTION_ICON: Record<string, string> = {
  manual_ingest: 'inbox',
  ai_text: 'pencil',
  ai_image: 'photo',
  ai_video: 'video',
  tts: 'speaker-wave',
  subtitle: 'doc',
  ffmpeg_merge: 'film',
  memory_write: 'sparkles',
  memory_recall: 'search',
  character_sync: 'users',
  entity_sync: 'map',
  text_split: 'copy',
}
export function iconOf(key: string): string {
  return ACTION_ICON[key] ?? 'doc'
}
export function cardClass(n: CanvasBoardNode): string {
  const st = n.status
  if (st === 'running') return 'running'
  if (st === 'waiting_input') return 'gate'
  if (st === 'failed') return 'failed'
  if (st === 'succeeded') return 'ok'
  if (st === 'skipped') return 'skip'
  if (st === 'cancelled') return 'cancel'
  return 'idle'
}
/** 状态徽标类：skipped 复用 .badge.skip（全局样式仅有 .skip） */
export function badgeClass(n: CanvasBoardNode): string {
  if (!n.status) return 'skip'
  return n.status === 'skipped' ? 'skip' : n.status
}
export function statusText(n: CanvasBoardNode): string {
  return n.status ? stepStatus(n.status).text : ''
}
export function taskText(n: CanvasBoardNode): string {
  if (!n.tasks || !n.tasks.total) return ''
  const bad = n.tasks.failed + n.tasks.cancelled
  return bad > 0 ? `任务 ${n.tasks.succeeded}/${n.tasks.total} · 异常 ${bad}` : `任务 ${n.tasks.succeeded}/${n.tasks.total}`
}
export function hasChips(n: CanvasBoardNode): boolean {
  return !!(
    taskText(n) ||
    n.assetCount ||
    n.skipText ||
    (n.status === 'waiting_input' && n.gateMessage) ||
    n.hasError
  )
}
