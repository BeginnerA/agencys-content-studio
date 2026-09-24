import { wrapSingleLine, estimateMaxCharsPerLine } from './subtitle-wrap'

/**
 * SRT → ASS 文档生成（字幕溢出根因修复）。
 *
 * 问题：`subtitles` 滤镜直接吃 SRT 时，libass 用「默认小 PlayResY（≈384）」解释 force_style 的
 * FontSize，再按 输出高/PlayResY 放大 → 有效字号 ∝ 高度² 二次膨胀（1080p 尤甚），叠加内置
 * ffmpeg 的 libass 不支持 CJK 换行 → 长句横向冲出画面。
 *
 * 修复：把喂给 subtitles 滤镜的文件换成**显式声明 PlayResX/PlayResY = 输出尺寸**的 ASS。
 * 如此 force_style 的 FontSize 即真实像素（公式 height×size_pct 名副其实），居中/边距按真实
 * 像素计算，跨 ffmpeg 构建稳定；左右安全边距由 ASS Default Style 的 MarginL/MarginR 提供
 * （force_style 不含这两项，故 Style 值生效）。超长行仍以 \N 预换行兜底（见 subtitle-wrap）。
 *
 * force_style 串与 buildComposeArgs 的 args 结构均不变（仅文件内容由 SRT 变 ASS、扩展名变 .ass）。
 */

/** SRT 时间戳行（hh:mm:ss,mmm --> hh:mm:ss,mmm；兼容 . 分隔毫秒） */
const SRT_TIME_RE =
  /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/

interface AssCue {
  startCs: number
  endCs: number
  text: string
}

/** SRT 时钟分量 → 厘秒（centisecond，ASS 时间精度 1/100s） */
function clockToCs(h: string, m: string, s: string, ms: string): number {
  return Math.round(((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms)) / 10)
}

/** 厘秒 → ASS 时间戳 h:mm:ss.cc（小时单/多位均可，冒号分隔） */
function csToAssTime(cs: number): string {
  const totalMs = Math.max(0, Math.round(cs * 10))
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(totalMs / 3600000)
  const m = Math.floor(totalMs / 60000) % 60
  const s = Math.floor(totalMs / 1000) % 60
  const cc = Math.floor(totalMs / 10) % 100
  return `${h}:${p2(m)}:${p2(s)}.${p2(cc)}`
}

/** ASS Dialogue 文本转义：去 {} 与 \（覆盖标签/换行控制符），避免破坏事件结构 */
function escapeAssText(s: string): string {
  return s.replace(/[{}\\]/g, '').trim()
}

/** SRT 文本 → cue 列表（块以空行分隔；无时间戳/空文本块跳过） */
export function parseSrtCues(srt: string): AssCue[] {
  const cues: AssCue[] = []
  for (const block of srt.split(/\r?\n[ \t]*\r?\n+/)) {
    const lines = block.split(/\r?\n/)
    const ti = lines.findIndex((l) => SRT_TIME_RE.test(l))
    if (ti < 0) continue
    const m = SRT_TIME_RE.exec(lines[ti]!)!
    const text = lines
      .slice(ti + 1)
      .join('\n')
      .trim()
    if (!text) continue
    cues.push({
      startCs: clockToCs(m[1]!, m[2]!, m[3]!, m[4]!),
      endCs: clockToCs(m[5]!, m[6]!, m[7]!, m[8]!),
      text,
    })
  }
  return cues
}

/**
 * SRT → 完整 ASS 文档（PlayRes=输出尺寸；Default Style 带左右边距；事件文本按宽度 \N 预换行）。
 * fontSize / marginV 与 subtitle-style 基线公式同源（height×0.04 / height×0.02），
 * 但此处为真实像素（PlayResY=height，不再被二次放大）。marginL=marginR=width×0.05。
 * opts.fontSize 可传入 force_style 实际生效字号（自定义品牌放大时据此预算换行，防大字号仍溢出）。
 */
export function srtToAss(
  srt: string,
  opts: { width: number; height: number; fontSize?: number },
): string {
  const { width, height } = opts
  const fontSize = Math.max(16, Math.round(opts.fontSize ?? height * 0.04))
  const marginL = Math.round(width * 0.05)
  const marginV = Math.round(height * 0.02)
  const maxChars = estimateMaxCharsPerLine(width, fontSize)
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Noto Sans CJK SC,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,${marginL},${marginL},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const events = parseSrtCues(srt).map((c) => {
    const wrapped = c.text
      .split('\n')
      .flatMap((l) => wrapSingleLine(l, maxChars))
      .map(escapeAssText)
      .filter((l) => l.length > 0)
      .join('\\N')
    return `Dialogue: 0,${csToAssTime(c.startCs)},${csToAssTime(c.endCs)},Default,,0,0,0,,${wrapped}`
  })
  return `${header.concat(events).join('\n')}\n`
}
