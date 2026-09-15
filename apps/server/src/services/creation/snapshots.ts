// [M28·批1a] 自 services/creation.ts 拆分：文档快照（创建/列表/删除/恢复，保留 id 重放）。
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { canvasEdges, canvasGroups, canvasNodes, canvasSnapshots } from '../../db/schema'
import type { CanvasSnapshot } from '../../db/schema'
import { emitStudioEvent } from '../events'
import { findCanvas } from './canvas'

// ---------- [M18] 文档快照（保留 id 重放） ----------

/** [M18] 每画布快照上限（手动创建满额 → 400 提示清理；恢复前自动备份满额 → 驱逐最旧） */
export const SNAPSHOT_LIMIT = 20

/** [M18] 快照文档形态（全量行 JSON；id 保留用于重放——adoptedTaskId→gen_tasks.canvasNodeId 不孤儿） */
export interface CanvasSnapshotDoc {
  nodes: Array<typeof canvasNodes.$inferSelect>
  edges: Array<typeof canvasEdges.$inferSelect>
  groups: Array<typeof canvasGroups.$inferSelect>
}

/** [M18] 快照元信息（列表；不含 doc 全文） */
export interface CanvasSnapshotMeta {
  id: number
  label: string
  nodeCount: number
  edgeCount: number
  groupCount: number
  createdAt: number
}

/** [M18] 恢复冲突（快照行 id 被他画布占用；路由层映射 409） */
export class SnapshotConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotConflictError'
  }
}

/** [M18] 恢复结果（backupSnapshotId = 恢复前自动备份；restored = 重放行数） */
export interface SnapshotRestoreResult {
  backupSnapshotId: number
  restored: { nodes: number; edges: number; groups: number }
}

/** 数组分块（SQLite 变量数上限保护） */
function chunkIds(ids: number[], size = 500): number[][] {
  const out: number[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/** [M18] 采集当前文档全量行 */
async function collectSnapshotDoc(canvasId: number): Promise<CanvasSnapshotDoc> {
  const [nodes, edges, groups] = await Promise.all([
    db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, canvasId)).orderBy(asc(canvasNodes.id)),
    db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, canvasId)).orderBy(asc(canvasEdges.id)),
    db.select().from(canvasGroups).where(eq(canvasGroups.canvasId, canvasId)).orderBy(asc(canvasGroups.id)),
  ])
  return { nodes, edges, groups }
}

/**
 * [M18] 创建快照：label 缺省「快照 N」；auto=true 为恢复前自动备份（满额驱逐最旧腾位，不阻断恢复）
 */
export async function createSnapshot(canvasId: number, label: unknown, opts?: { auto?: boolean }): Promise<CanvasSnapshot> {
  const canvas = await findCanvas(canvasId)
  if (!canvas) throw new Error(`画布 ${canvasId} 不存在`)
  const existing = await db
    .select({ id: canvasSnapshots.id })
    .from(canvasSnapshots)
    .where(eq(canvasSnapshots.canvasId, canvasId))
    .orderBy(asc(canvasSnapshots.createdAt), asc(canvasSnapshots.id))
  if (existing.length >= SNAPSHOT_LIMIT) {
    if (!opts?.auto) throw new Error(`快照已达上限（${SNAPSHOT_LIMIT}），请先删除旧快照`)
    const evict = existing.slice(0, existing.length - SNAPSHOT_LIMIT + 1)
    await db.delete(canvasSnapshots).where(inArray(canvasSnapshots.id, evict.map((r) => r.id)))
  }
  const name = typeof label === 'string' && label.trim() ? label.trim() : `快照 ${existing.length + 1}`
  const doc = await collectSnapshotDoc(canvasId)
  const [row] = await db
    .insert(canvasSnapshots)
    .values({ canvasId, label: name, doc: JSON.stringify(doc), createdAt: Date.now() })
    .returning()
  return row!
}

/** [M18] 快照列表（新→旧；含行数统计，不含 doc；画布不存在 → null） */
export async function listSnapshots(canvasId: number): Promise<CanvasSnapshotMeta[] | null> {
  const canvas = await findCanvas(canvasId)
  if (!canvas) return null
  const rows = await db
    .select()
    .from(canvasSnapshots)
    .where(eq(canvasSnapshots.canvasId, canvasId))
    .orderBy(desc(canvasSnapshots.createdAt), desc(canvasSnapshots.id))
  return rows.map((r) => {
    const doc = JSON.parse(r.doc) as CanvasSnapshotDoc
    return {
      id: r.id,
      label: r.label,
      nodeCount: doc.nodes.length,
      edgeCount: doc.edges.length,
      groupCount: doc.groups.length,
      createdAt: r.createdAt,
    }
  })
}

