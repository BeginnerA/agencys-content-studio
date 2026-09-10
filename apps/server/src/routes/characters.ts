import { Hono } from 'hono'
import { desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db'
import { assets, characters, type CharacterRow } from '../db/schema'
import { assertProjectAssets } from '../pipeline/refs'
import { upsertCharacter } from '../services/character'
import { HttpError, h, idParam, notFound } from './helpers'

export const charactersRoutes = new Hono()

// GET /characters —— 角色列表（?project_id=；项目视角 = 项目域 + 全局；含 refAssets 缩略）
charactersRoutes.get('/characters', h(async (c) => {
  const raw = c.req.query('project_id')
  let rows: CharacterRow[]
  if (raw !== undefined && raw !== '') {
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0) throw new HttpError(400, 'bad_project_id', `project_id 非法: ${raw}`)
    rows = await db
      .select()
      .from(characters)
      .where(or(eq(characters.projectId, pid), isNull(characters.projectId)))
      .orderBy(desc(characters.updatedAt))
  } else {
    rows = await db.select().from(characters).orderBy(desc(characters.updatedAt))
  }
  const byId = await refAssetsOf(rows)
  return c.json({ items: rows.map((r) => toCharacterView(r, byId)) })
}))

// GET /characters/:id —— 详情
charactersRoutes.get('/characters/:id', h(async (c) => {
  const row = await findCharacterRow(idParam(c))
  if (!row) return notFound(c, `角色 ${c.req.param('id')}`)
  const byId = await refAssetsOf([row])
  return c.json({ character: toCharacterView(row, byId) })
}))

// POST /characters —— 新建 / 具名 upsert（name 含别名命中；同域同名更新而非重复插入）
charactersRoutes.post('/characters', h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const name = body['name']
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'bad_name', 'name 必填（非空字符串）')
  let projectId: number | null = null
  if (body['project_id'] !== undefined && body['project_id'] !== null) {
    const pid = Number(body['project_id'])
    if (!Number.isInteger(pid) || pid <= 0) throw new HttpError(400, 'bad_project_id', 'project_id 非法')
    projectId = pid
  }
  const aliases = body['aliases']
  if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((x) => typeof x !== 'string' || !x))) {
    throw new HttpError(400, 'bad_aliases', 'aliases 需为非空字符串数组')
  }
  let refAssetIds: number[] | undefined
  if (body['ref_asset_ids'] !== undefined) {
    if (!Array.isArray(body['ref_asset_ids'])) throw new HttpError(400, 'bad_ref_assets', 'ref_asset_ids 需为数组')
    if (body['ref_asset_ids'].length > 0 && projectId === null) {
      throw new HttpError(400, 'bad_ref_assets', '全局角色库不接受项目资产引用（请提供 project_id）')
    }
    refAssetIds = projectId !== null ? await assertProjectAssets(projectId, body['ref_asset_ids'], 'ref_asset_ids') : []
  }
  const summary = strField(body, 'summary')
  const appearance = strField(body, 'appearance')
  const negative = strField(body, 'negative')
  const voice = strField(body, 'voice')
  const meta = body['meta'] && typeof body['meta'] === 'object' && !Array.isArray(body['meta']) ? (body['meta'] as Record<string, unknown>) : undefined
  const { id, created } = await upsertCharacter({
    projectId,
    name: name.trim(),
    aliases,
    summary,
    appearance,
    negative,
    voice,
    refAssetIds: refAssetIds && refAssetIds.length > 0 ? refAssetIds : undefined,
    meta,
  })
  const row = await findCharacterRow(id)
  return c.json({ character: toCharacterView(row!, new Map()), created }, 201)
}))

