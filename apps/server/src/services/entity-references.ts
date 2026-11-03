/**
 * 实体参考图分层登记服务（entity_references 表读写 + 派生同步）。
 * 分层行（role：base=基准定妆 / state=状态变体 / view=多视角补充）是显式登记的可选增强；
 * 每次增删改后把 enabled 行按优先级重算回写 characters.refAssetIds（扁平参考图列），
 * 保证未接入分层的下游（出图/复用/预览）零改动即可消费最新参考集，且每次回写记一条实体版本。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, characters, entityReferences } from '../db/schema'
import { recordEntityVersion } from './provenance'
import { GLOBAL_POOL_ID } from './global-pool'
import { MAX_REFS_PER_SHOT, REF_ROLES, selectEntityRefs } from './ref-selection'
import type { EntityRefRow, RefRole, SelectedRef } from './ref-selection'

/** 分层登记面错误：携带 HTTP 语义状态（400 入参非法 / 404 宿主缺失 / 409 唯一冲突），由端点层直接映射 */
export class EntityRefError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'EntityRefError'
  }
}

/** 参考登记视图（enabled 归一为布尔，供端点/UI 直接消费） */
export interface EntityRefView {
  id: number
  entityId: number
  assetId: number
  role: RefRole
  stateKey: string | null
  viewKey: string | null
  enabled: boolean
  note: string | null
  createdAt: number
}

interface EntityRefDbRow {
  id: number
  entityId: number
  assetId: number
  role: string
  stateKey: string | null
  viewKey: string | null
  enabled: number
  note: string | null
  createdAt: number
}

function toView(r: EntityRefDbRow): EntityRefView {
  return {
    id: r.id,
    entityId: r.entityId,
    assetId: r.assetId,
    role: r.role as RefRole,
    stateKey: r.stateKey,
    viewKey: r.viewKey,
    enabled: r.enabled === 1,
    note: r.note,
    createdAt: r.createdAt,
  }
}

/** states JSON 列宽容解析：非数组/坏 JSON → []；保留原文（分层状态命中需与条目原文精确对齐，不做 trim 归一） */
function parseStrArr(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
  } catch {
    return []
  }
}

/** refAssetIds JSON 列宽容解析：非数组/坏 JSON → []；仅保留正整数 id */
function parseNumArr(s: string): number[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(e.message)) return true
  }
  return false
}

async function loadCharacterRow(entityId: number): Promise<{ id: number; name: string; projectId: number | null; states: string; refAssetIds: string }> {
  const rows = await db
    .select({ id: characters.id, name: characters.name, projectId: characters.projectId, states: characters.states, refAssetIds: characters.refAssetIds })
    .from(characters)
    .where(eq(characters.id, entityId))
    .limit(1)
  const row = rows[0]
  if (!row) throw new EntityRefError(404, `实体 ${entityId} 不存在`)
  return row
}

/**
 * 派生同步：把该实体 enabled 分层行按 role 优先级（base→state→view）、同层按 id 升序重算成扁平 assetId 列表，
 * 回写 characters.refAssetIds；与现值 JSON 不等才写库并记一条实体版本（避免无变化也刷版本链）。
 * role 不在登记枚举内的历史脏行不入列（等价于停用），与选择策略的 enabled 过滤保持同一取用口径。
 */
async function deriveSync(entityId: number): Promise<void> {
  const rows = await db.select().from(characters).where(eq(characters.id, entityId)).limit(1)
  const entity = rows[0]
  if (!entity) return // 实体已删：无宿主可同步，静默返回
  const refRows = await db.select().from(entityReferences).where(and(eq(entityReferences.entityId, entityId), eq(entityReferences.enabled, 1)))
  const order: Record<RefRole, number> = { base: 0, state: 1, view: 2 }
  const sorted = refRows
    .filter((r) => (REF_ROLES as readonly string[]).includes(r.role))
    .sort((a, b) => order[a.role as RefRole] - order[b.role as RefRole] || a.id - b.id)
  const ids: number[] = []
  for (const r of sorted) if (!ids.includes(r.assetId)) ids.push(r.assetId)
  const next = JSON.stringify(ids)
  if (next === entity.refAssetIds) return // 参考集未变：不写库、不记版本
  const now = Date.now()
  await db.update(characters).set({ refAssetIds: next, updatedAt: now }).where(eq(characters.id, entityId))
  await recordEntityVersion({ entityId, projectId: entity.projectId, source: 'edit', label: '参考分层重算' })
}

