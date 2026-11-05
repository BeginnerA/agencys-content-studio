/**
 * 实体参考图分层选择策略（纯函数）。
 * role 优先级：状态命中 → 基准 → 多视角补充；
 * 实体未登记分层行时，refAssetIds 全体按隐式基准处理（旧项目零改动语义，无隐式写库）。
 */
import type { CharacterRow } from '../db/schema'
import { matchStateEntry } from './state-match'

export type RefRole = 'base' | 'state' | 'view'
export const REF_ROLES: readonly RefRole[] = ['base', 'state', 'view']

/** 单镜角色参考图上限（语义：按角色出场顺序截断） */
export const MAX_CHARACTER_REFS_PER_SHOT = 4

/** 单镜参考图总量上限（角色 ≤4 + 场景 ≤1 + 道具 ≤1） */
export const MAX_REFS_PER_SHOT = 6

/** 分层参考登记行（entity_references 表行的最小形状；enabled 为 0/1 整数列） */
export interface EntityRefRow {
  entityId: number
  assetId: number
  role: RefRole
  stateKey: string | null
  viewKey: string | null
  enabled: number
}

/** 单条入选参考（reason = 入选理由，供出图快照逐条追溯分层语义） */
export interface SelectedRef {
  assetId: number
  role: RefRole
  reason: string
}

/** 选择策略消费的镜头形状（出图 ShotSpec 的结构子集；image_prompt 可缺 → 文本档不命中） */
export interface RefShot {
  id: string
  characters?: string[]
  location?: string
  props?: string[]
  /** 画布直通参考图资产 id（前插注入，保序去重；与实体锚定参考共存） */
  ref_asset_ids?: number[]
  /** 场次号：states「第N场」定位词命中依据；缺失 → 场次档不命中 */
  scene?: number
  image_prompt?: string
}

/**
 * states 条目 JSON 列宽容解析：非数组/坏 JSON → []；剔空白项（与出图侧同语义）
 */
function parseStrArr(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
  } catch {
    return []
  }
}

/** refAssetIds JSON 列宽容解析：非数组/坏 JSON → []；仅保留正整数 id（与出图侧同语义） */
function parseNumArr(s: string): number[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}

/** 实体索引查询：原样 → 小写兜底（与 character 服务的索引键一致） */
function lookupCharacter(index: Map<string, CharacterRow>, name: string): CharacterRow | undefined {
  return index.get(name) ?? index.get(name.toLowerCase())
}

/**
 * 单实体参考图选择（纯函数）：
 * 有 enabled 分层行 → 状态命中（stateKey = 命中的 states 条目原文）→ 基准 → 多视角，逐级填充至 limit；
 * 命中状态但无对应分层行 → 回退基准并记 fallbacks；
 * 无分层行 → 隐式基准：refAssetIds 全体按扁平数组序作基准参考（未分层项目的既有语义）；
 * 超出 limit 的候选进 dropped（带原因），同资产重复不计额；
 * limit ≤0 → 候选全部按上限原因进 dropped 并立即返回：此时「本镜不可用 → 回退基准」的说明是误导
 * （回退同样取不到参考，而扁平列的 id 还会与分层行候选重复记账）。
 */
export function selectEntityRefs(
  row: { id: number; states: string; refAssetIds: string },
  refRows: EntityRefRow[],
  ctx: { scene?: number; episode?: number; text?: string },
  limit: number,
): { selected: SelectedRef[]; fallbacks: string[]; dropped: SelectedRef[] } {
  const enabled = refRows.filter((r) => r.enabled === 1 && r.entityId === row.id)
  const selected: SelectedRef[] = []
  const fallbacks: string[] = []
  const dropped: SelectedRef[] = []
  const seen = new Set<number>()
  const take = (r: EntityRefRow, reason: string): void => {
    if (seen.has(r.assetId)) return
    if (selected.length >= limit) {
      dropped.push({ assetId: r.assetId, role: r.role, reason: `超出参考图上限(${limit})` })
      return
    }
    seen.add(r.assetId)
    selected.push({ assetId: r.assetId, role: r.role, reason })
  }
  if (enabled.length === 0) {
    // 隐式基准：未分层实体沿用扁平数组序（与旧 collectRefAssetIds 行为等价）
    for (const assetId of parseNumArr(row.refAssetIds)) {
      if (selected.length >= limit) {
        dropped.push({ assetId, role: 'base', reason: `超出参考图上限(${limit})` })
        continue
      }
      seen.add(assetId)
      selected.push({ assetId, role: 'base', reason: '基准参考（未分层）' })
    }
    return { selected, fallbacks, dropped }
  }
  // 状态命中：与文本锚定同款语义——多条命中取数组最后一条（数组序即时间序，后覆盖前）
  let hitEntry: string | null = null
  for (const entry of parseStrArr(row.states)) {
    const m = matchStateEntry(entry, ctx)
    if (m.hit && m.phrase) hitEntry = entry
  }
  if (hitEntry) {
    const stateRefs = enabled.filter((r) => r.role === 'state' && r.stateKey === hitEntry)
    if (stateRefs.length > 0) for (const r of stateRefs) take(r, `状态命中「${hitEntry}」`)
    else fallbacks.push(`状态「${hitEntry}」无分层参考，回退基准`)
  }
  for (const r of enabled.filter((x) => x.role === 'base')) take(r, '基准参考')
  for (const r of enabled.filter((x) => x.role === 'view')) take(r, '多视角补充')
  // 零/负上限：本实体所有候选都已按「超出参考图上限(0)」记进裁剪，直接返回。
  // 不走下面的回退分支——回退结果照样受零上限约束、一张也取不到，却会额外产出一条
  // 「本镜不可用 → 回退基准参考图」的说明（语义错误：不可用的原因是名额为零，不是没有参考），
  // 并把扁平列的同一批 id 重复记入 dropped（与分层行候选双重记账，让每镜参考追溯失真）。
  if (limit <= 0) return { selected, fallbacks, dropped }

  // 分层行存在但本镜无可取用（如场景/道具只登记了状态变体行、或命中的状态行未登记参考）→ 回退隐式基准，
  // 绝不让「登记过参考」的实体静默零参考；场景/道具不带状态上下文，故这条分支对二者是常规路径而非例外。
  if (selected.length === 0) {
    fallbacks.push(`分层参考图本镜不可用（实体 #${row.id}），回退基准参考图`)
    for (const assetId of parseNumArr(row.refAssetIds)) {
      if (selected.length >= limit) {
        dropped.push({ assetId, role: 'base', reason: `超出参考图上限(${limit})` })
        continue
      }
      seen.add(assetId)
      selected.push({ assetId, role: 'base', reason: '基准参考（分层行回退）' })
    }
  }
  return { selected, fallbacks, dropped }
}

