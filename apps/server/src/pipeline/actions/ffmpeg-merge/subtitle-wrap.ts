/**
 * [M32] 字幕预换行（ASS 生成前的长行兵底）。
 *
 * 背景：服务端默认使用内置 ffmpeg-static（libass 未编译 ASS_FEATURE_WRAP_UNICODE），
 * 该 libass 只能在「空格」处换行；中文无空格 → 长句不自动换行。烧录链路已改为
 * 带显式 PlayResX/Y 的 ASS（见 subtitle-ass.ts），字号回归真实像素后绝大多数行能单行容纳；
 * 本模块作为超长行（如 estimated 模式产出的长句）的兵底，按宽度预算用 \N 硬切。
 *
 * 纯函数、无副作用。
 */

/**
 * CJK 全角字宽经验系数：单字像素宽 ≈ FontSize × 该系数。
 * ASS 已声明 PlayResY=输出高 → FontSize 即真实像素，CJK 全角/全角标点的 advance 恰为 1 em（= FontSize），
 * 故取 1.0（诚实值）。安全余量不再靠放大系数，而由每侧 5% 边距（SIDE_MARGIN_FRAC）提供：预算 =
 * (width − 2×边距) / 字宽，字满也仅贴到边距内侧、绝不冲出画面。旧值 1.4 过度预留 → 长句被过早拆成两行。
 */
export const CJK_WIDTH_FACTOR = 1.0

/** 每侧安全边距（占输出宽度比）：预留左右留白，避免文字贴边 */
export const SIDE_MARGIN_FRAC = 0.05

/** 优先断行标点（全/半角）：换行尽量落在标点后，保持语义完整 */
const BREAK_AFTER = new Set(Array.from('，。！？；：、,.;:!? '))

/**
 * 单行可容纳的最大 code point 数（下限 1）。
 * 可用宽 = width × (1 − 2×边距)；单字宽 ≈ max(1, fontSize) × 系数。
 */
export function estimateMaxCharsPerLine(width: number, fontSize: number): number {
  const avail = Math.max(0, width) * (1 - 2 * SIDE_MARGIN_FRAC)
  const perChar = Math.max(1, fontSize) * CJK_WIDTH_FACTOR
  return Math.max(1, Math.floor(avail / perChar))
}

/**
 * 单行文本换行：切成若干 ≤maxChars 的物理行。
 * 在窗口 [i, i+maxChars) 内取最后一个标点处断行（尽量填满且不超预算）；无标点则硬切。
 */
export function wrapSingleLine(text: string, maxChars: number): string[] {
  const max = Math.max(1, Math.floor(maxChars))
  const chars = Array.from(text)
  if (chars.length <= max) return [text]
  const out: string[] = []
  let i = 0
  while (i < chars.length) {
    if (chars.length - i <= max) {
      out.push(chars.slice(i).join(''))
      break
    }
    const windowEnd = i + max // 不含
    let cut = -1
    for (let j = windowEnd - 1; j > i; j--) {
      if (BREAK_AFTER.has(chars[j]!)) {
        cut = j + 1
        break
      }
    }
    const end = cut > i ? cut : windowEnd
    // 硬切后若行首将落在标点上（如句末「。」被甩到下一行），把该标点吸收进行内，避免孤立标点行；
    // 多带的 1 个全角标点（≈1em）落在每侧 5% 边距预留的余量内（2×5%×width ≥ 51px），仍不冲出画面。
    let lineEnd = end
    while (lineEnd < chars.length && lineEnd - i <= max && BREAK_AFTER.has(chars[lineEnd]!)) lineEnd++
    out.push(chars.slice(i, lineEnd).join(''))
    i = lineEnd
  }
  return out
}

/** SRT 时间戳行（cue 的第二行）：hh:mm:ss,mmm --> ...；兼容 . 分隔毫秒 */
const SRT_TIME_RE = /^\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/

/**
 * 整份 SRT 预换行：命中时间戳行后，把该 cue 的文本行逐行按 maxCharsPerLine 换行；
 * 序号行 / 时间戳行 / 空行原样保留，换行符风格（\r\n 或 \n）跟随原文。
 * maxCharsPerLine ≤ 0 → 原样返回（不换行）。
 */
export function wrapSrtText(srt: string, maxCharsPerLine: number): string {
  if (!srt || maxCharsPerLine <= 0) return srt
  const sep = srt.includes('\r\n') ? '\r\n' : '\n'
  const lines = srt.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    out.push(line)
    if (!SRT_TIME_RE.test(line)) continue
    // 收集本 cue 的文本行（直到空行或文件尾）
    const textLines: string[] = []
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== '') {
      i++
      textLines.push(lines[i]!)
    }
    for (const t of textLines) out.push(...wrapSingleLine(t, maxCharsPerLine))
  }
  return out.join(sep)
}
