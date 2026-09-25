/**
 * 精确返修（precision-rework）· 字幕纯解析/序列化（无任何 IO/DB/env 依赖）。
 *
 * 语义口径（规格 §4/§6.1）：
 * - cue 时间一律整数毫秒；序列化统一 `HH:MM:SS,mmm`（解析兼容 `.` 分隔毫秒）。
 * - 文本为受限纯文本：保留正常换行，拒绝控制字符、ASS 覆盖标签（{ } \）与任意 HTML 标签；
 *   绝不把输入当路径/命令/滤镜表达式（消费端只落不可变文件，由 hash 引用）。
 * - cue 标识由「字幕基准 tag + ordinal」生成，修订中保持稳定；源字幕重建后 baseTag 变化，
 *   旧标识不得跨基准沿用。
 */
import { createHash } from 'node:crypto'

/** SRT 总大小上限（UTF-8 字节） */
export const SRT_MAX_BYTES = 2 * 1024 * 1024
/** 单份字幕 cue 数上限 */
export const SRT_MAX_CUES = 5000
/** 单 cue 文本字符上限 */
export const SRT_MAX_CUE_TEXT_CHARS = 2000

/** 可编辑字幕 cue（最终成片时间轴坐标） */
export interface SubtitleCue {
  id: string
  startMs: number
  endMs: number
  text: string
}

/** 无标识的解析中间态 */
export interface RawCue {
  startMs: number
  endMs: number
  text: string
}

/** 领域错误：code 供程序分支，message 为中文可操作提示 */
export interface ReworkError {
  code: string
  message: string
  cueId?: string
}

export type ParseResult = { ok: true; cues: RawCue[] } | { ok: false; error: ReworkError }

const TIME_LINE_RE = /^(\d{1,3}):([05]\d):([05]\d)[,.](\d{3})\s*-->\s*(\d{1,3}):([05]\d):([05]\d)[,.](\d{3})$/
// 控制字符：允许 \n（正常换行）与 \r 已在换行归一时消除；\t 与其他 C0/C1、DEL 拒绝
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
const ASS_TAG_RE = /[{}\\]/
const HTML_TAG_RE = /<\s*\/?[A-Za-z!][^>]*>/

