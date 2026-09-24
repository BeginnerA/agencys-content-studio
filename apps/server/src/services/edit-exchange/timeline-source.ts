/**
 * 剪辑工程时间轴真源解析（stored / recomputed 双路）：
 * - stored：合成期成片 params.timeline 落库快照 → 直通（零重算漂移）；
 * - recomputed：无 timeline 的存量成片，用分镜 + 配音资产就地经 planBestEffortTimeline 重算段/句位置，
 *   再复用 buildEditTimeline 组装（媒体路径/BGM/转场/字幕等非位置字段取自成片既有 params）——同源算法，不造第三条时间轴逻辑；
 * - 双失败（native_dialogue / strict / 无 lines 字段 / 映射不一致 / 无镜头输入）→ 抛 no_timeline。
 */
import { readFileSync } from 'node:fs'
import { collectRunAssets } from '../export'
import { absPathOf } from '../storage'
import { probeMediaDuration } from '../ffmpeg'
import type { Asset } from '../../db/schema'
import {
  parseShotLines,
  planBestEffortTimeline,
  type AlignPlan,
} from '../../pipeline/actions/ffmpeg-merge/align'
import { shotIdOfAsset, lineIdOfVoiceAsset, type Segment } from '../../pipeline/actions/ffmpeg-merge/segments'
import { buildEditTimeline, type EditTimeline } from '../../pipeline/actions/ffmpeg-merge/timeline-snapshot'

export type EditExchangeErrorCode = 'no_final_video' | 'no_timeline' | 'bad_format'

export class EditExchangeError extends Error {
  constructor(readonly code: EditExchangeErrorCode, message: string) {
    super(message)
    this.name = 'EditExchangeError'
  }
}

export interface ResolvedTimeline {
  source: 'stored' | 'recomputed'
  timeline: EditTimeline
}

/** params.timeline 结构校验（stored 直通前；缺字段/旧产物 → null 转 recomputed） */
function parseStoredTimeline(params: Record<string, unknown>): EditTimeline | null {
  const t = params['timeline']
  if (!t || typeof t !== 'object') return null
  const tl = t as Partial<EditTimeline>
  if (tl.v !== 1 || !Array.isArray(tl.segments) || !Array.isArray(tl.lines)) return null
  return t as EditTimeline
}

function parseFps(v: unknown): number {
  return typeof v === 'number' && v > 0 ? v : 25
}

function parseResolution(v: unknown): { width: number; height: number } {
  const m = typeof v === 'string' ? /^(\d+)x(\d+)$/.exec(v) : null
  return { width: m ? Number(m[1]) : 1080, height: m ? Number(m[2]) : 1920 }
}

function numOr(v: unknown, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fb
}

/** 读 run 成片 params.timeline（stored）；无则按分镜+配音重算（recomputed）；双失败抛 no_timeline */
export async function resolveEditTimeline(runId: number): Promise<ResolvedTimeline> {
  const rows = await collectRunAssets(runId)
  const final = rows.find((a) => a.purpose === 'final_video' && a.kind === 'video')
  if (!final) throw new EditExchangeError('no_final_video', '该 run 无成片（final_video 产物），无法导出剪辑工程')
  const fp = safeObj(final.params)
  const stored = parseStoredTimeline(fp)
  if (stored) return { source: 'stored', timeline: stored }
  return { source: 'recomputed', timeline: await recomputeTimeline(rows, final, fp) }
}

