// 自 services/creation.ts 拆分：节点规格常量/类型与解析校验纯函数（导出面冻结）。
import { TRANSITIONS } from '../compose-config'

// ---------- 常量与类型 ----------

export const NODE_KINDS = ['asset', 'gen', 'text', 'entity', 'run'] as const
export type NodeKind = (typeof NODE_KINDS)[number]

/** gen 节点生成类型（audio=配音；compose=视频合成；llm=文本处理/图生文） */
export const GEN_KINDS = ['image', 'video', 'audio', 'compose', 'llm'] as const
export type GenKind = (typeof GEN_KINDS)[number]

export const EDGE_PORTS = ['reference', 'first_frame', 'last_frame', 'source', 'prompt', 'video', 'audio', 'text'] as const
export type EdgePort = (typeof EDGE_PORTS)[number]

export const EDIT_MODES = ['inpaint', 'erase', 'outpaint'] as const
export type EditMode = (typeof EDIT_MODES)[number]

/** 参考图端口容量（图片 ≤6 / 视频 ≤2 / llm ≤4；镜像 ai_image / ai_video 单镜参考图上限） */
export const REF_CAP: Record<'image' | 'video' | 'llm', number> = { image: 6, video: 2, llm: 4 }

/** LLM 节点 text 端口（素材文本）上限 */
export const LLM_TEXT_CAP = 4

/** 合成节点单端口输入上限（video / audio 各 ≤4） */
export const COMPOSE_CAP = 4

/** 字幕模式（compose：none=不出字幕 / auto=音轨文本自动生成 / asset=已有 SRT 资产重钉） */
export const SUBTITLE_MODES = ['none', 'auto', 'asset'] as const
export type SubtitleMode = (typeof SUBTITLE_MODES)[number]

/** 对齐时画面适配（compose：pad=信箱补边（现状零漂移）/ crop=裁切满幅） */
export const COMPOSE_FITS = ['pad', 'crop'] as const
export type ComposeFit = (typeof COMPOSE_FITS)[number]

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
  /** 输出帧率（仅 compose 有意义） */
  fps?: number
  /** 转场 token（仅 compose；TRANSITIONS 枚举） */
  transition?: string
  /** 转场时长秒（仅 compose，0.1-2，默认 0.5） */
  transitionDuration?: number
  /** BGM 资产 id（仅 compose；须属本项目 audio 资产） */
  bgmAssetId?: number
  /** BGM 音量（仅 compose，0-1，默认 0.5） */
  bgmVolume?: number
  /** BGM 首尾淡入淡出（仅 compose，默认 true） */
  bgmFade?: boolean
  /** 音字对齐（仅 compose，默认 false；video[i]↔audio[i] 边序配对，段时长=max，短段冻帧/静音补齐） */
  align?: boolean
  /** 字幕模式（仅 compose，默认 'none'） */
  subtitle?: SubtitleMode
  /** 字幕资产 id（subtitle='asset'：已有 SRT 资产，存在性校验在服务层——bgmAssetId 先例） */
  subtitleAssetId?: number
  /** 烧录字幕（仅 compose，默认 false——缺省仅生成 SRT 资产） */
  burnSubtitles?: boolean
  /** 对齐画面适配（仅 compose，默认 'pad'） */
  fit?: ComposeFit
  /** 声线令牌（仅 audio；全 ASCII 供应商枚举，语义短语经 resolveVoiceChain 降级） */
  voice?: string
  /** 语速（仅 audio，0.25-4） */
  speed?: number
  /** 情绪透传（仅 audio）：完整 emotion hint（`基调词——六维细节`）；仅当 audio 实例 extra 声明 emotion_param 时下发 */
  emotion?: string
  provider?: string
  model?: string
  /** LLM 温度（仅 llm，0-2，默认 0.8） */
  temperature?: number
  /** LLM 输出预算 tokens（仅 llm，1-128000，默认 12000） */
  maxTokens?: number
  useStylePreset?: boolean
  edit?: NodeSpecEdit
  /**
   * 锁版：上游节点 id（字符串键）→ 锁定的输入资产 id（下次执行强制用该资产，无视采纳/最新切换）。
   * 语义独立于 adoptedTaskId（选片）；缺省（无键）走最新/采纳。加法字段，旧 spec 无此键行为不变。
   */
  pin?: Record<string, number>
}

/** kind=text：提示词/文案节点 */
export interface TextSpec {
  text: string
}

/** kind=entity：实体参考直通（characters 行） */
export interface EntitySpec {
  entityId: number
}

/** kind=run：内嵌运行（pipeline_runs 行，须属同项目） */
export interface RunSpec {
  runId: number
}

/** 读模型节点 spec 联合（按 kind 分派解析） */
export type AnyNodeSpec = NodeSpec | TextSpec | EntitySpec | RunSpec