function clockToMs(h: string, m: string, s: string, ms: string): number {
  return ((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000) + Number(ms)
}

/** 整数毫秒 → `HH:MM:SS,mmm` */
export function msToClock(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error(`非法毫秒值: ${ms}`)
  const p = (n: number, w: number): string => String(n).padStart(w, '0')
  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / 1000) % 60
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms % 1000, 3)}`
}

/** 受限纯文本校验（解析与应用修订共用）；合法返回 null */
export function validateSubtitleText(text: string, cueId?: string): ReworkError | null {
  if (text.length === 0 || text.trim().length === 0) {
    return { code: 'unsafe_text', message: '字幕文本不能为空', cueId }
  }
  if (text.length > SRT_MAX_CUE_TEXT_CHARS) {
    return { code: 'unsafe_text', message: `单条字幕不能超过 ${SRT_MAX_CUE_TEXT_CHARS} 字符（当前 ${text.length}）`, cueId }
  }
  if (/\n\s*\n/.test(text)) {
    return { code: 'unsafe_text', message: '字幕文本内不能包含空行', cueId }
  }
  if (CONTROL_CHAR_RE.test(text)) {
    return { code: 'unsafe_text', message: '字幕文本包含控制字符，已拒绝', cueId }
  }
  if (ASS_TAG_RE.test(text)) {
    return { code: 'unsafe_text', message: '字幕文本不能包含 ASS 标签字符 { } \\', cueId }
  }
  if (HTML_TAG_RE.test(text)) {
    return { code: 'unsafe_text', message: '字幕文本不能包含 HTML 标签', cueId }
  }
  return null
}

/**
 * 严格解析 SRT → 有序 RawCue 列表。
 * 拒绝：超 2 MiB、超 5000 cue、缺时间戳行、空文本、不安全文本、start>=end、
 * 时间乱序或重叠（相邻 end=start 合法）。整体拒绝，不做静默跳过或裁切。
 */
export function parseSubtitleSrt(srt: string): ParseResult {
  if (Buffer.byteLength(srt, 'utf8') > SRT_MAX_BYTES) {
    return { ok: false, error: { code: 'srt_too_large', message: `字幕文件超过 ${SRT_MAX_BYTES} 字节上限` } }
  }
  const normalized = srt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = normalized.split(/\n[ \t]*\n+/).map((b) => b.trim()).filter((b) => b.length > 0)
  if (blocks.length > SRT_MAX_CUES) {
    return { ok: false, error: { code: 'too_many_cues', message: `字幕条数超过 ${SRT_MAX_CUES} 上限` } }
  }
  const cues: RawCue[] = []
  let prevEnd = -1
  for (const block of blocks) {
    const lines = block.split('\n')
    const ti = lines.findIndex((l) => TIME_LINE_RE.test(l))
    if (ti < 0) return { ok: false, error: { code: 'invalid_srt', message: `第 ${cues.length + 1} 条字幕缺少合法时间戳行` } }
    // 时间戳前的纯数字行视为序号（纯数字正文位于时间戳之后，不受影响）
    if (ti > 0 && !/^\d+$/.test(lines.slice(0, ti).join('\n').trim())) {
      return { ok: false, error: { code: 'invalid_srt', message: `第 ${cues.length + 1} 条字幕时间戳行之前存在非序号内容` } }
    }
    const m = TIME_LINE_RE.exec(lines[ti]!)!
    const startMs = clockToMs(m[1]!, m[2]!, m[3]!, m[4]!)
    const endMs = clockToMs(m[5]!, m[6]!, m[7]!, m[8]!)
    const ordinal = cues.length + 1
    if (startMs >= endMs) {
      return { ok: false, error: { code: 'invalid_time', message: `第 ${ordinal} 条字幕起点必须早于终点` } }
    }
    if (startMs < prevEnd) {
      return { ok: false, error: { code: 'overlapping_cues', message: `第 ${ordinal} 条字幕与上一条时间重叠（允许端点相接）` } }
    }
    const text = lines.slice(ti + 1).join('\n').trim()
    if (text.length === 0) {
      return { ok: false, error: { code: 'invalid_srt', message: `第 ${ordinal} 条字幕没有文本内容` } }
    }
    const textErr = validateSubtitleText(text)
    if (textErr) return { ok: false, error: { ...textErr, message: `第 ${ordinal} 条字幕：${textErr.message}` } }
    cues.push({ startMs, endMs, text })
    prevEnd = endMs
  }
  if (cues.length === 0) {
    return { ok: false, error: { code: 'invalid_srt', message: '字幕内容为空，没有可编辑的 cue' } }
  }
  return { ok: true, cues }
}

/** 由源字幕内容 hash 派生基准 tag（同一源重建前稳定；标识不得跨基准沿用） */
export function subtitleBaseTag(sourceSha256: string): string {
  return createHash('sha256').update(`subtitle-base:${sourceSha256}`).digest('hex').slice(0, 12)
}

/** ordinal（1 起）+ 基准 tag → 稳定 cue 标识 */
export function makeCueId(baseTag: string, ordinal: number): string {
  return `srt:${baseTag}:c${ordinal}`
}

/** RawCue 列表按序挂稳定标识 */
export function attachCueIds(raw: RawCue[], baseTag: string): SubtitleCue[] {
  return raw.map((c, i) => ({ ...c, id: makeCueId(baseTag, i + 1) }))
}

/** cue 列表 → 规范 SRT 文本（`\n` 换行、序号连续、结尾单个换行） */
export function serializeSubtitleSrt(cues: Array<Omit<SubtitleCue, 'id'>>): string {
  return cues.map((c, i) => `${i + 1}\n${msToClock(c.startMs)} --> ${msToClock(c.endMs)}\n${c.text}`).join('\n\n') + '\n'
}

/** 时间字段界与整数校验（应用修订与预览复校验共用）；返回首个错误 */
export function validateCueTiming(cue: { startMs: number; endMs: number }, durationMs: number, cueId: string): ReworkError | null {
  const { startMs, endMs } = cue
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
    return { code: 'invalid_time', message: '字幕时间必须是整数毫秒', cueId }
  }
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    return { code: 'invalid_time', message: '成片时长基准无效，无法校验字幕边界' }
  }
  if (startMs < 0) return { code: 'out_of_range', message: '字幕起点不能为负', cueId }
  if (startMs >= endMs) return { code: 'invalid_time', message: '字幕起点必须早于终点', cueId }
  if (endMs > durationMs) return { code: 'out_of_range', message: `字幕终点不能超过成片实测时长 ${durationMs}ms`, cueId }
  return null
}

/** 全列表最终一致性校验：逐 cue 界内 + 顺序单调不重叠（相邻 end=start 合法） */
export function validateCueList(cues: SubtitleCue[], durationMs: number): ReworkError | null {
  let prevEnd = -1
  for (const c of cues) {
    const err = validateCueTiming(c, durationMs, c.id)
    if (err) return err
    if (c.startMs < prevEnd) return { code: 'overlapping_cues', message: `字幕 ${c.id} 与前一条时间重叠（允许端点相接）`, cueId: c.id }
    prevEnd = c.endMs
  }
  return null
}
