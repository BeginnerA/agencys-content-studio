import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { COMPLIANCE_DIR } from '../env'
import { db } from '../db'
import { assets, type Asset } from '../db/schema'
import { createLogger } from '../logger'

// 合规审核服务：本地词库（workspace/compliance/words.txt，零外部服务）+ LLM 复审解析
// + 产物标记写回（assets.params.compliance，对齐 image-check params.quality 零新列先例）。
// 纯函数面（parseRules/scanText/parseLlmVerdict/overallStatus/renderComplianceReport）探针直测；
// LLM 复审调用在 compliance_check action 编排（探针不真实调用）。
// 注意：内置词库为小型基准词表，误放/误杀均可能——产物 = 标记与拦截语义，非法务意见（spec §8）。

const log = createLogger('compliance')

/** 词库行格式：类别|词|级别（block|warn；缺省 warn）；# 注释；空行跳过 */
export interface ComplianceRule {
  category: string
  word: string
  level: 'block' | 'warn'
}

/**
 * 内置《广告法》极限词高频基准地板：仅在 words.txt 文件缺失/读取异常时兜底启用，
 * 修复「词库缺失 → 合规扫描静默空转、产物误导为 pass」这一真实降级隐患（违「不静默降级」）。
 * 用户词库文件在位时**绝不并入**（现网命中集逐字零变化，probe-m24 文件路径零回归）。
 * 这是标记/拦截语义的地板，非完整法务词库，不构成法务意见（沿用 spec §8 免责）。
 */
export const BASE_RULES: ComplianceRule[] = [
  { category: '广告', word: '最便宜', level: 'block' },
  { category: '广告', word: '最佳', level: 'block' },
  { category: '广告', word: '最好', level: 'block' },
  { category: '广告', word: '最优', level: 'block' },
  { category: '广告', word: '第一', level: 'block' },
  { category: '广告', word: '首选', level: 'block' },
  { category: '广告', word: '绝对', level: 'block' },
  { category: '广告', word: '极致', level: 'block' },
  { category: '广告', word: '顶尖', level: 'block' },
  { category: '广告', word: '顶级', level: 'block' },
  { category: '广告', word: '独家', level: 'block' },
  { category: '广告', word: '唯一', level: 'block' },
  { category: '广告', word: '万能', level: 'block' },
  { category: '广告', word: '100%', level: 'block' },
  { category: '广告', word: '百分百', level: 'block' },
  { category: '广告', word: '无副作用', level: 'block' },
  { category: '广告', word: '根治', level: 'block' },
  { category: '广告', word: '包治', level: 'block' },
  { category: '广告', word: '永不复发', level: 'block' },
  { category: '广告', word: '史无前例', level: 'block' },
  { category: '广告', word: '国家级', level: 'warn' },
  { category: '广告', word: '世界级', level: 'warn' },
  { category: '广告', word: '纯天然', level: 'warn' },
  { category: '广告', word: '行业领先', level: 'warn' },
  { category: '医疗', word: '无效退款', level: 'block' },
  { category: '医疗', word: '药到病除', level: 'block' },
  { category: '医疗', word: '立竿见影', level: 'warn' },
]

export interface ComplianceHit {
  word: string
  category: string
  level: 'block' | 'warn'
  count: number
}

/** 归一化：小写 + 全角转半角（防全角绕过）；连续空白压合不做（词库词本身不含空白的基准假设） */
export function normalizeText(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) {
    const code = ch.charCodeAt(0)
    if (code === 0x3000) out += ' '
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0)
    else out += ch
  }
  return out
}

