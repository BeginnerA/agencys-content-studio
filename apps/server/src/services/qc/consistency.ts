/**
 * 第四期 · 统一 QC 面板：一致性核验（规格 2026-09-28 §4）。
 *
 * **纯函数**：入参为已加载的成片 `params.timeline` 快照、实测时长、run 级 `_compose.shot_durations`、
 * 台账最近 applied 指纹与当前基准指纹；输出对应 QcCheck[]。不查库、不调 capability、不触执行——
 * 由 report.ts 编排取数。时间轴只读解析自 `params.timeline`（唯一真源），严禁反推重建第二套时轴。
 */
import { QC_DURATION_TOLERANCE_SEC, type QcCheck } from './types'

/** 从 params.timeline 只读解析出的最小快照（字段缺省即 null/空，不臆造）。 */
export interface ParsedTimeline {
  totalSec: number | null
  segments: Array<{ shotId: string; kind: 'image' | 'video'; durSec: number; silenceSec: number }>
  lines: Array<{ timelineStart: number; durSec: number | null }>
  hasSubtitle: boolean
}

export interface ConsistencyInput {
  /** params.timeline 缺失 → null（timeline_source/duration 相应 not_tested，不反推） */
  timeline: ParsedTimeline | null
  /** ffprobe 实测成片时长；探测失败 → null */
  measuredDurationSec: number | null
  /** run 级 _compose.shot_durations（无覆盖 → 空对象） */
  shotDurations: Record<string, number>
  /** 台账最近 state='applied' 的 baseFingerprint；无 → null */
  lastAppliedFingerprint: string | null
  /** assessComposeInputCapability 当前基准指纹；门禁不满足 → null（无法计算，不伪造比对） */
  currentFingerprint: string | null
}

/** 只读解析 params.timeline（结构容错；缺字段不填充假值）。 */
export function parseTimeline(params: Record<string, unknown>): ParsedTimeline | null {
  const tl = params['timeline']
  if (!tl || typeof tl !== 'object' || Array.isArray(tl)) return null
  const o = tl as Record<string, unknown>
  const totalSec = typeof o.totalSec === 'number' && Number.isFinite(o.totalSec) ? o.totalSec : null
  const segs = Array.isArray(o.segments) ? o.segments : []
  const segments: ParsedTimeline['segments'] = []
  for (const s of segs) {
    if (!s || typeof s !== 'object') continue
    const so = s as Record<string, unknown>
    const shotId = typeof so.shotId === 'string' && so.shotId ? so.shotId : typeof so.id === 'string' ? so.id : null
    if (!shotId) continue
    segments.push({
      shotId,
      kind: so.kind === 'video' ? 'video' : 'image',
      durSec: typeof so.durSec === 'number' && Number.isFinite(so.durSec) ? so.durSec : 0,
      silenceSec: typeof so.silenceSec === 'number' && Number.isFinite(so.silenceSec) ? so.silenceSec : 0,
    })
  }
  const linesRaw = Array.isArray(o.lines) ? o.lines : []
  const lines: ParsedTimeline['lines'] = []
  for (const l of linesRaw) {
    if (!l || typeof l !== 'object') continue
    const lo = l as Record<string, unknown>
    if (typeof lo.timelineStart !== 'number' || !Number.isFinite(lo.timelineStart)) continue
    lines.push({ timelineStart: lo.timelineStart, durSec: typeof lo.durSec === 'number' && Number.isFinite(lo.durSec) ? lo.durSec : null })
  }
  const sub = o.subtitle
  return { totalSec, segments, lines, hasSubtitle: !!(sub && typeof sub === 'object' && !Array.isArray(sub)) }
}

/**
 * 五项一致性核验：timeline_source / duration_vs_timeline / shot_duration_applied /
 * rework_receipt_consistency / subtitle_alignment_present。逐条给可追溯来源，缺依据诚实标 not_tested/not_applicable。
 */