/** 单镜参考图选择结果：ids 为入列快照源，其余三项供日志与 params 快照追溯 */
export interface ShotRefSelection {
  ids: number[]
  perEntity: { entityId: number; name: string; refs: SelectedRef[] }[]
  fallbacks: string[]
  dropped: SelectedRef[]
}

/**
 * 本镜参考图收集（纯函数，任务 params.refAssetIds 快照源）：
 * shot.ref_asset_ids 直通（前插）→ 角色（shot.characters，跨角色共享 MAX_CHARACTER_REFS_PER_SHOT 名额、按出场顺序截断）
 * → 场景（shot.location 命中行，≤1）→ 道具（shot.props 命中行并集，≤1）；
 * 保序去重；总量 ≤totalLimit（缺省 = MAX_REFS_PER_SHOT），满额后新的实体选择行进 dropped。
 * refIndex 缺省（实体无分层数据）→ 全部走隐式基准，取用结果与未分层项目一致。
 * 场景/道具与角色的差异：二者无 states 语义 → 不做状态命中优先，直接按资产 id 升序取首个可用。
 * totalLimit 由宿主按登记的模型能力收紧总量（缺省即不收紧，行为与既有口径逐字等价）：
 * 上限小于宿主总量时，因这一收紧而落选的候选写成「超出模型参考图上限(N)」而非总量文案——
 * 追溯要能看出这张参考是被模型能力砍掉的，而不是产品自身的总量规则砍掉的（降级不得静默）。
 */
