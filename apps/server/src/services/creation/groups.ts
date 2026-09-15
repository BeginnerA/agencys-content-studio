/**
 * [M18] 画布节点分组服务（spec §2.6⑩）：
 * - createGroup：≥1 节点、须属本画布、成员不得已有组归属（违规 400 列出）→ 建组 + 赋 groupId + 锚点=成员包围盒左上；
 * - updateGroup：title / color / collapsed / x / y 局部改；
 * - deleteGroup：解组（成员 groupId=null）+ 删组行。
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
  nodeIds: unknown
  title?: unknown
  color?: unknown
}

export interface UpdateGroupPatch {
  title?: unknown
  color?: unknown
  collapsed?: unknown
  x?: unknown
  y?: unknown
}

/** 建组：校验成员归属 → 包围盒左上锚点 → 插组 → 批量赋 groupId */
export async function createGroup(canvasId: number, input: CreateGroupInput): Promise<CanvasGroup> {
  const rawIds = input.nodeIds
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new GroupError('bad_node_ids', 'nodeIds 需为非空数组（至少 1 个节点）')
  }
  const ids = [...new Set(rawIds.map(Number))]
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new GroupError('bad_node_ids', 'nodeIds 需为正整数数组')
  }
  const rows = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), inArray(canvasNodes.id, ids)))
  const found = new Set(rows.map((r) => r.id))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new GroupError('node_not_in_canvas', `节点不属于该画布或不存在：${missing.join(', ')}`, { nodeIds: missing })
  }
  const already = rows.filter((r) => r.groupId != null).map((r) => r.id)
  if (already.length > 0) {
    throw new GroupError('already_grouped', `节点已在分组中，不能重复成组：${already.join(', ')}`, { nodeIds: already })
  }
  const minX = Math.min(...rows.map((r) => r.x))
  const minY = Math.min(...rows.map((r) => r.y))
  const now = Date.now()
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '未命名分组'
  const [group] = await db
    .insert(canvasGroups)
    .values({ canvasId, title, color: normalizeColor(input.color), collapsed: 0, x: minX, y: minY, createdAt: now })
    .returning()
  await db.update(canvasNodes).set({ groupId: group!.id, updatedAt: now }).where(inArray(canvasNodes.id, ids))
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
  if (Object.keys(set).length === 0) return cur
  const [row] = await db.update(canvasGroups).set(set).where(eq(canvasGroups.id, gid)).returning()
  await touchCanvas(canvasId)
  return row ?? null
}

/** 解组：成员 groupId=null + 删组行；组不属本画布 → false（路由 404） */
export async function deleteGroup(canvasId: number, gid: number): Promise<boolean> {
  const [cur] = await db
    .select()
    .from(canvasGroups)
    .where(and(eq(canvasGroups.id, gid), eq(canvasGroups.canvasId, canvasId)))
    .limit(1)
  if (!cur) return false
  const now = Date.now()
  await db.update(canvasNodes).set({ groupId: null, updatedAt: now }).where(eq(canvasNodes.groupId, gid))
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
