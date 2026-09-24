/**
 * LLM 建议式编排（D11）：确定性摘要 + 输出归一（纯函数，探针直测）+ canvasAdvice 编排。
 * - buildCanvasSummary：CanvasDoc → 确定性 JSON 摘要（节点/边/组按 id 升序；gen 关键参数白名单 + excerpt 截断）；
 * - parseAdviceOutput：LLM 文本 → 归一建议（剥围栏 / kind 白名单归一 / targetNodeId 校验 / 条数截断；
 *   坏 JSON → 单条 raw 降级——宽容不炸）；
 * - canvasAdvice：摘要 + canvas-advice.md 提示词 + chatCompleteDetailed + 用量留痕（runId null，对齐
 * llm 节点 / prompt-expand 先例）；LLM 未配置→ LlmNotConfiguredError（路由 400 llm_unavailable，
 *   不生成假建议）。
 * 建议式红线：仅返回建议文本，不执行任何操作（执行式属另一范畴）。
 */
import { chatCompleteDetailed, loadPromptTemplate } from '../llm'
import { recordLlmUsage } from '../usage'
import { buildCanvasDoc } from './doc'
import { isGenSpec, type CanvasDoc, type CanvasDocNode, type NodeSpec } from './spec'

// ---------- 摘要（纯函数） ----------

/** 节点 excerpt（提示词/文本）截断长度（控摘要体积） */
export const SUMMARY_EXCERPT_MAX = 120

/** 建议 kind 白名单（LLM 输出约束；'raw' 为解析降级标记，不属白名单） */
export const ADVICE_KINDS = ['structure', 'connect', 'config', 'generate', 'cleanup'] as const
export type AdviceKind = (typeof ADVICE_KINDS)[number]

/** 建议条数上限（超出截断） */
export const MAX_ADVICE_ITEMS = 20

/** 单条 detail 长度上限（防灌水；raw 降级同口径） */
export const MAX_ADVICE_DETAIL = 2000

export interface CanvasSummaryNode {
  id: number
  kind: string
  title: string
  groupId: number | null
  /** gen/text：提示词或文本摘要（trim 后截断 ≤120） */
  excerpt?: string
  /** gen 关键参数（白名单字段） */
  gen?: { genKind: string; provider?: string; model?: string; size?: string; duration?: number }
  /** gen：最新任务状态 */
  status?: string
  /** readiness 预检问题（宽松 notes 不入摘要） */
  problems?: string[]
}

export interface CanvasSummary {
  canvas: { id: number; name: string; nodeCount: number; edgeCount: number }
  nodes: CanvasSummaryNode[]
  edges: Array<{ from: number; to: number; port: string }>
  groups: Array<{ id: number; title: string; parentId: number | null; nodeCount: number }>
  kindCount: Record<string, number>
  taskStatus: Record<string, number>
}

/** CanvasDoc → 确定性摘要（节点/边/组按 id 升序；同输入同输出——探针直测） */
export function buildCanvasSummary(doc: CanvasDoc): CanvasSummary {
  const sorted = [...doc.nodes].sort((a, b) => a.id - b.id)
  const nodes = sorted.map(summaryNode)
  const edges = [...doc.edges].sort((a, b) => a.id - b.id).map((e) => ({ from: e.from, to: e.to, port: e.port }))
  const memberCount = new Map<number, number>()
  for (const n of doc.nodes) {
    if (n.groupId != null) memberCount.set(n.groupId, (memberCount.get(n.groupId) ?? 0) + 1)
  }
  const groups = [...doc.groups]
    .sort((a, b) => a.id - b.id)
    .map((g) => ({ id: g.id, title: g.title, parentId: g.parentId ?? null, nodeCount: memberCount.get(g.id) ?? 0 }))
  const kindCount: Record<string, number> = {}
  const taskStatus: Record<string, number> = {}
  for (const n of sorted) {
    kindCount[n.kind] = (kindCount[n.kind] ?? 0) + 1
    if (n.kind === 'gen' && n.status) taskStatus[n.status] = (taskStatus[n.status] ?? 0) + 1
  }
  return {
    canvas: { id: doc.canvas.id, name: doc.canvas.name, nodeCount: doc.nodes.length, edgeCount: doc.edges.length },
    nodes,
    edges,
    groups,
    kindCount,
    taskStatus,
  }
}

