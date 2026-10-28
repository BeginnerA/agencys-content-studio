/**
 * M69 · 基准证据快照（design §4.2/§4.6）。
 * 只存「创建问题时看到的证据」，只覆盖问题范围：shot → 该镜段 + 相交 cues；
 * time → 相交段 + 窗口 cues；global → 全片。cues 50 / segments 200 上限，超限只留摘要。
 * 纯函数：sha256 由调用方注入（服务层 join assets）。
 */
import { createHash } from 'node:crypto'
import { shotRange, type FinalTimeline, type TimelineCue, type TimelineSegment } from './scope'

export interface SnapshotMedia {
  shotId: string | null
  assetId: number | null
  sha256: string | null
  startMs: number
  endMs: number
  durMs: number
}

export interface SnapshotShot extends SnapshotMedia {
  shotId: string
}

export interface SnapshotCue {
  id: string
  startMs: number
  endMs: number
  text: string
}

export interface SnapshotAudio {
  bgm: { assetId: number | null; sha256: string | null; volume: number | null; fadeSec: number | null } | null
  sfx: Array<{ shotId: string | null; assetId: number | null; sha256: string | null }>
}

export interface BaseSnapshot {
  v: 1
  stepKey: string
  finalAssetId: number
  finalSha256: string | null
  totalMs: number
  introMs: number
  shot: SnapshotShot | null
  segments: SnapshotMedia[]
  segmentsTruncated: boolean
  cues: SnapshotCue[]
  cuesDigest: string | null
  cuesCount: number
  cuesTruncated: boolean
  audio: SnapshotAudio | null
}

export type SnapshotScope =
  | { kind: 'shot'; shotId: string }
  | { kind: 'time'; startMs: number; endMs: number }
  | { kind: 'global' }

export interface TimelineAudioInput {
  bgm: { assetId: number | null; volume: number | null; fadeSec: number | null } | null
  sfx: Array<{ shotId: string | null; assetId: number | null }>
}

export type AssetShaLookup = (assetId: number | null) => string | null

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export const CUE_LIMIT = 50
export const SEGMENT_LIMIT = 200

/** 读 params.timeline 的音频实际生效值（不是 run.input._compose 覆盖意图）；无 timeline → null */
export function parseTimelineAudio(paramsJson: string | null): TimelineAudioInput | null {
  if (!paramsJson) return null
  let params: Record<string, unknown>
  try {
    const p = JSON.parse(paramsJson) as unknown
    if (!isObj(p)) return null
    params = p
  } catch {
    return null
  }
  const tl = params['timeline']
  if (!isObj(tl)) return null
  const rawBgm = tl['bgm']
  const bgm = isObj(rawBgm)
    ? { assetId: num(rawBgm['assetId']), volume: num(rawBgm['volume']), fadeSec: num(rawBgm['fadeSec']) }
    : null
  const rawSfx = tl['sfx']
  const sfx = Array.isArray(rawSfx)
    ? rawSfx.filter(isObj).map((s) => ({
        shotId: str(s['shotId']),
        assetId: num(s['assetId']),
      }))
    : []
  return { bgm, sfx }
}

/** 规范化 cue 摘要：排序后 [startMs,endMs,text]，不含 id（id 可能随重排变化） */
export function cuesDigestOf(cues: SnapshotCue[]): string {
  const norm = [...cues]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.text.localeCompare(b.text))
    .map((c) => [c.startMs, c.endMs, c.text])
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex')
}

function toMedia(s: TimelineSegment, assetSha: AssetShaLookup): SnapshotMedia {
  return {
    shotId: s.shotId,
    assetId: s.assetId,
    sha256: assetSha(s.assetId),
    startMs: s.startMs,
    endMs: s.endMs,
    durMs: s.durMs,
  }
}

