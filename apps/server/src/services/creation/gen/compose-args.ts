import { buildTransitionPlan } from '../../../pipeline/actions/ffmpeg-merge'
import type { ComposeSize } from './params'

/**
 * 合成 argv 纯函数（探针直测快照）：
 * - N≥2：filter_complex 逐段归一（ fit：pad=scale decrease + pad 居中（默认信箱）/ crop=scale increase + crop 裁切满幅；
 *   setsar=1，指定 fps 时先归 fps）→ concat=[vout]；
 * - N=1：-map 0:v（指定 fps 时输出端 -r）；
 * - 音频（合成端口输入，M≥1）：amix=inputs=M:duration=longest=[aout] → -map [aout] + -c:a aac；M=0 → -an（BGM 启用时替代 -an）；
 * - 转场（transition≠none 且 durations 齐备）：归一链尾 +tpad 冻帧补足（前 n-1 段 d+T）+ settb=AVTB →
 *   xfade 链（offset=buildTransitionPlan.offsets；总长仍 Σd）；durations 缺失/不齐 → 宽容降级为 concat；
 * - BGM（bgmPath 非空且 durations 齐备）：-stream_loop -1 输入 + atrim=0:totalDur + volume + 首尾 afade（默认 1.5s）
 *   → 与原音轨 amix（duration=first:normalize=0；无原音轨 → BGM 单源 anull）；
 * - 音字对齐（align 非空且音频段数=n）：视频短段 tpad 冻帧补足、音频段 apad+atrim 双保险截断 → concat 顺序拼接；
 *   转场强制降级（互斥）；BGM 兼容（atrim=0:Σ段长）；subtitlePath 非空 → subtitles 滤镜 + [vsub] 映射；
 * - 编码：libx264 + yuv420p（对齐 ffmpeg-merge 设定）+ faststart。
 */

/**
 * 音字对齐段计划（纯函数，探针直测）：
 * video[i]↔audio[i] 边序配对，段时长 = max(视频, 音频)（保留 3 位小数）；
 * 段数不等 / 任一段缺失或非正 → null（调用方宽容降级为现状 concat/amix）。
 */
export function planAlignedSegments(videoDurs: Array<number | null>, audioDurs: Array<number | null>): { segDurs: number[] } | null {
  if (videoDurs.length === 0 || videoDurs.length !== audioDurs.length) return null
  const segDurs: number[] = []
  for (let i = 0; i < videoDurs.length; i += 1) {
    const v = videoDurs[i]
    const a = audioDurs[i]
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
    if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0) return null
    segDurs.push(Math.round(Math.max(v, a) * 1000) / 1000)
  }
  return { segDurs }
}

/** subtitles 滤镜路径转义（值须以单引号包裹使用）：反斜杠→正斜杠；单引号→`'\''`（引号内拆分）；冒号→`\:`
 *  （option 层转义，Windows 盘符必备）。实测 ffmpeg 9.x：裸值遇空格/`#` 直接解析失败 → 组装处一律 `filename='…'`。 */
