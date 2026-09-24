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

/** 已批准配置与当前可用配置的差异；to=null 表示当前无可用配置。 */
export interface ResumeConfigDrift { service: string; from: string; to: string | null }

export interface RunDetail {
  run: Run
  steps: RunStep[]
  /** 归属轻松创作会话 id（非创作 run 为 null；旧服务端缺字段时回退 undefined） */
  creationSessionId?: number | null
  /** 轻松创作 run 因存在「受理状态不明」任务而无法就地续跑（需回会话核验） */
  resumeNeedsVerification?: boolean
  /** 受理状态不明的任务 id 清单（供核验引导） */
  ambiguousTaskIds?: number[]
  /** 已批准端点漂移清单（改模型/改价/删实例）；非空 → 续跑需 accept_config_drift 确认改用当前配置 */
  resumeConfigDrift?: ResumeConfigDrift[]
}

/** Gate 文本产物版本链条目（GET /runs/:id/steps/:key/revisions） */
export interface RevisionItem {
  assetId: number
  name: string
  createdAt: number
  /** 是否步骤当前产物（step.output.asset_ids[0]） */
  current: boolean
}

/** 参数热调变更项（PATCH /runs/:id/params 的 applied；同构于 run.input._params_log.changes） */
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
  /** 可编辑文本资产的当前内容版本号（详情接口附带；供乐观锁与前端缓存串 ?v=） */
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
  taskId: string | null
  /** 受理状态不明（已提交无任务号/产物）：轻松创作 run 据此隐显「重试」 */
  ambiguous: boolean
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
