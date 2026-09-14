import { readFileSync } from 'node:fs'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import { db } from '../db'
import {
  assets,
  canvasEdges,
  canvasGroups,
  canvasNodes,
  canvasSnapshots,
  canvases,
  characters,
  genTasks,
  pipelineRuns,
  pipelineSteps,
} from '../db/schema'
import type { Canvas, CanvasEdge, CanvasNode, CanvasSnapshot } from '../db/schema'
import { getImageAdapter, resolveEndpoint } from '../adapters/provider'
import { saveTemplate, templateFileOf, validateTemplateText, type TemplateValidation } from '../pipeline/loader'
import { assertProjectAssets } from '../pipeline/refs'
import { createRunRow, InvalidRunInputError } from './run-create'
import { TRANSITIONS } from './compose-config'
import { emitStudioEvent } from './events'
import { absPathOf } from './storage'

/**
 * [M16/M17] 创作画布文档层（写模型）：
 * - buildCanvasDoc：画布全量读模型——节点状态/结果零存量，由 gen_tasks（canvasNodeId）派生；[M17] 全型节点
 *   （asset|gen|text|entity|run）与端口矩阵 v3（[M18] +text 端口 / +llm 目标 + entity 源）、采纳优先（pickDisplayTask）、
 *   结果画廊（results）、run 节点运行摘要；
 * - CRUD + 端口规则矩阵校验（含环检测 + [M17] from 侧类型校验）；duplicate 深拷；buildTemplateDraft 低保真草案导出；
 * - [M17] extractTextNode：从 gen（spec.prompt）或文本资产提取文本节点；
 * - [M18] 回收站（软删/恢复/purge，findCanvas 为统一过滤点）+ 文档快照（保留 id 重放；恢复前自动备份）；
 * - 执行通道见 services/creation-gen.ts（本文件零网络、零适配器调用）。
 * 宽容降级：坏 spec / 上游缺产物 / 实体超限截断 → readiness problems/notes 列出（不炸）。
 */

// ---------- 常量与类型 ----------

export const NODE_KINDS = ['asset', 'gen', 'text', 'entity', 'run'] as const
export type NodeKind = (typeof NODE_KINDS)[number]

/** [M17/M18] gen 节点生成类型（audio=配音；compose=视频合成；llm=文本处理/图生文） */
export const GEN_KINDS = ['image', 'video', 'audio', 'compose', 'llm'] as const
export type GenKind = (typeof GEN_KINDS)[number]

export const EDGE_PORTS = ['reference', 'first_frame', 'last_frame', 'source', 'prompt', 'video', 'audio', 'text'] as const
export type EdgePort = (typeof EDGE_PORTS)[number]

export const EDIT_MODES = ['inpaint', 'erase', 'outpaint'] as const
export type EditMode = (typeof EDIT_MODES)[number]

/** 参考图端口容量（图片 ≤6 / 视频 ≤2 / [M18] llm ≤4；镜像 ai_image / ai_video 单镜参考图上限） */
export const REF_CAP: Record<'image' | 'video' | 'llm', number> = { image: 6, video: 2, llm: 4 }

/** [M18] LLM 节点 text 端口（素材文本）上限 */
export const LLM_TEXT_CAP = 4

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
  /** [M18] 转场 token（仅 compose；TRANSITIONS 枚举） */
  transition?: string
  /** [M18] 转场时长秒（仅 compose，0.1-2，默认 0.5） */
  transitionDuration?: number
  /** [M18] BGM 资产 id（仅 compose；须属本项目 audio 资产） */
  bgmAssetId?: number
  /** [M18] BGM 音量（仅 compose，0-1，默认 0.5） */
  bgmVolume?: number
  /** [M18] BGM 首尾淡入淡出（仅 compose，默认 true） */
  bgmFade?: boolean
  /** [M17] 声线令牌（仅 audio；全 ASCII 供应商枚举，语义短语经 resolveVoiceChain 降级） */
  voice?: string
  /** [M17] 语速（仅 audio，0.25-4） */
  speed?: number
  provider?: string
  model?: string
  /** [M18] LLM 温度（仅 llm，0-2，默认 0.8） */
  temperature?: number
  /** [M18] LLM 输出预算 tokens（仅 llm，1-128000，默认 12000） */
  maxTokens?: number
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
  /** [M18] text 端口（llm 素材文本，边创建序 ≤4） */
  textInputs: string[]
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
  /** [M18] 成组归属（canvas_groups.id；null=未成组） */
  groupId?: number | null
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

/** [M18] 画布分组视图（成员由节点 groupId 前端派生；空组用存储 x/y 显示） */
export interface CanvasDocGroup {
  id: number
  title: string
  color: string | null
  collapsed: boolean
  x: number
  y: number
}

export interface CanvasDoc {
  canvas: { id: number; projectId: number; name: string; viewport: Viewport }
  nodes: CanvasDocNode[]
  edges: CanvasDocEdgeView[]
  /** [M18] 节点分组（成组/折叠） */
  groups: CanvasDocGroup[]
}

