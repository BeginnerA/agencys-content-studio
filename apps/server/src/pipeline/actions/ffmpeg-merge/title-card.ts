import { existsSync } from 'node:fs'
import { wrapSingleLine, estimateMaxCharsPerLine } from './subtitle-wrap'
import type { SubtitleStyleConfig } from '../../../services/brand-config'

/**
 * 本地标题字卡（M61 T3）：lavfi 纯色底图 + drawtext 逐行 → 单帧 PNG，作为片首归一化段入混剪链。
 *
 * 设计红线：
 *  - 字卡文字必须本地 drawtext 渲染（AI 生成图像内嵌汉字会乱码——失效面规避，AI 仅提供无文字底图，见 T6）；
 *  - 字体解析宽容：解析不到 CJK 字体 → null，调用方整体跳过字卡（标题回退字幕烧录，绝不产出乱码卡）；
 *  - 纯函数 + 同步 fs 存在性检查，探针可直测；ffmpeg 执行由调用方（index.ts）完成。
 */

/** CJK 字体候选解析：ACS_CJK_FONT_FILE > Windows 微软雅黑/黑体 > Linux Noto CJK；全部缺失 → null（调用方降级） */
export function resolveCjkFont(env: NodeJS.ProcessEnv = process.env): string | null {
  const winRoot = (env['WINDIR'] || env['SystemRoot'] || 'C:/Windows').replace(/\\/g, '/')
  const candidates = [
    env['ACS_CJK_FONT_FILE'],
    `${winRoot}/Fonts/msyh.ttc`,
    `${winRoot}/Fonts/simhei.ttf`,
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/arphic/uming.ttc',
  ].filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      // 存在性检查异常按不存在处理
    }
  }
  return null
}

/** fontfile 路径转义（filtergraph 口径）：反斜杠→正斜杠、盘符冒号 → \:（Windows subtitles/drawtext 已知坑） */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

/**
 * 字幕资产 params JSON → M61 启用键（[M61-split] 自 index.ts 解析块拆出，语义逐字保持）：
 * 损坏 JSON/缺键 → 全零值 + stylePlan null（= 现状样式链与烧录链零改动）；不抛错。
 */
export function parseM61SubtitleParams(raw: string | null | undefined): {
  endMs: number
  titleLines: number
  msPerLine: number
  leadInMs: number
  stylePlan: { style?: SubtitleStyleConfig; styles?: SubtitleStyleConfig[]; cue_style?: number[] } | null
} {
  let p: { durationMs?: number; title_lines?: number; ms_per_line?: number; lead_in_ms?: number; style_plan?: { style?: SubtitleStyleConfig; styles?: SubtitleStyleConfig[]; cue_style?: number[] } }
  try {
    p = JSON.parse(raw ?? '{}')
  } catch {
    p = {}
  }
  const posRound = (v: unknown, allowZero: boolean): number =>
    typeof v === 'number' && Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? Math.round(v) : 0
  return {
    endMs: typeof p['durationMs'] === 'number' ? p['durationMs'] : 0,
    titleLines: posRound(p['title_lines'], false),
    msPerLine: posRound(p['ms_per_line'], false),
    leadInMs: posRound(p['lead_in_ms'], true),
    stylePlan: p['style_plan'] && typeof p['style_plan'] === 'object' && !Array.isArray(p['style_plan']) ? p['style_plan'] : null,
  }
}

/** drawtext text= 值转义：反斜杠/单引号/冒号/百分号（固定行文本进出片标题，保守全逃） */
export function escapeDrawtext(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%')
}

/** '#RRGGBB' → drawtext 颜色 '0xRRGGBB' */
export function toDrawtextColor(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `0x${hex.slice(1).toUpperCase()}` : '0xFFFFFF'
}

/** 卡内字号：标题组 size_pct（缺省 0.055 观感）；下限 24px 保证小画幅可读 */
export function cardFontSize(height: number, style: SubtitleStyleConfig): number {
  return Math.max(24, Math.round(Math.max(1, height) * (style.size_pct ?? 0.055)))
}

