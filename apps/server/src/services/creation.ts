import { readFileSync } from 'node:fs'
import { and, asc, count, desc, eq, inArray, or } from 'drizzle-orm'
import { db } from '../db'
import { assets, canvasEdges, canvasNodes, canvases, characters, genTasks, pipelineRuns, pipelineSteps } from '../db/schema'
import type { Canvas, CanvasEdge, CanvasNode } from '../db/schema'
import { getImageAdapter, resolveEndpoint } from '../adapters/provider'
import { validateTemplateText, type TemplateValidation } from '../pipeline/loader'
import { assertProjectAssets } from '../pipeline/refs'
import { absPathOf } from './storage'

/**
 * [M16/M17] 创作画布文档层（写模型）：
 * - buildCanvasDoc：画布全量读模型——节点状态/结果零存量，由 gen_tasks（canvasNodeId）派生；[M17] 全型节点
 *   （asset|gen|text|entity|run）与端口矩阵 v2（prompt/video/audio + entity 源）、采纳优先（pickDisplayTask）、
 *   结果画廊（results）、run 节点运行摘要；
 * - CRUD + 端口规则矩阵校验（含环检测 + [M17] from 侧类型校验）；duplicate 深拷；buildTemplateDraft 低保真草案导出；
 * - [M17] extractTextNode：从 gen（spec.prompt）或文本资产提取文本节点；
 * - 执行通道见 services/creation-gen.ts（本文件零网络、零适配器调用）。
 * 宽容降级：坏 spec / 上游缺产物 / 实体超限截断 → readiness problems/notes 列出（不炸）。
 */

// ---------- 常量与类型 ----------

export const NODE_KINDS = ['asset', 'gen', 'text', 'entity', 'run'] as const
export type NodeKind = (typeof NODE_KINDS)[number]

/** [M17] gen 节点生成类型（audio=配音；compose=视频合成） */
export const GEN_KINDS = ['image', 'video', 'audio', 'compose'] as const
export type GenKind = (typeof GEN_KINDS)[number]

export const EDGE_PORTS = ['reference', 'first_frame', 'last_frame', 'source', 'prompt', 'video', 'audio'] as const
export type EdgePort = (typeof EDGE_PORTS)[number]

export const EDIT_MODES = ['inpaint', 'erase', 'outpaint'] as const
export type EditMode = (typeof EDIT_MODES)[number]

/** 参考图端口容量（图片 ≤6 / 视频 ≤2；镜像 ai_image / ai_video 单镜参考图上限） */
export const REF_CAP: Record<'image' | 'video', number> = { image: 6, video: 2 }

/** [M17] 合成节点单端口输入上限（video / audio 各 ≤4） */
export const COMPOSE_CAP = 4

export interface NodeSpecEdit {
  mode: EditMode
  maskAssetId?: number
  expand?: { angle?: number; xScale?: number; yScale?: number }
}

export interface NodeSpec {
  genKind: GenKind
  prompt: string
  size?: string
  duration?: number
  resolution?: string
  aspectRatio?: string
  /** [M17] 输出帧率（仅 compose 有意义） */
  fps?: number
  /** [M17] 声线令牌（仅 audio；全 ASCII 供应商枚举，语义短语经 resolveVoiceChain 降级） */
  voice?: string
  /** [M17] 语速（仅 audio，0.25-4） */
  speed?: number
  provider?: string
  model?: string
  useStylePreset?: boolean
  edit?: NodeSpecEdit
}

/** [M17] kind=text：提示词/文案节点 */
export interface TextSpec {
  text: string
}

/** [M17] kind=entity：实体参考直通（characters 行） */
export interface EntitySpec {
  entityId: number
}

/** [M17] kind=run：内嵌运行（pipeline_runs 行，须属同项目） */
export interface RunSpec {
  runId: number
}

/** [M17] 读模型节点 spec 联合（按 kind 分派解析） */
export type AnyNodeSpec = NodeSpec | TextSpec | EntitySpec | RunSpec

/** [M17] spec 类型守卫：是否 gen 规范（含 genKind 字段） */
export function isGenSpec(s: unknown): s is NodeSpec {
  return !!s && typeof s === 'object' && typeof (s as Record<string, unknown>)['genKind'] === 'string'
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
  /** [M17] text 节点：提示词内容 */
  text?: string | null
  /** [M17] entity 节点：参考资产 id 集（执行时按 REF_CAP 截断展开） */
  refAssetIds?: number[] | null
}

export interface InputPlan {
  referenceAssetIds: number[]
  firstFrameAssetId: number | null
  lastFrameAssetId: number | null
  sourceAssetId: number | null
  /** [M17] prompt 端口（text 节点内容；非 null 时覆盖 spec.prompt） */
  promptText: string | null
  /** [M17] compose 视频输入（边创建序） */
  videoAssetIds: number[]
  /** [M17] compose 音频输入（边创建序） */
  audioAssetIds: number[]
  problems: string[]
  /** [M17] 宽容提示（实体截断等；不阻断执行） */
  notes: string[]
}

/** [M17] 结果画廊条目（最近成功 ≤12） */
export interface CanvasResultItem {
  taskId: number
  assetId: number
  asset: AssetLite | null
  createdAt: number
}

/** [M17] entity 节点实体摘要 */
export interface CanvasEntityInfo {
  id: number
  name: string
  kind: string
  refCount: number
  asset: AssetLite | null
}

/** [M17] run 节点运行摘要（pipeline_runs + steps 计数） */
export interface CanvasRunInfo {
  id: number
  templateKey: string
  status: string
  startedAt: number | null
  completedAt: number | null
  steps: { succeeded: number; total: number }
}

