import type { Asset } from '../../../db/schema'
import type { AlignPlan } from './align'
import type { Segment } from './segments'
import { shotIdOfAsset } from './segments'
import { round3 } from './util'

/**
 * Canonical 同源时间轴快照（成片 params.timeline 落库结构，剪辑工程交换导出的唯一真源）。
 * 数据全部来自合成期内存中已算好的既有变量（AlignPlan/voiceMetas/sfx entries/bgm/intro），
 * **纯增量溯源字段——不改任何 ffmpeg 参数与音频结果**（B② 同源红线）。
 * 坐标口径：segments.startSec / lines.timelineStart 均为「内容轴」（片头后为 0 起算，与 AlignPlan 同轴）；
 * sfx.startSec 与 intro 位移后的最终成片绝对轴同口径（planSfxStarts 已含片头位移）。
 */

/** 台词文本截断上限（params 体积护栏；完整文本经 subtitleRelPath 的 SRT 资产导出时读取） */
const TEXT_CAP = 200

export interface EditTimelineSegment {
  shotId: string | null
  assetId: number
  /** 镜头媒体相对路径（images 模式为定妆图，motion 为片段视频） */
  relPath: string | null
  kind: 'image' | 'video'
  durSec: number
  /** 内容轴起点 = Σ 前段 durSec（转场启用时为切点近似，transition 字段另行声明） */
  startSec: number
  lineIds: string[]
  silenceSec: number
}

export interface EditTimelineLine {
  lineId: string
  assetId: number | null
  /** 配音音频相对路径（无对应配音资产时 null） */
  relPath: string | null
  /** 内容轴起点秒（与 AlignPlan.timelineStart 同轴；未对齐时按配音 concat 序累计） */
  timelineStart: number
  durSec: number | null
  text: string
}

export interface EditTimeline {
  v: 1
  fps: number
  width: number
  height: number
  /** 成片总长（含片头尾） */
  totalSec: number
  introSec: number
  outroSec: number
  segments: EditTimelineSegment[]
  lines: EditTimelineLine[]
  sfx: Array<{ shotId: string | null; assetId: number | null; startSec: number; relPath: string }>
  bgm: { assetId: number | null; relPath: string; volume: number; fadeSec: number } | null
  transition: { type: string; durSec: number } | null
  subtitle: { assetId: number | null; relPath: string } | null
  watermark: boolean
}

/** 合成期输入 → 快照（纯函数，探针可直测） */
export function buildEditTimeline(p: {
  fps: number
  width: number
  height: number
  totalSec: number
  introSec: number
  outroSec: number
  segments: Segment[]
  rows: Asset[]
  alignPlan: AlignPlan | null
  voices: Array<{ assetId: number; lineId: string | null; durSec: number | null; relPath: string | null; text?: string }>
  sfx: Array<{ shotId: string | null; assetId?: number | null; startSec: number; relPath: string }>
  bgm: { assetId: number | null; relPath: string; volume: number; fadeSec: number } | null
  transition: { type: string; durSec: number } | null
  subtitle: { assetId: number | null; relPath: string } | null
  watermark: boolean
}): EditTimeline {
  const relByAsset = new Map(p.rows.map((a) => [a.id, a.relPath]))
  const shotByAsset = new Map(p.rows.map((a) => [a.id, shotIdOfAsset(a)]))
  const linePos = new Map((p.alignPlan?.lines ?? []).map((l) => [l.lineId, l.timelineStart]))
  const segPlan = new Map((p.alignPlan?.segments ?? []).map((s) => [s.shotId, s]))

  let cursor = 0
  const segments: EditTimelineSegment[] = []
  for (const seg of p.segments) {
    const shotId = shotByAsset.get(seg.id) ?? null
    const ps = shotId ? segPlan.get(shotId) : undefined
    segments.push({
      shotId,
      assetId: seg.id,
      relPath: relByAsset.get(seg.id) ?? null,
      kind: seg.kind,
      durSec: round3(seg.durSec),
      startSec: round3(cursor),
      lineIds: ps ? [...ps.lineIds] : [],
      silenceSec: ps ? round3(ps.silenceSec) : 0,
    })
    cursor += seg.durSec
  }

  // 逐句：有 canonical 计划取其 timelineStart；无计划按配音 concat 连续轴（与合成混流同构）从 0 累计
  const lines: EditTimelineLine[] = []
  let concatCursor = 0
  for (const v of p.voices) {
    if (!v.lineId) continue
    const start = linePos.get(v.lineId) ?? concatCursor
    concatCursor += v.durSec ?? 0
    lines.push({
      lineId: v.lineId,
      assetId: v.assetId,
      relPath: v.relPath,
      timelineStart: round3(start),
      durSec: v.durSec != null ? round3(v.durSec) : null,
      text: (v.text ?? '').slice(0, TEXT_CAP),
    })
  }

  return {
    v: 1,
    fps: p.fps,
    width: p.width,
    height: p.height,
    totalSec: round3(p.totalSec),
    introSec: round3(p.introSec),
    outroSec: round3(p.outroSec),
    segments,
    lines,
    sfx: p.sfx.map((s) => ({ shotId: s.shotId, assetId: s.assetId ?? null, startSec: round3(s.startSec), relPath: s.relPath })),
    bgm: p.bgm ? { assetId: p.bgm.assetId, relPath: p.bgm.relPath, volume: p.bgm.volume, fadeSec: round3(p.bgm.fadeSec) } : null,
    transition: p.transition,
    subtitle: p.subtitle,
    watermark: p.watermark,
  }
}
