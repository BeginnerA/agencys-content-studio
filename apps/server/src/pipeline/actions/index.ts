import type { StepContext } from '../context'
import type { StepResult } from '../types'
import { aiImage } from './ai-image'
import { aiText } from './ai-text'
import { aiVideo } from './ai-video'
import { ffmpegMerge } from './ffmpeg-merge'
import { manualIngest } from './manual-ingest'
import { memoryRecall } from './memory-recall'
import { memoryWrite } from './memory-write'
import { tts } from './tts'
import { subtitle } from './subtitle'

export type { StepContext }
export type { StepResult }

export type ActionFn = (ctx: StepContext) => Promise<StepResult>

/** action 注册表（与 loader.KNOWN_ACTIONS 同步；新增 action 两处都加） */
const registry: Record<string, ActionFn> = {
  manual_ingest: manualIngest,
  ai_text: aiText,
  ai_image: aiImage,
  ffmpeg_merge: ffmpegMerge,
  ai_video: aiVideo,
  tts,
  subtitle,
  memory_write: memoryWrite,
  memory_recall: memoryRecall,
}

export function getAction(key: string): ActionFn {
  const fn = registry[key]
  if (!fn) throw new Error(`action「${key}」未注册`)
  return fn
}

export function listActionKeys(): string[] {
  return Object.keys(registry)
}