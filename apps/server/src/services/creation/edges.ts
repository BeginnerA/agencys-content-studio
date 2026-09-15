// [M28·批1a] 自 services/creation.ts 拆分：画布边 CRUD（端口矩阵 + 环检测校验）。
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { assets, canvasEdges, canvasNodes } from '../../db/schema'
import type { Canvas, CanvasEdge } from '../../db/schema'
import { validateNewEdge, wouldCreateCycle } from './ports'
import { safeParseSpec } from './spec'

// ---------- 边 CRUD ----------

export async function addEdge(
  canvas: Canvas,
  fromRaw: unknown,
  toRaw: unknown,
  portRaw: unknown,
): Promise<CanvasEdge> {
  const from = Number(fromRaw)
  const to = Number(toRaw)
  if (!Number.isInteger(from) || from <= 0 || !Number.isInteger(to) || to <= 0) throw new Error('from/to 需为正整数节点 id')
  if (from === to) throw new Error('节点不能连接自身')
  if (typeof portRaw !== 'string') throw new Error('port 需为字符串')
  const rows = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvas.id), inArray(canvasNodes.id, [from, to])))
  const fromNode = rows.find((n) => n.id === from)
  const toNode = rows.find((n) => n.id === to)
  if (!fromNode || !toNode) throw new Error('节点不存在或不属于该画布')
  const existing = await db
    .select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port })
    .from(canvasEdges)
    .where(eq(canvasEdges.canvasId, canvas.id))
  const toParsed = toNode.kind === 'gen' ? safeParseSpec(toNode.spec) : { spec: null }
  const fromParsed = fromNode.kind === 'gen' ? safeParseSpec(fromNode.spec) : { spec: null }
  let fromAssetKind: string | null = null
  if (fromNode.kind === 'asset' && fromNode.assetId != null) {
    const a = await db.select({ kind: assets.kind }).from(assets).where(eq(assets.id, fromNode.assetId)).limit(1)
    fromAssetKind = a[0]?.kind ?? null
  }
  const err = validateNewEdge({ id: to, kind: toNode.kind, spec: toParsed.spec }, portRaw, from, existing, {
    id: from,
    kind: fromNode.kind,
    spec: fromParsed.spec,
    assetKind: fromAssetKind,
  })
  if (err) throw new Error(err)
  if (wouldCreateCycle(existing, from, to)) throw new Error('该连线会形成循环引用（画布连线须为有向无环）')
  const [row] = await db
    .insert(canvasEdges)
    .values({ canvasId: canvas.id, from, to, port: portRaw, createdAt: Date.now() })
    .returning()
  return row!
}

export async function deleteEdge(id: number): Promise<boolean> {
  const rows = await db.delete(canvasEdges).where(eq(canvasEdges.id, id)).returning({ id: canvasEdges.id })
  return rows.length > 0
}