/** 词库文本 → 规则（坏行跳过：缺词段/级别非法 → warn 兜底；词重复保留首见） */
export function parseRules(text: string): ComplianceRule[] {
  const rules: ComplianceRule[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split('|').map((p) => p.trim())
    const category = parts[0] || '未分类'
    const word = parts[1] ?? ''
    if (!word) continue
    const level = parts[2] === 'block' ? 'block' : 'warn'
    const key = `${category}\u0000${word.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    rules.push({ category, word, level })
  }
  return rules
}

/**
 * 现读词库文件（每次 action 现读，编辑即用）。
 * 文件在位 → source='file'（仅文件规则，逐字不变）；文件缺失/读失败 → 启用 BASE_RULES 兜底，source='builtin'（不再返空静默）。
 */
export function loadRules(dir: string = COMPLIANCE_DIR): { rules: ComplianceRule[]; source: 'file' | 'builtin'; path: string } {
  const file = join(dir, 'words.txt')
  if (!existsSync(file)) return { rules: BASE_RULES, source: 'builtin', path: file }
  try {
    return { rules: parseRules(readFileSync(file, 'utf8')), source: 'file', path: file }
  } catch (err) {
    log.warn(`词库读取失败（${(err as Error).message}）→ 启用内置基准地板`, {})
    return { rules: BASE_RULES, source: 'builtin', path: file }
  }
}

/** 文本扫描：归一化后 includes 命中计数；稳定序 = block 先、按 word 字典序（探针可确定性断言） */
export function scanText(text: string, rules: ComplianceRule[]): ComplianceHit[] {
  const hay = normalizeText(text)
  const hits: ComplianceHit[] = []
  for (const r of rules) {
    const needle = normalizeText(r.word)
    if (!needle) continue
    let count = 0
    let idx = hay.indexOf(needle)
    while (idx !== -1) {
      count += 1
      idx = hay.indexOf(needle, idx + needle.length)
    }
    if (count > 0) hits.push({ word: r.word, category: r.category, level: r.level, count })
  }
  hits.sort((a, b) => (a.level === b.level ? a.word.localeCompare(b.word, 'zh') : a.level === 'block' ? -1 : 1))
  return hits
}

/** LLM 复审契约（compliance-review.md）：{ verdict, items[] }；解析失败 → null（宽容降级不炸） */
export interface LlmVerdict {
  verdict: 'pass' | 'risk' | 'block'
  items: Array<{ category: string; quote: string; reason: string }>
}

/** 剥 ```json 围栏（对齐 advice 先例的宽容策略） */
export function stripCodeFence(text: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  return (m?.[1] ?? text).trim()
}

export function parseLlmVerdict(text: string): LlmVerdict | null {
  try {
    const raw = JSON.parse(stripCodeFence(text)) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    const verdict = o.verdict === 'pass' || o.verdict === 'risk' || o.verdict === 'block' ? o.verdict : null
    if (!verdict) return null
    const items: LlmVerdict['items'] = []
    if (Array.isArray(o.items)) {
      for (const it of o.items) {
        if (!it || typeof it !== 'object') continue
        const i = it as Record<string, unknown>
        if (typeof i.category !== 'string' || typeof i.reason !== 'string') continue
        items.push({ category: i.category, quote: typeof i.quote === 'string' ? i.quote : '', reason: i.reason })
      }
    }
    return { verdict, items }
  } catch {
    return null
  }
}

/** 综合状态：block 词库命中或 LLM block → block；warn 命中或 risk → warn；否则 pass（LLM null 不影响词库结论） */
export function overallStatus(hits: ComplianceHit[], verdict: LlmVerdict | null): 'pass' | 'warn' | 'block' {
  if (hits.some((h) => h.level === 'block') || verdict?.verdict === 'block') return 'block'
  if (hits.length > 0 || verdict?.verdict === 'risk') return 'warn'
  return 'pass'
}

export interface ComplianceMark {
  status: 'pass' | 'warn' | 'block'
  hits: ComplianceHit[]
  llm: LlmVerdict | null
  checkedAt: number
}

/** 审核结论 → markdown 报告正文（供 purpose=compliance_report 资产） */
export function renderComplianceReport(textChars: number, mark: ComplianceMark): string {
  const lines = [
    `# 合规审核报告`,
    ``,
    `- 结论：**${mark.status.toUpperCase()}**`,
    `- 审核文本：${textChars} 字符 · ${new Date(mark.checkedAt).toISOString()}`,
    `- 词库命中：${mark.hits.length === 0 ? '无' : ''}`,
  ]
  if (mark.hits.length > 0) {
    lines.push(``, `| 词 | 类别 | 级别 | 次数 |`, `|---|---|---|---|`)
    for (const h of mark.hits) lines.push(`| ${h.word} | ${h.category} | ${h.level} | ${h.count} |`)
  }
  if (mark.llm) {
    lines.push(``, `## LLM 复审：${mark.llm.verdict}`)
    for (const it of mark.llm.items) lines.push(`- [${it.category}] ${it.quote ? `「${it.quote}」` : ''}${it.reason}`)
  } else {
    lines.push(``, `## LLM 复审：未执行（通道不可用或已关闭，宽容降级）`)
  }
  lines.push(``, `> 本地词库为小型基准词表，结论为标记/拦截语义，非法务意见。`)
  return `${lines.join('\n')}\n`
}

/** 标记写回被检资产 params.compliance（merge 保留既有键；对齐 recordQuality 零新列）；资产不存在 → null */
export async function recordCompliance(assetId: number, mark: ComplianceMark): Promise<Asset | null> {
  const rows = await db.select().from(assets).where(and(eq(assets.id, assetId), isNull(assets.deletedAt))).limit(1)
  const a = rows[0]
  if (!a) return null
  let params: Record<string, unknown> = {}
  if (a.params) {
    try {
      const parsed = JSON.parse(a.params) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed as Record<string, unknown>
    } catch {
      params = {}
    }
  }
  params['compliance'] = mark
  const updated = await db
    .update(assets)
    .set({ params: JSON.stringify(params), updatedAt: Date.now() })
    .where(eq(assets.id, a.id))
    .returning()
  return updated[0] ?? null
}

/** 词库只读视图（GET /compliance/rules）：文件在位 source='file'；缺失 → source='builtin'（内置地板兜底，不 500、不返空） */
export function rulesView(): { total: number; byCategory: Record<string, number>; source: 'file' | 'builtin' } {
  const { rules, source } = loadRules()
  const byCategory: Record<string, number> = {}
  for (const r of rules) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1
  return { total: rules.length, byCategory, source }
}
