/**
 * 精确返修 · 合成侧人工字幕消费（precision-rework 规格 §6.2）。
 *
 * - 人工修订版本内容恒为成片绝对轴（预览/确认期口径固定）：烧录直接以它为显示输入，
 *   跳过旧逐句平移/片头统移的重复处理；源字幕与原声校验仍由调用方按原路径先行（结论分列）。
 * - fail closed：版本内容缺失、hash 与台账指针不符、SRT 不可严格解析一律抛错，
 *   绝不静默回退过期修订；入口级依赖指纹复验（P7，规格 §6.2）不符 → 本次不套用、
 *   指针保留不删（用户可预览恢复源字幕或重新编辑）。
 * - 无烧录快速路径：硬字幕关闭且「本次仅改显示字幕」→ 逐字节复制固定基准成片与派生画幅
 *   （封面从复制件重新抽帧），禁止视频/音频编码；其余任一依赖不一致 → 返回 null 走正常重合成。
 * 零供应商调用、零 gen_tasks 触碰；IO 全部经参数注入（探针可零 ffmpeg 验证）。
 */
import { copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseSubtitleEdits } from '../../../services/rework/ledger'
import { parseSubtitleSrt } from '../../../services/rework/subtitle-text'
import {
  planEffectiveSubtitle,
  planSubtitleShifts,
  sha256Text,
  type SubtitleTimingSource,
} from './effective-subtitle'
import { absPathOf, registerAsset, relPathOf } from '../../../services/storage'
import type { StepContext } from '../../context'
import type { AlignPlan } from './align'
import type { TransitionPlan } from './transition'

export interface ManualDisplay {
  text: string
  versionId: number
  sha256: string
  requestId: string
}

/**
 * 读取本步骤当前生效的人工修订（§6.2 步骤 2）：无指针 → null（行为与迁移前逐字节一致）；
 * 有指针 → 先做依赖指纹复验（recheckFingerprint 返回当前重算指纹：与 baseFingerprint 不符或
 * null=不可复验 → 过期，记日志返回 null，不套用也不删指针）；再版本内容校验（hash/可解析），不符即抛错。
 * readVersion/recheckFingerprint 由调用方注入（生产=provenance/baseline）。
 */
export async function loadManualDisplay(args: {
  runInput: string | null
  stepKey: string
  readVersion: (versionId: number) => Promise<string>
  recheckFingerprint?: () => Promise<string | null>
  log?: (msg: string) => void
}): Promise<ManualDisplay | null> {
  const ref = parseSubtitleEdits(args.runInput)[args.stepKey] ?? null
  if (!ref) return null
  if (args.recheckFingerprint) {
    const current = await args.recheckFingerprint().catch(() => null)
    if (current !== ref.baseFingerprint) {
      args.log?.('人工字幕修订已过期（选片/媒体/源字幕/时长/配置或品牌改动，或依赖基准不可复验）：本次合成不套用，指针保留，请重新预览确认')
      return null
    }
  }
  const text = await args.readVersion(ref.versionId)
  if (sha256Text(text) !== ref.sha256) {
    throw new Error(`人工字幕修订版本 #${ref.versionId} 内容与台账指针 hash 不符（陈旧或损坏），已拒绝合成`)
  }
  if (!parseSubtitleSrt(text).ok) throw new Error(`人工字幕修订版本 #${ref.versionId} 不是严格可解析 SRT，已拒绝合成`)
  return { text, versionId: ref.versionId, sha256: ref.sha256, requestId: ref.requestId }
}

export interface DisplaySubtitlePlan {
  /** 喂字幕滤镜的文件（未开烧录 → null；未平移 → 源文件路径） */
  srtAbs: string | null
  /** 需在 finally 清理的临时副本（无则 null） */
  tempSrtAbs: string | null
  /** 有效显示文本（与源不同才非 null；供有效字幕快照） */
  shiftedText: string | null
}

