import { Hono } from 'hono'
import { extname } from 'node:path'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db'
import { assets, characters, type CharacterRow } from '../db/schema'
import { assertRefAssetsForScope, GLOBAL_POOL_ID } from '../services/global-pool'
import { attachRefAssetsById, ENTITY_KINDS, upsertEntity, type EntityKind } from '../services/character'
import { recordEntityVersion } from '../services/provenance'
import { cancelEntityRefTask, listEntityRefTasks, startEntityRefGen } from '../services/entity-refgen'
import { polishAppearance } from '../services/entity-polish'
import { importFiles, kindByExt } from '../services/storage'
import { recordLlmUsage } from '../services/usage'
import { toAssetView } from './assets'
import { HttpError, h, idParam, notFound, wb } from './helpers'

/**
 * 实体素材库路由：/entities（kind=character|scene|prop）+ /characters 兼容路径。
 * 同一 handler 双路径挂载；?kind= 缺省 character，旧客户端零改动。
 * /entities/ref-gen*：参考图批量生成（无 run 异步任务队列；校验在服务层）。
 */
export const charactersRoutes = new Hono()

/** 批量润色单次上限 */
const MAX_POLISH_ITEMS = 10
/** 参考图上传单文件上限（10MB） */
const MAX_REF_UPLOAD_BYTES = 10 * 1024 * 1024

// GET /entities|/characters —— 实体列表（?project_id=&kind=；项目视角 = 项目域 + 全局；含 refAssets 缩略）
const listEntities = h(async (c) => {
  const kind = parseKind(c.req.query('kind'))
  const raw = c.req.query('project_id')
  let rows: CharacterRow[]
  if (raw !== undefined && raw !== '') {
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0) throw new HttpError(400, 'bad_project_id', `project_id 非法: ${raw}`)
    rows = await db
      .select()
      .from(characters)
      .where(and(eq(characters.kind, kind), or(eq(characters.projectId, pid), isNull(characters.projectId))))
      .orderBy(desc(characters.updatedAt))
  } else {
    rows = await db.select().from(characters).where(eq(characters.kind, kind)).orderBy(desc(characters.updatedAt))
  }
  const byId = await refAssetsOf(rows)
  return c.json({ items: rows.map((r) => toEntityView(r, byId)) })
})
charactersRoutes.get('/entities', listEntities)
charactersRoutes.get('/characters', listEntities)

// GET /entities/:id|/characters/:id —— 详情
const getEntity = h(async (c) => {
  const row = await findEntityRow(idParam(c))
  if (!row) return notFound(c, `素材 ${c.req.param('id')}`)
  const byId = await refAssetsOf([row])
  return c.json({ entity: toEntityView(row, byId) })
})
charactersRoutes.get('/entities/:id', getEntity)
charactersRoutes.get('/characters/:id', getEntity)

// POST /entities|/characters —— 新建 / 具名 upsert（name 含别名命中；同域同名更新而非重复插入）
const createEntity = h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const kind = parseKind(body['kind'])
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
    // 全局素材池域放开：仅接受全局素材池资产（项目资产依旧拒）
    refAssetIds = await assertRefAssetsForScope(projectId, body['ref_asset_ids'], 'ref_asset_ids')
  }
  const summary = strField(body, 'summary')
  const appearance = strField(body, 'appearance')
  const negative = strField(body, 'negative')
  const voice = kind === 'character' ? strField(body, 'voice') : undefined // [B③] 机器音色令牌（仅角色）：scene/prop 忽略
  const voiceDesc = kind === 'character' ? strField(body, 'voice_desc') : undefined // [B③] 声线描述（仅角色）：scene/prop 忽略
  const states = kind === 'character' ? strArrField(body, 'states') : undefined // 状态变体仅角色有意义：scene/prop 忽略
  const meta = body['meta'] && typeof body['meta'] === 'object' && !Array.isArray(body['meta']) ? (body['meta'] as Record<string, unknown>) : undefined
  const { id, created } = await upsertEntity({
    projectId,
    kind,
    name: name.trim(),
    aliases,
    summary,
    appearance,
    negative,
    voice,
    voiceDesc,
    states,
    refAssetIds: refAssetIds && refAssetIds.length > 0 ? refAssetIds : undefined,
    meta,
  })
  const row = await findEntityRow(id)
  return c.json({ entity: toEntityView(row!, new Map()), created }, 201)
})
charactersRoutes.post('/entities', createEntity)
charactersRoutes.post('/characters', createEntity)

