/**
 * [M18/M22] 画布节点分组服务（spec §2.6⑩ + M22 §2.4 组嵌套）：
 * - createGroup：nodeIds（≥1，须属本画布且无既有归属）+ groupIds（顶层子组，已嵌套拒绝）+ parentId（可选父组），
 *   nodeIds/groupIds 至少一非空 → 建组 + 赋节点 groupId / 子组 parentId + 锚点=节点包围盒左上（纯组时取子组锚点）；
 * - updateGroup：title / color / collapsed / x / y / parentId（移组：null=提升顶层；自环/后代环 → 400 group_cycle）局部改；
 * - deleteGroup：解组（成员 groupId=null + 子组 parentId=null 提升）+ 删组行。
 * 组不参与 copy（copy 出节点 groupId=null）；删节点不删组（空组保留）。
 * 每次变更 touchCanvas 更新画布时间戳 + emit canvas.changed 驱动前端对账。
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { canvasGroups, canvasNodes, canvases, type CanvasGroup } from '../../db/schema'
import { emitStudioEvent } from '../events'

/** 组操作错误（路由映射 400；detail 附违规节点 id 清单） */
export class GroupError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message)
    this.name = 'GroupError'
  }
}

/** UI 色 token 白名单（null=默认色；非白名单色回退 null 防注入） */
const GROUP_COLORS = new Set([
  'red', 'orange', 'amber', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray',
])

export interface CreateGroupInput {
  nodeIds?: unknown
  /** [M22] 顶层子组集合（至少与 nodeIds 一非空；已嵌套组拒绝 group_already_nested） */
  groupIds?: unknown
  /** [M22] 可选父组（须属本画布；新组嵌套其下） */
  parentId?: unknown
  title?: unknown
  color?: unknown
}

export interface UpdateGroupPatch {
  title?: unknown
  color?: unknown
  collapsed?: unknown
  x?: unknown
  y?: unknown
  /** [M22] 移组：null=提升顶层；数字=移入目标组（自环/后代环 → group_cycle） */
  parentId?: unknown
}

/** 建组：校验归属（节点+子组+父组）→ 锚点（节点包围盒左上 / 纯组取子组锚点）→ 插组（parentId）→ 批量赋属 */
export async function createGroup(canvasId: number, input: CreateGroupInput): Promise<CanvasGroup> {
  // [M22] nodeIds 可选（与 groupIds 至少一非空）；给空数组仍视为非法
  const rawIds = input.nodeIds
  const hasNodeIds = rawIds !== undefined && rawIds !== null
  if (hasNodeIds && (!Array.isArray(rawIds) || rawIds.length === 0)) {
    throw new GroupError('bad_node_ids', 'nodeIds 需为非空数组（至少 1 个节点）')
  }
  const ids = hasNodeIds ? [...new Set((rawIds as unknown[]).map(Number))] : []
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new GroupError('bad_node_ids', 'nodeIds 需为正整数数组')
  }
  // [M22] 子组集合：仅顶层组（parent_id IS NULL）可被装入
  const rawGids = input.groupIds
  const hasGroupIds = rawGids !== undefined && rawGids !== null
  if (hasGroupIds && (!Array.isArray(rawGids) || rawGids.length === 0)) {
    throw new GroupError('bad_group_ids', 'groupIds 需为非空数组（至少 1 个子组）')
  }
  const gids = hasGroupIds ? [...new Set((rawGids as unknown[]).map(Number))] : []
  if (gids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new GroupError('bad_group_ids', 'groupIds 需为正整数数组')
  }
  if (ids.length === 0 && gids.length === 0) {
    throw new GroupError('bad_node_ids', 'nodeIds 与 groupIds 至少一非空（新组需直接成员）')
  }
  // [M22] 父组（可选）：须属本画布
  let parentId: number | null = null
  if (input.parentId !== undefined && input.parentId !== null) {
    const pid = Number(input.parentId)
    if (!Number.isInteger(pid) || pid <= 0) throw new GroupError('bad_parent_id', 'parentId 需为正整数或 null')
    const [parent] = await db
      .select({ id: canvasGroups.id })
      .from(canvasGroups)
      .where(and(eq(canvasGroups.id, pid), eq(canvasGroups.canvasId, canvasId)))
      .limit(1)
    if (!parent) throw new GroupError('group_not_in_canvas', `父分组不属于该画布或不存在：${pid}`)
    parentId = pid
  }
  const rows = ids.length
    ? await db
        .select()
        .from(canvasNodes)
        .where(and(eq(canvasNodes.canvasId, canvasId), inArray(canvasNodes.id, ids)))
    : []
  const found = new Set(rows.map((r) => r.id))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new GroupError('node_not_in_canvas', `节点不属于该画布或不存在：${missing.join(', ')}`, { nodeIds: missing })
  }
  const already = rows.filter((r) => r.groupId != null).map((r) => r.id)
  if (already.length > 0) {
    throw new GroupError('already_grouped', `节点已在分组中，不能重复成组：${already.join(', ')}`, { nodeIds: already })
  }
  const childRows = gids.length
    ? await db
        .select()
        .from(canvasGroups)
        .where(and(eq(canvasGroups.canvasId, canvasId), inArray(canvasGroups.id, gids)))
    : []
  const foundG = new Set(childRows.map((r) => r.id))
  const missingG = gids.filter((id) => !foundG.has(id))
  if (missingG.length > 0) {
    throw new GroupError('group_not_in_canvas', `分组不属于该画布或不存在：${missingG.join(', ')}`, { groupIds: missingG })
  }
  const nested = childRows.filter((r) => r.parentId != null).map((r) => r.id)
  if (nested.length > 0) {
    throw new GroupError('group_already_nested', `分组已嵌套在其它组内，不能重复装入：${nested.join(', ')}`, { groupIds: nested })
  }
  // 锚点：含节点成员 → 包围盒左上；纯组 → 子组锚点最小值
  const minX = rows.length > 0 ? Math.min(...rows.map((r) => r.x)) : Math.min(...childRows.map((r) => r.x))
  const minY = rows.length > 0 ? Math.min(...rows.map((r) => r.y)) : Math.min(...childRows.map((r) => r.y))
  const now = Date.now()
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '未命名分组'
  const [group] = await db
    .insert(canvasGroups)
    .values({ canvasId, title, color: normalizeColor(input.color), collapsed: 0, x: minX, y: minY, parentId, createdAt: now })
    .returning()
  if (ids.length > 0) await db.update(canvasNodes).set({ groupId: group!.id, updatedAt: now }).where(inArray(canvasNodes.id, ids))
  if (gids.length > 0) await db.update(canvasGroups).set({ parentId: group!.id }).where(inArray(canvasGroups.id, gids))
  await touchCanvas(canvasId)
  return group!
}

