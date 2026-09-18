import { spawn } from 'node:child_process'
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { probeMediaDuration, resolveFfmpeg } from '../../../services/ffmpeg'
import { absPathOf, registerAsset, relPathOf } from '../../../services/storage'
import { loadBgmAsset, loadSfxAssets, readComposeConfig, readMultiAspect } from '../../../services/compose-config'
import { assetInput, safeRecordExecSnapshot, type ExecInputSpec } from '../../../services/provenance'
import { resolveBrandConfig } from '../../../services/brand-config'
import { emitStudioEvent } from '../../../services/events'
import { defaultSubtitleStyle, buildSubtitleStyle } from './subtitle-style'
import { isSameAspect } from './aspect'
import { computeShotSegments, loadPerShotDurations, shotIdOfAsset, lineIdOfVoiceAsset } from './segments'
import { loadShotAlignShots, planVoiceAlignedSegments, planSrtShifts, countSrtCues, shiftSrtText } from './align'
import { buildTransitionPlan } from './transition'
import { planSfxStarts } from './sfx'
import { buildComposeArgs } from './args'
import { numParam, clamp, round3 } from './util'
import type { ComposeSfxInput } from './args'
import type { Segment } from './segments'
import type { AlignPlan } from './align'
import type { StepContext } from '../../context'
import type { StepResult } from '../../types'
import type { Asset } from '../../../db/schema'

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
 *   ④ [M19] per-shot 音效：每镜 ≤1 条（purpose=sfx）；起点 = Σ_{j<i} d_j + 片头位移（与 xfade offsets 同口径），
 *      adelay 注入 + 终混 amix（主轨/BGM 存在时 duration=first）；无绑定 → 音频链逐字节不变。
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
  const { segments, skipped, warnings } = computeShotSegments(rows, mode, perShotDur, durationPerShot)
  for (const w of warnings) ctx.log(w)
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
  // [M19] 品牌三层解析（平台/项目/run；无任何配置 → {}，全链保持现行为）
  const brand = await resolveBrandConfig(ctx.run.projectId, ctx.run.input)
  // 字幕样式采用链：结构化优先（brand.subtitle 非空 → 接管）；否则旧链逐字节不变
  const legacyStyle = (typeof params['subtitle_style'] === 'string' && params['subtitle_style'])
    || (typeof vidCfg['subtitle_style'] === 'string' && vidCfg['subtitle_style'])
  const style = brand.subtitle
    ? buildSubtitleStyle(height, brand.subtitle).replace(/['"]/g, '')
    : ((legacyStyle || defaultSubtitleStyle(height)) as string).replace(/['"]/g, '')
  if (brand.subtitle && legacyStyle) {
    ctx.log('结构化字幕配置已接管，subtitle_style 旧串被忽略')
  }

  // [M19] 品牌素材槽解析（水印/片头/片尾；时长探测失败 → 宽容跳过该槽，全链保持现行为）
  const watermarkArg = brand.watermark ?? null
  let introArg: { path: string; durSec: number } | null = null
  if (brand.intro) {
    const d = probeMediaDuration(brand.intro.path)
    if (d !== null && d > 0) introArg = { path: brand.intro.path, durSec: d }
    else ctx.log('片头时长探测失败，已跳过片头（检查品牌片头文件）')
  }
  let outroArg: { path: string; durSec: number } | null = null
  if (brand.outro) {
    const d = probeMediaDuration(brand.outro.path)
    if (d !== null && d > 0) outroArg = { path: brand.outro.path, durSec: d }
    else ctx.log('片尾时长探测失败，已跳过片尾（检查品牌片尾文件）')
  }
  if (introArg) ctx.log(`片头就绪：${round3(introArg.durSec)}s（来源 ${brand.intro!.source}），正片内容轴后移 +${round3(introArg.durSec)}s`)
  if (outroArg) ctx.log(`片尾就绪：${round3(outroArg.durSec)}s（来源 ${brand.outro!.source}）`)
  // [M19] per-shot 音效解析（run 级直查；每镜 ≤1 条；起点 = Σ_{j<i} d_j + 片头位移；缺文件跳过 + log）
  const sfxVolume = clamp(composeCfg.sfx_volume ?? 1, 0, 2)
  const sfxMap = await loadSfxAssets(ctx.run.id)
  let sfxList: ComposeSfxInput[] = []
  if (sfxMap.size > 0) {
    const { entries, missing } = planSfxStarts(
      segments.map((s) => s.durSec),
      segments.map((s) => {
        const a = rows.find((r) => r.id === s.id)
        return a ? shotIdOfAsset(a) : null
      }),
      [...sfxMap.entries()].map(([shotId, a]) => ({
        shotId,
        assetId: a.id,
        relPath: a.relPath,
        fileOk: !!a.relPath && existsSync(absPathOf(a.relPath)),
      })),
      introArg ? round3(introArg.durSec) : 0,
    )
    for (const m of missing) ctx.log(`音效资产 #${m.assetId}（镜 ${m.shotId}）文件缺失，已跳过该条`)
    sfxList = entries.map((e) => ({ path: absPathOf(e.relPath), startSec: e.startSec }))
    if (sfxList.length > 0) ctx.log(`逐镜音效就绪：${sfxList.length} 条（音量 ${sfxVolume}）`)
  }

  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  const ep = String(runInput['episode_number'] ?? Date.now()).padStart(3, '0')
  const outName = `ep${ep}-final-${Date.now()}.mp4`
  const outRel = relPathOf(ctx.run.projectId, 'final_video', outName)
  const outAbs = absPathOf(outRel)
  // [M19] 多画幅原生渲染目标（与主画幅同比例者剔除；派生件落 video/ 子目录 purpose=final_video_derived）
  const multiAspect = readMultiAspect(composeCfg)
  const maTargets = multiAspect
    ? multiAspect.aspects
        .filter((a) => !isSameAspect(width, height, a))
        .map((a) => ({
          aspect: a,
          outAbs: absPathOf(relPathOf(ctx.run.projectId, 'final_video_derived', `ep${ep}-final-${a.replace(':', 'x')}-${Date.now()}.mp4`)),
        }))
    : []
  // [M19] 封面抽取点：有片头 → 片头时长 + 0.2s；否则 0.2s（现行为）
  const coverAt = introArg ? round3(introArg.durSec + 0.2) : 0.2

  // [M11/M19] 字幕平移：对齐逐 cue（cue ↔ 句序 = voices 序）与片头统移合并为一次重写；
  // Δ 全 0 不写副本；数量不符不平移（原样烧录）；无片头且无对齐 → 不进入（零 diff）
  const introShift = introArg ? round3(introArg.durSec) : 0
  let srtAbs: string | null = srtRelPath ? absPathOf(srtRelPath) : null
  let tempSrtAbs: string | null = null
  if (srtRelPath && (alignPlan || introShift > 0)) {
    let shifts: number[] | null = null
    let alignMode = false
    if (alignPlan) {
      const alignShifts = planSrtShifts(alignPlan, voiceMetas.map((v) => v.lineId!))
      if (alignShifts) {
        alignMode = true
        shifts = introShift > 0 ? alignShifts.map((d) => round3(d + introShift)) : alignShifts
      } else if (introShift > 0) {
        ctx.log(`字幕对齐平移跳过（cue 数与配音句数 ${voiceMetas.length} 不符），改按片头统移`)
      } else {
        ctx.log(`字幕平移跳过（cue 数与配音句数 ${voiceMetas.length} 不符），SRT 原样烧录`)
      }
    }
    if (!shifts && introShift > 0) {
      try {
        const cues = countSrtCues(await ctx.readText(subtitleIds[0]!))
        if (cues > 0) shifts = new Array<number>(cues).fill(introShift)
        else ctx.log('字幕片头位移跳过（SRT 无有效 cue 行），原样烧录')
      } catch (err) {
        ctx.log(`字幕片头位移失败（原样烧录）：${(err as Error).message}`)
      }
    }
    if (shifts) {
      if (shifts.every((d) => d < 1e-3)) {
        ctx.log('字幕平移 Δ 全 0（无静音插入），直接使用原 SRT')
      } else {
        try {
          const shifted = shiftSrtText(await ctx.readText(subtitleIds[0]!), shifts)
          if (!shifted) {
            ctx.log(`字幕平移跳过（SRT cue 数与配音句数 ${voiceMetas.length} 不符），原样烧录`)
          } else {
            tempSrtAbs = join(dirname(outAbs), `${alignMode ? '.aligned-' : '.intro-'}${ctx.run.id}-${Date.now()}.srt`)
            writeFileSync(tempSrtAbs, shifted, 'utf8')
            srtAbs = tempSrtAbs
            ctx.log(
              alignMode
                ? `字幕对齐平移：${shifts.length} 条 cue 重写（最大偏移 ${Math.max(...shifts).toFixed(2)}s${introShift > 0 ? '，含片头位移' : ''}，临时副本合成后清理）`
                : `字幕片头位移：${shifts.length} 条 cue 统移 +${introShift}s（临时副本合成后清理）`,
            )
          }
        } catch (err) {
          ctx.log(`字幕平移失败（原样烧录）：${(err as Error).message}`)
        }
      }
    }
  }

  // 组装 filter_complex 与编码参数（[M19] 提炼 buildComposeArgs 纯函数；无水印/片头尾 → 与 M11 逐字节一致）
  const hasAudio = voicePaths.length > 0
  const { args, cwd, totalAll, derived } = buildComposeArgs({
    segments,
    width,
    height,
    fps,
    xfadePlan,
    voicePaths,
    lineIds: voiceMetas.map((v) => v.lineId!),
    alignPlan,
    total,
    srtAbs,
    style,
    bgmPath,
    bgmVolume,
    bgmFade,
    watermark: watermarkArg,
    intro: introArg,
    outro: outroArg,
    sfx: sfxList,
    sfxVolume,
    multiAspect:
      multiAspect && maTargets.length > 0
        ? { strategy: multiAspect.strategy, targets: maTargets, subtitleCfg: brand.subtitle ?? null }
        : undefined,
    outAbs,
  })
  if (derived.length > 0) {
    ctx.log(
      `多画幅原生渲染：主 ${width}x${height} + 派生 ${derived.map((d) => `${d.aspect}(${d.width}x${d.height})`).join('、')}`
        + `（策略 ${multiAspect!.strategy}，编码 ×${derived.length + 1}，耗时相应增加）`,
    )
  }

  ctx.log(
    `ffmpeg 开始合成（${segments.length} 段${hasAudio ? ' + 音频轨' : ''}${srtRelPath ? ' + 字幕' : ''}${bgmPath ? ' + BGM' : ''}${xfadePlan.enabled ? ' + 转场' : ''}${watermarkArg ? ' + 水印' : ''}${introArg ? ' + 片头' : ''}${outroArg ? ' + 片尾' : ''}${sfxList.length > 0 ? ` + 音效×${sfxList.length}` : ''}）…`,
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
    duration: Math.round(totalAll),
    params: {
      fps,
      resolution,
      images: segments.filter((s) => s.kind === 'image').length,
      motion_clips: segments.filter((s) => s.kind === 'video').length,
      voices: voicePaths.length,
      subtitle: srtRelPath ? 1 : 0,
      subtitle_style: style,
      duration: Math.round(totalAll * 1000) / 1000,
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
      // [M19] 品牌溯源（无配置 → null；duration = 含片头尾总长）
      watermark: watermarkArg
        ? { position: watermarkArg.position, opacity: watermarkArg.opacity, width_pct: watermarkArg.width_pct, source: watermarkArg.source }
        : null,
      intro: introArg ? { source: brand.intro!.source, duration: round3(introArg.durSec) } : null,
      outro: outroArg ? { source: brand.outro!.source, duration: round3(outroArg.durSec) } : null,
      sfx: sfxList.length > 0 ? { count: sfxList.length, volume: sfxVolume } : null,
    },
    tags,
    stepId: ctx.step.id,
  })
  ctx.log(`成片落盘 asset#${videoAsset.id} → ${outRel}（${Math.round(size / 1024 / 1024)} MB${hasAudio ? '，含音轨' : ''}${srtRelPath ? '，含字幕' : ''}${introArg || outroArg ? '，含片头尾' : ''}）`)

  const assetIds = [videoAsset.id]
  if (wantCover) {
    const coverName = `ep${ep}-cover-${Date.now()}.jpg`
    const coverRel = relPathOf(ctx.run.projectId, 'thumbnail', coverName)
    const coverAbs = absPathOf(coverRel)
    await runFfmpeg(ctx, ffmpeg, ['-y', '-ss', String(coverAt), '-i', outAbs, '-frames:v', '1', '-q:v', '3', coverAbs])
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
  // [M19] 多画幅派生件落资产（单路异常仅 warn，不影响成片与封面结果）
  for (const d of derived) {
    try {
      if (!existsSync(d.outAbs)) {
        ctx.log(`派生画幅 ${d.aspect} 产物缺失，已跳过落资产`)
        continue
      }
      const dName = basename(d.outAbs)
      const derivedAsset = await registerAsset(ctx.run.projectId, {
        runId: ctx.run.id,
        name: dName,
        kind: 'video',
        purpose: 'final_video_derived',
        relPath: relPathOf(ctx.run.projectId, 'final_video_derived', dName),
        mime: 'video/mp4',
        ext: 'mp4',
        fileSize: statSync(d.outAbs).size,
        width: d.width,
        height: d.height,
        duration: Math.round(totalAll),
        params: {
          native: true,
          aspect: d.aspect,
          strategy: multiAspect!.strategy,
          source: 'multi_render',
          fps,
          resolution: `${d.width}x${d.height}`,
          duration: round3(totalAll),
        },
        tags: ['final', 'derived', d.aspect.replace(':', 'x')],
        stepId: ctx.step.id,
      })
      assetIds.push(derivedAsset.id)
      ctx.log(`派生画幅落盘 asset#${derivedAsset.id} ${d.aspect}（${d.width}x${d.height}）→ ${dName}`)
    } catch (err) {
      ctx.log(`派生画幅 ${d.aspect} 落资产失败（不影响成片）：${(err as Error).message}`)
    }
  }
  // [M29·R02] 合成执行真实输入快照：镜头媒体/配音/字幕/BGM + 分镜 JSON 文本（版本指针），按 shotId 定位
  await recordMergeProvenance(ctx, {
    rows,
    usedSegments: segments,
    skipped,
    voiceIds: voiceMetas.map((v) => v.assetId),
    subtitleIds,
    bgmAssetId: bgmAsset?.id ?? null,
    shotsAssetId: shotsIds[0] ?? null,
  })
  return { assetIds }
}

/**
 * [M29·R02] 合成输入旁路快照（失败仅告警，不触碰 buildComposeArgs 零漂移红线与成片产物）。
 * 媒体资产不可变→ versionId=null（身份即资产 id）；分镜 JSON 为可编辑文本→携版本指针（编辑分镜→下游成片可报）。
 */
async function recordMergeProvenance(
  ctx: StepContext,
  p: {
    rows: Asset[]
    usedSegments: Array<{ id: number }>
    skipped: number[]
    voiceIds: number[]
    subtitleIds: number[]
    bgmAssetId: number | null
    shotsAssetId: number | null
  },
): Promise<void> {
  try {
    const inputs: ExecInputSpec[] = []
    const byId = new Map(p.rows.map((a) => [a.id, a]))
    let ordinal = 0
    for (const seg of p.usedSegments) {
      const a = byId.get(seg.id)
      const shotId = a ? shotIdOfAsset(a) : null
      inputs.push(await assetInput('source', seg.id, { shotId, port: 'images', ordinal: ordinal++ }))
    }
    for (const id of p.skipped) inputs.push(await assetInput('source', id, { used: false, skipReason: '缺文件或类型不符', port: 'images' }))
    for (let i = 0; i < p.voiceIds.length; i++) inputs.push(await assetInput('voice', p.voiceIds[i]!, { ordinal: i }))
    for (const id of p.subtitleIds.slice(0, 1)) inputs.push(await assetInput('subtitle', id))
    if (p.bgmAssetId != null) inputs.push(await assetInput('bgm', p.bgmAssetId))
    if (p.shotsAssetId != null) inputs.push(await assetInput('text', p.shotsAssetId))
    await safeRecordExecSnapshot({
      projectId: ctx.run.projectId,
      execKind: 'pipeline_step',
      runId: ctx.run.id,
      stepId: ctx.step.id,
      templateKey: ctx.def.key,
      inputs,
    })
  } catch (err) {
    ctx.log(`执行快照记录失败（已忽略，不影响合成）：${(err as Error).message}`)
  }
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

export { defaultSubtitleStyle, toAssColor, buildSubtitleStyle } from './subtitle-style'
export { watermarkOverlayXY } from './watermark'
export { resolveAspectSize, aspectGeometryFilter, isSameAspect } from './aspect'
export { computeShotSegments, parseShotDurations } from './segments'
export { parseShotLines, planVoiceAlignedSegments, planSrtShifts, srtTsToSec, secToSrtTs, countSrtCues, shiftSrtText } from './align'
export { buildTransitionPlan } from './transition'
export { planSfxStarts } from './sfx'
export { buildComposeArgs } from './args'
export type { AlignShotInput, AlignLine, AlignPlan } from './align'
export type { TransitionPlan } from './transition'
export type { ComposeWatermarkInput, ComposeClipInput, ComposeSfxInput, ComposeArgsInput, ComposeDerivedOutput, ComposeArgsResult } from './args'
