import type { ComposeTransition } from './compose'

// ===== 创作画布（写模型；GET /canvases/:id 全量读模型契约） =====

export type CanvasNodeKind = 'asset' | 'gen' | 'text' | 'entity' | 'run'
export type CanvasEdgePort =
  | 'reference'
  | 'first_frame'
  | 'last_frame'
  | 'source'
  | 'prompt'
  | 'video'
  | 'audio'
  | 'text'
export type CanvasEditMode = 'inpaint' | 'erase' | 'outpaint'
/** 生成类型（image/video/audio/compose + llm=文本处理/图生文） */
export type GenKind = 'image' | 'video' | 'audio' | 'compose' | 'llm'

/** gen 节点编辑规格（inpaint/erase 需 maskAssetId；outpaint 用 expand 三元组） */
export interface NodeSpecEdit {
  mode: CanvasEditMode
  maskAssetId?: number
  expand?: { angle?: number; xScale?: number; yScale?: number }
}

/** 字幕模式（compose：none=不出字幕 / auto=音轨文本自动生成 / asset=已有 SRT 资产重钉） */
export type ComposeSubtitleMode = 'none' | 'auto' | 'asset'
/** 对齐画面适配（compose：pad=信箱补边（现状零漂移）/ crop=裁切满幅） */
export type ComposeFit = 'pad' | 'crop'

/** gen 节点 spec（服务端 parseNodeSpec 同构） */
export interface CreationNodeSpec {
  genKind: GenKind
  prompt: string
  size?: string
  duration?: number
  resolution?: string
  aspectRatio?: string
  /** 输出帧率（仅 compose 有意义） */
  fps?: number
  /** 合成转场 token（仅 compose；TRANSITIONS 枚举，服务端校验） */
  transition?: ComposeTransition
  /** 转场时长秒（仅 compose，0.1-2，缺省 0.5） */
  transitionDuration?: number
  /** BGM 音量 0-1（仅 compose，缺省 0.5） */
  bgmVolume?: number
  /** BGM 首尾淡入淡出（仅 compose，缺省 true） */
  bgmFade?: boolean
  /** BGM 资产 id（仅 compose；须属本项目 audio 资产） */
  bgmAssetId?: number
  /** 音字对齐（仅 compose；video[i]↔audio[i] 段级配对，时长取较长者，短段冻帧/静音补齐） */
  align?: boolean
  /** 字幕模式（仅 compose，缺省 none；生成/烧录均依赖 align） */
  subtitle?: ComposeSubtitleMode
  /** 字幕资产 id（subtitle='asset'：已有 SRT 资产按段重钉） */
  subtitleAssetId?: number
  /** 烧录字幕（仅 compose，缺省 false——缺省仅生成 SRT 资产） */
  burnSubtitles?: boolean
  /** 对齐画面适配（仅 compose，缺省 pad；P2 生效） */
  fit?: ComposeFit
  /** LLM 采样温度（仅 llm，0-2，缺省 0.7） */
  temperature?: number
  /** LLM 最大输出 token（仅 llm，1-32000，缺省 2048） */
  maxTokens?: number
  /** 声线令牌（仅 audio；全 ASCII 供应商枚举） */
  voice?: string
  /** 语速（仅 audio，0.25-4） */
  speed?: number
  /** 端点覆盖（缺省走 resolveEndpoint） */
  provider?: string
  model?: string
  /** 默认 true，对齐 ai_image use_style_preset 口径 */
  useStylePreset?: boolean
  edit?: NodeSpecEdit
}

/** kind=text：文本节点（text→gen 的 prompt 源；资产全文提取） */
export interface TextNodeSpec {
  text: string
}

/** kind=entity：实体参考直通（characters 行） */
export interface EntityNodeSpec {
  entityId: number
}

/** kind=run：内嵌运行（pipeline_runs 行，须属同项目） */
export interface RunNodeSpec {
  runId: number
}

/** 读模型节点 spec 联合（按 kind 分派解析） */
export type AnyNodeSpec =
  CreationNodeSpec | TextNodeSpec | EntityNodeSpec | RunNodeSpec

/** 画布视口（pan/zoom 持久化） */
export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

