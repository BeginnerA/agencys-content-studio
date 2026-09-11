// ===== 与后端 routes 响应对齐的领域类型（camelCase）=====

export type RunStatus = 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled'
export type StepStatus = 'pending' | 'running' | 'waiting_input' | 'succeeded' | 'skipped' | 'failed' | 'cancelled'
export type TaskStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled'

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

export interface ProviderConfigLite {
  id: number
  name: string
  serviceType: string
  model: string
  credentialId?: number | null
  isDefault: boolean
  isActive: boolean
  /** 编辑回显：自定义端点（GET /api-configs 提供；未设置为 null/undefined） */
  baseUrl?: string | null
  /** 编辑回显：Key 脱敏尾 4 位（未配置密钥为 null/undefined） */
  apiKeyMasked?: string | null
  /** 编辑回显：实例扩展参数（供适配器透传，如火山 TTS 的 appid；后端默认 {}） */
  extra?: Record<string, unknown> | null
  /** 实例级定价 JSON */
  pricing?: Record<string, number> | null
}

export interface ApiProvider {
  key: string
  name: string
  serviceType: 'llm' | 'image' | 'video' | 'audio'
  vendor: string | null
  description: string
  defaultUrl: string | null
  presetModels: string[]
  isActive: boolean
  configs: ProviderConfigLite[]
}

export interface ApiConfig {
  id: number
  providerKey: string
  serviceType: string
  credentialId: number | null
  credentialVendor: string | null
  credentialName: string | null
  name: string
  baseUrl: string | null
  apiKeyRef: string | null
  apiKeyMasked: string | null
  model: string | null
  extra: Record<string, unknown>
  pricing: Record<string, number>
  priority: number
  isDefault: boolean
  isActive: boolean
  createdAt: number
  updatedAt: number
}

/** 供应商凭证（厂商级，API Key 只配一次） */
export interface VendorCredential {
  id: number
  vendor: string
  name: string
  baseUrl: string | null
  apiKeyMasked: string
  hasKey: boolean
  extra: Record<string, unknown>
  isActive: boolean
  configCount: number
  createdAt: number
  updatedAt: number
}

/** POST /api-configs/fetch-models 响应：在线目录 / 预置回退 */
export interface FetchModelsResult {
  models: string[]
  source: 'live' | 'preset'
  note?: string
}

export interface TemplateInputDef {
  key: string
  label: string
  kind: 'text' | 'int' | 'bool' | 'files'
  required: boolean
  accept?: string[]
  default?: string | number | boolean
}

export interface TemplateGate {
  mode: string
  message: string
  /** 声明后挂起态显示「跳过」按钮（免审放行、产物保留） */
  skip_label?: string
  /** 条件门：不满足 → 步骤自动 succeeded（免审直过不挂起） */
  when?: string | string[]
}

export interface TemplateBatch {
  field: string
  maxConcurrent?: number
  retry?: number
}

export interface TemplateStepDef {
  key: string
  action: string
  title: string
  inputs: Record<string, string>
  params: Record<string, unknown>
  gate?: TemplateGate
  batch?: TemplateBatch
  output?: { purpose?: string }
  when?: string | string[]
  when_any?: string[]
  after?: string[]
}

export interface TemplateMeta {
  key: string
  name: string
  description: string
  genre: string
  version: number
  stepCount: number
  updatedAt: number
  /** [M2] 引用体检：存在 params.prompt_tpl 指向的提示词文件缺失 */
  promptsDirty?: boolean
  /** 展示元数据：场景分组（produce/plan/operate） */
  scene?: string
  /** 展示元数据：推荐下游模板 key 列表 */
  next?: string[]
}

/** POST /templates/validate 响应（纯校验不落盘） */
export interface TemplateValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  template?: TemplateDetail
}

/** GET /prompts 清单项 */
export interface PromptItem {
  name: string
  size: number
  updatedAt: number
}

export interface TemplateDetail {
  key: string
  version: number
  name: string
  description: string
  genre: string
  /** 展示元数据：场景分组（produce/plan/operate） */
  scene?: string
  /** 展示元数据：推荐下游模板 key 列表 */
  next?: string[]
  inputs: TemplateInputDef[]
  defaults: Record<string, unknown>
  steps: TemplateStepDef[]
}

/** 通用错误响应 {error:{code,message}} */
export interface ApiErrorBody {
  error: { code: string; message: string }
}

// ===== [M3] 记忆与角色 =====

export interface MemoryItem {
  id: number
  scope: 'project' | 'global'
  projectId: number | null
  type: string
  name: string | null
  content: string
  embeddingModel: string | null
  hasEmbedding: boolean
  /** 语义检索模式（q 给定）下的相似度 */
  score?: number
  meta?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface CharacterRefAsset {
  id: number
  name: string
  urls: AssetUrls
}

export interface CharacterItem {
  id: number
  projectId: number | null
  scope: 'project' | 'global'
  name: string
  aliases: string[]
  summary: string | null
  appearance: string | null
  negative: string | null
  voice: string | null
  refAssetIds: number[]
  refAssets: CharacterRefAsset[]
  meta?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface MemoryStatus {
  ready: boolean
  modelDir: string
  modelName: string
  dims: number | null
  count: number
  missingEmbedding: number
  error?: string
}

// ===== [M4] 批次 / 用量 / 统计 / 导出 / 发布 =====

export type BatchStatus = 'running' | 'completed' | 'partial_failed' | 'failed' | 'cancelled'

export interface Batch {
  id: number
  projectId: number
  templateKey: string
  name: string
  status: BatchStatus
  schedule: { max_concurrent?: number }
  total: number
  finished: number
  succeeded: number
  failed: number
  createdAt: number
  updatedAt: number
}

export interface BatchRunLite {
  id: number
  batchSeq: number | null
  status: RunStatus
  error: string | null
  input: Record<string, unknown> | null
  cost: number | null
  startedAt: number | null
  completedAt: number | null
  createdAt: number
}

export interface BatchDetail {
  batch: Batch
  runs: BatchRunLite[]
}

/** GET /stats/usage 响应（用量聚合） */
export interface UsageItem {
  key: string
  quantity: number
  cost: number
  unpriced: number
  count: number
}

export interface UsageSummary {
  items: UsageItem[]
  totals: { quantity: number; cost: number; unpriced: number }
}

/** GET /stats/overview 响应（看板六区块） */
export interface Overview {
  projects: number
  runs: { total: number; byStatus: Record<string, number>; successRate: number }
  cost: { total: number; last30d: number }
  assets: { total: number; byKind: Record<string, number> }
  activity: Array<{ day: string; runs: number; cost: number }>
  activeDays: number
  publications: { total: number; views: number; interactions: number }
}

/** 导出包（POST /runs/:id/exports、GET /exports） */
export interface ExportAssetLite {
  id: number
  projectId: number
  runId: number | null
  kind: string
  purpose: string | null
  name: string
  mime: string | null
  ext: string | null
  fileSize: number | null
  width: number | null
  height: number | null
  duration: number | null
  tags: unknown
  createdAt: number
  updatedAt: number
}

/** run 产物（GET /runs/:id/assets，导出向导数据源） */
export interface RunAssetLite extends ExportAssetLite {
  stepId: number | null
  sha256: string | null
}

export interface Publication {
  id: number
  projectId: number
  runId: number | null
  assetId: number | null
  platform: string
  url: string | null
  publishedAt: number | null
  metrics: Record<string, number> | null
  note: string | null
  createdAt: number
  updatedAt: number
}
