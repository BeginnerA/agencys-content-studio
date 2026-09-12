import { spawn } from 'node:child_process'
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { probeMediaDuration, resolveFfmpeg } from '../../services/ffmpeg'
import { absPathOf, registerAsset, relPathOf } from '../../services/storage'
import { TRANSITIONS, loadBgmAsset, readComposeConfig } from '../../services/compose-config'
import { shotDurationSec } from '../../services/shot-workbench'
import { emitStudioEvent } from '../../services/events'
import type { Asset } from '../../db/schema'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

/** 字幕 ASS 风格缺省（字号/边距按输出高度自适应；模板可用 defaults.video.subtitle_style 整体覆盖） */
function defaultSubtitleStyle(height: number): string {
  const fontSize = Math.max(16, Math.round(height * 0.018))
  const marginV = Math.round(height * 0.02)
  const outline = Math.max(1, Math.round(height * 0.0009))
  return (
    `FontName=Noto Sans CJK SC,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,` +
    `OutlineColour=&H00000000,BorderStyle=1,Outline=${outline},Shadow=0,MarginV=${marginV}`
  )
}

/** 数值参数：params → defaults.video（settings）→ fallback */
function numParam(v: unknown, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fb
}

interface Segment {
  id: number
  path: string
  kind: 'image' | 'video'
  durSec: number
  /** [M7] 静态图：时长来自分镜 per-shot 覆盖（fit_voice 显式优先依据） */
  explicit?: boolean
  /** [M7] 动效片：时长未知按 duration_per_shot 估算（日志溯源） */
  estimated?: boolean
}

/** [M11] 对齐输入（分镜 shots[] 子集：id / 时长 / 台词句 id 列表） */
export interface AlignShotInput {
  id: string
  durationSec: number | null
  lineIds: string[]
}

/** [M11] 句级映射（speechStart 语音连续轴 / timelineStart 成片轴；SRT 平移依据） */
export interface AlignLine {
  lineId: string
  speechStart: number
  timelineStart: number
}

/** [M11] 音字对齐计划（aligned=false 时 reason 记录回退原因；warnShots = 显式时长 < 句长合计的镜 id） */
export interface AlignPlan {
  aligned: boolean
  reason?: string
  segments: Array<{ shotId: string; durSec: number; lineIds: string[]; silenceSec: number }>
  lines: AlignLine[]
  totalDur: number
  warnShots?: string[]
}

/** [M11] 转场计划（videoLens 段实际长度；offsets = V_k；总长仍 Σd） */
export interface TransitionPlan {
  enabled: boolean
  type: string
  durSec: number
  videoLens: number[]
  offsets: number[]
  totalDur: number
}

/**
 * ffmpeg_merge：镜头序列 → 成片 + 封面（spec §5.4 三流合成）。
 * 镜头输入双字段互斥：images（静态图，-loop 1 -t duration_per_shot 定长）或
 * motion_clips（ai_video 产物，按实际时长 concat，不 -t/不 -loop）。
 * 可选 voices（audio 资产序列，逐句 concat 连续轨 → apad/atrim 对齐总时长，aac）；
 * 可选 subtitle（SRT 资产，视频流经 subtitles 滤镜烧录，force_style 参数化）。
 * 时间轴：镜头实际时长优先（video 资产 duration 字段，缺失时 ffprobe 探测兜底）；
 * 静态图回退 duration_per_shot（默认 4s）。产物 tags 增 'with_audio'/'with_subtitle'。
 * fit_voice=true 且为多镜静态图 + 配音时：按配音总长分配每镜时长（成片与音轨等长）。
 * [M7] 可选 shots（分镜 JSON）输入：静态图 per-shot 时长覆盖；逐镜容错（缺文件/类型不符 skip+warn，
 * 全 skip 才失败）；产物 params 增 inputs 快照（stale 检测）与 skipped_shots；fit_voice 显式时长优先。
 * [M11] 三增强（均可组合；失败即回退 M7 行为）：
 *   ① 音字对齐：shots[].lines ↔ voice.params.lineId 映射一致时，每镜时长 = 句和（显式 > 句和补镜尾静音）/
 *      空镜 explicit??duration_per_shot，音频轨按镜序 [句…,静音] concat，SRT 平移后烧录；
 *   ② BGM：run 级直查（loadBgmAsset）循环铺满（atrim 到 total）+ volume + afade + amix；
 *   ③ 转场：xfade 链（前 n-1 镜段长 +T 补偿，offset = V_k，总长仍 Σd）；_compose 覆盖 transition/bgm_*。
 */
