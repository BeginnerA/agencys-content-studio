/**
 * 混剪态（M53 photo-montage）：两段式合成的 phase-1 与触发判定。
 * - 触发（montageEnabled 纯函数）：params.montage=true / 镜头序列混排（图+视并存）/
 *   keep_clip_audio=true / ken_burns≠none；strict_delivery 下恒 false（批准链逐字节红线）。
 * - phase-1（normalizeSegmentsToClips）：逐段归一化为「定长 + 同尺寸/fps + 必带音轨」的临时 mp4——
 *   图片段 zoompan（Ken Burns，单帧产出 d=fps×dur）或定长静帧 + anullsrc 静音轨；
 *   视频段 trim/tpad 精确截长 + 原声（缺 a 流探测后 anullsrc 兜底）。
 * - phase-2 由 buildComposeArgs({ montage: true }) 消费：段全部按 -i 直读 + 轻滤镜，
 *   per-seg [i:a] 拼为连续现场轨参与既有 BGM/SFX 混音收口。
 * 零 diff 红线：未触发混剪 → index 不进本模块，legacy 单段链逐字节不变。
 */
import { spawnSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { resolveFfprobe } from '../../../services/ffmpeg'
import { round3 } from './util'
import type { Segment } from './segments'
import type { StepContext } from '../../context'

export type KenBurns = 'none' | 'in' | 'out' | 'alternate'

/** 混剪触发判定（纯函数；探针直测真值表） */
export function montageEnabled(params: Record<string, unknown>, opts: { hasMixed: boolean; hasVideoSeg: boolean; strict: boolean }): boolean {
  if (opts.strict) return false
  if (params['montage'] === false) return false
  if (params['montage'] === true) return true
  if (opts.hasMixed) return true
  if (params['keep_clip_audio'] === true && opts.hasVideoSeg) return true
  const kb = typeof params['ken_burns'] === 'string' && params['ken_burns'] ? params['ken_burns'] : 'none'
  return kb !== 'none'
}

/** 输入文件是否含音频流；ffprobe 不可用/探测失败 → null（调用方按有 a 流宽容，trim/apad 兜底） */
export function probeHasAudioStream(file: string): boolean | null {
  const ffprobe = resolveFfprobe()
  if (!ffprobe) return null
  try {
    const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    if (r.error || r.status !== 0) return null
    return String(r.stdout ?? '').trim().length > 0
  } catch {
    return null
  }
}

/** Ken Burns 方向（alternate：偶数镜推近、奇数镜拉远；下标从 0 计） */
export function kbDirectionFor(mode: KenBurns, index: number): 'in' | 'out' | null {
  if (mode === 'in' || mode === 'out') return mode
  if (mode === 'alternate') return index % 2 === 0 ? 'in' : 'out'
  return null
}

/** 归一化目标尺寸与图段超采样底尺寸（×2 冗余抑制 zoompan 亚像素抖动） */
export function normalizeSizes(width: number, height: number): { ssW: number; ssH: number } {
  return { ssW: width * 2, ssH: height * 2 }
}

/** phase-1 单段归一 args（纯函数；探针直测 filter 形状）：产物定长 dur + 同尺寸/fps + 必带音轨 */
export function buildNormalizeArgs(seg: Segment, opts: {
  width: number
  height: number
  fps: number
  kb: 'in' | 'out' | null
  clipHasAudio: boolean | null
  outAbs: string
}): string[] {
  const { width, height, fps, kb } = opts
  const dur = round3(seg.durSec)
  const frames = Math.max(1, Math.round(fps * dur))
  // 几何：居中裁切满幅（与 phase-2 legacy 图链同口径 force_original_aspect_ratio=increase + crop）
  const geometry = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
  const aTail = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo'
  const encTail = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '160k',
    '-t', String(dur), '-movflags', '+faststart', opts.outAbs]

  if (seg.kind === 'image') {
    // 单帧产出：不 -loop；kb 分支 zoompan d=帧数一次出满段；定帧分支 -frames:v 1 出单帧
    //（两相均物化为视频段入 phase-2；phase-2 montage 对超短段用 tpad clone 撑回 dur，见 args.ts）
    const vChain = kb
      ? (() => {
          const { ssW, ssH } = normalizeSizes(width, height)
          const step = round3(0.25 / frames)
          const z = kb === 'in' ? `min(1+${step}*on,1.25)` : `max(1.25-${step}*on,1)`
          return `scale=${ssW}:${ssH}:force_original_aspect_ratio=increase,crop=${ssW}:${ssH},`
            + `zoompan=z='${z}':d=${frames}:x='iw-iw/zoom':y='ih-ih/zoom':s=${width}x${height},`
            + `crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p`
        })()
      : `${geometry},setsar=1,fps=${fps},format=yuv420p`
    return [
      '-y', '-i', seg.path,
      '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${dur}`,
      '-filter_complex',
      `[0:v]${vChain}[v];[1:a]${aTail},atrim=duration=${dur}[a]`,
      '-map', '[v]', '-map', '[a]',
      ...(kb ? [] : ['-frames:v', '1']),
      ...encTail,
    ]
  }

  // 视频段：短于目标长 → tpad 末帧克隆/apad 补静音后定长截断；长于目标长 → trim 裁短
  const vChain = `setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${dur},`
    + `trim=duration=${dur},setpts=PTS-STARTPTS,${geometry},setsar=1,fps=${fps},format=yuv420p`
  if (opts.clipHasAudio === false) {
    // 探测确认无音频流 → lavfi 静音轨兜底（保证每段必有 a 流，phase-2 concat 才能 v=1:a=1）
    return [
      '-y', '-i', seg.path,
      '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${dur}`,
      '-filter_complex',
      `[0:v]${vChain}[v];[1:a]${aTail},atrim=duration=${dur}[a]`,
      '-map', '[v]', '-map', '[a]',
      ...encTail,
    ]
  }
  // 有原声（含探测失败宽容）：apad 补短/裁长保原声
  return [
    '-y', '-i', seg.path,
    '-filter_complex',
    `[0:v]${vChain}[v];[0:a]${aTail},apad=whole_dur=${dur},atrim=duration=${dur}[a]`,
    '-map', '[v]', '-map', '[a]',
    ...encTail,
  ]
}