/** 归属兼容校验：保证下游按出图运行项目解析该资产时恒可通过（全局实体只能挂全局池、项目实体只能挂本项目或全局池） */
function assertAssetScopeCompatible(entityProjectId: number | null, assetProjectId: number, assetId: number): void {
  if (entityProjectId === null) {
    if (assetProjectId !== GLOBAL_POOL_ID) {
      throw new EntityRefError(400, `全局实体只能登记全局素材池参考图（资产 ${assetId} 属项目 ${assetProjectId}，跨项目资产不得入全局）`)
    }
    return
  }
  if (assetProjectId !== entityProjectId && assetProjectId !== GLOBAL_POOL_ID) {
    throw new EntityRefError(400, `资产 ${assetId} 既不属实体所在项目 ${entityProjectId}，也不在全局素材池，下游出图无法解析`)
  }
}

/** state 角色校验：stateKey 非空且精确等于该实体 states 数组某条目（返回可核对的候选清单） */
function assertStateKey(entityStatesJson: string, role: RefRole, stateKey: string | null | undefined): void {
  if (role !== 'state') return
  const key = typeof stateKey === 'string' ? stateKey.trim() : ''
  if (!key) throw new EntityRefError(400, 'role=state 必须提供非空 stateKey')
  const states = parseStrArr(entityStatesJson)
  if (!states.includes(key)) {
    const options = states.length > 0 ? states.join(' / ') : '（该实体未登记任何状态）'
    throw new EntityRefError(400, `stateKey「${key}」需精确匹配实体 states 中的某条目，可核对：${options}`)
  }
}

/** 某实体全部 enabled 分层行（映射为选择策略消费的 EntityRefRow[]） */
async function enabledRowsOf(entityId: number): Promise<EntityRefRow[]> {
  const rows = await db.select().from(entityReferences).where(and(eq(entityReferences.entityId, entityId), eq(entityReferences.enabled, 1)))
  return rows.map((r) => ({ entityId: r.entityId, assetId: r.assetId, role: r.role as RefRole, stateKey: r.stateKey, viewKey: r.viewKey, enabled: r.enabled }))
}

/** 实体参考分层清单（含停用行，供管理界面完整呈现；实体不存在 404） */
export async function listEntityRefs(entityId: number): Promise<EntityRefView[]> {
  if (!Number.isInteger(entityId) || entityId <= 0) throw new EntityRefError(400, 'entityId 需为正整数')
  await loadCharacterRow(entityId) // 实体不存在 → 404
  const rows = await db.select().from(entityReferences).where(eq(entityReferences.entityId, entityId)).orderBy(entityReferences.id)
  return rows.map(toView)
}

/** 分层登记面的实体宿主快照（端点据此渲染状态下拉与旧数据判定，不再自行读实体行） */
export interface EntityRefHost {
  id: number
  name: string
  states: string[]
  refAssetIds: number[]
}

/**
 * 分层登记面的实体宿主快照：states 供状态下拉、refAssetIds 供「是否存在未分层历史扁平参考」判定；实体缺失 404。
 * 与 listEntityRefs 同款入参校验与缺失判定（复用 loadCharacterRow），JSON 列解析复用本文件私有解析函数——端点不再复制一份。
 */
export async function describeEntityRefHost(entityId: number): Promise<EntityRefHost> {
  if (!Number.isInteger(entityId) || entityId <= 0) throw new EntityRefError(400, 'entityId 需为正整数')
  const entity = await loadCharacterRow(entityId)
  return { id: entity.id, name: entity.name, states: parseStrArr(entity.states), refAssetIds: parseNumArr(entity.refAssetIds) }
}

/**
 * 新增分层登记（完整校验链，任一不过即抛带状态错误，不写库、不派生）：
 * 实体存在（404）→ role 合法（400）→ 资产存在且为图片且未删除（404/400）→ 归属兼容（400）
 * → state 角色 stateKey 精确命中（400）→ INSERT（唯一冲突 409）→ 固化该实体尚未登记的历史扁平参考图 → 派生同步回写。
 */
