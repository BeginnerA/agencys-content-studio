// [M28·批1a] 自 services/creation.ts 拆分：画布 CRUD/回收站/深拷 + 资产与任务轻视图工具。
import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, canvasEdges, canvasGroups, canvasNodes, canvasSnapshots, canvases, genTasks } from '../../db/schema'
import type { Canvas } from '../../db/schema'
import { emitStudioEvent } from '../events'
import { parseViewport, type AssetLite, type CanvasListItem } from './spec'

// ---------- 读模型 ----------

export function toAssetLite(a: typeof assets.$inferSelect): AssetLite {
  return {
    id: a.id,
    kind: a.kind,
    purpose: a.purpose,
    name: a.name,
    mime: a.mime,
    width: a.width,
    height: a.height,
    duration: a.duration,
    prompt: a.prompt,
    urls: {
      file: `/api/v1/assets/${a.id}/file`,
      thumb: a.kind === 'image' || a.kind === 'video' ? `/api/v1/assets/${a.id}/thumb?v=2` : null,
    },
  }
}


// ---------- 画布 CRUD ----------

export async function listCanvases(projectId: number, opts?: { trash?: boolean }): Promise<CanvasListItem[]> {
  const trash = opts?.trash === true
  const where = trash
    ? and(eq(canvases.projectId, projectId), isNotNull(canvases.deletedAt))
    : and(eq(canvases.projectId, projectId), isNull(canvases.deletedAt))
  const rows = await db.select().from(canvases).where(where).orderBy(desc(canvases.updatedAt))
  if (rows.length === 0) return []
  const counts = await db
    .select({ canvasId: canvasNodes.canvasId, n: count() })
    .from(canvasNodes)
    .where(inArray(canvasNodes.canvasId, rows.map((r) => r.id)))
    .groupBy(canvasNodes.canvasId)
  const byId = new Map(counts.map((c) => [c.canvasId, Number(c.n)]))
  // [M18] cover 派生（两次批查避 N+1）：节点 → succeeded 有产物任务（completedAt 降序）取每画布最近一条 → 批查资产
  const nodeRows = await db
    .select({ id: canvasNodes.id, canvasId: canvasNodes.canvasId })
    .from(canvasNodes)
    .where(inArray(canvasNodes.canvasId, rows.map((r) => r.id)))
  const nodeToCanvas = new Map(nodeRows.map((n) => [n.id, n.canvasId]))
  const coverAssetByCanvas = new Map<number, number>()
  if (nodeRows.length > 0) {
    const taskRows = await db
      .select({ canvasNodeId: genTasks.canvasNodeId, resultAssetId: genTasks.resultAssetId })
      .from(genTasks)
      .where(
        and(
          inArray(genTasks.canvasNodeId, nodeRows.map((n) => n.id)),
          eq(genTasks.status, 'succeeded'),
          isNotNull(genTasks.resultAssetId),
        ),
      )
      .orderBy(desc(genTasks.completedAt))
    for (const t of taskRows) {
      if (t.canvasNodeId == null || t.resultAssetId == null) continue
      const cid = nodeToCanvas.get(t.canvasNodeId)
      if (cid == null) continue
      if (!coverAssetByCanvas.has(cid)) coverAssetByCanvas.set(cid, t.resultAssetId) // 降序首条 = 最近完成
    }
  }
  const coverIds = [...new Set([...coverAssetByCanvas.values()])]
  const coverRows = coverIds.length ? await db.select().from(assets).where(inArray(assets.id, coverIds)) : []
  const coverById = new Map(coverRows.map((a) => [a.id, a]))
  return rows.map((r) => {
    const coverId = coverAssetByCanvas.get(r.id)
    const coverAsset = coverId != null ? coverById.get(coverId) : undefined
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      nodeCount: byId.get(r.id) ?? 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt,
      cover: coverAsset ? toAssetLite(coverAsset) : null,
    }
  })
}

export async function createCanvas(projectId: number, name?: string): Promise<Canvas> {
  const now = Date.now()
  const [row] = await db
    .insert(canvases)
    .values({ projectId, name: name?.trim() || '未命名画布', createdAt: now, updatedAt: now })
    .returning()
  return row!
}