export interface CanvasListItem {
  id: number
  projectId: number
  name: string
  nodeCount: number
  createdAt: number
  updatedAt: number
  /** [M18] 回收站标记（null=正常；非 null=软删时间戳） */
  deletedAt: number | null
  /** [M18] 列表封面：该画布最近完成 succeeded 任务的产物缩略（无 → null） */
  cover: AssetLite | null
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
  if (o['transition'] !== undefined && o['transition'] !== null) {
    const tr = o['transition']
    if (typeof tr !== 'string' || !(TRANSITIONS as readonly string[]).includes(tr)) {
      throw new Error(`spec.transition 非法（${TRANSITIONS.join('|')}）`)
    }
    spec.transition = tr
  }
  if (o['transitionDuration'] !== undefined && o['transitionDuration'] !== null) {
    const td = o['transitionDuration']
    if (typeof td !== 'number' || !Number.isFinite(td) || td < 0.1 || td > 2) throw new Error('spec.transitionDuration 需为 0.1-2 间的数字')
    spec.transitionDuration = td
  }
  if (o['bgmAssetId'] !== undefined && o['bgmAssetId'] !== null) {
    const b = o['bgmAssetId']
    if (typeof b !== 'number' || !Number.isInteger(b) || b <= 0) throw new Error('spec.bgmAssetId 需为正整数')
    spec.bgmAssetId = b
  }
  if (o['bgmVolume'] !== undefined && o['bgmVolume'] !== null) {
    const bv = o['bgmVolume']
    if (typeof bv !== 'number' || !Number.isFinite(bv) || bv < 0 || bv > 1) throw new Error('spec.bgmVolume 需为 0-1 间的数字')
    spec.bgmVolume = bv
  }
  if (o['bgmFade'] !== undefined) {
    if (typeof o['bgmFade'] !== 'boolean') throw new Error('spec.bgmFade 需为布尔')
    spec.bgmFade = o['bgmFade']
  }
  if (o['temperature'] !== undefined && o['temperature'] !== null) {
    const t = o['temperature']
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 2) throw new Error('spec.temperature 需为 0-2 间的数字')
    spec.temperature = t
  }
  if (o['maxTokens'] !== undefined && o['maxTokens'] !== null) {
    const mt = o['maxTokens']
    if (typeof mt !== 'number' || !Number.isInteger(mt) || mt < 1 || mt > 128000) throw new Error('spec.maxTokens 需为 1-128000 的整数')
    spec.maxTokens = mt
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
  if (spec.genKind === 'llm') {
    // [M18] 指令 = prompt 端口文本 > spec.prompt（LLM 未配置由 preflight 追加）
    if (!spec.prompt.trim() && !hasPromptInput) problems.push('指令为空（填写 prompt 或连接文本节点）')
    return problems
  }
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
    case 'llm':
      return 'text' // [M18] 产物为 text 资产
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

/** 端口规则矩阵校验 v3（建边用；[M18] +text 端口 / +llm 目标；返回错误文案或 null；from 提供时执行源侧类型校验） */
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
    if (spec.genKind !== 'image' && spec.genKind !== 'video' && spec.genKind !== 'llm') return '参考图端口仅图片/视频/LLM 生成节点支持'
    if (from && src !== 'image' && src !== 'entity') return `参考图来源需为图片素材/生成图/实体节点（当前类型：${srcLabel}）`
    const cap = REF_CAP[spec.genKind as 'image' | 'video' | 'llm']
    if (cur.length >= cap) return `${spec.genKind === 'llm' ? 'LLM' : spec.genKind === 'video' ? '视频' : '图片'}生成节点参考图上限 ${cap} 张`
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
    if (spec.genKind !== 'image' && spec.genKind !== 'video' && spec.genKind !== 'audio' && spec.genKind !== 'llm') {
      return '提示词端口仅图片/视频/音频/LLM 生成节点支持'
    }
    // 仅 text 节点或 llm 节点（产物文本）（文本资产节点执行侧无文本注入通道，一并拒绝）
    const fromText = from != null && (from.kind === 'text' || (from.kind === 'gen' && productKindOf(from.spec ?? null) === 'text'))
    if (from && !fromText) return `提示词端口仅接受文本节点或 LLM 节点（当前类型：${srcLabel}）`
    if (cur.length >= 1) return '提示词最多 1 条'
    return null
  }
  if (port === 'text') {
    // [M18] text 端口：仅 llm 目标；源 = text / llm 节点（素材文本，非指令）
    if (spec.genKind !== 'llm') return '文本素材端口仅 LLM 节点支持'
    const fromText = from != null && (from.kind === 'text' || (from.kind === 'gen' && productKindOf(from.spec ?? null) === 'text'))
    if (from && !fromText) return `文本素材来源需为文本节点或 LLM 节点（当前类型：${srcLabel}）`
    if (cur.length >= LLM_TEXT_CAP) return `文本素材上限 ${LLM_TEXT_CAP} 段`
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
 * 输入计划 v3（纯函数）：入边 → 各端口输入资产/文本 + 问题清单 + 宽容提示。
 * 语义 = 引用快照（采纳优先）：执行时取上游「采纳产物（有效时）或最新成功产物」；
 * [M17] 扩展：prompt 端口（text 节点内容）、video/audio 端口（compose 输入）、entity 源（refAssetIds 展开截断）；
 * [M18] 扩展：text 端口（llm 素材文本 ≤4 段）。
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
    textInputs: [],
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
      if (spec.genKind !== 'image' && spec.genKind !== 'video' && spec.genKind !== 'audio' && spec.genKind !== 'llm') {
        plan.problems.push('提示词连线仅图片/视频/音频/LLM 节点可用')
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
    if (e.port === 'text') {
      // [M18] text 端口：llm 素材文本（≤4 段；空文本 → problem）
      if (spec.genKind !== 'llm') {
        plan.problems.push('文本素材连线仅 LLM 节点可用')
        continue
      }
      if (plan.textInputs.length >= LLM_TEXT_CAP) {
        plan.problems.push(`文本素材超过上限 ${LLM_TEXT_CAP} 段（已忽略多余连线）`)
        continue
      }
      const t = upstream.get(e.from)?.text ?? null
      if (t == null || !t.trim()) {
        plan.problems.push(`文本素材来源 #${e.from} 暂无文本或为空`)
        continue
      }
      plan.textInputs.push(t.trim())
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

export async function listCanvases(projectId: number, opts?: { trash?: boolean }): Promise<CanvasListItem[]> {
  const trash = opts?.trash === true
  const where = trash
    ? and(eq(canvases.projectId, projectId), isNotNull(canvases.deletedAt))
    : and(eq(canvases.projectId, projectId), isNull(canvases.deletedAt))
  const rows = await db.select().from(canvases).where(where).orderBy(desc(canvases.updatedAt))
  if (rows.length === 0) return []
  const counts = await db
    .select({ canvasId: canvasNodes.canvasId, n: count() })
    .from(canvasNodes)
    .where(inArray(canvasNodes.canvasId, rows.map((r) => r.id)))
    .groupBy(canvasNodes.canvasId)
  const byId = new Map(counts.map((c) => [c.canvasId, Number(c.n)]))
  // [M18] cover 派生（两次批查避 N+1）：节点 → succeeded 有产物任务（completedAt 降序）取每画布最近一条 → 批查资产
  const nodeRows = await db
    .select({ id: canvasNodes.id, canvasId: canvasNodes.canvasId })
    .from(canvasNodes)
    .where(inArray(canvasNodes.canvasId, rows.map((r) => r.id)))
  const nodeToCanvas = new Map(nodeRows.map((n) => [n.id, n.canvasId]))
  const coverAssetByCanvas = new Map<number, number>()
  if (nodeRows.length > 0) {
    const taskRows = await db
      .select({ canvasNodeId: genTasks.canvasNodeId, resultAssetId: genTasks.resultAssetId })
      .from(genTasks)
      .where(
        and(
          inArray(genTasks.canvasNodeId, nodeRows.map((n) => n.id)),
          eq(genTasks.status, 'succeeded'),
          isNotNull(genTasks.resultAssetId),
        ),
      )
      .orderBy(desc(genTasks.completedAt))
    for (const t of taskRows) {
      if (t.canvasNodeId == null || t.resultAssetId == null) continue
      const cid = nodeToCanvas.get(t.canvasNodeId)
      if (cid == null) continue
      if (!coverAssetByCanvas.has(cid)) coverAssetByCanvas.set(cid, t.resultAssetId) // 降序首条 = 最近完成
    }
  }
  const coverIds = [...new Set([...coverAssetByCanvas.values()])]
  const coverRows = coverIds.length ? await db.select().from(assets).where(inArray(assets.id, coverIds)) : []
  const coverById = new Map(coverRows.map((a) => [a.id, a]))
  return rows.map((r) => {
    const coverId = coverAssetByCanvas.get(r.id)
    const coverAsset = coverId != null ? coverById.get(coverId) : undefined
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      nodeCount: byId.get(r.id) ?? 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt,
      cover: coverAsset ? toAssetLite(coverAsset) : null,
    }
  })
}

export async function createCanvas(projectId: number, name?: string): Promise<Canvas> {
  const now = Date.now()
  const [row] = await db
    .insert(canvases)
    .values({ projectId, name: name?.trim() || '未命名画布', createdAt: now, updatedAt: now })
    .returning()
  return row!
}

/** [M18] 画布行装载（统一过滤点）：默认仅活跃画布（已软删 → null，子端点一律 404）；includeDeleted 供 restore/purge */
export async function findCanvas(id: number, opts?: { includeDeleted?: boolean }): Promise<Canvas | null> {
  const rows = await db.select().from(canvases).where(eq(canvases.id, id)).limit(1)
  const row = rows[0] ?? null
  if (!row) return null
  if (row.deletedAt != null && opts?.includeDeleted !== true) return null
  return row
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

// 注：原 M16 硬删 deleteCanvas 已由 M18 softDeleteCanvas（软删）+ purgeCanvas（彻底删）取代

// ---------- [M18] 回收站（软删 / 恢复 / purge） ----------

/** [M18] 软删（进回收站）：仅标 deletedAt（子行保留；在途任务由路由层 cancelCanvasTasks 取消） */
export async function softDeleteCanvas(canvas: Canvas): Promise<Canvas> {
  const now = Date.now()
  const [row] = await db
    .update(canvases)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(canvases.id, canvas.id))
    .returning()
  emitStudioEvent({ type: 'canvas.changed', canvasId: canvas.id, projectId: canvas.projectId })
  return row!
}

/** [M18] 回收站恢复（行须为已软删；路由层已做状态判定与 404） */
export async function restoreCanvas(canvas: Canvas): Promise<Canvas> {
  const [row] = await db
    .update(canvases)
    .set({ deletedAt: null, updatedAt: Date.now() })
    .where(eq(canvases.id, canvas.id))
    .returning()
  emitStudioEvent({ type: 'canvas.changed', canvasId: canvas.id, projectId: canvas.projectId })
  return row!
}

/** [M18] 彻底删除（行须为已软删；级联删 nodes/edges/groups/snapshots；gen_tasks 行保留留痕） */
export async function purgeCanvas(canvasId: number): Promise<void> {
  await db.delete(canvasEdges).where(eq(canvasEdges.canvasId, canvasId))
  await db.delete(canvasNodes).where(eq(canvasNodes.canvasId, canvasId))
  await db.delete(canvasGroups).where(eq(canvasGroups.canvasId, canvasId))
  await db.delete(canvasSnapshots).where(eq(canvasSnapshots.canvasId, canvasId))
  await db.delete(canvases).where(eq(canvases.id, canvasId))
}

// ---------- [M18] 文档快照（保留 id 重放） ----------

/** [M18] 每画布快照上限（手动创建满额 → 400 提示清理；恢复前自动备份满额 → 驱逐最旧） */
export const SNAPSHOT_LIMIT = 20

/** [M18] 快照文档形态（全量行 JSON；id 保留用于重放——adoptedTaskId→gen_tasks.canvasNodeId 不孤儿） */
export interface CanvasSnapshotDoc {
  nodes: Array<typeof canvasNodes.$inferSelect>
  edges: Array<typeof canvasEdges.$inferSelect>
  groups: Array<typeof canvasGroups.$inferSelect>
}

/** [M18] 快照元信息（列表；不含 doc 全文） */
export interface CanvasSnapshotMeta {
  id: number
  label: string
  nodeCount: number
  edgeCount: number
  groupCount: number
  createdAt: number
}

/** [M18] 恢复冲突（快照行 id 被他画布占用；路由层映射 409） */
export class SnapshotConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotConflictError'
  }
}

