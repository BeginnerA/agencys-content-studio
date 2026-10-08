/**
 * OTIO JSON 格式化器（Resolve / 程序化管线）——纯函数，探针可直测。
 * 五轨固定：Video（V1 镜头序）/ Dialogue Audio（逐句配音）/ Music（BGM）/ Effects（SFX）/ Markdown（字幕）。
 * 坐标：segments/lines 为内容轴 → +introSec 落绝对轴；sfx.startSec 已绝对轴；
 *   字幕轨（precision-rework §8）取自有效字幕快照 cues（final 绝对轴，人工修订已体现），
 *   不再拿 lines 文本/时码覆盖；Dialogue Audio 轨仍只读 lines。旧快照无 cues 时兜底（见 subtitle-cues.ts）。
 * 时间值统一 RationalTime（rate=fps，value=帧），轨道内用 Gap 对齐留白。
 * 媒体引用：ExternalReference.target_url = nameOf(relPath)（打包期注入包内路径，缺省用文件名）。
 */
import type { EditTimeline } from '../../pipeline/actions/ffmpeg-merge/timeline-snapshot'
import type { FormatCtx } from './render-context'
import { secToFrames } from './timecode'
import { readSubtitleCues } from './subtitle-cues'

export type { FormatCtx } from './render-context'

const SCHEMA = (t: string) => `Opentimelineio.${t}.1`

function rt(sec: number, fps: number): Record<string, unknown> {
  return { OTIO_SCHEMA: SCHEMA('RationalTime'), rate: fps, value: secToFrames(sec, fps) }
}

function timeRange(startSec: number, durSec: number, fps: number): Record<string, unknown> {
  return {
    OTIO_SCHEMA: SCHEMA('TimeRange'),
    start_time: rt(startSec, fps),
    duration: rt(Math.max(0, durSec), fps),
  }
}

function clip(name: string, relPath: string | null, startSec: number, durSec: number, fps: number, ctx: FormatCtx, extra?: Record<string, unknown>): Record<string, unknown> {
  const mediaRef = relPath
    ? { OTIO_SCHEMA: SCHEMA('ExternalReference'), target_url: ctx.nameOf(relPath) }
    : { OTIO_SCHEMA: SCHEMA('MissingReference') }
  return {
    OTIO_SCHEMA: SCHEMA('Clip'),
    name,
    media_reference: mediaRef,
    source_range: timeRange(startSec, durSec, fps),
    metadata: { relative_start: rt(startSec, fps), ...(extra ?? {}) },
    effects: [],
    markers: [],
  }
}

function gap(durSec: number, fps: number): Record<string, unknown> {
  return { OTIO_SCHEMA: SCHEMA('Gap'), name: 'Gap', source_range: rt(Math.max(0, durSec), fps), metadata: {} }
}

/** 有序条目（含 start/dur）→ 子元素序列（按绝对起点插 Gap 留白） */
function layout(items: Array<{ start: number; dur: number; node: Record<string, unknown> }>, fps: number): Record<string, unknown>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start)
  const children: Record<string, unknown>[] = []
  let cursor = 0
  for (const it of sorted) {
    if (it.start > cursor + 1e-6) children.push(gap(it.start - cursor, fps))
    children.push(it.node)
    cursor = Math.max(cursor, it.start + it.dur)
  }
  return children
}

function track(name: string, kind: 'Video' | 'Audio' | 'Markdown', children: Record<string, unknown>[], fps: number): Record<string, unknown> {
  return {
    OTIO_SCHEMA: SCHEMA('Track'),
    name,
    kind,
    children,
    source_range: null,
    metadata: {},
    transition_items: [{ name: 'in', duration: rt(0, fps), transition_active_range: null, in_offset: rt(0, fps), out_offset: rt(0, fps) }],
  }
}

export function toOtio(tl: EditTimeline, ctx: FormatCtx): Record<string, unknown> {
  const fps = tl.fps
  const intro = tl.introSec

  const videoItems = tl.segments.map((s) => ({
    start: intro + s.startSec,
    dur: s.durSec,
    node: clip(s.shotId ?? `shot-${s.assetId}`, s.relPath, intro + s.startSec, s.durSec, fps, ctx, { asset_id: s.assetId, kind: s.kind }),
  }))

  const dialogueItems = tl.lines
    .filter((l) => l.relPath)
    .map((l) => ({
      start: intro + l.timelineStart,
      dur: l.durSec ?? 0,
      node: clip(l.lineId, l.relPath, intro + l.timelineStart, l.durSec ?? 0, fps, ctx, { line_id: l.lineId, asset_id: l.assetId }),
    }))

  const musicItems = tl.bgm
    ? [{
        start: 0,
        dur: tl.totalSec,
        node: clip('BGM', tl.bgm.relPath, 0, tl.totalSec, fps, ctx, { volume: tl.bgm.volume, fade_sec: tl.bgm.fadeSec }),
      }]
    : []

  const effectItems = tl.sfx
    .filter((s) => s.relPath)
    .map((s) => ({
      start: s.startSec, // 已绝对轴
      dur: 0, // 逐条时长快照未存 → 0 长占位（引用真实文件，NLE 内可读取实际长）
      node: clip(s.shotId ?? `sfx-${s.assetId ?? ''}`, s.relPath, s.startSec, 0, fps, ctx, { asset_id: s.assetId }),
    }))

  // 字幕轨：cues 为 final 绝对轴（不再叠加 intro 位移）；兜底路已在 readSubtitleCues 内完成 +intro
  const subRead = readSubtitleCues(tl)
  const subtitleItems = subRead.cues.map((cue) => ({
    start: cue.startSec,
    dur: cue.durSec,
    node: clip(cue.id, null, cue.startSec, cue.durSec, fps, ctx, { text: cue.text, subtitle_source: subRead.source, subtitle_origin: subRead.origin }),
  }))

  return {
    OTIO_SCHEMA: SCHEMA('Timeline'),
    name: ctx.title,
    source_range: timeRange(0, tl.totalSec, fps),
    metadata: {
      generated_by: 'agencys-content-studio/edit-exchange',
      fps: tl.fps,
      width: tl.width,
      height: tl.height,
      total_sec: tl.totalSec,
      intro_sec: tl.introSec,
      outro_sec: tl.outroSec,
      transition: tl.transition,
      watermark: tl.watermark,
      subtitle_ref: tl.subtitle ? ctx.nameOf(tl.subtitle.relPath) : null,
      subtitle_source: subRead.source,
      subtitle_origin: subRead.origin,
    },
    tracks: {
      OTIO_SCHEMA: SCHEMA('Stack'),
      name: 'tracks',
      children: [
        track('Video', 'Video', layout(videoItems, fps), fps),
        track('Dialogue Audio', 'Audio', layout(dialogueItems, fps), fps),
        track('Music', 'Audio', layout(musicItems, fps), fps),
        track('Effects', 'Audio', layout(effectItems, fps), fps),
        track('Markdown', 'Markdown', layout(subtitleItems, fps), fps),
      ],
      source_range: null,
      metadata: {},
    },
  }
}

/** OTIO 文件序列化为字符串（缩进稳定，供 zip entry 写入） */
export function renderOtio(tl: EditTimeline, ctx: FormatCtx): string {
  return JSON.stringify(toOtio(tl, ctx), null, 2)
}
