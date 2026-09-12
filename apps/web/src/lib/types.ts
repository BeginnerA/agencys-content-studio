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

/** [M8] 实体素材类型：角色 / 场景 / 道具（单表多态，kind 列） */
export type EntityKind = 'character' | 'scene' | 'prop'

export interface EntityItem {
  id: number
  projectId: number | null
  scope: 'project' | 'global'
  kind: EntityKind
  name: string
  aliases: string[]
  summary: string | null
  appearance: string | null
  negative: string | null
  /** 声线（仅 kind=character 有意义；scene/prop 恒为 null） */
  voice: string | null
  refAssetIds: number[]
  refAssets: CharacterRefAsset[]
  meta?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** [M8] 风格预设（平台级通用画风词块；项目经 settings.style_preset_id 单值绑定） */
export interface StylePresetItem {
  id: number
  name: string
  snippet: string
  description: string | null
  sortOrder: number
  /** 1=启用 / 0=停用 */
  isActive: number
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

// ===== [M7] 镜头工作台（GET /runs/:id/shot-board 契约） =====

/** 同镜历史版本（缩略图懒加载；urls 为引用） */
export interface ShotVersion {
  id: number
  name: string
  createdAt: number
  width: number | null
  height: number | null
  duration: number | null
  prompt: string | null
  /** [M10] 版本来源：task=步骤任务产物 / upload=本地上传入库 */
  source: 'task' | 'upload'
  urls: { file: string; thumb: string | null }
}

/** 镜头对应生成任务摘要（无任务 → null） */
export interface ShotTaskLite {
  id: number
  status: TaskStatus
  attempts: number
  errorMsg: string | null
  prompt: string | null
}

export interface ShotBoardShot {
  shotId: string
  order: number
  imagePrompt: string
  motionPrompt: string
  /** 分镜 per-shot 时长（null = 用全局 duration_per_shot） */
  duration: number | null
  task: ShotTaskLite | null
  /** 当前 output.asset_ids 中命中该镜的资产（null = 未选中/无产物） */
  selectedAssetId: number | null
  versions: ShotVersion[]
  /** [M10] 分镜对象全量（大编辑器字段回显/动态键值行） */
  raw: Record<string, unknown>
}

/** 合成新鲜度（run 无 ffmpeg_merge 步骤 → board.compose 为 null） */
export interface ShotBoardCompose {
  stepKey: string
  composedAt: number | null
  /** true/false/null（null = 旧产物无快照，无法判定，UI 降级为常态提示） */
  stale: boolean | null
}

export interface ShotBoardData {
  step: { id: number; key: string; title: string | null; action: string; status: StepStatus }
  shots: ShotBoardShot[]
  compose: ShotBoardCompose | null
  /** 返修可用性（不抛错判定：活跃 run / 其他 failed 步骤等） */
  repairable: { ok: boolean; reason: string | null }
}

/** 分镜字段级编辑项（edit / regenerate 复用） */
export interface ShotEditItem {
  shot_id: string
  image_prompt?: string
  motion_prompt?: string
  duration?: number
}

/** 选片/选镜提交项（shot_id 不重复；asset 需属该步骤任务组且 kind 匹配） */
export interface ShotPick {
  shot_id: string
  asset_id: number
}

/**
 * [M10] 结构性编辑操作（POST /runs/:id/shots/mutate）；前端建议序列 add* → patch* → remove* → reorder。
 */
export type ShotOp =
  | { op: 'reorder'; order: string[] }
  | { op: 'add'; shot: Record<string, unknown> }
  | { op: 'remove'; shot_id: string }
  | { op: 'patch'; shot_id: string; fields: Record<string, unknown> }

// ===== [M9] 小说改编链（GET /runs/:id/novel-board 契约） =====

/** 章节索引.json（切分 manifest；后端已解析，字段宽松防御） */
export interface NovelManifestDoc {
  source?: { asset_ids?: number[]; names?: string[]; chars?: number }
  regex_source?: string
  regex_used?: string
  total?: number
  selected?: number
  range?: string | null
  skipped_head_chars?: number
  reels?: string[]
  chapters?: Array<{ index?: number; reel?: string | null; title?: string; name?: string; asset_id?: number; chars?: number }>
}

/** 章节行（服务端规范化 + 事件提取任务状态） */
export interface NovelBoardChapter {
  index: number
  title: string
  reel: string | null
  name: string
  asset_id: number
  chars: number
  /** pending/processing/succeeded/failed/cancelled；无任务 → null */
  event_status: string | null
}

/** 事件图谱（event-graph.json，展示用字段宽松） */
export interface NovelBoardGraphDoc {
  overview?: string
  characters?: Array<{ name?: string; role?: string; arc?: string }>
  key_events?: Array<{ id?: string; name?: string; summary?: string; chapters?: number[]; intensity?: number; kind?: string }>
}

/** 分集规划（plan.json，episodes 为准） */
export interface NovelBoardPlanDoc {
  title?: string
  episode_count?: number
  episodes?: Array<{
    ep?: number
    title?: string
    chapters?: number[]
    synopsis?: string
    opening_hook?: string
    ending_hook?: string
    key_event_ids?: string[]
    chapter_events?: unknown
  }>
}

export interface NovelBoardData {
  run_id: number
  /** run 内存在 text_split 步骤 */
  found: boolean
  step: { key: string; status: string } | null
  split: { manifest: NovelManifestDoc; chapters: NovelBoardChapter[] } | null
  graph: { asset_id: number; name: string; doc: NovelBoardGraphDoc | null } | null
  plan: { asset_id: number; name: string; doc: NovelBoardPlanDoc | null } | null
  scripts: Array<{ asset_id: number; name: string; ep: number | null }>
  events: { total: number; done: number; failed: number } | null
}

// ===== [M11] 单步重跑 / 合成设置（BGM·转场） =====

/** [M11] 转场枚举（对齐 ffmpeg xfade 子集；与服务端 TRANSITIONS 同值） */
export type ComposeTransition = 'none' | 'fade' | 'fadeblack' | 'slideleft' | 'slideright' | 'dissolve'

/** [M11] run 级合成配置（run.input._compose；空对象 = 未设置，走模板 params / 代码默认） */
export interface ComposeConfig {
  /** 回显宽松（服务端枚举校验；UI 对未知值降级 none） */
  transition?: string
  /** 0.1–2 秒（服务端 clamp） */
  transition_duration?: number
  /** 0–1（服务端 clamp） */
  bgm_volume?: number
  /** 0–2 秒（服务端 clamp） */
  bgm_fade?: number
}

/** [M11] 单步重跑结果（POST /runs/:id/steps/:stepKey/rerun；无 tasks_reset 字段，预计执行数在 note 文案） */
export interface RerunResult {
  ok: boolean
  run_id: number
  step_key: string
  has_tasks: boolean
  tasks_total: number
  tasks_succeeded: number
  note: string
}
