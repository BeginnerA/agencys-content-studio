import { spawnSync } from 'node:child_process'
import { normalizeDialogueText, parseTimestampedTranscript, type TimestampedTranscript } from '@agencys/ai-provider-kit'
import { probeMediaDuration, resolveFfmpeg, resolveFfprobe } from '../ffmpeg'
import { absPathOf } from '../storage'
import { compileDialogueShot } from './dialogue'
import { hashJson, type CreationPlan } from './contract'

export interface DialogueTiming {
  videoStart: number
  audioStart: number
  videoDuration: number
  audioDuration: number
}

/** 起点均为容器时间轴；未知起点/时长拒绝，不以计划时长冒充实测。 */
export function inspectDialogueMedia(path: string): DialogueTiming {
  const ffprobe = resolveFfprobe(), ffmpeg = resolveFfmpeg()
  if (!ffprobe || !ffmpeg) throw new Error('人物对白需要 FFmpeg 和 ffprobe')
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time,duration', '-of', 'json', path], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  if (result.status !== 0) throw new Error('原生对白视频不可读取')
  const streams = (JSON.parse(result.stdout) as { streams?: Array<Record<string, unknown>> }).streams ?? []
  const video = streams.find((s) => s.codec_type === 'video'), audio = streams.find((s) => s.codec_type === 'audio')
  if (!video || !audio) throw new Error('原生对白视频缺少视频或原声音轨；禁止替换为 TTS')
  const numeric = (value: unknown): number => typeof value === 'string' && value.trim() ? Number(value) : NaN
  const timing = { videoStart: numeric(video.start_time), audioStart: numeric(audio.start_time), videoDuration: numeric(video.duration), audioDuration: numeric(audio.duration) }
  if (Object.values(timing).some((v) => !Number.isFinite(v)) || timing.videoDuration <= 0 || timing.audioDuration <= 0) throw new Error('原声音视频流起点或时长不可核验')
  const decoded = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
  if (decoded.status !== 0) throw new Error('原声音视频解码失败，已保留原文件')
  return timing
}

