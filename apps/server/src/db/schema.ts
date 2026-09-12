import { sqliteTable, integer, text, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * agencys-content-studio M1 schema —— 通用领域模型（对照设计规格 §4）
 * 时间戳统一 integer unix ms；JSON 字段统一 text + 应用层校验。
 */

export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    genre: text('genre').notNull().default('drama_short'), // drama_short|anime|article|note|talking_head|other
    brief: text('brief'),
    templateKey: text('template_key').notNull().default('mengbao-episode'),
    status: text('status').notNull().default('active'), // active|archived
    coverAssetId: integer('cover_asset_id'),
    settings: text('settings').notNull().default('{}'), // JSON: 项目级默认参数
    tags: text('tags').notNull().default('[]'), // JSON
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('idx_projects_status').on(t.status)],
)

export const pipelineRuns = sqliteTable(
  'pipeline_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull(),
    templateKey: text('template_key').notNull(),
    // queued|running|waiting_input|completed|failed|cancelled
    status: text('status').notNull().default('queued'),
    currentStepKey: text('current_step_key'),
    input: text('input').notNull(), // JSON 启动输入快照
    templateSnapshot: text('template_snapshot'), // JSON 模板快照（run 创建时固化；续跑/审阅读快照）
    summary: text('summary'), // JSON 完成汇总
    error: text('error'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    batchId: integer('batch_id'), // [M4] 所属批次（NULL = 独立 run）
    batchSeq: integer('batch_seq'), // [M4] 批内序号（从 1 起）
  },
  (t) => [
    index('idx_runs_project').on(t.projectId),
    index('idx_runs_status').on(t.status),
    index('idx_runs_batch').on(t.batchId),
  ],
)

export const pipelineSteps = sqliteTable(
  'pipeline_steps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id').notNull(),
    seq: integer('seq').notNull(),
    stepKey: text('step_key').notNull(),
    actionKey: text('action_key').notNull(),
    title: text('title'),
    // pending|running|waiting_input|succeeded|failed|skipped|cancelled
    status: text('status').notNull().default('pending'),
    input: text('input'), // JSON 引用解析后的实际输入
    output: text('output'), // JSON {asset_ids:[]} 或 {asset_id}
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_steps_run').on(t.runId, t.seq)],
)

export const genTasks = sqliteTable(
  'gen_tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull(),
    runId: integer('run_id'),
    stepId: integer('step_id'),
    kind: text('kind').notNull(), // image|video|text（text = M9 逐项文本任务）
    provider: text('provider'),
    model: text('model'),
    prompt: text('prompt'),
    params: text('params').notNull(), // JSON 生成参数
    taskId: text('task_id'), // 第三方任务 id
    status: text('status').notNull().default('pending'), // pending|processing|succeeded|failed|cancelled
    errorMsg: text('error_msg'),
    attempts: integer('attempts').notNull().default(0),
    resultAssetId: integer('result_asset_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [
    index('idx_tasks_status').on(t.status),
    index('idx_tasks_run').on(t.runId),
    index('idx_tasks_project').on(t.projectId),
  ],
)

export const assets = sqliteTable(
  'assets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull(),
    stepId: integer('step_id'),
    taskId: integer('task_id'),
    runId: integer('run_id'), // [M4] 所属 run（NULL = 非 run 产物；导出包归属查询用）
    kind: text('kind').notNull(), // image|video|audio|text|archive
    purpose: text('purpose'), // source|reference_character|reference_scene|reference_prop|sets|set_log|script|storyboard|shot_image|final_video|subtitle|thumbnail|export|chapters|events|graph|plan|regex
    name: text('name').notNull(),
    mime: text('mime'),
    ext: text('ext'),
    fileSize: integer('file_size'),
    width: integer('width'),
    height: integer('height'),
    duration: integer('duration'),
    sha256: text('sha256'),
    relPath: text('rel_path'),
    prompt: text('prompt'),
    params: text('params'), // JSON
    tags: text('tags').notNull().default('[]'), // JSON
    isFavorite: integer('is_favorite').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('idx_assets_project_purpose').on(t.projectId, t.purpose),
    index('idx_assets_project_kind').on(t.projectId, t.kind),
  ],
)