/** 改组（局部）：组不属本画布 → null（路由 404） */
export async function updateGroup(canvasId: number, gid: number, patch: UpdateGroupPatch): Promise<CanvasGroup | null> {
  const [cur] = await db
    .select()
    .from(canvasGroups)
    .where(and(eq(canvasGroups.id, gid), eq(canvasGroups.canvasId, canvasId)))
    .limit(1)
  if (!cur) return null
  const set: Record<string, unknown> = {}
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || !patch.title.trim()) throw new GroupError('bad_title', 'title 需为非空字符串')
    set.title = patch.title.trim()
  }
  if (patch.color !== undefined) set.color = normalizeColor(patch.color)
  if (patch.collapsed !== undefined) {
    set.collapsed = patch.collapsed === true || patch.collapsed === 1 || patch.collapsed === 'true' ? 1 : 0
  }
  if (patch.x !== undefined) {
    if (typeof patch.x !== 'number' || !Number.isFinite(patch.x)) throw new GroupError('bad_x', 'x 需为数字')
    set.x = patch.x
  }
  if (patch.y !== undefined) {
    if (typeof patch.y !== 'number' || !Number.isFinite(patch.y)) throw new GroupError('bad_y', 'y 需为数字')
    set.y = patch.y
  }
  // [M22] 移组：null=提升顶层；数字=移入目标组（同画布、非自身、非自身后代）
  if (patch.parentId !== undefined) {
    const raw = patch.parentId
    if (raw === null) {
      set.parentId = null
    } else {
      const pid = Number(raw)
      if (!Number.isInteger(pid) || pid <= 0) throw new GroupError('bad_parent_id', 'parentId 需为正整数或 null')
      if (pid === gid) throw new GroupError('group_cycle', '不能把组移入自身（会形成环）')
      const [target] = await db
        .select()
        .from(canvasGroups)
        .where(and(eq(canvasGroups.id, pid), eq(canvasGroups.canvasId, canvasId)))
        .limit(1)
      if (!target) throw new GroupError('group_not_in_canvas', `目标分组不属于该画布或不存在：${pid}`)
      // 防环：沿目标 parent 链上溯，遇 gid（=目标在自身后代链上）→ 拒绝
      let cursor: number | null = target.parentId
      let guard = 0
      while (cursor != null && guard < 1000) {
        if (cursor === gid) throw new GroupError('group_cycle', '不能把组移入自己的后代（会形成环）')
        const [up] = await db
          .select({ parentId: canvasGroups.parentId })
          .from(canvasGroups)
          .where(eq(canvasGroups.id, cursor))
          .limit(1)
        cursor = up ? up.parentId : null
        guard += 1
      }
      set.parentId = pid
    }
  }
  if (Object.keys(set).length === 0) return cur
  const [row] = await db.update(canvasGroups).set(set).where(eq(canvasGroups.id, gid)).returning()
  await touchCanvas(canvasId)
  return row ?? null
}

/** 解组：成员 groupId=null + [M22] 子组 parentId=null 提升顶层 + 删组行；组不属本画布 → false（路由 404） */
export async function deleteGroup(canvasId: number, gid: number): Promise<boolean> {
  const [cur] = await db
    .select()
    .from(canvasGroups)
    .where(and(eq(canvasGroups.id, gid), eq(canvasGroups.canvasId, canvasId)))
    .limit(1)
  if (!cur) return false
  const now = Date.now()
  await db.update(canvasNodes).set({ groupId: null, updatedAt: now }).where(eq(canvasNodes.groupId, gid))
  // [M22] 保守提升：子组不随删（与「删节点不删组」哲学一致，不丢组）
  await db.update(canvasGroups).set({ parentId: null }).where(eq(canvasGroups.parentId, gid))
  await db.delete(canvasGroups).where(eq(canvasGroups.id, gid))
  await touchCanvas(canvasId)
  return true
}

/** 色 token 归一：非白名单/空 → null（默认色） */
function normalizeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  return GROUP_COLORS.has(s) ? s : null
}

/** 变更画布时间戳 + 广播（组操作后统一调用） */
async function touchCanvas(canvasId: number): Promise<void> {
  const now = Date.now()
  const [row] = await db.update(canvases).set({ updatedAt: now }).where(eq(canvases.id, canvasId)).returning()
  if (row) emitStudioEvent({ type: 'canvas.changed', canvasId, projectId: row.projectId })
}
