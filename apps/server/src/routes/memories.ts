import { Hono, type Context } from 'hono'
import { and, count, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db'
import { memories } from '../db/schema'
import { embed, embeddingStatus, resolveModelName } from '../services/embedding'
import { recallMemories, reindexMemories, upsertMemory } from '../services/memory'
import { HttpError, h, idParam, notFound } from './helpers'

export const memoriesRoutes = new Hono()

// GET /memories —— 记忆列表（?project_id=&scope=&type=&q=&limit=；q 给定时按相似度排序并返回 score）
memoriesRoutes.get('/memories', h(async (c) => {
  const scope = c.req.query('scope') ?? 'both'
  if (scope !== 'project' && scope !== 'global' && scope !== 'both') throw new HttpError(400, 'bad_scope', `scope 非法: ${scope}`)
  const projectId = intQuery(c, 'project_id')
  if (scope === 'project' && projectId === undefined) throw new HttpError(400, 'bad_project_id', 'scope=project 时 project_id 必填')
  const type = c.req.query('type')
  const q = c.req.query('q')
  const limit = intQuery(c, 'limit') ?? 50

  if (q) {
    // 相似度模式：type 过滤在召回后进行（先多取 4 倍，筛选后仍尽量接近 limit；上限 200）
    const hits = await recallMemories({
      projectId: scope === 'global' ? null : projectId ?? null,
      query: q,
      limit: type ? Math.min(limit * 4, 200) : limit,
      scope,
    })
    if (hits.length === 0) return c.json({ items: [] })
    const rows = await db.select().from(memories).where(inArray(memories.id, hits.map((x) => x.id)))
    const byId = new Map(rows.map((r) => [r.id, r]))
    const items = hits
      .map((x) => {
        const r = byId.get(x.id)
        return r && (!type || r.type === type) ? toMemoryView(r, x.score) : null
      })
      .filter((x): x is Record<string, unknown> => x !== null)
      .slice(0, limit)
    return c.json({ items })
  }

  const conds = []
  if (scope === 'project') conds.push(eq(memories.projectId, projectId!))
  else if (scope === 'global') conds.push(isNull(memories.projectId))
  else if (projectId !== undefined) conds.push(or(eq(memories.projectId, projectId), isNull(memories.projectId)))
  if (type) conds.push(eq(memories.type, type))
  const rows = await db.select().from(memories).where(and(...conds)).orderBy(desc(memories.updatedAt)).limit(limit)
  return c.json({ items: rows.map((r) => toMemoryView(r)) })
}))

// POST /memories —— 写入记忆（有 name → 同域同名 upsert；embedding 不可用 → 400 带 model:prepare 指引）
memoriesRoutes.post('/memories', h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const content = body['content']
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'bad_content', 'content 必填（非空字符串）')
  const scope = typeof body['scope'] === 'string' ? body['scope'] : 'project'
  if (scope !== 'project' && scope !== 'global') throw new HttpError(400, 'bad_scope', `scope 非法: ${scope}`)
  let projectId: number | null = null
  if (scope === 'project') {
    const pid = body['project_id']
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) throw new HttpError(400, 'bad_project_id', 'scope=project 时 project_id 必填（正整数）')
    projectId = pid
  }
  const type = body['type'] === undefined ? 'note' : body['type']
  if (typeof type !== 'string' || !type.trim()) throw new HttpError(400, 'bad_type', 'type 非法')
  let name: string | null = null
  if (body['name'] !== undefined && body['name'] !== null) {
    if (typeof body['name'] !== 'string' || !body['name'].trim()) throw new HttpError(400, 'bad_name', 'name 非法')
    name = body['name'].trim()
  }
  const meta = body['meta'] && typeof body['meta'] === 'object' && !Array.isArray(body['meta']) ? (body['meta'] as Record<string, unknown>) : undefined
  const { id, created } = await upsertMemory({ projectId, type, name, content, meta })
  const rows = await db.select().from(memories).where(eq(memories.id, id)).limit(1)
  return c.json({ memory: toMemoryView(rows[0]!), created }, 201)
}))

// GET /memories/status —— 模型与索引状态（不触发模型加载；dims 未加载时读 config.json）
memoriesRoutes.get('/memories/status', h(async (c) => {
  const st = await embeddingStatus()
  const total = (await db.select({ n: count() }).from(memories))[0]?.n ?? 0
  const rows = await db.select({ embedding: memories.embedding, embeddingModel: memories.embeddingModel }).from(memories)
  const missing = rows.filter((r) => !r.embedding || !r.embeddingModel?.startsWith(`${st.modelName}@`)).length
  return c.json({ ...st, count: total, missingEmbedding: missing })
}))

// POST /memories/reindex —— 全量重建索引（模型不可用 → 400 带指引）
memoriesRoutes.post('/memories/reindex', h(async (c) => {
  const r = await reindexMemories()
  return c.json(r)
}))

// PUT /memories/:id —— 局部更新（content 变更 → 重算 embedding）
memoriesRoutes.put('/memories/:id', h(async (c) => {
  const id = idParam(c)
  const cur = (await db.select().from(memories).where(eq(memories.id, id)).limit(1))[0]
  if (!cur) return notFound(c, `记忆 ${id}`)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (body['content'] !== undefined) {
    if (typeof body['content'] !== 'string' || !body['content'].trim()) throw new HttpError(400, 'bad_content', 'content 非法')
    const vec = await embed(body['content']) // 模型不可用 → 抛错（消息含指引）
    patch['content'] = body['content']
    patch['embedding'] = JSON.stringify(vec)
    patch['embeddingModel'] = `${await resolveModelName()}@${vec.length}`
  }
  if (body['type'] !== undefined) {
    if (typeof body['type'] !== 'string' || !body['type'].trim()) throw new HttpError(400, 'bad_type', 'type 非法')
    patch['type'] = body['type']
  }
  if (body['name'] !== undefined) {
    if (body['name'] !== null && (typeof body['name'] !== 'string' || !body['name'].trim())) throw new HttpError(400, 'bad_name', 'name 非法')
    patch['name'] = body['name'] === null ? null : body['name'].trim()
  }
  const rows = await db.update(memories).set(patch).where(eq(memories.id, id)).returning()
  return c.json({ memory: toMemoryView(rows[0]!) })
}))

// DELETE /memories/:id —— 物理删除（记忆数据无文件残留，直接删行）
memoriesRoutes.delete('/memories/:id', h(async (c) => {
  const id = idParam(c)
  const rows = await db.delete(memories).where(eq(memories.id, id)).returning()
  if (!rows[0]) return notFound(c, `记忆 ${id}`)
  return c.json({ ok: true })
}))

function intQuery(c: Context, name: string): number | undefined {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `bad_${name}`, `${name} 非法: ${raw}`)
  return n
}

function toMemoryView(r: typeof memories.$inferSelect, score?: number): Record<string, unknown> {
  let meta: unknown = {}
  if (r.meta) { try { meta = JSON.parse(r.meta) } catch { meta = {} } }
  return {
    id: r.id,
    scope: r.projectId === null ? 'global' : 'project',
    projectId: r.projectId,
    type: r.type,
    name: r.name,
    content: r.content,
    embeddingModel: r.embeddingModel,
    hasEmbedding: Boolean(r.embedding),
    meta,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(score !== undefined ? { score } : {}),
  }
}