export interface CanvasDocNode {
  id: number
  kind: NodeKind
  x: number
  y: number
  title: string
  /** [M17] 故事板序号（1 起；null = 未编号） */
  seq?: number | null
  /** asset 节点：引用资产；gen 节点：显示产物（采纳优先）资产（冗余方便前端） */
  assetId: number | null
  asset: AssetLite | null
  /** gen → NodeSpec；text → TextSpec；entity → EntitySpec；run → RunSpec；损坏 → null + specError [M17] */
  spec: AnyNodeSpec | null
  specError: string | null
  /** 仅 gen：latestTask?.status ?? 'idle' */
  status: string | null
  latestTask: GenTaskLite | null
  tasks: GenTaskLite[]
  /** [M17] 仅 gen：采纳任务 id（null = 未采纳） */
  adoptedTaskId?: number | null
  /** [M17] 仅 gen：显示任务 id（采纳优先派生） */
  displayTaskId?: number | null
  /** [M17] 仅 gen：显示任务（含产物资产冗余） */
  displayTask?: (GenTaskLite & { asset: AssetLite | null }) | null
  /** [M17] 仅 gen：结果画廊（最近成功 ≤12） */
  results?: CanvasResultItem[]
  readiness: { ready: boolean; problems: string[]; notes?: string[] } | null
  editCapability: EditCapability | null
  canRun: boolean | null
  canCancel: boolean | null
  /** [M17] 仅 entity */
  entity?: CanvasEntityInfo | null
  /** [M17] 仅 run */
  run?: CanvasRunInfo | null
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
  if (!(GEN_KINDS as readonly unknown[]).includes(genKind)) throw new Error(`spec.genKind 非法（${GEN_KINDS.join('|')}）`)
  const prompt = o['prompt'] === undefined ? '' : o['prompt']
  if (typeof prompt !== 'string') throw new Error('spec.prompt 需为字符串')
  const spec: NodeSpec = { genKind: genKind as GenKind, prompt }
  for (const key of ['size', 'resolution', 'aspectRatio', 'provider', 'model', 'voice'] as const) {
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
  if (o['fps'] !== undefined && o['fps'] !== null) {
    const f = o['fps']
    if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0 || f > 120) throw new Error('spec.fps 需为 0-120 间的数字')
    spec.fps = f
  }
  if (o['speed'] !== undefined && o['speed'] !== null) {
    const sp = o['speed']
    if (typeof sp !== 'number' || !Number.isFinite(sp) || sp < 0.25 || sp > 4) throw new Error('spec.speed 需为 0.25-4 间的数字')
    spec.speed = sp
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
    if (genKind !== 'image') throw new Error('编辑节点仅支持图像（genKind 需为 image）')
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

/** [M17] text spec 结构校验：{ text: string }（空文本属 readiness 语义） */
export function parseTextSpec(raw: unknown): TextSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('text spec 需为对象（{ text }）')
  const o = raw as Record<string, unknown>
  const text = o['text'] === undefined ? '' : o['text']
  if (typeof text !== 'string') throw new Error('spec.text 需为字符串')
  return { text }
}

/** [M17] entity spec 结构校验：{ entityId: 正整数 } */
export function parseEntitySpec(raw: unknown): EntitySpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('entity spec 需为对象（{ entityId }）')
  const o = raw as Record<string, unknown>
  const id = Number(o['entityId'])
  if (!Number.isInteger(id) || id <= 0) throw new Error('spec.entityId 需为正整数')
  return { entityId: id }
}

/** [M17] run spec 结构校验：{ runId: 正整数 } */
export function parseRunSpec(raw: unknown): RunSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('run spec 需为对象（{ runId }）')
  const o = raw as Record<string, unknown>
  const id = Number(o['runId'])
  if (!Number.isInteger(id) || id <= 0) throw new Error('spec.runId 需为正整数')
  return { runId: id }
}

/** [M17] 通用 spec 宽容解析：坏 JSON → { spec: null, error }（读模型防炸） */
function safeParseRaw<T>(raw: string | null, parse: (obj: unknown) => T): { spec: T | null; error: string | null } {
  if (!raw) return { spec: null, error: 'spec 缺失' }
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch (err) {
    return { spec: null, error: `spec JSON 损坏: ${(err as Error).message}` }
  }
  try {
    return { spec: parse(obj), error: null }
  } catch (err) {
    return { spec: null, error: (err as Error).message }
  }
}

/** spec 宽容解析（gen）：坏 JSON → { spec: null, error }（读模型防炸） */
export function safeParseSpec(raw: string | null): { spec: NodeSpec | null; error: string | null } {
  return safeParseRaw(raw, parseNodeSpec)
}

/** [M17] spec 宽容解析（text / entity / run） */
export function safeParseTextSpec(raw: string | null): { spec: TextSpec | null; error: string | null } {
  return safeParseRaw(raw, parseTextSpec)
}

export function safeParseEntitySpec(raw: string | null): { spec: EntitySpec | null; error: string | null } {
  return safeParseRaw(raw, parseEntitySpec)
}

export function safeParseRunSpec(raw: string | null): { spec: RunSpec | null; error: string | null } {
  return safeParseRaw(raw, parseRunSpec)
}

