/**
 * EDL CMX3600 格式化器（Premiere / Avid）——纯函数，探针可直测。
 * 语义上限（§决策 3）：仅 V 镜头序列 + AA 旁白混音轨；转场 → 后一事件标 D（Dissolve）并附过渡时长；
 *   无字幕 / SFX / BGM 分层（EDL 表达能力上限，包内 README 声明降级面）。时码 HH:MM:SS:FF @fps（NDF）。
 */
import { basename } from 'node:path'
import type { EditTimeline } from '../../pipeline/actions/ffmpeg-merge/timeline-snapshot'
import type { FormatCtx } from './render-context'
import { secToTimecode, secToFrames } from './timecode'

/** relPath → EDL reel 名（CMX3600 ≤8 字符大写无空格；缺省 AX） */
function reelFor(nameOf: (r: string) => string, relPath: string | null): string {
  if (!relPath) return 'AX'
  const stem = basename(nameOf(relPath)).replace(/\.[^.]+$/, '')
  const clean = stem.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8)
  return clean || 'AX'
}

const pad = (n: number): string => String(n).padStart(4, '0')
const tc = (sec: number, fps: number): string => secToTimecode(sec, fps)

/** 单事件行（列对齐 CMX3600） */
function event(num: number, reel: string, track: 'V' | 'AA', type: 'C' | 'D', si: string, so: string, ri: string, ro: string, transField?: string): string {
  const t = type === 'D' && transField ? `D  ${transField}` : type
  return `${pad(num)}  ${reel.padEnd(8)} ${track.padEnd(5)} ${t.padEnd(8)} ${si} ${so} ${ri} ${ro}`
}

export function toEdl(tl: EditTimeline, ctx: FormatCtx): string {
  const fps = tl.fps
  const intro = tl.introSec
  const out: string[] = []
  out.push(`TITLE: ${ctx.title}`)
  out.push('FCM: NON-DROP FRAME')
  out.push('')

  let num = 1
  // V 镜头序列（record 时码升序；转场启用时第 2..n 段标 Dissolve）
  let cursor = 0
  for (let i = 0; i < tl.segments.length; i++) {
    const s = tl.segments[i]!
    const reel = reelFor(ctx.nameOf, s.relPath)
    const isDissolve = !!tl.transition && i > 0
    const transField = isDissolve && tl.transition ? `00.${pad(secToFrames(tl.transition.durSec, fps) % 100).slice(-2)}` : undefined
    out.push(
      event(num++, reel, 'V', isDissolve ? 'D' : 'C',
        tc(0, fps), tc(s.durSec, fps), tc(intro + cursor, fps), tc(intro + cursor + s.durSec, fps), transField),
    )
    cursor += s.durSec
  }

  // AA 旁白混音轨（逐句配音，record = intro + timelineStart）
  for (const l of tl.lines) {
    if (!l.relPath) continue
    const reel = reelFor(ctx.nameOf, l.relPath)
    const dur = l.durSec ?? 0
    out.push(
      event(num++, reel, 'AA', 'C',
        tc(0, fps), tc(dur, fps), tc(intro + l.timelineStart, fps), tc(intro + l.timelineStart + dur, fps)),
    )
  }

  return out.join('\r\n') + '\r\n'
}