/** [M18] 恢复结果（backupSnapshotId = 恢复前自动备份；restored = 重放行数） */
export interface SnapshotRestoreResult {
  backupSnapshotId: number
  restored: { nodes: number; edges: number; groups: number }
}

/** 数组分块（SQLite 变量数上限保护） */
function chunkIds(ids: number[], size = 500): number[][] {
  const out: number[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/** [M18] 采集当前文档全量行 */
async function collectSnapshotDoc(canvasId: number): Promise<CanvasSnapshotDoc> {
  const [nodes, edges, groups] = await Promise.all([
    db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, canvasId)).orderBy(asc(canvasNodes.id)),
    db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, canvasId)).orderBy(asc(canvasEdges.id)),
    db.select().from(canvasGroups).where(eq(canvasGroups.canvasId, canvasId)).orderBy(asc(canvasGroups.id)),
  ])
  return { nodes, edges, groups }
}

/**
 * [M18] 创建快照：label 缺省「快照 N」；auto=true 为恢复前自动备份（满额驱逐最旧腾位，不阻断恢复）
 */
export async function createSnapshot(canvasId: number, label: unknown, opts?: { auto?: boolean }): Promise<CanvasSnapshot> {
  const canvas = await findCanvas(canvasId)
  if (!canvas) throw new Error(`画布 ${canvasId} 不存在`)
  const existing = await db
    .select({ id: canvasSnapshots.id })
    .from(canvasSnapshots)
    .where(eq(canvasSnapshots.canvasId, canvasId))
    .orderBy(asc(canvasSnapshots.createdAt), asc(canvasSnapshots.id))
  if (existing.length >= SNAPSHOT_LIMIT) {
    if (!opts?.auto) throw new Error(`快照已达上限（${SNAPSHOT_LIMIT}），请先删除旧快照`)
    const evict = existing.slice(0, existing.length - SNAPSHOT_LIMIT + 1)
    await db.delete(canvasSnapshots).where(inArray(canvasSnapshots.id, evict.map((r) => r.id)))
  }
  const name = typeof label === 'string' && label.trim() ? label.trim() : `快照 ${existing.length + 1}`
  const doc = await collectSnapshotDoc(canvasId)
  const [row] = await db
    .insert(canvasSnapshots)
    .values({ canvasId, label: name, doc: JSON.stringify(doc), createdAt: Date.now() })
    .returning()
  return row!
}

