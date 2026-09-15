import { buildTransitionPlan } from '../../../pipeline/actions/ffmpeg-merge'
import type { ComposeSize } from './params'

/**
 * [M17/M18] 合成 argv 纯函数（探针直测快照）：
 * - N≥2：filter_complex 逐段归一（scale decrease + pad 居中 + setsar=1，指定 fps 时先归 fps）→ concat=[vout]；
 * - N=1：-map 0:v（指定 fps 时输出端 -r）；
 * - 音频（合成端口输入，M≥1）：amix=inputs=M:duration=longest=[aout] → -map [aout] + -c:a aac；M=0 → -an（BGM 启用时替代 -an）；
 * - [M18] 转场（transition≠none 且 durations 齐备）：归一链尾 +tpad 冻帧补足（前 n-1 段 d+T）+ settb=AVTB →
 *   xfade 链（offset=buildTransitionPlan.offsets；总长仍 Σd）；durations 缺失/不齐 → 宽容降级为 concat；
 * - [M18] BGM（bgmPath 非空且 durations 齐备）：-stream_loop -1 输入 + atrim=0:totalDur + volume + 首尾 afade（默认 1.5s）
 *   → 与原音轨 amix（duration=first:normalize=0；无原音轨 → BGM 单源 anull）；
 * - 编码：libx264 + yuv420p（对齐 ffmpeg-merge 设定）+ faststart。
 */
export function buildComposeArgs(opts: {
  videoPaths: string[]
  audioPaths: string[]
  outPath: string
  fps?: number | null
  size?: ComposeSize | null
  /** [M18] 各视频段时长（转场/BGM 计划依据；缺失/不齐/非法 → 转场与 BGM 宽容降级） */
  durations?: number[] | null
  transition?: string | null
  transitionDuration?: number | null
  /** [M18] BGM 本地路径（追加为最后一个 -stream_loop -1 输入） */
  bgmPath?: string | null
  bgmVolume?: number | null
  /** [M18] BGM 首尾淡入淡出（默认 true，时长 1.5s） */
  bgmFade?: boolean | null
}): string[] {
  const n = opts.videoPaths.length
  if (n === 0) throw new Error('合成缺少视频输入')
  const m = opts.audioPaths.length
  const fps = typeof opts.fps === 'number' && Number.isFinite(opts.fps) && opts.fps > 0 ? opts.fps : null

  // [M18] 转场计划：时长齐备且合法才启用（否则宽容降级 concat）
  const durations =
    Array.isArray(opts.durations) && opts.durations.length === n && opts.durations.every((d) => typeof d === 'number' && Number.isFinite(d) && d > 0)
      ? opts.durations
      : null
  const xplan = durations ? buildTransitionPlan(durations, String(opts.transition ?? 'none'), Number(opts.transitionDuration ?? 0.5)) : null
  const useX = !!xplan && xplan.enabled
  const totalDur = durations ? (useX ? xplan!.totalDur : Math.round(durations.reduce((s, d) => s + d, 0) * 1000) / 1000) : null
  // [M18] BGM：总长未知（durations 缺失）→ 降级禁用
  const bgm = totalDur != null && typeof opts.bgmPath === 'string' && opts.bgmPath ? opts.bgmPath : null
  const bgmVolume = typeof opts.bgmVolume === 'number' && Number.isFinite(opts.bgmVolume) ? Math.min(1, Math.max(0, opts.bgmVolume)) : 0.5
  const bgmFade = opts.bgmFade === false ? 0 : 1.5

  const args: string[] = ['-y']
  for (const p of opts.videoPaths) args.push('-i', p)
  for (const p of opts.audioPaths) args.push('-i', p)
  if (bgm) args.push('-stream_loop', '-1', '-i', bgm)

  const fc: string[] = []
  const maps: string[] = []
  if (n >= 2) {
    if (!opts.size) throw new Error('合成尺寸未知（多段合成需 resolution 或可探测的视频输入）')
    const { width, height } = opts.size
    for (let i = 0; i < n; i += 1) {
      let chain = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1${fps ? `,fps=${fps}` : ''}`
      if (useX) {
        // 前 n-1 段冻帧补足 T（转场期间被下一段覆盖；末镜不加）
        if (i < n - 1) chain += `,tpad=stop_mode=clone:stop_duration=${xplan!.durSec}`
        chain += ',settb=AVTB'
      }
      fc.push(`[${i}:v]${chain}[v${i}]`)
    }
    if (useX) {
      let prev = 'v0'
      const boundaries = xplan!.offsets.length
      for (let k = 0; k < boundaries; k += 1) {
        const outLabel = k < boundaries - 1 ? `x${k + 1}` : 'vout'
        fc.push(`[${prev}][v${k + 1}]xfade=transition=${xplan!.type}:duration=${xplan!.durSec}:offset=${xplan!.offsets[k]}[${outLabel}]`)
        prev = outLabel
      }
    } else {
      fc.push(`${opts.videoPaths.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vout]`)
    }
    maps.push('-map', '[vout]')
  } else {
    maps.push('-map', '0:v')
  }
  if (m > 0) {
    const ins = opts.audioPaths.map((_, k) => `[${n + k}:a]`).join('')
    if (bgm) {
      fc.push(`${ins}amix=inputs=${m}:duration=longest[amix]`)
      const bgmIdx = n + m
      let chain = `[${bgmIdx}:a]atrim=0:${totalDur},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bgmVolume}`
      if (bgmFade > 0) {
        chain += `,afade=t=in:st=0:d=${bgmFade},afade=t=out:st=${Math.max(0, Math.round((totalDur! - bgmFade) * 1000) / 1000)}:d=${bgmFade}`
      }
      fc.push(`${chain}[bgm]`)
      fc.push('[amix][bgm]amix=inputs=2:duration=first:normalize=0[aout]')
    } else {
      fc.push(`${ins}amix=inputs=${m}:duration=longest[aout]`)
    }
  } else if (bgm) {
    const bgmIdx = n
    let chain = `[${bgmIdx}:a]atrim=0:${totalDur},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bgmVolume}`
    if (bgmFade > 0) {
      chain += `,afade=t=in:st=0:d=${bgmFade},afade=t=out:st=${Math.max(0, Math.round((totalDur! - bgmFade) * 1000) / 1000)}:d=${bgmFade}`
    }
    fc.push(`${chain}[bgm]`)
    fc.push('[bgm]anull[aout]')
  }
  if (m > 0 || bgm) maps.push('-map', '[aout]')
  if (fc.length > 0) args.push('-filter_complex', fc.join(';'))
  args.push(...maps, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p')
  if (n === 1 && fps) args.push('-r', String(fps))
  if (m > 0 || bgm) args.push('-c:a', 'aac')
  else args.push('-an')
  args.push('-movflags', '+faststart', opts.outPath)
  return args
}
