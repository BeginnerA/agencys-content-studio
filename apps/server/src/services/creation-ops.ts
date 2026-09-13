/**
 * [M17] 创作画布批量操控与编排层（写模型）：
 * - batchNodes：批量部分更新（复用 validateNodePatch：预校验全量合法才写，同文案同语义）；
 * - deleteNodes：批量删除（级联边 + 计数）；copyNodes：批量复制（深拷；集合内部边重映射重建）；
 * - chainNodes：规则式串联（相邻对按源产物类型自动选端口建边；失败 skip 记账 {from,to,reason}）；
 * - computeArrange / arrangeNodes：整理·对齐·分布（纯函数 + 落库；layered 层深=最长上游路径 / grid 行优先）；
 * - runCanvasNodes：批量执行（仅入队就绪节点；未就绪/忙碌 → skipped 附 problems；variants 1-4 透传；不级联等待）；
 * - promptExpandNode：AI 扩写（text/gen 内容源 → chatCompleteDetailed → 不落库；用量经 recordLlmUsage）。
 * 依赖方向：creation-ops → creation / creation-gen / llm（单向）；本文件不经手 socket 事件（对齐文档层 CRUD）。
 */
import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { db } from '../db'
import { assets, canvasEdges, canvasNodes } from '../db/schema'
import type { Canvas, CanvasEdge, CanvasNode } from '../db/schema'
import {
  REF_CAP,
  addEdge,
  canvasOfNode,
  findNode,
  safeParseSpec,
  safeParseTextSpec,
  sourceKindOf,
  validateNodePatch,
  type FromNodeInfo,
  type NodeSpec,
} from './creation'
import { startCanvasNodeRun } from './creation-gen'
import { chatCompleteDetailed } from './llm'
import { recordLlmUsage } from './usage'

// ---------- 解析与装载 ----------

/** ids 解析：非空正整数数组（去重保序） */
function parseNodeIds(raw: unknown, label = 'ids'): number[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${label} 需为非空正整数数组`)
  const ids = [...new Set(raw.map(Number))]
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error(`${label} 需为非空正整数数组`)
  return ids
}

/** 节点批查 + 归属校验（缺失 → 抛；返回按入参序；重复 id 去重后仅一条） */
async function loadCanvasNodes(canvas: Canvas, ids: number[]): Promise<CanvasNode[]> {
  const rows = await db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvas.id), inArray(canvasNodes.id, ids)))
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of ids) {
    if (!byId.has(id)) throw new Error(`节点 #${id} 不存在或不属于该画布`)
  }
  return ids.map((id) => byId.get(id)!)
}

/** [M17] 建边/串联 from 侧信息组装（asset 查资产 kind；gen 解析 spec） */
async function fromInfoOf(node: CanvasNode): Promise<FromNodeInfo> {
  let assetKind: string | null = null
  if (node.kind === 'asset' && node.assetId != null) {
    const rows = await db.select({ kind: assets.kind }).from(assets).where(eq(assets.id, node.assetId)).limit(1)
    assetKind = rows[0]?.kind ?? null
  }
  const spec = node.kind === 'gen' ? safeParseSpec(node.spec).spec : null
  return { id: node.id, kind: node.kind, spec, assetKind }
}

// ---------- 批量部分更新 ----------

export interface BatchUpdateEntry {
  id: unknown
  x?: unknown
  y?: unknown
  title?: unknown
  spec?: unknown
  seq?: unknown
  adoptedTaskId?: unknown
}

/**
 * 批量部分更新：阶段 1 全量预校验（collect set，任一失败 → 零写入）；阶段 2 顺序落库。
 * 校验复用 validateNodePatch（与单节点 PATCH 同文案同语义）；同一 id 多次出现时后者覆盖（按入参序）。
 */
