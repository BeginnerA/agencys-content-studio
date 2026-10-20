import type { CharacterRow } from '../../db/schema'

/**
 * 参考图复用判定纯函数集（定妆照 / 场景 / 道具参考图「智能判断是否需要重新生成」的确定性依据）。
 * 与出图能力（provider refCap）解耦：复用只是把库内既有资产 id 透传为步产物，不涉及任何出图请求。
 * 全部为纯函数（零 DB / 零网络），供探针直接 import 断言。
 */

/** 实体索引集合（角色 / 场景 / 道具三库；与 ai_image 注入链同一 loadEntityIndex 源） */
type EntityIndexes = {
  characters: Map<string, CharacterRow>
  scenes: Map<string, CharacterRow>
  props: Map<string, CharacterRow>
}

/** 复用判定所需的镜头最小形（与 ShotSpec 结构兼容，纯函数只读这几项） */
type ReuseShot = {
  id: string
  characters?: string[]
  location?: string
  props?: string[]
  category?: string
}

/** 索引查询：原样 → 小写兜底（与 character 服务索引键一致） */
const lookupRow = (index: Map<string, CharacterRow>, name: string): CharacterRow | undefined =>
  index.get(name) ?? index.get(name.toLowerCase())

/** 实体行库内已有参考图首张 id（无行 / 无 refAssetIds → undefined） */
const firstExistingRef = (row: CharacterRow | undefined): number | undefined =>
  row ? parseNumArr(row.refAssetIds)[0] : undefined

/** JSON 数字数组列宽容解析：非数组/坏 JSON/非正整数 → 剔除 */
function parseNumArr(s: string): number[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}

/**
 * 定妆照身份锚定映射（纯函数）：
 * 参考图资产名（去末段扩展名 → trim → 小写）与镜头 id（角色名，同源归一）匹配；
 * 返回「镜头 id → 身份参考图资产 id」映射（命中才收录；同名多资产取首个）。
 */
export function buildIdentityRefMap(
  refAssets: Array<{ id: number; name: string }>,
  shots: Array<{ id: string }>,
): Map<string, number> {
  const byChar = new Map<string, number>()
  for (const a of refAssets) {
    const stem = a.name.replace(/\.[^.]+$/, '').trim().toLowerCase()
    if (stem && !byChar.has(stem)) byChar.set(stem, a.id)
  }
  const out = new Map<string, number>()
  for (const s of shots) {
    const id = byChar.get(String(s.id).trim().toLowerCase())
    if (id !== undefined) out.set(s.id, id)
  }
  return out
}

/**
 * 库内已有参考图复用映射（纯函数，auto 模式核心判定）：
 * 逐镜取「该镜头主实体在角色 / 场景 / 道具库内已有的首张参考图 asset id」：
 * - 有 characters（定妆照镜：characters=[角色名]）→ 角色库首名命中；
 * - category=scene → 场景库按 shot.id 命中；category=prop → 道具库按 shot.id 命中；
 * - 二者皆不中时回退：location→场景库、props 首项→道具库（分镜式镜头兜底）；
 * 仅取库内实体行 refAssetIds，**不含**画布 ref_asset_ids、不含 identity 上传图；
 * 无命中（新角色 / 库里无图）→ 不入表（该镜头照常生成）。返回「镜头 id → 可复用 asset id」。
 */
export function pickExistingRefs(
  shots: ReuseShot[],
  indexes: EntityIndexes,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const shot of shots) {
    const names = (Array.isArray(shot.characters) ? shot.characters : [])
      .filter((n): n is string => typeof n === 'string' && !!n.trim())
      .map((n) => n.trim())
    let id: number | undefined
    // 1) 定妆照：角色名命中角色库
    if (names.length > 0) id = firstExistingRef(lookupRow(indexes.characters, names[0]!))
    // 2) 场景/道具参考图：按 category 定向名称库（shot.id = 名称逐字）
    if (id === undefined && shot.category === 'scene') id = firstExistingRef(lookupRow(indexes.scenes, String(shot.id).trim()))
    if (id === undefined && shot.category === 'prop') id = firstExistingRef(lookupRow(indexes.props, String(shot.id).trim()))
    // 3) 分镜式兜底：location→场景库、props 首项→道具库
    if (id === undefined) {
      const loc = typeof shot.location === 'string' ? shot.location.trim() : ''
      if (loc) id = firstExistingRef(lookupRow(indexes.scenes, loc))
    }
    if (id === undefined) {
      for (const raw of shot.props ?? []) {
        if (typeof raw !== 'string' || !raw.trim()) continue
        id = firstExistingRef(lookupRow(indexes.props, raw.trim()))
        if (id !== undefined) break
      }
    }
    if (id !== undefined) out.set(shot.id, id)
  }
  return out
}