/** spec 类型守卫：是否 gen 规范（含 genKind 字段） */
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
  /** text 节点：提示词内容 */
  text?: string | null
  /** entity 节点：参考资产 id 集（执行时按 REF_CAP 截断展开） */
  refAssetIds?: number[] | null
  /** entity 节点：背后实体 id（供参考图实体版本溯源） */
  entityId?: number | null
}

export interface InputPlan {
  referenceAssetIds: number[]
  firstFrameAssetId: number | null
  lastFrameAssetId: number | null
  sourceAssetId: number | null
  /** prompt 端口（text 节点内容；非 null 时覆盖 spec.prompt） */
  promptText: string | null
  /** compose 视频输入（边创建序） */
  videoAssetIds: number[]
  /** compose 音频输入（边创建序） */
  audioAssetIds: number[]
  /** text 端口（llm 素材文本，边创建序 ≤4） */
  textInputs: string[]
  /** prompt 端口来源（节点 id + 背后资产 id；内联 text 节点 assetId=null） */
  promptSource: { nodeId: number; assetId: number | null } | null
  /** text 端口素材来源（与 textInputs 同序；节点 id + 背后资产 id） */
  textSources: Array<{ nodeId: number; assetId: number | null }>
  /** 参考图来源实体 id（entity 节点展开去重；供实体版本溯源） */
  entitySources: number[]
  problems: string[]
  /** 宽容提示（实体截断等；不阻断执行） */
  notes: string[]
}

/** 结果画廊条目（最近成功 ≤12） */
export interface CanvasResultItem {
  taskId: number
  assetId: number
  asset: AssetLite | null
  createdAt: number
}

/** entity 节点实体摘要 */
export interface CanvasEntityInfo {
  id: number
  name: string
  kind: string
  refCount: number
  asset: AssetLite | null
}

/** run 节点运行摘要（pipeline_runs + steps 计数） */
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
  /** 故事板序号（1 起；null = 未编号） */
  seq?: number | null
  /** 成组归属（canvas_groups.id；null=未成组） */
  groupId?: number | null
  /** asset 节点：引用资产；gen 节点：显示产物（采纳优先）资产（冗余方便前端） */
  assetId: number | null
  asset: AssetLite | null
  /** gen → NodeSpec；text → TextSpec；entity → EntitySpec；run → RunSpec；损坏 → null + specError */
  spec: AnyNodeSpec | null
  specError: string | null
  /** 仅 gen：latestTask?.status ?? 'idle' */
  status: string | null
  latestTask: GenTaskLite | null
  tasks: GenTaskLite[]
  /** 仅 gen：采纳任务 id（null = 未采纳） */
  adoptedTaskId?: number | null
  /** 仅 gen：显示任务 id（采纳优先派生） */
  displayTaskId?: number | null
  /** 仅 gen：显示任务（含产物资产冗余） */
  displayTask?: (GenTaskLite & { asset: AssetLite | null }) | null
  /** 仅 gen：结果画廊（最近成功 ≤12） */
  results?: CanvasResultItem[]
  readiness: { ready: boolean; problems: string[]; notes?: string[] } | null
  editCapability: EditCapability | null
  canRun: boolean | null
  canCancel: boolean | null
  /** 仅 entity */
  entity?: CanvasEntityInfo | null
  /** 仅 run */
  run?: CanvasRunInfo | null
}

export interface CanvasDocEdgeView {
  id: number
  from: number
  to: number
  port: string
}

/** 画布分组视图（成员由节点 groupId 前端派生；空组用存储 x/y 显示） */
export interface CanvasDocGroup {
  id: number
  title: string
  color: string | null
  collapsed: boolean
  x: number
  y: number
  /** 父组 id（null=顶层；前端嵌套渲染/移组菜单依赖） */
  parentId: number | null
}

export interface CanvasDoc {
  canvas: { id: number; projectId: number; name: string; viewport: Viewport }
  nodes: CanvasDocNode[]
  edges: CanvasDocEdgeView[]
  /** 节点分组（成组/折叠） */
  groups: CanvasDocGroup[]
}

