import type { StepContext } from '../context'
import type { StepResult } from '../types'
import { aiImage } from './ai-image'
import { aiText } from './ai-text'
import { aiVideo } from './ai-video'
// [M25] 一致性回查 + 视频解析骨架（契约纯函数已实装，action 体分别随批 2/批 3 接线）
import { adaptAudit } from './adapt-audit'
import { characterSync } from './character-sync'
// [M24] 摘要压缩 + 合规审核两 action 注册（与 loader.KNOWN_ACTIONS 同步）
import { complianceCheck } from './compliance-check'
import { entitySync } from './entity-sync'
import { ffmpegMerge } from './ffmpeg-merge'
import { literal } from './literal'
import { manualIngest } from './manual-ingest'
// [整改] 复盘回灌专用：发布记录直接入库（取代导出 CSV 再上传）
import { publicationIngest } from './publication-ingest'
import { memoryRecall } from './memory-recall'
import { memorySummary } from './memory-summary'
import { memoryWrite } from './memory-write'
import { tts } from './tts'
import { subtitle } from './subtitle'
import { textSplit } from './text-split'
import { videoAnalyze } from './video-analyze'

export type { StepContext }
export type { StepResult }

export type ActionFn = (ctx: StepContext) => Promise<StepResult>

/** action 注册表（与 loader.KNOWN_ACTIONS 同步；新增 action 两处都加） */
const registry: Record<string, ActionFn> = {
  manual_ingest: manualIngest,
  publication_ingest: publicationIngest,
  literal,
  ai_text: aiText,
  ai_image: aiImage,
  ffmpeg_merge: ffmpegMerge,
  ai_video: aiVideo,
  tts,
  subtitle,
  memory_write: memoryWrite,
  memory_recall: memoryRecall,
  memory_summary: memorySummary,
  compliance_check: complianceCheck,
  character_sync: characterSync,
  entity_sync: entitySync,
  text_split: textSplit,
  adapt_audit: adaptAudit,
  video_analyze: videoAnalyze,
}

export function getAction(key: string): ActionFn {
  const fn = registry[key]
  if (!fn) throw new Error(`action「${key}」未注册`)
  return fn
}

export function listActionKeys(): string[] {
  return Object.keys(registry)
}