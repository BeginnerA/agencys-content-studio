import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db'
import { stylePresets, type StylePreset } from '../db/schema'
import { extractStyleSnippetFromAssets } from '../services/style-preset'
import { HttpError, h, idParam, notFound } from './helpers'

/**
 * M8 风格预设库路由：CRUD（平台级通用画风词块，跨体裁跨项目复用）。
 * 项目绑定经 PATCH /projects/:id 的 settings.style_preset_id（服务端零新增绑定端点）；
 * 删除/停用后绑定残留 → ai_image 运行时宽容降级（resolveProjectStyleSnippet 返回 null + 日志）。
 */
export const stylePresetsRoutes = new Hono()

// GET /style-presets —— 列表（?active=1 仅启用；排序 sort_order asc, id asc）
stylePresetsRoutes.get('/style-presets', h(async (c) => {
  const activeOnly = c.req.query('active') === '1'
  const rows = activeOnly
    ? await db.select().from(stylePresets).where(eq(stylePresets.isActive, 1)).orderBy(asc(stylePresets.sortOrder), asc(stylePresets.id))
    : await db.select().from(stylePresets).orderBy(asc(stylePresets.sortOrder), asc(stylePresets.id))
  return c.json({ items: rows.map(toView) })
}))

// GET /style-presets/:id —— 详情
stylePresetsRoutes.get('/style-presets/:id', h(async (c) => {
  const row = await findRow(idParam(c))
  if (!row) return notFound(c, `风格预设 ${c.req.param('id')}`)
  return c.json({ preset: toView(row) })
}))

// POST /style-presets/extract —— [M13] 参考图 → 画风词提取（视觉 LLM；不落库，前端预填新建表单）
stylePresetsRoutes.post('/style-presets/extract', h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const pid = Number(body['project_id'])
  if (!Number.isInteger(pid) || pid <= 0) throw new HttpError(400, 'bad_project_id', 'project_id 非法')
  const assetIds = body['asset_ids']
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    throw new HttpError(400, 'bad_asset_ids', 'asset_ids 需为非空数组（1..4 张图片）')
  }
  const r = await extractStyleSnippetFromAssets(pid, assetIds)
  return c.json({ snippet: r.snippet, provider: r.provider, model: r.model })
}))

// POST /style-presets —— 新建（name 唯一 / snippet 必填）
stylePresetsRoutes.post('/style-presets', h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const name = body['name']
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'bad_name', 'name 必填（非空字符串）')
  const snippet = body['snippet']
  if (typeof snippet !== 'string' || !snippet.trim()) throw new HttpError(400, 'bad_snippet', 'snippet 必填（非空字符串）')
  const description = optStr(body, 'description')
  const sortOrder = optInt(body, 'sort_order') ?? 0
  const now = Date.now()
  try {
    const row = (
      await db
        .insert(stylePresets)
        .values({ name: name.trim(), snippet: snippet.trim(), description, sortOrder, isActive: 1, createdAt: now, updatedAt: now })
        .returning()
    )[0]!
    return c.json({ preset: toView(row) }, 201)
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(400, 'duplicate_name', `预设名已存在: ${name.trim()}`)
    throw err
  }
}))

// PUT /style-presets/:id —— 局部更新（name/snippet/description/sort_order/is_active）
stylePresetsRoutes.put('/style-presets/:id', h(async (c) => {
  const id = idParam(c)
  const cur = await findRow(id)
  if (!cur) return notFound(c, `风格预设 ${id}`)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (body['name'] !== undefined) {
    if (typeof body['name'] !== 'string' || !body['name'].trim()) throw new HttpError(400, 'bad_name', 'name 非法')
    patch['name'] = body['name'].trim()
  }
  if (body['snippet'] !== undefined) {
    if (typeof body['snippet'] !== 'string' || !body['snippet'].trim()) throw new HttpError(400, 'bad_snippet', 'snippet 非法')
    patch['snippet'] = body['snippet'].trim()
  }
  if (body['description'] !== undefined) {
    if (body['description'] !== null && typeof body['description'] !== 'string') throw new HttpError(400, 'bad_description', 'description 需为字符串或 null')
    patch['description'] = typeof body['description'] === 'string' ? body['description'].trim() || null : null
  }
  if (body['sort_order'] !== undefined) {
    const v = Number(body['sort_order'])
    if (!Number.isInteger(v)) throw new HttpError(400, 'bad_sort_order', 'sort_order 需为整数')
    patch['sortOrder'] = v
  }
  if (body['is_active'] !== undefined) {
    const v = body['is_active']
    if (v === true || v === 1) patch['isActive'] = 1
    else if (v === false || v === 0) patch['isActive'] = 0
    else throw new HttpError(400, 'bad_is_active', 'is_active 需为布尔或 0/1')
  }
  try {
    const rows = await db.update(stylePresets).set(patch).where(eq(stylePresets.id, id)).returning()
    return c.json({ preset: toView(rows[0]!) })
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(400, 'duplicate_name', `预设名已存在: ${String(body['name'])}`)
    throw err
  }
}))

// DELETE /style-presets/:id —— 删除（项目绑定残留 → 运行时宽容降级）
stylePresetsRoutes.delete('/style-presets/:id', h(async (c) => {
  const rows = await db.delete(stylePresets).where(eq(stylePresets.id, idParam(c))).returning()
  if (!rows[0]) return notFound(c, `风格预设 ${c.req.param('id')}`)
  return c.json({ ok: true })
}))

async function findRow(id: number): Promise<StylePreset | null> {
  const rows = await db.select().from(stylePresets).where(eq(stylePresets.id, id)).limit(1)
  return rows[0] ?? null
}

function toView(r: StylePreset): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    snippet: r.snippet,
    description: r.description,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** body 可选文本：undefined/null → null；非字符串 → 400 */
function optStr(body: Record<string, unknown>, key: string): string | null {
  const v = body[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new HttpError(400, `bad_${key}`, `${key} 需为字符串`)
  return v.trim() || null
}

/** body 可选整数：undefined/null → undefined；非整数 → 400 */
function optInt(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key]
  if (v === undefined || v === null) return undefined
  const n = Number(v)
  if (!Number.isInteger(n)) throw new HttpError(400, `bad_${key}`, `${key} 需为整数`)
  return n
}

/** 唯一约束冲突判定：drizzle 包装为 DrizzleQueryError（cause 链 → LibsqlError/SqliteError） */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(e.message)) return true
  }
  return false
}
