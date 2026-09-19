/** [M28] 运行详情共享纯逻辑：步骤节点样式 / 跳过提示 / 产物 id / 快照格式化 / 动作图标 / 成本字典。 */
import { skipReasonText } from '../../lib/format'
import type { RunStep } from '../../lib/types'

// ===== 步骤块渲染辅助 =====
export function nodeClass(s: RunStep): string {
  if (s.status === 'running') return 'running'
  if (s.status === 'waiting_input') return 'gate'
  if (s.status === 'failed') return 'failed'
  if (s.status === 'succeeded') return 'ok'
  if (s.status === 'skipped') return 'skip'
  if (s.status === 'cancelled') return 'cancel'
  return 'idle'
}

/** [M2] 跳过原因（output.skipped.reason）；succeeded 且带 skipped 记录 = 免审放行 */
export function skipInfo(
  s: RunStep,
): { text: string; userSkip: boolean } | null {
  const reason = (s.output as { skipped?: { reason?: string } } | null)?.skipped
    ?.reason
  if (s.status === 'skipped')
    return { text: skipReasonText(reason ?? 'skipped'), userSkip: false }
  if (s.status === 'succeeded' && reason === 'user_skip')
    return { text: '免审放行', userSkip: true }
  return null
}

export function assetIds(s: RunStep): number[] {
  const out = s.output?.asset_ids
  return Array.isArray(out) ? (out as number[]) : []
}

export function inputPretty(s: RunStep): string {
  if (!s.input) return '—'
  return JSON.stringify(s.input, null, 1)
}

export function outputPretty(s: RunStep): string {
  if (!s.output) return '—'
  return JSON.stringify(s.output, null, 1)
}

export const ACTION_ICON: Record<string, string> = {
  manual_ingest: 'inbox',
  ai_text: 'pencil',
  ai_image: 'photo',
  ffmpeg_merge: 'film',
  ai_video: 'video',
  memory_write: 'sparkles',
  memory_recall: 'search',
  character_sync: 'users',
}

export function iconOf(key: string): string {
  return ACTION_ICON[key] ?? 'doc'
}

export const COST_KIND_TEXT: Record<string, string> = {
  llm: 'LLM',
  image: '图像',
  video: '视频',
  tts: '配音',
}