export async function addEntityRef(p: {
  entityId: number
  assetId: number
  role: string
  stateKey?: string | null
  viewKey?: string | null
  note?: string | null
}): Promise<EntityRefView> {
  if (!Number.isInteger(p.entityId) || p.entityId <= 0) throw new EntityRefError(400, 'entityId 需为正整数')
  if (!Number.isInteger(p.assetId) || p.assetId <= 0) throw new EntityRefError(400, 'assetId 需为正整数')
  const entity = await loadCharacterRow(p.entityId)
  if (!(REF_ROLES as readonly string[]).includes(p.role)) throw new EntityRefError(400, `role 需为 ${REF_ROLES.join('|')} 之一`)
  const role = p.role as RefRole

  const assetRows = await db
    .select({ id: assets.id, kind: assets.kind, projectId: assets.projectId, deletedAt: assets.deletedAt })
    .from(assets)
    .where(and(eq(assets.id, p.assetId), isNull(assets.deletedAt)))
    .limit(1)
  const asset = assetRows[0]
  if (!asset) throw new EntityRefError(404, `资产 ${p.assetId} 不存在或已删除`)
  if (asset.kind !== 'image') throw new EntityRefError(400, `资产 ${p.assetId} 非图片（kind=${asset.kind}），不可登记为参考图`)
  assertAssetScopeCompatible(entity.projectId, asset.projectId, p.assetId)
  assertStateKey(entity.states, role, p.stateKey)

  const stateKey = typeof p.stateKey === 'string' && p.stateKey.trim() ? p.stateKey.trim() : null
  const viewKey = typeof p.viewKey === 'string' && p.viewKey.trim() ? p.viewKey.trim() : null
  const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim() : null
  const now = Date.now()
  let inserted: EntityRefDbRow
  try {
    const rows = await db
      .insert(entityReferences)
      .values({ entityId: p.entityId, assetId: p.assetId, role, stateKey, viewKey, enabled: 1, note, createdAt: now })
      .returning()
    inserted = rows[0]! as EntityRefDbRow
  } catch (err) {
    if (isUniqueViolation(err)) throw new EntityRefError(409, `资产 ${p.assetId} 已登记为实体 ${p.entityId} 的参考图（同实体同资产唯一）`)
    throw err
  }
  // 登记成功后把该实体尚未建行的历史扁平参考图固化为基准分层行：characters.refAssetIds 是扁平列，
  // 早于分层登记能力就可能已存有出图/复用写入的参考图，而这些资产并没有对应的 entity_references 行。
  // 派生同步的口径是「以该实体 enabled 分层行为唯一真源，整体重算并覆盖扁平列」，
  // 所以若跳过这一步，首次分层登记后扁平列会只剩「本次新登记的那一张」，其余历史参考图被覆盖掉——
  // 仍直读扁平列的环节（定妆照复用、溯源输入冻结、无分层行时的隐式基准回退）会静默失去这些参考。
  // 回填必须排在 INSERT 之后：本次这张此时已有行，回填按「已登记即跳过」自然略过它，
  // 于是①不会出现「先占一行基准、用户随后无法把这张历史参考图改角色（同实体同资产只允许一行）」的死路，
  // ②也不会出现「先按缺了本次这张的集合回写一次扁平列、再整体覆盖」这一次中途失真与多余的实体版本记录，
  // ③校验或唯一冲突失败时更是分毫未写。回填后紧跟的派生同步把扁平列重算成旧集合的超集，历史项零丢失、本项不重复。
  await backfillEntityRefs(p.entityId)
  await deriveSync(p.entityId)
  return toView(inserted)
}

/**
 * 更新分层登记（行存在 404；role/stateKey 变更时按所属实体重跑同款校验；enabled 布尔归一 0/1）→ 派生同步。
 * 未提供的字段保持原值（局部更新）。
 */
export async function patchEntityRef(
  refId: number,
  p: { enabled?: boolean; role?: string; stateKey?: string | null; viewKey?: string | null; note?: string | null },
): Promise<EntityRefView> {
  if (!Number.isInteger(refId) || refId <= 0) throw new EntityRefError(400, 'refId 需为正整数')
  const curRows = await db.select().from(entityReferences).where(eq(entityReferences.id, refId)).limit(1)
  const cur = curRows[0] as EntityRefDbRow | undefined
  if (!cur) throw new EntityRefError(404, `参考登记 ${refId} 不存在`)

  const patch: Partial<Pick<EntityRefDbRow, 'role' | 'stateKey' | 'viewKey' | 'enabled' | 'note'>> = {}
  if (p.role !== undefined) {
    if (!(REF_ROLES as readonly string[]).includes(p.role)) throw new EntityRefError(400, `role 需为 ${REF_ROLES.join('|')} 之一`)
    patch.role = p.role
  }
  if (p.stateKey !== undefined) patch.stateKey = typeof p.stateKey === 'string' && p.stateKey.trim() ? p.stateKey.trim() : null
  if (p.viewKey !== undefined) patch.viewKey = typeof p.viewKey === 'string' && p.viewKey.trim() ? p.viewKey.trim() : null
  if (p.note !== undefined) patch.note = typeof p.note === 'string' && p.note.trim() ? p.note.trim() : null
  if (p.enabled !== undefined) patch.enabled = p.enabled ? 1 : 0

  const effectiveRole = (patch.role ?? cur.role) as RefRole
  const effectiveStateKey = patch.stateKey !== undefined ? patch.stateKey : cur.stateKey
  if (effectiveRole === 'state') {
    const entity = await loadCharacterRow(cur.entityId) // 校验取所属实体 states（行本身不带）
    assertStateKey(entity.states, effectiveRole, effectiveStateKey)
  }

  let updated: EntityRefDbRow | undefined
  if (Object.keys(patch).length > 0) {
    const rows = await db.update(entityReferences).set(patch).where(eq(entityReferences.id, refId)).returning()
    updated = rows[0] as EntityRefDbRow | undefined
  }
  if (!updated) {
    // 无任何字段变更（如 enabled 传入与现值相同）：原行回显，仍走派生同步保证列一致
    const again = await db.select().from(entityReferences).where(eq(entityReferences.id, refId)).limit(1)
    updated = again[0] as EntityRefDbRow
  }
  await deriveSync(cur.entityId)
  return toView(updated)
}