// POST /entities/polish —— 批量润色 appearance（逐项串行；失败收集不阻断；全局实体跳过用量记录）
const polishEntities = h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const rawIds = body['ids']
  if (!Array.isArray(rawIds)) throw new HttpError(400, 'bad_ids', 'ids 需为正整数数组')
  const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  if (ids.length === 0) throw new HttpError(400, 'bad_ids', 'ids 需为正整数数组')
  if (ids.length > MAX_POLISH_ITEMS) throw new HttpError(400, 'too_many_ids', `单次最多润色 ${MAX_POLISH_ITEMS} 项（当前 ${ids.length} 项）`)
  const rows = await db.select().from(characters).where(inArray(characters.id, ids))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const polished: Array<{ id: number; name: string; appearance: string }> = []
  const failed: Array<{ id: number; error: string }> = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      failed.push({ id, error: '素材不存在' })
      continue
    }
    try {
      const r = await polishAppearance(row)
      const appearance = r.appearance.trim()
      if (!appearance) {
        failed.push({ id, error: '润色输出为空（未更新）' })
        continue
      }
      await db.update(characters).set({ appearance, updatedAt: Date.now() }).where(eq(characters.id, id))
      // 润色改变外观锚定文本 → 记实体版本
      await recordEntityVersion({ entityId: id, projectId: row.projectId, source: 'polish', label: 'LLM 润色外观' })
      if (row.projectId !== null) {
        await recordLlmUsage({ projectId: row.projectId, runId: null, provider: r.provider, model: r.model, usage: r.usage })
      }
      polished.push({ id, name: row.name, appearance })
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return c.json({ ok: true, polished, failed })
})
charactersRoutes.post('/entities/polish', polishEntities)

// POST /entities/ref-gen —— 批量发起参考图生成（≤10 实体 × 1-4 变体；入队即返 202）
// 体容 camelCase（spec 形态）与 snake_case（本路由既有风格）双写法
charactersRoutes.post('/entities/ref-gen', h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const projectId = body['projectId'] ?? body['project_id']
  const entityIds = body['entityIds'] ?? body['entity_ids']
  const variants = body['variants'] ?? 1
  const r = await wb(() => startEntityRefGen(Number(projectId), entityIds, variants))
  return c.json({ ok: true, tasks: r.tasks, count: r.count, note: '已入队生成（完成后自动挂接该素材参考图）' }, 202)
}))

// GET /entities/ref-gen/tasks?project_id= —— 任务列表（全部在途 + 近 20 条终态；供页内进度初始化）
charactersRoutes.get('/entities/ref-gen/tasks', h(async (c) => {
  const raw = c.req.query('project_id') ?? c.req.query('projectId')
  const r = await wb(() => listEntityRefTasks(Number(raw)))
  return c.json(r)
}))

// POST /entities/ref-gen/tasks/:id/cancel —— 取消（仅 pending/processing；完成后弃存）
charactersRoutes.post('/entities/ref-gen/tasks/:id/cancel', h(async (c) => {
  const id = idParam(c)
  await wb(() => cancelEntityRefTask(id))
  return c.json({ ok: true, note: '任务已取消（已发出的生成请求无法中断，完成后弃存）' })
}))

// PUT /entities/:id|/characters/:id —— 局部更新（传即替换；ref_asset_ids 须属该行项目域）
const updateEntity = h(async (c) => {
  const id = idParam(c)
  const cur = await findEntityRow(id)
  if (!cur) return notFound(c, `素材 ${id}`)
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
    if (key === 'voice' && cur.kind !== 'character') continue // 声线仅角色有意义：scene/prop 忽略
    if (body[key] !== undefined) {
      if (body[key] !== null && typeof body[key] !== 'string') throw new HttpError(400, `bad_${key}`, `${key} 需为字符串或 null`)
      patch[key] = body[key]
    }
  }
  if (body['voice_desc'] !== undefined && cur.kind === 'character') {
    // [B③] body 键 snake（voice_desc）→ 列属性 camel（voiceDesc）；仅角色（同 voice 口径）
    if (body['voice_desc'] !== null && typeof body['voice_desc'] !== 'string') throw new HttpError(400, 'bad_voice_desc', 'voice_desc 需为字符串或 null')
    patch['voiceDesc'] = body['voice_desc']
  }
  if (body['states'] !== undefined && cur.kind === 'character') {
    // states 替换语义：含空数组（空 = 清空）；scene/prop 忽略（同 voice 口径）
    if (!Array.isArray(body['states'])) throw new HttpError(400, 'bad_states', 'states 需为字符串数组')
    patch['states'] = JSON.stringify(cleanStrArr(body['states']))
  }
  if (body['ref_asset_ids'] !== undefined) {
    if (!Array.isArray(body['ref_asset_ids'])) throw new HttpError(400, 'bad_ref_assets', 'ref_asset_ids 需为数组')
    // 替换语义不变；全局素材池域仅接受池资产
    patch['refAssetIds'] = JSON.stringify(await assertRefAssetsForScope(cur.projectId, body['ref_asset_ids'], 'ref_asset_ids'))
  }
  const rows = await db.update(characters).set(patch).where(eq(characters.id, id)).returning()
  // 实质字段变更时记版本
  if (Object.keys(patch).length > 1) {
    await recordEntityVersion({ entityId: id, projectId: cur.projectId, source: 'edit', label: '手工编辑' })
  }
  const byId = await refAssetsOf([rows[0]!])
  return c.json({ entity: toEntityView(rows[0]!, byId) })
})
charactersRoutes.put('/entities/:id', updateEntity)
charactersRoutes.put('/characters/:id', updateEntity)

