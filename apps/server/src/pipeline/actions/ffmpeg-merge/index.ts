import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { probeMediaDuration, resolveFfmpeg } from '../../../services/ffmpeg'
import { absPathOf, registerAsset, relPathOf } from '../../../services/storage'
import { loadBgmAsset, loadAssetById, loadSfxAssets, readComposeConfig, readMultiAspect } from '../../../services/compose-config'
import { readVersionContent } from '../../../services/provenance'
import { resolveBrandConfig } from '../../../services/brand-config'
import { defaultSubtitleStyle, buildSubtitleStyle } from './subtitle-style'
import { srtToAss } from './subtitle-ass'
import { isSameAspect, resolveAspectSize } from './aspect'
import { computeShotSegments, loadPerShotDurations, shotIdOfAsset, lineIdOfVoiceAsset, buildClipDurByShotId } from './segments'
import { loadShotAlignShots, planBestEffortTimeline } from './align'
import { buildTransitionPlan } from './transition'
import { buildEditTimeline, type EditTimelineSubtitle } from './timeline-snapshot'
import { planEffectiveSubtitle } from './effective-subtitle'
import { computeFingerprintForComposeRecheck } from '../../../services/rework/baseline'
import { loadManualDisplay, planDisplaySubtitle, tryNoBurnManualRecompose } from './manual-display'
import { planSfxStarts } from './sfx'
import { buildComposeArgs } from './args'
import { numParam, clamp, round3 } from './util'
import { runFfmpeg } from './exec'
import { recordMergeProvenance } from './merge-provenance'
import type { ComposeSfxInput } from './args'
import type { Segment } from './segments'
import type { AlignPlan } from './align'
import type { StepContext } from '../../context'
import type { StepResult } from '../../types'
import type { Asset } from '../../../db/schema'
import { recipeOf, isCreationTemplate } from '../../../services/creation-chat/recipe'
import { hashJson } from '../../../services/creation-chat/contract'
import { validatedDialogueClip } from '../../../services/creation-chat/dialogue-cache'
import { dialogueSrt, estimateDialogueClip, estimatedDialogueSrt, estimatedValidationHash, inspectDialogueMedia, type EstimatedDialogueClip } from '../../../services/creation-chat/dialogue-media'
import { strictVoicePlan, strictSegments, assertStrictSrt, assertStrictOutput } from './strict'

