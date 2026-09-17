import type { RunStatus, StepStatus } from './base'
import type { Batch } from './batch'
import type { WorkflowStatus } from './workflow'

// ===== [M15] 流水线画布（GET /runs/:id/canvas · GET /templates/:key/canvas 契约） =====

/** 画布边：sched=调度依赖（origin 标注来源）；data=数据引用（def.inputs 的 steps.x.asset(s) 整串） */
export interface CanvasEdge {
  from: string
  to: string
  type: 'sched' | 'data'
  origin?: 'after' | 'default' | 'when'
}

/** def.inputs 引用条目（抽屉输入区展示「此步吃了谁的产物」） */
export interface CanvasRefEntry {
  field: string
  kind: 'input' | 'step' | 'assets-purpose'
  ref: string
}

/** 闸门摘要（run 态 message 已内插；模板态原文） */
export interface CanvasGateInfo {
  mode: string
  message: string
  skipLabel?: string
  when?: string | string[]
}

/** 节点级操作可用性（服务端算好，前端只渲染；rerun/recompose 文案对齐 assertRepairable） */
export interface CanvasGateActions {
  approve: boolean
  reject: boolean
  skip: boolean
}

export interface CanvasRerunActions {
  allowed: boolean
  reason: string | null
}

export interface CanvasTaskAgg {
  total: number
  pending: number
  processing: number
  succeeded: number
  failed: number
  cancelled: number
}

/** [M15] 运行画布节点（run 状态 × 步骤） */
export interface RunCanvasNode {
  key: string
  /** steps 行 id（抽屉任务过滤 / 重跑弹窗计数用；孤儿行 → null） */
  stepId: number | null
  seq: number
  action: string
  title: string
  status: StepStatus
  attempts: number
  error: string | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  gate: CanvasGateInfo | null
  gateTrace: { decision: 'approve' | 'reject'; note?: string; at: number } | null
  skippedReason: string | null
  tasks: CanvasTaskAgg
  assetIds: number[]
  /** step.input 快照（解析失败原样；行缺失 → null） */
  input: unknown
  inputsRefs: CanvasRefEntry[]
  actions: {
    gate: CanvasGateActions | null
    rerun: CanvasRerunActions | null
    recompose: CanvasRerunActions | null
    taskRetry: { count: number } | null
  }
}

/** [M15] 运行画布读模型 */
export interface RunCanvas {
  run: {
    id: number
    projectId: number
    templateKey: string
    templateVersion: number | null
    batchId: number | null
    batchSeq: number | null
    status: RunStatus
    currentStepKey: string | null
    error: string | null
    input: Record<string, unknown>
    startedAt: number | null
    completedAt: number | null
    createdAt: number
    updatedAt: number
  }
  /** 模板不可得（快照损坏且文件缺失）→ null（仅按行渲染） */
  template: { key: string; name: string; version: number } | null
  nodes: RunCanvasNode[]
  edges: CanvasEdge[]
  runActions: { canCancel: boolean; canResume: boolean }
}

/** [M23] 模板节点输入字段（画布内编辑数据源；string 顶层字段可编辑，其余只读 JSON 预览） */
export interface InputFieldView {
  key: string
  /** 当前值（string 原值；非 string → JSON.stringify 截断预览） */
  value: string
  /** 顶层 string 字段 → true（可覆盖）；其余 → false（仅预览） */
  editable: boolean
}

/** [M15] 模板画布节点（设计态，无运行字段） */
export interface TemplateCanvasNode {
  key: string
  seq: number
  action: string
  title: string
  gate: CanvasGateInfo | null
  when?: string | string[]
  whenAny?: string[]
  after?: string[]
  batch: { field: string; maxConcurrent?: number; retry?: number } | null
  output: { purpose: string } | null
  inputsRefs: CanvasRefEntry[]
  /** [M23] 编辑模式逐字段视图（保序：模板 inputs 声明顺序） */
  inputFields: InputFieldView[]
}

/** [M15] 模板画布读模型 */
export interface TemplateCanvas {
  template: { key: string; name: string; version: number; description?: string; genre: string }
  nodes: TemplateCanvasNode[]
  edges: CanvasEdge[]
}

/** [M15] CanvasBoard 通用节点视图（CanvasView 归一化 run/template 两态后传入；不参与网络契约） */
export interface CanvasBoardNode {
  key: string
  seq: number
  action: string
  title: string
  /** 运行态状态（模板态 undefined → idle 样式，不显示状态徽标） */
  status?: StepStatus
  durationMs?: number | null
  attempts?: number
  /** 任务聚合（run 态 total>0 时展示） */
  tasks?: CanvasTaskAgg
  gateMessage?: string | null
  skipLabel?: string | null
  /** 跳过/免审放行摘要（run 态） */
  skipText?: string | null
  hasError?: boolean
  assetCount?: number
  /** 模板态：when 条件摘要 */
  whenText?: string | null
  /** 模板态：批量字段摘要 */
  batchField?: string | null
}

// ===== [M23] 全景聚合（GET /canvas/overview 契约；E1/E2） =====

/** 全景 run 摘要（批次组内与独立组同构；cost 口径对齐 summarizeBatch） */
export interface OverviewRunLite {
  id: number
  batchSeq: number | null
  templateKey: string
  /** 固化快照版本（快照缺失 → null） */
  templateVersion: number | null
  status: RunStatus
  error: string | null
  input: unknown
  cost: number | null
  startedAt: number | null
  completedAt: number | null
  createdAt: number
}

/** 全景批次组：批次头（Batch 同构）+ 组内 runs（batchSeq 升序） */
export interface CanvasOverviewBatch extends Batch {
  runs: OverviewRunLite[]
}

/** [M27] 编排链段概览（每段取 workflowId+seq 最新 run；无 run → runId/runStatus/cost 均 null） */
export interface WorkflowSegmentLite {
  seq: number
  templateKey: string
  templateName: string
  runId: number | null
  runStatus: RunStatus | null
  cost: number | null
}

/** [M27] 编排链概览（全景「编排链」区数据源） */
export interface WorkflowOverviewLite {
  id: number
  name: string
  status: WorkflowStatus
  autoAdvance: number
  segments: WorkflowSegmentLite[]
}

/** [M23] 全景读模型（项目内跨批次/跨模板聚合） */
export interface CanvasOverview {
  project: { id: number; name: string }
  /** 新批在前（createdAt desc） */
  batches: CanvasOverviewBatch[]
  /** 无批次归属 runs（createdAt desc） */
  standaloneRuns: OverviewRunLite[]
  stats: { runCount: number; byStatus: Record<string, number>; totalCost: number }
  /** [M27] 编排链（旧前端超集兼容；无链 → []） */
  workflows: WorkflowOverviewLite[]
}

// ===== [M23] 模板画布内编辑（本地草稿层；不参与网络契约） =====

/** 单步骤覆盖（对齐 P3 template-edit edits.steps[]：{ key, title?, texts? }） */
export interface StepOverride {
  title?: string
  texts?: Record<string, string>
}

/** 编辑区逐字段视图（父级算好 overlay 值 + dirty；抽屉纯展示） */
export interface EditFieldState {
  key: string
  /** overlay 后值（未覆盖 → 模板原值） */
  value: string
  editable: boolean
  dirty: boolean
}

/** 编辑区节点视图（抽屉 props.editNode） */
export interface EditNodeState {
  key: string
  /** overlay 后标题（允许空串 → UI 红框提示） */
  title: string
  titleDirty: boolean
  fields: EditFieldState[]
}
