/**
 * M69 · 复检（design §4.6）：只报证据变化，永不判过。
 * 比较基准快照与当前 step_key 成片时间轴；任何结果都由人确认后才 verified。
 */
import { shotRange, type FinalTimeline, type ReviewCategory, type ReviewScopeKind } from './scope'
import { cuesDigestOf, type AssetShaLookup, type BaseSnapshot, type SnapshotMedia, type TimelineAudioInput } from './snapshot'

export type RecheckState = 'changed' | 'unchanged' | 'unverifiable'

export interface RecheckResult {
  state: RecheckState
  note: string
}

export interface RecheckInput {
  category: ReviewCategory
  scopeKind: ReviewScopeKind
  shotId: string | null
  startMs: number | null
  endMs: number | null
  snapshot: BaseSnapshot
  timeline: FinalTimeline | null
  audio: TimelineAudioInput | null
  assetSha: AssetShaLookup
}

interface Window {
  startMs: number
  endMs: number
}

function windowOf(p: RecheckInput): Window | null {
  if (!p.timeline) return null
  if (p.scopeKind === 'shot') {
    if (!p.shotId) return null
    return shotRange(p.timeline, p.shotId)
  }
  if (p.scopeKind === 'time') {
    if (p.startMs === null || p.endMs === null) return null
    return { startMs: p.startMs, endMs: p.endMs }
  }
  return { startMs: 0, endMs: p.timeline.totalMs }
}

/** time 范围在新成片已越界（成片变短）→ 不做时间重映射，按 unverifiable 诚实降级（spec §4.6） */
function windowOutOfRange(p: RecheckInput): boolean {
  return (
    p.scopeKind === 'time' &&
    p.timeline !== null &&
    (p.startMs === null || p.endMs === null || p.endMs > p.timeline.totalMs)
  )
}

const mediaDiff = (
  base: SnapshotMedia,
  cur: SnapshotMedia,
): 'same' | 'diff' | 'sha-missing' => {
  if (base.assetId !== cur.assetId) return 'diff'
  if (base.sha256 && cur.sha256) return base.sha256 === cur.sha256 ? 'same' : 'diff'
  return 'sha-missing'
}

function fmtId(id: number | null): string {
  return id === null ? '—' : `#${id}`
}

/** 媒体类（visual/prop/lip_sync） */
function recheckMedia(p: RecheckInput): RecheckResult {
  if (!p.timeline) return { state: 'unverifiable', note: '当前成片缺少时间轴快照，无法比对镜头媒体' }
  if (windowOutOfRange(p)) return { state: 'unverifiable', note: '原时间窗超出当前成片，无法比对（需人工看片）' }
  const win = windowOf(p)
  if (!win) return { state: 'unverifiable', note: '原范围无法在当前成片重锚定' }

  if (p.scopeKind === 'shot') {
    const base = p.snapshot.shot
    if (!base) return { state: 'unverifiable', note: '基准快照未记录该镜媒体' }
    const seg = p.timeline.segments.find((s) => s.shotId === p.shotId)
    if (!seg) return { state: 'unverifiable', note: `镜头 ${p.shotId ?? ''} 已不在当前成片` }
    const cur: SnapshotMedia = { shotId: seg.shotId, assetId: seg.assetId, sha256: p.assetSha(seg.assetId), startMs: seg.startMs, endMs: seg.endMs, durMs: seg.durMs }
    const d = mediaDiff(base, cur)
    if (d === 'diff') return { state: 'changed', note: `该镜媒体已更换：${fmtId(base.assetId)} → ${fmtId(cur.assetId)}（是否修好仍需人看）` }
    if (d === 'sha-missing') return { state: 'unchanged', note: '该镜 assetId 未变；sha 不可用，仅比对 assetId' }
    return { state: 'unchanged', note: '该镜媒体未更换（是否修好仍需人看）' }
  }

  const baseSegs = p.snapshot.segments
  if (!baseSegs.length) return { state: 'unverifiable', note: '基准快照未记录范围内镜头媒体' }
  const curSegs = p.timeline.segments.filter((s) => s.endMs > win.startMs && s.startMs < win.endMs)
  const suffix = p.snapshot.segmentsTruncated ? '（基准段数超限，仅比较已存段）' : ''

  const curByShot = new Map(curSegs.map((s) => [s.shotId ?? `#${s.assetId}`, s]))
  let shaMissing = false
  const diffs: string[] = []
  for (const b of baseSegs) {
    const key = b.shotId ?? `#${b.assetId}`
    const c = curByShot.get(key)
    if (!c) {
      diffs.push(`${b.shotId ?? '该段'} 已不在当前窗口`)
      continue
    }
    const d = mediaDiff(b, { shotId: c.shotId, assetId: c.assetId, sha256: p.assetSha(c.assetId), startMs: c.startMs, endMs: c.endMs, durMs: c.durMs })
    if (d === 'diff') diffs.push(`${key}：${fmtId(b.assetId)} → ${fmtId(c.assetId)}`)
    if (d === 'sha-missing') shaMissing = true
  }
  if (!p.snapshot.segmentsTruncated && curSegs.length > baseSegs.length) {
    diffs.push('窗口内新增镜头段')
  }
  if (diffs.length) return { state: 'changed', note: `范围内媒体已变化：${diffs.join('；')}${suffix}` }
  if (shaMissing) return { state: 'unchanged', note: `范围内 assetId 未变；部分 sha 不可用${suffix}` }
  return { state: 'unchanged', note: `范围内媒体未更换${suffix}` }
}