export function buildBaseSnapshot(p: {
  stepKey: string
  finalAssetId: number
  finalSha256: string | null
  /** 无时间轴的旧成片允许为 null：只记录「无证据」快照，复检将 unverifiable */
  timeline: FinalTimeline | null
  scope: SnapshotScope
  audio: TimelineAudioInput | null
  assetSha: AssetShaLookup
  limits?: { cues?: number; segments?: number }
}): BaseSnapshot {
  const { timeline, scope, assetSha } = p
  const cueLimit = p.limits?.cues ?? CUE_LIMIT
  const segLimit = p.limits?.segments ?? SEGMENT_LIMIT

  const win: { startMs: number; endMs: number } | null = timeline
    ? scope.kind === 'shot'
      ? shotRange(timeline, scope.shotId)
      : scope.kind === 'time'
        ? { startMs: scope.startMs, endMs: scope.endMs }
        : { startMs: 0, endMs: timeline.totalMs }
    : scope.kind === 'time'
      ? { startMs: scope.startMs, endMs: scope.endMs }
      : null

  const shotSeg =
    timeline && scope.kind === 'shot' && win
      ? timeline.segments.find((s) => s.shotId === scope.shotId) ?? null
      : null
  const shot: SnapshotShot | null =
    shotSeg && shotSeg.shotId
      ? { ...toMedia(shotSeg, assetSha), shotId: shotSeg.shotId }
      : null

  const allSegs = timeline && win ? timeline.segments.filter((s) => s.endMs > win.startMs && s.startMs < win.endMs) : []
  const segments = allSegs.slice(0, segLimit).map((s) => toMedia(s, assetSha))

  const allCues: SnapshotCue[] =
    timeline && win
      ? timeline.cues
          .filter((c) => c.endMs > win.startMs && c.startMs < win.endMs)
          .map((c: TimelineCue) => ({ id: c.id, startMs: c.startMs, endMs: c.endMs, text: c.text }))
      : []

  let audio: SnapshotAudio | null = null
  if (p.audio) {
    const sfx = scope.kind === 'shot'
      ? p.audio.sfx.filter((s) => s.shotId === (scope as { shotId: string }).shotId)
      : p.audio.sfx
    audio = {
      bgm: p.audio.bgm
        ? {
            assetId: p.audio.bgm.assetId,
            sha256: assetSha(p.audio.bgm.assetId),
            volume: p.audio.bgm.volume,
            fadeSec: p.audio.bgm.fadeSec,
          }
        : null,
      sfx: sfx.map((s) => ({ shotId: s.shotId, assetId: s.assetId, sha256: assetSha(s.assetId) })),
    }
  }

  return {
    v: 1,
    stepKey: p.stepKey,
    finalAssetId: p.finalAssetId,
    finalSha256: p.finalSha256,
    totalMs: timeline?.totalMs ?? 0,
    introMs: timeline?.introMs ?? 0,
    shot,
    segments,
    segmentsTruncated: allSegs.length > segLimit,
    cues: allCues.slice(0, cueLimit),
    cuesDigest: cuesDigestOf(allCues),
    cuesCount: allCues.length,
    cuesTruncated: allCues.length > cueLimit,
    audio,
  }
}

const isMedia = (v: unknown): v is SnapshotMedia => isObj(v)
const isCue = (v: unknown): v is SnapshotCue => isObj(v)

/** 读回快照；结构不足 → null（复检降级 unverifiable） */
export function parseBaseSnapshot(raw: string | null): BaseSnapshot | null {
  if (!raw) return null
  let o: Record<string, unknown>
  try {
    const p = JSON.parse(raw) as unknown
    if (!isObj(p)) return null
    o = p
  } catch {
    return null
  }
  if (o['v'] !== 1 || num(o['finalAssetId']) === null) return null
  const shotRaw = o['shot']
  return {
    v: 1,
    stepKey: str(o['stepKey']) ?? 'compose',
    finalAssetId: num(o['finalAssetId'])!,
    finalSha256: str(o['finalSha256']),
    totalMs: num(o['totalMs']) ?? 0,
    introMs: num(o['introMs']) ?? 0,
    shot: isObj(shotRaw) && typeof shotRaw['shotId'] === 'string'
      ? (shotRaw as unknown as SnapshotShot)
      : null,
    segments: Array.isArray(o['segments']) ? (o['segments'] as unknown[]).filter(isMedia) : [],
    segmentsTruncated: o['segmentsTruncated'] === true,
    cues: Array.isArray(o['cues']) ? (o['cues'] as unknown[]).filter(isCue) : [],
    cuesDigest: str(o['cuesDigest']),
    cuesCount: num(o['cuesCount']) ?? 0,
    cuesTruncated: o['cuesTruncated'] === true,
    audio: isObj(o['audio']) ? (o['audio'] as unknown as SnapshotAudio) : null,
  }
}