/** spec 业务完备性（readiness 用）：结构合法但有缺失 → 问题清单（[M17] hasPromptInput：prompt 端口已供文本 → 空 prompt 不再报） */
export function specProblems(spec: NodeSpec, hasPromptInput = false): string[] {
  const problems: string[] = []
  if (spec.genKind === 'compose') return problems // 输入全部来自连线；缺 video 输入由 planNodeInputs 报
  if (spec.genKind === 'audio') {
    if (!spec.prompt.trim() && !hasPromptInput) problems.push('朗读文本为空（填写 prompt 或连接文本节点）')
    return problems
  }
  if (spec.edit) {
    if (spec.edit.mode === 'inpaint' && !spec.prompt.trim()) problems.push('局部重绘需填写提示词（要画什么）')
    if ((spec.edit.mode === 'inpaint' || spec.edit.mode === 'erase') && !spec.edit.maskAssetId) {
      problems.push('缺少蒙版（请打开蒙版编辑器涂抹后保存）')
    }
  } else if (!spec.prompt.trim() && !hasPromptInput) {
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

/** [M17] 建边 from 侧信息（补源侧类型校验） */
export interface FromNodeInfo {
  id: number
  kind: string
  spec?: NodeSpec | null
  /** kind=asset：引用资产类型（image|video|audio|text|archive|...） */
  assetKind?: string | null
}

/** [M17] gen 节点预期产物类型（edit 并入 image；compose 产 video） */
export function productKindOf(spec: NodeSpec | null): string | null {
  if (!spec) return null
  switch (spec.genKind) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'compose':
      return 'video'
    default:
      return null
  }
}

/** [M17] from 侧产物类型：asset→资产类型；gen→预期产物；text/entity→虚拟类型（供端口校验） */
export function sourceKindOf(from: FromNodeInfo): string | null {
  if (from.kind === 'asset') return from.assetKind ?? null
  if (from.kind === 'gen') return productKindOf(from.spec ?? null)
  if (from.kind === 'text') return 'text'
  if (from.kind === 'entity') return 'entity'
  return null
}

/** 端口规则矩阵校验 v2（建边用；返回错误文案或 null；from 提供时执行源侧类型校验） */
export function validateNewEdge(
  to: { id: number; kind: string; spec: NodeSpec | null },
  port: string,
  fromId: number,
  existing: Array<{ from: number; to: number; port: string }>,
  from?: FromNodeInfo,
): string | null {
  if (!(EDGE_PORTS as readonly string[]).includes(port)) {
    return `端口非法：${port}（可选 ${EDGE_PORTS.join('|')}）`
  }
  if (to.kind === 'run' || from?.kind === 'run') return '运行节点不参与连线'
  if (to.kind !== 'gen') return '仅生成节点可接收连线'
  if (!to.spec) return '目标节点 spec 损坏，无法连线'
  const spec = to.spec
  const src = from ? sourceKindOf(from) : null
  const srcLabel = src ?? '未知'
  const cur = existing.filter((e) => e.to === to.id && e.port === port)
  if (cur.some((e) => e.from === fromId)) return '该连线已存在'
  if (port === 'reference') {
    if (spec.genKind !== 'image' && spec.genKind !== 'video') return '参考图端口仅图片/视频生成节点支持'
    if (from && src !== 'image' && src !== 'entity') return `参考图来源需为图片素材/生成图/实体节点（当前类型：${srcLabel}）`
    const cap = REF_CAP[spec.genKind as 'image' | 'video']
    if (cur.length >= cap) return `${spec.genKind === 'video' ? '视频' : '图片'}生成节点参考图上限 ${cap} 张`
    return null
  }
  if (port === 'first_frame' || port === 'last_frame') {
    const label = port === 'first_frame' ? '首帧' : '尾帧'
    if (spec.genKind !== 'video') return `${label}仅视频生成节点支持`
    if (from && src !== 'image') return `${label}来源需为图片素材或生成图（当前类型：${srcLabel}）`
    if (cur.length >= 1) return `${label}最多 1 条`
    return null
  }
  if (port === 'source') {
    if (!spec.edit) return '源图端口仅编辑节点支持（spec.edit）'
    if (from && src !== 'image') return `源图来源需为图片素材或生成图（当前类型：${srcLabel}）`
    if (cur.length >= 1) return '编辑源图最多 1 条'
    return null
  }
  if (port === 'prompt') {
    if (spec.genKind !== 'image' && spec.genKind !== 'video' && spec.genKind !== 'audio') {
      return '提示词端口仅图片/视频/音频生成节点支持'
    }
    // 仅 text 节点（文本资产节点执行侧无文本注入通道，一并拒绝）
    if (from && from.kind !== 'text') return `提示词端口仅接受文本节点（当前类型：${srcLabel}）`
    if (cur.length >= 1) return '提示词最多 1 条'
    return null
  }
  if (port === 'video') {
    if (spec.genKind !== 'compose') return '视频输入端口仅合成节点支持'
    if (from && src !== 'video') return `视频输入来源需为视频素材或生成视频（当前类型：${srcLabel}）`
    if (cur.length >= COMPOSE_CAP) return `合成节点视频输入上限 ${COMPOSE_CAP} 条`
    return null
  }
  // audio
  if (spec.genKind !== 'compose') return '音频输入端口仅合成节点支持'
  if (from && src !== 'audio') return `音频输入来源需为音频素材或生成音频（当前类型：${srcLabel}）`
  if (cur.length >= COMPOSE_CAP) return `合成节点音频输入上限 ${COMPOSE_CAP} 条`
  return null
}

/**
 * 输入计划 v2（纯函数）：入边 → 各端口输入资产/文本 + 问题清单 + 宽容提示。
 * 语义 = 引用快照（采纳优先）：执行时取上游「采纳产物（有效时）或最新成功产物」；
 * [M17] 扩展：prompt 端口（text 节点内容）、video/audio 端口（compose 输入）、entity 源（refAssetIds 展开截断）。
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
    promptText: null,
    videoAssetIds: [],
    audioAssetIds: [],
    problems: [],
    notes: [],
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
      const cap = (REF_CAP as Record<string, number>)[spec.genKind] ?? 0
      const up = upstream.get(e.from)
      if (up?.refAssetIds != null) {
        // [M17] entity 节点：展开参考图集（受 cap 截断，记 notes）
        let truncated = 0
        for (const rid of up.refAssetIds) {
          if (plan.referenceAssetIds.length >= cap) {
            truncated += 1
            continue
          }
          plan.referenceAssetIds.push(rid)
        }
        if (truncated > 0) plan.notes.push(`实体参考图超上限 ${cap} 张，已截断 ${truncated} 张`)
        continue
      }
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
      continue
    }
    if (e.port === 'prompt') {
      if (spec.genKind !== 'image' && spec.genKind !== 'video' && spec.genKind !== 'audio') {
        plan.problems.push('提示词连线仅图片/视频/音频节点可用')
        continue
      }
      if (plan.promptText != null) continue
      const t = upstream.get(e.from)?.text ?? null
      if (t == null || !t.trim()) {
        plan.problems.push(`提示词来源 #${e.from} 暂无文本或为空`)
        continue
      }
      plan.promptText = t.trim()
      continue
    }
    if (e.port === 'video') {
      if (spec.genKind !== 'compose') {
        plan.problems.push('视频连线仅合成节点可用')
        continue
      }
      if (plan.videoAssetIds.length >= COMPOSE_CAP) {
        plan.problems.push(`视频输入超过上限 ${COMPOSE_CAP} 条（已忽略多余连线）`)
        continue
      }
      const up = upstream.get(e.from)
      if (!up || up.assetId == null) {
        plan.problems.push(`引用节点 #${e.from} 暂无成功产物`)
        continue
      }
      if (up.mediaKind !== 'video') {
        plan.problems.push(`引用节点 #${e.from} 的产物为 ${up.mediaKind ?? '未知'}，不能作为视频输入（仅视频）`)
        continue
      }
      plan.videoAssetIds.push(up.assetId)
      continue
    }
    if (e.port === 'audio') {
      if (spec.genKind !== 'compose') {
        plan.problems.push('音频连线仅合成节点可用')
        continue
      }
      if (plan.audioAssetIds.length >= COMPOSE_CAP) {
        plan.problems.push(`音频输入超过上限 ${COMPOSE_CAP} 条（已忽略多余连线）`)
        continue
      }
      const up = upstream.get(e.from)
      if (!up || up.assetId == null) {
        plan.problems.push(`引用节点 #${e.from} 暂无成功产物`)
        continue
      }
      if (up.mediaKind !== 'audio') {
        plan.problems.push(`引用节点 #${e.from} 的产物为 ${up.mediaKind ?? '未知'}，不能作为音频输入（仅音频）`)
        continue
      }
      plan.audioAssetIds.push(up.assetId)
    }
  }
  if (spec.edit && plan.sourceAssetId == null && !plan.problems.some((p) => p.includes('暂无成功产物') || p.includes('不能作为生成输入'))) {
    plan.problems.push('编辑节点缺少源图连线（source）')
  }
  if (
    spec.genKind === 'compose' &&
    plan.videoAssetIds.length === 0 &&
    !plan.problems.some((p) => p.includes('暂无成功产物') || p.includes('不能作为视频输入'))
  ) {
    plan.problems.push('合成节点缺少视频输入连线（video）')
  }
  return plan
}

/**
 * [M17] 显示/引用任务决策（纯函数）：采纳有效（属本节点 + succeeded + 有产物）→ 该任务；否则最新成功；无 → null。
 * 节点对外引用（下游输入）与节点显示（画廊当前）同源。
 */
export function pickDisplayTask<T extends { id: number; status: string; resultAssetId: number | null }>(
  adoptedTaskId: number | null,
  tasksDesc: T[],
): T | null {
  if (adoptedTaskId != null) {
    const hit = tasksDesc.find((t) => t.id === adoptedTaskId && t.status === 'succeeded' && t.resultAssetId != null)
    if (hit) return hit
  }
  return tasksDesc.find((t) => t.status === 'succeeded' && t.resultAssetId != null) ?? null
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
        adoptedTaskId: node.adoptedTaskId,
        seq: node.seq,
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

/** [M17] 文本节点：spec { text }（空文本属 readiness 语义） */
export async function addTextNode(
  canvas: Canvas,
  spec: unknown,
  x: unknown,
  y: unknown,
  title?: unknown,
): Promise<CanvasNode> {
  const parsed = parseTextSpec(spec) // 非法 → 抛（400）
  const pos = parsePos(x, y)
  const now = Date.now()
  const [row] = await db
    .insert(canvasNodes)
    .values({
      canvasId: canvas.id,
      kind: 'text',
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

/** [M17] 实体节点：entityId 须存在且属同项目或全局（project_id NULL） */
export async function addEntityNode(
  canvas: Canvas,
  entityId: unknown,
  x: unknown,
  y: unknown,
  title?: unknown,
): Promise<CanvasNode> {
  const parsed = parseEntitySpec({ entityId })
  const rows = await db.select().from(characters).where(eq(characters.id, parsed.entityId)).limit(1)
  const ent = rows[0]
  if (!ent) throw new Error(`实体 ${parsed.entityId} 不存在`)
  if (ent.projectId !== null && ent.projectId !== canvas.projectId) throw new Error('实体不属于该项目（全局实体库除外）')
  const pos = parsePos(x, y)
  const now = Date.now()
  const [row] = await db
    .insert(canvasNodes)
    .values({
      canvasId: canvas.id,
      kind: 'entity',
      spec: JSON.stringify(parsed),
      title: typeof title === 'string' && title.trim() ? title.trim() : ent.name,
      x: pos.x,
      y: pos.y,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row!
}

/** [M17] 运行节点：runId 须存在且属同项目 */
export async function addRunNode(
  canvas: Canvas,
  runId: unknown,
  x: unknown,
  y: unknown,
  title?: unknown,
): Promise<CanvasNode> {
  const parsed = parseRunSpec({ runId })
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, parsed.runId)).limit(1)
  const run = rows[0]
  if (!run) throw new Error(`运行 ${parsed.runId} 不存在`)
  if (run.projectId !== canvas.projectId) throw new Error('运行不属于该项目')
  const pos = parsePos(x, y)
  const now = Date.now()
  const [row] = await db
    .insert(canvasNodes)
    .values({
      canvasId: canvas.id,
      kind: 'run',
      spec: JSON.stringify(parsed),
      title: typeof title === 'string' && title.trim() ? title.trim() : `运行 #${parsed.runId}`,
      x: pos.x,
      y: pos.y,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row!
}

export interface NodePatch {
  x?: unknown
  y?: unknown
  title?: unknown
  spec?: unknown
  seq?: unknown
  adoptedTaskId?: unknown
}

/**
 * [M17] PATCH 校验核心（updateNode 与 batchNodes 共用，保证同文案同语义）：
 * 校验 patch 合法性并返回待更新字段集（不含写库）。
 */
export async function validateNodePatch(cur: CanvasNode, patch: NodePatch): Promise<Record<string, unknown>> {
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
    if (cur.kind === 'gen') set['spec'] = JSON.stringify(parseNodeSpec(patch.spec))
    else if (cur.kind === 'text') set['spec'] = JSON.stringify(parseTextSpec(patch.spec))
    else throw new Error('该节点类型不可改 spec（gen/text 可改）')
  }
  // [M17] 故事板序号：null 清除 / 正整数（1 起）
  if (patch.seq !== undefined) {
    if (patch.seq === null) set['seq'] = null
    else {
      const n = Number(patch.seq)
      if (!Number.isInteger(n) || n <= 0) throw new Error('seq 需为 null 或正整数')
      set['seq'] = n
    }
  }
  // [M17] 结果采纳：null 清除 / 校验（属本节点 + succeeded + 有产物）
  if (patch.adoptedTaskId !== undefined) {
    if (cur.kind !== 'gen') throw new Error('仅生成节点支持采纳结果')
    if (patch.adoptedTaskId === null) {
      set['adoptedTaskId'] = null
    } else {
      const tid = Number(patch.adoptedTaskId)
      if (!Number.isInteger(tid) || tid <= 0) throw new Error('adoptedTaskId 需为 null 或正整数')
      const rows = await db
        .select()
        .from(genTasks)
        .where(and(eq(genTasks.id, tid), eq(genTasks.canvasNodeId, cur.id)))
        .limit(1)
      const t = rows[0]
      if (!t) throw new Error('采纳任务不存在或不属于该节点')
      if (t.status !== 'succeeded' || t.resultAssetId == null) throw new Error('仅可采纳有成功产物的任务')
      set['adoptedTaskId'] = tid
    }
  }
  return set
}

export async function updateNode(id: number, patch: NodePatch): Promise<CanvasNode | null> {
  const cur = await findNode(id)
  if (!cur) return null
  const set = await validateNodePatch(cur, patch)
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

/**
 * [M17] 快照重建认领-源校验：restoreFromNodeId 为正整数且源节点已不存在。
 * 路由在建节点前前置调用——失败即抛，避免产生「节点已建但认领失败」的残留；与 claimNodeTasks 同文案同语义。
 */
export async function assertRestorableSource(rawFrom: unknown): Promise<number> {
  const from = Number(rawFrom)
  if (!Number.isInteger(from) || from <= 0) throw new Error('restoreFromNodeId 需为正整数')
  const alive = await db.select({ id: canvasNodes.id }).from(canvasNodes).where(eq(canvasNodes.id, from)).limit(1)
  if (alive[0]) throw new Error('restoreFromNodeId 对应节点仍存在，禁止转移任务历史')
  return from
}

/**
 * [M17] 快照重建：认领已删节点的任务历史（gen_tasks.canvas_node_id 旧 → 新，同项目域）。
 * 撤销删除时重建 gen 节点后调用——任务归属随重建迁移，使画廊/采纳/下游引用完整恢复；
 * 否则 adoptedTaskId 的 PATCH 校验（任务须属本节点）必然失败。
 * 校验：目标须为 gen（任务仅归属 gen 节点）；源节点须已不存在（禁止转移存活节点任务）。
 */
export async function claimNodeTasks(canvas: Canvas, node: CanvasNode, rawFrom: unknown): Promise<number> {
  const from = await assertRestorableSource(rawFrom)
  if (from === node.id) throw new Error('restoreFromNodeId 不能指向节点自身')
  if (node.kind !== 'gen') throw new Error('仅生成节点可认领任务历史')
  const rows = await db
    .update(genTasks)
    .set({ canvasNodeId: node.id })
    .where(and(eq(genTasks.canvasNodeId, from), eq(genTasks.projectId, canvas.projectId)))
    .returning({ id: genTasks.id })
  return rows.length
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

  // [M17] entity 节点：批查实体（参考图集 + 首图缩略）
  const entityRefsByNodeId = new Map<number, number[]>()
  const entityByNodeId = new Map<number, CanvasEntityInfo>()
  const entityNodeRows = nodeRows.filter((n) => n.kind === 'entity')
  if (entityNodeRows.length) {
    const eids = entityNodeRows.map((n) => safeParseEntitySpec(n.spec).spec?.entityId).filter((x): x is number => x != null)
    const entRows = eids.length ? await db.select().from(characters).where(inArray(characters.id, eids)) : []
    const entById = new Map(entRows.map((c) => [c.id, c]))
    for (const n of entityNodeRows) {
      const eid = safeParseEntitySpec(n.spec).spec?.entityId
      const ent = eid != null ? entById.get(eid) : undefined
      if (!ent) continue
      const refIds = parseRefIds(ent.refAssetIds)
      entityRefsByNodeId.set(n.id, refIds)
      entityByNodeId.set(n.id, { id: ent.id, name: ent.name, kind: ent.kind, refCount: refIds.length, asset: null })
    }
  }

  // [M17] run 节点：批查 pipeline_runs + steps 状态计数
  const runByNodeId = new Map<number, CanvasRunInfo>()
  const runNodeRows = nodeRows.filter((n) => n.kind === 'run')
  if (runNodeRows.length) {
    const rids = runNodeRows.map((n) => safeParseRunSpec(n.spec).spec?.runId).filter((x): x is number => x != null)
    const runRows = rids.length ? await db.select().from(pipelineRuns).where(inArray(pipelineRuns.id, rids)) : []
    const runById = new Map(runRows.map((r) => [r.id, r]))
    const stepRows = rids.length
      ? await db
          .select({ runId: pipelineSteps.runId, status: pipelineSteps.status, n: count() })
          .from(pipelineSteps)
          .where(inArray(pipelineSteps.runId, rids))
          .groupBy(pipelineSteps.runId, pipelineSteps.status)
      : []
    for (const n of runNodeRows) {
      const rid = safeParseRunSpec(n.spec).spec?.runId
      const run = rid != null ? runById.get(rid) : undefined
      if (!run) continue
      let total = 0
      let succeeded = 0
      for (const s of stepRows) {
        if (s.runId !== run.id) continue
        total += Number(s.n)
        if (s.status === 'succeeded') succeeded += Number(s.n)
      }
      runByNodeId.set(n.id, {
        id: run.id,
        templateKey: run.templateKey,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        steps: { succeeded, total },
      })
    }
  }

  // 资产：素材节点 assetId + 全部任务 resultAssetId（含历史）+ [M17] 实体首张参考图
  const assetIdSet = new Set<number>()
  for (const n of nodeRows) if (n.assetId != null) assetIdSet.add(n.assetId)
  for (const t of taskRows) if (t.resultAssetId != null) assetIdSet.add(t.resultAssetId)
  for (const [, refIds] of entityRefsByNodeId) if (refIds[0] != null) assetIdSet.add(refIds[0])
  const assetRows = assetIdSet.size
    ? await db.select().from(assets).where(inArray(assets.id, [...assetIdSet]))
    : []
  const assetById = new Map(assetRows.map((a) => [a.id, a]))
  for (const [nodeId, refIds] of entityRefsByNodeId) {
    const info = entityByNodeId.get(nodeId)
    if (!info) continue
    const first = refIds[0] != null ? assetById.get(refIds[0]) : undefined
    info.asset = first ? toAssetLite(first) : null
  }

  // 上游产物索引 v2：asset→引用资产；gen→采纳优先产物；text→内容；entity→参考图集；run→空
  const upstream = new Map<number, UpstreamInfo>()
  for (const n of nodeRows) {
    if (n.kind === 'asset') {
      const a = n.assetId != null ? assetById.get(n.assetId) : undefined
      upstream.set(n.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
    } else if (n.kind === 'gen') {
      const display = pickDisplayTask(n.adoptedTaskId ?? null, tasksByNode.get(n.id) ?? [])
      const a = display?.resultAssetId != null ? assetById.get(display.resultAssetId) : undefined
      upstream.set(n.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
    } else if (n.kind === 'text') {
      const ts = safeParseTextSpec(n.spec)
      upstream.set(n.id, { assetId: null, mediaKind: null, text: ts.spec?.text ?? null })
    } else if (n.kind === 'entity') {
      upstream.set(n.id, { assetId: null, mediaKind: null, refAssetIds: entityRefsByNodeId.get(n.id) ?? [] })
    } else {
      upstream.set(n.id, { assetId: null, mediaKind: null })
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
      seq: n.seq ?? null,
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
        adoptedTaskId: null,
        displayTaskId: null,
        displayTask: null,
        results: [],
        readiness: null,
        editCapability: null,
        canRun: null,
        canCancel: null,
        entity: null,
        run: null,
      })
      continue
    }
    if (n.kind === 'text') {
      const ts = safeParseTextSpec(n.spec)
      const problems: string[] = []
      if (ts.error) problems.push(ts.error)
      if (ts.spec && !ts.spec.text.trim()) problems.push('文本为空')
      nodes.push({
        ...base,
        title: n.title ?? `文本 #${n.id}`,
        assetId: null,
        asset: null,
        spec: ts.spec,
        specError: ts.error,
        status: null,
        latestTask: null,
        tasks: [],
        adoptedTaskId: null,
        displayTaskId: null,
        displayTask: null,
        results: [],
        readiness: { ready: problems.length === 0, problems, notes: [] },
        editCapability: null,
        canRun: null,
        canCancel: null,
        entity: null,
        run: null,
      })
      continue
    }
    if (n.kind === 'entity') {
      const es = safeParseEntitySpec(n.spec)
      const info = entityByNodeId.get(n.id) ?? null
      const problems: string[] = []
      if (es.error) problems.push(es.error)
      if (es.spec && !info) problems.push('实体不存在或已删除')
      if (info && info.refCount === 0) problems.push('实体无参考图（请在实体库上传定妆照）')
      nodes.push({
        ...base,
        title: n.title ?? info?.name ?? `实体 #${n.id}`,
        assetId: null,
        asset: null,
        spec: es.spec,
        specError: es.error,
        status: null,
        latestTask: null,
        tasks: [],
        adoptedTaskId: null,
        displayTaskId: null,
        displayTask: null,
        results: [],
        readiness: { ready: problems.length === 0, problems, notes: [] },
        editCapability: null,
        canRun: null,
        canCancel: null,
        entity: info,
        run: null,
      })
      continue
    }
    if (n.kind === 'run') {
      const rs = safeParseRunSpec(n.spec)
      const run = runByNodeId.get(n.id) ?? null
      nodes.push({
        ...base,
        title: n.title ?? `运行 #${rs.spec?.runId ?? '?'}`,
        assetId: null,
        asset: null,
        spec: rs.spec,
        specError: rs.error,
        status: run?.status ?? null,
        latestTask: null,
        tasks: [],
        adoptedTaskId: null,
        displayTaskId: null,
        displayTask: null,
        results: [],
        readiness: null,
        editCapability: null,
        canRun: null,
        canCancel: null,
        entity: null,
        run,
      })
      continue
    }
    // gen：任务派生 + 采纳优先显示
    const parsed = safeParseSpec(n.spec)
    const allTasks = tasksByNode.get(n.id) ?? []
    const tasks = allTasks.slice(0, 5).map(toTaskLite)
    const latest = allTasks[0] ?? null
    const status = latest?.status ?? 'idle'
    const busy = status === 'pending' || status === 'processing'
    const adoptedTaskId = n.adoptedTaskId ?? null
    const display = pickDisplayTask(adoptedTaskId, allTasks)
    const displayTaskId = display?.id ?? null
    const results: CanvasResultItem[] = allTasks
      .filter((t) => t.status === 'succeeded' && t.resultAssetId != null)
      .slice(0, 12)
      .map((t) => {
        const a = t.resultAssetId != null ? assetById.get(t.resultAssetId) : undefined
        return { taskId: t.id, assetId: t.resultAssetId!, asset: a ? toAssetLite(a) : null, createdAt: t.createdAt }
      })
    const displayAsset = display?.resultAssetId != null ? assetById.get(display.resultAssetId) : undefined
    const displayTask = display ? { ...toTaskLite(display), asset: displayAsset ? toAssetLite(displayAsset) : null } : null
    const problems: string[] = []
    let notes: string[] = []
    if (parsed.error) problems.push(parsed.error)
    if (parsed.spec) {
      const plan = planNodeInputs(parsed.spec, n.id, edgeRows, upstream)
      problems.push(...specProblems(parsed.spec, plan.promptText != null), ...plan.problems)
      notes = plan.notes
    }
    const isEdit = Boolean(parsed.spec?.edit)
    nodes.push({
      ...base,
      title: n.title ?? defaultGenTitle(parsed.spec, n.id),
      assetId: display?.resultAssetId ?? null,
      asset: displayAsset ? toAssetLite(displayAsset) : null,
      spec: parsed.spec,
      specError: parsed.error,
      status,
      latestTask: latest ? toTaskLite(latest) : null,
      tasks,
      adoptedTaskId,
      displayTaskId,
      displayTask,
      results,
      readiness: { ready: problems.length === 0, problems, notes },
      editCapability: isEdit && parsed.spec ? await capOf(parsed.spec.provider) : null,
      canRun: Boolean(parsed.spec) && problems.length === 0 && !busy,
      canCancel: busy,
      entity: null,
      run: null,
    })
  }

  const viewport = parseViewport(safeJson(canvas.viewport)) ?? { x: 0, y: 0, zoom: 1 }
  return {
    canvas: { id: canvas.id, projectId: canvas.projectId, name: canvas.name, viewport },
    nodes,
    edges: edgeRows.map((e) => ({ id: e.id, from: e.from, to: e.to, port: e.port })),
  }
}

/** 执行时输入计划 v2（实时解析：采纳优先；text/entity 上游展开；供 creation-gen 调用） */
export async function loadInputPlan(
  node: CanvasNode,
  incoming: Array<{ from: number; to: number; port: string }>,
  spec: NodeSpec,
): Promise<InputPlan> {
  const fromIds = [...new Set(incoming.map((e) => e.from))]
  const upstream = new Map<number, UpstreamInfo>()
  if (fromIds.length > 0) {
    const rows = await db.select().from(canvasNodes).where(inArray(canvasNodes.id, fromIds))
    const genRows = rows.filter((r) => r.kind === 'gen')
    const assetRows0 = rows.filter((r) => r.kind === 'asset' && r.assetId != null)
    const entityRows = rows.filter((r) => r.kind === 'entity')
    // gen 上游：全部成功任务（新→旧）→ pickDisplayTask 采纳优先
    const okTasks = genRows.length
      ? await db
          .select()
          .from(genTasks)
          .where(and(inArray(genTasks.canvasNodeId, genRows.map((r) => r.id)), eq(genTasks.status, 'succeeded')))
          .orderBy(desc(genTasks.id))
      : []
    const okByNode = new Map<number, Array<(typeof okTasks)[number]>>()
    for (const t of okTasks) {
      if (t.canvasNodeId == null || t.resultAssetId == null) continue
      const list = okByNode.get(t.canvasNodeId) ?? []
      list.push(t)
      okByNode.set(t.canvasNodeId, list)
    }
    // entity 上游：characters 批查（参考图集）
    const entityRefs = new Map<number, number[]>()
    if (entityRows.length) {
      const eids = entityRows.map((r) => safeParseEntitySpec(r.spec).spec?.entityId).filter((x): x is number => x != null)
      const ents = eids.length ? await db.select().from(characters).where(inArray(characters.id, eids)) : []
      const entById = new Map(ents.map((c) => [c.id, c]))
      for (const r of entityRows) {
        const eid = safeParseEntitySpec(r.spec).spec?.entityId
        const ent = eid != null ? entById.get(eid) : undefined
        entityRefs.set(r.id, ent ? parseRefIds(ent.refAssetIds) : [])
      }
    }
    // 资产：asset 上游 + gen 显示产物（采纳优先）
    const assetIds = new Set<number>(assetRows0.map((r) => r.assetId!))
    const displayAssetByNode = new Map<number, number>()
    for (const r of genRows) {
      const disp = pickDisplayTask(r.adoptedTaskId ?? null, okByNode.get(r.id) ?? [])
      if (disp?.resultAssetId != null) {
        assetIds.add(disp.resultAssetId)
        displayAssetByNode.set(r.id, disp.resultAssetId)
      }
    }
    const assetRows = assetIds.size ? await db.select().from(assets).where(inArray(assets.id, [...assetIds])) : []
    const assetById = new Map(assetRows.map((a) => [a.id, a]))
    for (const r of rows) {
      if (r.kind === 'asset') {
        const a = r.assetId != null ? assetById.get(r.assetId) : undefined
        upstream.set(r.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
      } else if (r.kind === 'gen') {
        const rid = displayAssetByNode.get(r.id)
        const a = rid != null ? assetById.get(rid) : undefined
        upstream.set(r.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
      } else if (r.kind === 'text') {
        const ts = safeParseTextSpec(r.spec)
        upstream.set(r.id, { assetId: null, mediaKind: null, text: ts.spec?.text ?? null })
      } else if (r.kind === 'entity') {
        upstream.set(r.id, { assetId: null, mediaKind: null, refAssetIds: entityRefs.get(r.id) ?? [] })
      } else {
        upstream.set(r.id, { assetId: null, mediaKind: null })
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
  const genSpecOf = (n: CanvasDocNode): NodeSpec | null => (n.kind === 'gen' && isGenSpec(n.spec) ? n.spec : null)
  const genNodes = doc.nodes.filter((n) => genSpecOf(n) != null)
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
    const spec = genSpecOf(node)!
    const action =
      spec.genKind === 'audio'
        ? 'tts'
        : spec.genKind === 'compose'
          ? 'ffmpeg_merge'
          : spec.edit || spec.genKind === 'image'
            ? 'ai_image'
            : 'ai_video'
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
    if (spec.fps) lines.push(`    # fps: ${spec.fps}`)
    if (spec.voice) lines.push(`    # voice: ${spec.voice}`)
    if (spec.speed) lines.push(`    # speed: ${spec.speed}`)
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

// ---------- [M17] 文本提取 ----------

/** [M17] 提取文本节点：源 = gen（spec.prompt）或文本资产节点（读资产全文）→ 新建 text 节点（默认源右侧偏移） */
export async function extractTextNode(nodeId: number, x?: unknown, y?: unknown): Promise<CanvasNode | null> {
  const src = await findNode(nodeId)
  if (!src) return null
  let text: string
  if (src.kind === 'gen') {
    const parsed = safeParseSpec(src.spec)
    if (!parsed.spec) throw new Error(`源节点 spec 损坏：${parsed.error}`)
    text = parsed.spec.prompt
  } else if (src.kind === 'asset') {
    const rows = src.assetId != null ? await db.select().from(assets).where(eq(assets.id, src.assetId)).limit(1) : []
    const a = rows[0]
    if (!a) throw new Error('源素材不存在')
    if (a.kind !== 'text') throw new Error('仅文本资产可提取（或从生成节点提取 prompt）')
    if (!a.relPath) throw new Error('文本资产缺少文件路径')
    try {
      text = readFileSync(absPathOf(a.relPath), 'utf8').slice(0, 20000)
    } catch {
      throw new Error('文本资产文件读取失败')
    }
  } else {
    throw new Error('仅生成节点或文本资产节点可提取文本')
  }
  const pos = parsePos(x === undefined ? src.x + 260 : x, y === undefined ? src.y : y)
  const now = Date.now()
  const [row] = await db
    .insert(canvasNodes)
    .values({
      canvasId: src.canvasId,
      kind: 'text',
      spec: JSON.stringify({ text: text.trim() }),
      x: pos.x,
      y: pos.y,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row ?? null
}

// ---------- 小工具 ----------

/** [M17] characters.refAssetIds（JSON 数组）宽容解析：非法 → [] */
function parseRefIds(raw: string | null): number[] {
  try {
    const arr: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(arr)) return []
    return arr.map(Number).filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

/** [M17] gen 节点默认标题（按 genKind / edit 分派） */
function defaultGenTitle(spec: NodeSpec | null, id: number): string {
  if (!spec) return `节点 #${id}`
  if (spec.edit) return `编辑 #${id}`
  if (spec.genKind === 'video') return `视频 #${id}`
  if (spec.genKind === 'audio') return `音频 #${id}`
  if (spec.genKind === 'compose') return `合成 #${id}`
  return `图片 #${id}`
}

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