/** phase-1 执行：逐段归一化 → 新 segments（kind 统一 'video'、path=临时 mp4；临时件返回 cleanup） */
export async function normalizeSegmentsToClips(
  ctx: StepContext,
  ffmpeg: string,
  segments: Segment[],
  opts: { width: number; height: number; fps: number; kb: KenBurns; outDir: string },
): Promise<{ segments: Segment[]; temps: string[] }> {
  const stamp = Date.now()
  const out: Segment[] = []
  const temps: string[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const tmp = join(opts.outDir, `.mseg-${ctx.run.id}-${ctx.step.id}-${i}-${stamp}.mp4`)
    const kb = seg.kind === 'image' ? kbDirectionFor(opts.kb, i) : null
    const clipHasAudio = seg.kind === 'video' ? probeHasAudioStream(seg.path) : null
    const args = buildNormalizeArgs(seg, { width: opts.width, height: opts.height, fps: opts.fps, kb, clipHasAudio, outAbs: tmp })
    ctx.log(`混剪归一化 ${i + 1}/${segments.length}（${seg.kind === 'image' ? `图片段${kb ? ` + Ken Burns ${kb}` : ''}` : `视频段${clipHasAudio === false ? '（无原声，补静音）' : ''}`}）：${seg.durSec}s`)
    try {
      const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600_000, windowsHide: true })
      if (r.status !== 0) {
        const err = (r.stderr?.toString('utf8') ?? '').split('\n').filter(Boolean).slice(-3).join(' | ')
        throw new Error(`混剪归一化第 ${i + 1} 段失败：${err || `ffmpeg exit=${r.status}`}`)
      }
    } catch (e) {
      for (const t of temps) { try { unlinkSync(t) } catch { /* 清理失败忽略 */ } }
      throw e instanceof Error && e.message.startsWith('混剪归一化') ? e : new Error(`混剪归一化第 ${i + 1} 段失败：${(e as Error).message}`)
    }
    temps.push(tmp)
    out.push({ id: seg.id, path: tmp, kind: 'video', durSec: seg.durSec, explicit: seg.explicit })
  }
  return { segments: out, temps }
}