/** 字幕 */
function recheckSubtitle(p: RecheckInput): RecheckResult {
  if (!p.timeline) return { state: 'unverifiable', note: '当前成片缺少时间轴快照，无法比对字幕' }
  if (windowOutOfRange(p)) return { state: 'unverifiable', note: '原时间窗超出当前成片，无法比对（需人工看片）' }
  const win = windowOf(p)
  if (!win) return { state: 'unverifiable', note: '原范围无法在当前成片重锚定' }
  const cur = p.timeline.cues
    .filter((c) => c.endMs > win.startMs && c.startMs < win.endMs)
    .map((c) => ({ id: c.id, startMs: c.startMs, endMs: c.endMs, text: c.text }))

  if (p.snapshot.cuesTruncated) {
    const digest = cuesDigestOf(cur)
    const same = p.snapshot.cuesDigest !== null && digest === p.snapshot.cuesDigest
    return {
      state: same ? 'unchanged' : 'changed',
      note: same
        ? `字幕摘要一致（窗口 ${p.snapshot.cuesCount} 条，未展开逐条）`
        : `字幕摘要变化（基准 ${p.snapshot.cuesCount} 条 → 当前 ${cur.length} 条，未展开逐条）`,
    }
  }

  const baseCues = p.snapshot.cues
  if (!baseCues.length && !cur.length) return { state: 'unchanged', note: '范围内无字幕可比' }
  if (!baseCues.length || !cur.length) {
    return { state: 'changed', note: `字幕增删：基准 ${baseCues.length} 条 → 当前 ${cur.length} 条` }
  }
  const baseKey = [...baseCues]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.text.localeCompare(b.text))
    .map((c) => [c.startMs, c.endMs, c.text])
  const curKey = [...cur]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.text.localeCompare(b.text))
    .map((c) => [c.startMs, c.endMs, c.text])
  const same = JSON.stringify(baseKey) === JSON.stringify(curKey)
  return {
    state: same ? 'unchanged' : 'changed',
    note: same
      ? `范围内字幕文本/起止未变（${cur.length} 条）`
      : `范围内字幕文本/起止已变化（基准 ${baseCues.length} 条 → 当前 ${cur.length} 条）`,
  }
}

