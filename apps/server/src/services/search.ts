import { readFileSync } from 'node:fs'
import { and, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { db } from '../db'
import { assets, batches, canvases, characters, episodes, pipelineRuns, projects, publications, schedules } from '../db/schema'
import { createLogger } from '../logger'
import { cosine, embed, embeddingStatus, ensureEmbedder, resolveModelName } from './embedding'
import { recallMemories } from './memory'
import { absPathOf } from './storage'

/**
 * [M21] 全局搜索服务——关键词九域（SQL LIKE）+ 语义限文本域（记忆 / 文本资产）。
 * 语义模型不可用 → 自动降级（关键词照常，available:false 不抛错）；
 * 首搜检出未索引文本资产 → 后台全量增量索引（模块级单 inflight 防重）。
 */

const log = createLogger('search')

/** 语义索引接入文本资产的截断长度（字符） */
const TEXT_INDEX_MAX = 1500
/** 语义命中最低余弦分（对齐 memories 召回先例） */
const SEMANTIC_MIN_SCORE = 0.25

export interface SearchItem { id: number; title: string; subtitle: string | null; url: string }
export interface SearchGroup { domain: string; label: string; items: SearchItem[] }
export interface SemanticHit { entity: 'memory' | 'asset'; id: number; title: string; snippet: string; score: number; url: string }
export interface SearchResult {
  q: string
  groups: SearchGroup[]
  semantic: { available: boolean; degraded: boolean; indexing: boolean; hits: SemanticHit[] }
}

/** LIKE 模式构造：`%` `_` `\` 转义（配 ESCAPE '\'；关键词走参数绑定，无注入面） */
function likePat(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

/** 单列 LIKE 条件（显式 ESCAPE '\'，保证转义生效） */
function likeCond(col: SQLiteColumn, pat: string): SQL {
  return sql`${col} LIKE ${pat} ESCAPE '\\'`
}

/** 跨域关键词搜索（9 域并行查询；空组不出现） */
export async function searchKeywordGroups(q: string, limit: number): Promise<SearchGroup[]> {
  const pat = likePat(q)
  const isNum = /^\d{1,15}$/.test(q)
  const num = isNum ? Number(q) : 0

  const [projRows, runRows, assetRows, charRows, canvasRows, pubRows, epRows, batchRows, schedRows] = await Promise.all([
    db
      .select({ id: projects.id, name: projects.name, brief: projects.brief })
      .from(projects)
      .where(and(isNull(projects.deletedAt), or(likeCond(projects.name, pat), likeCond(projects.brief, pat), likeCond(projects.tags, pat))))
      .limit(limit),
    (isNum
      ? db.select({ id: pipelineRuns.id, status: pipelineRuns.status, projectId: pipelineRuns.projectId }).from(pipelineRuns).where(eq(pipelineRuns.id, num))
      : db
          .select({ id: pipelineRuns.id, status: pipelineRuns.status, projectId: pipelineRuns.projectId })
          .from(pipelineRuns)
          .where(likeCond(pipelineRuns.input, pat))
          .orderBy(desc(pipelineRuns.id))
    ).limit(limit),
    db
      .select({ id: assets.id, name: assets.name, kind: assets.kind, projectId: assets.projectId })
      .from(assets)
      .where(and(isNull(assets.deletedAt), or(likeCond(assets.name, pat), likeCond(assets.tags, pat))))
      .orderBy(desc(assets.id))
      .limit(limit),
    db
      .select({ id: characters.id, name: characters.name, kind: characters.kind, summary: characters.summary })
      .from(characters)
      .where(or(likeCond(characters.name, pat), likeCond(characters.aliases, pat), likeCond(characters.summary, pat)))
      .limit(limit),
    db
      .select({ id: canvases.id, name: canvases.name, projectId: canvases.projectId })
      .from(canvases)
      .where(and(isNull(canvases.deletedAt), likeCond(canvases.name, pat)))
      .limit(limit),
    db
      .select({ id: publications.id, title: publications.title, url: publications.url, note: publications.note, projectId: publications.projectId })
      .from(publications)
      .where(or(likeCond(publications.title, pat), likeCond(publications.url, pat), likeCond(publications.note, pat)))
      .orderBy(desc(publications.id))
      .limit(limit),
    (isNum
      ? db.select({ id: episodes.id, number: episodes.number, title: episodes.title, projectId: episodes.projectId }).from(episodes).where(eq(episodes.number, num))
      : db
          .select({ id: episodes.id, number: episodes.number, title: episodes.title, projectId: episodes.projectId })
          .from(episodes)
          .where(likeCond(episodes.title, pat))
    ).limit(limit),
    (isNum
      ? db.select({ id: batches.id, name: batches.name, status: batches.status, projectId: batches.projectId, total: batches.total, finished: batches.finished }).from(batches).where(eq(batches.id, num))
      : db
          .select({ id: batches.id, name: batches.name, status: batches.status, projectId: batches.projectId, total: batches.total, finished: batches.finished })
          .from(batches)
          .where(likeCond(batches.name, pat))
          .orderBy(desc(batches.id))
    ).limit(limit),
    db
      .select({ id: schedules.id, name: schedules.name, status: schedules.status, projectId: schedules.projectId })
      .from(schedules)
      .where(likeCond(schedules.name, pat))
      .orderBy(desc(schedules.scheduledAt))
      .limit(limit),
  ])

  const groups: SearchGroup[] = []
  const push = (domain: string, label: string, items: SearchItem[]): void => {
    if (items.length) groups.push({ domain, label, items })
  }
  push('projects', '项目', projRows.map((r) => ({ id: r.id, title: r.name, subtitle: r.brief ? clip(r.brief, 60) : null, url: `/projects/${r.id}` })))
  push('runs', '运行', runRows.map((r) => ({ id: r.id, title: `运行 #${r.id}`, subtitle: `项目 #${r.projectId} · ${r.status}`, url: `/runs/${r.id}` })))
  push('assets', '资产', assetRows.map((r) => ({ id: r.id, title: r.name, subtitle: `${r.kind} · 项目 #${r.projectId}`, url: `/projects/${r.projectId}?tab=assets` })))
  push('entities', '实体', charRows.map((r) => ({ id: r.id, title: r.name, subtitle: r.summary ? clip(r.summary, 60) : r.kind, url: '/entities' })))
  push('canvases', '画布', canvasRows.map((r) => ({ id: r.id, title: r.name, subtitle: `项目 #${r.projectId}`, url: `/creation?project=${r.projectId}&canvas=${r.id}` })))
  push('publications', '发布', pubRows.map((r) => ({ id: r.id, title: r.title ?? `发布 #${r.id}`, subtitle: r.url ?? `项目 #${r.projectId}`, url: `/projects/${r.projectId}?tab=pubs` })))
  push('episodes', '剧集', epRows.map((r) => ({ id: r.id, title: r.title ?? `第 ${r.number} 集`, subtitle: `项目 #${r.projectId} · 第 ${r.number} 集`, url: `/projects/${r.projectId}` })))
  push('batches', '批次', batchRows.map((r) => ({ id: r.id, title: r.name, subtitle: `项目 #${r.projectId} · ${r.status} · ${r.finished}/${r.total}`, url: `/batches/${r.id}` })))
  push('schedules', '排产', schedRows.map((r) => ({ id: r.id, title: r.name, subtitle: `项目 #${r.projectId} · ${r.status}`, url: '/stats?tab=schedule' })))
  return groups
}

/** 混合搜索入口：关键词（必得）+ 语义（可降级）并行 */
export async function searchAll(q: string, limit = 5): Promise<SearchResult> {
  const [groups, semantic] = await Promise.all([searchKeywordGroups(q, limit), semanticSearch(q)])
  return { q, groups, semantic }
}

/** 语义搜索（记忆 + 文本资产）；模型不可用/运行期错误 → 全降级（不抛错） */
async function semanticSearch(q: string): Promise<SearchResult['semantic']> {
  try {
    await ensureEmbedder()
  } catch (err) {
    log.warn(`语义搜索降级（模型不可用）：${(err as Error).message}`)
    return { available: false, degraded: true, indexing: false, hits: [] }
  }
  try {
    const modelName = await resolveModelName()
    const qv = await embed(q)
    const tag = `${modelName}@${qv.length}`
    const hits: SemanticHit[] = []
    // 记忆召回（复用 M3 实现：cosine + minScore 0.25 + limit 5）
    const mem = await recallMemories({ projectId: null, query: q, limit: 5 })
    for (const m of mem) {
      hits.push({ entity: 'memory', id: m.id, title: m.name ?? '记忆', snippet: clip(m.content, 80), score: m.score, url: '/memories' })
    }
    // 文本资产（仅当前模型 tag 一致的行参与；异模型/未索引行由后台增量补齐）
    const rows = await db
      .select({ id: assets.id, projectId: assets.projectId, name: assets.name, embedding: assets.embedding })
      .from(assets)
      .where(and(eq(assets.kind, 'text'), isNull(assets.deletedAt), eq(assets.embeddingModel, tag)))
    for (const r of rows) {
      if (!r.embedding) continue
      let vec: number[]
      try {
        vec = JSON.parse(r.embedding) as number[]
      } catch {
        continue
      }
      const score = cosine(qv, vec)
      if (score >= SEMANTIC_MIN_SCORE) {
        hits.push({ entity: 'asset', id: r.id, title: r.name, snippet: '', score, url: `/projects/${r.projectId}?tab=assets` })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    const indexing = await maybeTriggerTextIndex(tag)
    return { available: true, degraded: false, indexing, hits: hits.slice(0, 5) }
  } catch (err) {
    log.warn(`语义搜索降级（运行期错误）：${(err as Error).message}`)
    return { available: false, degraded: true, indexing: false, hits: [] }
  }
}

/** 首搜自动索引：存在未索引/异模型文本资产 → 后台触发；返回是否仍有待索引行 */
let textIndexInflight = false
async function maybeTriggerTextIndex(currentTag: string): Promise<boolean> {
  const pending = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.kind, 'text'), isNull(assets.deletedAt), or(isNull(assets.embeddingModel), ne(assets.embeddingModel, currentTag))))
    .limit(1)
  if (!pending.length) return false
  if (!textIndexInflight) {
    textIndexInflight = true
    void reindexAssetTexts()
      .catch((err) => log.warn(`后台文本索引失败：${(err as Error).message}`))
      .finally(() => {
        textIndexInflight = false
      })
  }
  return true
}

/** 文本资产向量全量重建（已有最新 tag 的行跳过 → 二次调用幂等；模型不可用 → 抛错） */
export async function reindexAssetTexts(): Promise<{ total: number; indexed: number; skipped: number; failed: number }> {
  await ensureEmbedder() // 模型不可用 → 直接抛错（调用方转 503 + model:prepare 指引）
  const st = await embeddingStatus()
  const currentTag = st.dims !== null ? `${st.modelName}@${st.dims}` : null
  const rows = await db.select().from(assets).where(and(eq(assets.kind, 'text'), isNull(assets.deletedAt)))
  let indexed = 0
  let skipped = 0
  let failed = 0
  for (const r of rows) {
    if (currentTag && r.embedding && r.embeddingModel === currentTag) {
      skipped += 1
      continue
    }
    try {
      const text = readAssetText(r)
      if (!text.trim()) {
        skipped += 1
        continue
      }
      const vec = await embed(text)
      await db
        .update(assets)
        .set({ embedding: JSON.stringify(vec), embeddingModel: `${st.modelName}@${vec.length}` })
        .where(eq(assets.id, r.id))
      indexed += 1
    } catch (err) {
      failed += 1
      log.warn(`文本资产索引跳过 #${r.id}：${(err as Error).message}`)
    }
  }
  return { total: rows.length, indexed, skipped, failed }
}

/** 读取文本资产内容（relPath 缺失/读失败 → 空串；截断 1500 字符控成本） */
function readAssetText(a: typeof assets.$inferSelect): string {
  if (!a.relPath) return ''
  try {
    return readFileSync(absPathOf(a.relPath), 'utf8').slice(0, TEXT_INDEX_MAX)
  } catch {
    return ''
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
