import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '../db'
import { characters, type CharacterRow } from '../db/schema'
import { recordEntityVersion, type VersionSource } from './provenance'

/**
 * 角色库服务（泛化为实体素材库：kind 多态 character|scene|prop）。
 * 一致性锚定档案（appearance/negative/voice/refAssetIds）。
 * 索引键 = name 与 aliases 各项（原样精确匹配；英文别名兜底 toLowerCase）；同名时项目行覆盖全局行。
 * 全部为小数据量全表查询（单机百条级）。
 */

export type EntityKind = 'character' | 'scene' | 'prop'

/** 实体类型全集（路由/服务校验复用） */
export const ENTITY_KINDS = ['character', 'scene', 'prop'] as const

/** 实体索引：kind 限定（项目域 + 全局行 → Map（name/aliases → 行））；供 ai_image 注入与 tts 声线链复用 */
export async function loadEntityIndex(projectId: number, kind: EntityKind = 'character'): Promise<Map<string, CharacterRow>> {
  const rows = await db
    .select()
    .from(characters)
    .where(and(eq(characters.kind, kind), or(eq(characters.projectId, projectId), isNull(characters.projectId))))
  const index = new Map<string, CharacterRow>()
  // 全局先入、项目后入 → 同名时项目行覆盖（项目优先）
  for (const r of [...rows.filter((x) => x.projectId === null), ...rows.filter((x) => x.projectId === projectId)]) {
    putKeys(index, r)
  }
  return index
}

/** 单实体查询（name 含别名命中；kind 限定） */
export async function findEntity(projectId: number, name: string, kind: EntityKind = 'character'): Promise<CharacterRow | null> {
  const index = await loadEntityIndex(projectId, kind)
  return index.get(name) ?? index.get(name.toLowerCase()) ?? null
}

