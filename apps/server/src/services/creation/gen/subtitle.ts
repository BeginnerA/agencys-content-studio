// [M22·批1-①] 字幕纯函数：段级 SRT 生成 / 轻量解析 / 已有字幕按段重钉（时间戳复用 ffmpeg-merge align.ts）。
import { secToSrtTs, srtTsToSec } from '../../../pipeline/actions/ffmpeg-merge/align'

/** [M22] SRT 时间戳行（对齐 align.ts 的 SRT_TIME_RE 语义；兼容 . 分隔） */
const SRT_TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/

export interface SubtitleSegment {
  /** 段起点（Σ 前序段长） */
  startSec: number
  /** 真实语音时长（tts 段时长；字幕止点 = start + min(voiceDur, segDur)） */
  voiceDur: number
  /** 对齐段时长（字幕覆盖上限） */
  segDur: number
  text: string
}

export interface SrtCue {
  startSec: number
  endSec: number
  text: string
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000

/** [M22] cues → SRT 文本（序号从 1 连续；end 早于 start 收敛；尾随换行） */
function renderSrt(cues: SrtCue[]): string {
  const blocks = cues.map((c, idx) => {
    const start = Math.max(0, c.startSec)
    const end = Math.max(start, c.endSec)
    return `${idx + 1}\n${secToSrtTs(start)} --> ${secToSrtTs(end)}\n${c.text}`
  })
  return `${blocks.join('\n\n')}\n`
}

/** [M22] 段级 SRT 生成：逐段一条 cue（start=段起点，end=start+min(voiceDur,segDur)）；文本空段跳过；全空 → null */
export function buildSegmentSrt(segs: SubtitleSegment[]): string | null {
  const cues: SrtCue[] = []
  for (const s of segs) {
    const text = s.text.trim()
    if (!text) continue
    const dur = Math.min(s.voiceDur, s.segDur)
    if (!(dur > 0)) continue
    cues.push({ startSec: s.startSec, endSec: round3(s.startSec + dur), text })
  }
  if (cues.length === 0) return null
  return renderSrt(cues)
}

/** [M22] 轻量 SRT 解析（hh:mm:ss,mmm / . 兼容）→ cues（时间戳行起块，空行/下一时间戳终止；兼容紧凑序号行） */
export function parseSrtCues(srt: string): SrtCue[] {
  const lines = srt.split(/\r?\n/)
  const cues: SrtCue[] = []
  let i = 0
  while (i < lines.length) {
    const m = SRT_TIME_RE.exec(lines[i]!)
    if (!m) {
      i += 1
      continue
    }
    const startSec = srtTsToSec(m[1]!, m[2]!, m[3]!, m[4]!)
    const endSec = srtTsToSec(m[5]!, m[6]!, m[7]!, m[8]!)
    const textLines: string[] = []
    i += 1
    while (i < lines.length) {
      const cur = lines[i]!
      if (cur.trim() === '') break
      if (SRT_TIME_RE.test(cur)) break
      if (/^\d+$/.test(cur.trim()) && i + 1 < lines.length && SRT_TIME_RE.test(lines[i + 1]!)) break
      textLines.push(cur)
      i += 1
    }
    cues.push({ startSec, endSec, text: textLines.join('\n') })
  }
  return cues
}

/** [M22] 已有字幕按段重钉：cue 数 == 段数时顺序重钉（cue_i 起点=段起点_i；时长保持原 cue 时长、clamp 段内）；数量不符 → null */
export function retimeSrtCues(cues: SrtCue[], segs: Array<{ startSec: number; segDur: number }>): string | null {
  if (cues.length === 0 || cues.length !== segs.length) return null
  const out: SrtCue[] = []
  for (let i = 0; i < cues.length; i += 1) {
    const seg = segs[i]!
    const cue = cues[i]!
    const text = cue.text.trim()
    if (!text) continue
    const dur = Math.min(Math.max(0, cue.endSec - cue.startSec), Math.max(0, seg.segDur))
    out.push({ startSec: seg.startSec, endSec: round3(seg.startSec + dur), text })
  }
  if (out.length === 0) return null
  return renderSrt(out)
}
