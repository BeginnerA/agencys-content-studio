/**
 * 共享字幕 cue 读取（precision-rework §8）：剪辑工程字幕轨必须由 timeline.subtitle.cues
 * （合成期有效字幕快照，coordinate='final' 绝对轴，已含片头位移与人工修订平移）构造，
 * 不再拿 timeline.lines 的对白文本/时码覆盖人工修订；对白音轨仍只读 lines（双轨分离）。
 * 旧 v=1 快照无 cues 时按兜底旧规则（lines 文本 + 内容轴 +intro）构造并如实标注来源，
 * 由调用方（formatNotes/manifest）向用户声明兜底面。纯函数，探针可直测。
 */
import type { EditTimeline } from '../../pipeline/actions/ffmpeg-merge/timeline-snapshot'

/** 格式化器统一消费的字幕条目（startSec 为成片绝对轴秒） */
export interface ExchangeCue {
  id: string
  startSec: number
  durSec: number
  text: string
}

export interface SubtitleCueRead {
  cues: ExchangeCue[]
  /** subtitle=取自有效字幕快照 cues（人工修订已体现）；lines-fallback=旧快照兜底；none=无可导字幕 */
  source: 'subtitle' | 'lines-fallback' | 'none'
  /** 快照声明的字幕来源；兜底/无字幕为 null */
  origin: 'source' | 'manual' | null
}

/** 读取剪辑工程字幕轨条目：subtitle.cues 优先，缺失/畸形回退 lines 兜底 */
export function readSubtitleCues(tl: EditTimeline): SubtitleCueRead {
  const sub = tl.subtitle
  const rawCues = sub?.cues
  if (Array.isArray(rawCues) && rawCues.length > 0) {
    const cues: ExchangeCue[] = []
    for (const c of rawCues) {
      if (!c || typeof c.startMs !== 'number' || typeof c.endMs !== 'number' || typeof c.text !== 'string') continue
      cues.push({
        id: typeof c.id === 'string' && c.id ? c.id : `cue-${cues.length + 1}`,
        startSec: c.startMs / 1000,
        durSec: Math.max(0, (c.endMs - c.startMs) / 1000),
        text: c.text,
      })
    }
    if (cues.length > 0) return { cues, source: 'subtitle', origin: sub?.origin ?? 'source' }
  }
  if (tl.lines.length > 0) {
    const cues: ExchangeCue[] = tl.lines.map((l, i) => ({
      id: l.lineId || `line-${i + 1}`,
      startSec: tl.introSec + l.timelineStart,
      durSec: l.durSec ?? 2,
      text: l.text,
    }))
    return { cues, source: 'lines-fallback', origin: null }
  }
  return { cues: [], source: 'none', origin: null }
}