/** [M18] 画布行装载（统一过滤点）：默认仅活跃画布（已软删 → null，子端点一律 404）；includeDeleted 供 restore/purge */
export async function findCanvas(id: number, opts?: { includeDeleted?: boolean }): Promise<Canvas | null> {
  const rows = await db.select().from(canvases).where(eq(canvases.id, id)).limit(1)
  const row = rows[0] ?? null
  if (!row) return null
  if (row.deletedAt != null && opts?.includeDeleted !== true) return null
  return row
}

export async function updateCanvas(
  id: number,
  patch: { name?: unknown; viewport?: unknown },
): Promise<Canvas | null> {
  const cur = await findCanvas(id)
  if (!cur) return null
  const set: Record<string, unknown> = { updatedAt: Date.now() }
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) throw new Error('name 需为非空字符串')
    set['name'] = patch.name.trim()
  }
  if (patch.viewport !== undefined) {
    const vp = parseViewport(patch.viewport)
    if (!vp) throw new Error('viewport 非法（需 {x,y,zoom} 数字）')
    set['viewport'] = JSON.stringify(vp)
  }
  const [row] = await db.update(canvases).set(set).where(eq(canvases.id, id)).returning()
  return row ?? null
}

// 注：原 M16 硬删 deleteCanvas 已由 M18 softDeleteCanvas（软删）+ purgeCanvas（彻底删）取代

// ---------- [M18] 回收站（软删 / 恢复 / purge） ----------

/** [M18] 软删（进回收站）：仅标 deletedAt（子行保留；在途任务由路由层 cancelCanvasTasks 取消） */
export async function softDeleteCanvas(canvas: Canvas): Promise<Canvas> {
  const now = Date.now()
  const [row] = await db
    .update(canvases)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(canvases.id, canvas.id))
    .returning()
  emitStudioEvent({ type: 'canvas.changed', canvasId: canvas.id, projectId: canvas.projectId })
  return row!
}

/** [M18] 回收站恢复（行须为已软删；路由层已做状态判定与 404） */
export async function restoreCanvas(canvas: Canvas): Promise<Canvas> {
  const [row] = await db
    .update(canvases)
    .set({ deletedAt: null, updatedAt: Date.now() })
    .where(eq(canvases.id, canvas.id))
    .returning()
  emitStudioEvent({ type: 'canvas.changed', canvasId: canvas.id, projectId: canvas.projectId })
  return row!
}

/** [M18] 彻底删除（行须为已软删；级联删 nodes/edges/groups/snapshots；gen_tasks 行保留留痕） */
export async function purgeCanvas(canvasId: number): Promise<void> {
  await db.delete(canvasEdges).where(eq(canvasEdges.canvasId, canvasId))
  await db.delete(canvasNodes).where(eq(canvasNodes.canvasId, canvasId))
  await db.delete(canvasGroups).where(eq(canvasGroups.canvasId, canvasId))
  await db.delete(canvasSnapshots).where(eq(canvasSnapshots.canvasId, canvasId))
  await db.delete(canvases).where(eq(canvases.id, canvasId))
}

/** 深拷：节点 id 映射后重建边（spec/assetId 引用原样） */
export async function duplicateCanvas(id: number, name?: string): Promise<Canvas | null> {
  const src = await findCanvas(id)
  if (!src) return null
  const now = Date.now()
  const [copy] = await db
    .insert(canvases)
    .values({ projectId: src.projectId, name: name?.trim() || `${src.name} 副本`, viewport: src.viewport, createdAt: now, updatedAt: now })
    .returning()
  const nodes = await db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, id)).orderBy(asc(canvasNodes.id))
  const idMap = new Map<number, number>()
  for (const node of nodes) {
    const [created] = await db
      .insert(canvasNodes)
      .values({
        canvasId: copy!.id,
        kind: node.kind,
        assetId: node.assetId,
        title: node.title,
        spec: node.spec,
        x: node.x,
        y: node.y,
        adoptedTaskId: node.adoptedTaskId,
        seq: node.seq,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: canvasNodes.id })
    idMap.set(node.id, created!.id)
  }
  const edges = await db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, id)).orderBy(asc(canvasEdges.id))
  for (const edge of edges) {
    const from = idMap.get(edge.from)
    const to = idMap.get(edge.to)
    if (from === undefined || to === undefined) continue
    await db.insert(canvasEdges).values({ canvasId: copy!.id, from, to, port: edge.port, createdAt: now })
  }
  return copy ?? null
}