export async function ffmpegMerge(ctx: StepContext): Promise<StepResult> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    throw new Error(
      '未找到可用 ffmpeg：内置二进制与系统 PATH 均不可用；请先在仓库根 pnpm install（重新下载内置二进制），'
      + '或 winget install ffmpeg，或在 .env 设 CSTUDIO_FFMPEG_PATH 指向 ffmpeg.exe',
    )
  }
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const vidCfg = (ctx.settings.video ?? {}) as Record<string, unknown>
  const fps = numParam(params['fps'] ?? vidCfg['fps'], 25)
  const resolution =
    (typeof params['resolution'] === 'string' && params['resolution'])
    || (typeof vidCfg['resolution'] === 'string' && vidCfg['resolution'])
    || '1080x1920'
  const wantCover = params['cover'] === true
  const durationPerShot = numParam(params['duration_per_shot'] ?? vidCfg['duration_per_shot'], 4)

  const m = /^(\d+)x(\d+)$/.exec(resolution)
  if (!m) throw new Error(`resolution 非法: ${resolution}（需 WxH 如 1080x1920）`)
  const width = Number(m[1])
  const height = Number(m[2])

  // 镜头段：images（静态）与 motion_clips（动效）互斥，模板 when 分支保证单路
  const imageIds = ctx.assetIdsOf('images')
  const clipIds = ctx.assetIdsOf('motion_clips')
  if (imageIds.length === 0 && clipIds.length === 0) throw new Error('inputs.images / inputs.motion_clips 均无镜头资产')
  if (imageIds.length > 0 && clipIds.length > 0) {
    throw new Error('images 与 motion_clips 互斥：模板 when 应按 motion 开关只给一路输入')
  }
  const mode: 'images' | 'clips' = imageIds.length > 0 ? 'images' : 'clips'
  const rows = await ctx.assetsOf(mode === 'images' ? imageIds : clipIds)
  if (rows.length === 0) throw new Error('镜头资产均不可用（资产不存在或已删除）')
  // [M7] shots（分镜 JSON）→ per-shot 时长覆盖表（v6 存量 run 无此输入 → 空表 = 行为不变）
  const shotsIds = ctx.assetIdsOf('shots')
  const perShotDur = await loadPerShotDurations(ctx, shotsIds)
  const { segments, skipped } = computeShotSegments(rows, mode, perShotDur, durationPerShot)
  if (skipped.length > 0) {
    for (const id of skipped) {
      const a = rows.find((r) => r.id === id)
      ctx.log(`镜头资产 #${id}（${a?.name ?? '?'}）不可用，已跳过（缺文件或类型不符）`)
    }
    ctx.log(`共跳过 ${skipped.length} 个镜头资产（合成继续；溯源见产物 params.skipped_shots）`)
  }
  if (segments.length === 0) throw new Error('无可用镜头资产（全部缺文件或类型不符），请检查镜头产物后重新合成')
  if (mode === 'clips') {
    for (const seg of segments) {
      if (seg.estimated) ctx.log(`镜头视频 #${seg.id} 时长未知（无 duration 字段且 ffprobe 不可用），按 ${seg.durSec}s 估算`)
    }
  }
  // voices：tts 产物逐句 concat 为连续音轨；[M11] 逐句 meta（lineId/durSec）供对齐/fit_voice/撑长共用
  const voiceIds = ctx.assetIdsOf('voices')
  const voicePaths: string[] = []
  const voiceMetas: Array<{ assetId: number; lineId: string | null; durSec: number | null }> = []
  if (voiceIds.length > 0) {
    const vRows = await ctx.assetsOf(voiceIds)
    for (const a of vRows) {
      if (a.kind !== 'audio' || !a.relPath) {
        throw new Error(`voices 资产 #${a.id}（${a.name}）非本地音频`)
      }
      const path = absPathOf(a.relPath)
      voicePaths.push(path)
      voiceMetas.push({
        assetId: a.id,
        lineId: lineIdOfVoiceAsset(a),
        durSec: typeof a.duration === 'number' && a.duration > 0 ? a.duration : probeMediaDuration(path),
      })
    }
    const probeFail = voiceMetas.filter((v) => v.durSec === null).length
    if (probeFail > 0) ctx.log(`配音句时长探测失败 ${probeFail} 句（相关计时功能可能降级）`)
  }
  const voiceSec = voiceMetas.reduce((s, v) => s + (v.durSec ?? 0), 0)
  const voiceProbeOk = voiceMetas.length > 0 && voiceMetas.every((v) => v.durSec !== null && v.durSec > 0)

  // subtitle：SRT 文本资产 → subtitles 滤镜烧录（相对路径 + cwd 规避路径转义）
  const subtitleIds = ctx.assetIdsOf('subtitle')
  let srtRelPath: string | null = null
  let srtEndMs = 0
  if (subtitleIds.length > 0) {
    const sRows = await ctx.assetsOf(subtitleIds.slice(0, 1))
    const s = sRows[0]
    if (!s?.relPath) throw new Error(`subtitle 资产 #${subtitleIds[0]} 无本地文件`)
    srtRelPath = s.relPath
    try {
      const p = JSON.parse(s.params ?? '{}') as { durationMs?: number }
      srtEndMs = typeof p['durationMs'] === 'number' ? p['durationMs'] : 0
    } catch {
      // params 损坏不影响烧录
    }
    ctx.log(`烧录字幕 ${basename(srtRelPath)}（SRT 时间轴${srtEndMs ? `，末条结束 ${Math.round(srtEndMs / 1000)}s` : ''}）`)
  } else if (params['subtitle'] === true) {
    ctx.log('subtitle=true 但 inputs.subtitle 无 SRT 资产，已跳过烧录')
  }

  // [M11] 音字对齐尝试（静态图 + voices 全带 lineId/时长 + 分镜 lines 映射一致）：
  // 逐镜时长 = 句时长和（显式 > 句和 → 镜尾静音）/ 空镜 explicit ?? duration_per_shot；失败回退下方 M7 语义
  let alignPlan: AlignPlan | null = null
  // 回退原因：motion_mode / no_voices / no_lineid / 计划 reason / mapping_incomplete（成功路径该值不参与 params）
  let alignReason = 'not_applicable'
  if (mode !== 'images') {
    alignReason = 'motion_mode'
  } else if (voiceMetas.length === 0) {
    alignReason = 'no_voices'
  } else if (!voiceMetas.every((v) => v.lineId !== null && v.durSec !== null && v.durSec > 0)) {
    alignReason = 'no_lineid'
  } else {
    const { shots: alignShots, hasLinesField } = await loadShotAlignShots(ctx, shotsIds)
    const voiceDur = new Map(voiceMetas.map((v) => [v.lineId!, v.durSec!]))
    const plan = planVoiceAlignedSegments(alignShots, voiceDur, durationPerShot, { hasLinesField })
    if (plan.aligned) {
      // 严格映射：实际段集合 == 分镜集合（任一镜缺段/无 shotId → 回退；先校验后赋值防半改）
      const shotIdByAssetId = new Map<number, string>()
      for (const a of rows) {
        const sid = shotIdOfAsset(a)
        if (sid) shotIdByAssetId.set(a.id, sid)
      }
      const planByShot = new Map(plan.segments.map((s) => [s.shotId, s]))
      const used = new Set<string>()
      const mapping: Array<{ seg: Segment; durSec: number }> = []
      let ok = true
      for (const seg of segments) {
        const sid = shotIdByAssetId.get(seg.id)
        const ps = sid ? planByShot.get(sid) : undefined
        if (!sid || !ps || used.has(sid)) {
          ok = false
          break
        }
        used.add(sid)
        mapping.push({ seg, durSec: ps.durSec })
      }
      if (ok && used.size === plan.segments.length) {
        for (const item of mapping) item.seg.durSec = item.durSec
        alignPlan = plan
        const silentShots = plan.segments.filter((s) => s.lineIds.length === 0).length
        ctx.log(
          `音字对齐启用：${plan.segments.length} 镜 × ${plan.lines.length} 句映射一致（无台词镜 ${silentShots} 个），成片总长 ${plan.totalDur.toFixed(2)}s`,
        )
        if (plan.warnShots && plan.warnShots.length > 0) {
          ctx.log(`显式时长小于句长合计 ${plan.warnShots.length} 镜（${plan.warnShots.join('、')}）：已以句长为准，确保台词完整`)
        }
      } else {
        alignReason = 'mapping_incomplete'
        ctx.log('音字对齐未启用（mapping_incomplete：镜头集合与分镜映射不一致），回退 M7 均分/显式语义')
      }
    } else {
      alignReason = plan.reason ?? 'unknown'
      ctx.log(`音字对齐未启用（${alignReason}），回退 M7 均分/显式语义`)
    }
  }
  const alignAligned = alignPlan !== null

  // 口播场景守卫：仅 1 张静态图且带配音/字幕时，底图时长撑到内容实际长度（防尾段冻结/丢内容）——
  // [M7] 基准取「该镜当前时长」（分镜显式覆盖 ?? 全局）；有字幕以字幕末时间（估时）为准；无字幕则实测音频总长
  const needStretch =
    !alignAligned && segments.length === 1 && segments[0]!.kind === 'image' && (voicePaths.length > 0 || srtEndMs > 0)
  if (needStretch && voicePaths.length > 0 && srtEndMs <= 0) {
    if (voiceSec > 0) srtEndMs = Math.ceil(voiceSec) * 1000
    else ctx.log('配音句时长探测失败（跳过撑长）')
  }
  if (needStretch && srtEndMs > 0) {
    const baseDur = segments[0]!.durSec
    const stretched = Math.max(baseDur, Math.ceil(srtEndMs / 1000) + 1)
    if (stretched > baseDur) {
      ctx.log(`口播底图单张，时长由 ${baseDur}s 撑至 ${stretched}s（对齐配音/字幕，防尾段冻结）`)
      segments[0]!.durSec = stretched
    }
  }

  // fit_voice：多镜静态图 + 配音 → 按配音总长分配每镜时长（成片与音轨等长，消除尾部静音/末帧定格）——
  // [M7] 显式优先：分镜 JSON 指定时长（explicit）的镜固定不参与均分，剩余配音时长均分给无显式镜；
  // 全部显式 → 跳过均分；剩余 ≤0 或探测失败 → 放弃适配回退（flex 镜保留全局时长）；
  // 仅 images 模式生效（motion_clips 为真实时长不可拉伸）；单张静态图走上方口播撑长，不重复适配。
  if (
    params['fit_voice'] === true &&
    !needStretch &&
    !alignAligned &&
    segments.length > 1 &&
    segments.every((s) => s.kind === 'image') &&
    voicePaths.length > 0
  ) {
    if (!voiceProbeOk || voiceSec <= 0) {
      ctx.log('fit_voice 未生效：配音时长探测失败，回退 duration_per_shot')
    } else {
      const explicitSegs = segments.filter((s) => s.explicit)
      const flexSegs = segments.filter((s) => !s.explicit)
      if (flexSegs.length === 0) {
        ctx.log('fit_voice 跳过：全部分镜已指定时长（固定时长优先，不做均分）')
      } else {
        const explicitSec = explicitSegs.reduce((s, seg) => s + seg.durSec, 0)
        const remain = voiceSec - explicitSec
        if (remain <= 0) {
          ctx.log(`fit_voice 未生效：显式时长合计 ${explicitSec.toFixed(2)}s 已达/超过配音总长 ${voiceSec.toFixed(2)}s，回退`)
        } else {
          const per = Math.round((remain / flexSegs.length) * 1000) / 1000
          for (const seg of flexSegs) seg.durSec = per
          ctx.log(
            `fit_voice：显式 ${explicitSegs.length} 镜固定（${explicitSec.toFixed(2)}s），剩余 ${flexSegs.length} 镜按配音剩余 ${remain.toFixed(2)}s 均分（每镜 ${per}s）`,
          )
        }
      }
    }
  }

  const total = segments.reduce((s, seg) => s + seg.durSec, 0)
  const totalStr = String(round3(total))
  // [M11] 转场计划（仅静态图 ≥2 镜生效；_compose 覆盖模板 params；禁用时 filter 与 M7 逐字节一致）
  const composeCfg = readComposeConfig(ctx.run.input)
  const transitionReq = composeCfg.transition ?? (typeof params['transition'] === 'string' ? params['transition'] : 'none')
  const transitionDurReq = composeCfg.transition_duration ?? numParam(params['transition_duration'], 0.5)
  const transitionUsable = mode === 'images' && segments.length >= 2
  const xfadePlan = buildTransitionPlan(
    segments.map((s) => s.durSec),
    transitionUsable ? transitionReq : 'none',
    transitionDurReq,
  )
  if (xfadePlan.enabled) {
    ctx.log(`转场启用：${xfadePlan.type} × ${xfadePlan.offsets.length} 处（每处 ${xfadePlan.durSec}s；前 n−1 镜段长 +T 补偿，总长不变）`)
  } else if (transitionReq !== 'none') {
    ctx.log(
      `转场参数 ${transitionReq} 未生效（${!transitionUsable ? (mode === 'images' ? '镜头数不足 2' : 'motion_clips 模式不支持') : '值非法或时长无效'}），按 none 处理`,
    )
  }
  // [M11] BGM（run 级直查；_compose 覆盖模板 params；文件缺失跳过 + warn）
  const bgmVolume = clamp(composeCfg.bgm_volume ?? numParam(params['bgm_volume'], 0.25), 0, 1)
  const bgmFade = clamp(composeCfg.bgm_fade ?? numParam(params['bgm_fade'], 2), 0, Math.min(2, total / 2))
  const bgmAsset = await loadBgmAsset(ctx.run.id)
  let bgmPath: string | null = null
  if (bgmAsset) {
    if (bgmAsset.relPath && existsSync(absPathOf(bgmAsset.relPath))) bgmPath = absPathOf(bgmAsset.relPath)
    else ctx.log(`BGM 资产 #${bgmAsset.id} 文件缺失，已跳过混音`)
  }
  if (bgmPath) {
    ctx.log(`BGM 就绪：asset#${bgmAsset!.id}（音量 ${bgmVolume}${bgmFade > 0 ? `，淡入淡出 ${bgmFade}s` : ''}）`)
  }
  const coveredCount = segments.filter((s) => s.explicit).length
  ctx.log(
    segments[0]!.kind === 'image'
      ? `合成 ${segments.length} 张镜头图 → ${width}x${height}@${fps}fps（总 ${total}s${coveredCount > 0 ? `，其中 ${coveredCount} 张按分镜指定时长` : `，每张 ${durationPerShot}s`}）`
      : `合成 ${segments.length} 段镜头视频 → ${width}x${height}@${fps}fps（按实际时长，总 ${total}s）`,
  )
  if (voicePaths.length > 0) ctx.log(`混流 ${voicePaths.length} 句配音轨（连续拼接${needStretch ? '' : `，对齐总时长 ${total}s`}）`)
  const style = ((typeof params['subtitle_style'] === 'string' && params['subtitle_style'])
    || (typeof vidCfg['subtitle_style'] === 'string' && vidCfg['subtitle_style'])
    || defaultSubtitleStyle(height)).replace(/['"]/g, '')

  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  const ep = String(runInput['episode_number'] ?? Date.now()).padStart(3, '0')
  const outName = `ep${ep}-final-${Date.now()}.mp4`
  const outRel = relPathOf(ctx.run.projectId, 'final_video', outName)
  const outAbs = absPathOf(outRel)

  // [M11] 字幕对齐平移：cue ↔ 句序（= voices 序）；Δ 全 0 不写副本；数量不符不平移（原样烧录）
  let srtAbs: string | null = srtRelPath ? absPathOf(srtRelPath) : null
  let tempSrtAbs: string | null = null
  if (alignPlan && srtRelPath) {
    const shifts = planSrtShifts(alignPlan, voiceMetas.map((v) => v.lineId!))
    if (!shifts) {
      ctx.log(`字幕平移跳过（cue 数与配音句数 ${voiceMetas.length} 不符），SRT 原样烧录`)
    } else if (shifts.every((d) => d < 1e-3)) {
      ctx.log('字幕平移 Δ 全 0（无静音插入），直接使用原 SRT')
    } else {
      try {
        const shifted = shiftSrtText(await ctx.readText(subtitleIds[0]!), shifts)
        if (!shifted) {
          ctx.log(`字幕平移跳过（SRT cue 数与配音句数 ${voiceMetas.length} 不符），原样烧录`)
        } else {
          tempSrtAbs = join(dirname(outAbs), `.aligned-${ctx.run.id}-${Date.now()}.srt`)
          writeFileSync(tempSrtAbs, shifted, 'utf8')
          srtAbs = tempSrtAbs
          ctx.log(`字幕对齐平移：${shifts.length} 条 cue 重写（最大偏移 ${Math.max(...shifts).toFixed(2)}s，临时副本合成后清理）`)
        }
      } catch (err) {
        ctx.log(`字幕平移失败（原样烧录）：${(err as Error).message}`)
      }
    }
  }

  // 组装 filter_complex：段归一（+settb）→ xfade/concat → [basev]；(字幕) → subtitles → [outv]；
  // voices（+对齐静音段）→ [outa]；(BGM) → amix/anull → [aout]
  const inputArgs: string[] = []
  const fcParts: string[] = []
  segments.forEach((seg, i) => {
    const segLen = xfadePlan.enabled ? xfadePlan.videoLens[i]! : seg.durSec
    if (seg.kind === 'image') {
      inputArgs.push('-loop', '1', '-t', String(segLen), '-i', seg.path)
    } else {
      inputArgs.push('-i', seg.path)
    }
    fcParts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p${xfadePlan.enabled ? ',settb=AVTB' : ''}[v${i}]`,
    )
  })
  const segIn = segments.map((_, i) => `[v${i}]`).join('')
  const hasAudio = voicePaths.length > 0
  if (hasAudio) {
    voicePaths.forEach((p, i) => {
      inputArgs.push('-i', p)
      const srcIdx = segments.length + i
      fcParts.push(`[${srcIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`)
    })
    if (alignPlan) {
      // [M11] 对齐轨：按镜序 [句…, 镜尾静音(anullsrc)] concat（总长严格 = Σd；apad 兜底浮点）
      const items: string[] = []
      let silenceIdx = 0
      for (const ps of alignPlan.segments) {
        for (const lineId of ps.lineIds) {
          const vi = voiceMetas.findIndex((v) => v.lineId === lineId)
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
      fcParts.push(`${items.join('')}concat=n=${items.length}:v=0:a=1,apad=whole_dur=${totalStr}[outa]`)
    } else {
      const aIn = voicePaths.map((_, i) => `[a${i}]`).join('')
      // 连续轨：apad 补静音到视频总长；音频超长不裁剪（口播超时保内容，输出时长自然取 max）
      fcParts.push(`${aIn}concat=n=${voicePaths.length}:v=0:a=1,apad=whole_dur=${totalStr}[outa]`)
    }
  }
  // [M11] BGM 混音链：有主音轨 → amix 以主轨定长；无主音轨 → bgm 直接 [aout]
  if (bgmPath) {
    const bgmIdx = segments.length + voicePaths.length
    inputArgs.push('-stream_loop', '-1', '-i', bgmPath)
    const fadeDur = round3(bgmFade)
    let chain =
      `[${bgmIdx}:a]atrim=0:${totalStr},asetpts=PTS-STARTPTS,aresample=44100,`
      + `aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bgmVolume}`
    if (fadeDur > 0) {
      chain += `,afade=t=in:st=0:d=${fadeDur},afade=t=out:st=${round3(Math.max(0, total - bgmFade))}:d=${fadeDur}`
    }
    fcParts.push(`${chain}[bgm]`)
    fcParts.push(hasAudio ? '[outa][bgm]amix=inputs=2:duration=first:normalize=0[aout]' : '[bgm]anull[aout]')
  }
  const videoOut = srtAbs ? 'outv' : 'basev'
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
  } else {
    fcParts.push(`${segIn}concat=n=${segments.length}:v=1:a=0[basev]`)
  }
  if (srtAbs) {
    fcParts.push(
      `[basev]subtitles='${basename(srtAbs)}':force_style='${style}'[outv]`,
    )
  }

  const maps = ['-map', `[${videoOut}]`]
  const encAudio: string[] = []
  if (hasAudio || bgmPath) {
    maps.push('-map', bgmPath ? '[aout]' : '[outa]')
    encAudio.push('-c:a', 'aac', '-b:a', '192k')
  }
  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex',
    fcParts.join(';'),
    ...maps,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-r', String(fps),
    ...encAudio,
    '-movflags', '+faststart',
    outAbs,
  ]
  // subtitles filter 以相对路径（文件名）引用 SRT → cwd 指向其所在目录（对齐平移副本与输出同目录）
  const cwd = srtAbs ? dirname(srtAbs) : undefined

  ctx.log(
    `ffmpeg 开始合成（${segments.length} 段${hasAudio ? ' + 音频轨' : ''}${srtRelPath ? ' + 字幕' : ''}${bgmPath ? ' + BGM' : ''}${xfadePlan.enabled ? ' + 转场' : ''}）…`,
  )
  try {
    await runFfmpeg(ctx, ffmpeg, args, cwd)
  } finally {
    if (tempSrtAbs) {
      try {
        unlinkSync(tempSrtAbs)
      } catch {
        // 临时字幕清理失败不影响成片
      }
    }
  }
  const size = statSync(outAbs).size

  const tags = ['final']
  if (hasAudio) tags.push('with_audio')
  if (srtRelPath) tags.push('with_subtitle')
  const videoAsset = await registerAsset(ctx.run.projectId, {
    runId: ctx.run.id,
    name: outName,
    kind: 'video',
    purpose: 'final_video',
    relPath: outRel,
    mime: 'video/mp4',
    ext: 'mp4',
    fileSize: size,
    width,
    height,
    duration: Math.round(total),
    params: {
      fps,
      resolution,
      images: segments.filter((s) => s.kind === 'image').length,
      motion_clips: segments.filter((s) => s.kind === 'video').length,
      voices: voicePaths.length,
      subtitle: srtRelPath ? 1 : 0,
      subtitle_style: style,
      duration: Math.round(total * 1000) / 1000,
      // [M7] 输入快照（stale 检测数据源：与 output.asset_ids 同口径）+ 容错溯源（旧键全部保留不动）
      inputs: {
        images: mode === 'images' ? imageIds : null,
        motion_clips: mode === 'clips' ? clipIds : null,
        shots_source: shotsIds[0] ?? null,
      },
      skipped_shots: skipped,
      // [M11] 三增强溯源（禁用时记录原因，不影响既有语义）
      align: alignPlan
        ? { aligned: true, reason: null, lines: alignPlan.lines.length, shots: alignPlan.segments.length, total_dur: alignPlan.totalDur }
        : { aligned: false, reason: alignReason, lines: 0, shots: 0, total_dur: null },
      transition: { enabled: xfadePlan.enabled, type: xfadePlan.enabled ? xfadePlan.type : null, dur_sec: xfadePlan.enabled ? xfadePlan.durSec : null },
      bgm: bgmPath && bgmAsset ? { asset_id: bgmAsset.id, volume: bgmVolume, fade: bgmFade } : null,
    },
    tags,
    stepId: ctx.step.id,
  })
  ctx.log(`成片落盘 asset#${videoAsset.id} → ${outRel}（${Math.round(size / 1024 / 1024)} MB${hasAudio ? '，含音轨' : ''}${srtRelPath ? '，含字幕' : ''}）`)

  const assetIds = [videoAsset.id]
  if (wantCover) {
    const coverName = `ep${ep}-cover-${Date.now()}.jpg`
    const coverRel = relPathOf(ctx.run.projectId, 'thumbnail', coverName)
    const coverAbs = absPathOf(coverRel)
    await runFfmpeg(ctx, ffmpeg, ['-y', '-ss', '0.2', '-i', outAbs, '-frames:v', '1', '-q:v', '3', coverAbs])
    const coverAsset = await registerAsset(ctx.run.projectId, {
      runId: ctx.run.id,
      name: coverName,
      kind: 'image',
      purpose: 'thumbnail',
      relPath: coverRel,
      mime: 'image/jpeg',
      ext: 'jpg',
      fileSize: statSync(coverAbs).size,
      params: { sourceVideo: videoAsset.id },
      tags: ['cover'],
      stepId: ctx.step.id,
    })
    assetIds.push(coverAsset.id)
    ctx.log(`封面提取完成 asset#${coverAsset.id}`)
  }
  return { assetIds }
}

/**
 * [M7] 镜头段组装（纯函数；探针直测）——段组装 + 时长决策 + 容错判定收敛于此：
 * - 缺本地文件 / 文件缺失 / kind 不符 → skipped（不再整体失败；全 skip 由调用方拦抛）；
 * - 静态图：分镜 per-shot 覆盖优先（explicit 标记）→ duration_per_shot；
 * - 动效片：asset.duration → ffprobe → duration_per_shot 估算（estimated 标记）。
 */
export function computeShotSegments(
  rows: Asset[],
  mode: 'images' | 'clips',
  perShotDur: Map<string, number>,
  durationPerShot: number,
): { segments: Segment[]; skipped: number[] } {
  const segments: Segment[] = []
  const skipped: number[] = []
  for (const a of rows) {
    if (!a.relPath) {
      skipped.push(a.id)
      continue
    }
    const path = absPathOf(a.relPath)
    try {
      statSync(path)
    } catch {
      skipped.push(a.id)
      continue
    }
    if (mode === 'images') {
      if (a.kind !== 'image') {
        skipped.push(a.id)
        continue
      }
      const shotId = shotIdOfAsset(a)
      const override = shotId !== null ? perShotDur.get(shotId) : undefined
      segments.push({ id: a.id, path, kind: 'image', durSec: override ?? durationPerShot, explicit: override !== undefined })
    } else {
      if (a.kind !== 'video') {
        skipped.push(a.id)
        continue
      }
      let dur: number | null = typeof a.duration === 'number' && a.duration > 0 ? a.duration : null
      let estimated = false
      if (dur === null) {
        dur = probeMediaDuration(path)
        if (dur === null) {
          dur = durationPerShot
          estimated = true
        }
      }
      segments.push({ id: a.id, path, kind: 'video', durSec: dur, estimated })
    }
  }
  return { segments, skipped }
}

/** [M7] shots（分镜 JSON 原始文本）→ per-shot 时长表（裸数组 / {shots:[]}；duration 优先回退 duration_sec；非法条目跳过） */
export function parseShotDurations(raw: string): Map<string, number> {
  const map = new Map<string, number>()
  const obj = JSON.parse(raw) as unknown
  const arr = Array.isArray(obj) ? obj : (obj as { shots?: unknown }).shots
  if (!Array.isArray(arr)) return map
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const id = o['id']
    if (typeof id !== 'string' || !id) continue
    const dur = shotDurationSec(o)
    if (dur != null) map.set(id, dur)
  }
  return map
}

/** [M7] shots（分镜 JSON）→ per-shot 时长覆盖表（解析失败 → 空表 + 日志；无输入 → 空表） */
async function loadPerShotDurations(ctx: StepContext, shotsIds: number[]): Promise<Map<string, number>> {
  if (shotsIds.length === 0) return new Map()
  try {
    return parseShotDurations(await ctx.readText(shotsIds[0]!))
  } catch (err) {
    ctx.log(`分镜时长覆盖解析失败（回退全局 duration_per_shot）：${(err as Error).message}`)
    return new Map()
  }
}

/** 资产 params.shotId（分镜时长覆盖匹配键，与 ai_image/ai_video 产物口径一致） */
function shotIdOfAsset(a: Asset): string | null {
  if (!a.params) return null
  try {
    const p = JSON.parse(a.params) as { shotId?: unknown }
    return typeof p.shotId === 'string' && p.shotId ? p.shotId : null
  } catch {
    return null
  }
}

/** [M11] 配音资产 params.lineId（tts 产物句 id） */
function lineIdOfVoiceAsset(a: Asset): string | null {
  if (!a.params) return null
  try {
    const p = JSON.parse(a.params) as { lineId?: unknown }
    return typeof p.lineId === 'string' && p.lineId ? p.lineId : null
  } catch {
    return null
  }
}

/** [M11] 数值收敛（先下限后上限；hi < lo 时以 hi 收口——如极短片 fade 上限） */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi)
}

/** [M11] 保留 3 位小数（ffmpeg 参数文本防浮点尾数） */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** [M11] 分镜 JSON → 对齐输入（shots[].lines；hasLinesField = 至少一镜含该字段） */
export function parseShotLines(raw: string): { shots: AlignShotInput[]; hasLinesField: boolean } {
  const obj = JSON.parse(raw) as unknown
  const arr = Array.isArray(obj) ? obj : (obj as { shots?: unknown }).shots
  const shots: AlignShotInput[] = []
  let hasLinesField = false
  if (!Array.isArray(arr)) return { shots, hasLinesField }
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const id = o['id']
    if (typeof id !== 'string' || !id) continue
    const rawLines = o['lines']
    let lineIds: string[] = []
    if (Array.isArray(rawLines)) {
      hasLinesField = true
      lineIds = rawLines.filter((x): x is string => typeof x === 'string' && x.length > 0)
    }
    shots.push({ id, durationSec: shotDurationSec(o), lineIds })
  }
  return { shots, hasLinesField }
}

