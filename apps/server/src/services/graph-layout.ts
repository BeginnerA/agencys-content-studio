/**
 * 事件图谱力导向布局（spec §2.4）：d3-force 确定性迭代（ops.ts 同构手法）。
 * 输入 = novel-board graph 文档节点/边，输出 = 服务端算好的坐标（前端 SVG 零计算）。
 * 确定性契约（探针断言）：显式注入初始坐标（输入序环形布局，非 d3 内部默认）+ stop() 手动
 * tick 固定轮数 + 输出 round —— 同输入必同输出，无随机源。
 */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'

export const GRAPH_TICKS = 300
export const GRAPH_LINK_DISTANCE = 150
export const GRAPH_CHARGE = -420

export interface GraphLayoutNode {
  /** 唯一 id（event:名 / char:名 前缀区分双类型） */
  id: string
  kind: 'event' | 'character'
  label: string
  /** 事件覆盖章数等权重信息（半径微调用）；缺省 0 */
  weight?: number
}

export interface GraphLayoutLink {
  source: string
  target: string
  /** char-event 参与 / event-event 时序 */
  kind: 'member' | 'sequence'
}

export interface LaidOutNode extends GraphLayoutNode {
  x: number
  y: number
  r: number
}

export interface GraphLayout {
  nodes: LaidOutNode[]
  links: Array<{ source: string; target: string; kind: string }>
  width: number
  height: number
}

/** 节点半径（纯函数）：事件 22 + min(10, 覆盖章数)；角色 14 + min(8, 度数) */
export function nodeRadius(n: GraphLayoutNode, degree: number): number {
  return n.kind === 'event' ? 22 + Math.min(10, Math.max(0, n.weight ?? 0)) : 14 + Math.min(8, degree)
}

interface SimNode extends SimulationNodeDatum {
  node: GraphLayoutNode
  r: number
  // 收窄为必选：初始坐标显式注入（确定性契约），d3 全程原地更新，数学运算处无 undefined
  x: number
  y: number
}

/**
 * 布局主函数（纯函数，探针直测）：
 * - 空图 → { nodes: [], links: [], width: 0, height: 0 }；
 * - 单节点 → 原点 (0,0) 附近固定 (120, 100)，不迭代；
 * - 引用不存在的 link 端点 → 静默过滤（图谱脏数据宽容）；
 * - 输出坐标 round 取整并平移使包围盒左上 = (40, 40)（SVG 边距）。
 */
export function computeGraphLayout(nodes: GraphLayoutNode[], links: GraphLayoutLink[]): GraphLayout {
  if (nodes.length === 0) return { nodes: [], links: [], width: 0, height: 0 }
  const ids = new Set(nodes.map((n) => n.id))
  const validLinks = links.filter((l) => ids.has(l.source) && ids.has(l.target) && l.source !== l.target)
  const degree = new Map<string, number>()
  for (const l of validLinks) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
  }
  const radii = new Map(nodes.map((n) => [n.id, nodeRadius(n, degree.get(n.id) ?? 0)]))
  if (nodes.length === 1) {
    const only = nodes[0]!
    const out: LaidOutNode = { ...only, x: 120, y: 100, r: radii.get(only.id)! }
    return { nodes: [out], links: [], width: 240, height: 200 }
  }
  // 确定性初始坐标：输入序环形（黄金角步进，纯算术无随机）
  const init: SimNode[] = nodes.map((n, i) => ({
    node: n,
    r: radii.get(n.id)!,
    x: Math.cos(i * 2.399963) * (60 + i * 14),
    y: Math.sin(i * 2.399963) * (60 + i * 14),
  }))
  const byId = new Map(init.map((s) => [s.node.id, s]))
  const simLinks: Array<SimulationLinkDatum<SimNode>> = validLinks.map((l) => ({
    source: byId.get(l.source)!,
    target: byId.get(l.target)!,
  }))
  const sim = forceSimulation<SimNode>(init)
    .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks).id((d) => d.node.id).distance(GRAPH_LINK_DISTANCE))
    .force('charge', forceManyBody<SimNode>().strength(GRAPH_CHARGE))
    .force('collide', forceCollide<SimNode>().radius((d) => d.r + 10))
    .force('center', forceCenter<SimNode>(0, 0))
    .stop()
  sim.tick(GRAPH_TICKS)
  // NaN 兜底 + 包围盒平移至 (40,40)
  for (const s of init) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) {
      s.x = 0
      s.y = 0
    }
  }
  const minX = Math.min(...init.map((s) => s.x - s.r))
  const minY = Math.min(...init.map((s) => s.y - s.r))
  const maxX = Math.max(...init.map((s) => s.x + s.r))
  const maxY = Math.max(...init.map((s) => s.y + s.r))
  const outNodes: LaidOutNode[] = init.map((s) => ({
    ...s.node,
    x: Math.round(s.x - minX + 40),
    y: Math.round(s.y - minY + 40),
    r: Math.round(s.r),
  }))
  return {
    nodes: outNodes,
    links: validLinks.map((l) => ({ source: l.source, target: l.target, kind: l.kind })),
    width: Math.round(maxX - minX) + 80,
    height: Math.round(maxY - minY) + 80,
  }
}

