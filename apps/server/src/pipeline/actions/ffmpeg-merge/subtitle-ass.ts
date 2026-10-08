import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { wrapSingleLine, estimateMaxCharsPerLine } from './subtitle-wrap'
import { buildSubtitleStyle, assStyleRow, assStyleFontSize } from './subtitle-style'
import type { SubtitleStyleConfig } from '../../../services/brand-config'

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
 * opts.cutCues（字卡启用时）：裁前 N 个 cue（标题已由字卡呈现，防双呈现；仅影响烧录 ASS，
 * 不改 SRT 资产——SRT 资产不可变契约；缺省/0 → 事件序列逐字节不变）。
 * opts.styles / opts.cueStyle（分层排版）：Default 之外追加具名 Style 行（字号/边距按本路
 * 尺寸重算），cue→样式组下标（源=资产 params.style_plan.cue_style，索引为**原始 cue 序**含已裁段）；
 * 映射缺失/越界 → 该 cue 回落 Default；换行预算按各 cue 生效样式字号。缺省两参 → 逐字节零 diff。
 * opts.defaultCfg（分层排版配套）：非空时 Default 行改由 assStyleRow 按合并主样式全量生成
 *（颜色/描边/落位等，与省略 force_style 的烧录链配套；字号仍按 opts.fontSize 基线链公式由调用方传入）。
 */
export function srtToAss(
  srt: string,
  opts: {
    width: number
    height: number
    fontSize?: number
    cutCues?: number
    styles?: Array<{ name: string; cfg: SubtitleStyleConfig }>
    cueStyle?: number[]
    defaultCfg?: SubtitleStyleConfig
  },
): string {
  const { width, height } = opts
  const fontSize = Math.max(16, Math.round(opts.fontSize ?? height * 0.04))
  const marginL = Math.round(width * 0.05)
  const marginV = Math.round(height * 0.02)
  const maxChars = estimateMaxCharsPerLine(width, fontSize)
  // T7：defaultCfg 非空 → Default 行全量承接合并主样式（配合烧录链省略 force_style）；字号仍用 opts.fontSize 基线链
  const defaultRow = opts.defaultCfg
    ? assStyleRow('Default', { ...opts.defaultCfg, size_pct: undefined, font: undefined }, width, height, fontSize)
    : `Style: Default,Noto Sans CJK SC,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,${marginL},${marginL},${marginV},1`
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
    defaultRow,
    ...(opts.styles ?? []).map((s) => assStyleRow(s.name, s.cfg, width, height)),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const cut = typeof opts.cutCues === 'number' && Number.isFinite(opts.cutCues) ? Math.max(0, Math.floor(opts.cutCues)) : 0
  const events = parseSrtCues(srt)
    .slice(cut)
    .map((c, i) => {
      const named = opts.cueStyle ? opts.styles?.[opts.cueStyle[cut + i] ?? -1] : undefined
      const styleName = named?.name ?? 'Default'
      const budget = named ? estimateMaxCharsPerLine(width, assStyleFontSize(named.cfg, height)) : maxChars
      const wrapped = c.text
        .split('\n')
        .flatMap((l) => wrapSingleLine(l, budget))
        .map(escapeAssText)
        .filter((l) => l.length > 0)
        .join('\\N')
      return `Dialogue: 0,${csToAssTime(c.startCs)},${csToAssTime(c.endCs)},${styleName},,0,0,0,,${wrapped}`
    })
  return `${header.concat(events).join('\n')}\n`
}

/**
 * 烧录用 ASS 产物组（自 index.ts 拆出：≤800 行红线，行为零变更）：主路 + 每派生画幅各一份
 * 显式 PlayRes 的临时 ASS（文件名 .sub-<runId>-<stamp><tag>.ass 落 srt 同目录；新建文件路径逐一
 * 推入 opts.temps 供合成后清理，写入中途抛错时已落盘文件仍可回收）。派生路字号：品牌结构化
 * 字幕配置按该路高度重算，否则继承主路字号。调用方 catch 后回落 SRT 原样烧录。
 */
export function buildAssBurnPaths(opts: {
  srtAbs: string
  style: string
  width: number
  height: number
  runId: number
  derived: Array<{ w: number; h: number }>
  brandSubtitle: SubtitleStyleConfig | null
  temps: string[]
  /** 字卡已生成时裁前 N 个标题 cue（主/派生各路同裁；缺省/0 逐字节不变） */
  cutCues?: number
  /** 分层排版：具名样式组 + cue→组下标（各组字号按各路高度重算，同一引用透传；缺省零 diff） */
  styles?: Array<{ name: string; cfg: SubtitleStyleConfig }>
  cueStyle?: number[]
}): string[] {
  const fsFromStyle = (s: string, fb: number): number => {
    const m = /FontSize=([\d.]+)/.exec(s)
    return m ? Number(m[1]) : fb
  }
  const rawSrt = readFileSync(opts.srtAbs, 'utf8')
  const mainFontSize = fsFromStyle(opts.style, Math.max(16, Math.round(opts.height * 0.04)))
  const assDir = dirname(opts.srtAbs)
  const stamp = Date.now()
  // T7：多 Style 启用且主样式 cfg 在位 → Default 行按 cfg 全量生成（烧录链同步省略 force_style，由 index 传 assLayered）
  const defaultCfg = opts.styles?.length ? opts.brandSubtitle ?? undefined : undefined
  const writeAss = (w: number, h: number, fontSize: number, tag: string): string => {
    const ass = srtToAss(rawSrt, { width: w, height: h, fontSize, cutCues: opts.cutCues, styles: opts.styles, cueStyle: opts.cueStyle, defaultCfg })
    const p = join(assDir, `.sub-${opts.runId}-${stamp}${tag}.ass`)
    writeFileSync(p, ass, 'utf8')
    opts.temps.push(p)
    return p
  }
  const paths = [writeAss(opts.width, opts.height, mainFontSize, '')]
  for (const t of opts.derived) {
    const fs = opts.brandSubtitle
      ? fsFromStyle(buildSubtitleStyle(t.h, opts.brandSubtitle), Math.max(16, Math.round(t.h * (opts.brandSubtitle.size_pct ?? 0.04))))
      : mainFontSize
    paths.push(writeAss(t.w, t.h, fs, `-${paths.length}`))
  }
  return paths
}