/** 供应商凭证（厂商级，一个厂商一条记录；API Key 只配一次，实例共享） */
export const vendorCredentials = sqliteTable('vendor_credentials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vendor: text('vendor').notNull().unique(), // 厂商标识：aliyun / deepseek / openai / siliconflow / google / volcengine / minimax / pollinations
  name: text('name').notNull(), // 显示名：阿里千问 / DeepSeek / OpenAI ...
  apiKeyRef: text('api_key_ref').notNull().default('local'), // 密钥引用（local:vendor:{vendor}）
  baseUrl: text('base_url'), // 可选覆盖（厂商根端点）
  extra: text('extra').notNull().default('{}'), // JSON 厂商级扩展
  isActive: integer('is_active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const apiProviders = sqliteTable('api_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(), // volcengine_image/gemini_image/.../deepseek_llm
  name: text('name').notNull(),
  serviceType: text('service_type').notNull(), // llm|image|video|audio
  vendor: text('vendor'), // 厂商分组标识（关联 vendor_credentials.vendor）
  defaultUrl: text('default_url'),
  presetModels: text('preset_models'), // JSON
  description: text('description'),
  isActive: integer('is_active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const apiConfigs = sqliteTable(
  'api_configs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    providerKey: text('provider_key').notNull(),
    serviceType: text('service_type').notNull(), // llm|image|video|audio
    credentialId: integer('credential_id'), // FK → vendor_credentials.id（凭证级 Key 共享）
    name: text('name').notNull(),
    baseUrl: text('base_url'), // 覆盖 provider.defaultUrl
    apiKeyRef: text('api_key_ref').notNull().default('local'), // fallback：credential_id 优先
    model: text('model'),
    extra: text('extra').notNull().default('{}'), // JSON
    pricing: text('pricing').notNull().default('{}'), // JSON 实例级定价：{"tokens_in":2,"tokens_out":8} / {"image":0.04} / {"second":0.6} / {"char":0.1}
    priority: integer('priority').notNull().default(0),
    isDefault: integer('is_default').notNull().default(0),
    isActive: integer('is_active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_configs_type_default').on(t.serviceType, t.isDefault), index('idx_configs_credential').on(t.credentialId)],
)

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  value: text('value').notNull(), // JSON
  updatedAt: integer('updated_at').notNull(),
})

/** M3 记忆表（通用；projectId NULL = 全局） */
export const memories = sqliteTable(
  'memories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id'), // NULL = 全局（跨项目/账号级）
    type: text('type').notNull().default('note'), // note|style|fact|feedback|...（开放，应用层不强校验）
    name: text('name'), // 具名记忆（同 project+name upsert）；NULL = 匿名追加
    content: text('content').notNull(),
    embedding: text('embedding'), // JSON number[]（写入时模型不可用则为 NULL）
    embeddingModel: text('embedding_model'), // 写入时模型标识（目录名+维度）
    meta: text('meta').notNull().default('{}'), // JSON: {runId,stepId,assetId,source}
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_memories_project').on(t.projectId),
    index('idx_memories_name').on(t.projectId, t.name),
  ],
)

/** M3 角色库表（M8 泛化为实体素材库：kind 多态 character|scene|prop；projectId NULL = 全局库） */
export const characters = sqliteTable(
  'characters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id'), // NULL = 全局库
    kind: text('kind').notNull().default('character'), // [M8] 实体类型：character|scene|prop
    name: text('name').notNull(),
    aliases: text('aliases').notNull().default('[]'), // JSON string[]
    summary: text('summary'),
    appearance: text('appearance'), // 外观锚定文本（注入核心）
    negative: text('negative'), // 免漂移负向词
    voice: text('voice'), // 声线基准短语
    states: text('states').notNull().default('[]'), // [M13] 角色状态变体（JSON string[]：{剧情节点}：{状态短语}；仅 character 有意义）
    refAssetIds: text('ref_asset_ids').notNull().default('[]'), // 定妆照资产 ids（JSON）
    meta: text('meta').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_characters_project').on(t.projectId), index('idx_characters_name').on(t.name)],
)