// PUT /characters/:id —— 局部更新（传即替换；ref_asset_ids 须属该行项目域）
charactersRoutes.put('/characters/:id', h(async (c) => {
  const id = idParam(c)
  const cur = await findCharacterRow(id)
  if (!cur) return notFound(c, `角色 ${id}`)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (body['name'] !== undefined) {
    if (typeof body['name'] !== 'string' || !body['name'].trim()) throw new HttpError(400, 'bad_name', 'name 非法')
    patch['name'] = body['name'].trim()
  }
  if (body['aliases'] !== undefined) {
    if (!Array.isArray(body['aliases'])) throw new HttpError(400, 'bad_aliases', 'aliases 需为字符串数组')
    patch['aliases'] = JSON.stringify(body['aliases'].filter((x) => typeof x === 'string'))
  }
  for (const key of ['summary', 'appearance', 'negative', 'voice'] as const) {
    if (body[key] !== undefined) {
      if (body[key] !== null && typeof body[key] !== 'string') throw new HttpError(400, `bad_${key}`, `${key} 需为字符串或 null`)
      patch[key] = body[key]
    }
  }
  if (body['ref_asset_ids'] !== undefined) {
    if (!Array.isArray(body['ref_asset_ids'])) throw new HttpError(400, 'bad_ref_assets', 'ref_asset_ids 需为数组')
    if (cur.projectId === null) {
      if (body['ref_asset_ids'].length > 0) throw new HttpError(400, 'bad_ref_assets', '全局角色库不接受项目资产引用')
      patch['refAssetIds'] = JSON.stringify([])
    } else {
      patch['refAssetIds'] = JSON.stringify(await assertProjectAssets(cur.projectId, body['ref_asset_ids'], 'ref_asset_ids'))
    }
  }
  const rows = await db.update(characters).set(patch).where(eq(characters.id, id)).returning()
  const byId = await refAssetsOf([rows[0]!])
  return c.json({ character: toCharacterView(rows[0]!, byId) })
}))

// DELETE /characters/:id —— 物理删除（档案无文件残留；定妆照资产保留）
charactersRoutes.delete('/characters/:id', h(async (c) => {
  const rows = await db.delete(characters).where(eq(characters.id, idParam(c))).returning()
  if (!rows[0]) return notFound(c, `角色 ${c.req.param('id')}`)
  return c.json({ ok: true })
}))

async function findCharacterRow(id: number): Promise<CharacterRow | null> {
  const rows = await db.select().from(characters).where(eq(characters.id, id)).limit(1)
  return rows[0] ?? null
}

/** 角色引用资产批量查（refAssetIds 并集 → 行 Map） */
async function refAssetsOf(rows: CharacterRow[]): Promise<Map<number, typeof assets.$inferSelect>> {
  const ids = [...new Set(rows.flatMap((r) => safeNums(r.refAssetIds)))]
  if (ids.length === 0) return new Map()
  const assetRows = await db.select().from(assets).where(inArray(assets.id, ids))
  return new Map(assetRows.map((a) => [a.id, a]))
}

/** body 文本字段：undefined/null → undefined（不更新）；字符串 trim 后为空 → undefined；非字符串 → 400 */
function strField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new HttpError(400, `bad_${key}`, `${key} 需为字符串`)
  return v.trim() || undefined
}

function toCharacterView(r: CharacterRow, assetsById: Map<number, typeof assets.$inferSelect>): Record<string, unknown> {
  const refAssetIds = safeNums(r.refAssetIds)
  let aliases: string[] = []
  try {
    const v = JSON.parse(r.aliases) as unknown
    if (Array.isArray(v)) aliases = v.filter((x): x is string => typeof x === 'string')
  } catch { /* 空 */ }
  let meta: unknown = {}
  try { meta = JSON.parse(r.meta) } catch { meta = {} }
  const refAssets = refAssetIds
    .map((aid) => assetsById.get(aid))
    .filter((a) => a !== undefined)
    .map((a) => ({
      id: a!.id,
      name: a!.name,
      urls: { file: `/api/v1/assets/${a!.id}/file`, thumb: a!.kind === 'image' ? `/api/v1/assets/${a!.id}/thumb` : null },
    }))
  return {
    id: r.id,
    scope: r.projectId === null ? 'global' : 'project',
    projectId: r.projectId,
    name: r.name,
    aliases,
    summary: r.summary,
    appearance: r.appearance,
    negative: r.negative,
    voice: r.voice,
    refAssetIds,
    refAssets,
    meta,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function safeNums(s: string): number[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}
