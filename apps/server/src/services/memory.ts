import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '../db'
import { memories } from '../db/schema'
import { cosine, embed, ensureEmbedder, resolveModelName } from './embedding'
import { createLogger } from '../logger'

/**
 * 记忆服务：写入（具名 upsert）/ 向量召回 / 全量重建索引。
 * embedding 不可用时写入与检索直接抛错（不静默）——错误消息含 model:prepare 指引（来自 embedding 服务）。
 */

const log = createLogger('memory')

/** 写入记忆：有 name → 同域同名 upsert（保 id）；无 name → 匿名追加 */
export async function upsertMemory(p: {
  projectId: number | null
  type: string
  name?: string | null
  content: string
  meta?: Record<string, unknown>
}): Promise<{ id: number; created: boolean }> {
  const now = Date.now()
  const vec = await embed(p.content) // 模型不可用 → 抛错（不静默）
  const tag = `${await resolveModelName()}@${vec.length}`
  const embedding = JSON.stringify(vec)
  const meta = JSON.stringify(p.meta ?? {})

  if (p.name) {
    const scopeCond = p.projectId === null ? isNull(memories.projectId) : eq(memories.projectId, p.projectId)
    const rows = await db
      .select()
      .from(memories)
      .where(and(eq(memories.name, p.name), scopeCond))
      .limit(1)
    if (rows[0]) {
      await db
        .update(memories)
        .set({ content: p.content, embedding, embeddingModel: tag, meta, updatedAt: now })
        .where(eq(memories.id, rows[0].id))
      return { id: rows[0].id, created: false }
    }
  }
  const inserted = (
    await db
      .insert(memories)
      .values({
        projectId: p.projectId,
        type: p.type,
        name: p.name ?? null,
        content: p.content,
        embedding,
        embeddingModel: tag,
        meta,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
  )[0]!
  return { id: inserted.id, created: true }
}

/** 向量召回：scope 过滤 → types 行内过滤（ 如 ['summary'] 只召摘要；零 SQL 变更）→ 异模型行跳过 → cosine 排序 → limit/minScore 截断 */
export async function recallMemories(p: {
  projectId: number | null
  query: string
  limit?: number
  minScore?: number
  scope?: 'project' | 'global' | 'both'
  types?: string[]
}): Promise<Array<{ id: number; type: string; name: string | null; content: string; updatedAt: number; score: number }>> {
  const limit = p.limit ?? 3
  const minScore = p.minScore ?? 0.25
  const scope = p.scope ?? 'both'
  const qv = await embed(p.query)
  const tag = `${await resolveModelName()}@${qv.length}`

  const scopeCond =
    scope === 'project'
      ? eq(memories.projectId, p.projectId!)
      : scope === 'global'
        ? isNull(memories.projectId)
        : p.projectId === null
          ? undefined // 全库（不做项目过滤）
          : or(eq(memories.projectId, p.projectId), isNull(memories.projectId))
  const rows = await db.select().from(memories).where(scopeCond)

  const scored: Array<{ id: number; type: string; name: string | null; content: string; updatedAt: number; score: number }> = []
  let foreign = 0
  for (const r of rows) {
    if (!r.embedding) continue
    if (p.types && p.types.length > 0 && !p.types.includes(r.type)) continue
    if (r.embeddingModel !== tag) {
      foreign += 1
      continue
    }
    let vec: number[]
    try {
      vec = JSON.parse(r.embedding) as number[]
    } catch {
      continue
    }
    const score = cosine(qv, vec)
    if (score >= minScore) scored.push({ id: r.id, type: r.type, name: r.name, content: r.content, updatedAt: r.updatedAt, score })
  }
  if (foreign > 0) log.warn(`召回跳过 ${foreign} 条异模型/无模型记忆（当前 ${tag}）`)
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** 全量重建索引（逐行重算；模型不可用 → 抛错；单行失败计数跳过） */
export async function reindexMemories(): Promise<{ total: number; rebuilt: number; skipped: number }> {
  await ensureEmbedder() // 模型不可用 → 直接抛错（不静默）
  const modelName = await resolveModelName()
  const rows = await db.select().from(memories)
  let rebuilt = 0
  let skipped = 0
  for (const r of rows) {
    try {
      const vec = await embed(r.content)
      await db
        .update(memories)
        .set({ embedding: JSON.stringify(vec), embeddingModel: `${modelName}@${vec.length}` })
        .where(eq(memories.id, r.id))
      rebuilt += 1
    } catch (e) {
      skipped += 1
      log.warn(`reindex 跳过 #${r.id}：${(e as Error).message}`)
    }
  }
  return { total: rows.length, rebuilt, skipped }
}