// DELETE /entities/:id|/characters/:id —— 物理删除（档案无文件残留；参考图资产保留）
const removeEntity = h(async (c) => {
  const rows = await db.delete(characters).where(eq(characters.id, idParam(c))).returning()
  if (!rows[0]) return notFound(c, `素材 ${c.req.param('id')}`)
  return c.json({ ok: true })
})
charactersRoutes.delete('/entities/:id', removeEntity)
charactersRoutes.delete('/characters/:id', removeEntity)

// POST /entities/:id/ref-images —— 上传参考图（multipart: file；sha256 去重入库 + 挂接并集；
// 全局实体放开：文件入全局素材池（虚拟项目 #0）并按行 id 挂接，避免同名项目行遮蔽）
const uploadEntityRefImage = h(async (c) => {
  const id = idParam(c)
  const cur = await findEntityRow(id)
  if (!cur) return notFound(c, `素材 ${id}`)
  const form = await c.req.formData().catch(() => { throw new HttpError(400, 'bad_form', '非 multipart/form-data 请求') })
  const fileRaw = form.get('file')
  if (!fileRaw || typeof fileRaw === 'string') throw new HttpError(400, 'no_file', '未收到文件（字段名 file）')
  const file = fileRaw as File
  if (file.size > MAX_REF_UPLOAD_BYTES) throw new HttpError(413, 'too_large', '单文件超过 10MB 上限')
  if (kindByExt(extname(file.name)) !== 'image') throw new HttpError(400, 'not_image', '仅支持图片文件（png/jpg/jpeg/webp/gif/bmp）')
  const buf = new Uint8Array(await file.arrayBuffer())
  if (buf.byteLength === 0) throw new HttpError(400, 'no_file', '文件内容为空')
  const ownerProjectId = cur.projectId ?? GLOBAL_POOL_ID
  const [asset] = await importFiles(ownerProjectId, [{ name: file.name || `ref-${cur.kind}-${Date.now()}`, data: buf }], { purpose: `reference_${cur.kind}` })
  await attachRefAssetsById(cur.id, [asset!.id], 'ref-upload', cur.projectId)
  const fresh = await findEntityRow(id)
  const byId = await refAssetsOf([fresh!])
  return c.json({ entity: toEntityView(fresh!, byId), asset: toAssetView(asset!) }, 201)
})
charactersRoutes.post('/entities/:id/ref-images', uploadEntityRefImage)

/** kind 解析（query/body 同口径）：缺省 character；非法 → 400 */
function parseKind(raw: unknown): EntityKind {
  if (raw === undefined || raw === null || raw === '') return 'character'
  if (typeof raw === 'string' && (ENTITY_KINDS as readonly string[]).includes(raw)) return raw as EntityKind
  throw new HttpError(400, 'bad_kind', `kind 非法: ${String(raw)}（可选 character|scene|prop）`)
}

async function findEntityRow(id: number): Promise<CharacterRow | null> {
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

/** body 字符串数组字段：undefined/null → undefined；非数组 → 400；元素清洗见 cleanStrArr */
function strArrField(body: Record<string, unknown>, key: string): string[] | undefined {
  const v = body[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new HttpError(400, `bad_${key}`, `${key} 需为字符串数组`)
  return cleanStrArr(v)
}

/** 字符串数组清洗：仅留字符串 + trim 去空 + 去重保序（states 口径） */
function cleanStrArr(v: unknown[]): string[] {
  return [...new Set(v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean))]
}

function toEntityView(r: CharacterRow, assetsById: Map<number, typeof assets.$inferSelect>): Record<string, unknown> {
  const refAssetIds = safeNums(r.refAssetIds)
  const aliases = safeStrArr(r.aliases)
  let meta: unknown = {}
  try { meta = JSON.parse(r.meta) } catch { meta = {} }
  const refAssets = refAssetIds
    .map((aid) => assetsById.get(aid))
    .filter((a) => a !== undefined)
    .map((a) => ({
      id: a!.id,
      name: a!.name,
      urls: { file: `/api/v1/assets/${a!.id}/file`, thumb: a!.kind === 'image' ? `/api/v1/assets/${a!.id}/thumb?v=2` : null },
    }))
  return {
    id: r.id,
    kind: r.kind,
    scope: r.projectId === null ? 'global' : 'project',
    projectId: r.projectId,
    name: r.name,
    aliases,
    summary: r.summary,
    appearance: r.appearance,
    negative: r.negative,
    voice: r.voice,
    voiceDesc: r.voiceDesc,
    states: safeStrArr(r.states),
    refAssetIds,
    refAssets,
    meta,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** JSON 字符串数组读取（坏 JSON/非数组 → []；aliases/states 同容错） */
function safeStrArr(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
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
