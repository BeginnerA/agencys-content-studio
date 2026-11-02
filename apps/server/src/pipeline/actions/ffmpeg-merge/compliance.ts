/**
 * 合规角标纯函数：drawtext 滤镜构造 + ResolvedCompliance → ComposeArgsInput.compliance 解析。
 * 红线：resolveComplianceArg 返回 null（关闭/无字体）时 args 逐字节不变；字体缺失降级为跳过角标（warn 由调用方记）。
 */
import { escapeDrawtext, escapeFilterPath, resolveCjkFont } from './title-card'
import { round3 } from './util'
import { aigcMetadata } from '../../../services/compliance-label'
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

/** 合成产物溯源 params.compliance（只增键；enabled = 角标实际产出（无字体降级 false）；produce_id 与内嵌元数据同源） */
export interface MergeComplianceMeta {
  enabled: boolean
  text: string | null
  position: WatermarkPosition | null
  producer: string | null
  produce_id: string
}

/** 品牌溯源组（index.ts params 薄委托；无配置 → null；duration = 含片头尾总长；produce_id 与内嵌元数据同源） */
export interface MergeBrandProvenance {
  watermark: { position: WatermarkPosition; opacity: number; width_pct: number; source: string } | null
  intro: { source: string; duration: number } | null
  outro: { source: string; duration: number } | null
  sfx: { count: number; volume: number } | null
  compliance: MergeComplianceMeta
}

/** 成片合成接线（index.ts 薄委托；≤800 行红线拆出，行为零变更）：
 *  隐式元数据恒产（不可关）；显式角标默认开、enabled:false 逐级关闭；无 CJK 字体 → 角标降级跳过并提示（隐式不受影响） */
export function resolveMergeCompliance(
  brand: { compliance?: ResolvedCompliance | null },
  log: (msg: string) => void,
): { aigc: ReturnType<typeof aigcMetadata>; complianceArg: ComplianceArg | null; compose: { compliance: ComplianceArg | null; metadataJson: string } } {
  const aigc = aigcMetadata({ producer: brand.compliance?.producer ?? '个人创作者' })
  const complianceArg = resolveComplianceArg(brand.compliance ?? undefined)
  if (brand.compliance?.enabled && !complianceArg) log('合规角标跳过：未找到 CJK 字体（隐式元数据不受影响）')
  return { aigc, complianceArg, compose: { compliance: complianceArg, metadataJson: aigc.json } }
}

/** 品牌溯源组构造（index.ts params 薄委托；≤800 行红线拆出，行为零变更；键序即 params JSON 键序） */
export function mergeBrandProvenance(
  brand: { intro?: { source: string }; outro?: { source: string }; compliance?: { text?: string; position?: WatermarkPosition; producer?: string } | null },
  m: {
    watermark: { position: WatermarkPosition; opacity: number; width_pct: number; source: string } | null
    intro: { durSec: number } | null
    outro: { durSec: number } | null
    sfxCount: number
    sfxVolume: number
  },
  complianceArg: ComplianceArg | null,
  produceId: string,
): MergeBrandProvenance {
  return {
    watermark: m.watermark
      ? { position: m.watermark.position, opacity: m.watermark.opacity, width_pct: m.watermark.width_pct, source: m.watermark.source }
      : null,
    intro: m.intro ? { source: brand.intro!.source, duration: round3(m.intro.durSec) } : null,
    outro: m.outro ? { source: brand.outro!.source, duration: round3(m.outro.durSec) } : null,
    sfx: m.sfxCount > 0 ? { count: m.sfxCount, volume: m.sfxVolume } : null,
    compliance: { enabled: !!complianceArg, text: brand.compliance?.text ?? null, position: brand.compliance?.position ?? null, producer: brand.compliance?.producer ?? null, produce_id: produceId },
  }
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
