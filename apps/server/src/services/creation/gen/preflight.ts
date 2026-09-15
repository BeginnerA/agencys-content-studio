import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../../db'
import { assets, canvasEdges, canvasNodes, genTasks } from '../../../db/schema'
import type { Canvas, CanvasNode } from '../../../db/schema'
import { resolveLlmEndpoint } from '../../llm'
import { resolveAudioEndpoint } from '../../tts'
import { resolveUnitPrice, type UsageKind, type UsageUnit } from '../../usage'
import { loadInputPlan } from '../inputs'
import { canvasOfNode, findNode } from '../nodes'
import { safeParseSpec, specProblems, type InputPlan, type NodeSpec } from '../spec'

// ---------- 启动执行 ----------

/** [M18] 节点预检（spec/输入计划/问题清单一次性解析）——startCanvasNodeRun 与 run-preview 共用 */
export interface NodePreflight {
  node: CanvasNode
  canvas: Canvas
  spec: NodeSpec
  plan: InputPlan
  problems: string[]
}

export async function preflightNode(nodeId: number): Promise<NodePreflight> {
  const node = await findNode(nodeId)
  if (!node) throw new Error(`画布节点 ${nodeId} 不存在`)
  if (node.kind !== 'gen') throw new Error('仅生成节点可执行')
  const canvas = await canvasOfNode(nodeId)
  if (!canvas) throw new Error('画布不存在')
  const parsed = safeParseSpec(node.spec)
  if (!parsed.spec) throw new Error(`节点不可执行：${parsed.error}`)
  const spec = parsed.spec
  const incoming = await db
    .select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port })
    .from(canvasEdges)
    .where(eq(canvasEdges.to, nodeId))
  const plan = await loadInputPlan(node, incoming, spec)
  const problems = [...specProblems(spec, plan.promptText != null), ...plan.problems]
  if (spec.edit?.maskAssetId) {
    const m = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, spec.edit.maskAssetId), eq(assets.projectId, canvas.projectId)))
      .limit(1)
    if (!m[0]) problems.push(`蒙版资产 #${spec.edit.maskAssetId} 不存在或不属于项目`)
  }
  if (spec.bgmAssetId != null) {
    const b = await db
      .select({ id: assets.id, kind: assets.kind, deletedAt: assets.deletedAt })
      .from(assets)
      .where(and(eq(assets.id, spec.bgmAssetId), eq(assets.projectId, canvas.projectId)))
      .limit(1)
    if (!b[0] || b[0].deletedAt != null || b[0].kind !== 'audio') problems.push(`BGM 资产 #${spec.bgmAssetId} 不存在或不是本项目音频`)
  }
  if (spec.genKind === 'llm') {
    // [M18] LLM 未配置 → readiness problem 引导 Settings（口径与 chatCompleteDetailed 抛错一致）
    const ep = await resolveLlmEndpoint()
    if (!ep.baseUrl || !ep.apiKey) {
      problems.push('LLM 未配置：请在 Settings → AI 配置检查 llm 实例（或 .env 设置 AGENT_LLM_BASE_URL/AGENT_LLM_API_KEY）')
    }
  }
  return { node, canvas, spec, plan, problems }
}

// ---------- [M18] 执行成本预估 ----------

/** [M18] 预估单行（unit 行；unitPrice/subtotal 为 null = 未计价） */
export interface PreviewUnitLine {
  unit: UsageUnit
  quantity: number
  unitPrice: number | null
  subtotal: number | null
}

/** [M18] 预估节点条目（ready = 无 problems 且非 busy） */
export interface PreviewNodeItem {
  nodeId: number
  title: string
  genKind: string
  ready: boolean
  busy: boolean
  problems: string[]
  units: PreviewUnitLine[]
  total: number | null
  unpriced: boolean
}

/** [M18] 预估响应（total.amount 仅含有价节点；unpriced = 未计价节点数） */
export interface PreviewCanvasResult {
  nodes: PreviewNodeItem[]
  total: { amount: number; unpriced: number; ready: number; blocked: number; busy: number }
}

/**
 * [M18] 画布执行成本预估（零副作用：不建任务、不发外部请求）：
 * - 节点集合：nodeIds 缺省 = 全部 gen 节点；显式 → 去重正整数（画布域校验）；
 * - 单位矩阵：image → 1 张；video → spec.duration ?? 5 秒；audio → 指令文本字数（promptText ?? spec.prompt）；
 *   compose → 本地零成本（total=0）；llm → unpriced（tokens 不可预知，前端显示「按量计费」）；
 * - 单价链：resolveUnitPrice（实例级 → settings.pricing → null）与 recordUsage 快照同源；
 * - 就绪性复用 preflightNode（与 startCanvasNodeRun 同源）。
 */
