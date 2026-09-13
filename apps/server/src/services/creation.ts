import { and, asc, count, desc, eq, inArray, or } from 'drizzle-orm'
import { db } from '../db'
import { assets, canvasEdges, canvasNodes, canvases, genTasks } from '../db/schema'
import type { Canvas, CanvasEdge, CanvasNode } from '../db/schema'
import { getImageAdapter, resolveEndpoint } from '../adapters/provider'
import { validateTemplateText, type TemplateValidation } from '../pipeline/loader'
import { assertProjectAssets } from '../pipeline/refs'

/**
 * [M16] 创作画布文档层（写模型）：
 * - buildCanvasDoc：画布全量读模型——节点状态/结果零存量，全部由 gen_tasks（canvasNodeId）派生；
 * - CRUD + 端口规则矩阵校验（含环检测）；duplicate 深拷；buildTemplateDraft 低保真草案导出；
 * - 执行通道见 services/creation-gen.ts（本文件零网络、零适配器调用）。
 * 宽容降级：坏 spec / 上游缺产物 → readiness 问题列出（不炸）。
 */

// ---------- 常量与类型 ----------

export const NODE_KINDS = ['asset', 'gen'] as const
export type NodeKind = (typeof NODE_KINDS)[number]

export const EDGE_PORTS = ['reference', 'first_frame', 'last_frame', 'source'] as const
export type EdgePort = (typeof EDGE_PORTS)[number]

export const EDIT_MODES = ['inpaint', 'erase', 'outpaint'] as const
export type EditMode = (typeof EDIT_MODES)[number]

/** 参考图端口容量（图片 ≤6 / 视频 ≤2；镜像 ai_image / ai_video 单镜参考图上限） */
export const REF_CAP: Record<'image' | 'video', number> = { image: 6, video: 2 }

export interface NodeSpecEdit {
  mode: EditMode
  maskAssetId?: number
  expand?: { angle?: number; xScale?: number; yScale?: number }
}

