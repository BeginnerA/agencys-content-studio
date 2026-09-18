import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Asset } from '../../../db/schema'
import { probeMediaDuration, resolveFfmpeg, resolveFfprobe } from '../../../services/ffmpeg'
import { absPathOf } from '../../../services/storage'
import { planVoiceAlignedSegments, type AlignPlan } from './align'
import { shotIdOfAsset, lineIdOfVoiceAsset, type Segment } from './segments'
import type { CreationPlan } from '../../../services/creation-chat/contract'

/** 严格路径不信任资产缓存的时长，读取真实流并验证可解码。 */
export function assertDecodable(path: string, stream: 'audio' | 'video'): number {
  const ffprobe = resolveFfprobe()
  const ffmpeg = resolveFfmpeg()
  if (!ffprobe || !ffmpeg) throw new Error('严格交付需要可用 ffmpeg 和 ffprobe')
  const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', path], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  if (probe.status !== 0) throw new Error('媒体不可读取或已损坏')
  const streams = (JSON.parse(probe.stdout) as { streams?: { codec_type?: string }[] }).streams ?? []
  if (!streams.some((s) => s.codec_type === stream)) throw new Error(`媒体缺少 ${stream} 流`)
  const decoded = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', path, '-map', stream === 'video' ? '0:v:0' : '0:a:0', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000, windowsHide: true })
  if (decoded.status !== 0) throw new Error('媒体解码失败，不能交付')
  return probeMediaDuration(path) ?? 0
}

export function strictVoicePlan(plan: CreationPlan, voices: Asset[], projectId: number): AlignPlan {
  if (voices.length !== plan.lines.length) throw new Error('配音不完整，禁止生成镜头')
  const durations = new Map<string, number>()
  for (let i = 0; i < voices.length; i++) {
    const a = voices[i]!
    const id = lineIdOfVoiceAsset(a)
    if (!id || id !== plan.lines[i]!.id || durations.has(id) || a.kind !== 'audio' || !a.relPath || a.deletedAt !== null || a.projectId !== projectId) throw new Error('配音台词映射或项目归属错误')
    const duration = assertDecodable(absPathOf(a.relPath), 'audio')
    if (duration <= 0) throw new Error('配音时长不可核验')
    durations.set(id, duration)
  }
  const aligned = planVoiceAlignedSegments(plan.shots.map((s) => ({ id: s.id, durationSec: s.duration, lineIds: s.lines })), durations, 5, { hasLinesField: true })
  if (!aligned.aligned || aligned.warnShots?.length) throw new Error(`旁白放不下已批准镜长，请修改方案：${aligned.warnShots?.join('、') ?? aligned.reason}`)
  return aligned
}

export function strictSegments(plan: CreationPlan, rows: Asset[], projectId: number): Segment[] {
  if (rows.length !== plan.shots.length || new Set(rows.map((a) => a.id)).size !== rows.length) throw new Error('缺镜或重复镜头，禁止交付')
  return plan.shots.map((shot, i) => {
    const a = rows[i]!
    const kind = plan.mode === 'dynamic' ? 'video' : 'image'
    if (a.projectId !== projectId || a.deletedAt !== null || a.kind !== kind || !a.relPath || shotIdOfAsset(a) !== shot.id) throw new Error('镜头顺序、类型或归属与批准方案不符')
    const path = absPathOf(a.relPath)
    const duration = assertDecodable(path, 'video')
    if (kind === 'video' && (duration <= 0 || shot.duration - duration > 0.5 + 0.001)) throw new Error(`镜头 ${shot.id} 时长不足，最多允许 0.5 秒尾帧补齐`)
    return { id: a.id, path, kind, durSec: shot.duration, explicit: true }
  })
}

/** 验证字幕包含完整台词且严格落在各句真实音轨区间，支持一句拆为多个 cue。 */
export function assertStrictSrt(path: string, plan: CreationPlan, aligned: AlignPlan, voices: Asset[]): void {
  const blocks = readFileSync(path, 'utf8').trim().split(/\r?\n\r?\n/)
  const joined = new Map<string, string>()
  let prev = 0
  const durations = voices.map((a) => probeMediaDuration(absPathOf(a.relPath!))!)
  for (const block of blocks) {
    const rows = block.split(/\r?\n/)
    const match = /^(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)$/.exec(rows[1] ?? '')
    if (!match) throw new Error('字幕格式非法')
    const sec = (offset: number) => +match[offset]! * 3600 + +match[offset + 1]! * 60 + +match[offset + 2]! + +match[offset + 3]! / 1000
    const start = sec(1), end = sec(5)
    const lineIndex = aligned.lines.findIndex((l, i) => start >= l.timelineStart - 0.002 && end <= l.timelineStart + durations[i]! + 0.002)
    if (lineIndex < 0 || start < prev - 0.002 || end <= start || end > plan.duration + 0.002) throw new Error('字幕越界或未对齐旁白')
    const id = aligned.lines[lineIndex]!.lineId
    joined.set(id, (joined.get(id) ?? '') + rows.slice(2).join(''))
    prev = end
  }
  const compact = (s: string) => s.replace(/\s/g, '')
  if (plan.lines.some((l) => compact(joined.get(l.id) ?? '') !== compact(l.text))) throw new Error('字幕台词不完整或被篡改')
}

export function assertStrictOutput(path: string, duration: number): void {
  const actual = assertDecodable(path, 'video')
  const audio = assertDecodable(path, 'audio')
  if (Math.abs(actual - duration) > 0.15 || audio <= 0) throw new Error('成片时长或音轨检查失败，不能报告完成')
}