/** 具名 upsert（kind 分派）：name（含别名命中）匹配同域同 kind 行 → 更新非空字段（保 id、保未传字段；aliases/refAssetIds 并集去重； states 非空覆盖）；否则插入 */
export async function upsertEntity(p: {
  projectId: number | null
  kind?: EntityKind
  name: string
  aliases?: string[]
  summary?: string | null
  appearance?: string | null
  negative?: string | null
  voice?: string | null
  /** [B③] 自然语言声线描述（仅展示/审计，不进 TTS 声链） */
  voiceDesc?: string | null
  /** 状态变体（「{剧情节点}：{状态短语}」字符串数组；非空覆盖写） */
  states?: string[]
  refAssetIds?: number[]
  meta?: Record<string, unknown>
}): Promise<{ id: number; created: boolean }> {
  const now = Date.now()
  const kind = p.kind ?? 'character'
  const scopeCond = and(
    eq(characters.kind, kind),
    p.projectId === null ? isNull(characters.projectId) : eq(characters.projectId, p.projectId),
  )
  const rows = await db.select().from(characters).where(scopeCond)
  const lower = p.name.toLowerCase()
  const hit = rows.find(
    (r) =>
      r.name === p.name ||
      r.name.toLowerCase() === lower ||
      safeArr(r.aliases).some((a) => a === p.name || a.toLowerCase() === lower),
  )
  if (hit) {
    const patch: Record<string, unknown> = { updatedAt: now }
    if (p.aliases && p.aliases.length > 0) patch['aliases'] = JSON.stringify([...new Set([...safeArr(hit.aliases), ...p.aliases])])
    if (p.summary) patch['summary'] = p.summary
    if (p.appearance) patch['appearance'] = p.appearance
    if (p.negative) patch['negative'] = p.negative
    if (p.voice) patch['voice'] = p.voice
    if (p.voiceDesc) patch['voiceDesc'] = p.voiceDesc
    if (p.states && p.states.length > 0) patch['states'] = JSON.stringify(p.states)
    if (p.refAssetIds && p.refAssetIds.length > 0) {
      patch['refAssetIds'] = JSON.stringify([...new Set([...safeArrNum(hit.refAssetIds), ...p.refAssetIds])])
    }
    if (p.meta) patch['meta'] = JSON.stringify(p.meta)
    await db.update(characters).set(patch).where(eq(characters.id, hit.id))
    // 仅当有实质字段变更时记版本（避免空 upsert 污染版本链）
    if (Object.keys(patch).length > 1) {
      await recordEntityVersion({ entityId: hit.id, projectId: p.projectId, source: 'edit', label: p.name })
    }
    return { id: hit.id, created: false }
  }
  const inserted = (
    await db
      .insert(characters)
      .values({
        projectId: p.projectId,
        kind,
        name: p.name,
        aliases: JSON.stringify(p.aliases ?? []),
        summary: p.summary ?? null,
        appearance: p.appearance ?? null,
        negative: p.negative ?? null,
        voice: p.voice ?? null,
        voiceDesc: p.voiceDesc ?? null,
        states: JSON.stringify(p.states ?? []),
        refAssetIds: JSON.stringify(p.refAssetIds ?? []),
        meta: JSON.stringify(p.meta ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
  )[0]!
  // 新建实体登记初始版本（baseline）
  await recordEntityVersion({ entityId: inserted.id, projectId: p.projectId, source: 'baseline', label: p.name })
  return { id: inserted.id, created: true }
}

/** 参考图挂接（kind 限定）：与已有 refAssetIds 并集去重后更新，返回新增数量（未命中实体 / 无新增 → 0）。
 * 有新增时记实体版本（source 由调用上下文区分上传/生成）。 */
export async function attachRefAssets(
  projectId: number,
  name: string,
  assetIds: number[],
  kind: EntityKind = 'character',
  source: VersionSource = 'edit',
): Promise<number> {
  const row = await findEntity(projectId, name, kind)
  if (!row || assetIds.length === 0) return 0
  const existing = safeArrNum(row.refAssetIds)
  const merged = [...new Set([...existing, ...assetIds])]
  const added = merged.length - existing.length
  if (added > 0) {
    await db.update(characters).set({ refAssetIds: JSON.stringify(merged), updatedAt: Date.now() }).where(eq(characters.id, row.id))
    await recordEntityVersion({ entityId: row.id, projectId, source, label: `参考图挂接 +${added}` })
  }
  return added
}

// ---- 兼容委托：旧签名保留（kind 恒为 character）；probe-m3 / tts 链 / 存量调用零改动 ----

/** 角色索引（旧签名）：等价 loadEntityIndex(projectId, 'character') */
export async function loadCharacterIndex(projectId: number): Promise<Map<string, CharacterRow>> {
  return loadEntityIndex(projectId, 'character')
}

/** 单角色查询（旧签名）：等价 findEntity(projectId, name, 'character') */
export async function findCharacter(projectId: number, name: string): Promise<CharacterRow | null> {
  return findEntity(projectId, name, 'character')
}

/** 具名 upsert（旧签名）：等价 upsertEntity({ ...p, kind: 'character' }) */
export async function upsertCharacter(p: {
  projectId: number | null
  name: string
  aliases?: string[]
  summary?: string | null
  appearance?: string | null
  negative?: string | null
  voice?: string | null
  /** [B③] 自然语言声线描述（透传 upsertEntity） */
  voiceDesc?: string | null
  /** 状态变体（透传 upsertEntity） */
  states?: string[]
  refAssetIds?: number[]
  meta?: Record<string, unknown>
}): Promise<{ id: number; created: boolean }> {
  return upsertEntity({ ...p, kind: 'character' })
}

function putKeys(index: Map<string, CharacterRow>, r: CharacterRow): void {
  index.set(r.name, r)
  index.set(r.name.toLowerCase(), r)
  for (const a of safeArr(r.aliases)) {
    index.set(a, r)
    index.set(a.toLowerCase(), r)
  }
}

function safeArr(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function safeArrNum(s: string): number[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}