export async function batchNodes(canvas: Canvas, rawUpdates: unknown): Promise<{ updated: number }> {
  if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) throw new Error('updates 需为非空数组')
  const entries = rawUpdates.map((u) => {
    if (!u || typeof u !== 'object' || Array.isArray(u)) throw new Error('updates[] 需为对象')
    return u as BatchUpdateEntry
  })
  const ids = entries.map((u) => Number(u.id))
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error('updates[].id 需为正整数')
  const nodes = await loadCanvasNodes(canvas, [...new Set(ids)])
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const sets: Array<{ id: number; set: Record<string, unknown> }> = []
  for (const u of entries) {
    const id = Number(u.id)
    const set = await validateNodePatch(byId.get(id)!, {
      x: u.x,
      y: u.y,
      title: u.title,
      spec: u.spec,
      seq: u.seq,
      adoptedTaskId: u.adoptedTaskId,
    })
    sets.push({ id, set })
  }
  for (const { id, set } of sets) {
    await db.update(canvasNodes).set(set).where(eq(canvasNodes.id, id))
  }
  return { updated: sets.length }
}

// ---------- 批量删除 / 复制 ----------

/** 批量删除：级联其全部连线（返回节点/边删除计数） */
export async function deleteNodes(canvas: Canvas, rawIds: unknown): Promise<{ deleted: number; edges: number }> {
  const ids = parseNodeIds(rawIds)
  await loadCanvasNodes(canvas, ids)
  const edgeRows = await db
    .delete(canvasEdges)
    .where(and(eq(canvasEdges.canvasId, canvas.id), or(inArray(canvasEdges.from, ids), inArray(canvasEdges.to, ids))))
    .returning({ id: canvasEdges.id })
  const nodeRows = await db
    .delete(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvas.id), inArray(canvasNodes.id, ids)))
    .returning({ id: canvasNodes.id })
  return { deleted: nodeRows.length, edges: edgeRows.length }
}

/** 复制偏移缺省值（+40,+40） */
export const COPY_OFFSET_DEFAULT = { x: 40, y: 40 }

function parseOffset(raw: unknown): { x: number; y: number } {
  if (raw === undefined || raw === null) return { ...COPY_OFFSET_DEFAULT }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('offset 需为 { x?, y? } 对象')
  const o = raw as Record<string, unknown>
  const out = { ...COPY_OFFSET_DEFAULT }
  for (const k of ['x', 'y'] as const) {
    if (o[k] !== undefined) {
      const n = Number(o[k])
      if (!Number.isFinite(n)) throw new Error(`offset.${k} 需为数字`)
      out[k] = n
    }
  }
  return out
}

/**
 * 批量复制：深拷（spec/assetId/adoptedTaskId/seq/title；任务归属不迁移 → 拷贝节点 displayTaskId 恒 null）；
 * 集合内部边重映射重建；跨集合边不复制。位置 = 原位置 + offset。
 */
