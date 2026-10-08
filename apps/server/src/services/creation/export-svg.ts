/**
 * 画布布局图导出（SVG 纯函数）：全节点包围盒视口 + 组框（先外层）+ 边贝塞尔 + 节点卡片。
 * - 零新依赖（字符串拼接； 手绘 SVG 边先例哲学）；
 * - 布局参数与前端 board 对齐：节点卡宽 220 / 高度缺省 140（静态快照无 DOM 实测）；边 = 源右中 → 目标左中
 *   三次贝塞尔（dx = max(48, |Δx|/2)，与 internals.bezier 同公式）；组框包围盒公式同前端 groupBox；
 * - 视觉近似：kind/genKind 色板常量表（前端 CSS 变量不可达，取近似色值）；组框取组色近似；
 * - 折叠态忽略（导出 = 全展开布局快照，信息不丢失）；
 * - XML 转义全字段（& < > " '）；标题截断 16 字符。
 * 依赖方向：export-svg → spec（仅类型）；零网络、零 DB。
 */
import type { CanvasDoc, CanvasDocGroup, CanvasDocNode } from './spec'

// ---------- 常量（探针断言直用） ----------

/** 视口留白 */
export const SVG_PADDING = 40
/** 节点卡宽（与前端 NODE_W 对齐） */
export const SVG_NODE_W = 220
/** 节点卡高（静态快照缺省；与前端 DEFAULT_H 对齐） */
export const SVG_NODE_H = 140
/** 标题截断长度 */
export const SVG_TITLE_MAX = 16
/** 背景色 */
export const SVG_BG = '#fafafa'
/** 边色（与前端 .cb-edge 对齐近似） */
export const SVG_EDGE_COLOR = '#94a3b8'
/** 空画布视口兜底（与前端 svgBox 初值一致） */
export const SVG_MIN_BOX = { x: 0, y: 0, w: 900, h: 640 }

/** kind/genKind 近似色板（结构断言优先，色值近似前端节点视觉） */
export const SVG_KIND_COLORS: Record<string, string> = {
  asset: '#64748b',
  'gen:image': '#8b5cf6',
  'gen:video': '#3b82f6',
  'gen:audio': '#10b981',
  'gen:compose': '#f59e0b',
  'gen:llm': '#06b6d4',
  text: '#eab308',
  entity: '#ec4899',
  run: '#ef4444',
}

/** 组色近似表（前端 GROUP_COLORS 枚举；缺省灰） */
export const SVG_GROUP_COLORS: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  green: '#22c55e',
  teal: '#14b8a6',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  gray: '#64748b',
}

// ---------- 纯函数工具 ----------

/** XML 转义（& < > " '；全字段过） */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 标题截断（>16 → 前 16 + …） */
export function truncTitle(t: string): string {
  return t.length > SVG_TITLE_MAX ? `${t.slice(0, SVG_TITLE_MAX)}…` : t
}

/** 节点颜色：gen 用 spec.genKind 细分；未知 → 灰 */
export function svgNodeColor(n: Pick<CanvasDocNode, 'kind' | 'spec'>): string {
  if (n.kind === 'gen') {
    const spec = n.spec
    const gk = spec && typeof spec === 'object' && 'genKind' in spec ? String((spec as { genKind?: unknown }).genKind) : ''
    return SVG_KIND_COLORS[`gen:${gk}`] ?? SVG_KIND_COLORS['gen:image']!
  }
  return SVG_KIND_COLORS[n.kind] ?? '#64748b'
}