export interface NodeSpec {
  genKind: 'image' | 'video'
  prompt: string
  size?: string
  duration?: number
  resolution?: string
  aspectRatio?: string
  provider?: string
  model?: string
  useStylePreset?: boolean
  edit?: NodeSpecEdit
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface AssetLite {
  id: number
  kind: string
  purpose: string | null
  name: string
  mime: string | null
  width: number | null
  height: number | null
  duration: number | null
  prompt: string | null
  urls: { file: string; thumb: string | null }
}

export interface GenTaskLite {
  id: number
  status: string
  attempts: number
  errorMsg: string | null
  taskId: string | null
  resultAssetId: number | null
  createdAt: number
  completedAt: number | null
}

export interface EditCapability {
  inpaint: boolean
  erase: boolean
  outpaint: boolean
}

export interface UpstreamInfo {
  assetId: number | null
  mediaKind: string | null
}

export interface InputPlan {
  referenceAssetIds: number[]
  firstFrameAssetId: number | null
  lastFrameAssetId: number | null
  sourceAssetId: number | null
  problems: string[]
}

export interface CanvasDocNode {
  id: number
  kind: NodeKind
  x: number
  y: number
  title: string
  /** asset 节点：引用资产；gen 节点：最新成功结果资产（冗余方便前端） */
  assetId: number | null
  asset: AssetLite | null
  /** 仅 gen（解析成功时）；损坏 → null + specError */
  spec: NodeSpec | null
  specError: string | null
  /** 仅 gen：latestTask?.status ?? 'idle' */
  status: string | null
  latestTask: GenTaskLite | null
  tasks: GenTaskLite[]
  readiness: { ready: boolean; problems: string[] } | null
  editCapability: EditCapability | null
  canRun: boolean | null
  canCancel: boolean | null
}

export interface CanvasDocEdgeView {
  id: number
  from: number
  to: number
  port: string
}

export interface CanvasDoc {
  canvas: { id: number; projectId: number; name: string; viewport: Viewport }
  nodes: CanvasDocNode[]
  edges: CanvasDocEdgeView[]
}

export interface CanvasListItem {
  id: number
  projectId: number
  name: string
  nodeCount: number
  createdAt: number
  updatedAt: number
}

// ---------- 解析与校验（纯函数，供探针直接断言） ----------

/** spec 结构校验（建/改节点时调用；必填项缺失属 readiness 语义，不在此拦截） */
export function parseNodeSpec(raw: unknown): NodeSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('spec 需为对象')
  const o = raw as Record<string, unknown>
  const genKind = o['genKind']
  if (genKind !== 'image' && genKind !== 'video') throw new Error('spec.genKind 非法（image|video）')
  const prompt = o['prompt'] === undefined ? '' : o['prompt']
  if (typeof prompt !== 'string') throw new Error('spec.prompt 需为字符串')
  const spec: NodeSpec = { genKind, prompt }
  for (const key of ['size', 'resolution', 'aspectRatio', 'provider', 'model'] as const) {
    const v = o[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') throw new Error(`spec.${key} 需为字符串`)
    spec[key] = v
  }
  if (o['duration'] !== undefined && o['duration'] !== null) {
    const d = o['duration']
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) throw new Error('spec.duration 需为正数（秒）')
    spec.duration = d
  }
  if (o['useStylePreset'] !== undefined) {
    if (typeof o['useStylePreset'] !== 'boolean') throw new Error('spec.useStylePreset 需为布尔')
    spec.useStylePreset = o['useStylePreset']
  }
  if (o['edit'] !== undefined && o['edit'] !== null) {
    const e = o['edit']
    if (typeof e !== 'object' || Array.isArray(e)) throw new Error('spec.edit 需为对象')
    const eo = e as Record<string, unknown>
    if (!(EDIT_MODES as readonly string[]).includes(eo['mode'] as string)) {
      throw new Error(`spec.edit.mode 非法（${EDIT_MODES.join('|')}）`)
    }
    if (genKind === 'video') throw new Error('编辑节点仅支持图像（genKind 需为 image）')
    const edit: NodeSpecEdit = { mode: eo['mode'] as EditMode }
    if (eo['maskAssetId'] !== undefined && eo['maskAssetId'] !== null) {
      const m = eo['maskAssetId']
      if (typeof m !== 'number' || !Number.isInteger(m) || m <= 0) throw new Error('spec.edit.maskAssetId 需为正整数')
      edit.maskAssetId = m
    }
    if (eo['expand'] !== undefined && eo['expand'] !== null) {
      const x = eo['expand']
      if (typeof x !== 'object' || Array.isArray(x)) throw new Error('spec.edit.expand 需为对象')
      const xo = x as Record<string, unknown>
      const expand: { angle?: number; xScale?: number; yScale?: number } = {}
      for (const key of ['angle', 'xScale', 'yScale'] as const) {
        const v = xo[key]
        if (v === undefined || v === null) continue
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 4) {
          throw new Error(`spec.edit.expand.${key} 需为 0-4 间的数字`)
        }
        expand[key] = v
      }
      edit.expand = expand
    }
    spec.edit = edit
  }
  return spec
}

/** spec 宽容解析：坏 JSON → { spec: null, error }（读模型防炸） */
export function safeParseSpec(raw: string | null): { spec: NodeSpec | null; error: string | null } {
  if (!raw) return { spec: null, error: 'spec 缺失' }
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch (err) {
    return { spec: null, error: `spec JSON 损坏: ${(err as Error).message}` }
  }
  try {
    return { spec: parseNodeSpec(obj), error: null }
  } catch (err) {
    return { spec: null, error: (err as Error).message }
  }
}

/** spec 业务完备性（readiness 用）：结构合法但有缺失 → 问题清单 */
export function specProblems(spec: NodeSpec): string[] {
  const problems: string[] = []
  if (spec.edit) {
    if (spec.edit.mode === 'inpaint' && !spec.prompt.trim()) problems.push('局部重绘需填写提示词（要画什么）')
    if ((spec.edit.mode === 'inpaint' || spec.edit.mode === 'erase') && !spec.edit.maskAssetId) {
      problems.push('缺少蒙版（请打开蒙版编辑器涂抹后保存）')
    }
  } else if (!spec.prompt.trim()) {
    problems.push('prompt 为空')
  }
  return problems
}

