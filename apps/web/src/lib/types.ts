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
  /** [M13] 状态变体（仅 kind=character 有意义；「剧情节点：状态短语」；scene/prop 恒为 []） */
  states: string[]
  refAssetIds: number[]
  refAssets: CharacterRefAsset[]
  meta?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** [M8] 风格预设（平台级通用画风词块；[M13] 项目经 settings.style_preset_ids 数组多选绑定，旧单值键兼容回退） */
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

/** [M13] 参考图视觉提取结果（POST /style-presets/extract；不落库，供表单预填） */
export interface StyleExtractResult {
  snippet: string
  provider: string
  model: string
}

/** [M13] 批量润色结果（POST /entities/polish；failed 项不改动，可重选重试） */
export interface EntityPolishResult {
  ok: boolean
  polished: Array<{ id: number; name: string; appearance: string }>
  failed: Array<{ id: number; error: string }>
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
  /** [M12] 收藏标记（1=已收藏；版本清理保留豁免） */
  isFavorite: number
  /** [M12] 图像检测摘要（无/坏数据 → null，前端不显示徽标） */
  quality: Pick<ImageQuality, 'ok' | 'reason'> | null
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

// ===== [M12] 旧版本清理与收藏 / 图像检测 =====

/** [M12] 图像有效性检测结果（assets.params.quality 契约；ok=null 表示无法判定） */
export interface ImageQuality {
  ok: boolean | null
  reason: string
  stats?: { ymin: number; ymax: number; yavg: number; satavg: number }
  checkedAt?: number
}

/** [M12] 版本清理结果（shots/cleanup 与 assets/cleanup-versions 共用；groups=命中版本组数） */
export interface CleanupResult {
  ok: boolean
  groups: number
  cleaned: number
  kept: number
  note: string
}

/** [M12] 回收空间结果（物理删除已清理资产文件；files=回收文件数） */
export interface GcResult {
  ok: boolean
  files: number
  freed_bytes: number
  note: string
}

// ===== [M14] 剧集实体（series → episodes 两级，一项目一剧） =====

/** [M14] 剧（系列） */
export interface SeriesInfo {
  id: number
  projectId: number
  name: string
  totalEpisodes: number
  contentAssetId: number | null
  createdAt: number
  updatedAt: number
}

/** [M14] 集（status 为派生展示态：最新 run 状态优先；rowStatus 为行原值，编辑回显用） */
export interface Episode {
  id: number
  projectId: number
  seriesId: number
  number: number
  title: string | null
  status: string
  rowStatus: string
  contentAssetId: number | null
  latestRunId: number | null
  runStatus: string | null
  createdAt: number
  updatedAt: number
}

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

// ===== [M16] 创作画布（写模型；GET /canvases/:id 全量读模型契约） =====

export type CanvasNodeKind = 'asset' | 'gen' | 'text' | 'entity' | 'run'
export type CanvasEdgePort =
  | 'reference'
  | 'first_frame'
  | 'last_frame'
  | 'source'
  | 'prompt'
  | 'video'
  | 'audio'
export type CanvasEditMode = 'inpaint' | 'erase' | 'outpaint'
/** [M17] 生成类型（image/video/audio 生成 + compose 音视频合成） */
export type GenKind = 'image' | 'video' | 'audio' | 'compose'

/** gen 节点编辑规格（inpaint/erase 需 maskAssetId；outpaint 用 expand 三元组） */
export interface NodeSpecEdit {
  mode: CanvasEditMode
  maskAssetId?: number
  expand?: { angle?: number; xScale?: number; yScale?: number }
}

/** gen 节点 spec（服务端 parseNodeSpec 同构） */
export interface CreationNodeSpec {
  genKind: GenKind
  prompt: string
  size?: string
  duration?: number
  resolution?: string
  aspectRatio?: string
  /** [M17] 输出帧率（仅 compose 有意义） */
  fps?: number
  /** [M17] 声线令牌（仅 audio；全 ASCII 供应商枚举） */
  voice?: string
  /** [M17] 语速（仅 audio，0.25-4） */
  speed?: number
  /** 端点覆盖（缺省走 resolveEndpoint） */
  provider?: string
  model?: string
  /** 默认 true，对齐 ai_image use_style_preset 口径 */
  useStylePreset?: boolean
  edit?: NodeSpecEdit
}

/** [M17] kind=text：文本节点（text→gen 的 prompt 源；资产全文提取） */
export interface TextNodeSpec {
  text: string
}

/** [M17] kind=entity：实体参考直通（characters 行） */
export interface EntityNodeSpec {
  entityId: number
}

/** [M17] kind=run：内嵌运行（pipeline_runs 行，须属同项目） */
export interface RunNodeSpec {
  runId: number
}

/** [M17] 读模型节点 spec 联合（按 kind 分派解析） */
export type AnyNodeSpec = CreationNodeSpec | TextNodeSpec | EntityNodeSpec | RunNodeSpec

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
  /** [M17] 故事板序号（1 起；null = 未编号） */
  seq: number | null
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
  /** [M17] 仅 gen：采纳任务 id（null = 未采纳） */
  adoptedTaskId: number | null
  /** [M17] 仅 gen：显示任务 id（采纳优先派生） */
  displayTaskId: number | null
  /** [M17] 仅 gen：显示任务（含产物资产冗余） */
  displayTask: CanvasDisplayTask | null
  /** [M17] 仅 gen：结果画廊（最近成功 ≤12） */
  results: CanvasResultItem[]
  /** [M17] 仅 entity：实体摘要 */
  entity: CanvasEntityInfo | null
  /** [M17] 仅 run：运行摘要 */
  run: CanvasRunInfo | null
  readiness: { ready: boolean; problems: string[]; notes?: string[] } | null
  editCapability: CanvasEditCapability | null
  canRun: boolean | null
  canCancel: boolean | null
}