function summaryNode(n: CanvasDocNode): CanvasSummaryNode {
  const out: CanvasSummaryNode = { id: n.id, kind: n.kind, title: n.title, groupId: n.groupId ?? null }
  if (n.kind === 'gen') {
    const spec = isGenSpec(n.spec) ? (n.spec as NodeSpec) : null
    if (spec) {
      const gen: NonNullable<CanvasSummaryNode['gen']> = { genKind: spec.genKind }
      if (spec.provider) gen.provider = spec.provider
      if (spec.model) gen.model = spec.model
      if (spec.size) gen.size = spec.size
      if (spec.duration !== undefined) gen.duration = spec.duration
      out.gen = gen
      const prompt = spec.prompt.trim()
      if (prompt) out.excerpt = prompt.slice(0, SUMMARY_EXCERPT_MAX)
    }
    if (n.status) out.status = n.status
  } else if (n.kind === 'text') {
    const t = (n.spec as { text?: unknown } | null)?.text
    if (typeof t === 'string' && t.trim()) out.excerpt = t.trim().slice(0, SUMMARY_EXCERPT_MAX)
  }
  const problems = n.readiness?.problems
  if (problems && problems.length > 0) out.problems = [...problems]
  return out
}

// ---------- 输出解析（纯函数） ----------

/** 归一建议项（'raw' = 解析失败降级的原文单条） */
export interface CanvasAdviceItem {
  kind: AdviceKind | 'raw'
  targetNodeId?: number
  title: string
  detail: string
}

export interface AdviceParseResult {
  advice: CanvasAdviceItem[]
  mode: 'json' | 'raw'
}

/** LLM 文本 → 归一建议（坏 JSON/非数组 → 单条 raw 降级；坏项丢弃；条数截断；kind 非法归一 'config'） */
export function parseAdviceOutput(raw: string, validNodeIds: ReadonlySet<number>): AdviceParseResult {
  const text = raw.trim()
  if (!text) return { advice: [], mode: 'raw' }
  let data: unknown
  try {
    data = JSON.parse(stripCodeFence(text))
  } catch {
    return { advice: [rawItem(text)], mode: 'raw' }
  }
  if (!Array.isArray(data)) return { advice: [rawItem(text)], mode: 'raw' }
  return { advice: normalizeAdviceItems(data, validNodeIds), mode: 'json' }
}

function normalizeAdviceItems(items: unknown[], validNodeIds: ReadonlySet<number>): CanvasAdviceItem[] {
  const out: CanvasAdviceItem[] = []
  for (const it of items) {
    if (out.length >= MAX_ADVICE_ITEMS) break
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue
    const o = it as Record<string, unknown>
    const title = typeof o['title'] === 'string' ? o['title'].trim() : ''
    const detail = typeof o['detail'] === 'string' ? o['detail'].trim() : ''
    if (!title || !detail) continue
    const kindRaw = String(o['kind'] ?? '')
    const kind: CanvasAdviceItem['kind'] = (ADVICE_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as AdviceKind)
      : 'config'
    const item: CanvasAdviceItem = { kind, title: title.slice(0, 80), detail: detail.slice(0, MAX_ADVICE_DETAIL) }
    const tid = o['targetNodeId']
    if (typeof tid === 'number' && Number.isInteger(tid) && validNodeIds.has(tid)) item.targetNodeId = tid
    out.push(item)
  }
  return out
}

function rawItem(text: string): CanvasAdviceItem {
  return { kind: 'raw', title: 'LLM 原始输出（未解析为 JSON）', detail: text.slice(0, MAX_ADVICE_DETAIL) }
}

/** 剥 markdown 代码围栏（```json … ``` / ``` … ```；非围栏原样返回） */
function stripCodeFence(text: string): string {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text)
  return m ? m[1]!.trim() : text
}

// ---------- 服务编排（IO） ----------

export interface CanvasAdviceResult {
  advice: CanvasAdviceItem[]
  /** json = 结构化归一成功；raw = 原文降级 */
  mode: 'json' | 'raw'
  provider: string
  model: string
  usage: { tokensIn: number; tokensOut: number } | null
}

/**
 * 画布建议（LLM 建议式；不执行）：确定性摘要 → canvas-advice.md → chatCompleteDetailed → 归一 → 用量留痕。
 * 画布缺失 → null（路由 404）；LLM 未配置 → LlmNotConfiguredError（路由 400 llm_unavailable）。
 */
export async function canvasAdvice(canvasId: number): Promise<CanvasAdviceResult | null> {
  const doc = await buildCanvasDoc(canvasId)
  if (!doc) return null
  const summary = buildCanvasSummary(doc)
  const res = await chatCompleteDetailed(
    [
      { role: 'system', content: loadPromptTemplate('canvas-advice.md') },
      { role: 'user', content: `画布摘要 JSON：\n${JSON.stringify(summary, null, 2)}` },
    ],
    undefined,
    { maxTokens: 3000 },
  )
  const parsed = parseAdviceOutput(res.content, new Set(doc.nodes.map((n) => n.id)))
  await recordLlmUsage({ projectId: doc.canvas.projectId, runId: null, provider: res.provider, model: res.model, usage: res.usage })
  return {
    advice: parsed.advice,
    mode: parsed.mode,
    provider: res.provider,
    model: res.model,
    usage: res.usage ? { tokensIn: res.usage.promptTokens, tokensOut: res.usage.completionTokens } : null,
  }
}
