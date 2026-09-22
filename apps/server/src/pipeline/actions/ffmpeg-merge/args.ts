import { basename, dirname } from 'node:path'
import { resolveAspectSize, aspectGeometryFilter } from './aspect'
import { buildSubtitleStyle } from './subtitle-style'
import { watermarkOverlayXY } from './watermark'
import { round3 } from './util'
import type { Segment } from './segments'
import type { AlignPlan } from './align'
import type { TransitionPlan } from './transition'
import type { ResolvedWatermark, SubtitleStyleConfig } from '../../../services/brand-config'

/** [M19] 品牌素材输入（水印：清洗参数 + 绝对路径） */
export type ComposeWatermarkInput = ResolvedWatermark & { path: string }

/** [M19] 片头/片尾输入（绝对路径 + 探测时长） */
export interface ComposeClipInput {
  path: string
  durSec: number
}

/** [M19] per-shot 音效输入（绝对路径 + 镜起点秒；起点已含片头位移） */
export interface ComposeSfxInput {
  path: string
  startSec: number
}

/** [M19] buildComposeArgs 输入（主链解析后的纯数据） */
export interface ComposeArgsInput {
  strictDelivery?: boolean
  /** 已通过逐镜原声与台词核验的流起点；缺省保持历史参数逐字不变。 */
  nativeAudio?: Array<{ videoStart: number; audioStart: number }>
  segments: Segment[]
  width: number
  height: number
  fps: number
  xfadePlan: TransitionPlan
  voicePaths: string[]
  /** 配音句 lineId（与 voicePaths 同序；对齐轨组装用） */
  lineIds: string[]
  alignPlan: AlignPlan | null
  /** 成片总长（秒；正片 Σd，未含片头尾） */
  total: number
  srtAbs: string | null
  /** [M32] 每路字幕文件（[0]=主，[k+1]=派生路 k）；缺省/越界 → 回落 srtAbs。多画幅各路 PlayRes 不同，需各自 ASS。 */
  subtitlePaths?: string[]
  style: string
  bgmPath: string | null
  bgmVolume: number
  bgmFade: number
  watermark: ComposeWatermarkInput | null
  intro: ComposeClipInput | null
  outro: ComposeClipInput | null
  /** [M19] per-shot 音效（空/缺省 = 音频链与 M11 逐字节一致） */
  sfx?: ComposeSfxInput[]
  /** [M19] SFX 全局音量（默认 1；服务层已 clamp 0–2） */
  sfxVolume?: number
  /** [M19] 多画幅原生渲染（缺省/targets 空 → args 与单画幅逐字节一致） */
  multiAspect?: {
    strategy: 'crop' | 'pad'
    targets: Array<{ aspect: string; outAbs: string }>
    /** 结构化字幕配置（非空时派生路按该路高度重算字号；null = 整串模式复用主串） */
    subtitleCfg?: SubtitleStyleConfig | null
  }
  outAbs: string
}

/** [M19] 多画幅派生输出（buildComposeArgs 算定尺寸与标签；调用方据此落资产） */
export interface ComposeDerivedOutput {
  aspect: string
  width: number
  height: number
  outAbs: string
}

/** [M19] buildComposeArgs 输出（totalAll = 含片头尾总长；无片头尾时 === round3(total)） */
export interface ComposeArgsResult {
  args: string[]
  cwd: string | undefined
  totalAll: number
  /** [M19] 派生路输出（与 args 中的额外输出组同序；无派生 → []） */
  derived: ComposeDerivedOutput[]
}