export async function copyNodes(
  canvas: Canvas,
  rawIds: unknown,
  rawOffset: unknown,
): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }> {
  const ids = parseNodeIds(rawIds)
  const src = await loadCanvasNodes(canvas, ids)
  const offset = parseOffset(rawOffset)
  const now = Date.now()
  const idMap = new Map<number, number>()
  const nodes: CanvasNode[] = []
  for (const n of src) {
    const [row] = await db
      .insert(canvasNodes)
      .values({
        canvasId: canvas.id,
        kind: n.kind,
        assetId: n.assetId,
        title: n.title,
        spec: n.spec,
        x: n.x + offset.x,
        y: n.y + offset.y,
        adoptedTaskId: n.adoptedTaskId,
        seq: n.seq,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    idMap.set(n.id, row!.id)
    nodes.push(row!)
  }
  const inner = await db
    .select()
    .from(canvasEdges)
    .where(and(eq(canvasEdges.canvasId, canvas.id), inArray(canvasEdges.from, ids), inArray(canvasEdges.to, ids)))
    .orderBy(asc(canvasEdges.id))
  const edges: CanvasEdge[] = []
  for (const e of inner) {
    const [row] = await db
      .insert(canvasEdges)
      .values({ canvasId: canvas.id, from: idMap.get(e.from)!, to: idMap.get(e.to)!, port: e.port, createdAt: now })
      .returning()
    edges.push(row!)
  }
  return { nodes, edges }
}

// ---------- 规则式串联（chain） ----------

export interface ChainSkip {
  from: number
  to: number
  reason: string
}

export interface ChainResult {
  created: CanvasEdge[]
  skipped: ChainSkip[]
}

/**
 * chain 端口决策（纯函数）：源产物类型 × 目标 → 候选端口序列（顺序 = 尝试优先级；空 = 类型不符）。
 * 规则：text→prompt（image/video/audio）；视频源→video（compose）；音频源→audio（compose）；
 * 图像/实体源→reference（image/video gen；video 满额则 first_frame 兜底）。
 */
export function chainPortCandidates(from: FromNodeInfo, to: { kind: string; spec: NodeSpec | null }): string[] {
  if (from.kind === 'run' || to.kind === 'run') return []
  if (to.kind !== 'gen' || !to.spec) return []
  const src = sourceKindOf(from)
  const gk = to.spec.genKind
  if (src === 'text') return gk === 'image' || gk === 'video' || gk === 'audio' ? ['prompt'] : []
  if (src === 'video') return gk === 'compose' ? ['video'] : []
  if (src === 'audio') return gk === 'compose' ? ['audio'] : []
  if (src === 'image' || src === 'entity') {
    if (gk === 'image') return ['reference']
    if (gk === 'video') return ['reference', 'first_frame']
    return []
  }
  return []
}

/** 候选为空时的拒绝文案（对齐 validateNewEdge 语义优先级） */
function chainRejectReason(fromInfo: FromNodeInfo, toNode: CanvasNode, toSpec: NodeSpec | null): string {
  if (fromInfo.kind === 'run' || toNode.kind === 'run') return '运行节点不参与连线'
  if (toNode.kind !== 'gen') return '仅生成节点可接收连线'
  if (!toSpec) return '目标节点 spec 损坏，无法连线'
  const src = sourceKindOf(fromInfo) ?? '未知'
  return `类型不符（${src} → ${toSpec.genKind}）`
}

/** 端口容量提前判定（供 reference 满额 fallback first_frame；文案确定）；重复边交给 addEdge 判「该连线已存在」 */
function capReason(
  port: string,
  toId: number,
  toSpec: NodeSpec,
  fromId: number,
  existing: Array<{ from: number; to: number; port: string }>,
): string | null {
  const cur = existing.filter((e) => e.to === toId && e.port === port)
  if (cur.some((e) => e.from === fromId)) return null
  if (port === 'reference') {
    const cap = REF_CAP[toSpec.genKind as 'image' | 'video']
    if (cap && cur.length >= cap) return `参考图上限已满（${cap} 张）`
    return null
  }
  if (port === 'first_frame' && cur.length >= 1) return '首帧最多 1 条'
  return null
}

/**
 * 规则式串联：按 ids 顺序对相邻对自动建边（复用 addEdge 做类型/重复/环校验与插入）。
 * 单对失败 → skip 记账（不中断后续对）；成功边即时进入内存 existing（后续 cap 判定含新建边）。
 */
export async function chainNodes(canvas: Canvas, rawIds: unknown): Promise<ChainResult> {
  const ids = parseNodeIds(rawIds)
  const nodes = await loadCanvasNodes(canvas, ids)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const created: CanvasEdge[] = []
  const skipped: ChainSkip[] = []
  const existing = await db
    .select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port })
    .from(canvasEdges)
    .where(eq(canvasEdges.canvasId, canvas.id))
  for (let i = 0; i + 1 < ids.length; i += 1) {
    const fromNode = byId.get(ids[i]!)!
    const toNode = byId.get(ids[i + 1]!)!
    const fromInfo = await fromInfoOf(fromNode)
    const toSpec = toNode.kind === 'gen' ? safeParseSpec(toNode.spec).spec : null
    const candidates = chainPortCandidates(fromInfo, { kind: toNode.kind, spec: toSpec })
    if (candidates.length === 0) {
      skipped.push({ from: fromNode.id, to: toNode.id, reason: chainRejectReason(fromInfo, toNode, toSpec) })
      continue
    }
    let lastReason = ''
    let ok = false
    for (const port of candidates) {
      const hit = capReason(port, toNode.id, toSpec!, fromNode.id, existing)
      if (hit) {
        lastReason = hit
        continue // 满额 → 尝试下一候选（如 first_frame 兜底）；全部失败则以最后原因为 skip 理由
      }
      try {
        const edge = await addEdge(canvas, fromNode.id, toNode.id, port)
        created.push(edge)
        existing.push({ from: edge.from, to: edge.to, port: edge.port })
        ok = true
        break
      } catch (err) {
        lastReason = (err as Error).message
        break // 已存在 / 环 / from 侧类型不符 → 不换端口
      }
    }
    if (!ok) skipped.push({ from: fromNode.id, to: toNode.id, reason: lastReason })
  }
  return { created, skipped }
}