/** [M18] 快照列表（新→旧；含行数统计，不含 doc；画布不存在 → null） */
export async function listSnapshots(canvasId: number): Promise<CanvasSnapshotMeta[] | null> {
  const canvas = await findCanvas(canvasId)
  if (!canvas) return null
  const rows = await db
    .select()
    .from(canvasSnapshots)
    .where(eq(canvasSnapshots.canvasId, canvasId))
    .orderBy(desc(canvasSnapshots.createdAt), desc(canvasSnapshots.id))
  return rows.map((r) => {
    const doc = JSON.parse(r.doc) as CanvasSnapshotDoc
    return {
      id: r.id,
      label: r.label,
      nodeCount: doc.nodes.length,
      edgeCount: doc.edges.length,
      groupCount: doc.groups.length,
      createdAt: r.createdAt,
    }
  })
}

/** [M18] 删除快照（画布域限定；不存在/不属本画布 → false） */
export async function deleteSnapshot(canvasId: number, snapshotId: number): Promise<boolean> {
  const rows = await db
    .select({ id: canvasSnapshots.id })
    .from(canvasSnapshots)
    .where(and(eq(canvasSnapshots.id, snapshotId), eq(canvasSnapshots.canvasId, canvasId)))
    .limit(1)
  if (!rows[0]) return false
  await db.delete(canvasSnapshots).where(eq(canvasSnapshots.id, snapshotId))
  return true
}

/**
 * [M18] 快照恢复（保留 id 重放，spec §2.1）：
 * ①事务内先冲突预检（快照行 id 被他画布占用 → 回滚 + 409）→ ②自动备份「恢复前备份」→
 * ③清空现 nodes/edges/groups → ④按快照 doc 显式保留原 id 重插 → ⑤ emitCanvasChanged。
 * 画布/快照不存在 → null（路由 404）；行数极少场景下 id 占用仅可能来自显式建行，仍走事务回滚保护。
 */
