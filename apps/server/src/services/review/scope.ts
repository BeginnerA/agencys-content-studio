/**
 * 审片问题单 · 时间轴定位纯函数。
 * 唯一真源 = 成片 params.timeline：segments.startSec 为内容轴（片头后 0 起算），
 * cues.coordinate='final' 已是最终绝对轴。本模块不查库、不读文件、不触执行。
 */
export type ReviewScopeKind = 'shot' | 'time' | 'global'
export type ReviewCategory = 'visual' | 'prop' | 'lip_sync' | 'subtitle' | 'audio' | 'pacing' | 'other'
export type ReviewSeverity = 'blocker' | 'major' | 'minor'

export interface TimelineSegment {
  shotId: string | null
  assetId: number | null
  kind: string
  startMs: number
  endMs: number
  durMs: number
}

export interface TimelineCue {
  id: string
  startMs: number
  endMs: number
  text: string
}

export interface FinalTimeline {
  totalMs: number
  introMs: number
  outroMs: number
  segments: TimelineSegment[]
  cues: TimelineCue[]
}

export interface ReviewAssetLike {
  id: number
  kind: string
  purpose?: string | null
  relPath?: string | null
  deletedAt?: number | null
  sha256?: string | null
  duration?: number | null
  createdAt?: number | null
}

export interface ReviewStepLike {
  id: number
  stepKey: string
  actionKey: string
  output: string | null
}

