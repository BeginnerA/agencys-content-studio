/**
 * 精确返修（precision-rework）· 有效字幕快照纯函数（规格 §6.1）。
 *
 * 合成期实际生效的字幕（未平移=源文本；逐句对齐/片头平移后=shiftSrtText 结果；
 * 严格路径=源文本原样，不静默修正历史时码）解析为带稳定标识的 cue 列表并计算
 * hash，映射为 timeline.subtitle 的可选增量字段。零 IO——不可变文件的落盘由
 * 调用方（ffmpeg-merge index）负责；解析失败返回 null，调用方省略增量字段，
 * 绝不影响合成本身。
 *
 * 口径：cues 坐标恒为成片绝对轴（coordinate='final'，已含片头/平移位移）；
 * cue 标识锚定「源字幕」内容基准 tag——平移与派生不换基准，重建源后才换。
 *
 * planSubtitleShifts/planEffectiveSubtitle 为烧录路径与快照共用的唯一计算入口
 * （关闭烧录同样得到与成片绝对轴一致的有效字幕），IO 仅通过依赖回调。
 */
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  attachCueIds,
  parseSubtitleSrt,
  subtitleBaseTag,
  type SubtitleCue,
} from '../../../services/rework/subtitle-text'
import { planSrtShifts, countSrtCues, shiftSrtText, type AlignPlan } from './align'
import { round3 } from './util'

/** 时间来源标记（规格 §6.1）：人工修订不得升级来源等级 */
export type SubtitleTimingSource = 'estimated' | 'measured' | 'unknown'

export interface EffectiveSubtitleSnapshot {
  /** 人工修订版本的 content_versions id；无人工修订时为 null（§6.1 允许为空） */
  versionId: number | null
  /** 有效字幕文本（非源文本）的 UTF-8 sha256 hex */
  sha256: string
  /** 固定 'final'：成片绝对轴，与内容轴 lines 区分 */
  coordinate: 'final'
  cues: SubtitleCue[]
  origin: 'source' | 'manual'
  sourceRef: { assetId: number | null; sha256: string; timingSource: SubtitleTimingSource }
}

/** 文本 → sha256 hex（源与有效字幕文件内容 hash 共用） */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 有效字幕 → 快照增量字段；null = 有效文本不可严格解析（调用方记日志跳过，不影响合成）。
 * shiftedText 传入与源不同文本时 cues 时间已含平移位移（final 轴），标识仍锚定源基准 tag。
 */
export function buildEffectiveSubtitleSnapshot(args: {
  /** 源字幕资产全文（sourceRef.hash 与 cue 基准 tag 的计算基准） */
  sourceText: string
  /** 平移结果文本；null = 有效字幕与源一致（无平移 / Δ 全 0 / 严格路径 / 平移失败回退） */
  shiftedText: string | null
  sourceAssetId: number | null
  timingSource: SubtitleTimingSource
  /** P3 人工修订版本供给时传 'manual' + versionId；P2 恒默认 source */
  origin?: 'source' | 'manual'
  versionId?: number | null
}): EffectiveSubtitleSnapshot | null {
  const effectiveText = args.shiftedText ?? args.sourceText
  const parsed = parseSubtitleSrt(effectiveText)
  if (!parsed.ok) return null
  const sourceSha256 = sha256Text(args.sourceText)
  return {
    versionId: args.versionId ?? null,
    sha256: sha256Text(effectiveText),
    coordinate: 'final',
    cues: attachCueIds(parsed.cues, subtitleBaseTag(sourceSha256)),
    origin: args.origin ?? 'source',
    sourceRef: { assetId: args.sourceAssetId, sha256: sourceSha256, timingSource: args.timingSource },
  }
}

/**
 * 字幕平移唯一入口（逐句对齐 + 片头统移合并为一次重写；与迁移前 index.ts 逐行为等价）：
 * shiftedText=null = 有效字幕与源一致（Δ 全 0 / cue 数不符 / 读失败回退），各分支只记日志不中断合成。
 */
export async function planSubtitleShifts(args: {
  alignPlan: AlignPlan | null
  voiceLineIds: string[]
  voiceCount: number
  introShift: number
  readSource: () => Promise<string>
  log: (msg: string) => void
}): Promise<{ shifts: number[] | null; alignMode: boolean; shiftedText: string | null }> {
  let shifts: number[] | null = null
  let alignMode = false
  if (args.alignPlan) {
    const alignShifts = planSrtShifts(args.alignPlan, args.voiceLineIds)
    if (alignShifts) {
      alignMode = true
      shifts = args.introShift > 0 ? alignShifts.map((d) => round3(d + args.introShift)) : alignShifts
    } else if (args.introShift > 0) {
      args.log(`字幕对齐平移跳过（cue 数与配音句数 ${args.voiceCount} 不符），改按片头统移`)
    } else {
      args.log(`字幕平移跳过（cue 数与配音句数 ${args.voiceCount} 不符），原样烧录`)
    }
  }
  if (!shifts && args.introShift > 0) {
    try {
      const cues = countSrtCues(await args.readSource())
      if (cues > 0) shifts = new Array<number>(cues).fill(args.introShift)
      else args.log('字幕片头位移跳过（SRT 无有效 cue 行），原样烧录')
    } catch (err) {
      args.log(`字幕片头位移失败（原样烧录）：${(err as Error).message}`)
    }
  }
  let shiftedText: string | null = null
  if (shifts) {
    if (shifts.every((d) => d < 1e-3)) {
      args.log('字幕平移 Δ 全 0（无静音插入），直接使用原 SRT')
    } else {
      try {
        const shifted = shiftSrtText(await args.readSource(), shifts)
        if (!shifted) {
          args.log(`字幕平移跳过（SRT cue 数与配音句数 ${args.voiceCount} 不符），原样烧录`)
        } else {
          shiftedText = shifted
        }
      } catch (err) {
        args.log(`字幕平移失败（原样烧录）：${(err as Error).message}`)
      }
    }
  }
  return { shifts, alignMode, shiftedText }
}

export interface EffectiveSubtitlePlan {
  /** timeline.subtitle 增量字段（含 effectiveRelPath） */
  ext: NonNullable<EffectiveSubtitleSnapshot> & { effectiveRelPath: string }
  /** 需另落源旁不可变文件时非空（发生平移时）；否则有效文件即源文件 */
  effectiveTextToWrite: string | null
}

/** 快照字段 + 有效文件路径规划（纯函数；落盘由调用方执行）；null = 不可严格解析 */
export function planEffectiveSubtitle(args: {
  sourceText: string
  shiftedText: string | null
  sourceRelPath: string
  sourceAssetId: number | null
  timingSource: SubtitleTimingSource
  /** P6 人工修订消费时传 'manual' + versionId；无人工修订省略（默认 source） */
  origin?: 'source' | 'manual'
  versionId?: number | null
}): EffectiveSubtitlePlan | null {
  const snap = buildEffectiveSubtitleSnapshot(args)
  if (!snap) return null
  if (!args.shiftedText) return { ext: { ...snap, effectiveRelPath: args.sourceRelPath }, effectiveTextToWrite: null }
  // 内容寻址命名 = 不可变且同源同内容幂等复用（display-<sha16>.srt，与源同目录）
  const rel = join(dirname(args.sourceRelPath), `display-${snap.sha256.slice(0, 16)}.srt`)
  return { ext: { ...snap, effectiveRelPath: rel }, effectiveTextToWrite: args.shiftedText }
}
