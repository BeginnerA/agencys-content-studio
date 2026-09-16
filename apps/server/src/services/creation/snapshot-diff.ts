/**
 * [M22] 快照文档 diff 纯函数（spec §2.5）：
 * - 按行 id 匹配 → nodes/edges/groups × { added, removed, modified }（三表键浅比较 JSON 值）
 * - modified.changes: [{ field, before, after }]；展示值截断（字符串 >200 字符加省略；对象 stringify 后同规则）
 * - summary 计数；探针直测（不触库）。
 * 注：undefined 与 null 视同（旧快照缺列 vs 新行 NULL 不误报 modified）。
 */
import type { CanvasSnapshotDoc } from './snapshots'

export type SnapshotDiffKind = 'node' | 'edge' | 'group'

/** 单项字段变更（值经 clampDiffValue 截断） */
export interface SnapshotDiffChange {
  field: string
  before: unknown
  after: unknown
}

/** 行级变更条目（modified 用） */
export interface SnapshotDiffEntry {
  id: number
  title: string
  changes: SnapshotDiffChange[]
}

/** 行级简单条目（added/removed 用） */
export interface SnapshotDiffItem {
  id: number
  title: string
}

export interface SnapshotDiffBucket {
  added: SnapshotDiffItem[]
  removed: SnapshotDiffItem[]
  modified: SnapshotDiffEntry[]
}

export interface SnapshotDiffSummary {
  nodes: { added: number; removed: number; modified: number }
  edges: { added: number; removed: number; modified: number }
  groups: { added: number; removed: number; modified: number }
}

export interface SnapshotDiff {
  summary: SnapshotDiffSummary
  nodes: SnapshotDiffBucket
  edges: SnapshotDiffBucket
  groups: SnapshotDiffBucket
}

/** 展示截断阈值（字符数） */
const MAX_SHOW = 200

/** 展示值截断：字符串超长加省略号；对象先 stringify（超长 → 截断字符串，未超保留结构） */
export function clampDiffValue(v: unknown): unknown {
  if (typeof v === 'string') return v.length > MAX_SHOW ? `${v.slice(0, MAX_SHOW)}…` : v
  if (v !== null && typeof v === 'object') {
    const s = JSON.stringify(v)
    if (s.length > MAX_SHOW) return `${s.slice(0, MAX_SHOW)}…`
    return v
  }
  return v
}

/** 行标题：node/group 取 title；edge 取 `#from→#to(port)` */
function titleOf(kind: SnapshotDiffKind, row: Record<string, unknown>): string {
  if (kind === 'edge') return `#${row['from']}→#${row['to']}(${row['port']})`
  return typeof row['title'] === 'string' && row['title'] ? row['title'] : `#${row['id']}`
}

/** 行字段浅比较（排除 id；undefined/null 视同） */
function diffRow(base: Record<string, unknown>, target: Record<string, unknown>): SnapshotDiffChange[] {
  const keys = new Set([...Object.keys(base), ...Object.keys(target)])
  const out: SnapshotDiffChange[] = []
  for (const k of keys) {
    if (k === 'id') continue
    const b = base[k] ?? null
    const a = target[k] ?? null
    if (JSON.stringify(b) === JSON.stringify(a)) continue
    out.push({ field: k, before: clampDiffValue(b), after: clampDiffValue(a) })
  }
  out.sort((x, y) => x.field.localeCompare(y.field))
  return out
}

function diffBucket(baseRows: Array<Record<string, unknown>>, targetRows: Array<Record<string, unknown>>, kind: SnapshotDiffKind): SnapshotDiffBucket {
  const baseMap = new Map(baseRows.map((r) => [Number(r['id']), r]))
  const targetMap = new Map(targetRows.map((r) => [Number(r['id']), r]))
  const added: SnapshotDiffItem[] = []
  const removed: SnapshotDiffItem[] = []
  const modified: SnapshotDiffEntry[] = []
  for (const [id, row] of targetMap) if (!baseMap.has(id)) added.push({ id, title: titleOf(kind, row) })
  for (const [id, row] of baseMap) if (!targetMap.has(id)) removed.push({ id, title: titleOf(kind, row) })
  for (const [id, bRow] of baseMap) {
    const tRow = targetMap.get(id)
    if (!tRow) continue
    const changes = diffRow(bRow, tRow)
    if (changes.length > 0) modified.push({ id, title: titleOf(kind, tRow), changes })
  }
  const byId = (x: { id: number }, y: { id: number }): number => x.id - y.id
  added.sort(byId)
  removed.sort(byId)
  modified.sort(byId)
  return { added, removed, modified }
}

/** 主入口：base（基准）→ target（目标）的文档级差异 */
export function diffSnapshotDocs(base: CanvasSnapshotDoc, target: CanvasSnapshotDoc): SnapshotDiff {
  const nodes = diffBucket(
    base.nodes as unknown as Array<Record<string, unknown>>,
    target.nodes as unknown as Array<Record<string, unknown>>,
    'node',
  )
  const edges = diffBucket(
    base.edges as unknown as Array<Record<string, unknown>>,
    target.edges as unknown as Array<Record<string, unknown>>,
    'edge',
  )
  const groups = diffBucket(
    base.groups as unknown as Array<Record<string, unknown>>,
    target.groups as unknown as Array<Record<string, unknown>>,
    'group',
  )
  const count = (b: SnapshotDiffBucket): { added: number; removed: number; modified: number } => ({
    added: b.added.length,
    removed: b.removed.length,
    modified: b.modified.length,
  })
  return { summary: { nodes: count(nodes), edges: count(edges), groups: count(groups) }, nodes, edges, groups }
}