export async function restoreSnapshot(canvasId: number, snapshotId: number): Promise<SnapshotRestoreResult | null> {
  const canvas = await findCanvas(canvasId)
  if (!canvas) return null
  const snapRows = await db
    .select()
    .from(canvasSnapshots)
    .where(and(eq(canvasSnapshots.id, snapshotId), eq(canvasSnapshots.canvasId, canvasId)))
    .limit(1)
  const snap = snapRows[0]
  if (!snap) return null
  const doc = JSON.parse(snap.doc) as CanvasSnapshotDoc

  // ① 自动备份（失败不阻断？——失败即中止：无备份不重放，保证可回退）
  const backup = await createSnapshot(canvasId, `恢复前备份（${snap.label}）`, { auto: true })

  const now = Date.now()
  await db.transaction(async (tx) => {
    // ② 冲突预检（事务内、清空前：看外部占用；本画布行即将被清空不构成冲突）
    const clashNode = doc.nodes.length
      ? (await Promise.all(chunkIds(doc.nodes.map((n) => n.id)).map((chunk) =>
          tx.select({ id: canvasNodes.id, canvasId: canvasNodes.canvasId }).from(canvasNodes).where(inArray(canvasNodes.id, chunk)),
        ))).flat().find((r) => r.canvasId !== canvasId)
      : undefined
    if (clashNode) throw new SnapshotConflictError(`快照恢复冲突：节点 #${clashNode.id} 已被其他画布占用（id 保留重放不可行）`)
    const clashEdge = doc.edges.length
      ? (await Promise.all(chunkIds(doc.edges.map((e) => e.id)).map((chunk) =>
          tx.select({ id: canvasEdges.id, canvasId: canvasEdges.canvasId }).from(canvasEdges).where(inArray(canvasEdges.id, chunk)),
        ))).flat().find((r) => r.canvasId !== canvasId)
      : undefined
    if (clashEdge) throw new SnapshotConflictError(`快照恢复冲突：边 #${clashEdge.id} 已被其他画布占用（id 保留重放不可行）`)
    const clashGroup = doc.groups.length
      ? (await Promise.all(chunkIds(doc.groups.map((g) => g.id)).map((chunk) =>
          tx.select({ id: canvasGroups.id, canvasId: canvasGroups.canvasId }).from(canvasGroups).where(inArray(canvasGroups.id, chunk)),
        ))).flat().find((r) => r.canvasId !== canvasId)
      : undefined
    if (clashGroup) throw new SnapshotConflictError(`快照恢复冲突：分组 #${clashGroup.id} 已被其他画布占用（id 保留重放不可行）`)

    // ③ 清空现文档
    await tx.delete(canvasEdges).where(eq(canvasEdges.canvasId, canvasId))
    await tx.delete(canvasNodes).where(eq(canvasNodes.canvasId, canvasId))
    await tx.delete(canvasGroups).where(eq(canvasGroups.canvasId, canvasId))

    // ④ 重放（显式保留 id；分组先于节点）
    for (const g of doc.groups) {
      await tx.insert(canvasGroups).values({
        id: g.id,
        canvasId,
        title: g.title,
        color: g.color,
        collapsed: g.collapsed,
        x: g.x,
        y: g.y,
        createdAt: g.createdAt,
      })
    }
    for (const n of doc.nodes) {
      await tx.insert(canvasNodes).values({
        id: n.id,
        canvasId,
        kind: n.kind,
        assetId: n.assetId,
        title: n.title,
        spec: n.spec,
        x: n.x,
        y: n.y,
        adoptedTaskId: n.adoptedTaskId,
        seq: n.seq,
        groupId: n.groupId,
        createdAt: n.createdAt,
        updatedAt: now,
      })
    }
    for (const e of doc.edges) {
      await tx.insert(canvasEdges).values({ id: e.id, canvasId, from: e.from, to: e.to, port: e.port, createdAt: e.createdAt })
    }
  })

  emitStudioEvent({ type: 'canvas.changed', canvasId, projectId: canvas.projectId })
  return {
    backupSnapshotId: backup.id,
    restored: { nodes: doc.nodes.length, edges: doc.edges.length, groups: doc.groups.length },
  }
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
  const groupRows = await db.select().from(canvasGroups).where(eq(canvasGroups.canvasId, canvasId)).orderBy(asc(canvasGroups.id))
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
      groupId: n.groupId ?? null,
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
    groups: groupRows.map((g) => ({ id: g.id, title: g.title, color: g.color, collapsed: g.collapsed === 1, x: g.x, y: g.y })),
  }
}

/** 执行时输入计划 v3（实时解析：采纳优先；text/entity 上游展开；[M18] llm 产物文本装载；供 creation-gen 调用） */
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
        const up: UpstreamInfo = { assetId: a?.id ?? null, mediaKind: a?.kind ?? null }
        // [M18] llm 产物文本装载：prompt/text 端口源侧取正文（文件缺失 → text 留空，planNodeInputs 报「暂无文本」）
        if (a?.kind === 'text' && a.relPath) {
          try {
            up.text = readFileSync(absPathOf(a.relPath), 'utf8')
          } catch {
            up.text = null
          }
        }
        upstream.set(r.id, up)
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

// ---------- [M18] 模板草案 v2（literal + 主步骤 + lossy 清单） ----------

/** 画布 → 流水线模板草案 v2：text/asset 节点 → inputs；gen 节点→ literal 包装 + 主步骤；llm→ ai_text prompt_inline；compose→ ffmpeg_merge；entity/run/参考图/编辑/转场/BGM → lossy */
export async function buildTemplateDraft(
  canvasId: number,
  key?: string,
): Promise<{ yaml: string; validation: TemplateValidation; lossy: string[] } | null> {
  const doc = await buildCanvasDoc(canvasId)
  if (!doc) return null
  const draftKey = key?.trim() || `canvas-draft-${canvasId}`
  if (!/^[\w-]+$/.test(draftKey)) throw new Error(`key「${draftKey}」非法（仅字母/数字/下划线/中划线）`)
  const { yaml, lossy } = buildTemplateDraftYaml(doc, draftKey)
  return { yaml, validation: validateTemplateText(yaml, draftKey), lossy }
}