// ---------- 整理 / 对齐 / 分布（arrange） ----------

/** 布局网格（与 Web 画布卡片尺寸对齐） */
export const ARRANGE_COL_W = 300
export const ARRANGE_ROW_H = 240

export const ARRANGE_MODES = [
  'layered',
  'grid',
  'align-left',
  'align-right',
  'align-top',
  'align-bottom',
  'distribute-h',
  'distribute-v',
] as const
export type ArrangeMode = (typeof ARRANGE_MODES)[number]

export interface ArrangeNodeInput {
  id: number
  x: number
  y: number
  seq: number | null
}

/** 层内/网格排序：有 seq 优先（升序），无 seq 按 x → y → id */
function seqThenPos(a: ArrangeNodeInput, b: ArrangeNodeInput): number {
  if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq
  if (a.seq != null && b.seq == null) return -1
  if (a.seq == null && b.seq != null) return 1
  return a.x - b.x || a.y - b.y || a.id - b.id
}

/** 位置排序：x → y → id */
function posThenId(a: ArrangeNodeInput, b: ArrangeNodeInput): number {
  return a.x - b.x || a.y - b.y || a.id - b.id
}

/** 层深 = 子集内最长上游路径（Kahn 拓扑序；残留环按已算深度兜底——建边已防环） */
function computeDepths(nodes: ArrangeNodeInput[], edges: Array<{ from: number; to: number }>): Map<number, number> {
  const ids = new Set(nodes.map((n) => n.id))
  const indeg = new Map<number, number>(nodes.map((n) => [n.id, 0]))
  const depth = new Map<number, number>(nodes.map((n) => [n.id, 0]))
  const adj = new Map<number, number[]>()
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    const list = adj.get(e.from) ?? []
    list.push(e.to)
    adj.set(e.from, list)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const next of adj.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1))
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  return depth
}

/**
 * [M17] 整理布局纯函数（探针直接断言）：返回 id → 新坐标（未列入 = 不移动）。
 * - layered：列 = 层深（distinct 归一化），同层按 (seq, x, y) 行序；x = 锚X + 列×300、y = 锚Y + 行×240；
 * - grid：行优先、列数 = max(2, ceil(√n))；sortBy:'seq' 时有 seq 优先（先 seq 组后无 seq 组）；
 * - align-*：点语义（服务端不持有渲染尺寸）取包围盒边缘；distribute-*：n≥3 中间点等距（首尾不动）。
 * 锚 = 目标集包围盒左上角（minX, minY）。
 */
