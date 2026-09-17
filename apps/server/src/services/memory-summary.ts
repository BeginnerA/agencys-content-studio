import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { memories } from '../db/schema'
import { chatCompleteDetailed, loadPromptTemplate, type LlmUsage } from './llm'
import { recordLlmUsage } from './usage'
import { upsertMemory } from './memory'
import { createLogger } from '../logger'

// [M24·F1] 三层记忆 / 摘要压缩：项目/剧/集（+自定义）级摘要，LLM 增量合并压缩沉淀。
// 承载 = memories 表开放字段（type='summary' + 具名 upsert 幂等，零新表零新列，spec §2.2）：
//   summary:project / summary:series:{id} / summary:episode:{id} / summary:custom:{name}
// 纯函数面（summaryName/buildMergeInput/guardSummaryLen）探针直测；
// summarizeToMemory = action 与自动钩子共用的 LLM 编排核心（真实调用走 e2e 实弹）。

const log = createLogger('memory-summary')

/** 摘要级（spec §2.2 四型；纲领「项目/剧/章」的「章」= 剧的章节单元 episode；小说卷章用 custom） */
export type SummaryLevel = 'project' | 'series' | 'episode' | 'custom'

export const SUMMARY_LEVELS: readonly SummaryLevel[] = ['project', 'series', 'episode', 'custom']

/** 摘要缺省长度预算（字符；LLM 目标 ≤ max_chars，护栏 1.5× 判不遵守） */
export const SUMMARY_DEFAULT_MAX_CHARS = 600

/** 参数错误（level/id 组合非法；action 转 StepError，钩子侧仅日志跳过） */
export class SummaryParamError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'SummaryParamError'
  }
}

/** name 约定（四型）：level 必需 id 缺失 / custom 缺 name → SummaryParamError */
export function summaryName(
  level: SummaryLevel,
  opts: { seriesId?: number | null; episodeId?: number | null; name?: string | null },
): string {
  if (level === 'project') return 'summary:project'
  if (level === 'series') {
    if (typeof opts.seriesId !== 'number' || !Number.isInteger(opts.seriesId) || opts.seriesId <= 0)
      throw new SummaryParamError('level=series 需有效 series_id（params → run input 取值链均缺失）')
    return `summary:series:${opts.seriesId}`
  }
  if (level === 'episode') {
    if (typeof opts.episodeId !== 'number' || !Number.isInteger(opts.episodeId) || opts.episodeId <= 0)
      throw new SummaryParamError('level=episode 需有效 episode_id（params → run input 取值链均缺失）')
    return `summary:episode:${opts.episodeId}`
  }
  const name = typeof opts.name === 'string' ? opts.name.trim() : ''
  if (!name) throw new SummaryParamError('level=custom 需 params.name（自定义摘要名，如 卷一/chapter-3）')
  if (name.includes('\u0000')) throw new SummaryParamError('params.name 含非法字符')
  return `summary:custom:${name}`
}

/** 合并输入构造：merge 且既有摘要非空 → 「既有摘要 + 新素材」（增量压缩）；否则仅新素材 */
export function buildMergeInput(existing: string | null, fresh: string, merge: boolean): string {
  const old = (existing ?? '').trim()
  const src = fresh.trim()
  if (!merge || !old) return src
  return `【既有摘要】\n${old}\n\n【新素材】\n${src}`
}

/** 输出护栏：非空 + 超 max_chars×1.5 → 抛错（模型不遵守预算，明示修正而非静默截断） */
export function guardSummaryLen(out: string, maxChars: number): string {
  const s = out.trim()
  if (!s) throw new Error('摘要输出为空（模型未产出内容）')
  if (s.length > Math.floor(maxChars * 1.5))
    throw new Error(`摘要超出预算（${s.length} > ${maxChars}×1.5；模型未遵守长度约束，可提高 max_chars 或更换模型）`)
  return s
}

/** 读现有同名摘要内容（无 → null） */
export async function getSummaryContent(projectId: number, name: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(memories)
    .where(and(eq(memories.projectId, projectId), eq(memories.name, name)))
    .limit(1)
  return rows[0]?.content ?? null
}

export interface SummarizeParams {
  projectId: number
  level: SummaryLevel
  seriesId?: number | null
  episodeId?: number | null
  customName?: string | null
  /** 新素材全文（action/钩子侧已完成资产拼接） */
  sourceText: string
  maxChars?: number
  merge?: boolean
  /** 提示词文件（缺省 memory-summary.md） */
  promptTpl?: string
  /** 用量留痕上下文 */
  runId?: number | null
  stepId?: number | null
}

export interface SummarizeResult {
  memoryId: number
  created: boolean
  name: string
  /** 摘要字符数 */
  chars: number
  /** 合并前既有摘要字符数（0 = 新建/未合并） */
  mergedFromChars: number
  /** 素材输入字符数（压缩比参考） */
  sourceChars: number
  usage: LlmUsage | null
  provider: string
  model: string
}

/**
 * 摘要核心（action 与自动钩子共用）：同名既有摘要 + 新素材 → memory-summary.md 增量合并压缩
 * → upsertMemory(type='summary') → 结果。LLM 不可用 → 原样抛出（显式链 StepError；钩子侧隔离捕获）。
 */
export async function summarizeToMemory(p: SummarizeParams): Promise<SummarizeResult> {
  const maxChars = typeof p.maxChars === 'number' && p.maxChars > 0 ? Math.floor(p.maxChars) : SUMMARY_DEFAULT_MAX_CHARS
  const merge = p.merge !== false
  const tplFile = p.promptTpl ?? 'memory-summary.md'
  const name = summaryName(p.level, { seriesId: p.seriesId, episodeId: p.episodeId, name: p.customName })
  const source = p.sourceText.trim()
  if (!source) throw new SummaryParamError('摘要素材为空')

  const existing = merge ? await getSummaryContent(p.projectId, name) : null
  const mergedInput = buildMergeInput(existing, source, merge)
  const res = await chatCompleteDetailed(
    [
      { role: 'system', content: loadPromptTemplate(tplFile) },
      {
        role: 'user',
        content: `目标长度不超过 ${maxChars} 字。请基于以下内容输出/更新摘要（直接输出摘要正文，不要任何前后缀说明）：\n\n${mergedInput}`,
      },
    ],
    undefined,
    { maxTokens: Math.max(1024, maxChars * 4) },
  )
  const summary = guardSummaryLen(res.content, maxChars)
  const { id, created } = await upsertMemory({
    projectId: p.projectId,
    type: 'summary',
    name,
    content: summary,
    meta: { runId: p.runId ?? null, stepId: p.stepId ?? null, source: 'memory_summary', level: p.level },
  })
  await recordLlmUsage({ projectId: p.projectId, runId: p.runId ?? null, stepId: p.stepId ?? null, provider: res.provider, model: res.model, usage: res.usage })
  log.info(`摘要#${id} ${created ? '新建' : '更新'}（${name}，${mergedInput.length} → ${summary.length} 字）`, {})
  return {
    memoryId: id,
    created,
    name,
    chars: summary.length,
    mergedFromChars: (existing ?? '').trim().length,
    sourceChars: source.length,
    usage: res.usage,
    provider: res.provider,
    model: res.model,
  }
}
