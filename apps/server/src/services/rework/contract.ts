/**
 * 精确返修（precision-rework）· 单一变更与预览契约（纯函数，规格 §4）。
 *
 * - 三类结构化操作：改显示文字 / 改起止时间 / 选中 cue 批量平移；只修改既有 cue，
 *   不增删、不改数量和顺序。
 * - 每个 cue 至多被一种操作命中一次（含跨 kind 组合），重复/冲突整体拒绝——
 *   避免「time+shift」这类语义叠加引起前后值不可解释。
 * - 结果 = 最终 cue 全列表整体校验（界内/单调/不重叠）+ 逐 cue diff；任一校验失败
 *   不产出部分结果，不静默裁切、不自动挤动其他字幕。
 * - 前端不得提交可信费用、原值或执行范围；本模块只保证变更语义，基准指纹由服务端组装。
 */
import { z } from 'zod'
import {
  type ReworkError,
  type SubtitleCue,
  validateCueList,
  validateSubtitleText,
} from './subtitle-text'

export type SubtitleChange =
  | { kind: 'subtitle-text'; cueId: string; text: string }
  | { kind: 'subtitle-time'; cueId: string; startMs: number; endMs: number }
  | { kind: 'subtitle-shift'; cueIds: string[]; deltaMs: number }

/** 批量平移单次幅度上限：±10 分钟（整数毫秒；界内校验仍以后者为准） */
export const MAX_SHIFT_DELTA_MS = 10 * 60 * 1000
/** 单次请求变更数上限 */
export const MAX_CHANGES_PER_REQUEST = 1000

const intMs = z.number().int()
const cueIdSchema = z.string().min(1).max(200)

export const subtitleChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('subtitle-text'), cueId: cueIdSchema, text: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal('subtitle-time'), cueId: cueIdSchema, startMs: intMs, endMs: intMs }).strict(),
  z.object({ kind: z.literal('subtitle-shift'), cueIds: z.array(cueIdSchema).min(1).max(5000), deltaMs: intMs }).strict(),
])

export const subtitleChangesSchema = z.array(subtitleChangeSchema).min(1).max(MAX_CHANGES_PER_REQUEST)

/** 单 cue 单字段的前后差异（time 拆 start/end 两行，便于 UI 就近显示） */
export interface SubtitleDiffEntry {
  cueId: string
  field: 'text' | 'startMs' | 'endMs'
  before: string | number
  after: string | number
}

export type ApplyChangesResult =
  | { ok: true; finalCues: SubtitleCue[]; diffs: SubtitleDiffEntry[] }
  | { ok: false; errors: ReworkError[] }

/** zod 层拒绝（非数组/未知 kind/额外字段/非整数毫秒等）→ 领域错误列表 */
export function parseSubtitleChanges(input: unknown): { ok: true; changes: SubtitleChange[] } | { ok: false; errors: ReworkError[] } {
  const parsed = subtitleChangesSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        code: 'invalid_change',
        message: `变更请求不合法（${i.path.join('.') || 'root'}）：${i.message}`,
      })),
    }
  }
  // 平移量非零（零位移必然 no_effect，提前给出定向错误而非泛化拒绝）
  for (const c of parsed.data) {
    if (c.kind === 'subtitle-shift' && c.deltaMs === 0) {
      return { ok: false, errors: [{ code: 'invalid_change', message: '批量平移量不能为 0 毫秒' }] }
    }
  }
  return { ok: true, changes: parsed.data }
}

/**
 * 规范化变更（用于 previewHash/请求指纹稳定性）：按目标 cue 的 ordinal 顺序排列，
 * shift 的 cueIds 按同一序排序。要求 cues 已通过 parseSubtitleChanges。
 */
export function normalizeSubtitleChanges(changes: SubtitleChange[], cues: SubtitleCue[]): SubtitleChange[] {
  const order = new Map(cues.map((c, i) => [c.id, i]))
  const rank = (id: string): number => order.get(id) ?? Number.MAX_SAFE_INTEGER
  const sorted = [...changes].sort((a, b) => {
    const ka = a.kind === 'subtitle-shift' ? rank(a.cueIds[0]!) : rank(a.cueId)
    const kb = b.kind === 'subtitle-shift' ? rank(b.cueIds[0]!) : rank(b.cueId)
    return ka - kb || a.kind.localeCompare(b.kind)
  })
  return sorted.map((c) =>
    c.kind === 'subtitle-shift'
      ? { ...c, cueIds: [...c.cueIds].sort((x, y) => rank(x) - rank(y)) }
      : c,
  )
}