/** M8 风格预设库（平台级通用：跨体裁画风词块；项目经 projects.settings.style_preset_id 单选绑定） */
export const stylePresets = sqliteTable('style_presets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(), // 预设名（唯一）
  snippet: text('snippet').notNull(), // 英文风格词块（运行时拼入出图提示词）
  description: text('description'), // 展示用说明
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: integer('is_active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** [M14] 剧集主表（平台级通用：一项目一剧；集列表体见 episodes） */
export const series = sqliteTable(
  'series',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull(), // 一项目一剧（应用层唯一）
    name: text('name').notNull(), // 剧名
    totalEpisodes: integer('total_episodes').notNull().default(0), // 计划集数（集行数事实源）
    contentAssetId: integer('content_asset_id'), // 起作资产（如系列设定包资产 id）
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_series_project').on(t.projectId)],
)

/** [M14] 集表（平台级通用：集号/标题/状态/内容资产 + 最新 run 绑定） */
export const episodes = sqliteTable(
  'episodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull(),
    seriesId: integer('series_id').notNull(),
    number: integer('number').notNull(), // 集号（≥1；项目内唯一）
    title: text('title'), // 集标题（可选）
    status: text('status').notNull().default('locked'), // locked|planning|done（手工置位）；展示经最新 run 状态派生合并
    contentAssetId: integer('content_asset_id'), // 本集剧本/内容资产
    latestRunId: integer('latest_run_id'), // 最近一次以本集起作的 run（启动端点后置回写）
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_episodes_project_number').on(t.projectId, t.number), // 集号项目内唯一
    index('idx_episodes_series').on(t.seriesId),
  ],
)

/** M4 批次表（通用；同模板多 run 调度与进度） */
export const batches = sqliteTable('batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  templateKey: text('template_key').notNull(),
  name: text('name').notNull(),
  // running|completed|partial_failed|failed|cancelled
  status: text('status').notNull().default('running'),
  schedule: text('schedule').notNull().default('{"max_concurrent":1}'), // JSON
  total: integer('total').notNull().default(0),
  finished: integer('finished').notNull().default(0),   // 终态 run 数（completed+failed+cancelled）
  succeeded: integer('succeeded').notNull().default(0), // completed 数
  failed: integer('failed').notNull().default(0),       // failed 数
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('idx_batches_project').on(t.projectId), index('idx_batches_status').on(t.status)])

/** M4 用量记录表（成本核算；runId NULL = 非 run 来源，如连通性测试） */
export const usageRecords = sqliteTable('usage_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  runId: integer('run_id'),        // NULL = 非 run 来源（如连通性测试）
  stepId: integer('step_id'),
  taskId: integer('task_id'),      // gen_tasks.id（图片/视频任务）
  assetId: integer('asset_id'),    // 产出资产（可溯源）
  kind: text('kind').notNull(),    // llm|image|video|tts
  provider: text('provider'),
  model: text('model'),
  quantity: real('quantity').notNull(),
  unit: text('unit').notNull(),    // tokens_in|tokens_out|image|second|char
  unitPrice: real('unit_price'),   // 记录时快照（元/单位，已含基数换算）；未配置 NULL
  cost: real('cost'),              // quantity × unitPrice；未配置 NULL
  currency: text('currency').notNull().default('CNY'),
  meta: text('meta').notNull().default('{}'), // JSON：原始 usage / 辅助信息
  createdAt: integer('created_at').notNull(),
}, (t) => [
  index('idx_usage_project').on(t.projectId),
  index('idx_usage_run').on(t.runId),
  index('idx_usage_kind').on(t.kind),
])

/** M4 发布登记表（发布渠道与数据登记；metrics 仅存不算） */
export const publications = sqliteTable('publications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  runId: integer('run_id'),        // 可空：允许登记非流水线内容
  assetId: integer('asset_id'),    // 可空：首选关联成片资产
  platform: text('platform').notNull(), // douyin|wechat_channels|kuaishou|xiaohongshu|bilibili|other
  url: text('url'),
  publishedAt: integer('published_at'),
  metrics: text('metrics').notNull().default('{}'), // JSON: {views,likes,comments,favorites,shares}（仅存不算）
  note: text('note'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('idx_publications_project').on(t.projectId), index('idx_publications_asset').on(t.assetId)])

export type Project = typeof projects.$inferSelect
export type PipelineRun = typeof pipelineRuns.$inferSelect
export type PipelineStep = typeof pipelineSteps.$inferSelect
export type GenTask = typeof genTasks.$inferSelect
export type Asset = typeof assets.$inferSelect
export type VendorCredential = typeof vendorCredentials.$inferSelect
export type ApiConfig = typeof apiConfigs.$inferSelect
export type Memory = typeof memories.$inferSelect
export type CharacterRow = typeof characters.$inferSelect
export type StylePreset = typeof stylePresets.$inferSelect
export type Series = typeof series.$inferSelect
export type Episode = typeof episodes.$inferSelect
export type Batch = typeof batches.$inferSelect
export type UsageRecord = typeof usageRecords.$inferSelect
export type Publication = typeof publications.$inferSelect