export function computeArrange(
  nodes: ArrangeNodeInput[],
  opts: { edges: Array<{ from: number; to: number }>; mode: string; sortBy?: unknown },
): Map<number, { x: number; y: number }> {
  if (!(ARRANGE_MODES as readonly string[]).includes(opts.mode)) {
    throw new Error(`mode 非法（${ARRANGE_MODES.join('|')}）：${opts.mode}`)
  }
  const out = new Map<number, { x: number; y: number }>()
  if (nodes.length === 0) return out
  const anchorX = Math.min(...nodes.map((n) => n.x))
  const anchorY = Math.min(...nodes.map((n) => n.y))
  const mode = opts.mode as ArrangeMode
  if (mode === 'layered') {
    const depth = computeDepths(nodes, opts.edges)
    const cols = [...new Set(depth.values())].sort((a, b) => a - b)
    const colOf = new Map(cols.map((d, i) => [d, i]))
    const groups = new Map<number, ArrangeNodeInput[]>()
    for (const n of nodes) {
      const col = colOf.get(depth.get(n.id) ?? 0)!
      const list = groups.get(col) ?? []
      list.push(n)
      groups.set(col, list)
    }
    for (const [col, list] of groups) {
      list.sort(seqThenPos)
      list.forEach((n, row) => {
        out.set(n.id, { x: anchorX + col * ARRANGE_COL_W, y: anchorY + row * ARRANGE_ROW_H })
      })
    }
    return out
  }
  if (mode === 'grid') {
    const sorted = [...nodes].sort(opts.sortBy === 'seq' ? seqThenPos : posThenId)
    const cols = Math.max(2, Math.ceil(Math.sqrt(sorted.length)))
    sorted.forEach((n, i) => {
      out.set(n.id, {
        x: anchorX + (i % cols) * ARRANGE_COL_W,
        y: anchorY + Math.floor(i / cols) * ARRANGE_ROW_H,
      })
    })
    return out
  }
  const maxX = Math.max(...nodes.map((n) => n.x))
  const maxY = Math.max(...nodes.map((n) => n.y))
  if (mode === 'align-left') {
    for (const n of nodes) out.set(n.id, { x: anchorX, y: n.y })
    return out
  }
  if (mode === 'align-right') {
    for (const n of nodes) out.set(n.id, { x: maxX, y: n.y })
    return out
  }
  if (mode === 'align-top') {
    for (const n of nodes) out.set(n.id, { x: n.x, y: anchorY })
    return out
  }
  if (mode === 'align-bottom') {
    for (const n of nodes) out.set(n.id, { x: n.x, y: maxY })
    return out
  }
  if (nodes.length < 3) return out // 分布需 ≥3（首尾不动，无中间点）
  const horiz = mode === 'distribute-h'
  const sorted = [...nodes].sort((a, b) => (horiz ? posThenId(a, b) : a.y - b.y || a.x - b.x || a.id - b.id))
  const lo = horiz ? anchorX : anchorY
  const hi = horiz ? maxX : maxY
  sorted.forEach((n, i) => {
    const v = lo + ((hi - lo) * i) / (sorted.length - 1)
    out.set(n.id, horiz ? { x: v, y: n.y } : { x: n.x, y: v })
  })
  return out
}

/** arrange 端点：目标集（nodeIds? 缺省 = 全画布）→ computeArrange → 落库 */
export async function arrangeNodes(
  canvas: Canvas,
  opts: { mode: unknown; nodeIds?: unknown; sortBy?: unknown },
): Promise<{ updated: number; positions: Array<{ id: number; x: number; y: number }> }> {
  const { mode, nodeIds, sortBy } = opts
  if (typeof mode !== 'string') throw new Error('mode 需为字符串')
  const all = await db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, canvas.id))
  let target = all
  if (nodeIds !== undefined && nodeIds !== null) {
    const ids = parseNodeIds(nodeIds, 'nodeIds')
    const byId = new Map(all.map((n) => [n.id, n]))
    for (const id of ids) {
      if (!byId.has(id)) throw new Error(`节点 #${id} 不存在或不属于该画布`)
    }
    target = ids.map((id) => byId.get(id)!)
  }
  const edges = await db
    .select({ from: canvasEdges.from, to: canvasEdges.to })
    .from(canvasEdges)
    .where(eq(canvasEdges.canvasId, canvas.id))
  const pos = computeArrange(
    target.map((n) => ({ id: n.id, x: n.x, y: n.y, seq: n.seq ?? null })),
    { edges, mode, sortBy },
  )
  const positions = [...pos.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y }))
  const now = Date.now()
  for (const p of positions) {
    await db.update(canvasNodes).set({ x: p.x, y: p.y, updatedAt: now }).where(eq(canvasNodes.id, p.id))
  }
  return { updated: positions.length, positions }
}

// ---------- 批量执行（canvases/run） ----------

const NOT_READY_PREFIX = '节点未就绪：'

/**
 * 批量执行：只入队就绪节点（逐节点串行 startCanvasNodeRun；未就绪/忙碌 → skipped 附 problems）。
 * variants（1-4）透传（每节点 ×N 建任务）；不做级联等待（下游等上游任务完成由用户手动再跑——防爆量计费，spec §8）。
 */