export function buildConsistencyChecks(input: ConsistencyInput): QcCheck[] {
  const out: QcCheck[] = []
  const { timeline, measuredDurationSec, shotDurations, lastAppliedFingerprint, currentFingerprint } = input

  // timeline_source：params.timeline 存在且含 totalSec 或 segments → passed；缺失 → not_tested（不反推）
  if (!timeline) {
    out.push({ key: 'timeline_source', status: 'not_tested', evidenceType: 'metadata', source: 'params.timeline', reason: '成片无 params.timeline 快照（legacy/未落快照），不反推重建时轴' })
  } else if (timeline.totalSec === null && timeline.segments.length === 0) {
    out.push({ key: 'timeline_source', status: 'not_tested', evidenceType: 'metadata', source: 'params.timeline', reason: 'params.timeline 缺 totalSec 与 segments，无法作为可比对基准' })
  } else {
    out.push({ key: 'timeline_source', status: 'passed', evidenceType: 'metadata', source: 'params.timeline', value: `${timeline.segments.length} 段 / totalSec=${timeline.totalSec ?? 'null'}` })
  }

  // duration_vs_timeline：实测时长 vs totalSec（无 totalSec 则 Σ 段长），容差 ±QC_DURATION_TOLERANCE_SEC
  const declaredTotal = timeline ? (timeline.totalSec ?? (timeline.segments.length ? timeline.segments.reduce((s, x) => s + x.durSec, 0) : null)) : null
  if (measuredDurationSec === null) {
    out.push({ key: 'duration_vs_timeline', status: 'not_tested', evidenceType: 'local_measurement', source: 'ffprobe', reason: 'ffprobe 不可用或未测得时长' })
  } else if (timeline === null || declaredTotal === null) {
    out.push({ key: 'duration_vs_timeline', status: 'not_tested', evidenceType: 'local_measurement', source: 'params.timeline', value: measuredDurationSec, reason: '缺 params.timeline，无法比对声明总长' })
  } else {
    const diff = Math.abs(measuredDurationSec - declaredTotal)
    out.push(
      diff <= QC_DURATION_TOLERANCE_SEC
        ? { key: 'duration_vs_timeline', status: 'passed', evidenceType: 'local_measurement', source: 'ffprobe', value: measuredDurationSec }
        : { key: 'duration_vs_timeline', status: 'failed', evidenceType: 'local_measurement', source: 'ffprobe', value: measuredDurationSec, reason: `实测 ${measuredDurationSec.toFixed(2)}s 与 params.timeline 声明 ${declaredTotal.toFixed(2)}s 差 ${diff.toFixed(2)}s（容差 ${QC_DURATION_TOLERANCE_SEC}s）` },
    )
  }

  // shot_duration_applied：图片镜显示段长必须 ≥ 请求覆盖（覆盖≥Σ 精确落地、<Σ 抬高到 Σ，绝不会被裁到请求以下）
  const durKeys = Object.keys(shotDurations).sort()
  if (durKeys.length === 0) {
    out.push({ key: 'shot_duration_applied', status: 'not_applicable', evidenceType: 'offline_probe', source: '_compose', reason: '本运行无镜头时长覆盖' })
  } else if (timeline === null) {
    out.push({ key: 'shot_duration_applied', status: 'not_tested', evidenceType: 'offline_probe', source: 'params.timeline', reason: '有 shot_durations 覆盖但缺 params.timeline，无法验证是否入轴' })
  } else {
    const segByShot = new Map(timeline.segments.map((s) => [s.shotId, s]))
    const drifted: string[] = []
    const missing: string[] = []
    for (const shotId of durKeys) {
      const req = shotDurations[shotId]
      if (typeof req !== 'number' || !Number.isFinite(req)) continue
      const seg = segByShot.get(shotId)
      if (!seg) {
        missing.push(shotId)
        continue
      }
      if (seg.durSec + 1e-6 < req) drifted.push(`${shotId}(段长${seg.durSec}<请求${req})`)
    }
    if (drifted.length) {
      out.push({ key: 'shot_duration_applied', status: 'failed', evidenceType: 'offline_probe', source: 'params.timeline', reason: `时长覆盖未反映到成片段长（返修后未重生成？）：${drifted.join(', ')}` })
    } else if (missing.length) {
      out.push({ key: 'shot_duration_applied', status: 'not_tested', evidenceType: 'offline_probe', source: 'params.timeline', reason: `覆盖镜在时间轴中无对应段：${missing.join(', ')}` })
    } else {
      out.push({ key: 'shot_duration_applied', status: 'passed', evidenceType: 'offline_probe', source: 'params.timeline', value: `${durKeys.length} 镜覆盖已入轴` })
    }
  }

  // rework_receipt_consistency：台账最近 applied 指纹 vs 当前基准指纹（漂移=返修后成片/配置已变）
  if (lastAppliedFingerprint === null) {
    out.push({ key: 'rework_receipt_consistency', status: 'not_applicable', evidenceType: 'offline_probe', source: 'rework_ledger', reason: '该运行无已应用返修记录' })
  } else if (currentFingerprint === null) {
    out.push({ key: 'rework_receipt_consistency', status: 'not_tested', evidenceType: 'offline_probe', source: 'rework_ledger', reason: '返修能力门禁未满足，无法计算当前基准指纹以比对台账' })
  } else if (lastAppliedFingerprint === currentFingerprint) {
    out.push({ key: 'rework_receipt_consistency', status: 'passed', evidenceType: 'offline_probe', source: 'rework_ledger', value: '台账 applied 与当前基准一致' })
  } else {
    out.push({ key: 'rework_receipt_consistency', status: 'failed', evidenceType: 'offline_probe', source: 'rework_ledger', reason: '存在已应用返修回执但当前成片/配置基准指纹已变（返修后成片未重生成或被替换）' })
  }

  // subtitle_alignment_present：只读结构核验字幕行是否落在声明总长内（不做 OCR/语义）
  if (timeline === null) {
    out.push({ key: 'subtitle_alignment_present', status: 'not_tested', evidenceType: 'metadata', source: 'params.timeline', reason: '缺 params.timeline' })
  } else if (timeline.lines.length === 0) {
    out.push({ key: 'subtitle_alignment_present', status: 'not_applicable', evidenceType: 'metadata', source: 'params.timeline', reason: timeline.hasSubtitle ? '含字幕快照但无可定位行' : '成片无字幕行（未烧录/无字幕）' })
  } else if (declaredTotal === null) {
    out.push({ key: 'subtitle_alignment_present', status: 'not_tested', evidenceType: 'metadata', source: 'params.timeline', reason: '有字幕行但缺声明总长，无法判定越界' })
  } else {
    const over = timeline.lines.filter((l) => (l.timelineStart + (l.durSec ?? 0)) > declaredTotal + QC_DURATION_TOLERANCE_SEC)
    out.push(
      over.length === 0
        ? { key: 'subtitle_alignment_present', status: 'passed', evidenceType: 'metadata', source: 'params.timeline', value: `${timeline.lines.length} 行均在时间轴内` }
        : { key: 'subtitle_alignment_present', status: 'failed', evidenceType: 'metadata', source: 'params.timeline', reason: `${over.length}/${timeline.lines.length} 字幕行超出声明总长 ${declaredTotal.toFixed(2)}s（结构越界，语义仍需人工）` },
    )
  }

  return out
}
