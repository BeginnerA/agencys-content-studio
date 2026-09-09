import { Hono } from 'hono'
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, pipelineRuns, projects } from '../db/schema'
import { loadTemplate } from '../pipeline/loader'
import { HttpError, h, idParam, notFound } from './helpers'

export const projectsRoutes = new Hono()

// GET /projects —— 项目列表（?status= 过滤；含最近 run 与资产计数）
projectsRoutes.get('/projects', h(async (c) => {
  const status = c.req.query('status') ?? 'active'
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.status, status), isNull(projects.deletedAt)))
    .orderBy(desc(projects.updatedAt))
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return c.json({ items: [] })

  const runs = await db
    .select({ id: pipelineRuns.id, projectId: pipelineRuns.projectId, status: pipelineRuns.status, templateKey: pipelineRuns.templateKey, createdAt: pipelineRuns.createdAt, updatedAt: pipelineRuns.updatedAt })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.projectId, ids))
    .orderBy(desc(pipelineRuns.updatedAt))
  const runsByProject = new Map<number, typeof runs[number][]>()
  for (const r of runs) {
    const list = runsByProject.get(r.projectId) ?? []
    if (list.length < 5) list.push(r)
    runsByProject.set(r.projectId, list)
  }
  const counts = await db
    .select({ projectId: assets.projectId, cnt: count() })
    .from(assets)
    .where(and(inArray(assets.projectId, ids), isNull(assets.deletedAt)))
    .groupBy(assets.projectId)
  const countByProject = new Map(counts.map((r) => [r.projectId, r.cnt]))
  return c.json({
    items: rows.map((p) => ({
      id: p.id,
      name: p.name,
      genre: p.genre,
      brief: p.brief,
      templateKey: p.templateKey,
      status: p.status,
      coverAssetId: p.coverAssetId,
      tags: safeJson(p.tags, []),
      assetCount: countByProject.get(p.id) ?? 0,
      recentRuns: (runsByProject.get(p.id) ?? []).map((r) => ({
        id: r.id,
        status: r.status,
        templateKey: r.templateKey,
        updatedAt: r.updatedAt,
      })),
      updatedAt: p.updatedAt,
    })),
  })
}))

// POST /projects —— 新建项目
projectsRoutes.post('/projects', h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const name = body['name']
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'bad_name', 'name 必填')
  const templateKey = typeof body['template_key'] === 'string' ? body['template_key'] : 'mengbao-episode'
  try {
    loadTemplate(templateKey)
  } catch (err) {
    throw new HttpError(400, 'bad_template', `模板不可用：${(err as Error).message}`)
  }
  const genre = typeof body['genre'] === 'string' ? body['genre'] : 'drama_short'
  const settings = body['settings'] && typeof body['settings'] === 'object' ? JSON.stringify(body['settings']) : '{}'
  const tags = Array.isArray(body['tags']) ? JSON.stringify(body['tags'].filter((t: unknown) => typeof t === 'string')) : '[]'
  const t = Date.now()
  const row = await db
    .insert(projects)
    .values({
      name: name.trim(),
      genre,
      brief: typeof body['brief'] === 'string' ? body['brief'] : null,
      templateKey,
      settings,
      tags,
      createdAt: t,
      updatedAt: t,
    })
    .returning()
  const p = row[0]!
  return c.json({ project: { id: p.id, name: p.name, genre: p.genre, templateKey: p.templateKey, brief: p.brief } }, 201)
}))

// GET /projects/:id —— 详情（含 settings 解析 + 最近 5 runs）
projectsRoutes.get('/projects/:id', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt))).limit(1)
  const p = rows[0]
  if (!p) return notFound(c, `项目 ${id}`)
  const runs = await db
    .select()
    .from(pipelineRuns)
    .where(eq(pipelineRuns.projectId, id))
    .orderBy(desc(pipelineRuns.createdAt))
    .limit(5)
  return c.json({
    project: {
      ...p,
      settings: safeJson(p.settings, {}),
      tags: safeJson(p.tags, []),
      recentRuns: runs.map((r) => ({
        id: r.id,
        status: r.status,
        templateKey: r.templateKey,
        currentStepKey: r.currentStepKey,
        error: r.error,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    },
  })
}))

// PATCH /projects/:id —— 局部更新（name/brief/settings/tags/status/template_key/cover_asset_id）
projectsRoutes.patch('/projects/:id', h(async (c) => {
  const id = idParam(c)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (body['name'] !== undefined) {
    if (typeof body['name'] !== 'string' || !body['name'].trim()) throw new HttpError(400, 'bad_name', 'name 非法')
    patch['name'] = body['name'].trim()
  }
  if (body['brief'] !== undefined) patch['brief'] = typeof body['brief'] === 'string' ? body['brief'] : null
  if (body['status'] !== undefined) {
    if (!['active', 'archived'].includes(body['status'] as string)) throw new HttpError(400, 'bad_status', 'status 需为 active|archived')
    patch['status'] = body['status']
  }
  if (body['template_key'] !== undefined) {
    if (typeof body['template_key'] !== 'string') throw new HttpError(400, 'bad_template', 'template_key 非法')
    try { loadTemplate(body['template_key']) } catch (err) { throw new HttpError(400, 'bad_template', `模板不可用：${(err as Error).message}`) }
    patch['templateKey'] = body['template_key']
  }
  if (body['settings'] !== undefined && typeof body['settings'] === 'object') patch['settings'] = JSON.stringify(body['settings'])
  if (body['tags'] !== undefined && Array.isArray(body['tags'])) patch['tags'] = JSON.stringify(body['tags'])
  if (body['cover_asset_id'] !== undefined) patch['coverAssetId'] = body['cover_asset_id'] === null ? null : Number(body['cover_asset_id'])
  const rows = await db.update(projects).set(patch).where(and(eq(projects.id, id), isNull(projects.deletedAt))).returning()
  if (!rows[0]) return notFound(c, `项目 ${id}`)
  return c.json({ project: rows[0] })
}))

// DELETE /projects/:id —— 归档（逻辑删 status=archived）
projectsRoutes.delete('/projects/:id', h(async (c) => {
  const id = idParam(c)
  const rows = await db
    .update(projects)
    .set({ status: 'archived', updatedAt: Date.now() })
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .returning()
  if (!rows[0]) return notFound(c, `项目 ${id}`)
  return c.json({ ok: true })
}))

function safeJson(s: string | null, fallback: unknown): unknown {
  if (!s) return fallback
  try { return JSON.parse(s) } catch { return fallback }
}