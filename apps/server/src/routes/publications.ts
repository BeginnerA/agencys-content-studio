/**
 * [M4] 发布登记 REST（E4 内容面）：登记/列表+汇总/更新回填/删除
 * [M20] 增强：批量导入 / 趋势视图 / A/B 分组对比 / title+ab_group 字段
 * - run_id/asset_id 可空：允许登记非流水线内容
 * - metrics 白名单归一（views/likes/comments/favorites/shares → 非负整数）
 */
import { Hono } from 'hono'
import { and, asc, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db'
import { publications } from '../db/schema'
import { publicationTotals } from '../services/stats'
import { HttpError, h, idParam, notFound } from './helpers'

export const publicationsRoutes = new Hono()

const PLATFORMS = ['douyin', 'wechat_channels', 'kuaishou', 'xiaohongshu', 'bilibili', 'other'] as const

// POST /publications —— 登记（run_id/asset_id 可空：允许非流水线内容）
publicationsRoutes.post('/publications', h(async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const projectId = Number(body['project_id'])
  if (!Number.isInteger(projectId) || projectId <= 0) throw new HttpError(400, 'bad_input', 'project_id 必填')
  const platform = body['platform']
  if (typeof platform !== 'string' || !(PLATFORMS as readonly string[]).includes(platform)) {
    throw new HttpError(400, 'bad_platform', `platform 需为 ${PLATFORMS.join('|')}`)
  }
  const t = Date.now()
  const row = (
    await db
      .insert(publications)
      .values({
        projectId,
        runId: intOrNull(body['run_id']),
        assetId: intOrNull(body['asset_id']),
        platform,
        url: typeof body['url'] === 'string' ? body['url'] : null,
        publishedAt: intOrNull(body['published_at']),
        metrics: JSON.stringify(normalizeMetrics(body['metrics'])),
        title: typeof body['title'] === 'string' ? body['title'] : null,
        abGroup: typeof body['ab_group'] === 'string' ? body['ab_group'] : null,
        note: typeof body['note'] === 'string' ? body['note'] : null,
        createdAt: t,
        updatedAt: t,
      })
      .returning()
  )[0]!
  return c.json({ publication: toView(row) }, 201)
}))

// GET /publications?project_id=&run_id=&asset_id=&platform= —— 列表 + 汇总（views/interactions 同口径）
publicationsRoutes.get('/publications', h(async (c) => {
  const conds = []
  const projectId = c.req.query('project_id')
  if (projectId) conds.push(eq(publications.projectId, Number(projectId)))
  const runId = c.req.query('run_id')
  if (runId) conds.push(eq(publications.runId, Number(runId)))
  const assetId = c.req.query('asset_id')
  if (assetId) conds.push(eq(publications.assetId, Number(assetId)))
  const platform = c.req.query('platform')
  if (platform) conds.push(eq(publications.platform, platform))
  const abGroup = c.req.query('ab_group')
  if (abGroup) conds.push(eq(publications.abGroup, abGroup))
  const rows = await db
    .select()
    .from(publications)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(publications.createdAt))
    .limit(200)
  return c.json({ items: rows.map(toView), summary: publicationTotals(rows) })
}))

// PUT /publications/:id —— 更新（含指标回填）
publicationsRoutes.put('/publications/:id', h(async (c) => {
  const id = idParam(c)
  const row = (await db.select().from(publications).where(eq(publications.id, id)).limit(1))[0]
  if (!row) return notFound(c, `发布记录 ${id}`)
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (body['platform'] !== undefined) {
    if (typeof body['platform'] !== 'string' || !(PLATFORMS as readonly string[]).includes(body['platform'])) {
      throw new HttpError(400, 'bad_platform', `platform 需为 ${PLATFORMS.join('|')}`)
    }
    patch.platform = body['platform']
  }
  if (typeof body['url'] === 'string') patch.url = body['url']
  if (body['published_at'] !== undefined) patch.publishedAt = intOrNull(body['published_at'])
  if (body['metrics'] !== undefined) patch.metrics = JSON.stringify(normalizeMetrics(body['metrics']))
  if (typeof body['title'] === 'string') patch.title = body['title'] || null
  if (typeof body['ab_group'] === 'string') patch.abGroup = body['ab_group'] || null
  if (typeof body['note'] === 'string') patch.note = body['note']
  const updated = (await db.update(publications).set(patch).where(eq(publications.id, id)).returning())[0]!
  return c.json({ publication: toView(updated) })
}))

// DELETE /publications/:id
publicationsRoutes.delete('/publications/:id', h(async (c) => {
  const id = idParam(c)
  const row = (await db.select().from(publications).where(eq(publications.id, id)).limit(1))[0]
  if (!row) return notFound(c, `发布记录 ${id}`)
  await db.delete(publications).where(eq(publications.id, id))
  return c.json({ ok: true })
}))