export interface ResolvedFinal {
  assetId: number
  /** 是否走了「该步无可用产物 → 全 run 最新成片」降级 */
  degraded: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

function outputIdsOfRaw(output: string | null): number[] {
  if (!output) return []
  try {
    const o = JSON.parse(output) as Record<string, unknown>
    const ids = o['asset_ids']
    if (!Array.isArray(ids)) return []
    return ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

function usableFinal(a: ReviewAssetLike): boolean {
  return (
    a.deletedAt == null &&
    a.kind === 'video' &&
    a.purpose === 'final_video' &&
    typeof a.relPath === 'string' &&
    a.relPath.length > 0
  )
}

/**
 * 该 stepKey 的当前成片：先取同 stepKey + ffmpeg_merge 步骤 output.asset_ids 中最新可用 final_video；
 * 无匹配步骤或产物被删 → 回退该 run 最新可用 final_video（降级，仍可审）。
 */
export function resolveReviewFinal(
  steps: ReviewStepLike[],
  assets: ReviewAssetLike[],
  stepKey = 'compose',
): ResolvedFinal | null {
  const byId = new Map(assets.map((a) => [a.id, a]))
  const compose = steps
    .filter((s) => s.stepKey === stepKey && s.actionKey === 'ffmpeg_merge')
    .sort((a, b) => b.id - a.id)[0]
  if (compose) {
    const ids = outputIdsOfRaw(compose.output)
    for (const id of [...ids].sort((a, b) => b - a)) {
      const a = byId.get(id)
      if (a && usableFinal(a)) return { assetId: a.id, degraded: false }
    }
  }
  const fallback = assets
    .filter(usableFinal)
    .sort((a, b) => b.id - a.id)[0]
  return fallback ? { assetId: fallback.id, degraded: true } : null
}

/** 只读 params.timeline；结构不足返回 null（降级，不反推） */
export function parseFinalTimeline(paramsJson: string | null): FinalTimeline | null {
  if (!paramsJson) return null
  let params: Record<string, unknown>
  try {
    const p = JSON.parse(paramsJson) as unknown
    if (!isObj(p)) return null
    params = p
  } catch {
    return null
  }
  const raw = params['timeline']
  if (!isObj(raw)) return null
  const introMs = Math.max(0, Math.round((num(raw['introSec']) ?? 0) * 1000))
  const outroMs = Math.max(0, Math.round((num(raw['outroSec']) ?? 0) * 1000))

  const rawSegs = raw['segments']
  const segments: TimelineSegment[] = Array.isArray(rawSegs)
    ? rawSegs.filter(isObj).map((s) => {
        const startSec = num(s['startSec']) ?? 0
        const durSec = Math.max(0, num(s['durSec']) ?? 0)
        const startMs = introMs + Math.round(startSec * 1000)
        return {
          shotId: typeof s['shotId'] === 'string' && s['shotId'] ? s['shotId'] : null,
          assetId: num(s['assetId']),
          kind: typeof s['kind'] === 'string' ? s['kind'] : 'video',
          startMs,
          endMs: startMs + Math.round(durSec * 1000),
          durMs: Math.round(durSec * 1000),
        }
      })
    : []

  const totalSec = num(raw['totalSec'])
  const derived = introMs + segments.reduce((n, s) => n + s.durMs, 0) + outroMs
  const totalMs = totalSec !== null ? Math.round(totalSec * 1000) : derived
  // 既无声明总长、又无任何段 → 无时间轴证据
  if (totalSec === null && segments.length === 0) return null

  const sub = raw['subtitle']
  const rawCues = isObj(sub) ? sub['cues'] : undefined
  const cues: TimelineCue[] = Array.isArray(rawCues)
    ? rawCues
        .filter(isObj)
        .map((c) => ({
          id: typeof c['id'] === 'string' ? c['id'] : '',
          startMs: Math.round(num(c['startMs']) ?? 0),
          endMs: Math.round(num(c['endMs']) ?? 0),
          text: typeof c['text'] === 'string' ? c['text'] : '',
        }))
        .filter((c) => c.endMs > c.startMs)
    : []

  return { totalMs, introMs, outroMs, segments, cues }
}

export interface AtLocation {
  kind: 'intro' | 'shot' | 'outro' | 'outside'
  shotId?: string
  startMs?: number
  endMs?: number
}

/** 半开区间定位：边界取后一段；atMs ≥ totalMs 或负值 → outside */
export function locateAt(tl: FinalTimeline, atMs: number): AtLocation {
  if (!Number.isFinite(atMs) || atMs < 0 || atMs >= tl.totalMs) return { kind: 'outside' }
  if (atMs < tl.introMs) return { kind: 'intro' }
  for (const s of tl.segments) {
    if (atMs >= s.startMs && atMs < s.endMs) {
      return { kind: 'shot', shotId: s.shotId ?? undefined, startMs: s.startMs, endMs: s.endMs }
    }
  }
  return { kind: 'outro' }
}

export function shotRange(tl: FinalTimeline, shotId: string): { startMs: number; endMs: number } | null {
  const s = tl.segments.find((x) => x.shotId === shotId)
  return s ? { startMs: s.startMs, endMs: s.endMs } : null
}

export type TimeRangeCheck =
  | { ok: true }
  | { ok: false; code: 'bad_scope' | 'no_timeline'; message: string }

/** 时间窗：整数、0 ≤ start < end、end ≤ 上限（timeline.totalMs，缺省资产时长毫秒） */
export function validateTimeRange(
  tl: FinalTimeline | null,
  startMs: number,
  endMs: number,
  fallbackDurationMs: number | null,
): TimeRangeCheck {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) {
    return { ok: false, code: 'bad_scope', message: '时间范围需为整数毫秒' }
  }
  if (startMs < 0 || startMs >= endMs) {
    return { ok: false, code: 'bad_scope', message: '时间范围需满足 0 ≤ 起点 < 终点' }
  }
  const max = tl?.totalMs ?? fallbackDurationMs
  if (max === null) {
    return { ok: false, code: 'no_timeline', message: '当前成片缺少可用时间轴，无法创建时间范围问题；请改用全片范围' }
  }
  if (endMs > max) {
    return { ok: false, code: 'bad_scope', message: `时间范围超出成片时长（${max}ms）` }
  }
  return { ok: true }
}

/** 4.4 范围/类别矩阵：lip_sync 仅 shot；pacing 仅 time/global；其余不限 */
export function categoryAllowsScope(category: ReviewCategory, kind: ReviewScopeKind): boolean {
  if (category === 'lip_sync') return kind === 'shot'
  if (category === 'pacing') return kind === 'time' || kind === 'global'
  return true
}
