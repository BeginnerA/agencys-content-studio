/**
 * [M15] 流水线画布布局层（CanvasBoard 拆分：M26 红线纯重构，逻辑逐字搬移）
 * - 层号 = sched 边拓扑最长路径松弛（防环最多 n 轮）；层内按 seq 垂直堆叠居中
 * - 边路径（锚点右中 → 左中）三次贝塞尔；running 节点入边 flowing 标记
 * 依赖仅 props.nodes/edges/mode；pan/zoom/编辑交互仍留组件内（共享 viewport/pan/zoom/selEdge refs）。
 */
import { computed } from 'vue'
import type { CanvasBoardNode, CanvasEdge } from '../../lib/types'

// ---- 常量（spec：节点卡 ~240×96、层距 300、行距 140）----
export const NODE_W = 240
export const NODE_H = 96
export const COL_GAP = 300
export const ROW_GAP = 140
export const PAD = 60

export interface EdgePath {
  k: string
  d: string
  type: 'sched' | 'data'
  flowing: boolean
  /** [M23] 编辑态边选中/删除定位用 */
  from: string
  to: string
}

export function useCanvasLayout(props: {
  nodes: CanvasBoardNode[]
  edges: CanvasEdge[]
  mode: 'run' | 'template'
}) {
  // ---- 布局：sched 边最长路径 ----
  const layout = computed(() => {
    const nodes = props.nodes
    const level = new Map<string, number>()
    for (const n of nodes) level.set(n.key, 0)
    const keySet = new Set(nodes.map((n) => n.key))
    const sched = props.edges.filter(
      (e) => e.type === 'sched' && keySet.has(e.from) && keySet.has(e.to),
    )
    for (let round = 0; round < nodes.length; round++) {
      let changed = false
      for (const e of sched) {
        const nv = level.get(e.from)! + 1
        if (nv > level.get(e.to)!) {
          level.set(e.to, nv)
          changed = true
        }
      }
      if (!changed) break
    }
    const byLevel = new Map<number, CanvasBoardNode[]>()
    for (const n of nodes) {
      const l = level.get(n.key)!
      if (!byLevel.has(l)) byLevel.set(l, [])
      byLevel.get(l)!.push(n)
    }
    let maxLevel = 0
    let maxRows = 1
    for (const [l, arr] of byLevel) {
      maxLevel = Math.max(maxLevel, l)
      maxRows = Math.max(maxRows, arr.length)
    }
    const pos = new Map<string, { x: number; y: number }>()
    for (const [l, arr] of byLevel) {
      arr.sort((a, b) => a.seq - b.seq)
      const off = ((maxRows - arr.length) * ROW_GAP) / 2
      arr.forEach((n, i) =>
        pos.set(n.key, { x: l * COL_GAP, y: off + i * ROW_GAP }),
      )
    }
    return {
      pos,
      width: maxLevel * COL_GAP + NODE_W,
      height: (maxRows - 1) * ROW_GAP + NODE_H,
    }
  })

  const worldW = computed(() => layout.value.width + PAD * 2)
  const worldH = computed(() => layout.value.height + PAD * 2)

  function nodeStyle(key: string): Record<string, string> {
    const p = layout.value.pos.get(key)
    if (!p) return { display: 'none' }
    return {
      left: `${PAD + p.x}px`,
      top: `${PAD + p.y}px`,
      width: `${NODE_W}px`,
      minHeight: `${NODE_H}px`,
    }
  }

  // ---- 边路径（锚点右中 → 左中）----
  const edgePaths = computed<EdgePath[]>(() => {
    const pos = layout.value.pos
    const statusByKey = new Map(props.nodes.map((n) => [n.key, n.status]))
    const out: EdgePath[] = []
    for (const e of props.edges) {
      const a = pos.get(e.from)
      const b = pos.get(e.to)
      if (!a || !b) continue
      const x1 = PAD + a.x + NODE_W
      const y1 = PAD + a.y + NODE_H / 2
      const x2 = PAD + b.x
      const y2 = PAD + b.y + NODE_H / 2
      const dx = Math.max(48, Math.abs(x2 - x1) / 2)
      out.push({
        k: `${e.from}|${e.to}|${e.type}`,
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        type: e.type,
        flowing:
          props.mode === 'run' &&
          e.type === 'sched' &&
          statusByKey.get(e.to) === 'running',
        from: e.from,
        to: e.to,
      })
    }
    // sched 在下、data 在上（同对混合双保留时数据边可见）
    return out.sort((a, b) =>
      a.type === b.type ? 0 : a.type === 'sched' ? -1 : 1,
    )
  })

  return { layout, worldW, worldH, nodeStyle, edgePaths }
}