export function collectRefSelection(
  shot: RefShot,
  indexes: { characters: Map<string, CharacterRow>; scenes: Map<string, CharacterRow>; props: Map<string, CharacterRow> },
  refIndex?: Map<number, EntityRefRow[]>,
  stateCtx?: { episode?: number },
  totalLimit: number = MAX_REFS_PER_SHOT,
): ShotRefSelection {
  const ids: number[] = []
  const seen = new Set<number>()
  const perEntity: { entityId: number; name: string; refs: SelectedRef[] }[] = []
  const fallbacks: string[] = []
  const dropped: SelectedRef[] = []
  /** 本镜总量是否被模型能力收紧到宿主总量以内（决定落选候选用哪一句原因） */
  const cappedByModel = totalLimit < MAX_REFS_PER_SHOT
  const capsDropReason = `超出模型参考图上限(${totalLimit})`
  /** 入列一条参考：保序去重 + 总量上限；返回是否实际入列 */
  const accept = (assetId: number): boolean => {
    if (seen.has(assetId) || ids.length >= totalLimit) return false
    seen.add(assetId)
    ids.push(assetId)
    return true
  }

  /** 该实体的分层行（按资产 id 升序；不改动入参索引） */
  const rowsOf = (row: CharacterRow): EntityRefRow[] => [...(refIndex?.get(row.id) ?? [])].sort((a, b) => a.assetId - b.assetId)
  /** 逐实体记录选择结果（同一实体重复出场只记一次，参考图仍按去重语义共用名额） */
  const note = (row: CharacterRow, refs: SelectedRef[], res: { fallbacks: string[]; dropped: SelectedRef[] }): void => {
    if (!perEntity.some((p) => p.entityId === row.id)) perEntity.push({ entityId: row.id, name: row.name, refs })
    fallbacks.push(...res.fallbacks)
    dropped.push(...res.dropped)
  }

  // 0) 画布直通（shots.ref_asset_ids 前插——画布连线比实体锚定更显式）
  for (const raw of shot.ref_asset_ids ?? []) {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) accept(raw)
  }
  // 角色状态命中上下文：与状态锚定注入同款取值（镜号 + 场景名 + 画面提示词）
  const scene = typeof shot.scene === 'number' && Number.isFinite(shot.scene) ? shot.scene : undefined
  const stateMatchCtx = { scene, episode: stateCtx?.episode, text: [shot.id, shot.location ?? '', shot.image_prompt ?? ''].join(' ') }

  // 1) 角色（语义：跨角色共享 4 名额、按出场顺序截断；总量剩余空间同样约束本段）
  let charUsed = 0
  for (const raw of shot.characters ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const row = lookupCharacter(indexes.characters, raw.trim())
    if (!row) continue
    const charRoom = MAX_CHARACTER_REFS_PER_SHOT - charUsed
    const totalRoom = totalLimit - ids.length
    if (charRoom <= 0 || totalRoom <= 0) {
      // 共享名额或总量已满：本实体候选全部记为裁剪，原因按实际生效的上限区分
      const reason = charRoom <= 0
        ? `超出角色参考图上限(${MAX_CHARACTER_REFS_PER_SHOT})`
        : cappedByModel
          ? capsDropReason
          : `超出参考图总量上限(${MAX_REFS_PER_SHOT})`
      const full = selectEntityRefs(row, rowsOf(row), stateMatchCtx, 0)
      note(row, [], { fallbacks: full.fallbacks, dropped: full.dropped.map((d) => ({ ...d, reason })) })
      continue
    }
    const limit = Math.min(charRoom, totalRoom)
    const res = selectEntityRefs(row, rowsOf(row), stateMatchCtx, limit)
    // 本段名额被收紧后的总量压小（totalRoom < charRoom 才是「模型上限砍的」；两者相等时
    // 不收紧也会给到同样的名额，原因仍是本段自身上限，不能冒充成能力降级）
    if (cappedByModel && totalRoom < charRoom) for (const d of res.dropped) d.reason = capsDropReason

    const refs = [...res.selected]
    let added = 0
    for (const s of res.selected) if (accept(s.assetId)) added += 1
    // 与他处（画布/前序角色）重复的资产不占角色名额：把本实体被裁掉的候选按原序补进剩余空位
    for (const cand of [...res.dropped]) {
      if (added >= limit) break
      if (!accept(cand.assetId)) continue
      res.dropped.splice(res.dropped.indexOf(cand), 1)
      // 回补的候选原先带着「超出上限」的落选原因，如今已实际入列送模型：沿用旧文案会让同一资产 id
      // 在追溯里既是发送项又是被砍项，自相矛盾，改成回补说明。
      refs.push({ ...cand, reason: `重复腾出的名额回补（本角色上限 ${limit}）` })
      added += 1
    }
    charUsed += added
    note(row, refs, res)
  }

  // 2) 场景（location 命中行，≤1）
  const loc = typeof shot.location === 'string' ? shot.location.trim() : ''
  if (loc) {
    const row = lookupCharacter(indexes.scenes, loc)
    if (row) {
      const res = selectEntityRefs(row, rowsOf(row), {}, 1)
      for (const s of res.selected) accept(s.assetId)
      note(row, res.selected, res)
    }
  }

  // 3) 道具（props 命中行并集，≤1：取到首个有可用参考的道具后即止；命中但无参考不占名额）
  for (const raw of shot.props ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const row = lookupCharacter(indexes.props, raw.trim())
    if (!row) continue
    const res = selectEntityRefs(row, rowsOf(row), {}, 1)
    if (res.selected.length === 0) continue
    for (const s of res.selected) accept(s.assetId)
    note(row, res.selected, res)
    break
  }

  return { ids, perEntity, fallbacks, dropped }
}

/**
 * 本镜参考图 id 列表（collectRefSelection 的薄封装，保持既有探针断言可直接消费）
 * totalLimit 透传给主函数：缺省即宿主总量，收紧时与出图入队同一口径（两者不得各算一套）
 */
export function collectRefAssetIds(
  shot: RefShot,
  indexes: Parameters<typeof collectRefSelection>[1],
  refIndex?: Map<number, EntityRefRow[]>,
  stateCtx?: { episode?: number },
  totalLimit?: number,
): number[] {
  return collectRefSelection(shot, indexes, refIndex, stateCtx, totalLimit ?? MAX_REFS_PER_SHOT).ids
}

/** 参考图 id 合并（上传参考前置→ 实体/画布参考，保序去重，总量 ≤limit） */
export function mergeRefIds(primary: number[], secondary: number[], limit: number = MAX_REFS_PER_SHOT): number[] {
  const ids: number[] = []
  const seen = new Set<number>()
  for (const id of [...primary, ...secondary]) {
    if (!seen.has(id)) { seen.add(id); ids.push(id) }
  }
  return ids.slice(0, limit)
}