// ===== graph-json 文档 → 节点/边推导（纯函数，探针直测）=====
// 输入 = novel-board graph.doc（{overview, characters[], key_events[]}）；脏 doc → null（前端降级表视图）。
// 边规则（spec §2.4 落地口径）：
// - sequence：关键事件按首个 chapter 升序（同值保持原序）相邻相连（因果时序链）；
// - member：角色名在事件 name+summary 文本中出现 → 角色—事件参与边（确定性子串启发，无新契约字段）。
export function deriveGraphNodesLinks(doc: unknown): { nodes: GraphLayoutNode[]; links: GraphLayoutLink[] } | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  const d = doc as { key_events?: unknown; characters?: unknown }
  if (!Array.isArray(d.key_events) || d.key_events.length === 0) return null
  const nodes: GraphLayoutNode[] = []
  const seen = new Set<string>()
  interface EvMeta {
    id: string
    first: number
    text: string
  }
  const evMeta: EvMeta[] = []
  for (const raw of d.key_events as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') continue
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) continue
    const id = `event:${name}`
    if (seen.has(id)) continue
    seen.add(id)
    const chapters = Array.isArray(raw.chapters) ? raw.chapters.filter((n): n is number => typeof n === 'number') : []
    const summary = typeof raw.summary === 'string' ? raw.summary : ''
    nodes.push({ id, kind: 'event', label: name, weight: chapters.length })
    evMeta.push({ id, first: chapters.length ? Math.min(...chapters) : Number.MAX_SAFE_INTEGER, text: `${name}\n${summary}` })
  }
  const charIds: Array<{ id: string; name: string }> = []
  if (Array.isArray(d.characters)) {
    for (const raw of d.characters as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== 'object') continue
      const name = typeof raw.name === 'string' ? raw.name.trim() : ''
      if (!name) continue
      const id = `char:${name}`
      if (seen.has(id)) continue
      seen.add(id)
      nodes.push({ id, kind: 'character', label: name })
      charIds.push({ id, name })
    }
  }
  const links: GraphLayoutLink[] = []
  const ordered = [...evMeta].sort((a, b) => a.first - b.first)
  for (let i = 1; i < ordered.length; i++) {
    links.push({ source: ordered[i - 1]!.id, target: ordered[i]!.id, kind: 'sequence' })
  }
  for (const ev of evMeta) {
    for (const ch of charIds) {
      if (ev.text.includes(ch.name)) links.push({ source: ch.id, target: ev.id, kind: 'member' })
    }
  }
  return { nodes, links }
}

/** doc → 布局（脏 doc/无事件 → null；确定性同 computeGraphLayout） */
export function layoutFromGraphDoc(doc: unknown): GraphLayout | null {
  const derived = deriveGraphNodesLinks(doc)
  if (!derived || derived.nodes.length === 0) return null
  return computeGraphLayout(derived.nodes, derived.links)
}