/** [M11] shots 资产 → 对齐输入（无输入/解析失败 → 空表） */
async function loadShotAlignShots(
  ctx: StepContext,
  shotsIds: number[],
): Promise<{ shots: AlignShotInput[]; hasLinesField: boolean }> {
  if (shotsIds.length === 0) return { shots: [], hasLinesField: false }
  try {
    return parseShotLines(await ctx.readText(shotsIds[0]!))
  } catch (err) {
    ctx.log(`分镜对齐解析失败（回退 M7 语义）：${(err as Error).message}`)
    return { shots: [], hasLinesField: false }
  }
}

/**
 * [M11] 音字对齐计划（§2.3 条件与决策表；纯函数，探针直测）：
 * - 校验：lines 字段存在 → 并集 == voiceDur 键集（无重复/幽灵/孤儿）；否则 reason 回退；
 * - 时长：带台词镜 Σ句和（explicit > Σ → explicit + 镜尾静音；explicit < Σ → Σ + warnShots）；
 *        空镜 explicit ?? fallbackDur；
 * - lines 双轴：speechStart（语音连续轴）/ timelineStart（成片轴），按「镜序 × 镜内序」。
 */
export function planVoiceAlignedSegments(
  shots: AlignShotInput[],
  voiceDur: Map<string, number>,
  fallbackDur: number,
  opts: { hasLinesField: boolean },
): AlignPlan {
  const fail = (reason: string): AlignPlan => ({ aligned: false, reason, segments: [], lines: [], totalDur: 0 })
  if (shots.length === 0) return fail('no_shots')
  if (voiceDur.size === 0) return fail('no_voices')
  if (!opts.hasLinesField) return fail('no_lines_field')
  const mapped = new Set<string>()
  for (const s of shots) {
    for (const id of s.lineIds) {
      if (mapped.has(id) || !voiceDur.has(id)) return fail('mapping_mismatch')
      mapped.add(id)
    }
  }
  if (mapped.size !== voiceDur.size) return fail('mapping_mismatch')
  const safeFallback = fallbackDur > 0 ? fallbackDur : 4
  const segments: AlignPlan['segments'] = []
  const lines: AlignLine[] = []
  const warnShots: string[] = []
  let speechCursor = 0
  let timelineCursor = 0
  for (const s of shots) {
    let durSec: number
    let silenceSec = 0
    const sum = s.lineIds.reduce((acc, id) => acc + voiceDur.get(id)!, 0)
    if (s.lineIds.length > 0) {
      if (s.durationSec != null && s.durationSec > sum) {
        durSec = s.durationSec
        silenceSec = s.durationSec - sum
      } else {
        durSec = sum
        if (s.durationSec != null && s.durationSec < sum) warnShots.push(s.id)
      }
    } else {
      durSec = s.durationSec != null && s.durationSec > 0 ? s.durationSec : safeFallback
      silenceSec = durSec
    }
    let inShot = 0
    for (const id of s.lineIds) {
      lines.push({
        lineId: id,
        speechStart: round3(speechCursor + inShot),
        timelineStart: round3(timelineCursor + inShot),
      })
      inShot += voiceDur.get(id)!
    }
    speechCursor += inShot
    segments.push({ shotId: s.id, durSec: round3(durSec), lineIds: [...s.lineIds], silenceSec: round3(silenceSec) })
    timelineCursor += durSec
  }
  return { aligned: true, segments, lines, totalDur: round3(timelineCursor), warnShots }
}

