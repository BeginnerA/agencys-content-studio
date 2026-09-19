// ===== 与后端 routes 响应对齐的领域类型（camelCase）=====

export type RunStatus =
  'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled'
export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting_input'
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'cancelled'
export type TaskStatus =
  'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled'

export interface RecentRun {
  id: number
  status: RunStatus
  templateKey: string
  updatedAt: number
}

export interface Project {
  id: number
  name: string
  genre: string
  brief: string
  templateKey: string | null
  status: string
  coverAssetId: number | null
  tags: string[]
  assetCount: number
  recentRuns: RecentRun[]
  updatedAt: number
}

export interface ProjectDetail extends Project {
  settings: Record<string, unknown>
}

export interface Run {
  id: number
  projectId: number
  templateKey: string
  templateVersion?: number
  batchId: number | null
  batchSeq: number | null
  status: RunStatus
  currentStepKey: string | null
  input: Record<string, unknown>
  summary: { stepCount?: number; durationMs?: number } | null
  error: string | null
  startedAt: number | null
  completedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface RunStep {
  id: number
  seq: number
  stepKey: string
  actionKey: string
  title: string
  status: StepStatus
  attempts: number
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  error: string | null
  startedAt: number | null
  completedAt: number | null
}

export interface RunDetail {
  run: Run
  steps: RunStep[]
}

/** [M21] Gate 文本产物版本链条目（GET /runs/:id/steps/:key/revisions） */
export interface RevisionItem {
  assetId: number
  name: string
  createdAt: number
  /** 是否步骤当前产物（step.output.asset_ids[0]） */
  current: boolean
}

/** [M21] 参数热调变更项（PATCH /runs/:id/params 的 applied；同构于 run.input._params_log.changes） */
export interface ParamChange {
  group: string
  key: string
  from: unknown
  to: unknown
}

export interface AssetUrls {
  file: string
  thumb: string | null
}

export interface Asset {
  id: number
  projectId: number
  stepId: number | null
  taskId: number | null
  kind: string
  purpose: string
  name: string
  mime: string
  ext: string
  fileSize: number
  width: number | null
  height: number | null
  duration: number | null
  prompt: string | null
  params: Record<string, unknown> | null
  tags: string[]
  isFavorite: number
  createdAt: number
  updatedAt: number
  urls: AssetUrls
  /** [M29·R02] 可编辑文本资产的当前内容版本号（详情接口附带；供乐观锁与前端缓存串 ?v=） */
  contentRevision?: number
}

export interface TaskResultAsset {
  id: number
  name: string
  kind: string
  purpose: string
  fileUrl: string
}

export interface GenTask {
  id: number
  projectId: number
  runId: number
  stepId: number
  kind: string
  provider: string
  model: string | null
  status: TaskStatus
  attempts: number
  errorMsg: string | null
  prompt: string
  params: Record<string, unknown> | null
  resultAsset: TaskResultAsset | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

/** 通用错误响应 {error:{code,message}} */
export interface ApiErrorBody {
  error: { code: string; message: string }
}