/** [M18] 删除快照（画布域限定；不存在/不属本画布 → false） */
export async function deleteSnapshot(canvasId: number, snapshotId: number): Promise<boolean> {
  const rows = await db
    .select({ id: canvasSnapshots.id })
    .from(canvasSnapshots)
    .where(and(eq(canvasSnapshots.id, snapshotId), eq(canvasSnapshots.canvasId, canvasId)))
    .limit(1)
  if (!rows[0]) return false
  await db.delete(canvasSnapshots).where(eq(canvasSnapshots.id, snapshotId))
  return true
}

/**
 * [M18] 快照恢复（保留 id 重放，spec §2.1）：
 * ①事务内先冲突预检（快照行 id 被他画布占用 → 回滚 + 409）→ ②自动备份「恢复前备份」→
 * ③清空现 nodes/edges/groups → ④按快照 doc 显式保留原 id 重插 → ⑤ emitCanvasChanged。
 * 画布/快照不存在 → null（路由 404）；行数极少场景下 id 占用仅可能来自显式建行，仍走事务回滚保护。
 */
export async function restoreSnapshot(canvasId: number, snapshotId: number): Promise<SnapshotRestoreResult | null> {
  const canvas = await findCanvas(canvasId)
  if (!canvas) return null
  const snapRows = await db
    .select()
    .from(canvasSnapshots)
    .where(and(eq(canvasSnapshots.id, snapshotId), eq(canvasSnapshots.canvasId, canvasId)))
    .limit(1)
  const snap = snapRows[0]
  if (!snap) return null
  const doc = JSON.parse(snap.doc) as CanvasSnapshotDoc

  // ① 自动备份（失败不阻断？——失败即中止：无备份不重放，保证可回退）
  const backup = await createSnapshot(canvasId, `恢复前备份（${snap.label}）`, { auto: true })

  const now = Date.now()
  await db.transaction(async (tx) => {
    // ② 冲突预检（事务内、清空前：看外部占用；本画布行即将被清空不构成冲突）
    const clashNode = doc.nodes.length
      ? (await Promise.all(chunkIds(doc.nodes.map((n) => n.id)).map((chunk) =>
          tx.select({ id: canvasNodes.id, canvasId: canvasNodes.canvasId }).from(canvasNodes).where(inArray(canvasNodes.id, chunk)),
        ))).flat().find((r) => r.canvasId !== canvasId)
      : undefined
    if (clashNode) throw new SnapshotConflictError(`快照恢复冲突：节点 #${clashNode.id} 已被其他画布占用（id 保留重放不可行）`)
    const clashEdge = doc.edges.length
      ? (await Promise.all(chunkIds(doc.edges.map((e) => e.id)).map((chunk) =>
          tx.select({ id: canvasEdges.id, canvasId: canvasEdges.canvasId }).from(canvasEdges).where(inArray(canvasEdges.id, chunk)),
        ))).flat().find((r) => r.canvasId !== canvasId)
      : undefined
    if (clashEdge) throw new SnapshotConflictError(`快照恢复冲突：边 #${clashEdge.id} 已被其他画布占用（id 保留重放不可行）`)
    const clashGroup = doc.groups.length
      ? (await Promise.all(chunkIds(doc.groups.map((g) => g.id)).map((chunk) =>
          tx.select({ id: canvasGroups.id, canvasId: canvasGroups.canvasId }).from(canvasGroups).where(inArray(canvasGroups.id, chunk)),
        ))).flat().find((r) => r.canvasId !== canvasId)
      : undefined
    if (clashGroup) throw new SnapshotConflictError(`快照恢复冲突：分组 #${clashGroup.id} 已被其他画布占用（id 保留重放不可行）`)

    // ③ 清空现文档
    await tx.delete(canvasEdges).where(eq(canvasEdges.canvasId, canvasId))
    await tx.delete(canvasNodes).where(eq(canvasNodes.canvasId, canvasId))
    await tx.delete(canvasGroups).where(eq(canvasGroups.canvasId, canvasId))

    // ④ 重放（显式保留 id；分组先于节点）
    for (const g of doc.groups) {
      await tx.insert(canvasGroups).values({
        id: g.id,
        canvasId,
        title: g.title,
        color: g.color,
        collapsed: g.collapsed,
        x: g.x,
        y: g.y,
        createdAt: g.createdAt,
      })
    }
    for (const n of doc.nodes) {
      await tx.insert(canvasNodes).values({
        id: n.id,
        canvasId,
        kind: n.kind,
        assetId: n.assetId,
        title: n.title,
        spec: n.spec,
        x: n.x,
        y: n.y,
        adoptedTaskId: n.adoptedTaskId,
        seq: n.seq,
        groupId: n.groupId,
        createdAt: n.createdAt,
        updatedAt: now,
      })
    }
    for (const e of doc.edges) {
      await tx.insert(canvasEdges).values({ id: e.id, canvasId, from: e.from, to: e.to, port: e.port, createdAt: e.createdAt })
    }
  })

  emitStudioEvent({ type: 'canvas.changed', canvasId, projectId: canvas.projectId })
  return {
    backupSnapshotId: backup.id,
    restored: { nodes: doc.nodes.length, edges: doc.edges.length, groups: doc.groups.length },
  }
}
