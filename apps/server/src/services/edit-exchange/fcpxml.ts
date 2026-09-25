/**
 * FCPXML 1.10 格式化器（剪映专业版 / Final Cut / DaVinci Resolve）——纯函数，探针可直测。
 * 结构：resources（format + 每媒体一 asset + 标题/转场声明）→ library/event/project/sequence → spines（多轨）。
 * 轨道映射（§决策 3）：V1=镜头段顺序（转场启用时段间 <transition> fade）；对白逐句 asset-clip；
 *   BGM 独立 spine；SFX 独立 spine；字幕逐句 <title> 挂 generator（文本纯净轴）。
 * 字幕轨数据源（precision-rework §8）：subtitle spine 取自有效字幕快照 cues（final 绝对轴，人工修订已体现），
 *   不再用 lines 覆盖；对白 spine 仍只读 lines。旧快照无 cues 时按兜底规则构造（见 subtitle-cues.ts）。
 * 时间值统一 rational seconds `帧/fps s`（帧精度，免浮点漂移）。
 */
import type { EditTimeline } from '../../pipeline/actions/ffmpeg-merge/timeline-snapshot'
import type { FormatCtx } from './render-context'
import { secToFrames } from './timecode'
import { readSubtitleCues } from './subtitle-cues'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 秒 → rational seconds（`帧/fps s`） */
function tr(sec: number, fps: number): string {
  return `${secToFrames(sec, fps)}/${fps}s`
}

interface AssetReg {
  id: string
  relPath: string
  hasVideo: boolean
  hasAudio: boolean
  durSec: number
  name: string
}

/** relPath 去重登记资源池；返回 relPath → assetId 映射 */
function buildAssets(tl: EditTimeline): { list: AssetReg[]; byRel: Map<string, string> } {
  const list: AssetReg[] = []
  const byRel = new Map<string, string>()
  const add = (relPath: string | null, kind: 'video' | 'image' | 'audio', durSec: number, name: string): string | null => {
    if (!relPath) return null
    const existed = byRel.get(relPath)
    if (existed) return existed
    const id = `r${list.length + 2}` // r1 留给 format
    byRel.set(relPath, id)
    list.push({ id, relPath, hasVideo: kind !== 'audio', hasAudio: kind === 'audio', durSec, name })
    return id
  }
  for (const s of tl.segments) add(s.relPath, s.kind, s.durSec, s.shotId ?? `shot-${s.assetId}`)
  for (const l of tl.lines) if (l.relPath) add(l.relPath, 'audio', l.durSec ?? 0, l.lineId)
  if (tl.bgm) add(tl.bgm.relPath, 'audio', tl.totalSec, 'BGM')
  for (const s of tl.sfx) if (s.relPath) add(s.relPath, 'audio', 0, s.shotId ?? `sfx-${s.assetId ?? ''}`)
  return { list, byRel }
}