/** 逐行按宽度预算 \N 语义预换行（复用 subtitle-wrap 预算），返回物理行序列（行序自上而下） */
export function layoutCardLines(lines: string[], width: number, fontSize: number): string[] {
  const max = estimateMaxCharsPerLine(width, fontSize)
  const out: string[] = []
  for (const l of lines) {
    const t = l.trim()
    if (!t) continue
    out.push(...wrapSingleLine(t, max))
  }
  return out
}

/**
 * 单帧 PNG 生成参数（纯函数，探针可直测）：color 底 + 逐物理行一条 drawtext（水平居中，
 * 垂直按 alignment 块布局：5 居中 / 8 顶部（上边距 8%H）/ 2 底部（下边距 12%H），行距 1.3×字号）。
 * bg 缺省深蓝黑 #101826（spec 定案，影厅质感）；描边宽 = H × outline_pct（缺省 0.0018，粗描抗亮底图）。
 * bgImageAbs（M61 T6）：AI 无文字底图绝对路径 → 改用图片输入分支：scale/crop 满幅 + drawbox 半透明压暗
 * （black@0.45 全幅，保标题可读）+ 同一条 drawtext 链；缺省/空串 → 色底分支逐字节不变（降级 local）。
 */
export function buildTitleCardArgs(p: {
  fontFile: string
  lines: string[]
  width: number
  height: number
  fps: number
  outAbs: string
  style?: SubtitleStyleConfig
  bg?: string
  alignment?: 2 | 5 | 8
  bgImageAbs?: string | null
}): string[] {
  const width = Math.max(2, Math.round(p.width))
  const height = Math.max(2, Math.round(p.height))
  const style = p.style ?? {}
  const alignment = p.alignment ?? style.alignment ?? 5
  const fs = cardFontSize(height, style)
  const rows = layoutCardLines(p.lines, width, fs)
  if (rows.length === 0) throw new Error('title-card: 无有效文字行')
  const lineH = Math.round(fs * 1.3)
  const blockH = lineH * rows.length
  const startY = alignment === 8
    ? Math.round(height * 0.08)
    : alignment === 2
      ? height - Math.round(height * 0.12) - blockH
      : Math.round((height - blockH) / 2)
  const font = escapeFilterPath(p.fontFile)
  const color = toDrawtextColor(style.color ?? '#FFFFFF')
  const borderColor = toDrawtextColor(style.outline_color ?? '#000000')
  const borderw = Math.max(1, Math.round(height * (style.outline_pct ?? 0.0018)))
  const bold = style.bold === false ? ':fontweight=0' : ''
  const draws = rows
    .map((row, i) => {
      const y = startY + i * lineH
      return `drawtext=fontfile='${font}':text='${escapeDrawtext(row)}':x=(w-text_w)/2:y=${y}:fontsize=${fs}:fontcolor=${color}:borderw=${borderw}:bordercolor=${borderColor}${bold}`
    })
    .join(',')
  const bgHex = /^#[0-9a-fA-F]{6}$/.test(p.bg ?? '') ? (p.bg as string) : '#101826'
  const bg = `0x${bgHex.slice(1).toUpperCase()}`
  const bgImg = typeof p.bgImageAbs === 'string' && p.bgImageAbs.trim() ? p.bgImageAbs.trim() : null
  if (bgImg) {
    // AI 底图分支：满幅缩放裁剪 → 全幅半透明压暗 → 标题逐行叠加（文字永远本地 drawtext，绝不由生图模型画）
    const fill = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},drawbox=x=0:y=0:w=${width}:h=${height}:color=black@0.45:t=fill`
    return ['-y', '-i', bgImg, '-frames:v', '1', '-vf', `${fill},${draws}`, p.outAbs]
  }
  return [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${bg}:s=${width}x${height}:r=${Math.max(1, Math.round(p.fps))}`,
    '-frames:v', '1',
    '-vf', draws,
    p.outAbs,
  ]
}
