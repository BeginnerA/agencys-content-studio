import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, isNull, like } from 'drizzle-orm'
import { COMPLIANCE_DIR } from '../env'
import { db } from '../db'
import { assets } from '../db/schema'
import { createLogger } from '../logger'
import { loadRules, normalizeText, parseRules, type ComplianceRule } from './compliance'

// 合规词库补充建议（Tier B，零新 LLM 计费）：从**既有已付费的** compliance_check 结论
// （assets.params.compliance.llm.items）聚合候选新词，一键追加进 words.txt。不新增任何 LLM 调用，
// 不猜测——建议一律 warn 起步（是否升 block 属法务判断，保留人工，charter §六）。
// 「仅建议不执行」：suggestRules 只读聚合；appendRules 仅在用户点击采纳时写入。

const log = createLogger('compliance-suggest')

export interface SuggestedRule {
  category: string
  word: string
  level: 'block' | 'warn'
  evidence: string
  times: number
}

/** 候选词清洗：去首尾空白、压合内部空白、剥离会破坏 `类别|词|级别` 格式的字符（| 与换行）、截断 ≤20 字符 */
function cleanWord(raw: string): string {
  const s = raw.replace(/\|/g, ' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > 20 ? s.slice(0, 20) : s
}

/**
 * 聚合项目域（projectId=null → 全域）资产的 params.compliance.llm.items 为候选新规则。
 * 去重：(category, 归一词) 聚合计数；剔除当前词库已有词（不重复建议）；level 一律 warn（升 block 交人工）。
 */
export async function suggestRules(projectId: number | null): Promise<SuggestedRule[]> {
  const conds = [isNull(assets.deletedAt), like(assets.params, '%compliance%')]
  if (projectId !== null) conds.push(eq(assets.projectId, projectId))
  const rows = await db
    .select({ params: assets.params })
    .from(assets)
    .where(and(...conds))
    .limit(1000)

  const existing = new Set(loadRules().rules.map((r) => normalizeText(r.word)))
  const agg = new Map<string, SuggestedRule>()

  for (const row of rows) {
    if (!row.params) continue
    let compliance: unknown
    try {
      compliance = (JSON.parse(row.params) as Record<string, unknown>)['compliance']
    } catch {
      continue
    }
    const llm = (compliance as { llm?: unknown } | undefined)?.llm as { items?: unknown } | undefined
    if (!llm || !Array.isArray(llm.items)) continue
    for (const it of llm.items) {
      if (!it || typeof it !== 'object') continue
      const i = it as Record<string, unknown>
      const category = typeof i.category === 'string' && i.category.trim() ? i.category.trim() : '未分类'
      const word = cleanWord(typeof i.quote === 'string' ? i.quote : '')
      if (!word) continue
      const norm = normalizeText(word)
      if (existing.has(norm)) continue // 词库已有 → 不重复建议
      const key = `${category}\u0000${norm}`
      const prev = agg.get(key)
      if (prev) {
        prev.times += 1
      } else {
        agg.set(key, {
          category,
          word,
          level: 'warn',
          evidence: typeof i.reason === 'string' ? i.reason : '',
          times: 1,
        })
      }
    }
  }

  return [...agg.values()]
    .sort((a, b) => (a.times === b.times ? a.word.localeCompare(b.word, 'zh') : b.times - a.times))
    .slice(0, 50)
}

/** 读真实词库文件规则（不经 loadRules 的 builtin 兜底）：仅用于写入去重与计数；文件不存在 → [] */
function loadFileRules(file: string): ComplianceRule[] {
  if (!existsSync(file)) return []
  try {
    return parseRules(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

/** 词库文件头部注释（新建文件时写入；声明为标记/拦截语义地板，非法务意见） */
const WORDS_HEADER = [
  '# 合规审核本地词库（行格式：类别|词|级别；# 注释；编辑保存即生效）',
  '# 由「词库补充建议」自动追加，请按业务自行复核级别（block/warn）与增删。',
].join('\n')

/**
 * 追加规则进 words.txt：自动建目录/文件；`类别|词|级别` 格式；(category,word) 去重（保留首见，含文件既有 + 本批内）；
 * 单条缺词或词含破坏格式字符 → 跳过（坏行容错，对齐 parseRules 宽容）。追加不覆盖既有行。返回新增条数与追加后总条数。
 */
export async function appendRules(
  rules: Array<{ category: string; word: string; level: string }>,
): Promise<{ added: number; total: number }> {
  if (!Array.isArray(rules) || rules.length === 0) return { added: 0, total: 0 }
  if (!existsSync(COMPLIANCE_DIR)) mkdirSync(COMPLIANCE_DIR, { recursive: true })
  const file = join(COMPLIANCE_DIR, 'words.txt')
  const hadFile = existsSync(file)
  const current = hadFile ? readFileSync(file, 'utf8') : ''

  const seen = new Set<string>()
  for (const r of loadFileRules(file)) seen.add(`${r.category}\u0000${normalizeText(r.word)}`)

  const newLines: string[] = []
  for (const raw of rules) {
    const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim().replace(/\|/g, ' ') : '未分类'
    const word = cleanWord(typeof raw.word === 'string' ? raw.word : '')
    if (!word) continue
    const level = raw.level === 'block' ? 'block' : 'warn'
    const key = `${category}\u0000${normalizeText(word)}`
    if (seen.has(key)) continue
    seen.add(key)
    newLines.push(`${category}|${word}|${level}`)
  }

  if (newLines.length > 0) {
    const body = hadFile ? `${current.replace(/\s+$/, '')}\n${newLines.join('\n')}\n` : `${WORDS_HEADER}\n${newLines.join('\n')}\n`
    writeFileSync(file, body, 'utf8')
    log.info(`词库追加 ${newLines.length} 条建议规则（${hadFile ? '续写' : '新建文件'}）`)
  }
  return { added: newLines.length, total: loadFileRules(file).length }
}
