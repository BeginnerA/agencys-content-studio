/**
 * [M4] 发布登记 REST（E4 内容面）：登记/列表+汇总/更新回填/删除
 * - run_id/asset_id 可空：允许登记非流水线内容
 * - metrics 白名单归一（views/likes/comments/favorites/shares → 非负整数）
 */
import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
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
        note: typeof body['note'] === 'string' ? body['note'] : null,
        createdAt: t,
        updatedAt: t,
      })
      .returning()
  )[0]!
  return c.json({ publication: toView(row) }, 201)
}))

// GET /publications?project_id=&asset_id=&platform= —— 列表 + 汇总（views/interactions 同口径）
publicationsRoutes.get('/publications', h(async (c) => {
  const conds = []
  const projectId = c.req.query('project_id')
  if (projectId) conds.push(eq(publications.projectId, Number(projectId)))
  const assetId = c.req.query('asset_id')
  if (assetId) conds.push(eq(publications.assetId, Number(assetId)))
  const platform = c.req.query('platform')
  if (platform) conds.push(eq(publications.platform, platform))
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
