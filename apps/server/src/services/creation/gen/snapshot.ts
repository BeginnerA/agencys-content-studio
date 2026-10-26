/**
 * 画布任务执行快照（gen_tasks.exec_snapshot）。
 *
 * 为什么需要：并发槽位 ≤2 + 第三方长任务，使「点击执行」与「真正开始计费」之间存在可达分钟级的
 * 排队窗口。历史上任务行只冻结 prompt/params，执行期仍重读当前节点 spec 与当前连线——排队期间
 * 改配置或改连线，实际计费执行的是另一份输入。本模块把入队那一刻的 {spec, edges, plan} 整体冻结，
 * 执行期（含进程内自动重试）一律以快照为准；解码失败（存量行 / 结构漂移）→ null → 回落实时读取。
 */
import { parseNodeSpec, type InputPlan, type NodeSpec } from '../spec'

/** 入队冻结的三段：节点配置 + 入边 + 解析后的输入计划（与 preflightNode 同源） */
export interface CanvasExecSnapshot {
  spec: NodeSpec
  edges: Array<{ from: number; to: number; port: string }>
  plan: InputPlan
}

export function encodeExecSnapshot(snap: CanvasExecSnapshot): string {
  return JSON.stringify(snap)
}

/** 连线形状校验（仅取执行所需三字段，多余键丢弃） */
function edgesOf(raw: unknown): Array<{ from: number; to: number; port: string }> | null {
  if (!Array.isArray(raw)) return null
  const out: Array<{ from: number; to: number; port: string }> = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') return null
    const o = e as Record<string, unknown>
    const from = Number(o['from'])
    const to = Number(o['to'])
    const port = o['port']
    if (!Number.isInteger(from) || !Number.isInteger(to) || typeof port !== 'string') return null
    out.push({ from, to, port })
  }
  return out
}

/** 输入计划形状校验（planNodeInputs 产出的必需数组字段齐备才认） */
function planOf(raw: unknown): InputPlan | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const arrays = ['referenceAssetIds', 'videoAssetIds', 'audioAssetIds', 'textInputs', 'entitySources', 'problems', 'notes', 'textSources']
  if (!arrays.every((k) => Array.isArray(o[k]))) return null
  return raw as InputPlan
}

/**
 * 快照宽容解码：缺列 / 坏 JSON / spec 非法规 / 结构漂移 → null。
 * 返回 null 即回落实时读取（迁移前存量行的原行为），不阻断队列。
 */
export function decodeExecSnapshot(raw: string | null | undefined): CanvasExecSnapshot | null {
  if (!raw) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  let spec: NodeSpec
  try {
    spec = parseNodeSpec(o['spec'])
  } catch {
    return null
  }
  const edges = edgesOf(o['edges'])
  const plan = planOf(o['plan'])
  if (!edges || !plan) return null
  return { spec, edges, plan }
}