export async function runCanvasNodes(
  canvas: Canvas,
  opts: { nodeIds?: unknown; variants?: unknown },
): Promise<{
  started: Array<{ nodeId: number; taskId: number; taskIds: number[] }>
  skipped: Array<{ nodeId: number; problems: string[] }>
}> {
  const { nodeIds, variants } = opts
  let variantCount = 1
  if (variants !== undefined && variants !== null) {
    const v = Number(variants)
    if (!Number.isInteger(v) || v < 1 || v > 4) throw new Error('variants 需为 1-4 的整数')
    variantCount = v
  }
  let targets: number[]
  if (nodeIds === undefined || nodeIds === null) {
    const rows = await db
      .select({ id: canvasNodes.id })
      .from(canvasNodes)
      .where(and(eq(canvasNodes.canvasId, canvas.id), eq(canvasNodes.kind, 'gen')))
      .orderBy(asc(canvasNodes.id))
    targets = rows.map((r) => r.id)
  } else {
    targets = parseNodeIds(nodeIds, 'nodeIds')
    await loadCanvasNodes(canvas, targets)
  }
  const started: Array<{ nodeId: number; taskId: number; taskIds: number[] }> = []
  const skipped: Array<{ nodeId: number; problems: string[] }> = []
  for (const id of targets) {
    try {
      const { taskId, taskIds } = await startCanvasNodeRun(id, variantCount)
      started.push({ nodeId: id, taskId, taskIds })
    } catch (err) {
      const msg = (err as Error).message
      const problems = msg.startsWith(NOT_READY_PREFIX)
        ? msg.slice(NOT_READY_PREFIX.length).split('；').filter((s) => s.length > 0)
        : [msg]
      skipped.push({ nodeId: id, problems })
    }
  }
  return { started, skipped }
}

// ---------- [M17] AI 辅助（prompt-expand） ----------

/**
 * 提示词扩写：内容源 = text 节点 spec.text / gen 节点 spec.prompt（其余 kind 拒绝）；
 * chatCompleteDetailed（内联系统提示，maxTokens 2000）→ { prompt, provider, model } 不落库；
 * LLM 未配置 → LlmNotConfiguredError 经路由 400 透传（前端引导 Settings）；用量经 recordLlmUsage（runId null）。
 */
export async function promptExpandNode(
  nodeId: number,
  instruction?: unknown,
): Promise<{ prompt: string; provider: string; model: string } | null> {
  const node = await findNode(nodeId)
  if (!node) return null
  const canvas = await canvasOfNode(nodeId)
  if (!canvas) throw new Error('画布不存在')
  let source: string
  if (node.kind === 'text') {
    const ts = safeParseTextSpec(node.spec)
    if (!ts.spec) throw new Error(`节点 spec 损坏：${ts.error}`)
    source = ts.spec.text.trim()
  } else if (node.kind === 'gen') {
    const spec = safeParseSpec(node.spec).spec
    if (!spec) throw new Error('节点 spec 损坏，无法扩写')
    source = spec.prompt.trim()
  } else {
    throw new Error('仅文本节点或生成节点可扩写提示词')
  }
  if (!source) throw new Error('内容为空（请先填写提示词文本）')
  if (instruction !== undefined && instruction !== null && typeof instruction !== 'string') {
    throw new Error('instruction 需为字符串')
  }
  const extra = typeof instruction === 'string' && instruction.trim() ? `\n\n补充要求：${instruction.trim()}` : ''
  const res = await chatCompleteDetailed(
    [
      {
        role: 'system',
        content:
          '你是创作提示词扩写引擎。将用户给出的提示词扩写为更具体、更富画面感的单段中文提示词：' +
          '不改变原意与主体，补充镜头语言、光影、构图、质感与风格细节；直接输出扩写后的提示词本体，不输出解释、前缀或 markdown 围栏。',
      },
      { role: 'user', content: `原提示词：\n${source}${extra}` },
    ],
    undefined,
    { maxTokens: 2000 },
  )
  const prompt = res.content.trim()
  if (!prompt) throw new Error('LLM 返回为空')
  await recordLlmUsage({ projectId: canvas.projectId, runId: null, provider: res.provider, model: res.model, usage: res.usage })
  return { prompt, provider: res.provider, model: res.model }
}