/** [M17] gen 节点结果画廊条目（最近成功产物） */
export interface CanvasResultItem {
  taskId: number
  assetId: number
  asset: CanvasAssetLite | null
  createdAt: number
}

/** [M17] entity 节点实体摘要 */
export interface CanvasEntityInfo {
  id: number
  name: string
  kind: string
  refCount: number
  asset: CanvasAssetLite | null
}

/** [M17] run 节点运行摘要 */
export interface CanvasRunInfo {
  id: number
  templateKey: string
  status: string
  startedAt: number | null
  completedAt: number | null
  steps: { succeeded: number; total: number }
}

/** [M17] 显示任务（gen 采纳优先产物 + 资产冗余） */
export type CanvasDisplayTask = CanvasGenTaskLite & { asset: CanvasAssetLite | null }

/** [M17] 节点行原始形态（POST/PATCH/copy/extract 端点返回 DB 行，spec 为 JSON 字符串） */
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

/** [M17] 边行原始形态（copy 端点返回 DB 行） */
export interface CanvasEdgeRow {
  id: number
  canvasId: number
  from: number
  to: number
  port: string
  createdAt: number
}

/** [M17] 整理模式（服务端 ARRANGE_MODES 同构） */
export type CanvasArrangeMode =
  | 'layered'
  | 'grid'
  | 'align-left'
  | 'align-right'
  | 'align-top'
  | 'align-bottom'
  | 'distribute-h'
  | 'distribute-v'

/** [M17] 批量执行结果（canvases/run） */
export interface CanvasRunBatchResult {
  started: Array<{ nodeId: number; taskId: number; taskIds: number[] }>
  skipped: Array<{ nodeId: number; problems: string[] }>
}

/** [M17] 导出 zip 结果（creation-export） */
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

/** [M16] 画布文档全量读模型 */
export interface CanvasDoc {
  canvas: { id: number; projectId: number; name: string; viewport: CanvasViewport }
  nodes: CanvasDocNode[]
  edges: CanvasDocEdge[]
}

/** [M16] 画布列表项 */
export interface CanvasListItem {
  id: number
  projectId: number
  name: string
  nodeCount: number
  createdAt: number
  updatedAt: number
}