export function escapeSubtitlePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')
}
export function buildComposeArgs(opts: {
  videoPaths: string[]
  audioPaths: string[]
  outPath: string
  fps?: number | null
  size?: ComposeSize | null
  /** 各视频段时长（转场/BGM 计划依据；缺失/不齐/非法 → 转场与 BGM 宽容降级） */
  durations?: number[] | null
  transition?: string | null
  transitionDuration?: number | null
  /** BGM 本地路径（追加为最后一个 -stream_loop -1 输入） */
  bgmPath?: string | null
  bgmVolume?: number | null
  /** BGM 首尾淡入淡出（默认 true，时长 1.5s） */
  bgmFade?: boolean | null
  /** 音字对齐（调用方以 planAlignedSegments 判定后的入参；非空且音频段数齐备 → 段级对齐构造，转场强制降级） */
  align?: { videoDurs: number[]; audioDurs: number[] } | null
  /** 烧录字幕 SRT 本地路径（非空 → subtitles 滤镜；路径经 escapeSubtitlePath 转义） */
  subtitlePath?: string | null
  /** 智能裁剪：'pad'（默认，信箱缩放）| 'crop'（裁切满幅）——归一链二选一 */
  fit?: string | null
}): string[] {
  const n = opts.videoPaths.length
  if (n === 0) throw new Error('合成缺少视频输入')
  const m = opts.audioPaths.length
  const fps = typeof opts.fps === 'number' && Number.isFinite(opts.fps) && opts.fps > 0 ? opts.fps : null

  // 音字对齐：video[i]↔audio[i] 段级配对（段时长 max）；音频段数须与视频一致
  const alignPlan = opts.align ? planAlignedSegments(opts.align.videoDurs, opts.align.audioDurs) : null
  const useAlign = alignPlan != null && m > 0 && m === n
  // 烧录字幕路径（转义后在滤镜串中使用）
  const subPath = typeof opts.subtitlePath === 'string' && opts.subtitlePath ? opts.subtitlePath : null
  const escSubPath = subPath ? escapeSubtitlePath(subPath) : ''

  // 转场计划：时长齐备且合法才启用（否则宽容降级 concat）； 对齐模式与转场互斥 → 强制降级（note 由调用方留痕）
  const durations =
    Array.isArray(opts.durations) && opts.durations.length === n && opts.durations.every((d) => typeof d === 'number' && Number.isFinite(d) && d > 0)
      ? opts.durations
      : null
  const xplan = durations && !useAlign ? buildTransitionPlan(durations, String(opts.transition ?? 'none'), Number(opts.transitionDuration ?? 0.5)) : null
  const useX = !!xplan && xplan.enabled
  const totalDur = useAlign
    ? Math.round(alignPlan!.segDurs.reduce((s, d) => s + d, 0) * 1000) / 1000
    : durations ? (useX ? xplan!.totalDur : Math.round(durations.reduce((s, d) => s + d, 0) * 1000) / 1000) : null
  // BGM：总长未知（durations 缺失）→ 降级禁用
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
    // 归一链二选一：pad（信箱化，现状零漂移）/ crop（铺满裁边）
    const normChain =
      opts.fit === 'crop'
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`
        : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`
    for (let i = 0; i < n; i += 1) {
      let chain = `${normChain}${fps ? `,fps=${fps}` : ''}`
      if (useAlign && opts.align!.videoDurs[i]! < alignPlan!.segDurs[i]!) {
        // 视频短于段长 → 末帧冻帧补足（tpad 时长 = 段长 − 视频长）
        chain += `,tpad=stop_mode=clone:stop_duration=${Math.round((alignPlan!.segDurs[i]! - opts.align!.videoDurs[i]!) * 1000) / 1000}`
      }
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
    maps.push('-map', subPath ? '[vsub]' : '[vout]')
    if (subPath) {
      // 烧录字幕：拼接/转场产物 → subtitles 滤镜（单引号包裹值，防空格/`#` 解析失败）
      fc.push(`[vout]subtitles=filename='${escSubPath}'[vsub]`)
    }
  } else {
    // 单段 + 烧录字幕：-map 0:v 换成滤镜链（单引号包裹值）
    if (subPath) {
      fc.push(`[0:v]subtitles=filename='${escSubPath}'[vsub]`)
      maps.push('-map', '[vsub]')
    } else {
      maps.push('-map', '0:v')
    }
  }
  if (m > 0) {
    const ins = opts.audioPaths.map((_, k) => `[${n + k}:a]`).join('')
    if (useAlign) {
      // 段级对齐：逐段 apad 补静音 + atrim 双保险截断到段长 → concat 顺序拼接（替代 amix 并行混音）
      const segDurs = alignPlan!.segDurs
      for (let k = 0; k < m; k += 1) {
        fc.push(`[${n + k}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${segDurs[k]},asetpts=PTS-STARTPTS[a${k}]`)
      }
      fc.push(`${opts.audioPaths.map((_, k) => `[a${k}]`).join('')}concat=n=${m}:v=0:a=1[${bgm ? 'amix' : 'aout'}]`)
      if (bgm) {
        // BGM 与原音轨 amix（duration=first；原轨已精确为 Σ段长）
        const bgmIdx = n + m
        let chain = `[${bgmIdx}:a]atrim=0:${totalDur},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bgmVolume}`
        if (bgmFade > 0) {
          chain += `,afade=t=in:st=0:d=${bgmFade},afade=t=out:st=${Math.max(0, Math.round((totalDur! - bgmFade) * 1000) / 1000)}:d=${bgmFade}`
        }
        fc.push(`${chain}[bgm]`)
        fc.push('[amix][bgm]amix=inputs=2:duration=first:normalize=0[aout]')
      }
    } else if (bgm) {
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