/** 删除分层登记（行存在 404）→ 派生同步。 */
export async function removeEntityRef(refId: number): Promise<void> {
  if (!Number.isInteger(refId) || refId <= 0) throw new EntityRefError(400, 'refId 需为正整数')
  const rows = await db.select({ id: entityReferences.id, entityId: entityReferences.entityId }).from(entityReferences).where(eq(entityReferences.id, refId)).limit(1)
  const cur = rows[0]
  if (!cur) throw new EntityRefError(404, `参考登记 ${refId} 不存在`)
  await db.delete(entityReferences).where(eq(entityReferences.id, refId))
  await deriveSync(cur.entityId)
}

/**
 * 回填：把 characters.refAssetIds 中「尚未登记为分层行」的资产逐个登记为 base（按数组序），
 * 仅用于给历史扁平参考集补出可管理的分层行；有实际插入才派生同步（重算列值与既有序一致 → 幂等稳定）。
 * 重复调用无新增（已登记资产被跳过）。
 * 被新增分层行的调用方在写库之后调用：那时本次登记的资产已有行，按「已登记即跳过」自然略过，
 * 既不会被抢先占成基准行而堵死「把这张历史参考图改成别的角色」，也不会让扁平列出现一次缺本项的中间态。
 */
export async function backfillEntityRefs(entityId: number): Promise<{ added: number }> {
  if (!Number.isInteger(entityId) || entityId <= 0) throw new EntityRefError(400, 'entityId 需为正整数')
  const entity = await loadCharacterRow(entityId)
  const refIds = parseNumArr(entity.refAssetIds)
  if (refIds.length === 0) return { added: 0 }
  const registeredRows = await db.select({ assetId: entityReferences.assetId }).from(entityReferences).where(eq(entityReferences.entityId, entityId))
  const registered = new Set(registeredRows.map((r) => r.assetId))
  const now = Date.now()
  let added = 0
  for (const assetId of refIds) {
    if (registered.has(assetId)) continue // 幂等：已登记（任意 role）即跳过
    await db.insert(entityReferences).values({ entityId, assetId, role: 'base', stateKey: null, viewKey: null, enabled: 1, note: '历史参考图回填', createdAt: now })
    registered.add(assetId)
    added += 1
  }
  if (added > 0) await deriveSync(entityId)
  return { added }
}

/**
 * 批量载入多个实体的 enabled 分层行索引（供出图逐镜选择消费）。
 * 空入参 → 空 Map（不发起 IN () 查询）；role 列断言回 RefRole；enabled 恒为 1（已过滤）。
 */
export async function loadRefIndex(entityIds: number[]): Promise<Map<number, EntityRefRow[]>> {
  const map = new Map<number, EntityRefRow[]>()
  const ids = [...new Set(entityIds.filter((n) => Number.isInteger(n) && n > 0))]
  if (ids.length === 0) return map
  const rows = await db.select().from(entityReferences).where(and(inArray(entityReferences.entityId, ids), eq(entityReferences.enabled, 1)))
  for (const r of rows) {
    const row: EntityRefRow = { entityId: r.entityId, assetId: r.assetId, role: r.role as RefRole, stateKey: r.stateKey, viewKey: r.viewKey, enabled: r.enabled }
    const list = map.get(r.entityId)
    if (list) list.push(row)
    else map.set(r.entityId, [row])
  }
  return map
}

/** 逐实体选择预览（纯读，不落库、不改 refAssetIds）：给定上下文看本实体实际会取用哪些参考、为何回退/裁剪 */
export async function previewEntitySelection(
  entityId: number,
  ctx: { scene?: number; episode?: number; text?: string },
  limit?: number,
): Promise<{ selected: SelectedRef[]; fallbacks: string[]; dropped: SelectedRef[] }> {
  if (!Number.isInteger(entityId) || entityId <= 0) throw new EntityRefError(400, 'entityId 需为正整数')
  const entity = await loadCharacterRow(entityId)
  const refRows = await enabledRowsOf(entityId)
  return selectEntityRefs(entity, refRows, ctx, limit ?? MAX_REFS_PER_SHOT)
}