/** viewport 解析：非法 → null（路由 400）；zoom 宽容 clamp [0.1, 10] */
export function parseViewport(raw: unknown): Viewport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const x = o['x']
  const y = o['y']
  const zoom = o['zoom']
  if (typeof x !== 'number' || !Number.isFinite(x)) return null
  if (typeof y !== 'number' || !Number.isFinite(y)) return null
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0) return null
  return { x, y, zoom: Math.min(10, Math.max(0.1, zoom)) }
}

/** 环检测：加入 from→to 后是否成环（等价于「沿既有边 to 可达 from」） */
export function wouldCreateCycle(edges: Array<{ from: number; to: number }>, from: number, to: number): boolean {
  const adj = new Map<number, number[]>()
  for (const e of edges) {
    const list = adj.get(e.from) ?? []
    list.push(e.to)
    adj.set(e.from, list)
  }
  const seen = new Set<number>([to])
  const stack = [to]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === from) return true
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return false
}

/** 端口规则矩阵校验（建边用；返回错误文案或 null） */
export function validateNewEdge(
  to: { id: number; kind: string; spec: NodeSpec | null },
  port: string,
  fromId: number,
  existing: Array<{ from: number; to: number; port: string }>,
): string | null {
  if (!(EDGE_PORTS as readonly string[]).includes(port)) {
    return `端口非法：${port}（可选 ${EDGE_PORTS.join('|')}）`
  }
  if (to.kind !== 'gen') return '仅生成节点可接收连线'
  if (!to.spec) return '目标节点 spec 损坏，无法连线'
  const spec = to.spec
  if (port === 'reference') {
    const cap = REF_CAP[spec.genKind]
    const cur = existing.filter((e) => e.to === to.id && e.port === port)
    if (cur.some((e) => e.from === fromId)) return '该连线已存在'
    if (cur.length >= cap) return `${spec.genKind === 'video' ? '视频' : '图片'}生成节点参考图上限 ${cap} 张`
    return null
  }
  if (port === 'first_frame' || port === 'last_frame') {
    if (spec.genKind !== 'video') return `${port === 'first_frame' ? '首帧' : '尾帧'}仅视频生成节点支持`
    const cur = existing.filter((e) => e.to === to.id && e.port === port)
    if (cur.some((e) => e.from === fromId)) return '该连线已存在'
    if (cur.length >= 1) return `${port === 'first_frame' ? '首帧' : '尾帧'}最多 1 条`
    return null
  }
  // source
  if (!spec.edit) return '源图端口仅编辑节点支持（spec.edit）'
  const cur = existing.filter((e) => e.to === to.id && e.port === port)
  if (cur.some((e) => e.from === fromId)) return '该连线已存在'
  if (cur.length >= 1) return '编辑源图最多 1 条'
  return null
}

/**
 * 输入计划（纯函数）：入边 → 各端口输入资产 + 问题清单。
 * 语义 = 引用快照：执行时取上游「当前最新成功产物」；上游无产物/非图片 → problems（不炸）。
 */
export function planNodeInputs(
  spec: NodeSpec,
  nodeId: number,
  edges: Array<{ from: number; to: number; port: string }>,
  upstream: Map<number, UpstreamInfo>,
): InputPlan {
  const plan: InputPlan = {
    referenceAssetIds: [],
    firstFrameAssetId: null,
    lastFrameAssetId: null,
    sourceAssetId: null,
    problems: [],
  }
  const incoming = edges.filter((e) => e.to === nodeId)
  const takeUpstream = (fromId: number): number | null => {
    const up = upstream.get(fromId)
    if (!up || up.assetId == null) {
      plan.problems.push(`引用节点 #${fromId} 暂无成功产物`)
      return null
    }
    if (up.mediaKind !== 'image') {
      plan.problems.push(`引用节点 #${fromId} 的产物为 ${up.mediaKind ?? '未知'}，不能作为生成输入（仅图片）`)
      return null
    }
    return up.assetId
  }
  for (const e of incoming) {
    if (e.port === 'reference') {
      const cap = REF_CAP[spec.genKind]
      if (plan.referenceAssetIds.length >= cap) {
        plan.problems.push(`参考图超过上限 ${cap} 张（已忽略多余连线）`)
        continue
      }
      const id = takeUpstream(e.from)
      if (id != null) plan.referenceAssetIds.push(id)
      continue
    }
    if (e.port === 'first_frame') {
      if (spec.genKind !== 'video') {
        plan.problems.push('首帧连线仅视频节点可用')
        continue
      }
      if (plan.firstFrameAssetId != null) continue
      plan.firstFrameAssetId = takeUpstream(e.from)
      continue
    }
    if (e.port === 'last_frame') {
      if (spec.genKind !== 'video') {
        plan.problems.push('尾帧连线仅视频节点可用')
        continue
      }
      if (plan.lastFrameAssetId != null) continue
      plan.lastFrameAssetId = takeUpstream(e.from)
      continue
    }
    if (e.port === 'source') {
      if (!spec.edit) {
        plan.problems.push('源图连线仅编辑节点可用')
        continue
      }
      if (plan.sourceAssetId != null) continue
      plan.sourceAssetId = takeUpstream(e.from)
    }
  }
  if (spec.edit && plan.sourceAssetId == null && !plan.problems.some((p) => p.includes('暂无成功产物') || p.includes('不能作为生成输入'))) {
    plan.problems.push('编辑节点缺少源图连线（source）')
  }
  return plan
}

