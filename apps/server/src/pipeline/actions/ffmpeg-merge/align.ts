import { shotDurationSec } from '../../../services/shot'
import { round3 } from './util'
import type { StepContext } from '../../context'

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
  /** [统一时轴] best-effort：命中镜已产出 canonical 计划，但存在被跳过的幽灵句（分镜引用却无实测配音） */
  partial?: boolean
  /** [统一时轴] 被跳过的句 id（幽灵句；无配音不入时间轴） */
  warnLines?: string[]
  /** [统一时轴] 计划所属模式（溯源；images 音频驱动 / motion 真实 clip 时长） */
  mode?: 'images' | 'motion'
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
export async function loadShotAlignShots(
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

/**
 * [以音定画] 逐镜音频驱动时长（纯函数，探针直测）：镜头视频时长跟随该镜所属台词句的实测音频总长。
 * 供 ai_video 生成期把每镜 clip 时长对齐台词音频——动效模式合成分镜段 = clip 自身时长、
 * 音频轨逐句首尾相接，故只要每镜 clip 长 == 该镜台词音频和，累计音画即逐镜对齐（消除「先视频后配音」的时长错位）。
 * 与 planVoiceAlignedSegments 不同：不做全量映射严格校验、不以显式时长取大——只要有 ≥1 句命中即采用句和；
 * 无命中句（空镜/动作镜）不进表（调用方回退分镜估长/兜底）。
 */
export function planAudioDrivenShotDurations(
  shots: AlignShotInput[],
  voiceDur: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>()
  if (voiceDur.size === 0) return out
  for (const s of shots) {
    let sum = 0
    for (const id of s.lineIds) sum += voiceDur.get(id) ?? 0
    if (sum > 0) out.set(s.id, round3(sum))
  }
  return out
}

/**
 * [统一时轴·中档] best-effort 时间轴计划：与 planVoiceAlignedSegments 同段/双轴算法，但放宽
 * 「一个幽灵句即整体回退」——分镜引用但缺实测配音的句按 0 长跳过（记 warnLines / partial=true），
 * 其余命中镜仍产出 canonical 计划，供视频段长 + 字幕平移 + 音轨同源消费（消除回退即漂移）。
 * 保留的硬失败：no_shots / no_voices / no_lines_field（多镜无归属 → fit_voice 残差）/ 重复映射（歧义）/
 * 孤儿配音（有 voice 无镜引用 → 视频将短于音轨，不可安全对齐）。无幽灵句时行为与 planVoiceAlignedSegments 逐字节一致。
 * mode：images 段长 = max(explicit, Σ命中句)（音频驱动，显式为下限防台词被截）；
 *       motion 段长 = clipDurByShotId 真实 clip 时长（不拉伸），仅借 lineIds 把字幕平移到 clip 累计轴。
 */
export function planBestEffortTimeline(
  shots: AlignShotInput[],
  voiceDur: Map<string, number>,
  fallbackDur: number,
  opts: { hasLinesField: boolean; mode: 'images' | 'motion'; clipDurByShotId?: Map<string, number> },
): AlignPlan {
  const fail = (reason: string): AlignPlan => ({ aligned: false, reason, segments: [], lines: [], totalDur: 0 })
  if (shots.length === 0) return fail('no_shots')
  if (voiceDur.size === 0) return fail('no_voices')
  if (!opts.hasLinesField) return fail('no_lines_field')
  // 逐镜解析命中句：幽灵句（分镜引用但 voiceDur 缺）跳过并告警，不阻断；重复映射=歧义仍整体失败
  const mapped = new Set<string>()
  const warnLines: string[] = []
  const resolved: Array<{ shot: AlignShotInput; ids: string[] }> = []
  for (const s of shots) {
    const ids: string[] = []
    for (const id of s.lineIds) {
      if (mapped.has(id)) return fail('mapping_mismatch')
      if (!voiceDur.has(id)) {
        warnLines.push(id)
        continue
      }
      mapped.add(id)
      ids.push(id)
    }
    resolved.push({ shot: s, ids })
  }
  if (mapped.size !== voiceDur.size) return fail('mapping_mismatch')
  const safeFallback = fallbackDur > 0 ? fallbackDur : 4
  const segments: AlignPlan['segments'] = []
  const lines: AlignLine[] = []
  const warnShots: string[] = []
  let speechCursor = 0
  let timelineCursor = 0
  for (const { shot: s, ids } of resolved) {
    const sum = ids.reduce((acc, id) => acc + voiceDur.get(id)!, 0)
    let durSec: number
    let silenceSec = 0
    if (opts.mode === 'motion') {
      const clipDur = opts.clipDurByShotId?.get(s.id)
      durSec = clipDur != null && clipDur > 0 ? clipDur : s.durationSec != null && s.durationSec > 0 ? s.durationSec : safeFallback
      silenceSec = Math.max(0, durSec - sum)
    } else if (ids.length > 0) {
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
    for (const id of ids) {
      lines.push({ lineId: id, speechStart: round3(speechCursor + inShot), timelineStart: round3(timelineCursor + inShot) })
      inShot += voiceDur.get(id)!
    }
    speechCursor += inShot
    segments.push({ shotId: s.id, durSec: round3(durSec), lineIds: [...ids], silenceSec: round3(silenceSec) })
    timelineCursor += durSec
  }
  return { aligned: true, segments, lines, totalDur: round3(timelineCursor), warnShots, partial: warnLines.length > 0, warnLines, mode: opts.mode }
}

/** [M11] SRT 每 cue 平移秒数（cue ↔ 句序 = voices 序；任一缺失 → null = 不平移） */
export function planSrtShifts(align: AlignPlan, lineIdsInCueOrder: string[]): number[] | null {
  if (!align.aligned || lineIdsInCueOrder.length === 0) return null
  const byId = new Map(align.lines.map((l) => [l.lineId, l]))
  const shifts: number[] = []
  for (const id of lineIdsInCueOrder) {
    const line = byId.get(id)
    if (!line) {
      // [统一时轴] partial：该 cue 句未命中计划（幽灵/无实测配音）→ 不平移（shift 0），不整体放弃
      if (!align.partial) return null
      shifts.push(0)
      continue
    }
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

/** [M11] SRT 时间戳行正则（cue 行：hh:mm:ss,mmm --> hh:mm:ss,mmm；兼容 . 分隔）；[M19] 提升为模块级共享常量 */
const SRT_TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/

/** [M19] SRT cue 数（时间戳行计数；片头位移平移前校验用） */
export function countSrtCues(srt: string): number {
  let n = 0
  for (const line of srt.split(/\r?\n/)) {
    if (SRT_TIME_RE.test(line)) n++
  }
  return n
}

/** [M11] SRT 逐 cue 平移（保格式；cue 数与 shifts 不符 → null） */
export function shiftSrtText(srt: string, shifts: number[]): string | null {
  const timeRe = SRT_TIME_RE
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
