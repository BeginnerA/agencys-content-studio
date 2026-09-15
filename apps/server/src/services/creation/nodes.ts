// [M28·批1a] 自 services/creation.ts 拆分：节点 CRUD/校验/快照重建认领 + 坐标解析。
import { and, eq, or } from 'drizzle-orm'
import { db } from '../../db'
import { canvasEdges, canvasNodes, characters, genTasks, pipelineRuns } from '../../db/schema'
import type { Canvas, CanvasNode } from '../../db/schema'
import { assertProjectAssets } from '../../pipeline/refs'
import { findCanvas } from './canvas'
import { parseEntitySpec, parseNodeSpec, parseRunSpec, parseTextSpec } from './spec'

// ---------- 节点 CRUD ----------

export async function findNode(id: number): Promise<CanvasNode | null> {
  const rows = await db.select().from(canvasNodes).where(eq(canvasNodes.id, id)).limit(1)
  return rows[0] ?? null
}

/** 素材节点：assetId 须存在且属画布项目域（assertProjectAssets） */
export async function addAssetNode(
  canvas: Canvas,
  assetId: unknown,
  x: unknown,
  y: unknown,
  title?: unknown,
): Promise<CanvasNode> {
  const num = Number(assetId)
  if (!Number.isInteger(num) || num <= 0) throw new Error('assetId 需为正整数')
  await assertProjectAssets(canvas.projectId, [num], 'assetId')
  const pos = parsePos(x, y)
  const now = Date.now()
  const [row] = await db
    .insert(canvasNodes)
    .values({
      canvasId: canvas.id,
      kind: 'asset',
      assetId: num,
      title: typeof title === 'string' && title.trim() ? title.trim() : null,
      x: pos.x,
      y: pos.y,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row!
}

export async function addGenNode(
  canvas: Canvas,
  spec: unknown,
  x: unknown,
  y: unknown,
  title?: unknown,
): Promise<CanvasNode> {
  const parsed = parseNodeSpec(spec) // 非法 → 抛（400）
  const pos = parsePos(x, y)
  const now = Date.now()
  const [row] = await db
    .insert(canvasNodes)
    .values({
      canvasId: canvas.id,
      kind: 'gen',
      spec: JSON.stringify(parsed),
      title: typeof title === 'string' && title.trim() ? title.trim() : null,
      x: pos.x,
      y: pos.y,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row!
}

/** [M17] 文本节点：spec { text }（空文本属 readiness 语义） */
export async function addTextNode(
  canvas: Canvas,
  spec: unknown,
  x: unknown,
  y: unknown,
  title?: unknown,
): Promise<CanvasNode> {
  const parsed = parseTextSpec(spec) // 非法 → 抛（400）
  const pos = parsePos(x, y)
  const now = Date.now()
  const [row] = await db
    .insert(canvasNodes)
    .values({
      canvasId: canvas.id,
      kind: 'text',
      spec: JSON.stringify(parsed),
      title: typeof title === 'string' && title.trim() ? title.trim() : null,
      x: pos.x,
      y: pos.y,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row!
}

/** [M17] 实体节点：entityId 须存在且属同项目或全局（project_id NULL） */
export async function addEntityNode(
  canvas: Canvas,
  entityId: unknown,
  x: unknown,
  y: unknown,
  title?: unknown,
): Promise<CanvasNode> {
  const parsed = parseEntitySpec({ entityId })
  const rows = await db.select().from(characters).where(eq(characters.id, parsed.entityId)).limit(1)
  const ent = rows[0]
  if (!ent) throw new Error(`实体 ${parsed.entityId} 不存在`)
  if (ent.projectId !== null && ent.projectId !== canvas.projectId) throw new Error('实体不属于该项目（全局实体库除外）')
  const pos = parsePos(x, y)
  const now = Date.now()
  const [row] = await db
    .insert(canvasNodes)
    .values({
      canvasId: canvas.id,
      kind: 'entity',
      spec: JSON.stringify(parsed),
      title: typeof title === 'string' && title.trim() ? title.trim() : ent.name,
      x: pos.x,
      y: pos.y,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row!
}

/** [M17] 运行节点：runId 须存在且属同项目 */
export async function addRunNode(
  canvas: Canvas,
  runId: unknown,
  x: unknown,
  y: unknown,
  title?: unknown,
): Promise<CanvasNode> {
  const parsed = parseRunSpec({ runId })
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, parsed.runId)).limit(1)
  const run = rows[0]
  if (!run) throw new Error(`运行 ${parsed.runId} 不存在`)
  if (run.projectId !== canvas.projectId) throw new Error('运行不属于该项目')
  const pos = parsePos(x, y)
  const now = Date.now()
  const [row] = await db
    .insert(canvasNodes)
    .values({
      canvasId: canvas.id,
      kind: 'run',
      spec: JSON.stringify(parsed),
      title: typeof title === 'string' && title.trim() ? title.trim() : `运行 #${parsed.runId}`,
      x: pos.x,
      y: pos.y,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row!
}

export interface NodePatch {
  x?: unknown
  y?: unknown
  title?: unknown
  spec?: unknown
  seq?: unknown
  adoptedTaskId?: unknown
}

/**
 * [M17] PATCH 校验核心（updateNode 与 batchNodes 共用，保证同文案同语义）：
 * 校验 patch 合法性并返回待更新字段集（不含写库）。
 */
export async function validateNodePatch(cur: CanvasNode, patch: NodePatch): Promise<Record<string, unknown>> {
  const set: Record<string, unknown> = { updatedAt: Date.now() }
  if (patch.x !== undefined || patch.y !== undefined) {
    const x = patch.x === undefined ? cur.x : patch.x
    const y = patch.y === undefined ? cur.y : patch.y
    const pos = parsePos(x, y)
    set['x'] = pos.x
    set['y'] = pos.y
  }
  if (patch.title !== undefined) {
    if (patch.title === null || patch.title === '') set['title'] = null
    else if (typeof patch.title !== 'string') throw new Error('title 需为字符串或 null')
    else set['title'] = patch.title.trim()
  }
  if (patch.spec !== undefined) {
    if (cur.kind === 'gen') set['spec'] = JSON.stringify(parseNodeSpec(patch.spec))
    else if (cur.kind === 'text') set['spec'] = JSON.stringify(parseTextSpec(patch.spec))
    else throw new Error('该节点类型不可改 spec（gen/text 可改）')
  }
  // [M17] 故事板序号：null 清除 / 正整数（1 起）
  if (patch.seq !== undefined) {
    if (patch.seq === null) set['seq'] = null
    else {
      const n = Number(patch.seq)
      if (!Number.isInteger(n) || n <= 0) throw new Error('seq 需为 null 或正整数')
      set['seq'] = n
    }
  }
  // [M17] 结果采纳：null 清除 / 校验（属本节点 + succeeded + 有产物）
  if (patch.adoptedTaskId !== undefined) {
    if (cur.kind !== 'gen') throw new Error('仅生成节点支持采纳结果')
    if (patch.adoptedTaskId === null) {
      set['adoptedTaskId'] = null
    } else {
      const tid = Number(patch.adoptedTaskId)
      if (!Number.isInteger(tid) || tid <= 0) throw new Error('adoptedTaskId 需为 null 或正整数')
      const rows = await db
        .select()
        .from(genTasks)
        .where(and(eq(genTasks.id, tid), eq(genTasks.canvasNodeId, cur.id)))
        .limit(1)
      const t = rows[0]
      if (!t) throw new Error('采纳任务不存在或不属于该节点')
      if (t.status !== 'succeeded' || t.resultAssetId == null) throw new Error('仅可采纳有成功产物的任务')
      set['adoptedTaskId'] = tid
    }
  }
  return set
}

export async function updateNode(id: number, patch: NodePatch): Promise<CanvasNode | null> {
  const cur = await findNode(id)
  if (!cur) return null
  const set = await validateNodePatch(cur, patch)
  const [row] = await db.update(canvasNodes).set(set).where(eq(canvasNodes.id, id)).returning()
  return row ?? null
}

/** 删节点：级联删其全部连线（同画布内 from 或 to 命中） */
export async function deleteNode(id: number): Promise<boolean> {
  const cur = await findNode(id)
  if (!cur) return false
  await db
    .delete(canvasEdges)
    .where(and(eq(canvasEdges.canvasId, cur.canvasId), or(eq(canvasEdges.from, id), eq(canvasEdges.to, id))))
  await db.delete(canvasNodes).where(eq(canvasNodes.id, id))
  return true
}

/**
 * [M17] 快照重建认领-源校验：restoreFromNodeId 为正整数且源节点已不存在。
 * 路由在建节点前前置调用——失败即抛，避免产生「节点已建但认领失败」的残留；与 claimNodeTasks 同文案同语义。
 */
export async function assertRestorableSource(rawFrom: unknown): Promise<number> {
  const from = Number(rawFrom)
  if (!Number.isInteger(from) || from <= 0) throw new Error('restoreFromNodeId 需为正整数')
  const alive = await db.select({ id: canvasNodes.id }).from(canvasNodes).where(eq(canvasNodes.id, from)).limit(1)
  if (alive[0]) throw new Error('restoreFromNodeId 对应节点仍存在，禁止转移任务历史')
  return from
}

/**
 * [M17] 快照重建：认领已删节点的任务历史（gen_tasks.canvas_node_id 旧 → 新，同项目域）。
 * 撤销删除时重建 gen 节点后调用——任务归属随重建迁移，使画廊/采纳/下游引用完整恢复；
 * 否则 adoptedTaskId 的 PATCH 校验（任务须属本节点）必然失败。
 * 校验：目标须为 gen（任务仅归属 gen 节点）；源节点须已不存在（禁止转移存活节点任务）。
 */
export async function claimNodeTasks(canvas: Canvas, node: CanvasNode, rawFrom: unknown): Promise<number> {
  const from = await assertRestorableSource(rawFrom)
  if (from === node.id) throw new Error('restoreFromNodeId 不能指向节点自身')
  if (node.kind !== 'gen') throw new Error('仅生成节点可认领任务历史')
  const rows = await db
    .update(genTasks)
    .set({ canvasNodeId: node.id })
    .where(and(eq(genTasks.canvasNodeId, from), eq(genTasks.projectId, canvas.projectId)))
    .returning({ id: genTasks.id })
  return rows.length
}

/** 画布归属查询（执行通道用）：节点 → 画布 */
export async function canvasOfNode(nodeId: number): Promise<Canvas | null> {
  const node = await findNode(nodeId)
  if (!node) return null
  return findCanvas(node.canvasId)
}

export function parsePos(x: unknown, y: unknown): { x: number; y: number } {
  const nx = Number(x)
  const ny = Number(y)
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error('坐标 x/y 需为数字')
  return { x: nx, y: ny }
}