/** 存量成片兜底重算：位置（段/句）走 planBestEffortTimeline，其余字段取成片 params 既有溯源 */
async function recomputeTimeline(rows: Asset[], final: Asset, fp: Record<string, unknown>): Promise<EditTimeline> {
  const inputs = safeObj(fp['inputs'])
  const imageIds = numArray(inputs['images'])
  const clipIds = numArray(inputs['motion_clips'])
  const shotAssetIds = imageIds.length > 0 ? imageIds : clipIds
  if (shotAssetIds.length === 0) throw new EditExchangeError('no_timeline', '成片缺少镜头输入溯源，无法重算时间轴；请重新合成后再导出')
  const mode: 'images' | 'motion' = imageIds.length > 0 ? 'images' : 'motion'

  const byId = new Map(rows.map((a) => [a.id, a]))
  const shotRows = shotAssetIds.map((id) => byId.get(id)).filter((a): a is Asset => !!a && !!a.relPath)
  if (shotRows.length === 0) throw new EditExchangeError('no_timeline', '镜头资产均不可用，无法重算时间轴；请重新合成后再导出')

  // 分镜文本（shots 资产）→ 对齐输入
  const shotsId = numOr(inputs['shots_source'], 0)
  const shotsAsset = shotsId ? byId.get(shotsId) : undefined
  let shots: ReturnType<typeof parseShotLines>['shots'] = []
  let hasLinesField = false
  if (shotsAsset?.relPath) {
    try {
      const parsed = parseShotLines(readFileSync(absPathOf(shotsAsset.relPath), 'utf8'))
      shots = parsed.shots
      hasLinesField = parsed.hasLinesField
    } catch {
      // 分镜文本读取失败 → 交由 planBestEffortTimeline 以 no_shots 兜底
    }
  }

  // 配音资产 → lineId→实测时长 映射 + 逐句 meta
  const voiceAssets = rows.filter((a) => a.kind === 'audio' && (a.purpose === 'voice' || a.purpose === 'dialogue_audio'))
  const voiceDur = new Map<string, number>()
  const voices: Array<{ assetId: number; lineId: string | null; durSec: number | null; relPath: string | null; text: string }> = []
  for (const a of voiceAssets) {
    const lineId = lineIdOfVoiceAsset(a)
    const durSec = typeof a.duration === 'number' && a.duration > 0 ? a.duration : a.relPath ? probeMediaDuration(absPathOf(a.relPath)) : null
    voices.push({ assetId: a.id, lineId, durSec, relPath: a.relPath ?? null, text: a.prompt ?? '' })
    if (lineId && durSec != null && durSec > 0) voiceDur.set(lineId, durSec)
  }

  const clipDurByShotId = mode === 'motion' ? buildMotionClipDurs(shotRows) : undefined
  const plan = planBestEffortTimeline(shots, voiceDur, 4, { hasLinesField, mode, clipDurByShotId })
  if (!plan.aligned) {
    throw new EditExchangeError('no_timeline', `存量成片时间轴重算失败（${plan.reason ?? 'unknown'}）；请重新合成后再导出`)
  }

  // 段：按 canonical 计划顺序（shotId → 资产）重组，durSec 取计划值
  const assetByShotId = new Map(shotRows.map((a) => [shotIdOfAsset(a), a]).filter((x): x is [string, Asset] => !!x[0]))
  const segments: Segment[] = []
  for (const ps of plan.segments) {
    const a = assetByShotId.get(ps.shotId)
    if (!a?.relPath) continue
    segments.push({ id: a.id, path: absPathOf(a.relPath), kind: a.kind === 'video' ? 'video' : 'image', durSec: ps.durSec })
  }

  const res = parseResolution(fp['resolution'])
  const bgm = parseBgm(fp['bgm'], byId)
  const transition = parseTransition(fp['transition'])
  const subtitleAsset = rows.find((a) => a.purpose === 'subtitle' && a.relPath)

  return buildEditTimeline({
    fps: parseFps(fp['fps']),
    width: res.width,
    height: res.height,
    totalSec: numOr(fp['duration'], plan.totalDur),
    introSec: numOr(safeObj(fp['intro'])['duration'], 0),
    outroSec: numOr(safeObj(fp['outro'])['duration'], 0),
    segments,
    rows: shotRows,
    alignPlan: plan as AlignPlan,
    voices,
    sfx: [], // 存量 params.sfx 仅存计数无逐条起点 → 不重建（如实降级）
    bgm,
    transition,
    subtitle: subtitleAsset ? { assetId: subtitleAsset.id, relPath: subtitleAsset.relPath! } : null,
    watermark: !!fp['watermark'],
  })
}

/** motion 模式：shotId → 视频资产实测时长（供 planBestEffortTimeline 作 clip 时间轴基准，不拉伸） */
function buildMotionClipDurs(shotRows: Asset[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const a of shotRows) {
    const sid = shotIdOfAsset(a)
    if (!sid || !a.relPath) continue
    const dur = typeof a.duration === 'number' && a.duration > 0 ? a.duration : probeMediaDuration(absPathOf(a.relPath))
    if (dur != null && dur > 0) out.set(sid, dur)
  }
  return out
}

function parseBgm(v: unknown, byId: Map<number, Asset>): EditTimeline['bgm'] {
  const b = safeObj(v)
  const assetId = numOr(b['asset_id'], 0)
  if (!assetId) return null
  const relPath = byId.get(assetId)?.relPath
  if (!relPath) return null
  return { assetId, relPath, volume: numOr(b['volume'], 1), fadeSec: numOr(b['fade'], 0) }
}

function parseTransition(v: unknown): EditTimeline['transition'] {
  const t = safeObj(v)
  if (t['enabled'] !== true) return null
  const type = typeof t['type'] === 'string' ? t['type'] : 'fade'
  return { type, durSec: numOr(t['dur_sec'], 0) }
}

function safeObj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v) as unknown
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return {}
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []
}