/**
 * 应用结构化变更 → 最终 cue 全列表 + diff。整体成功或整体失败，绝不部分生效。
 * durationMs 为成片实测时长（整数毫秒），由服务端基准提供，不接受前端可信值。
 */
export function applySubtitleChanges(args: {
  cues: SubtitleCue[]
  changes: SubtitleChange[]
  durationMs: number
}): ApplyChangesResult {
  const { cues, changes, durationMs } = args
  const errors: ReworkError[] = []
  const byId = new Map(cues.map((c) => [c.id, c]))
  const touched = new Map<string, SubtitleChange['kind']>()

  // 1) 引用与冲突：未知 cue、同 cue 命中多种/多次操作，全部收集后拒绝
  for (const ch of changes) {
    const ids = ch.kind === 'subtitle-shift' ? ch.cueIds : [ch.cueId]
    const unique = new Set(ids)
    if (unique.size !== ids.length) {
      errors.push({ code: 'conflicting_changes', message: '同一条字幕不能重复出现在多个平移目标中' })
    }
    for (const id of unique) {
      if (!byId.has(id)) {
        errors.push({ code: 'unknown_cue', message: `字幕标识 ${id} 不存在于当前基准版本`, cueId: id })
        continue
      }
      const prev = touched.get(id)
      if (prev) {
        errors.push({ code: 'conflicting_changes', message: `字幕 ${id} 同时命中 ${prev} 与 ${ch.kind}，一条字幕仅允许一种操作一次`, cueId: id })
      } else {
        touched.set(id, ch.kind)
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  // 2) 内容校验：文字安全性 + 目标时间原始合法性（NaN/小数已由 zod 拦截）
  for (const ch of changes) {
    if (ch.kind === 'subtitle-text') {
      const err = validateSubtitleText(ch.text, ch.cueId)
      if (err) errors.push(err)
    }
    if (ch.kind === 'subtitle-time') {
      if (!Number.isSafeInteger(ch.startMs) || !Number.isSafeInteger(ch.endMs)) {
        errors.push({ code: 'invalid_time', message: '字幕时间必须是整数毫秒', cueId: ch.cueId })
      } else if (ch.startMs >= ch.endMs) {
        errors.push({ code: 'invalid_time', message: '字幕起点必须早于终点', cueId: ch.cueId })
      }
    }
    if (ch.kind === 'subtitle-shift') {
      if (!Number.isSafeInteger(ch.deltaMs) || Math.abs(ch.deltaMs) > MAX_SHIFT_DELTA_MS) {
        errors.push({ code: 'invalid_time', message: `平移量必须是 ±${MAX_SHIFT_DELTA_MS}ms 内的非零整数毫秒` })
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  // 3) 生成最终列表（数量与顺序不变）
  const finalCues: SubtitleCue[] = cues.map((c) => ({ ...c }))
  const idxOf = new Map(cues.map((c, i) => [c.id, i]))
  const diffs: SubtitleDiffEntry[] = []
  const pushDiff = (cueId: string, field: SubtitleDiffEntry['field'], before: string | number, after: string | number): void => {
    if (before !== after) diffs.push({ cueId, field, before, after })
  }
  for (const ch of changes) {
    if (ch.kind === 'subtitle-text') {
      const target = finalCues[idxOf.get(ch.cueId)!]!
      pushDiff(ch.cueId, 'text', target.text, ch.text)
      target.text = ch.text
    } else if (ch.kind === 'subtitle-time') {
      const target = finalCues[idxOf.get(ch.cueId)!]!
      pushDiff(ch.cueId, 'startMs', target.startMs, ch.startMs)
      pushDiff(ch.cueId, 'endMs', target.endMs, ch.endMs)
      target.startMs = ch.startMs
      target.endMs = ch.endMs
    } else {
      for (const id of ch.cueIds) {
        const target = finalCues[idxOf.get(id)!]!
        pushDiff(id, 'startMs', target.startMs, target.startMs + ch.deltaMs)
        pushDiff(id, 'endMs', target.endMs, target.endMs + ch.deltaMs)
        target.startMs += ch.deltaMs
        target.endMs += ch.deltaMs
      }
    }
  }

  // 4) 无有效变化整体拒绝；全列表最终校验（界内/单调/不重叠），失败不产出部分结果
  if (diffs.length === 0) {
    return { ok: false, errors: [{ code: 'no_effect', message: '变更结果与当前基准完全一致，没有需要应用的修改' }] }
  }
  const listErr = validateCueList(finalCues, durationMs)
  if (listErr) return { ok: false, errors: [listErr] }
  return { ok: true, finalCues, diffs }
}