export async function previewCanvasRun(canvas: Canvas, nodeIds?: unknown): Promise<PreviewCanvasResult> {
  let ids: number[]
  if (nodeIds === undefined || nodeIds === null) {
    const rows = await db
      .select({ id: canvasNodes.id })
      .from(canvasNodes)
      .where(and(eq(canvasNodes.canvasId, canvas.id), eq(canvasNodes.kind, 'gen')))
    ids = rows.map((r) => r.id)
  } else {
    if (!Array.isArray(nodeIds)) throw new Error('nodeIds 需为正整数数组')
    ids = [...new Set(nodeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    if (ids.length === 0) throw new Error('nodeIds 需为正整数数组')
  }
  const busySet = new Set<number | null>(
    ids.length === 0
      ? []
      : (
          await db
            .select({ nodeId: genTasks.canvasNodeId })
            .from(genTasks)
            .where(and(inArray(genTasks.canvasNodeId, ids), inArray(genTasks.status, ['pending', 'processing'])))
        ).map((r) => r.nodeId),
  )

  const items: PreviewNodeItem[] = []
  for (const id of ids) {
    let pf: NodePreflight
    try {
      pf = await preflightNode(id)
      if (pf.canvas.id !== canvas.id) throw new Error(`节点 #${id} 不属于该画布`)
    } catch (err) {
      items.push({
        nodeId: id,
        title: `#${id}`,
        genKind: '',
        ready: false,
        busy: false,
        problems: [(err as Error).message],
        units: [],
        total: null,
        unpriced: false,
      })
      continue
    }
    const units: PreviewUnitLine[] = []
    let unpriced = false
    const pushUnit = async (
      kind: UsageKind,
      unit: UsageUnit,
      quantity: number,
      provider: string | null,
      model: string | null,
    ): Promise<void> => {
      const unitPrice = await resolveUnitPrice({ kind, provider, model, unit })
      const subtotal = unitPrice === null ? null : Math.round(quantity * unitPrice * 1e6) / 1e6
      if (unitPrice === null) unpriced = true
      units.push({ unit, quantity, unitPrice, subtotal })
    }
    if (pf.problems.length === 0) {
      if (pf.spec.genKind === 'image') {
        await pushUnit('image', 'image', 1, pf.spec.provider ?? null, pf.spec.model ?? null)
      } else if (pf.spec.genKind === 'video') {
        const duration = typeof pf.spec.duration === 'number' && pf.spec.duration > 0 ? pf.spec.duration : 5
        await pushUnit('video', 'second', duration, pf.spec.provider ?? null, pf.spec.model ?? null)
      } else if (pf.spec.genKind === 'audio') {
        const text = (pf.plan.promptText ?? pf.spec.prompt).trim()
        let provider = pf.spec.provider ?? null
        let model = pf.spec.model ?? null
        try {
          const endpoint = await resolveAudioEndpoint(pf.spec.provider)
          provider = endpoint.providerKey
          model = endpoint.model
        } catch { /* 音频端点未配置 → 退回 spec 声明（未命中即 unpriced） */ }
        await pushUnit('tts', 'char', text.length, provider, model)
      } else if ((pf.spec.genKind as string) === 'llm') {
        unpriced = true // [P4] tokens 不可预知（按量计费）
      }
      // compose：本地零成本（units 空 → total=0）
    }
    const busy = busySet.has(id)
    let total: number | null = null
    if (units.length > 0) {
      total = units.every((u) => u.subtotal != null)
        ? Math.round(units.reduce((s, u) => s + (u.subtotal ?? 0), 0) * 1e6) / 1e6
        : null
    } else if (pf.spec.genKind === 'compose') {
      total = 0
    }
    items.push({
      nodeId: id,
      title: pf.node.title ?? `#${id}`,
      genKind: pf.spec.genKind,
      ready: pf.problems.length === 0 && !busy,
      busy,
      problems: pf.problems,
      units,
      total,
      unpriced,
    })
  }

  const total = {
    amount: Math.round(items.reduce((s, it) => s + (it.total ?? 0), 0) * 1e6) / 1e6,
    unpriced: items.filter((it) => it.unpriced).length,
    ready: items.filter((it) => it.ready).length,
    blocked: items.filter((it) => !it.ready && !it.busy).length,
    busy: items.filter((it) => it.busy).length,
  }
  return { nodes: items, total }
}