/**
 * ffmpeg_merge：镜头序列 → 成片 + 封面（spec §5.4 三流合成）。
 * 镜头输入双字段互斥：images（静态图，-loop 1 -t duration_per_shot 定长）或
 * motion_clips（ai_video 产物，按实际时长 concat，不 -t/不 -loop）。
 * 可选 voices（audio 资产序列，逐句 concat 连续轨 → apad/atrim 对齐总时长，aac）；
 * 可选 subtitle（SRT 资产，视频流经 subtitles 滤镜烧录，force_style 参数化）。
 * 时间轴：镜头实际时长优先（video 资产 duration 字段，缺失时 ffprobe 探测兜底）；
 * 静态图回退 duration_per_shot（默认 4s）。产物 tags 增 'with_audio'/'with_subtitle'。
 * fit_voice=true 且为多镜静态图 + 配音时：按配音总长分配每镜时长（成片与音轨等长）。
 * 可选 shots（分镜 JSON）输入：静态图 per-shot 时长覆盖；逐镜容错（缺文件/类型不符 skip+warn，
 * 全 skip 才失败）；产物 params 增 inputs 快照（stale 检测）与 skipped_shots；fit_voice 显式时长优先。
 * 三增强（均可组合；失败即回退既有行为）：
 *   ① 音字对齐：shots[].lines ↔ voice.params.lineId 映射一致时，每镜时长 = 句和（显式 > 句和补镜尾静音）/
 *      空镜 explicit??duration_per_shot，音频轨按镜序 [句…,静音] concat，SRT 平移后烧录；
 *   ② BGM：run 级直查（loadBgmAsset）循环铺满（atrim 到 total）+ volume + afade + amix；
 *   ③ 转场：xfade 链（前 n-1 镜段长 +T 补偿，offset = V_k，总长仍 Σd）；_compose 覆盖 transition/bgm_*。
 *   ④ per-shot 音效：每镜 ≤1 条（purpose=sfx）；起点 = Σ_{j<i} d_j + 片头位移（与 xfade offsets 同口径），
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
  const strict = params['strict_delivery'] === true
  const recipe = strict ? recipeOf(ctx.run) : null
  const dialogue = recipe?.plan.performance === 'dialogue'
  if (strict && !recipe) throw new Error('严格合成缺少批准方案')
  const vidCfg = (ctx.settings.video ?? {}) as Record<string, unknown>
  const fps = numParam(params['fps'] ?? vidCfg['fps'], 25)
  const resolution = recipe ? ({ '9:16': '720x1280', '16:9': '1280x720', '1:1': '720x720' }[recipe.plan.aspectRatio]) :
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
  // shots（分镜 JSON）→ per-shot 时长覆盖表（v6 存量 run 无此输入 → 空表 = 行为不变）
  const shotsIds = ctx.assetIdsOf('shots')
  const perShotDur = await loadPerShotDurations(ctx, shotsIds)
  // [切片2b] 镜头时长本地返修：_compose.shot_durations 覆盖分镜 per-shot 显示时长（零重生媒体、零付费）。
  // 两条互斥生效路径：① 无对白/未对齐→经此 perShotDur（仅 images 分支消费，motion clips 段长=clip 实测不受影响）；
  // ② 音频对齐→经下方 alignShots[].durationSec（plan 会在映射一致时回写 seg.durSec）。motion 已在预览 blocked，此处按模式防御性跳过。
  const shotDurOverride = readComposeConfig(ctx.run.input).shot_durations ?? {}
  if (mode === 'images') {
    for (const [sid, sec] of Object.entries(shotDurOverride)) {
      if (typeof sec === 'number' && Number.isFinite(sec) && sec > 0) perShotDur.set(sid, sec)
    }
  }
  const { segments, skipped, warnings } = recipe
    ? { segments: strictSegments(recipe.plan, rows, ctx.run.projectId), skipped: [] as number[], warnings: [] as string[] }
    : computeShotSegments(rows, mode, perShotDur, durationPerShot)
  // 对白 clips 双路线：strict = ASR 逐字核验缓存复用（validatedDialogueClip）；estimated = 本步实测视频 + 来源校验同源重算（零付费）
  const dialogueClips: Array<Awaited<ReturnType<typeof validatedDialogueClip>> | EstimatedDialogueClip> | null = dialogue && recipe
    ? recipe.estimatedDialogue
      ? recipe.plan.shots.map((shot, i) => estimateDialogueClip(recipe.plan, shot.id, rows[i]!, ctx.run.projectId))
      : await Promise.all(recipe.plan.shots.map((shot, i) => validatedDialogueClip(recipe, shot.id, rows[i]!, ctx.run.projectId)))
    : null
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
  // voices：tts 产物逐句 concat 为连续音轨； 逐句 meta（lineId/durSec）供对齐/fit_voice/撑长共用
  const voiceIds = ctx.assetIdsOf('voices')
  const voicePaths: string[] = []
  const voiceMetas: Array<{ assetId: number; lineId: string | null; durSec: number | null; relPath: string | null; text: string }> = []
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
        // 快照附加字段（仅入 timeline，不参与既有对齐/混流逻辑）
        relPath: a.relPath,
        text: a.prompt ?? '',
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
    ctx.log(`字幕就绪 ${basename(srtRelPath)}（SRT 时间轴${srtEndMs ? `，末条结束 ${Math.round(srtEndMs / 1000)}s` : ''}）`)
  } else if (params['subtitle'] === true) {
    ctx.log('subtitle=true 但 inputs.subtitle 无 SRT 资产，已跳过烧录')
  }

  // 音字对齐尝试（静态图与动效统一：voices 全带 lineId/时长 + 分镜 lines，best-effort 命中镜即产出 canonical 计划）：
  // 逐镜时长 images=句和（显式>句和→镜尾静音）/ motion=真实 clip 时长（不拉伸）/ 空镜 explicit??duration_per_shot；幽灵句跳过不整体回退；失败回退既有语义
  let alignPlan: AlignPlan | null = null
  // 回退原因：no_voices / no_lineid / 计划 reason(no_lines_field等) / mapping_incomplete（成功路径：aligned / partial_mapped / motion_aligned）
  let alignReason = 'not_applicable'
  if (dialogueClips && recipe) {
    if (voiceIds.length || !srtRelPath || subtitleIds.length !== 1) throw new Error('人物对白必须使用原声和配套字幕，禁止混入 TTS')
    const [subtitle] = await ctx.assetsOf(subtitleIds)
    // expected 与 validationHash 均按路线同源重算：陈旧/跨路线字幕一律拒绝（语义与 strict 现状一致）
    const estimated = recipe.estimatedDialogue === true
    const expected = estimated
      ? estimatedDialogueSrt(recipe.plan, dialogueClips as EstimatedDialogueClip[])
      : dialogueSrt(dialogueClips as Awaited<ReturnType<typeof validatedDialogueClip>>[])
    const validationHash = estimated
      ? estimatedValidationHash(dialogueClips as EstimatedDialogueClip[])
      : hashJson({ policy: recipe.asr!.policy, clips: dialogueClips })
    if (!subtitle || subtitle.projectId !== ctx.run.projectId || subtitle.deletedAt !== null || subtitle.kind !== 'text'
      || JSON.parse(subtitle.params ?? '{}').validationHash !== validationHash || readFileSync(absPathOf(srtRelPath), 'utf8') !== expected) {
      throw new Error('对白字幕与当前原声不匹配，禁止使用陈旧字幕')
    }
    alignReason = 'native_dialogue'
  } else if (recipe) {
    alignPlan = strictVoicePlan(recipe.plan, await ctx.assetsOf(voiceIds), ctx.run.projectId)
    if (!srtRelPath || subtitleIds.length !== 1) throw new Error('严格交付缺少字幕')
    assertStrictSrt(absPathOf(srtRelPath), recipe.plan, alignPlan, await ctx.assetsOf(voiceIds))
  } else if (voiceMetas.length === 0) {
    alignReason = 'no_voices'
  } else if (!voiceMetas.every((v) => v.lineId !== null && v.durSec !== null && v.durSec > 0)) {
    alignReason = 'no_lineid'
  } else {
    const planMode: 'images' | 'motion' = mode === 'images' ? 'images' : 'motion'
    const { shots: alignShots, hasLinesField } = await loadShotAlignShots(ctx, shotsIds)
    // [切片2b] 音频对齐路径：用 shot_durations 覆盖分镜显式时长（仅 images；motion 预览已 blocked，按 planMode 防御性跳过）。
    // 不改 planBestEffortTimeline 纯函数语义——覆盖仅作用于喂入的 durationSec，Σ-clamp（请求<句和→落句和）/字幕位置由既有算法同源重算。
    if (planMode === 'images') {
      for (const s of alignShots) {
        const sec = shotDurOverride[s.id]
        if (typeof sec === 'number' && Number.isFinite(sec) && sec > 0) s.durationSec = sec
      }
    }
    const voiceDur = new Map(voiceMetas.map((v) => [v.lineId!, v.durSec!]))
    const clipDurByShotId = planMode === 'motion' ? buildClipDurByShotId(segments, rows) : undefined
    const plan = planBestEffortTimeline(alignShots, voiceDur, durationPerShot, { hasLinesField, mode: planMode, clipDurByShotId })
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
        alignReason = planMode === 'motion' ? 'motion_aligned' : plan.partial ? 'partial_mapped' : 'aligned'
        const silentShots = plan.segments.filter((s) => s.lineIds.length === 0).length
        ctx.log(
          `音字对齐启用（${planMode}）：${plan.segments.length} 镜 × ${plan.lines.length} 句映射一致（无台词镜 ${silentShots} 个），成片总长 ${plan.totalDur.toFixed(2)}s`,
        )
        if (plan.warnLines && plan.warnLines.length > 0) {
          ctx.log(`同源时间轴启用（部分命中）：${plan.warnLines.length} 句缺实测配音（${plan.warnLines.join('、')}）——已跳过该句，命中镜仍按同源平移`)
        }
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
  // 基准取「该镜当前时长」（分镜显式覆盖 ?? 全局）；有字幕以字幕末时间（估时）为准；无字幕则实测音频总长
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
  // 显式优先：分镜 JSON 指定时长（explicit）的镜固定不参与均分，剩余配音时长均分给无显式镜；
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
  // 转场计划（仅静态图 ≥2 镜生效；_compose 覆盖模板 params；禁用时 filter 与既有实现逐字节一致）
  const composeCfg = readComposeConfig(ctx.run.input)
  const transitionReq = strict ? 'none' : composeCfg.transition ?? (typeof params['transition'] === 'string' ? params['transition'] : 'none')
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
  // BGM（非严格 run 级直查；_compose 覆盖模板 params；文件缺失跳过 + warn）
  const bgmVolume = clamp(composeCfg.bgm_volume ?? numParam(params['bgm_volume'], dialogue ? 0.1 : 0.25), 0, dialogue ? 0.12 : 1)
  const bgmFade = clamp(composeCfg.bgm_fade ?? numParam(params['bgm_fade'], 2), 0, Math.min(2, total / 2))
  // 严格合成 BGM 窄口径 opt-in：仅方案批准 role:'bgm' 时放行用户上传/已存在 BGM；
  // 默认（无 bgm ref）仍无 BGM（逐字节不变，不违反「不生成 BGM」——此处为使用用户素材）
  let bgmAsset: Asset | null
  if (strict) {
    const bgmRef = recipe?.refs.find((r) => r.role === 'bgm')
    bgmAsset = bgmRef ? await loadAssetById(bgmRef.assetId) : null
  } else {
    bgmAsset = await loadBgmAsset(ctx.run.id)
  }
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
  // 品牌三层解析（平台/项目/run；无任何配置 → {}，全链保持现行为）
  // 严格合成本向不叠加品牌（brand={}）；现仅对轻松创作模板放开“默认继承”，
  // 且确认卡可逐次关（_compose.brandApply=false）；非创建类严格 run 维持 brand={} 不变；未配品牌→{} 逐字节不变。
  const brand = (!strict || (isCreationTemplate(ctx.run.templateKey) && composeCfg.brandApply !== false))
    ? await resolveBrandConfig(ctx.run.projectId, ctx.run.input)
    : {}
  // 字幕样式采用链：结构化优先（brand.subtitle 非空 → 接管）；否则旧链逐字节不变
  const legacyStyle = (typeof params['subtitle_style'] === 'string' && params['subtitle_style'])
    || (typeof vidCfg['subtitle_style'] === 'string' && vidCfg['subtitle_style'])
  const style = brand.subtitle
    ? buildSubtitleStyle(height, brand.subtitle).replace(/['"]/g, '')
    : ((legacyStyle || defaultSubtitleStyle(height)) as string).replace(/['"]/g, '')
  if (brand.subtitle && legacyStyle) {
    ctx.log('结构化字幕配置已接管，subtitle_style 旧串被忽略')
  }

  // 品牌素材槽解析（水印/片头/片尾；时长探测失败 → 宽容跳过该槽，全链保持现行为）
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
  // per-shot 音效解析（run 级直查；每镜 ≤1 条；起点 = Σ_{j<i} d_j + 片头位移；缺文件跳过 + log）
  const sfxVolume = clamp(composeCfg.sfx_volume ?? 1, 0, 2)
  const sfxMap = strict ? new Map<string, Asset>() : await loadSfxAssets(ctx.run.id)
  let sfxList: ComposeSfxInput[] = []
  // 快照专用：entries 补 shotId（不改动 sfxList 既有形状）
  const sfxSnap: Array<{ shotId: string | null; assetId: number; startSec: number; relPath: string }> = []
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
    for (const e of entries) {
      let sid: string | null = null
      for (const [k, a] of sfxMap) if (a.id === e.assetId) { sid = k; break }
      sfxSnap.push({ shotId: sid, assetId: e.assetId, startSec: e.startSec, relPath: e.relPath })
    }
    if (sfxList.length > 0) ctx.log(`逐镜音效就绪：${sfxList.length} 条（音量 ${sfxVolume}）`)
  }

  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  const ep = String(runInput['episode_number'] ?? Date.now()).padStart(3, '0')
  const outName = `ep${ep}-final-${Date.now()}.mp4`
  const outRel = relPathOf(ctx.run.projectId, 'final_video', outName)
  const outAbs = absPathOf(outRel)
  // 多画幅原生渲染目标（与主画幅同比例者剔除；派生件落 video/ 子目录 purpose=final_video_derived）
  const multiAspect = strict ? null : readMultiAspect(composeCfg)
  const maTargets = multiAspect
    ? multiAspect.aspects
        .filter((a) => !isSameAspect(width, height, a))
        .map((a) => ({
          aspect: a,
          outAbs: absPathOf(relPathOf(ctx.run.projectId, 'final_video_derived', `ep${ep}-final-${a.replace(':', 'x')}-${Date.now()}.mp4`)),
        }))
    : []
  // 封面抽取点：有片头 → 片头时长 + 0.2s；否则 0.2s（现行为）
  const coverAt = introArg ? round3(introArg.durSec + 0.2) : 0.2

  // 显示字幕规划（§6.2 接管至 manual-display：人工修订前置分支 + 原逐句/片头平移逻辑逐字节保持；
  // 烧录开关 _compose.subtitleBurn=false → 不喂字幕滤镜，srtRelPath 仍供对白/严格校验与快照使用）
  const introShift = introArg ? round3(introArg.durSec) : 0
  const subtitleBurn = composeCfg.subtitleBurn !== false
  const manual = await loadManualDisplay({
    runInput: ctx.run.input,
    stepKey: ctx.def.key,
    readVersion: async (id) => { const v = await readVersionContent(id); if (v.kind !== 'text') throw new Error(`人工字幕修订版本 #${id} 非文本内容，已拒绝合成`); return v.text },
    recheckFingerprint: () => computeFingerprintForComposeRecheck(ctx.run.id, ctx.def.key),
    log: (msg) => ctx.log(msg),
  })
  const dplan = await planDisplaySubtitle({
    strict, srtRelPath, subtitleBurn, alignPlan,
    voiceLineIds: voiceMetas.map((v) => v.lineId!), voiceCount: voiceMetas.length,
    introShift, readSource: () => ctx.readText(subtitleIds[0]!),
    outDir: dirname(outAbs), runId: ctx.run.id, manual, log: (msg) => ctx.log(msg),
  })
  const srtAbs = dplan.srtAbs
  const tempSrtAbs = dplan.tempSrtAbs
  const srtShiftedText = dplan.shiftedText

  // SRT → ASS 转换：内置 ffmpeg 的 libass 不支持 CJK 换行 + force_style 吃 SRT 时按默认小
  // PlayResY 二次放大字号 → 长句横向冲出画面。改为生成显式 PlayResX/Y=输出尺寸的 ASS 喂 subtitles
  // 滤镜（force_style 仍生效、args 结构不变）：字号回归真实像素、左右边距由 ASS Style 提供、超长行 \\N 预换行。
  // 多画幅各路 PlayRes 不同 → 主 + 每派生路各生成一份 ASS。
  // 严格交付同样溢出 → 一并启用：仅生成烧录用 ASS 副本喂滤镜，不改原 SRT 资产；
  // assertStrictSrt 校验的是原始 SRT（本块之前已跑），\N 换行只拆行不减字，成片时长/音轨不变（assertStrictOutput 不受影响）。
  const assTempAbs: string[] = []
  let subtitlePaths: string[] | undefined
  if (srtAbs && srtRelPath) {
    try {
      const fsFromStyle = (s: string, fb: number): number => {
        const m = /FontSize=([\d.]+)/.exec(s)
        return m ? Number(m[1]) : fb
      }
      const rawSrt = readFileSync(srtAbs, 'utf8')
      const mainFontSize = fsFromStyle(style, Math.max(16, Math.round(height * 0.04)))
      const assDir = dirname(srtAbs)
      const stamp = Date.now()
      const writeAss = (w: number, h: number, fontSize: number, tag: string): string => {
        const ass = srtToAss(rawSrt, { width: w, height: h, fontSize })
        const p = join(assDir, `.sub-${ctx.run.id}-${stamp}${tag}.ass`)
        writeFileSync(p, ass, 'utf8')
        assTempAbs.push(p)
        return p
      }
      const paths = [writeAss(width, height, mainFontSize, '')]
      for (const t of maTargets) {
        const { w, h } = resolveAspectSize(width, height, t.aspect)
        const fs = brand.subtitle
          ? fsFromStyle(buildSubtitleStyle(h, brand.subtitle), Math.max(16, Math.round(h * (brand.subtitle.size_pct ?? 0.04))))
          : mainFontSize
        paths.push(writeAss(w, h, fs, `-${paths.length}`))
      }
      subtitlePaths = paths
      ctx.log(`字幕 SRT→ASS：PlayRes ${width}×${height} 显式声明，左右边距 5%，防中文横向溢出（临时 ASS 合成后清理）`)
    } catch (err) {
      ctx.log(`字幕 ASS 转换失败（回落 SRT 原样烧录）：${(err as Error).message}`)
    }
  }

  // 组装 filter_complex 与编码参数（提炼 buildComposeArgs 纯函数；无水印/片头尾→ 与既有实现逐字节一致）
  const hasAudio = voicePaths.length > 0 || !!dialogueClips
  const { args, cwd, totalAll, derived } = buildComposeArgs({
    strictDelivery: strict,
    ...(dialogueClips ? { nativeAudio: dialogueClips.map((clip) => clip.timing) } : {}),
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
    subtitlePaths,
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

  // 无烧录快速路径（§6.2 步骤 5）：仅改显示字幕 → 逐字节复制基准成片/派生画幅零编码；
  // 任一其他依赖不一致 → 返回 null 继续下方正常重合成（台词/音频位置不变红线由不进入编码路径保证）
  const fastIds = await tryNoBurnManualRecompose({
    ctx, manual, eligible: !strict && !!manual && !subtitleBurn && !dialogueClips,
    outName, outRel, outAbs, coverAt, wantCover, ffmpeg, runFfmpeg, derived,
    cur: { fps, resolution, width, height, totalAll, imageCount: segments.filter((s) => s.kind === 'image').length, motionCount: segments.filter((s) => s.kind === 'video').length, voiceCount: voicePaths.length, style, srtRelPath, subtitleAssetId: subtitleIds[0] ?? null, inputs: { images: mode === 'images' ? imageIds : null, motion_clips: mode === 'clips' ? clipIds : null, shots_source: shotsIds[0] ?? null }, skipped, alignPlan, alignReason, xfade: xfadePlan, bgm: bgmPath && bgmAsset ? { asset_id: bgmAsset.id, volume: bgmVolume, fade: bgmFade } : null, watermark: watermarkArg, intro: introArg ? { source: brand.intro!.source, duration: round3(introArg.durSec) } : null, outro: outroArg ? { source: brand.outro!.source, duration: round3(outroArg.durSec) } : null, sfxCount: sfxList.length, sfxVolume },
    recordProvenance: () => recordMergeProvenance(ctx, { rows, usedSegments: segments, skipped, voiceIds: voiceMetas.map((v) => v.assetId), subtitleIds, bgmAssetId: bgmAsset?.id ?? null, shotsAssetId: shotsIds[0] ?? null }),
  })
  if (fastIds) return { assetIds: fastIds }

  ctx.log(
    `ffmpeg 开始合成（${segments.length} 段${hasAudio ? ' + 音频轨' : ''}${srtAbs ? ' + 字幕' : ''}${bgmPath ? ' + BGM' : ''}${xfadePlan.enabled ? ' + 转场' : ''}${watermarkArg ? ' + 水印' : ''}${introArg ? ' + 片头' : ''}${outroArg ? ' + 片尾' : ''}${sfxList.length > 0 ? ` + 音效×${sfxList.length}` : ''}）…`,
  )
  try {
    await runFfmpeg(ctx, ffmpeg, args, cwd)
  } finally {
    for (const tmp of [tempSrtAbs, ...assTempAbs]) {
      if (!tmp) continue
      try {
        unlinkSync(tmp)
      } catch {
        // 临时字幕清理失败不影响成片
      }
    }
  }
  if (recipe) assertStrictOutput(outAbs, recipe.plan.duration)
  if (dialogueClips && recipe) {
    const timing = inspectDialogueMedia(outAbs)
    if (Math.abs(timing.videoDuration - recipe.plan.duration) > 0.15 || Math.abs(timing.audioDuration - recipe.plan.duration) > 0.15
      || Math.abs(timing.audioStart - timing.videoStart) > 0.05) throw new Error('原声成片音画时长或时间基准检查失败')
  }
  const size = statSync(outAbs).size

  // 有效字幕快照（规格 §6.1）：记录实际生效文本/cue 与不可变文件（平移时源旁 display-<sha16>
  // 内容寻址落盘，幂等复用）；解析失败/读取异常仅记日志省略增量字段，绝不影响合成
  let subtitleSnapExt: Partial<EditTimelineSubtitle> = {}
  if (srtRelPath) {
    try {
      const plan = planEffectiveSubtitle({
        sourceText: await ctx.readText(subtitleIds[0]!),
        shiftedText: srtShiftedText,
        sourceRelPath: srtRelPath,
        sourceAssetId: subtitleIds[0] ?? null,
        // 对白路线时间源：估算/实测已验；其余（含严格旁白）不冒充可信来源
        timingSource: dialogueClips && recipe ? (recipe.estimatedDialogue === true ? 'estimated' : 'measured') : 'unknown',
        origin: manual ? 'manual' : 'source',
        versionId: manual?.versionId ?? null,
      })
      if (plan) {
        if (plan.effectiveTextToWrite) {
          const effAbs = absPathOf(plan.ext.effectiveRelPath)
          if (!existsSync(effAbs)) writeFileSync(effAbs, plan.effectiveTextToWrite, 'utf8')
        }
        subtitleSnapExt = plan.ext
      } else {
        ctx.log('有效字幕快照跳过（SRT 不可严格解析；不影响合成）')
      }
    } catch (err) {
      ctx.log(`有效字幕快照失败（不影响合成）：${(err as Error).message}`)
    }
  }

  const tags = ['final']
  if (hasAudio) tags.push('with_audio')
  if (srtAbs) tags.push('with_subtitle')
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
      ...(strict ? { strict_delivery: true, delivery_checked: true } : {}),
      ...(dialogueClips ? { performance: 'dialogue', dialogue_review_required: true, ...(recipe?.estimatedDialogue ? { dialogue_subtitles_estimated: true } : {}), dialogue_clips: dialogueClips } : {}),
      fps,
      resolution,
      images: segments.filter((s) => s.kind === 'image').length,
      motion_clips: segments.filter((s) => s.kind === 'video').length,
      voices: voicePaths.length,
      subtitle: srtRelPath ? 1 : 0,
      subtitle_style: style,
      duration: Math.round(totalAll * 1000) / 1000,
      // 输入快照（stale 检测数据源：与 output.asset_ids 同口径）+ 容错溯源（旧键全部保留不动）
      inputs: {
        images: mode === 'images' ? imageIds : null,
        motion_clips: mode === 'clips' ? clipIds : null,
        shots_source: shotsIds[0] ?? null,
      },
      skipped_shots: skipped,
      // 三增强溯源（禁用时记录原因，不影响既有语义；partial/warn_lines 标记 best-effort 部分命中）
      align: alignPlan
        ? { aligned: true, reason: null, lines: alignPlan.lines.length, shots: alignPlan.segments.length, total_dur: alignPlan.totalDur, mode: alignPlan.mode ?? null, partial: alignPlan.partial ?? false, warn_lines: alignPlan.warnLines?.length ?? 0 }
        : { aligned: false, reason: alignReason, lines: 0, shots: 0, total_dur: null, mode: null, partial: false, warn_lines: 0 },
      transition: { enabled: xfadePlan.enabled, type: xfadePlan.enabled ? xfadePlan.type : null, dur_sec: xfadePlan.enabled ? xfadePlan.durSec : null },
      bgm: bgmPath && bgmAsset ? { asset_id: bgmAsset.id, volume: bgmVolume, fade: bgmFade } : null,
      // 品牌溯源（无配置 → null；duration = 含片头尾总长）
      watermark: watermarkArg
        ? { position: watermarkArg.position, opacity: watermarkArg.opacity, width_pct: watermarkArg.width_pct, source: watermarkArg.source }
        : null,
      intro: introArg ? { source: brand.intro!.source, duration: round3(introArg.durSec) } : null,
      outro: outroArg ? { source: brand.outro!.source, duration: round3(outroArg.durSec) } : null,
      sfx: sfxList.length > 0 ? { count: sfxList.length, volume: sfxVolume } : null,
      // Canonical 同源时间轴快照（剪辑工程交换导出唯一真源；纯增量溯源，不改任何 ffmpeg 参数与音频结果）
      timeline: buildEditTimeline({
        fps, width, height, totalSec: totalAll, introSec: introShift, outroSec: outroArg ? round3(outroArg.durSec) : 0,
        segments, rows, alignPlan, voices: voiceMetas, sfx: sfxSnap,
        bgm: bgmPath && bgmAsset?.relPath ? { assetId: bgmAsset.id, relPath: bgmAsset.relPath, volume: bgmVolume, fadeSec: bgmFade } : null,
        transition: xfadePlan.enabled ? { type: xfadePlan.type, durSec: xfadePlan.durSec } : null,
        subtitle: srtRelPath ? { assetId: subtitleIds[0] ?? null, relPath: srtRelPath, ...subtitleSnapExt } : null,
        watermark: !!watermarkArg,
      }),
    },
    tags,
    stepId: ctx.step.id,
  })
  ctx.log(`成片落盘 asset#${videoAsset.id} → ${outRel}（${Math.round(size / 1024 / 1024)} MB${hasAudio ? '，含音轨' : ''}${srtAbs ? '，含字幕' : ''}${introArg || outroArg ? '，含片头尾' : ''}）`)

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
  // 多画幅派生件落资产（单路异常仅 warn，不影响成片与封面结果）
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
  // 合成执行真实输入快照：镜头媒体/配音/字幕/BGM + 分镜 JSON 文本（版本指针），按 shotId 定位
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

// runFfmpeg → ./exec.ts；recordMergeProvenance → ./merge-provenance.ts（行为保真拆分，index ≤800）


export { defaultSubtitleStyle, toAssColor, buildSubtitleStyle } from './subtitle-style'
export { estimateMaxCharsPerLine, wrapSingleLine, wrapSrtText } from './subtitle-wrap'
export { srtToAss, parseSrtCues } from './subtitle-ass'
export { watermarkOverlayXY } from './watermark'
export { resolveAspectSize, aspectGeometryFilter, isSameAspect } from './aspect'
export { computeShotSegments, parseShotDurations, buildClipDurByShotId } from './segments'
export { parseShotLines, planVoiceAlignedSegments, planBestEffortTimeline, planAudioDrivenShotDurations, planSrtShifts, srtTsToSec, secToSrtTs, countSrtCues, shiftSrtText } from './align'
export { buildTransitionPlan } from './transition'
export { planSfxStarts } from './sfx'
export { buildComposeArgs } from './args'
export type { AlignShotInput, AlignLine, AlignPlan } from './align'
export type { TransitionPlan } from './transition'
export type { ComposeWatermarkInput, ComposeClipInput, ComposeSfxInput, ComposeArgsInput, ComposeDerivedOutput, ComposeArgsResult } from './args'
