import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'

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
  },
  (t) => [
    index('idx_runs_project').on(t.projectId),
    index('idx_runs_status').on(t.status),
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
    kind: text('kind').notNull(), // image|video
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
    kind: text('kind').notNull(), // image|video|audio|text|archive
    purpose: text('purpose'), // source|reference_character|reference_scene|script|storyboard|shot_image|final_video|subtitle|thumbnail|export
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

export const apiProviders = sqliteTable('api_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(), // volcengine_image/gemini_image/.../deepseek_llm
  name: text('name').notNull(),
  serviceType: text('service_type').notNull(), // llm|image|video|audio
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
    name: text('name').notNull(),
    baseUrl: text('base_url'), // 覆盖 provider.defaultUrl
    apiKeyRef: text('api_key_ref').notNull().default('local'), // env 变量名 或 local
    model: text('model'),
    extra: text('extra').notNull().default('{}'), // JSON
    priority: integer('priority').notNull().default(0),
    isDefault: integer('is_default').notNull().default(0),
    isActive: integer('is_active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_configs_type_default').on(t.serviceType, t.isDefault)],
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

/** M3 角色库表（通用；projectId NULL = 全局角色库） */
export const characters = sqliteTable(
  'characters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id'), // NULL = 全局角色库
    name: text('name').notNull(),
    aliases: text('aliases').notNull().default('[]'), // JSON string[]
    summary: text('summary'),
    appearance: text('appearance'), // 外观锚定文本（注入核心）
    negative: text('negative'), // 免漂移负向词
    voice: text('voice'), // 声线基准短语
    refAssetIds: text('ref_asset_ids').notNull().default('[]'), // 定妆照资产 ids（JSON）
    meta: text('meta').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_characters_project').on(t.projectId), index('idx_characters_name').on(t.name)],
)

export type Project = typeof projects.$inferSelect
export type PipelineRun = typeof pipelineRuns.$inferSelect
export type PipelineStep = typeof pipelineSteps.$inferSelect
export type GenTask = typeof genTasks.$inferSelect
export type Asset = typeof assets.$inferSelect
export type ApiConfig = typeof apiConfigs.$inferSelect
export type Memory = typeof memories.$inferSelect
export type CharacterRow = typeof characters.$inferSelect