export interface CanvasListItem {
  id: number
  projectId: number
  name: string
  nodeCount: number
  createdAt: number
  updatedAt: number
  /** 回收站标记（null=正常；非 null=软删时间戳） */
  deletedAt: number | null
  /** 列表封面：该画布最近完成 succeeded 任务的产物缩略（无 → null） */
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
  if (o['align'] !== undefined) {
    if (typeof o['align'] !== 'boolean') throw new Error('spec.align 需为布尔')
    spec.align = o['align']
  }
  if (o['subtitle'] !== undefined && o['subtitle'] !== null) {
    const st = o['subtitle']
    if (typeof st !== 'string' || !(SUBTITLE_MODES as readonly string[]).includes(st)) {
      throw new Error(`spec.subtitle 非法（${SUBTITLE_MODES.join('|')}）`)
    }
    spec.subtitle = st as SubtitleMode
  }
  if (o['subtitleAssetId'] !== undefined && o['subtitleAssetId'] !== null) {
    const sa = o['subtitleAssetId']
    if (typeof sa !== 'number' || !Number.isInteger(sa) || sa <= 0) throw new Error('spec.subtitleAssetId 需为正整数')
    spec.subtitleAssetId = sa
  }
  if (o['burnSubtitles'] !== undefined) {
    if (typeof o['burnSubtitles'] !== 'boolean') throw new Error('spec.burnSubtitles 需为布尔')
    spec.burnSubtitles = o['burnSubtitles']
  }
  if (o['fit'] !== undefined && o['fit'] !== null) {
    const ft = o['fit']
    if (typeof ft !== 'string' || !(COMPOSE_FITS as readonly string[]).includes(ft)) {
      throw new Error(`spec.fit 非法（${COMPOSE_FITS.join('|')}）`)
    }
    spec.fit = ft as ComposeFit
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
  if (o['emotion'] !== undefined && o['emotion'] !== null) {
    const em = o['emotion']
    if (typeof em !== 'string') throw new Error('spec.emotion 需为字符串')
    const emTrim = em.trim()
    if (emTrim) {
      if (emTrim.length > 200) throw new Error('spec.emotion 需为 1-200 字')
      spec.emotion = emTrim
    }
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
  // pin（锁版）：{ [上游节点id字符串]: 资产id 正整数 }；空对象/缺省 → 不设置
  if (o['pin'] !== undefined && o['pin'] !== null) {
    const pn = o['pin']
    if (typeof pn !== 'object' || Array.isArray(pn)) throw new Error('spec.pin 需为对象（节点id→资产id）')
    const pin: Record<string, number> = {}
    for (const [k, v] of Object.entries(pn as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`spec.pin[${k}] 需为正整数资产 id`)
      pin[k] = v
    }
    if (Object.keys(pin).length > 0) spec.pin = pin
  }
  return spec
}

/** text spec 结构校验：{ text: string }（空文本属 readiness 语义） */
export function parseTextSpec(raw: unknown): TextSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('text spec 需为对象（{ text }）')
  const o = raw as Record<string, unknown>
  const text = o['text'] === undefined ? '' : o['text']
  if (typeof text !== 'string') throw new Error('spec.text 需为字符串')
  return { text }
}

/** entity spec 结构校验：{ entityId: 正整数 } */
export function parseEntitySpec(raw: unknown): EntitySpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('entity spec 需为对象（{ entityId }）')
  const o = raw as Record<string, unknown>
  const id = Number(o['entityId'])
  if (!Number.isInteger(id) || id <= 0) throw new Error('spec.entityId 需为正整数')
  return { entityId: id }
}

/** run spec 结构校验：{ runId: 正整数 } */
export function parseRunSpec(raw: unknown): RunSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('run spec 需为对象（{ runId }）')
  const o = raw as Record<string, unknown>
  const id = Number(o['runId'])
  if (!Number.isInteger(id) || id <= 0) throw new Error('spec.runId 需为正整数')
  return { runId: id }
}

/** 通用 spec 宽容解析：坏 JSON → { spec: null, error }（读模型防炸） */
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

/** spec 宽容解析（text / entity / run） */
export function safeParseTextSpec(raw: string | null): { spec: TextSpec | null; error: string | null } {
  return safeParseRaw(raw, parseTextSpec)
}

export function safeParseEntitySpec(raw: string | null): { spec: EntitySpec | null; error: string | null } {
  return safeParseRaw(raw, parseEntitySpec)
}

export function safeParseRunSpec(raw: string | null): { spec: RunSpec | null; error: string | null } {
  return safeParseRaw(raw, parseRunSpec)
}

/** spec 业务完备性（readiness 用）：结构合法但有缺失 → 问题清单（ hasPromptInput：prompt 端口已供文本 → 空 prompt 不再报） */
export function specProblems(spec: NodeSpec, hasPromptInput = false): string[] {
  const problems: string[] = []
  if (spec.genKind === 'compose') return problems // 输入全部来自连线；缺 video 输入由 planNodeInputs 报
  if (spec.genKind === 'llm') {
    // 指令 = prompt 端口文本 > spec.prompt（LLM 未配置由 preflight 追加）
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

/** characters.refAssetIds（JSON 数组）宽容解析：非法 → [] */
export function parseRefIds(raw: string | null): number[] {
  try {
    const arr: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(arr)) return []
    return arr.map(Number).filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}
