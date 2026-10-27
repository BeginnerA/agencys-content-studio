/**
 * 发布登记 REST（E4 内容面）：登记/列表+汇总/更新回填/删除
 * 增强：批量导入 / 趋势视图 / A/B 分组对比 / title+ab_group 字段
 * - run_id/asset_id 可空：允许登记非流水线内容
 * - metrics 白名单归一（views/likes/comments/favorites/shares → 非负整数）
 */
import { Hono } from 'hono'
import { and, asc, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db'
import { publications, settings } from '../db/schema'
import { publicationTotals } from '../services/stats'
import { parseTable, TableParseError, type ParsedTable } from '../services/table-parse'
import { parseMapping, assembleRows, matchRows, ImportError, type ImportMapping } from '../services/publication-import'
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

// ---------- 批量导入 ----------

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

// ---------- 趋势视图 ----------

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

// ---------- A/B 分组对比 ----------

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

// ---------- 平台数据文件导入（M67，spec §3.3） ----------

const IMPORT_PRESETS_KEY = 'publication_import_presets'
/** 预设名保留字（JSON 键名即用户输入，阻断 __proto__ 等回灌原型链）与长度上限 */
const IMPORT_PRESET_RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const IMPORT_PRESET_NAME_MAX = 50

async function readImportPresets(): Promise<Record<string, { platform: string; mapping: ImportMapping }>> {
  const row = (await db.select().from(settings).where(eq(settings.key, IMPORT_PRESETS_KEY)).limit(1))[0]
  if (!row) return {}
  try {
    // null 原型承装：存储 JSON 的键名不可信，阻断解析结果上的 __proto__ 等保留键污染面
    return Object.assign(Object.create(null), JSON.parse(row.value)) as Record<string, { platform: string; mapping: ImportMapping }>
  } catch {
    return {}
  }
}

async function saveImportPreset(name: string, platform: string, mapping: ImportMapping): Promise<void> {
  if (IMPORT_PRESET_RESERVED.has(name)) {
    throw new HttpError(400, 'bad_input', `预设名不可使用保留字（${[...IMPORT_PRESET_RESERVED].join('/')}）`)
  }
  if (name.length > IMPORT_PRESET_NAME_MAX) {
    throw new HttpError(400, 'bad_input', `预设名超 ${IMPORT_PRESET_NAME_MAX} 字符上限`)
  }
  const presets = await readImportPresets()
  presets[name] = { platform, mapping }
  const value = JSON.stringify(presets)
  const now = Date.now()
  await db
    .insert(settings)
    .values({ key: IMPORT_PRESETS_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
}

function mappingOf(raw: string): ImportMapping {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'bad_input', 'mapping 非合法 JSON')
  }
  try {
    return parseMapping(obj)
  } catch (e) {
    if (e instanceof ImportError) throw new HttpError(400, e.code, e.message)
    throw e
  }
}

/** POST /publications/import?project_id=&dry_run= —— multipart: file + platform + mapping[可选] + preset[可选]（无状态两阶段，spec §3.3） */
publicationsRoutes.post('/publications/import', h(async (c) => {
  const projectId = Number(c.req.query('project_id'))
  if (!Number.isInteger(projectId) || projectId <= 0) throw new HttpError(400, 'bad_input', 'project_id 必填')
  const dryRun = c.req.query('dry_run') === '1'
  const form = await c.req.formData().catch(() => {
    throw new HttpError(400, 'bad_form', '非 multipart/form-data 请求')
  })
  const platform = form.get('platform')
  if (typeof platform !== 'string' || !(PLATFORMS as readonly string[]).includes(platform)) {
    throw new HttpError(400, 'bad_platform', `platform 需为 ${PLATFORMS.join('|')}`)
  }
  const mappingRaw = form.get('mapping')
  if (mappingRaw === null && !dryRun) throw new HttpError(400, 'bad_input', '导入落库需 mapping（JSON 列映射）')
  const mapping: ImportMapping | null = typeof mappingRaw === 'string' ? mappingOf(mappingRaw) : null

  const file = form.get('file')
  if (!(file instanceof File)) throw new HttpError(400, 'bad_input', 'file 必填（xlsx/csv 文件）')
  const ext = file.name.split('.').pop() ?? ''
  const buf = Buffer.from(await file.arrayBuffer())
  let table: ParsedTable
  try {
    table = parseTable(buf, ext)
  } catch (e) {
    if (e instanceof TableParseError) throw new HttpError(400, e.code, e.message)
    throw e
  }
  const columns = table.header.map((name, index) => ({
    index,
    name,
    sample: table.rows.slice(0, 3).map((r) => r[index] ?? ''),
  }))

  if (!mapping) {
    // dry_run=1 无 mapping：仅解析预览（列映射 UI 取列清单），零写库
    return c.json({ columns, sampleRows: [], warnings: table.warnings })
  }

  const assembled = assembleRows(table, mapping, platform)
  const existing = await db
    .select()
    .from(publications)
    .where(and(eq(publications.projectId, projectId), eq(publications.platform, platform)))
  const plan = matchRows(assembled.rows, existing)

  if (dryRun) {
    return c.json({
      columns,
      preview: { updateCount: plan.updates.length, newCount: plan.creates.length, duplicates: plan.duplicates },
      sampleRows: assembled.rows.slice(0, 8),
      warnings: [...table.warnings, ...assembled.warnings],
    })
  }

  const t = Date.now()
  for (const r of plan.creates) {
    await db.insert(publications).values({
      projectId,
      platform,
      url: r.url,
      publishedAt: r.publishedAt,
      title: r.title,
      abGroup: r.abGroup,
      metrics: JSON.stringify(r.metrics),
      runId: null,
      assetId: null,
      note: null,
      createdAt: t,
      updatedAt: t,
    })
  }
  for (const u of plan.updates) {
    await db
      .update(publications)
      .set({ ...u.patch, updatedAt: t })
      .where(eq(publications.id, u.id))
  }
  const presetName = form.get('preset')
  if (typeof presetName === 'string' && presetName.trim()) {
    await saveImportPreset(presetName.trim(), platform, mapping)
  }
  return c.json({ created: plan.creates.length, updated: plan.updates.length, warnings: [...table.warnings, ...assembled.warnings] })
}))

publicationsRoutes.get('/publications/import/presets', h(async (c) => {
  return c.json({ presets: await readImportPresets() })
}))

publicationsRoutes.put('/publications/import/presets', h(async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
  if (!name) throw new HttpError(400, 'bad_input', 'name 必填')
  const platform = body['platform']
  if (typeof platform !== 'string' || !(PLATFORMS as readonly string[]).includes(platform)) {
    throw new HttpError(400, 'bad_platform', `platform 需为 ${PLATFORMS.join('|')}`)
  }
  const mapping = mappingOf(JSON.stringify(body['mapping'] ?? null))
  await saveImportPreset(name, platform, mapping)
  return c.json({ ok: true })
}))
