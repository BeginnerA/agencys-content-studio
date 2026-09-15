import { statSync } from 'node:fs'
import { absPathOf } from '../../../services/storage'
import { probeMediaDuration } from '../../../services/ffmpeg'
import { shotDurationSec } from '../../../services/shot'
import { QUALITY_TEXT, type ImageQualityReason } from '../../../services/image-check'
import type { Asset } from '../../../db/schema'
import type { StepContext } from '../../context'

export interface Segment {
  id: number
  path: string
  kind: 'image' | 'video'
  durSec: number
  /** [M7] 静态图：时长来自分镜 per-shot 覆盖（fit_voice 显式优先依据） */
  explicit?: boolean
  /** [M7] 动效片：时长未知按 duration_per_shot 估算（日志溯源） */
  estimated?: boolean
}

/**
 * [M7] 镜头段组装（纯函数；探针直测）——段组装 + 时长决策 + 容错判定收敛于此：
 * - 缺本地文件 / 文件缺失 / kind 不符 → skipped（不再整体失败；全 skip 由调用方拦抛）；
 * - 静态图：分镜 per-shot 覆盖优先（explicit 标记）→ duration_per_shot；
 * - 动效片：asset.duration → ffprobe → duration_per_shot 估算（estimated 标记）。
 */
export function computeShotSegments(
  rows: Asset[],
  mode: 'images' | 'clips',
  perShotDur: Map<string, number>,
  durationPerShot: number,
): { segments: Segment[]; skipped: number[]; warnings: string[] } {
  const segments: Segment[] = []
  const skipped: number[] = []
  const warnings: string[] = []
  for (const a of rows) {
    if (!a.relPath) {
      skipped.push(a.id)
      continue
    }
    const path = absPathOf(a.relPath)
    try {
      statSync(path)
    } catch {
      skipped.push(a.id)
      continue
    }
    if (mode === 'images') {
      if (a.kind !== 'image') {
        skipped.push(a.id)
        continue
      }
      // [M12] 图像检测异常警示（仅警告；不阻断用户已选中的图）
      const warn = qualityWarning(a)
      if (warn) warnings.push(warn)
      const shotId = shotIdOfAsset(a)
      const override = shotId !== null ? perShotDur.get(shotId) : undefined
      segments.push({ id: a.id, path, kind: 'image', durSec: override ?? durationPerShot, explicit: override !== undefined })
    } else {
      if (a.kind !== 'video') {
        skipped.push(a.id)
        continue
      }
      let dur: number | null = typeof a.duration === 'number' && a.duration > 0 ? a.duration : null
      let estimated = false
      if (dur === null) {
        dur = probeMediaDuration(path)
        if (dur === null) {
          dur = durationPerShot
          estimated = true
        }
      }
      segments.push({ id: a.id, path, kind: 'video', durSec: dur, estimated })
    }
  }
  return { segments, skipped, warnings }
}

/** [M12] 图像检测异常警示（params.quality.ok === false；缺失/坏数据 → null） */
function qualityWarning(a: Asset): string | null {
  if (!a.params) return null
  try {
    const q = (JSON.parse(a.params) as { quality?: { ok?: unknown; reason?: unknown } }).quality
    if (!q || q.ok !== false) return null
    const reason = typeof q.reason === 'string' ? q.reason : 'unknown'
    return `镜头产物 asset#${a.id} 疑似异常图（${QUALITY_TEXT[reason as ImageQualityReason] ?? reason}），已按选中继续合成`
  } catch {
    return null
  }
}

/** [M7] shots（分镜 JSON 原始文本）→ per-shot 时长表（裸数组 / {shots:[]}；duration 优先回退 duration_sec；非法条目跳过） */
export function parseShotDurations(raw: string): Map<string, number> {
  const map = new Map<string, number>()
  const obj = JSON.parse(raw) as unknown
  const arr = Array.isArray(obj) ? obj : (obj as { shots?: unknown }).shots
  if (!Array.isArray(arr)) return map
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const id = o['id']
    if (typeof id !== 'string' || !id) continue
    const dur = shotDurationSec(o)
    if (dur != null) map.set(id, dur)
  }
  return map
}

/** [M7] shots（分镜 JSON）→ per-shot 时长覆盖表（解析失败 → 空表 + 日志；无输入 → 空表） */
export async function loadPerShotDurations(ctx: StepContext, shotsIds: number[]): Promise<Map<string, number>> {
  if (shotsIds.length === 0) return new Map()
  try {
    return parseShotDurations(await ctx.readText(shotsIds[0]!))
  } catch (err) {
    ctx.log(`分镜时长覆盖解析失败（回退全局 duration_per_shot）：${(err as Error).message}`)
    return new Map()
  }
}

/** 资产 params.shotId（分镜时长覆盖匹配键，与 ai_image/ai_video 产物口径一致） */
export function shotIdOfAsset(a: Asset): string | null {
  if (!a.params) return null
  try {
    const p = JSON.parse(a.params) as { shotId?: unknown }
    return typeof p.shotId === 'string' && p.shotId ? p.shotId : null
  } catch {
    return null
  }
}

/** [M11] 配音资产 params.lineId（tts 产物句 id） */
export function lineIdOfVoiceAsset(a: Asset): string | null {
  if (!a.params) return null
  try {
    const p = JSON.parse(a.params) as { lineId?: unknown }
    return typeof p.lineId === 'string' && p.lineId ? p.lineId : null
  } catch {
    return null
  }
}