/** 音频：只读 timeline.bgm/sfx（实际生效值），shot 范围只比该镜 SFX + BGM */
function recheckAudio(p: RecheckInput): RecheckResult {
  const base = p.snapshot.audio
  if (!base) return { state: 'unverifiable', note: '基准快照未记录音频证据' }
  if (!p.audio) return { state: 'unverifiable', note: '当前成片缺少音频时间轴证据' }
  const shotId = p.scopeKind === 'shot' ? p.shotId : null
  const baseSfx = shotId ? base.sfx.filter((s) => s.shotId === shotId) : base.sfx
  const curSfx = shotId ? p.audio.sfx.filter((s) => s.shotId === shotId) : p.audio.sfx

  const diffs: string[] = []
  if ((base.bgm?.assetId ?? null) !== (p.audio.bgm?.assetId ?? null)) {
    diffs.push(`BGM 换绑 ${fmtId(base.bgm?.assetId ?? null)} → ${fmtId(p.audio.bgm?.assetId ?? null)}`)
  } else if (base.bgm && p.audio.bgm) {
    if (base.bgm.sha256 && p.assetSha(base.bgm.assetId) && base.bgm.sha256 !== p.assetSha(base.bgm.assetId)) {
      diffs.push('BGM 内容变化')
    }
    if ((base.bgm.volume ?? null) !== (p.audio.bgm.volume ?? null)) diffs.push(`BGM 音量 ${base.bgm.volume} → ${p.audio.bgm.volume}`)
    if ((base.bgm.fadeSec ?? null) !== (p.audio.bgm.fadeSec ?? null)) diffs.push(`BGM 淡入 ${base.bgm.fadeSec} → ${p.audio.bgm.fadeSec}`)
  }

  const norm = (xs: Array<{ shotId: string | null; assetId: number | null }>) =>
    xs.map((s) => `${s.shotId ?? '*'}:${s.assetId ?? '-'}`).sort()
  if (JSON.stringify(norm(baseSfx)) !== JSON.stringify(norm(curSfx))) diffs.push('SFX 绑定变化')

  if (diffs.length) return { state: 'changed', note: `音频证据已变化：${diffs.join('；')}` }
  return { state: 'unchanged', note: '音频绑定/音量/淡入未变（听感仍需人耳确认）' }
}

/** 节奏：总长 + 范围内段长 */
function recheckPacing(p: RecheckInput): RecheckResult {
  if (!p.timeline) return { state: 'unverifiable', note: '当前成片缺少时间轴快照，无法比对节奏' }
  if (windowOutOfRange(p)) return { state: 'unverifiable', note: '原时间窗超出当前成片，无法比对（需人工看片）' }
  const diffs: string[] = []
  if (p.timeline.totalMs !== p.snapshot.totalMs) {
    diffs.push(`总长 ${p.snapshot.totalMs}ms → ${p.timeline.totalMs}ms`)
  }
  const win = windowOf(p)
  if (win) {
    const baseDur = new Map(p.snapshot.segments.map((s) => [s.shotId ?? `#${s.assetId}`, s.durMs]))
    const curSegs = p.timeline.segments.filter((s) => s.endMs > win.startMs && s.startMs < win.endMs)
    for (const s of curSegs) {
      const k = s.shotId ?? `#${s.assetId}`
      const b = baseDur.get(k)
      if (b !== undefined && b !== s.durMs) diffs.push(`${k} 段长 ${b}ms → ${s.durMs}ms`)
      if (b === undefined) diffs.push(`${k} 为新增段`)
    }
  }
  if (diffs.length) return { state: 'changed', note: `节奏证据已变化：${diffs.join('；')}` }
  return { state: 'unchanged', note: '总长与范围内段长未变' }
}

export function recheckScope(p: RecheckInput): RecheckResult {
  if (p.category === 'other') {
    return { state: 'unverifiable', note: '其他类问题无自动可比证据，需人工复核' }
  }
  if (p.category === 'subtitle') return recheckSubtitle(p)
  if (p.category === 'audio') return recheckAudio(p)
  if (p.category === 'pacing') return recheckPacing(p)
  return recheckMedia(p)
}