/** [M11] SRT 每 cue 平移秒数（cue ↔ 句序 = voices 序；任一缺失 → null = 不平移） */
export function planSrtShifts(align: AlignPlan, lineIdsInCueOrder: string[]): number[] | null {
  if (!align.aligned || lineIdsInCueOrder.length === 0) return null
  const byId = new Map(align.lines.map((l) => [l.lineId, l]))
  const shifts: number[] = []
  for (const id of lineIdsInCueOrder) {
    const line = byId.get(id)
    if (!line) return null
    shifts.push(round3(line.timelineStart - line.speechStart))
  }
  return shifts
}

/** [M11] SRT 时间戳（hh:mm:ss,mmm / 兼容 . 分隔）→ 秒 */
export function srtTsToSec(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
}

/** [M11] 秒 → SRT 时间戳（hh:mm:ss,mmm；负值收敛 0） */
export function secToSrtTs(sec: number): string {
  const totalMs = Math.round(Math.max(0, sec) * 1000)
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return (
    `${p2(Math.floor(totalMs / 3600000))}:${p2(Math.floor(totalMs / 60000) % 60)}:`
    + `${p2(Math.floor(totalMs / 1000) % 60)},${String(totalMs % 1000).padStart(3, '0')}`
  )
}

/** [M11] SRT 逐 cue 平移（保格式；cue 数与 shifts 不符 → null） */
export function shiftSrtText(srt: string, shifts: number[]): string | null {
  const timeRe = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/
  const lines = srt.split(/\r?\n/)
  let cueCount = 0
  for (const line of lines) {
    if (timeRe.test(line)) cueCount++
  }
  if (cueCount !== shifts.length) return null
  let cue = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = timeRe.exec(line)
    if (!m) continue
    const shift = shifts[cue]!
    cue++
    const start = srtTsToSec(m[1]!, m[2]!, m[3]!, m[4]!) + shift
    const end = srtTsToSec(m[5]!, m[6]!, m[7]!, m[8]!) + shift
    lines[i] = line.replace(timeRe, `${secToSrtTs(start)} --> ${secToSrtTs(end)}`)
  }
  return lines.join(srt.includes('\r\n') ? '\r\n' : '\n')
}

