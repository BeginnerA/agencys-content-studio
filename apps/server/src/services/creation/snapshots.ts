// [M28·批1a] 自 services/creation.ts 拆分：文档快照（创建/列表/删除/恢复，保留 id 重放）。
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { canvasEdges, canvasGroups, canvasNodes, canvasSnapshots, canvases } from '../../db/schema'
import type { Canvas, CanvasSnapshot } from '../../db/schema'
import { emitStudioEvent } from '../events'
import { findCanvas } from './canvas'
import { diffSnapshotDocs, type SnapshotDiff } from './snapshot-diff'

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

/** [M18/M22] 采集当前文档全量行（diff 端点取 live 文档复用；快照重建重放语义靠调用侧） */
export async function collectSnapshotDoc(canvasId: number): Promise<CanvasSnapshotDoc> {
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

    // ④ 重放（显式保留 id；分组先于节点；[M22] parentId 保留重放——旧快照无字段容错）
    for (const g of doc.groups) {
      await tx.insert(canvasGroups).values({
        id: g.id,
        canvasId,
        title: g.title,
        color: g.color,
        collapsed: g.collapsed,
        x: g.x,
        y: g.y,
        parentId: g.parentId ?? null,
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

// ---------- [M22] 快照 diff / 分支（spec §2.5） ----------

/** 快照行读取（画布域限定；不存在/不属本画布 → null） */
async function readSnapshotRow(canvasId: number, snapshotId: number): Promise<CanvasSnapshot | null> {
  const rows = await db
    .select()
    .from(canvasSnapshots)
    .where(and(eq(canvasSnapshots.id, snapshotId), eq(canvasSnapshots.canvasId, canvasId)))
    .limit(1)
  return rows[0] ?? null
}

/** [M22] diff 端点响应形状（base=基准快照；target=live 或另一快照；diff 三桶展开） */
export interface SnapshotDiffResult {
  base: { kind: 'snapshot'; id: number; label: string }
  target: { kind: 'snapshot'; id: number; label: string } | { kind: 'live' }
  summary: SnapshotDiff['summary']
  nodes: SnapshotDiff['nodes']
  edges: SnapshotDiff['edges']
  groups: SnapshotDiff['groups']
}

/**
 * [M22] 快照对比：against 缺省/='live'（快照 ↔ 当前文档），或另一快照 sid 字符串。
 * sid / sid2 须属本画布（否则 null → 路由 404）。
 */
export async function diffSnapshotAgainst(canvasId: number, snapshotId: number, against: string): Promise<SnapshotDiffResult | null> {
  const canvas = await findCanvas(canvasId)
  if (!canvas) return null
  const baseSnap = await readSnapshotRow(canvasId, snapshotId)
  if (!baseSnap) return null
  const baseDoc = JSON.parse(baseSnap.doc) as CanvasSnapshotDoc
  const base = { kind: 'snapshot' as const, id: baseSnap.id, label: baseSnap.label }
  const a = (against ?? '').trim()
  if (a === '' || a === 'live') {
    const diff = diffSnapshotDocs(baseDoc, await collectSnapshotDoc(canvasId))
    return { base, target: { kind: 'live' }, ...diff }
  }
  const sid2 = Number(a)
  const targetSnap = Number.isInteger(sid2) && sid2 > 0 ? await readSnapshotRow(canvasId, sid2) : null
  if (!targetSnap) return null
  const diff = diffSnapshotDocs(baseDoc, JSON.parse(targetSnap.doc) as CanvasSnapshotDoc)
  return { base, target: { kind: 'snapshot', id: targetSnap.id, label: targetSnap.label }, ...diff }
}

/**
 * [M22] 分支为新画布：单事务内新 id 重放（groups 先插 parentId 回填 → nodes groupId 映射 → edges 端点映射）。
 * 与 restoreSnapshot（保留 id）不同：全新画布空间无 id 冲突（duplicateCanvas 深拷哲学）；name 缺省「{源画布名} 分支」。
 */
export async function branchSnapshot(canvasId: number, snapshotId: number, name?: unknown): Promise<Canvas | null> {
  const canvas = await findCanvas(canvasId)
  if (!canvas) return null
  const snap = await readSnapshotRow(canvasId, snapshotId)
  if (!snap) return null
  const doc = JSON.parse(snap.doc) as CanvasSnapshotDoc
  const now = Date.now()
  const label = typeof name === 'string' && name.trim() ? name.trim() : `${canvas.name} 分支`
  const newId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(canvases)
      .values({ projectId: canvas.projectId, name: label, viewport: canvas.viewport, createdAt: now, updatedAt: now })
      .returning({ id: canvases.id })
    const cid = created!.id
    // 组：先插（parentId 暂 null）记录旧→新映射，再回填（单遍插入时父映射可能未知）
    const gidMap = new Map<number, number>()
    for (const g of doc.groups) {
      const [row] = await tx
        .insert(canvasGroups)
        .values({ canvasId: cid, title: g.title, color: g.color, collapsed: g.collapsed, x: g.x, y: g.y, parentId: null, createdAt: g.createdAt })
        .returning({ id: canvasGroups.id })
      gidMap.set(g.id, row!.id)
    }
    for (const g of doc.groups) {
      if (g.parentId == null) continue
      const pid = gidMap.get(g.parentId)
      if (pid == null) continue
      await tx.update(canvasGroups).set({ parentId: pid }).where(eq(canvasGroups.id, gidMap.get(g.id)!))
    }
    // 节点：group_id 经映射；assetId/spec/adoptedTaskId/seq 原样
    const nidMap = new Map<number, number>()
    for (const n of doc.nodes) {
      const [row] = await tx
        .insert(canvasNodes)
        .values({
          canvasId: cid,
          kind: n.kind,
          assetId: n.assetId,
          title: n.title,
          spec: n.spec,
          x: n.x,
          y: n.y,
          adoptedTaskId: n.adoptedTaskId,
          seq: n.seq,
          groupId: n.groupId != null ? (gidMap.get(n.groupId) ?? null) : null,
          createdAt: n.createdAt,
          updatedAt: now,
        })
        .returning({ id: canvasNodes.id })
      nidMap.set(n.id, row!.id)
    }
    // 边：from/to 经映射（端点悬空跳过——与 duplicateCanvas 同策略）
    for (const e of doc.edges) {
      const from = nidMap.get(e.from)
      const to = nidMap.get(e.to)
      if (from === undefined || to === undefined) continue
      await tx.insert(canvasEdges).values({ canvasId: cid, from, to, port: e.port, createdAt: e.createdAt })
    }
    return cid
  })
  return newId ? findCanvas(newId) : null
}
