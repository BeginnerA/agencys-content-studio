/**
 * 第四期 · 统一 QC 面板：本地媒体测量层（规格 2026-09-28 §4/§5）。
 *
 * 全部为**本地只读测量**：ffprobe 取容器/流/分辨率/帧率/实测时长，ffmpeg ebur128 取真峰值与积分响度。
 * 零模型、零付费、零写入、不 import 引擎。工具缺失或超时 → 返回 null（宽容，不判 failed），
 * 与 `image-check.ts` 的 `ffmpeg_unavailable → ok=null` 保守策略一致。时长/尺寸复用既有 `services/ffmpeg.ts`。
 */
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolveFfmpeg, resolveFfprobe } from '../ffmpeg'

/** ffprobe 一次读取的成片物理规格（第一期 §7.2 媒体基线字段口径）。 */
export interface MediaSpec {
  /** 容器名（ffprobe format.format_name，如 mp4） */
  container: string | null
  hasVideo: boolean
  hasAudio: boolean
  width: number | null
  height: number | null
  /** 帧率（avg_frame_rate 分数解析；无法解析 → null） */
  fps: number | null
  /** format.duration（秒）；无法解析 → null */
  durationSec: number | null
}

/** ffmpeg ebur128 客观响度测量（不判失真，仅记录数值；Q2 已锁）。 */
export interface LoudnessMeasure {
  /** 真峰值 dBTP（ebur128 summary Peak） */
  peakDbtp: number | null
  /** 积分响度 LUFS（ebur128 summary I） */
  integratedLufs: number | null
}

/** 文件是否存在且为常规文件（缺失 → false，供 file_readable 判 failed）。 */
export function fileExists(absPath: string): boolean {
  try {
    return statSync(absPath).isFile()
  } catch {
    return false
  }
}

function parseRate(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const [num, den] = raw.split('/')
  const n = Number(num)
  const d = Number(den ?? 1)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null
  return n > 0 ? n / d : null
}

/**
 * ffprobe JSON 一次取成片规格。ffprobe 缺失/失败/非法 JSON → null（宽容）。
 */
export function probeMediaSpec(absPath: string): MediaSpec | null {
  const ffprobe = resolveFfprobe()
  if (!ffprobe) return null
  const r = spawnSync(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  )
  if (r.error || r.status !== 0) return null
  let json: unknown
  try {
    json = JSON.parse(String(r.stdout ?? ''))
  } catch {
    return null
  }
  const root = json as { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> }
  const streams = Array.isArray(root.streams) ? root.streams : []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  const fmtDuration = Number(root.format?.duration)
  const w = typeof video?.width === 'number' ? video.width : null
  const h = typeof video?.height === 'number' ? video.height : null
  return {
    container: typeof root.format?.format_name === 'string' ? root.format.format_name : null,
    hasVideo: !!video,
    hasAudio: !!audio,
    width: w !== null && w > 0 ? w : null,
    height: h !== null && h > 0 ? h : null,
    fps: parseRate(video?.avg_frame_rate ?? video?.r_frame_rate),
    durationSec: Number.isFinite(fmtDuration) && fmtDuration > 0 ? fmtDuration : null,
  }
}

/**
 * ffmpeg ebur128 客观响度测量（真峰值 dBTP + 积分响度 LUFS）。
 * ffmpeg 缺失/超时/解析不到 summary → 对应值 null（宽容；不据此判失真/削波）。
 */
export function measureLoudness(absPath: string): LoudnessMeasure {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) return { peakDbtp: null, integratedLufs: null }
  const r = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostats', '-i', absPath, '-filter_complex', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  )
  if (r.error || r.status !== 0) return { peakDbtp: null, integratedLufs: null }
  const text = `${String(r.stdout ?? '')}\n${String(r.stderr ?? '')}`
  // Summary 段： "I:  -xx.x LUFS" 与 "Peak:  -xx.x dBTP"（取最后一次即 Summary 汇总值）
  const integrated = matchLastNumber(text, /I:\s*(-?[\d.]+)\s*LUFS/)
  const peak = matchLastNumber(text, /Peak:\s*(-?[\d.]+)\s*dBTP/)
  return { integratedLufs: integrated, peakDbtp: peak }
}

function matchLastNumber(text: string, re: RegExp): number | null {
  let last: number | null = null
  const g = new RegExp(re.source, 'g')
  let m: RegExpExecArray | null
  while ((m = g.exec(text)) !== null) {
    const n = Number(m[1])
    if (Number.isFinite(n)) last = n
  }
  // ebur128 对纯静音返回 -inf/-70 边界，仍原样保留（不填充 0）
  return last
}