/**
 * 显示字幕规划（自 ffmpeg-merge index 原样接管 + §6.2 人工消费前置分支）：
 * 人工修订在场时直接使用版本内容（成片轴），不进入平移计算；否则逐字保持既有语义
 * （对齐逐 cue + 片头统移一次重写、Δ 全 0 不写副本、cue 数不符原样烧录）。
 */
export async function planDisplaySubtitle(args: {
  strict: boolean
  srtRelPath: string | null
  subtitleBurn: boolean
  alignPlan: AlignPlan | null
  voiceLineIds: string[]
  voiceCount: number
  introShift: number
  readSource: () => Promise<string>
  outDir: string
  runId: number
  manual: ManualDisplay | null
  log: (msg: string) => void
}): Promise<DisplaySubtitlePlan> {
  const { srtRelPath, subtitleBurn, introShift, manual } = args
  if (manual) {
    if (!srtRelPath) throw new Error('存在人工字幕修订但本步没有源字幕输入（源验证与显示修订必须分列共存）')
    if (!subtitleBurn) {
      args.log(`人工字幕修订生效（版本 #${manual.versionId}；烧录关闭：显示文本进快照与下载，成片不含硬字幕）`)
      return { srtAbs: null, tempSrtAbs: null, shiftedText: manual.text }
    }
    const p = join(args.outDir, `.manual-${args.runId}-${Date.now()}.srt`)
    writeFileSync(p, manual.text, 'utf8')
    args.log(`人工字幕修订生效（版本 #${manual.versionId}；成片轴副本直接烧录，跳过旧逐句/片头平移）`)
    return { srtAbs: p, tempSrtAbs: p, shiftedText: manual.text }
  }
  if (srtRelPath && !subtitleBurn) args.log('字幕烧录已关闭：成片不含硬字幕（字幕文件仍生成，可单独下载）')
  let srtAbs: string | null = srtRelPath && subtitleBurn ? absPathOf(srtRelPath) : null
  let tempSrtAbs: string | null = null
  let shiftedText: string | null = null
  if (!args.strict && srtRelPath && (args.alignPlan || introShift > 0)) {
    const sp = await planSubtitleShifts({
      alignPlan: args.alignPlan,
      voiceLineIds: args.voiceLineIds,
      voiceCount: args.voiceCount,
      introShift,
      readSource: args.readSource,
      log: args.log,
    })
    if (sp.shifts && sp.shiftedText && subtitleBurn) {
      tempSrtAbs = join(args.outDir, `${sp.alignMode ? '.aligned-' : '.intro-'}${args.runId}-${Date.now()}.srt`)
      writeFileSync(tempSrtAbs, sp.shiftedText, 'utf8')
      srtAbs = tempSrtAbs
      args.log(
        sp.alignMode
          ? `字幕对齐平移：${sp.shifts.length} 条 cue 重写（最大偏移 ${Math.max(...sp.shifts).toFixed(2)}s${introShift > 0 ? '，含片头位移' : ''}，临时副本合成后清理）`
          : `字幕片头位移：${sp.shifts.length} 条 cue 统移 +${introShift}s（临时副本合成后清理）`,
      )
    }
    shiftedText = sp.shiftedText
  }
  return { srtAbs, tempSrtAbs, shiftedText }
}

/**
 * 无烧录快速路径（§6.2 步骤 5）：!strict && manual && 烧录关 && 非对白路线时，
 * 校验基准成片 params 溯源与本次合成计划在「显示字幕以外」逐字段一致——
 * 一致 → 逐字节复制基准成片/派生画幅（禁止编码），timeline.subtitle 换人工有效字幕快照后
 * 登记新版本资产；任一不符 → 记日志返回 null，调用方继续正常重合成。
 */