/** 边三次贝塞尔（与前端 internals.bezier 同公式：dx = max(48, |x2-x1|/2)） */
export function svgBezier(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(48, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

/** 节点高度（静态快照统一缺省——无 DOM 实测） */
export function svgNodeH(_n: CanvasDocNode): number {
  return SVG_NODE_H
}

// ---------- 组框（嵌套递归：包围盒 = 全部后代组成员节点并集；空组退化存储坐标） ----------

export interface SvgGroupBox {
  id: number
  title: string
  color: string
  depth: number
  x: number
  y: number
  w: number
  h: number
}

/** 组深度（parentId 链；守卫防环） */
function groupDepthOf(g: CanvasDocGroup, byId: Map<number, CanvasDocGroup>): number {
  let d = 0
  let cur = g
  let guard = 0
  while (cur.parentId != null && guard < 100) {
    const p = byId.get(cur.parentId)
    if (!p) break
    d += 1
    cur = p
    guard += 1
  }
  return d
}

/** 全部后代组 id（不含自身；栈式 + 守卫防环） */
function descGroupIdsOf(gid: number, childrenOf: Map<number, CanvasDocGroup[]>): number[] {
  const out: number[] = []
  const stack = [gid]
  let guard = 0
  while (stack.length && guard < 1000) {
    const cur = stack.pop()!
    for (const c of childrenOf.get(cur) ?? []) {
      out.push(c.id)
      stack.push(c.id)
    }
    guard += 1
  }
  return out
}

/** 组框集合（depth 升序 = 先画外层） */
export function computeSvgGroupBoxes(nodes: CanvasDocNode[], groups: CanvasDocGroup[]): SvgGroupBox[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const childrenOf = new Map<number, CanvasDocGroup[]>()
  for (const g of groups) {
    if (g.parentId == null) continue
    const arr = childrenOf.get(g.parentId) ?? []
    arr.push(g)
    childrenOf.set(g.parentId, arr)
  }
  const boxes: SvgGroupBox[] = []
  for (const g of groups) {
    const subtree = new Set<number>([g.id, ...descGroupIdsOf(g.id, childrenOf)])
    const members = nodes.filter((n) => n.groupId != null && subtree.has(n.groupId))
    let box: { x: number; y: number; w: number; h: number }
    if (members.length) {
      let mnX = Infinity
      let mnY = Infinity
      let mxX = -Infinity
      let mxY = -Infinity
      for (const n of members) {
        mnX = Math.min(mnX, n.x)
        mnY = Math.min(mnY, n.y)
        mxX = Math.max(mxX, n.x + SVG_NODE_W)
        mxY = Math.max(mxY, n.y + svgNodeH(n))
      }
      box = { x: mnX - 12, y: mnY - 34, w: mxX - mnX + 24, h: mxY - mnY + 46 }
    } else {
      // 空组：存储 x/y 显示（对齐前端先例）
      box = { x: g.x, y: g.y, w: SVG_NODE_W, h: 120 }
    }
    boxes.push({
      id: g.id,
      title: g.title,
      color: SVG_GROUP_COLORS[g.color ?? ''] ?? '#64748b',
      depth: groupDepthOf(g, byId),
      ...box,
    })
  }
  boxes.sort((a, b) => a.depth - b.depth || a.id - b.id)
  return boxes
}

// ---------- 主函数 ----------

/**
 * 布局图 SVG（纯函数）：空画布 → 兜底视口 900×640；有节点 → 节点 ∪ 组框包围盒 + 40 padding。
 * 渲染序：背景 → 组框（外层先）→ 边 → 节点。
 */
export function buildCanvasSvg(doc: CanvasDoc): string {
  const { nodes, edges } = doc
  const groupBoxes = computeSvgGroupBoxes(nodes, doc.groups)

  // 视口：初值取前端兜底；并入节点与组框
  let mnX = SVG_MIN_BOX.x
  let mnY = SVG_MIN_BOX.y
  let mxX = SVG_MIN_BOX.x + SVG_MIN_BOX.w
  let mxY = SVG_MIN_BOX.y + SVG_MIN_BOX.h
  for (const n of nodes) {
    mnX = Math.min(mnX, n.x)
    mnY = Math.min(mnY, n.y)
    mxX = Math.max(mxX, n.x + SVG_NODE_W)
    mxY = Math.max(mxY, n.y + svgNodeH(n))
  }
  for (const b of groupBoxes) {
    mnX = Math.min(mnX, b.x)
    mnY = Math.min(mnY, b.y)
    mxX = Math.max(mxX, b.x + b.w)
    mxY = Math.max(mxY, b.y + b.h)
  }
  const vx = mnX - SVG_PADDING
  const vy = mnY - SVG_PADDING
  const vw = mxX - mnX + SVG_PADDING * 2
  const vh = mxY - mnY + SVG_PADDING * 2

  const pos = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, h: svgNodeH(n) }]))
  const parts: string[] = []

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif">`,
  )
  parts.push(
    `<defs><marker id="edge-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${SVG_EDGE_COLOR}"/></marker></defs>`,
  )
  parts.push(`<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${SVG_BG}"/>`)

  // 组框（depth 升序 = 先外层）
  for (const b of groupBoxes) {
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12" fill="${b.color}" fill-opacity="0.06" stroke="${b.color}" stroke-opacity="0.55" stroke-width="1.5" stroke-dasharray="6 4"/>`,
    )
    parts.push(
      `<text x="${b.x + 10}" y="${b.y + 18}" font-size="12" font-weight="600" fill="#475569">${xmlEscape(truncTitle(b.title))}</text>`,
    )
  }

  // 边：源右中 → 目标左中
  for (const e of edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    const d = svgBezier(a.x + SVG_NODE_W, a.y + a.h / 2, b.x, b.y + b.h / 2)
    parts.push(
      `<path d="${d}" fill="none" stroke="${SVG_EDGE_COLOR}" stroke-opacity="0.58" stroke-width="1.7" marker-end="url(#edge-arrow)"/>`,
    )
  }

  // 节点卡：底部矩形 + 顶部圆角头部条 + 标题 + 两侧端口圆点
  for (const n of nodes) {
    const p = pos.get(n.id)!
    const c = svgNodeColor(n)
    const x2 = p.x + SVG_NODE_W
    parts.push(`<g>`)
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${SVG_NODE_W}" height="${p.h}" rx="8" fill="#ffffff" stroke="${c}" stroke-width="1.5"/>`)
    parts.push(
      `<path d="M ${p.x} ${p.y + 24} L ${p.x} ${p.y + 8} Q ${p.x} ${p.y} ${p.x + 8} ${p.y} L ${x2 - 8} ${p.y} Q ${x2} ${p.y} ${x2} ${p.y + 8} L ${x2} ${p.y + 24} Z" fill="${c}"/>`,
    )
    parts.push(
      `<text x="${p.x + 10}" y="${p.y + 16}" font-size="12" font-weight="600" fill="#ffffff">${xmlEscape(truncTitle(n.title))}</text>`,
    )
    parts.push(`<circle cx="${p.x}" cy="${p.y + p.h / 2}" r="3" fill="${c}"/>`)
    parts.push(`<circle cx="${x2}" cy="${p.y + p.h / 2}" r="3" fill="${c}"/>`)
    parts.push(`</g>`)
  }

  parts.push(`</svg>`)
  return parts.join('\n')
}