export interface TemplateDraftResult {
  yaml: string
  lossy: string[]
}

/** 纯函数：v2 YAML 文本 + lossy 清单（探针直接断言） */
export function buildTemplateDraftYaml(doc: CanvasDoc, key: string): TemplateDraftResult {
  const lossy: string[] = []
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const genSpecOf = (n: CanvasDocNode): NodeSpec | null => (n.kind === 'gen' && isGenSpec(n.spec) ? n.spec : null)
  const textOf = (n: CanvasDocNode): string | null => {
    if (n.kind !== 'text' || !n.spec || typeof n.spec !== 'object') return null
    const t = (n.spec as { text?: unknown }).text
    return typeof t === 'string' ? t : null
  }

  // 1) inputs 收集（text 节点 → text 输入；asset 节点 → files 输入）
  const inputsYaml: string[] = []
  const assetInputOf = new Map<number, string>() // asset nodeId → `a{id}`
  for (const n of doc.nodes) {
    if (n.kind === 'text') {
      inputsYaml.push(
        `  - { key: t${n.id}, kind: text, label: ${yamlScalar(n.title)}, default: ${yamlScalar(textOf(n) ?? '')}, required: false }`,
      )
    } else if (n.kind === 'asset' && n.assetId != null) {
      assetInputOf.set(n.id, `a${n.id}`)
      inputsYaml.push(`  - { key: a${n.id}, kind: files, label: ${yamlScalar(n.title)}, required: false }`)
    } else if (n.kind === 'entity') {
      lossy.push(`实体节点 #${n.id}（${n.title}）：模板引擎暂无参考图直通（写入注释）`)
    } else if (n.kind === 'run') {
      lossy.push(`运行节点 #${n.id}（${n.title}）：模板引擎不支持嵌套运行（写入注释）`)
    }
  }

  // 2) gen 节点拓扑序
  const genNodes = doc.nodes.filter((n) => genSpecOf(n) != null)
  const order = topoSortGenNodeIds(genNodes.map((n) => n.id), doc.edges)

  const lines: string[] = []
  lines.push(`# 由创作画布「${doc.canvas.name}」（canvas #${doc.canvas.id}）导出——模板 v2 草案`)
  lines.push('# 说明：literal 包装提示词为 shots/lines JSON；主步骤 ai_image/ai_video/tts/ai_text(prompt_inline)/ffmpeg_merge；entity/run/参考图/编辑/转场/BGM 写入 lossy。')
  lines.push(`key: ${key}`)
  lines.push('version: 1')
  lines.push(`name: ${yamlScalar(`${doc.canvas.name} 草案`)}`)
  lines.push('description: 从创作画布导出的 v2 草案')
  lines.push('genre: other')
  if (inputsYaml.length === 0) lines.push('inputs: []')
  else {
    lines.push('inputs:')
    lines.push(...inputsYaml)
  }

  if (order.length === 0) {
    lines.push('steps: []')
    return { yaml: `${lines.join('\n')}\n`, lossy }
  }

  lines.push('steps:')
  const finalStepOf = new Map<number, string>() // gen nodeId → 主步骤 key（供下游引用）

  for (const id of order) {
    const node = byId.get(id)!
    const spec = genSpecOf(node)!
    const incoming = doc.edges.filter((e) => e.to === id)

    // ---- llm → ai_text (prompt_inline) ----
    if (spec.genKind === 'llm') {
      const sk = `n${id}`
      finalStepOf.set(id, sk)
      const after = new Set<string>()
      const inputPairs: Array<[string, string]> = []
      let idx = 0
      for (const e of incoming) {
        if (e.port !== 'text' && e.port !== 'prompt') continue
        const up = byId.get(e.from)
        if (!up) continue
        if (up.kind === 'text') {
          inputPairs.push([`text${++idx}`, `input.t${up.id}`])
        } else if (up.kind === 'gen') {
          const fk = finalStepOf.get(up.id)
          if (fk) {
            inputPairs.push([`text${++idx}`, `steps.${fk}.asset`])
            after.add(fk)
          }
        }
      }
      const refEdges = incoming.filter((e) => e.port === 'reference')
      for (const e of refEdges) {
        const up = byId.get(e.from)
        if (up?.kind === 'gen') {
          const fk = finalStepOf.get(up.id)
          if (fk) after.add(fk)
        }
      }
      if (refEdges.length > 0) {
        lossy.push(`LLM 节点 #${id}（${node.title}）：${refEdges.length} 张参考图→ ai_text 不支持多模态输入（模板层降级，运行时需图生文替代）`)
      }
      lines.push(`  - key: ${sk}`)
      lines.push('    action: ai_text')
      lines.push(`    title: ${yamlScalar(node.title)}`)
      lines.push(`    after: [${Array.from(after).join(', ')}]`)
      if (inputPairs.length > 0) {
        lines.push('    inputs:')
        for (const [k, v] of inputPairs) lines.push(`      ${k}: ${v}`)
      } else {
        lines.push('    inputs: {}')
      }
      lines.push('    params:')
      lines.push(`      prompt_inline: ${yamlScalar(spec.prompt || '（画布节点未指定指令）')}`)
      lines.push('      output_purpose: creation_llm')
      lines.push('      output_format: markdown')
      if (spec.provider || spec.model) lines.push(`    # provider/model: ${spec.provider ?? '默认'} / ${spec.model ?? '默认'}`)
      continue
    }

    // ---- compose → ffmpeg_merge ----
    if (spec.genKind === 'compose') {
      const sk = `n${id}`
      finalStepOf.set(id, sk)
      const vidRefs: string[] = []
      const audRefs: string[] = []
      const after = new Set<string>()
      for (const e of incoming) {
        const up = byId.get(e.from)
        if (!up) continue
        if (e.port === 'video') {
          if (up.kind === 'gen') {
            const fk = finalStepOf.get(up.id)
            if (fk) {
              vidRefs.push(`steps.${fk}.asset`)
              after.add(fk)
            }
          } else if (up.kind === 'asset') {
            const ak = assetInputOf.get(up.id)
            if (ak) vidRefs.push(`input.${ak}`)
          }
        } else if (e.port === 'audio') {
          if (up.kind === 'gen') {
            const fk = finalStepOf.get(up.id)
            if (fk) {
              audRefs.push(`steps.${fk}.asset`)
              after.add(fk)
            }
          } else if (up.kind === 'asset') {
            const ak = assetInputOf.get(up.id)
            if (ak) audRefs.push(`input.${ak}`)
          }
        }
      }
      lines.push(`  - key: ${sk}`)
      lines.push('    action: ffmpeg_merge')
      lines.push(`    title: ${yamlScalar(node.title)}`)
      lines.push(`    after: [${Array.from(after).join(', ')}]`)
      if (vidRefs.length === 0 && audRefs.length === 0) {
        lossy.push(`合成节点 #${id}（${node.title}）：无视频/音频上游，运行时需手动提供 inputs`)
        lines.push('    inputs: {}')
      } else {
        lines.push('    inputs:')
        if (vidRefs.length > 0) {
          lines.push('      motion_clips:')
          for (const r of vidRefs) lines.push(`        - ${r}`)
        }
        if (audRefs.length > 0) {
          lines.push('      voices:')
          for (const r of audRefs) lines.push(`        - ${r}`)
        }
      }
      lines.push('    params:')
      if (spec.fps) lines.push(`      fps: ${spec.fps}`)
      if (spec.resolution) lines.push(`      resolution: ${yamlScalar(spec.resolution)}`)
      lines.push('      output_purpose: creation_compose')
      if (spec.transition) lossy.push(`合成节点 #${id}：转场 ${spec.transition}（模板 ffmpeg_merge 无 xfade 参数，运行时需手工滤镜）`)
      if (spec.bgmAssetId) lossy.push(`合成节点 #${id}：BGM asset#${spec.bgmAssetId}（模板无 BGM 专用字段，可手动追加至 voices）`)
      continue
    }

    // ---- image / video / audio → literal + 主步骤 ----
    const litKey = `n${id}_lit`
    const sk = `n${id}`
    finalStepOf.set(id, sk)
    let action: string
    let inputField: string
    let asKind: 'storyboard-single' | 'lines-single'
    let purpose: string
    if (spec.genKind === 'audio') {
      action = 'tts'
      inputField = 'lines'
      asKind = 'lines-single'
      purpose = 'voice'
    } else if (spec.genKind === 'video') {
      action = 'ai_video'
      inputField = 'shots'
      asKind = 'storyboard-single'
      purpose = 'creation_video'
    } else {
      action = 'ai_image'
      inputField = 'shots'
      asKind = 'storyboard-single'
      purpose = 'creation_image'
    }
    const promptEdge = incoming.find((e) => e.port === 'prompt')
    const promptFrom = promptEdge ? byId.get(promptEdge.from) : null
    const after = new Set<string>()
    let textRef: string | null = null
    if (promptFrom?.kind === 'text') {
      textRef = `input.t${promptFrom.id}`
    } else if (promptFrom?.kind === 'gen') {
      const fk = finalStepOf.get(promptFrom.id)
      if (fk) {
        textRef = `steps.${fk}.asset`
        after.add(fk)
      }
    }
    for (const e of incoming) {
      if (e === promptEdge) continue
      const up = byId.get(e.from)
      if (up?.kind === 'gen') {
        const fk = finalStepOf.get(up.id)
        if (fk) after.add(fk)
      }
    }

    // lit 步骤
    lines.push(`  - key: ${litKey}`)
    lines.push('    action: literal')
    lines.push(`    title: ${yamlScalar(`${node.title} 文本`)}`)
    lines.push(`    after: [${Array.from(after).join(', ')}]`)
    if (textRef) {
      lines.push('    inputs:')
      lines.push(`      text: ${textRef}`)
      lines.push('    params:')
      lines.push(`      as: ${asKind}`)
    } else {
      lines.push('    inputs: {}')
      lines.push('    params:')
      lines.push(`      as: ${asKind}`)
      lines.push(`      payload: ${yamlScalar(spec.prompt || '（画布节点未指定提示词）')}`)
    }
    // 主步骤
    lines.push(`  - key: ${sk}`)
    lines.push(`    action: ${action}`)
    lines.push(`    title: ${yamlScalar(node.title)}`)
    lines.push(`    after: [${litKey}${after.size > 0 ? `, ${Array.from(after).join(', ')}` : ''}]`)
    lines.push('    inputs:')
    lines.push(`      ${inputField}: steps.${litKey}.asset`)
    lines.push('    params:')
    if (spec.size) lines.push(`      size: ${yamlScalar(spec.size)}`)
    if (spec.duration) lines.push(`      duration: ${spec.duration}`)
    if (spec.resolution) lines.push(`      resolution: ${yamlScalar(spec.resolution)}`)
    if (spec.aspectRatio) lines.push(`      aspect_ratio: ${yamlScalar(spec.aspectRatio)}`)
    if (spec.voice) lines.push(`      voice: ${yamlScalar(spec.voice)}`)
    if (spec.speed) lines.push(`      speed: ${spec.speed}`)
    lines.push(`      output_purpose: ${purpose}`)
    if (spec.genKind === 'image') lines.push(`      use_style_preset: ${spec.useStylePreset !== false ? 'true' : 'false'}`)
    if (spec.provider || spec.model) lines.push(`    # provider/model: ${spec.provider ?? '默认'} / ${spec.model ?? '默认'}`)
    const refEdges = incoming.filter((e) => e.port === 'reference' || e.port === 'first_frame' || e.port === 'last_frame' || e.port === 'source')
    if (refEdges.length > 0) {
      lossy.push(`${action} 节点 #${id}（${node.title}）：${refEdges.length} 条参考/首末帧/编辑源连线→ 模板层不映射，运行时需手工补充`)
    }
    if (spec.edit) {
      lossy.push(`${action} 节点 #${id}：编辑模式（${spec.edit.mode}）→ 模板层不支持，运行时需替换为普通生成或后处理`)
    }
  }

  return { yaml: `${lines.join('\n')}\n`, lossy }
}