export async function tryNoBurnManualRecompose(args: {
  ctx: StepContext
  manual: ManualDisplay | null
  /** 调用方算好的准入复合条件（!strict && manual && !subtitleBurn && !对白路线）；false 直接放弃 */
  eligible: boolean
  outName: string
  outRel: string
  outAbs: string
  coverAt: number
  wantCover: boolean
  ffmpeg: string
  runFfmpeg: (ctx: StepContext, ffmpeg: string, ffArgs: string[], cwd?: string) => Promise<void>
  recordProvenance: () => Promise<void>
  derived: Array<{ aspect: string; width: number; height: number; outAbs: string }>
  /** 本次合成计划中与基准 params 溯源同口径的字段（键序与 index registerAsset params 字面量一致） */
  cur: {
    fps: number
    resolution: string
    width: number
    height: number
    totalAll: number
    imageCount: number
    motionCount: number
    voiceCount: number
    style: string
    srtRelPath: string | null
    subtitleAssetId: number | null
    inputs: { images: number[] | null; motion_clips: number[] | null; shots_source: number | null }
    skipped: number[]
    alignPlan: AlignPlan | null
    alignReason: string | null
    xfade: TransitionPlan
    bgm: { asset_id: number; volume: number; fade: number } | null
    watermark: { position: string; opacity: number; width_pct: number; source: string } | null
    intro: { source: string; duration: number } | null
    outro: { source: string; duration: number } | null
    sfxCount: number
    sfxVolume: number
  }
}): Promise<number[] | null> {
  const { ctx, manual, cur } = args
  if (!args.eligible || !manual) return null
  // 基准 = 本步上一次成功 output.asset_ids 里的 final_video（executeStep 完成前 output 仍为旧值）
  let oldIds: number[] = []
  try {
    oldIds = (JSON.parse(ctx.step.output ?? '{}') as { asset_ids?: number[] }).asset_ids ?? []
  } catch {
    oldIds = []
  }
  if (oldIds.length === 0) {
    ctx.log('无烧录快速路径跳过（本步无既有成片基准，首次合成走正常编码）')
    return null
  }
  const oldAssets = await ctx.assetsOf(oldIds)
  const base = oldAssets.find((a) => a.purpose === 'final_video')
  if (!base?.relPath || !existsSync(absPathOf(base.relPath))) {
    ctx.log('无烧录快速路径跳过（基准成片资产或文件缺失），走正常重合成')
    return null
  }
  const oldParams = JSON.parse(base.params ?? '{}') as Record<string, unknown>
  if (oldParams.dialogue_clips || oldParams.strict_delivery) {
    ctx.log('无烧录快速路径跳过（基准为对白/严格交付路线），走正常重合成')
    return null
  }
  // 溯源逐字段投影（两侧同一固定键序 stringify 对比；timeline 为派生数据不参与准入判定）
  const traceOf = (p: Record<string, unknown>): string => {
    const inp = (p.inputs ?? {}) as Record<string, unknown>
    const al = (p.align ?? {}) as Record<string, unknown>
    const tr = (p.transition ?? {}) as Record<string, unknown>
    const bg = (p.bgm ?? null) as Record<string, unknown> | null
    const wm = (p.watermark ?? null) as Record<string, unknown> | null
    const ins = (p.intro ?? null) as Record<string, unknown> | null
    const outs = (p.outro ?? null) as Record<string, unknown> | null
    const sf = (p.sfx ?? null) as Record<string, unknown> | null
    return JSON.stringify({
      fps: p.fps ?? null,
      resolution: p.resolution ?? null,
      images: p.images ?? null,
      motion_clips: p.motion_clips ?? null,
      voices: p.voices ?? null,
      subtitle: p.subtitle ?? null,
      subtitle_style: p.subtitle_style ?? null,
      duration: p.duration ?? null,
      inputs: { images: inp.images ?? null, motion_clips: inp.motion_clips ?? null, shots_source: inp.shots_source ?? null },
      skipped_shots: p.skipped_shots ?? null,
      align: { aligned: al.aligned ?? false, reason: al.reason ?? null, lines: al.lines ?? 0, shots: al.shots ?? 0, total_dur: al.total_dur ?? null, mode: al.mode ?? null, partial: al.partial ?? false, warn_lines: al.warn_lines ?? 0 },
      transition: { enabled: tr.enabled ?? false, type: tr.type ?? null, dur_sec: tr.dur_sec ?? null },
      bgm: bg ? { asset_id: bg.asset_id ?? null, volume: bg.volume ?? null, fade: bg.fade ?? null } : null,
      watermark: wm ? { position: wm.position ?? null, opacity: wm.opacity ?? null, width_pct: wm.width_pct ?? null, source: wm.source ?? null } : null,
      intro: ins ? { source: ins.source ?? null, duration: ins.duration ?? null } : null,
      outro: outs ? { source: outs.source ?? null, duration: outs.duration ?? null } : null,
      sfx: sf ? { count: sf.count ?? null, volume: sf.volume ?? null } : null,
    })
  }
  const curTrace = JSON.stringify({
    fps: cur.fps,
    resolution: cur.resolution,
    images: cur.imageCount,
    motion_clips: cur.motionCount,
    voices: cur.voiceCount,
    subtitle: cur.srtRelPath ? 1 : 0,
    subtitle_style: cur.style,
    duration: Math.round(cur.totalAll * 1000) / 1000,
    inputs: { images: cur.inputs.images, motion_clips: cur.inputs.motion_clips, shots_source: cur.inputs.shots_source },
    skipped_shots: cur.skipped,
    align: cur.alignPlan
      ? { aligned: true, reason: null, lines: cur.alignPlan.lines.length, shots: cur.alignPlan.segments.length, total_dur: cur.alignPlan.totalDur, mode: cur.alignPlan.mode ?? null, partial: cur.alignPlan.partial ?? false, warn_lines: cur.alignPlan.warnLines?.length ?? 0 }
      : { aligned: false, reason: cur.alignReason, lines: 0, shots: 0, total_dur: null, mode: null, partial: false, warn_lines: 0 },
    transition: { enabled: cur.xfade.enabled, type: cur.xfade.enabled ? cur.xfade.type : null, dur_sec: cur.xfade.enabled ? cur.xfade.durSec : null },
    bgm: cur.bgm ? { asset_id: cur.bgm.asset_id, volume: cur.bgm.volume, fade: cur.bgm.fade } : null,
    watermark: cur.watermark ? { position: cur.watermark.position, opacity: cur.watermark.opacity, width_pct: cur.watermark.width_pct, source: cur.watermark.source } : null,
    intro: cur.intro ? { source: cur.intro.source, duration: cur.intro.duration } : null,
    outro: cur.outro ? { source: cur.outro.source, duration: cur.outro.duration } : null,
    sfx: cur.sfxCount > 0 ? { count: cur.sfxCount, volume: cur.sfxVolume } : null,
  })
  if (traceOf(oldParams) !== curTrace) {
    ctx.log('无烧录快速路径不适用（显示字幕之外存在其他输入/参数变化），走正常重合成')
    return null
  }
  // 派生画幅逐项一致（集合相同且基准文件在），否则拒绝快速路径
  const oldDerived = oldAssets.filter((a) => a.purpose === 'final_video_derived' && a.relPath)
  const aspectOf = (params: string | null | undefined): string => String((JSON.parse(params ?? '{}') as Record<string, unknown>).aspect ?? '')
  const newAspects = args.derived.map((d) => d.aspect)
  const oldAspects = oldDerived.map((a) => aspectOf(a.params))
  if (
    oldAspects.length !== newAspects.length ||
    !oldAspects.every((x) => newAspects.includes(x)) ||
    !oldDerived.every((a) => existsSync(absPathOf(a.relPath!)))
  ) {
    ctx.log('无烧录快速路径不适用（多画幅派生配置或基准文件变化），走正常重合成')
    return null
  }
  // 人工有效字幕快照（沿用基准旧快照的 timingSource：人工修订不得升级来源等级）
  if (!cur.srtRelPath || cur.subtitleAssetId == null) {
    ctx.log('无烧录快速路径不适用（缺少源字幕输入）')
    return null
  }
  const oldSnap = ((oldParams.timeline as Record<string, unknown> | undefined)?.subtitle ?? null) as Record<string, unknown> | null
  const timingSource = (oldSnap?.sourceRef as { timingSource?: SubtitleTimingSource } | undefined)?.timingSource ?? 'unknown'
  const plan = planEffectiveSubtitle({
    sourceText: await ctx.readText(cur.subtitleAssetId),
    shiftedText: manual.text,
    sourceRelPath: cur.srtRelPath,
    sourceAssetId: cur.subtitleAssetId,
    timingSource,
    origin: 'manual',
    versionId: manual.versionId,
  })
  if (!plan) {
    ctx.log('无烧录快速路径不适用（人工修订字幕不可严格解析）')
    return null
  }
  if (plan.effectiveTextToWrite) {
    const effAbs = absPathOf(plan.ext.effectiveRelPath)
    if (!existsSync(effAbs)) writeFileSync(effAbs, plan.effectiveTextToWrite, 'utf8')
  }
  // 逐字节复制（禁止任何编解码）：主成片 → 派生画幅 → 封面从复制件重新抽帧
  copyFileSync(absPathOf(base.relPath), args.outAbs)
  const newParams: Record<string, unknown> = {
    ...oldParams,
    timeline: {
      ...((oldParams.timeline ?? {}) as Record<string, unknown>),
      subtitle: { assetId: cur.subtitleAssetId, relPath: cur.srtRelPath, ...plan.ext },
    },
    manual_subtitle_version: manual.versionId,
    no_burn_fastpath: true,
  }
  const size = statSync(args.outAbs).size
  const tags = ['final']
  if (cur.voiceCount > 0) tags.push('with_audio')
  const videoAsset = await registerAsset(ctx.run.projectId, {
    runId: ctx.run.id,
    name: args.outName,
    kind: 'video',
    purpose: 'final_video',
    relPath: args.outRel,
    mime: 'video/mp4',
    ext: 'mp4',
    fileSize: size,
    width: cur.width,
    height: cur.height,
    duration: Math.round(cur.totalAll),
    params: newParams,
    tags,
    stepId: ctx.step.id,
  })
  ctx.log(`无烧录快速路径：逐字节复制基准成片 asset#${base.id} → ${args.outName}（${Math.round(size / 1024 / 1024)} MB，零编码零供应商调用，台词/音频位置不变）`)
  const assetIds = [videoAsset.id]
  if (args.wantCover) {
    const coverName = args.outName.replace('final-', 'cover-').replace(/\.mp4$/, '.jpg')
    const coverRel = relPathOf(ctx.run.projectId, 'thumbnail', coverName)
    const coverAbs = absPathOf(coverRel)
    await args.runFfmpeg(ctx, args.ffmpeg, ['-y', '-ss', String(args.coverAt), '-i', args.outAbs, '-frames:v', '1', '-q:v', '3', coverAbs])
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
  for (const d of args.derived) {
    const oldD = oldDerived.find((a) => aspectOf(a.params) === d.aspect)!
    copyFileSync(absPathOf(oldD.relPath!), d.outAbs)
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
      duration: Math.round(cur.totalAll),
      params: JSON.parse(oldD.params ?? '{}') as Record<string, unknown>,
      tags: ['final', 'derived', d.aspect.replace(':', 'x')],
      stepId: ctx.step.id,
    })
    assetIds.push(derivedAsset.id)
    ctx.log(`无烧录快速路径：派生画幅 ${d.aspect} 逐字节复制 asset#${oldD.id} → ${dName}`)
  }
  await args.recordProvenance()
  return assetIds
}