/** 拓扑排序（gen 子图 Kahn；环兜底按 id 序追加——建边已防环，此为防务） */
export function topoSortGenNodeIds(genIds: number[], edges: Array<{ from: number; to: number }>): number[] {
  const gen = new Set(genIds)
  const indeg = new Map<number, number>(genIds.map((id) => [id, 0]))
  const adj = new Map<number, number[]>()
  for (const e of edges) {
    if (!gen.has(e.from) || !gen.has(e.to)) continue
    const list = adj.get(e.from) ?? []
    list.push(e.to)
    adj.set(e.from, list)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }
  const queue = genIds.filter((id) => (indeg.get(id) ?? 0) === 0)
  const out: number[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    out.push(id)
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  for (const id of genIds) {
    if (!out.includes(id)) out.push(id) // 环残留（不应发生）
  }
  return out
}

/** 编辑能力声明快照：解析当前图像端点 → adapter.editing；不可用 → 全 false（不炸） */
export async function editCapabilityOf(provider?: string): Promise<EditCapability> {
  try {
    const endpoint = await resolveEndpoint('image', provider)
    const adapter = getImageAdapter(endpoint.providerKey)
    const ed = adapter.editing
    const inpaint = ed?.inpaint === true
    return { inpaint, erase: inpaint, outpaint: ed?.outpaint === true }
  } catch {
    return { inpaint: false, erase: false, outpaint: false }
  }
}

// ---------- 读模型 ----------

function toAssetLite(a: typeof assets.$inferSelect): AssetLite {
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

function toTaskLite(t: typeof genTasks.$inferSelect): GenTaskLite {
  return {
    id: t.id,
    status: t.status,
    attempts: t.attempts,
    errorMsg: t.errorMsg,
    taskId: t.taskId,
    resultAssetId: t.resultAssetId,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  }
}

// ---------- 画布 CRUD ----------

export async function listCanvases(projectId: number): Promise<CanvasListItem[]> {
  const rows = await db.select().from(canvases).where(eq(canvases.projectId, projectId)).orderBy(desc(canvases.updatedAt))
  if (rows.length === 0) return []
  const counts = await db
    .select({ canvasId: canvasNodes.canvasId, n: count() })
    .from(canvasNodes)
    .where(inArray(canvasNodes.canvasId, rows.map((r) => r.id)))
    .groupBy(canvasNodes.canvasId)
  const byId = new Map(counts.map((c) => [c.canvasId, Number(c.n)]))
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    nodeCount: byId.get(r.id) ?? 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}

export async function createCanvas(projectId: number, name?: string): Promise<Canvas> {
  const now = Date.now()
  const [row] = await db
    .insert(canvases)
    .values({ projectId, name: name?.trim() || '未命名画布', createdAt: now, updatedAt: now })
    .returning()
  return row!
}

export async function findCanvas(id: number): Promise<Canvas | null> {
  const rows = await db.select().from(canvases).where(eq(canvases.id, id)).limit(1)
  return rows[0] ?? null
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

export async function deleteCanvas(id: number): Promise<boolean> {
  const cur = await findCanvas(id)
  if (!cur) return false
  await db.delete(canvasEdges).where(eq(canvasEdges.canvasId, id))
  await db.delete(canvasNodes).where(eq(canvasNodes.canvasId, id))
  await db.delete(canvases).where(eq(canvases.id, id))
  return true
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

export async function updateNode(
  id: number,
  patch: { x?: unknown; y?: unknown; title?: unknown; spec?: unknown },
): Promise<CanvasNode | null> {
  const cur = await findNode(id)
  if (!cur) return null
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
    if (cur.kind !== 'gen') throw new Error('素材节点不可改 spec')
    const parsed = parseNodeSpec(patch.spec)
    set['spec'] = JSON.stringify(parsed)
  }
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
  const err = validateNewEdge({ id: to, kind: toNode.kind, spec: toParsed.spec }, portRaw, from, existing)
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

// ---------- 读模型组装 ----------

export async function buildCanvasDoc(canvasId: number): Promise<CanvasDoc | null> {
  const canvas = await findCanvas(canvasId)
  if (!canvas) return null
  const nodeRows = await db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, canvasId)).orderBy(asc(canvasNodes.id))
  const edgeRows = await db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, canvasId)).orderBy(asc(canvasEdges.id))
  const nodeIds = nodeRows.map((n) => n.id)

  // 任务：全量按节点分组（新→旧）；最新一条 = tasks[0]
  const taskRows = nodeIds.length
    ? await db.select().from(genTasks).where(inArray(genTasks.canvasNodeId, nodeIds)).orderBy(desc(genTasks.id))
    : []
  const tasksByNode = new Map<number, Array<typeof genTasks.$inferSelect>>()
  for (const t of taskRows) {
    if (t.canvasNodeId == null) continue
    const list = tasksByNode.get(t.canvasNodeId) ?? []
    list.push(t)
    tasksByNode.set(t.canvasNodeId, list)
  }

  // 资产：素材节点 assetId + 全部任务 resultAssetId（含历史）
  const assetIdSet = new Set<number>()
  for (const n of nodeRows) if (n.assetId != null) assetIdSet.add(n.assetId)
  for (const t of taskRows) if (t.resultAssetId != null) assetIdSet.add(t.resultAssetId)
  const assetRows = assetIdSet.size
    ? await db.select().from(assets).where(inArray(assets.id, [...assetIdSet]))
    : []
  const assetById = new Map(assetRows.map((a) => [a.id, a]))

  // 上游产物索引：asset 节点取引用资产；gen 节点取最新成功任务产物
  const upstream = new Map<number, UpstreamInfo>()
  for (const n of nodeRows) {
    if (n.kind === 'asset') {
      const a = n.assetId != null ? assetById.get(n.assetId) : undefined
      upstream.set(n.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
    } else {
      const latestOk = (tasksByNode.get(n.id) ?? []).find((t) => t.status === 'succeeded' && t.resultAssetId != null)
      const a = latestOk?.resultAssetId != null ? assetById.get(latestOk.resultAssetId) : undefined
      upstream.set(n.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
    }
  }

  const capCache = new Map<string, Promise<EditCapability>>()
  const capOf = (provider?: string): Promise<EditCapability> => {
    const key = provider ?? ''
    const hit = capCache.get(key)
    if (hit) return hit
    const p = editCapabilityOf(provider)
    capCache.set(key, p)
    return p
  }

  const nodes: CanvasDocNode[] = []
  for (const n of nodeRows) {
    const base = {
      id: n.id,
      kind: n.kind as NodeKind,
      x: n.x,
      y: n.y,
    }
    if (n.kind === 'asset') {
      const a = n.assetId != null ? assetById.get(n.assetId) : undefined
      nodes.push({
        ...base,
        title: n.title ?? a?.name ?? `素材 #${n.assetId ?? '?'}`,
        assetId: n.assetId ?? null,
        asset: a ? toAssetLite(a) : null,
        spec: null,
        specError: null,
        status: null,
        latestTask: null,
        tasks: [],
        readiness: null,
        editCapability: null,
        canRun: null,
        canCancel: null,
      })
      continue
    }
    const parsed = safeParseSpec(n.spec)
    const tasks = (tasksByNode.get(n.id) ?? []).slice(0, 5).map(toTaskLite)
    const latest = (tasksByNode.get(n.id) ?? [])[0] ?? null
    const status = latest?.status ?? 'idle'
    const busy = status === 'pending' || status === 'processing'
    const problems: string[] = []
    if (parsed.error) problems.push(parsed.error)
    if (parsed.spec) {
      problems.push(...specProblems(parsed.spec))
      const plan = planNodeInputs(parsed.spec, n.id, edgeRows, upstream)
      problems.push(...plan.problems)
    }
    const isEdit = Boolean(parsed.spec?.edit)
    const resultAssetId = latest?.status === 'succeeded' ? latest.resultAssetId : null
    const resultAsset = resultAssetId != null ? assetById.get(resultAssetId) : undefined
    nodes.push({
      ...base,
      title: n.title ?? (parsed.spec ? (parsed.spec.edit ? `编辑 #${n.id}` : parsed.spec.genKind === 'video' ? `视频 #${n.id}` : `图片 #${n.id}`) : `节点 #${n.id}`),
      assetId: resultAssetId ?? null,
      asset: resultAsset ? toAssetLite(resultAsset) : null,
      spec: parsed.spec,
      specError: parsed.error,
      status,
      latestTask: latest ? toTaskLite(latest) : null,
      tasks,
      readiness: { ready: problems.length === 0, problems },
      editCapability: isEdit && parsed.spec ? await capOf(parsed.spec.provider) : null,
      canRun: Boolean(parsed.spec) && problems.length === 0 && !busy,
      canCancel: busy,
    })
  }

  const viewport = parseViewport(safeJson(canvas.viewport)) ?? { x: 0, y: 0, zoom: 1 }
  return {
    canvas: { id: canvas.id, projectId: canvas.projectId, name: canvas.name, viewport },
    nodes,
    edges: edgeRows.map((e) => ({ id: e.id, from: e.from, to: e.to, port: e.port })),
  }
}

/** 执行时输入计划（实时解析：取上游当前最新成功产物；供 creation-gen 调用） */
export async function loadInputPlan(
  node: CanvasNode,
  incoming: Array<{ from: number; to: number; port: string }>,
  spec: NodeSpec,
): Promise<InputPlan> {
  const fromIds = [...new Set(incoming.map((e) => e.from))]
  const upstream = new Map<number, UpstreamInfo>()
  if (fromIds.length > 0) {
    const rows = await db.select().from(canvasNodes).where(inArray(canvasNodes.id, fromIds))
    const genFromIds = rows.filter((r) => r.kind === 'gen').map((r) => r.id)
    const assetFromIds = rows.filter((r) => r.kind === 'asset' && r.assetId != null).map((r) => r.assetId!)
    const okTasks = genFromIds.length
      ? await db
          .select()
          .from(genTasks)
          .where(and(inArray(genTasks.canvasNodeId, genFromIds), eq(genTasks.status, 'succeeded')))
          .orderBy(desc(genTasks.id))
      : []
    const latestByNode = new Map<number, number>()
    for (const t of okTasks) {
      if (t.canvasNodeId == null || t.resultAssetId == null || latestByNode.has(t.canvasNodeId)) continue
      latestByNode.set(t.canvasNodeId, t.resultAssetId)
    }
    const allAssetIds = [...new Set([...assetFromIds, ...[...latestByNode.values()]])]
    const assetRows = allAssetIds.length ? await db.select().from(assets).where(inArray(assets.id, allAssetIds)) : []
    const assetById = new Map(assetRows.map((a) => [a.id, a]))
    for (const r of rows) {
      if (r.kind === 'asset') {
        const a = r.assetId != null ? assetById.get(r.assetId) : undefined
        upstream.set(r.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
      } else {
        const rid = latestByNode.get(r.id)
        const a = rid != null ? assetById.get(rid) : undefined
        upstream.set(r.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
      }
    }
  }
  return planNodeInputs(spec, node.id, incoming, upstream)
}

// ---------- 模板草案（低保真导出） ----------

/** 画布 → 流水线模板草案：gen 节点拓扑序 → step（prompt/参数注释保留 + TODO 标注）；复用 loader 校验自检 */
export async function buildTemplateDraft(
  canvasId: number,
  key?: string,
): Promise<{ yaml: string; validation: TemplateValidation } | null> {
  const doc = await buildCanvasDoc(canvasId)
  if (!doc) return null
  const draftKey = key?.trim() || `canvas-draft-${canvasId}`
  if (!/^[\w-]+$/.test(draftKey)) throw new Error(`key「${draftKey}」非法（仅字母/数字/下划线/中划线）`)
  const yaml = buildTemplateDraftYaml(doc, draftKey)
  return { yaml, validation: validateTemplateText(yaml, draftKey) }
}

/** 纯函数：YAML 文本生成（探针直接断言） */
export function buildTemplateDraftYaml(doc: CanvasDoc, key: string): string {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const genNodes = doc.nodes.filter((n) => n.kind === 'gen' && n.spec)
  const order = topoSortGenNodeIds(genNodes.map((n) => n.id), doc.edges)
  const lines: string[] = []
  lines.push(`# 由创作画布「${doc.canvas.name}」（canvas #${doc.canvas.id}）导出——低保真草案`)
  lines.push('# 说明：每个画布生成节点映射为一个 step；prompt 与参数以注释保留，冒号后内容需人工改写为模板引用/输入。')
  lines.push(`key: ${key}`)
  lines.push('version: 1')
  lines.push(`name: ${yamlScalar(`${doc.canvas.name} 草案`)}`)
  lines.push('description: 从创作画布导出的草案（待人工完善）')
  lines.push('genre: other')
  lines.push('inputs: []')
  lines.push('steps:')
  for (const id of order) {
    const node = byId.get(id)!
    const spec = node.spec!
    const action = spec.edit || spec.genKind === 'image' ? 'ai_image' : 'ai_video'
    const genUps = doc.edges.filter((e) => e.to === id && byId.get(e.from)?.kind === 'gen')
    const assetUps = doc.edges.filter((e) => e.to === id && byId.get(e.from)?.kind === 'asset')
    lines.push(`  - key: n${id}`)
    lines.push(`    action: ${action}`)
    lines.push(`    title: ${yamlScalar(node.title)}`)
    lines.push(`    after: [${genUps.map((e) => `n${e.from}`).join(', ')}]`)
    lines.push(`    # TODO 待人工补全：原画布节点 #${id}${spec.edit ? `（编辑模式 ${spec.edit.mode}）` : ''}`)
    lines.push(`    # prompt: ${yamlComment(spec.prompt || '（空）')}`)
    if (spec.size) lines.push(`    # size: ${spec.size}`)
    if (spec.duration) lines.push(`    # duration: ${spec.duration}`)
    if (spec.resolution) lines.push(`    # resolution: ${spec.resolution}`)
    if (spec.aspectRatio) lines.push(`    # aspectRatio: ${spec.aspectRatio}`)
    if (spec.provider || spec.model) lines.push(`    # provider/model: ${spec.provider ?? '默认'} / ${spec.model ?? '默认'}`)
    if (spec.edit?.maskAssetId) lines.push(`    # 蒙版（${spec.edit.mode}）：asset#${spec.edit.maskAssetId}`)
    for (const e of assetUps) {
      const from = byId.get(e.from)!
      lines.push(`    # 素材输入（${e.port}）：${yamlComment(from.title)}（asset#${from.assetId ?? '?'}）`)
    }
  }
  return `${lines.join('\n')}\n`
}

function yamlScalar(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function yamlComment(s: string): string {
  return s.replace(/\s*\n\s*/g, ' / ').trim()
}

// ---------- 小工具 ----------

/** 画布归属查询（执行通道用）：节点 → 画布 */
export async function canvasOfNode(nodeId: number): Promise<Canvas | null> {
  const node = await findNode(nodeId)
  if (!node) return null
  return findCanvas(node.canvasId)
}

function parsePos(x: unknown, y: unknown): { x: number; y: number } {
  const nx = Number(x)
  const ny = Number(y)
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error('坐标 x/y 需为数字')
  return { x: nx, y: ny }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