export function toFcpxml(tl: EditTimeline, ctx: FormatCtx): string {
  const fps = tl.fps
  const intro = tl.introSec
  const { list, byRel } = buildAssets(tl)
  const formatId = 'r1'

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<!DOCTYPE fcpxml>')
  lines.push('<fcpxml version="1.10">')
  // resources
  lines.push('  <resources>')
  lines.push(`    <format id="${formatId}" frameDuration="1/${Math.round(fps)}s" width="${tl.width}" height="${tl.height}"/>`)
  for (const a of list) {
    const src = `file://${encodeURI(ctx.nameOf(a.relPath))}`
    const audio = a.hasAudio ? ' hasAudio="1" audioSources="1" audioChannels="2"' : ''
    const video = a.hasVideo ? ' hasVideo="1"' : ''
    lines.push(`    <asset id="${a.id}" name="${esc(a.name)}" src="${src}" start="0s" duration="${tr(a.durSec, fps)}"${video}${audio} format="${formatId}"/>`)
  }
  // 字幕 generator + 文本样式（逐句 <title> 引用）
  lines.push('    <effect id="rTitle" name="Basic Title" uid=".../Titles.localized/Basic Title.localized/Basic Title.moti" version="1.0.0" title="Basic Title"/>')
  if (tl.transition) lines.push('    <effect id="rDissolve" name="Cross Dissolve" uid=".../Transitions.localized/Cross Dissolve.localized/Cross Dissolve.moti" version="1.0.0" title="Cross Dissolve"/>')
  lines.push('    <style id="ts1"/>')
  lines.push('  </resources>')
  // library
  lines.push('  <library>')
  lines.push('    <event>')
  lines.push(`      <project name="${esc(ctx.title)}">`)
  lines.push(`        <sequence duration="${tr(tl.totalSec, fps)}" format="${formatId}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`)
  lines.push('          <spines>')

  // V1 镜头序（转场启用时段间 transition）
  lines.push('            <spine>')
  for (let i = 0; i < tl.segments.length; i++) {
    const s = tl.segments[i]!
    const ref = byRel.get(s.relPath ?? '') ?? formatId
    lines.push(`              <asset-clip ref="${ref}" offset="${tr(intro + s.startSec, fps)}" duration="${tr(s.durSec, fps)}" format="${formatId}" name="${esc(s.shotId ?? `shot-${s.assetId}`)}" start="0s"/>`)
    if (tl.transition && i < tl.segments.length - 1) {
      const cutSec = intro + s.startSec + s.durSec
      lines.push(`              <transition name="cross dissolve" offset="${tr(cutSec, fps)}" duration="${tr(tl.transition.durSec, fps)}"/>`)
    }
  }
  lines.push('            </spine>')

  // 对白旁白轨
  const dlg = tl.lines.filter((l) => l.relPath)
  if (dlg.length > 0) {
    lines.push('            <spine role="dialogue">')
    for (const l of dlg) {
      const ref = byRel.get(l.relPath!) ?? formatId
      lines.push(`              <asset-clip ref="${ref}" offset="${tr(intro + l.timelineStart, fps)}" duration="${tr(l.durSec ?? 0, fps)}" format="${formatId}" name="${esc(l.lineId)}" start="0s"/>`)
    }
    lines.push('            </spine>')
  }

  // BGM 轨
  if (tl.bgm) {
    const ref = byRel.get(tl.bgm.relPath) ?? formatId
    lines.push('            <spine role="music">')
    lines.push(`              <asset-clip ref="${ref}" offset="0s" duration="${tr(tl.totalSec, fps)}" format="${formatId}" name="BGM" start="0s"/>`)
    lines.push('            </spine>')
  }

  // SFX 轨
  if (tl.sfx.length > 0) {
    lines.push('            <spine role="sfx">')
    for (const s of tl.sfx) {
      if (!s.relPath) continue
      const ref = byRel.get(s.relPath) ?? formatId
      lines.push(`              <asset-clip ref="${ref}" offset="${tr(s.startSec, fps)}" duration="${tr(0, fps)}" format="${formatId}" name="${esc(s.shotId ?? 'sfx')}" start="0s"/>`)
    }
    lines.push('            </spine>')
  }

  // 字幕 title 轨（逐句挂 generator；cues 为 final 绝对轴，不再叠加 intro 位移）
  const subRead = readSubtitleCues(tl)
  if (subRead.cues.length > 0) {
    lines.push('            <spine>')
    for (const cue of subRead.cues) {
      lines.push(`              <title ref="rTitle" style="ts1" offset="${tr(cue.startSec, fps)}" duration="${tr(cue.durSec, fps)}" name="${esc(cue.id)}">`)
      lines.push(`                <text><text-style ref="ts1">${esc(cue.text)}</text-style></text>`)
      lines.push('              </title>')
    }
    lines.push('            </spine>')
  }

  lines.push('          </spines>')
  lines.push('        </sequence>')
  lines.push('      </project>')
  lines.push('    </event>')
  lines.push('  </library>')
  lines.push('</fcpxml>')
  return lines.join('\n') + '\n'
}