/** 画布文档内资产视图（含缩略；toAssetLite 子集） */
export interface CanvasAssetLite {
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

/** 画布任务摘要（gen_tasks 行派生；run/step 恒 null） */
export interface CanvasGenTaskLite {
  id: number
  status: string
  attempts: number
  errorMsg: string | null
  taskId: string | null
  resultAssetId: number | null
  createdAt: number
  completedAt: number | null
}

/** 编辑能力声明快照（edit 节点才非 null；供应商未声明 → 全 false） */
export interface CanvasEditCapability {
  inpaint: boolean
  erase: boolean
  outpaint: boolean
}

/** 画布文档节点（状态/结果零存量，由 gen_tasks 派生） */
export interface CanvasDocNode {
  id: number
  kind: CanvasNodeKind
  x: number
  y: number
  title: string
  /** 故事板序号（1 起；null = 未编号） */
  seq: number | null
  /** 成组归属（canvas_groups.id；null=未成组） */
  groupId: number | null
  /** asset 节点：引用资产；gen 节点：显示产物（采纳优先）资产 */
  assetId: number | null
  asset: CanvasAssetLite | null
  /** gen → CreationNodeSpec；text/entity/run → 对应 spec；损坏 → null + specError */
  spec: AnyNodeSpec | null
  specError: string | null
  /** 仅 gen：latestTask?.status ?? 'idle' */
  status: string | null
  latestTask: CanvasGenTaskLite | null
  /** 最近 5 条摘要（新→旧） */
  tasks: CanvasGenTaskLite[]
  /** 仅 gen：采纳任务 id（null = 未采纳） */
  adoptedTaskId: number | null
  /** 仅 gen：显示任务 id（采纳优先派生） */
  displayTaskId: number | null
  /** 仅 gen：显示任务（含产物资产冗余） */
  displayTask: CanvasDisplayTask | null
  /** 仅 gen：结果画廊（最近成功 ≤12） */
  results: CanvasResultItem[]
  /** 仅 entity：实体摘要 */
  entity: CanvasEntityInfo | null
  /** 仅 run：运行摘要 */
  run: CanvasRunInfo | null
  readiness: { ready: boolean; problems: string[]; notes?: string[] } | null
  editCapability: CanvasEditCapability | null
  canRun: boolean | null
  canCancel: boolean | null
}

/** gen 节点结果画廊条目（最近成功产物） */
export interface CanvasResultItem {
  taskId: number
  assetId: number
  asset: CanvasAssetLite | null
  createdAt: number
}

/** entity 节点实体摘要 */
export interface CanvasEntityInfo {
  id: number
  name: string
  kind: string
  refCount: number
  asset: CanvasAssetLite | null
}

/** run 节点运行摘要 */
export interface CanvasRunInfo {
  id: number
  templateKey: string
  status: string
  startedAt: number | null
  completedAt: number | null
  steps: { succeeded: number; total: number }
}

/** 显示任务（gen 采纳优先产物 + 资产冗余） */
export type CanvasDisplayTask = CanvasGenTaskLite & {
  asset: CanvasAssetLite | null
}

/** 节点行原始形态（POST/PATCH/copy/extract 端点返回 DB 行，spec 为 JSON 字符串） */
export interface CanvasNodeRow {
  id: number
  canvasId: number
  kind: string
  assetId: number | null
  title: string | null
  spec: string | null
  x: number
  y: number
  adoptedTaskId: number | null
  seq: number | null
  createdAt: number
  updatedAt: number
}

/** 边行原始形态（copy 端点返回 DB 行） */
export interface CanvasEdgeRow {
  id: number
  canvasId: number
  from: number
  to: number
  port: string
  createdAt: number
}

/** 整理模式（服务端 ARRANGE_MODES 同构； +force） */
export type CanvasArrangeMode =
  | 'layered'
  | 'grid'
  | 'force'
  | 'align-left'
  | 'align-right'
  | 'align-top'
  | 'align-bottom'
  | 'distribute-h'
  | 'distribute-v'

/** 批量执行结果（canvases/run） */
export interface CanvasRunBatchResult {
  started: Array<{ nodeId: number; taskId: number; taskIds: number[] }>
  skipped: Array<{ nodeId: number; problems: string[] }>
}

// ===== 执行成本预估（canvases/run-preview；单位与 usage.ts 同源） =====

/** 计费单位（服务端 usage.ts UsageUnit 同构） */
export type UsageUnit = 'tokens_in' | 'tokens_out' | 'image' | 'second' | 'char'

/** 预估单行（unitPrice/subtotal 为 null = 未计价） */
export interface PreviewUnitLine {
  unit: UsageUnit
  quantity: number
  unitPrice: number | null
  subtotal: number | null
}

/** 预估节点条目（ready = 无 problems 且非 busy） */
export interface PreviewNodeItem {
  nodeId: number
  title: string
  genKind: string
  ready: boolean
  busy: boolean
  problems: string[]
  units: PreviewUnitLine[]
  total: number | null
  /** tokens 不可预知（llm 按量计费）或单价链未命中 */
  unpriced: boolean
}

/** 预估响应（amount 仅含有价节点；unpriced = 未计价节点数） */
export interface PreviewCanvasResult {
  nodes: PreviewNodeItem[]
  total: {
    amount: number
    unpriced: number
    ready: number
    blocked: number
    busy: number
  }
}

/** 导出 zip 结果（creation-export） */
export interface CanvasExportResult {
  asset: { id: number; name: string; size: number | null }
  stats: { packed: number; skipped: number }
}

/** 画布边（手画引用语义：from/to 均为节点 id） */
export interface CanvasDocEdge {
  id: number
  from: number
  to: number
  port: string
}

/** 画布分组（成员由节点 groupId 前端派生；空组用存储 x/y 显示；parentId 支持嵌套） */
export interface CanvasGroup {
  id: number
  title: string
  color: string | null
  collapsed: boolean
  x: number
  y: number
  /** 所属父组（null=顶层；嵌套多层） */
  parentId: number | null
}

/** 画布文档全量读模型 */
export interface CanvasDoc {
  canvas: {
    id: number
    projectId: number
    name: string
    viewport: CanvasViewport
  }
  nodes: CanvasDocNode[]
  edges: CanvasDocEdge[]
  /** 节点分组（成组/折叠） */
  groups: CanvasGroup[]
}

/** 画布列表项 */
export interface CanvasListItem {
  id: number
  projectId: number
  name: string
  nodeCount: number
  createdAt: number
  updatedAt: number
  /** 回收站标记（null=正常；非 null=软删时间戳） */
  deletedAt: number | null
  /** 列表封面（最近完成 succeeded 任务产物缩略；无 → null） */
  cover: CanvasAssetLite | null
}

/** 画布快照元信息（列表用；不含文档全文） */
export interface CanvasSnapshotMeta {
  id: number
  label: string
  nodeCount: number
  edgeCount: number
  groupCount: number
  createdAt: number
}

/** 快照恢复结果（restored = 重放计数；backupSnapshotId = 恢复前自动备份） */
export interface SnapshotRestoreResult {
  ok: boolean
  backupSnapshotId: number
  restored: { nodes: number; edges: number; groups: number }
}

// ===== 快照对比（服务端 snapshot-diff 同构；展示值经 200 字符截断） =====

/** 单项字段变更（before/after 已截断，展示直用） */
export interface SnapshotDiffChange {
  field: string
  before: unknown
  after: unknown
}

/** 行级简单条目（added/removed 用） */
export interface SnapshotDiffItem {
  id: number
  title: string
}

/** 行级变更条目（modified 用） */
export interface SnapshotDiffEntry {
  id: number
  title: string
  changes: SnapshotDiffChange[]
}

export interface SnapshotDiffBucket {
  added: SnapshotDiffItem[]
  removed: SnapshotDiffItem[]
  modified: SnapshotDiffEntry[]
}

export interface SnapshotDiffCount {
  added: number
  removed: number
  modified: number
}

export interface SnapshotDiffSummary {
  nodes: SnapshotDiffCount
  edges: SnapshotDiffCount
  groups: SnapshotDiffCount
}

export interface SnapshotDiff {
  summary: SnapshotDiffSummary
  nodes: SnapshotDiffBucket
  edges: SnapshotDiffBucket
  groups: SnapshotDiffBucket
}

/** 快照对比响应（base=对比基准快照；target=live 或另一快照） */
export interface SnapshotDiffResult extends SnapshotDiff {
  base: { kind: 'snapshot'; id: number; label: string }
  target: { kind: 'snapshot'; id: number; label: string } | { kind: 'live' }
}

// ===== LLM 建议式编排（POST /canvases/:id/advice 契约；仅建议不执行） =====

/** 建议 kind（raw = LLM 原文解析失败降级标记，白名单外） */
export type CanvasAdviceKind =
  'structure' | 'connect' | 'config' | 'generate' | 'cleanup' | 'raw'

/** 单条建议（targetNodeId 已由服务端校验存在→剔除；定位用） */
export interface CanvasAdviceItem {
  kind: CanvasAdviceKind
  targetNodeId?: number
  title: string
  detail: string
}

/** 建议响应（mode：json=结构化归一成功 / raw=原文降级；usage 为 null=用量未知） */
export interface CanvasAdviceResult {
  advice: CanvasAdviceItem[]
  mode: 'json' | 'raw'
  provider: string
  model: string
  usage: { tokensIn: number; tokensOut: number } | null
}