/** 抽取音频独立归零供 ASR；原起点差仍保存在 timing 中供字幕与合成共用。 */
export function extractDialogueAudio(video: string, output: string): DialogueTiming {
  const timing = inspectDialogueMedia(video)
  const ffmpeg = resolveFfmpeg()!
  const extracted = spawnSync(ffmpeg, ['-n', '-v', 'error', '-xerror', '-i', video, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
  if (extracted.status !== 0) throw new Error('原声音轨抽取失败，未提交 ASR')
  const audioDuration = probeMediaDuration(output)
  if (!audioDuration || !Number.isFinite(audioDuration)) throw new Error('抽取音轨时长不可核验')
  const volume = spawnSync(ffmpeg, ['-hide_banner', '-i', output, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
  const maximum = /max_volume:\s*(-?[\d.]+) dB/.exec(volume.stderr)?.[1]
  if (volume.status !== 0 || maximum === undefined || !Number.isFinite(Number(maximum)) || Number(maximum) < -60) throw new Error('原声音轨为空或静音，未提交 ASR')
  return { ...timing, audioDuration }
}

export function validateDialogueTranscript(plan: CreationPlan, shotId: string, raw: unknown, timing: DialogueTiming): TimestampedTranscript {
  const compiled = compileDialogueShot(plan, shotId)
  const shot = plan.shots.find((s) => s.id === shotId)!
  if (Object.values(timing).some((v) => !Number.isFinite(v)) || timing.videoDuration + 0.001 < shot.duration) throw new Error(`镜头 ${shotId} 原视频不足批准镜长，禁止循环或变速补齐`)
  const transcript = parseTimestampedTranscript(raw, timing.audioDuration)
  if (normalizeDialogueText(transcript.text) !== normalizeDialogueText(compiled.text)) throw new Error(`镜头 ${shotId} 实际原声与批准台词不符`)
  const offset = timing.audioStart - timing.videoStart
  if (transcript.segments.some((s) => s.start + offset < 0 || s.end + offset > Math.min(shot.duration, timing.videoDuration))) {
    throw new Error(`镜头 ${shotId} 实际对白超出可播放或批准区间，禁止截断`)
  }
  return transcript
}

export function dialogueSrt(shots: Array<{ shotId: string; duration: number; timing: DialogueTiming; transcript: TimestampedTranscript }>): string {
  let offset = 0, index = 0, previousEnd = 0
  const blocks: string[] = []
  const stamp = srtStamp
  for (const shot of shots) {
    const shift = offset + shot.timing.audioStart - shot.timing.videoStart
    for (const seg of shot.transcript.segments) {
      const start = Math.round((shift + seg.start) * 1000), end = Math.round((shift + seg.end) * 1000)
      if (start < previousEnd || end <= start || end > Math.round((offset + shot.duration) * 1000)) throw new Error(`镜头 ${shot.shotId} 字幕无法保持合法毫秒时间戳`)
      const text = seg.text.replace(/\s+/g, ' ').replace(/</g, '＜').replace(/>/g, '＞')
      blocks.push(`${++index}\n${stamp(start)} --> ${stamp(end)}\n${text}`)
      previousEnd = end
    }
    offset += shot.duration
  }
  if (!blocks.length) throw new Error('没有实际对白字幕，禁止交付')
  return blocks.join('\n\n') + '\n'
}

function srtStamp(ms: number): string {
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}

/** 单镜估算窗口 = [起播余量, min(批准镜长, 实测视频时长))；纯本地确定性计算，零网络零计费。 */
export const ESTIMATED_DIALOGUE_POLICY = 'estimated-lines-v1'
const ESTIMATED_HEAD_LEAD = 0.3

/**
 * [M47] 免核验对白估算字幕（路 B）：逐镜在窗口内按批准台词归一字数占比分配区间，
 * 句间连续单调；与实测 dialogueSrt 的本质区别是「口头承诺」——不核验模型真实说了什么，
 * 台词与声音是否一致由强制人工审阅闸把关（诚实红线：调用方须在资产 params 如实标注 estimated）。
 */
export function estimatedDialogueSrt(plan: CreationPlan, clips: Array<{ shotId: string; duration: number; videoDuration: number }>): string {
  if (plan.performance !== 'dialogue') throw new Error('估算字幕仅适用人物对白方案')
  let offset = 0, index = 0
  const blocks: string[] = []
  for (const clip of clips) {
    const shot = plan.shots.find((s) => s.id === clip.shotId)
    if (!shot) throw new Error(`镜头 ${clip.shotId} 不在批准分镜内`)
    const window = Math.min(clip.duration, clip.videoDuration)
    if (!Number.isFinite(window) || window - ESTIMATED_HEAD_LEAD < 0.2) throw new Error(`镜头 ${clip.shotId} 可播放窗口不足以容纳估算字幕`)
    const lines = plan.lines.filter((l) => shot.lines.includes(l.id))
    if (!lines.length) throw new Error(`镜头 ${clip.shotId} 没有台词，无法生成对白字幕`)
    const weights = lines.map((l) => [...normalizeDialogueText(l.text)].length)
    if (weights.some((w) => w === 0)) throw new Error(`镜头 ${clip.shotId} 存在归一后空台词，拒绝估算`)
    const total = weights.reduce((a, b) => a + b, 0)
    const usable = window - ESTIMATED_HEAD_LEAD
    let cursor = 0
    for (let i = 0; i < lines.length; i++) {
      const start = Math.round((offset + ESTIMATED_HEAD_LEAD + (cursor / total) * usable) * 1000)
      cursor += weights[i]!
      const end = Math.round((offset + ESTIMATED_HEAD_LEAD + (cursor / total) * usable) * 1000)
      if (end <= start || end > Math.round((offset + clip.duration) * 1000)) throw new Error(`镜头 ${clip.shotId} 估算字幕时间戳越界，拒绝交付`)
      const text = lines[i]!.text.replace(/\s+/g, ' ').replace(/</g, '＜').replace(/>/g, '＞')
      blocks.push(`${++index}\n${srtStamp(start)} --> ${srtStamp(end)}\n${text}`)
    }
    offset += clip.duration
  }
  if (!blocks.length) throw new Error('没有估算对白字幕，禁止交付')
  return blocks.join('\n\n') + '\n'
}

/** [M47] 估算镜 clips 形态：timing 供合成原声混流与出口守卫，字幕与哈希只消费 {shotId, duration, videoDuration}。 */
export interface EstimatedDialogueClip { shotId: string; duration: number; videoDuration: number; timing: DialogueTiming }

/** 估算路线的来源校验（与 strict dialogueSource 同源语义）：视频必须属于当前批准角色与台词（dialogueHash 一致）。 */
export function assertEstimatedClipSource(plan: CreationPlan, shotId: string, asset: { kind: string; relPath: string | null; params: string | null }): void {
  if (plan.performance !== 'dialogue') throw new Error('估算对白仅适用人物对白方案')
  if (asset.kind !== 'video' || !asset.relPath) throw new Error(`镜头 ${shotId} 原声视频不可用`)
  const compiled = compileDialogueShot(plan, shotId)
  const params = JSON.parse(asset.params ?? '{}')
  if (params.shotId !== shotId || params.dialogueHash !== compiled.dialogueHash) throw new Error(`镜头 ${shotId} 视频不属于当前批准角色和台词`)
}

/** 合成步同源重算入口：来源校验 + 实测视频（含原声轨存在与可解码守卫，零付费）。 */
export function estimateDialogueClip(plan: CreationPlan, shotId: string, asset: { kind: string; relPath: string | null; params: string | null; projectId: number }, projectId: number): EstimatedDialogueClip {
  if (asset.projectId !== projectId) throw new Error(`镜头 ${shotId} 视频不属于本项目`)
  assertEstimatedClipSource(plan, shotId, asset)
  const timing = inspectDialogueMedia(absPathOf(asset.relPath!))
  return { shotId, duration: plan.shots.find((s) => s.id === shotId)!.duration, videoDuration: timing.videoDuration, timing }
}

/** 字幕步与合成步共用同一函数计哈希，保证两侧同源可比对。 */
export function estimatedValidationHash(clips: EstimatedDialogueClip[]): string {
  return hashJson({ policy: ESTIMATED_DIALOGUE_POLICY, clips: clips.map((c) => ({ shotId: c.shotId, duration: c.duration, videoDuration: c.videoDuration })) })
}