/**
 * [M11] 转场计划（§2.5 数学；纯函数，探针直测）：
 * - 禁用：n < 2 / transition = none / 非法值；
 * - T = clamp(durationSec, 0.1, min(2, min(d)))；前 n−1 镜段长 d+T（末镜 d）；
 * - offset o_k = V_k = Σ_{j≤k} d_j（k=1..n−1）；totalDur = Σd。
 */
export function buildTransitionPlan(durations: number[], transition: string, durationSec: number): TransitionPlan {
  const n = durations.length
  const totalDur = round3(durations.reduce((s, d) => s + d, 0))
  const disabled: TransitionPlan = {
    enabled: false,
    type: 'none',
    durSec: 0,
    videoLens: durations.slice(),
    offsets: [],
    totalDur,
  }
  if (n < 2) return disabled
  if (!(TRANSITIONS as readonly string[]).includes(transition) || transition === 'none') return disabled
  const minDur = Math.min(...durations)
  if (!(minDur > 0)) return disabled
  const durSec = round3(clamp(durationSec, 0.1, Math.min(2, minDur)))
  if (!(durSec > 0)) return disabled
  const videoLens = durations.map((d, i) => (i < n - 1 ? round3(d + durSec) : d))
  const offsets: number[] = []
  let acc = 0
  for (let k = 0; k < n - 1; k++) {
    acc = round3(acc + durations[k]!)
    offsets.push(acc)
  }
  return { enabled: true, type: transition, durSec, videoLens, offsets, totalDur: round3(acc + durations[n - 1]!) }
}

/** ffmpeg 执行：stderr 逐行 → step.log 事件；非零退出抛错（含尾部输出） */
function runFfmpeg(ctx: StepContext, ffmpeg: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, cwd })
    let tail = ''
    child.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8')
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        tail = trimmed.length > 300 ? trimmed.slice(-300) : trimmed
        emitStudioEvent({ type: 'step.log', runId: ctx.run.id, stepId: ctx.step.id, seq: Date.now(), chunk: trimmed })
      }
    })
    child.on('error', (err) => reject(new Error(`ffmpeg 启动失败: ${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出码 ${code}：${tail}`))
    })
  })
}