/** 指标白名单归一：views/likes/comments/favorites/shares → 非负整数（缺省/非法 → 0） */
function normalizeMetrics(v: unknown): Record<string, number> {
  const keys = ['views', 'likes', 'comments', 'favorites', 'shares'] as const
  const src = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const out: Record<string, number> = {}
  for (const k of keys) {
    const n = Number(src[k] ?? 0)
    out[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return out
}

function intOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

function toView(r: typeof publications.$inferSelect): Record<string, unknown> {
  return {
    id: r.id,
    projectId: r.projectId,
    runId: r.runId,
    assetId: r.assetId,
    platform: r.platform,
    url: r.url,
    publishedAt: r.publishedAt,
    metrics: safeParse(r.metrics),
    title: r.title,
    abGroup: r.abGroup,
    note: r.note,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function safeParse(s: string | null): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// ---------- [M20] 批量导入 ----------

/** POST /publications/batch —— 批量导入（数组 ≤200 条） */
publicationsRoutes.post('/publications/batch', h(async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const items = body['items']
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'bad_input', 'items 需为非空数组')
  if (items.length > 200) throw new HttpError(400, 'too_many', '单次最多 200 条')
  const t = Date.now()
  const created: Array<Record<string, unknown>> = []
  for (const raw of items) {
    const b = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const projectId = Number(b['project_id'])
    if (!Number.isInteger(projectId) || projectId <= 0) continue
    const platform = b['platform']
    if (typeof platform !== 'string' || !(PLATFORMS as readonly string[]).includes(platform)) continue
    const row = (
      await db.insert(publications).values({
        projectId,
        runId: intOrNull(b['run_id']),
        assetId: intOrNull(b['asset_id']),
        platform,
        url: typeof b['url'] === 'string' ? b['url'] : null,
        publishedAt: intOrNull(b['published_at']),
        metrics: JSON.stringify(normalizeMetrics(b['metrics'])),
        title: typeof b['title'] === 'string' ? b['title'] : null,
        abGroup: typeof b['ab_group'] === 'string' ? b['ab_group'] : null,
        note: typeof b['note'] === 'string' ? b['note'] : null,
        createdAt: t,
        updatedAt: t,
      }).returning()
    )[0]!
    created.push(toView(row))
  }
  return c.json({ count: created.length, items: created }, 201)
}))

// ---------- [M20] 趋势视图 ----------

/** GET /publications/trend?project_id=&days= —— 按日聚合发布指标趋势 */
publicationsRoutes.get('/publications/trend', h(async (c) => {
  const projectId = c.req.query('project_id')
  const days = Math.min(365, Math.max(7, Number(c.req.query('days') ?? '30')))
  const from = Date.now() - days * 86_400_000
  const conds = [gte(publications.publishedAt, from)]
  if (projectId) conds.push(eq(publications.projectId, Number(projectId)))
  const rows = await db
    .select({
      day: sql<string>`strftime('%Y-%m-%d', ${publications.publishedAt} / 1000, 'unixepoch', 'localtime')`,
      metrics: publications.metrics,
    })
    .from(publications)
    .where(and(...conds))
    .orderBy(asc(publications.publishedAt))
  const map = new Map<string, { count: number; views: number; interactions: number }>()
  for (const r of rows) {
    const day = r.day || 'unknown'
    if (!map.has(day)) map.set(day, { count: 0, views: 0, interactions: 0 })
    const acc = map.get(day)!
    acc.count++
    let m: Record<string, unknown> = {}
    try { m = JSON.parse(r.metrics) } catch { /* skip */ }
    const n = (k: string) => typeof m[k] === 'number' && Number.isFinite(m[k]) ? (m[k] as number) : 0
    acc.views += n('views')
    acc.interactions += n('likes') + n('comments') + n('favorites') + n('shares')
  }
  const items = [...map.entries()].map(([day, v]) => ({ day, ...v }))
  return c.json({ items, days })
}))

// ---------- [M20] A/B 分组对比 ----------

/** GET /publications/ab-groups?project_id= —— A/B 分组聚合对比 */
publicationsRoutes.get('/publications/ab-groups', h(async (c) => {
  const projectId = c.req.query('project_id')
  const conds = [isNotNull(publications.abGroup)]
  if (projectId) conds.push(eq(publications.projectId, Number(projectId)))
  const rows = await db
    .select({ abGroup: publications.abGroup, metrics: publications.metrics, platform: publications.platform })
    .from(publications)
    .where(and(...conds))
  const groups = new Map<string, { count: number; views: number; interactions: number; platforms: Set<string> }>()
  for (const r of rows) {
    const g = r.abGroup!
    if (!groups.has(g)) groups.set(g, { count: 0, views: 0, interactions: 0, platforms: new Set() })
    const acc = groups.get(g)!
    acc.count++
    acc.platforms.add(r.platform)
    let m: Record<string, unknown> = {}
    try { m = JSON.parse(r.metrics) } catch { /* skip */ }
    const n = (k: string) => typeof m[k] === 'number' && Number.isFinite(m[k]) ? (m[k] as number) : 0
    acc.views += n('views')
    acc.interactions += n('likes') + n('comments') + n('favorites') + n('shares')
  }
  const items = [...groups.entries()].map(([group, v]) => ({
    group,
    count: v.count,
    views: v.views,
    interactions: v.interactions,
    platforms: [...v.platforms],
    avgViews: v.count > 0 ? Math.round(v.views / v.count) : 0,
    avgInteractions: v.count > 0 ? Math.round(v.interactions / v.count) : 0,
  }))
  return c.json({ items })
}))