// ---------- [M18] template-try（draft v2 → 保存模板 → 建 run） ----------

/** template-try 失败错误（路由转 400；detail 可选附送 validation.errors 清单） */
export class TemplateTryError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message)
    this.name = 'TemplateTryError'
  }
}

export interface TemplateTryResult {
  templateKey: string
  runId: number
  lossy: string[]
  input: Record<string, unknown>
}

/** 从中文名称提取可安全的模板 key 基名（非字母数字下划线中划线 → '-'；默认 'canvas'） */
function sanitizeTplKey(name: string): string {
  const s = name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s || 'canvas'
}

/**
 * [M18] 画布→模板→一键试跑：
 * - nodeIds 给定：保留该集 + 上游闭包（包含资产/文本/实体），边只保留两端均在保留集内；
 * - draft v2 同同构建 YAML + lossy；validate 失败 → TemplateTryError('validation_failed')；
 * - key 缺省 `<canvas.name>-try`（sanitize）；冲突自动后缀 -2/-3/…（最多 30 层）；
 * - inputs 预填：text 型不传（default 自会回填）；files 型传 asset 节点 assetId；
 * - createRunRow（queued）→ {templateKey, runId, lossy, input}。
 */
export async function tryRunTemplate(
  canvasId: number,
  p: { nodeIds?: number[]; key?: string } = {},
): Promise<TemplateTryResult | null> {
  const fullDoc = await buildCanvasDoc(canvasId)
  if (!fullDoc) return null

  // 子图过滤：nodeIds + 上游闭包
  let doc = fullDoc
  if (p.nodeIds && p.nodeIds.length > 0) {
    const byId = new Map(fullDoc.nodes.map((n) => [n.id, n]))
    const incomingByTo = new Map<number, Array<{ from: number; to: number; port: string; id: number }>>()
    for (const e of fullDoc.edges) {
      const arr = incomingByTo.get(e.to) ?? []
      arr.push(e)
      incomingByTo.set(e.to, arr)
    }
    const keep = new Set<number>()
    const stack: number[] = []
    for (const id of p.nodeIds) if (byId.has(id)) stack.push(id)
    while (stack.length) {
      const id = stack.pop()!
      if (keep.has(id)) continue
      keep.add(id)
      for (const e of incomingByTo.get(id) ?? []) if (!keep.has(e.from)) stack.push(e.from)
    }
    doc = {
      ...fullDoc,
      nodes: fullDoc.nodes.filter((n) => keep.has(n.id)),
      edges: fullDoc.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    }
  }

  const baseKey = (p.key?.trim() || `${sanitizeTplKey(fullDoc.canvas.name)}-try`).slice(0, 60)
  if (!/^[\w-]+$/.test(baseKey)) throw new TemplateTryError('bad_key', `key「${baseKey}」非法（仅字母/数字/下划线/中划线）`)
  let finalKey = baseKey
  let suffix = 2
  while (templateFileOf(finalKey) && suffix < 32) {
    finalKey = `${baseKey}-${suffix}`
    suffix++
  }
  if (templateFileOf(finalKey)) throw new TemplateTryError('key_conflict', `模板 key「${baseKey}」冲突无法避让`)

  const { yaml, lossy } = buildTemplateDraftYaml(doc, finalKey)
  const validation = validateTemplateText(yaml, finalKey)
  if (!validation.ok) {
    throw new TemplateTryError('validation_failed', validation.errors.join('；'), validation.errors)
  }
  try {
    saveTemplate(finalKey, yaml)
  } catch (err) {
    throw new TemplateTryError('save_failed', (err as Error).message)
  }

  // inputs 预填（files ← asset 节点 assetId；text 默认从模板 default 回填）
  const input: Record<string, unknown> = {}
  for (const n of doc.nodes) {
    if (n.kind === 'asset' && n.assetId != null) input[`a${n.id}`] = [n.assetId]
  }

  try {
    const run = await createRunRow({
      projectId: doc.canvas.projectId,
      templateKey: finalKey,
      input,
    })
    return { templateKey: finalKey, runId: run.id, lossy, input }
  } catch (err) {
    if (err instanceof InvalidRunInputError) throw new TemplateTryError('bad_input', err.message)
    throw new TemplateTryError('run_create_failed', (err as Error).message)
  }
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
  if (spec.genKind === 'llm') return `LLM #${id}`
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
