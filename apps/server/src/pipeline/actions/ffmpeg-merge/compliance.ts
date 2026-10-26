/**
 * M66 合规角标纯函数：drawtext 滤镜构造 + ResolvedCompliance → ComposeArgsInput.compliance 解析。
 * 红线：resolveComplianceArg 返回 null（关闭/无字体）时 args 逐字节不变；字体缺失降级为跳过角标（warn 由调用方记）。
 */
import { escapeDrawtext, escapeFilterPath, resolveCjkFont } from './title-card'
import type { WatermarkPosition } from '../../../services/brand-config'
import type { ResolvedCompliance } from '../../../services/brand-config'

export interface ComplianceArg { text: string; position: WatermarkPosition; margin_px: number; fontAbs: string }

/** ResolvedCompliance → buildComposeArgs 入参（disabled/无 CJK 字体 → null = 关闭，args 逐字节不变） */
export function resolveComplianceArg(resolved: ResolvedCompliance | undefined, env: NodeJS.ProcessEnv = process.env): ComplianceArg | null {
  if (!resolved || resolved.enabled === false) return null
  const fontAbs = resolveCjkFont(env)
  if (!fontAbs) return null
  return { text: resolved.text, position: resolved.position, margin_px: resolved.margin_px, fontAbs }
}

/** 角标 drawtext 滤镜（白字黑底条，底色 35% 黑；fontsize = max(18, H×3%)；九宫格 x/y 表达式 drawtext 口径） */
export function complianceDrawtextFilter(c: ComplianceArg, height: number): string {
  const m = Math.max(0, Math.round(c.margin_px))
  const fs = Math.max(18, Math.round(Math.max(1, height) * 0.03))
  const row = c.position.charAt(0)
  const col = c.position.charAt(1)
  const x = col === 'l' ? `${m}` : col === 'c' ? '(w-text_w)/2' : `w-text_w-${m}`
  const y = row === 't' ? `${m}` : row === 'm' ? '(h-text_h)/2' : `h-text_h-${m}`
  return `drawtext=fontfile='${escapeFilterPath(c.fontAbs)}':text='${escapeDrawtext(c.text)}':x=${x}:y=${y}:fontsize=${fs}:fontcolor=white:box=1:boxcolor=black@0.35:boxborderw=${Math.round(fs / 4)}`
}
