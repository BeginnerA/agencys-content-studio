import { spawnSync } from 'node:child_process'
import { normalizeDialogueText, parseTimestampedTranscript, type TimestampedTranscript } from '@agencys/ai-provider-kit'
import { probeMediaDuration, resolveFfmpeg, resolveFfprobe } from '../ffmpeg'
import { compileDialogueShot } from './dialogue'
import type { CreationPlan } from './contract'

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
  const stamp = (ms: number): string => `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
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
