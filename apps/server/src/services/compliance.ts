import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { COMPLIANCE_DIR } from '../env'
import { db } from '../db'
import { assets, type Asset } from '../db/schema'
import { createLogger } from '../logger'

// [M24·F5] 合规审核服务：本地词库（workspace/compliance/words.txt，零外部服务）+ LLM 复审解析
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

/** 现读词库文件（每次 action 现读，编辑即用；缺失 → source='missing' 不抛） */
export function loadRules(dir: string = COMPLIANCE_DIR): { rules: ComplianceRule[]; source: 'file' | 'missing'; path: string } {
  const file = join(dir, 'words.txt')
  if (!existsSync(file)) return { rules: [], source: 'missing', path: file }
  try {
    return { rules: parseRules(readFileSync(file, 'utf8')), source: 'file', path: file }
  } catch (err) {
    log.warn(`词库读取失败（${(err as Error).message}）→ 空规则`, {})
    return { rules: [], source: 'missing', path: file }
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

/** 词库只读视图（GET /compliance/rules）：文件缺失 → total 0 + source missing（不 500） */
export function rulesView(): { total: number; byCategory: Record<string, number>; source: 'file' | 'missing' } {
  const { rules, source } = loadRules()
  const byCategory: Record<string, number> = {}
  for (const r of rules) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1
  return { total: rules.length, byCategory, source }
}