/**
 * [M19] 合成 args 组装（纯函数；探针直测）——M7/M11 组装逻辑原样搬移 + 水印/片头尾开关：
 * - 零 diff 红线：watermark/intro/outro 全 null 时 args/cwd 与 M7/M11 逐字节一致；
 * - 输入顺序：segments → voices → BGM → watermark → intro → outro（auxIdx 依此递推）；
 * - 片头尾：归一（scale/crop/setsar/fps/yuv420p）→ 与 [basev] concat（不参与转场）→ [basev2]；
 * - 字幕烧录于拼接后（时间轴含片头位移）；水印 overlay 在字幕之后（最顶层）→ [outv]；
 * - 配音轨 adelay（片头时长）→ apad 到 totalAll；BGM atrim/afade 末端锚定 totalAll；
 * - [M19] SFX：逐条 adelay 注入（起点含片头位移）→ 终混并入 [aout]；无 SFX → 音频链逐字节不变。
 * - [M19] 多画幅：拼接结果 split → 主路照旧 + 派生路各自几何/字幕/水印 → 每路独立输出组；未启用 → 逐字节不变。
 */
export function buildComposeArgs(input: ComposeArgsInput): ComposeArgsResult {
  const {
    segments, width, height, fps, xfadePlan, voicePaths, lineIds, alignPlan, total,
    srtAbs, style, bgmPath, bgmVolume, bgmFade, watermark, intro, outro, outAbs,
  } = input
  const nativeAudio = input.nativeAudio
  if (nativeAudio && (!input.strictDelivery || nativeAudio.length !== segments.length || !segments.length ||
    segments.some((s) => s.kind !== 'video') || voicePaths.length || alignPlan || xfadePlan.enabled || intro || outro ||
    nativeAudio.some((t) => !Number.isFinite(t.audioStart) || !Number.isFinite(t.videoStart)))) {
    throw new Error('原生对白合成输入不合法，不能混入旁白、转场或片头尾')
  }
  const sfxList = input.sfx ?? []
  const sfxCount = sfxList.length
  const sfxVolume = input.sfxVolume ?? 1
  const maTargets = input.multiAspect?.targets ?? []
  const maStrategy = input.multiAspect?.strategy ?? 'crop'
  const maSubCfg = input.multiAspect?.subtitleCfg ?? null
  // [M32] 每路字幕文件：[0]=主，[k+1]=派生路 k；缺省/越界回落 srtAbs（多画幅各路 PlayRes 不同，需各自 ASS）
  const subtitlePaths = input.subtitlePaths ?? []
  const subPathFor = (idx: number): string => subtitlePaths[idx] ?? srtAbs!
  const introDur = intro ? round3(intro.durSec) : 0
  const outroDur = outro ? round3(outro.durSec) : 0
  const totalAll = round3(total + introDur + outroDur)
  const totalAllStr = String(totalAll)
  const introMs = intro ? Math.round(intro.durSec * 1000) : 0
  const introDelay = introMs > 0 ? `,adelay=${introMs}|${introMs}` : ''

  const inputArgs: string[] = []
  const fcParts: string[] = []
  segments.forEach((seg, i) => {
    const segLen = xfadePlan.enabled ? xfadePlan.videoLens[i]! : seg.durSec
    if (seg.kind === 'image') {
      inputArgs.push('-loop', '1', '-t', String(segLen), '-i', seg.path)
    } else {
      inputArgs.push('-i', seg.path)
    }
    const strictTiming = nativeAudio
      ? `setpts=PTS-STARTPTS,trim=duration=${seg.durSec},`
      : input.strictDelivery
      ? `${seg.kind === 'video' ? 'tpad=stop_mode=clone:stop_duration=0.5,' : ''}trim=duration=${seg.durSec},setpts=PTS-STARTPTS,`
      : ''
    fcParts.push(
      `[${i}:v]${strictTiming}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p${xfadePlan.enabled ? ',settb=AVTB' : ''}[v${i}]`,
    )
  })
  const segIn = segments.map((_, i) => `[v${i}]`).join('')
  const hasAudio = voicePaths.length > 0 || !!nativeAudio
  if (nativeAudio) {
    nativeAudio.forEach((timing, i) => {
      const offset = timing.audioStart - timing.videoStart
      // 与视频归零轴共用实测偏移；只裁掉经核验无对白的头尾，绝不拉伸人声。
      const trim = offset < 0 ? `atrim=start=${-offset},` : ''
      const delay = offset > 0 ? `adelay=${Math.round(offset * 44100)}S:all=1,` : ''
      fcParts.push(`[${i}:a]${trim}asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,${delay}apad=whole_dur=${segments[i]!.durSec},atrim=duration=${segments[i]!.durSec}[native${i}]`)
    })
  } else if (hasAudio) {
    voicePaths.forEach((p, i) => {
      inputArgs.push('-i', p)
      const srcIdx = segments.length + i
      fcParts.push(`[${srcIdx}:a]${input.strictDelivery ? 'asetpts=PTS-STARTPTS,' : ''}aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`)
    })
    if (alignPlan) {
      // [M11] 对齐轨：按镜序 [句…, 镜尾静音(anullsrc)] concat（总长严格 = Σd；apad 兜底浮点）
      const items: string[] = []
      let silenceIdx = 0
      for (const ps of alignPlan.segments) {
        for (const lineId of ps.lineIds) {
          const vi = lineIds.findIndex((id) => id === lineId)
          if (vi < 0) throw new Error(`内部不一致：句 ${lineId} 无对应配音资产（对齐轨组装中止）`)
          items.push(`[a${vi}]`)
        }
        if (ps.silenceSec > 0) {
          fcParts.push(
            `anullsrc=r=44100:cl=stereo:d=${round3(ps.silenceSec)},aformat=sample_fmts=fltp:channel_layouts=stereo[s${silenceIdx}]`,
          )
          items.push(`[s${silenceIdx}]`)
          silenceIdx++
        }
      }
      fcParts.push(`${items.join('')}concat=n=${items.length}:v=0:a=1${introDelay},apad=whole_dur=${totalAllStr}[outa]`)
    } else {
      const aIn = voicePaths.map((_, i) => `[a${i}]`).join('')
      // 连续轨：adelay 片头位移 + apad 补静音到总长；音频超长不裁剪（口播超时保内容，输出时长自然取 max）
      fcParts.push(`${aIn}concat=n=${voicePaths.length}:v=0:a=1${introDelay},apad=whole_dur=${totalAllStr}[outa]`)
    }
  }
  // [M11] BGM 混音链：有主音轨 → amix 以主轨定长；无主音轨 → bgm 直接 [aout]
  if (bgmPath) {
    const bgmIdx = segments.length + voicePaths.length
    inputArgs.push('-stream_loop', '-1', '-i', bgmPath)
    // [M19] 淡出锚点：有片头尾 → totalAll；否则 total（零漂移）
    const fadeBase = intro || outro ? totalAll : total
    const fadeDur = round3(bgmFade)
    let chain =
      `[${bgmIdx}:a]atrim=0:${totalAllStr},asetpts=PTS-STARTPTS,aresample=44100,`
      + `aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bgmVolume}`
    if (fadeDur > 0) {
      chain += `,afade=t=in:st=0:d=${fadeDur},afade=t=out:st=${round3(Math.max(0, fadeBase - bgmFade))}:d=${fadeDur}`
    }
    fcParts.push(`${chain}[bgm]`)
    // [M19] 有 SFX 时主混先出 [amain]，由 SFX 终混统一产出 [aout]；无 SFX → 现行为逐字节不变
    if (hasAudio) fcParts.push(`[outa][bgm]amix=inputs=2:duration=first:normalize=0[${sfxCount > 0 ? 'amain' : 'aout'}]`)
    else if (sfxCount === 0) fcParts.push('[bgm]anull[aout]')
  }
  // [M19] 品牌素材输入（水印 → 片头 → 片尾；索引递推；归一链先于 [basev] 拼接定义）
  let auxIdx = segments.length + voicePaths.length + (bgmPath ? 1 : 0)
  if (watermark) {
    const wmIdx = auxIdx
    auxIdx++
    inputArgs.push('-i', watermark.path)
    fcParts.push(
      `[${wmIdx}:v]scale=${Math.round(width * watermark.width_pct)}:-1,format=rgba,colorchannelmixer=aa=${watermark.opacity}[wm]`,
    )
  }
  if (intro) {
    const introIdx = auxIdx
    auxIdx++
    inputArgs.push('-i', intro.path)
    fcParts.push(
      `[${introIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[vintro]`,
    )
  }
  if (outro) {
    const outroIdx = auxIdx
    inputArgs.push('-i', outro.path)
    fcParts.push(
      `[${outroIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[voutro]`,
    )
  }
  // [M19] per-shot 音效输入（索引位于全部素材槽之后；起点 adelay 已含片头位移；v1 不裁剪——超镜长自然溢出）
  const sfxBaseIdx = segments.length + voicePaths.length + (bgmPath ? 1 : 0)
    + (watermark ? 1 : 0) + (intro ? 1 : 0) + (outro ? 1 : 0)
  sfxList.forEach((s, i) => {
    inputArgs.push('-i', s.path)
    const startMs = Math.round(s.startSec * 1000)
    fcParts.push(
      `[${sfxBaseIdx + i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,`
      + `volume=${round3(sfxVolume)},adelay=${startMs}|${startMs}[sfx${i}]`,
    )
  })
  // [M19] SFX 终混：有主音轨/BGM → amix(inputs=1+k, duration=first 以主轨定长)；
  // 仅 SFX（无配音无 BGM）→ 组内 amix(longest) + apad 到 totalAll
  if (sfxCount > 0) {
    const sfxIns = sfxList.map((_, i) => `[sfx${i}]`).join('')
    if (hasAudio || bgmPath) {
      const mainIn = hasAudio && bgmPath ? '[amain]' : hasAudio ? '[outa]' : '[bgm]'
      fcParts.push(`${mainIn}${sfxIns}amix=inputs=${1 + sfxCount}:duration=first:normalize=0[aout]`)
    } else {
      fcParts.push(`${sfxIns}amix=inputs=${sfxCount}:duration=longest:normalize=0,apad=whole_dur=${totalAllStr}[aout]`)
    }
  }
  if (xfadePlan.enabled) {
    // [M11] xfade 链：offset o_k = V_k（前 n−1 镜段长 +T 补偿；末轮输出 [basev]，总长仍 Σd）
    let prev = 'v0'
    const boundaries = xfadePlan.offsets.length
    for (let k = 0; k < boundaries; k++) {
      const outLabel = k < boundaries - 1 ? `x${k + 1}` : 'basev'
      fcParts.push(
        `[${prev}][v${k + 1}]xfade=transition=${xfadePlan.type}:duration=${xfadePlan.durSec}:offset=${xfadePlan.offsets[k]}[${outLabel}]`,
      )
      prev = outLabel
    }
  } else if (nativeAudio) {
    fcParts.push(`${segments.map((_, i) => `[v${i}][native${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[basev][outa]`)
  } else {
    fcParts.push(`${segIn}concat=n=${segments.length}:v=1:a=0[basev]`)
  }
  // [M19] 片头尾拼接：仅存在侧参与（n=2/3）；字幕轴与音频位移均以拼接后为准
  const concatBase = intro || outro ? 'basev2' : 'basev'
  if (intro || outro) {
    const parts = `${intro ? '[vintro]' : ''}[basev]${outro ? '[voutro]' : ''}`
    const n = 1 + (intro ? 1 : 0) + (outro ? 1 : 0)
    fcParts.push(`${parts}concat=n=${n}:v=1:a=0[basev2]`)
  }
  // [M19] 多画幅：split 于拼接后（含片头尾）——主路 [bm] 照旧，派生路 [b1..bk] 各自构图
  const mainBase = maTargets.length > 0 ? 'bm' : concatBase
  if (maTargets.length > 0) {
    const labels = ['bm', ...maTargets.map((_, k) => `b${k + 1}`)].map((l) => `[${l}]`).join('')
    fcParts.push(`[${concatBase}]split=${maTargets.length + 1}${labels}`)
  }
  const subOut: string | null = srtAbs ? (watermark ? 'subv' : 'outv') : null
  if (srtAbs) {
    fcParts.push(
      `[${mainBase}]subtitles='${basename(subPathFor(0))}':force_style='${style}'[${subOut}]`,
    )
  }
  // [M19] 水印 overlay（最顶层；字幕烧录之后）
  if (watermark) {
    const wmIn = srtAbs && subOut ? subOut : mainBase
    fcParts.push(`[${wmIn}][wm]overlay=${watermarkOverlayXY(watermark.position, watermark.margin_px)}[outv]`)
  }
  const videoOut = watermark || srtAbs ? 'outv' : mainBase

  // [M19] 派生路：几何（与 A 派生端点同源 aspectGeometryFilter）→ 字幕（结构化配置按该路高度重算）→ 水印（同一 [wm] 分流）
  const derived: ComposeDerivedOutput[] = []
  const derivedLabels: string[] = []
  maTargets.forEach((t, k) => {
    const { w, h } = resolveAspectSize(width, height, t.aspect)
    let prev = `b${k + 1}`
    fcParts.push(`[${prev}]${aspectGeometryFilter(maStrategy, w, h)}[dv${k}]`)
    prev = `dv${k}`
    if (srtAbs) {
      const st = maSubCfg ? buildSubtitleStyle(h, maSubCfg).replace(/['"]/g, '') : style
      fcParts.push(`[${prev}]subtitles='${basename(subPathFor(k + 1))}':force_style='${st}'[dsub${k}]`)
      prev = `dsub${k}`
    }
    if (watermark) {
      fcParts.push(`[${prev}][wm]overlay=${watermarkOverlayXY(watermark.position, watermark.margin_px)}[dwm${k}]`)
      prev = `dwm${k}`
    }
    derivedLabels.push(prev)
    derived.push({ aspect: t.aspect, width: w, height: h, outAbs: t.outAbs })
  })

  // [M19] 音频终标签（有 BGM/SFX → [aout]；仅配音 → [outa]；无音频 → null）
  const audioTail = bgmPath || sfxCount > 0 ? 'aout' : hasAudio ? 'outa' : null
  const encAudio: string[] = []
  // [M19] 多路输出时同一音频 pad 不得被两个输出重复 -map（ffmpeg：Output with label ... already used elsewhere
  // → Error opening output files: Invalid argument）→ asplit=1+k 分流，每路映射唯一标签；单路 → 原标签不变
  const aMaps: string[] = []
  if (audioTail) {
    encAudio.push('-c:a', 'aac', '-b:a', '192k')
    if (maTargets.length > 0) {
      const outs = ['amapMain', ...maTargets.map((_, k) => `amapD${k}`)]
      fcParts.push(`[${audioTail}]asplit=${outs.length}${outs.map((l) => `[${l}]`).join('')}`)
      aMaps.push(...outs.map((l) => `[${l}]`))
    } else {
      aMaps.push(`[${audioTail}]`)
    }
  }
  const encVideo = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(fps)]
  // 多输出：每路独立 -map 组 + 同编码参数（音频按路分流）；无派生 → token 序与单输出逐字节一致
  const am = (label: string | undefined): string[] => (label ? ['-map', label] : [])
  const outGroups = ['-map', `[${videoOut}]`, ...am(aMaps[0]), ...encVideo, ...encAudio, '-movflags', '+faststart', outAbs]
  derived.forEach((d, k) => {
    outGroups.push(
      '-map',
      `[${derivedLabels[k]!}]`,
      ...am(aMaps[k + 1]),
      ...encVideo,
      ...encAudio,
      '-movflags',
      '+faststart',
      d.outAbs,
    )
  })
  const args = ['-y', ...inputArgs, '-filter_complex', fcParts.join(';'), ...outGroups]
  // subtitles filter 以相对路径（文件名）引用 SRT → cwd 指向其所在目录（对齐平移副本与输出同目录）
  const cwd = srtAbs ? dirname(srtAbs) : undefined
  return { args, cwd, totalAll, derived }
}
