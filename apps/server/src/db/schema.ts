import { sqliteTable, integer, text, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * agencys-content-studio schema —— 通用领域模型（对照设计规格 §4）
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
    batchId: integer('batch_id'), // 所属批次（NULL = 独立 run）
    batchSeq: integer('batch_seq'), // 批内序号（从 1 起）
    workflowId: integer('workflow_id'), // 归属编排链（NULL = 非编排 run）
    workflowSeq: integer('workflow_seq'), // 链内段序（从 0 起）
    resumedFromRunId: integer('resumed_from_run_id'), // [审计G2] 断点续跑派生自哪个源 run（NULL = 非续跑派生；防双击 resume 并行双扣费）
  },
  (t) => [
    index('idx_runs_project').on(t.projectId),
    index('idx_runs_status').on(t.status),
    index('idx_runs_batch').on(t.batchId),
    index('idx_runs_workflow').on(t.workflowId),
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
    canvasNodeId: integer('canvas_node_id'), // 创作画布节点归属（run/step 均 null）
    kind: text('kind').notNull(), // image|video|text（text = 逐项文本任务）
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
    runId: integer('run_id'), // 所属 run（NULL = 非 run 产物；导出包归属查询用）
    kind: text('kind').notNull(), // image|video|audio|text|archive
    purpose: text('purpose'), // source|reference_character|reference_scene|reference_prop|sets|set_log|script|storyboard|shot_image|final_video|final_video_derived|subtitle|subtitle_display|thumbnail|export|chapters|events|graph|plan|regex|sfx
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
    embedding: text('embedding'), // 文本资产语义索引向量（JSON number[]；仅 kind='text' 写入，NULL = 未索引）
    embeddingModel: text('embedding_model'), // 写入时模型标识（modelName@dims，与 memories 同构）
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
  serviceType: text('service_type').notNull(), // llm|image|video|audio|music
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
    serviceType: text('service_type').notNull(), // llm|image|video|audio|music
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

/** 记忆表（通用；projectId NULL = 全局） */
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

/** 角色库表（泛化为实体素材库：kind 多态 character|scene|prop；projectId NULL = 全局库） */
export const characters = sqliteTable(
  'characters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id'), // NULL = 全局库
    kind: text('kind').notNull().default('character'), // 实体类型：character|scene|prop
    name: text('name').notNull(),
    aliases: text('aliases').notNull().default('[]'), // JSON string[]
    summary: text('summary'),
    appearance: text('appearance'), // 外观锚定文本（注入核心）
    negative: text('negative'), // 免漂移负向词
    voice: text('voice'), // [B③] 机器音色入口：供应商 voice 令牌 / clone:{id} 引用（进 TTS 声链）
    voiceDesc: text('voice_desc'), // [B③] 自然语言声线描述（如「成年男声、低沉沙哑」；仅展示/审计，永不进声链）
    states: text('states').notNull().default('[]'), // 角色状态变体（JSON string[]：{剧情节点}：{状态短语}；仅 character 有意义）
    refAssetIds: text('ref_asset_ids').notNull().default('[]'), // 定妆照资产 ids（JSON）
    meta: text('meta').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_characters_project').on(t.projectId), index('idx_characters_name').on(t.name)],
)

/** 风格预设库（平台级通用：跨体裁画风词块；项目经 projects.settings.style_preset_id 单选绑定） */
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

/** 剧集主表（平台级通用：一项目一剧；集列表体见 episodes） */
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

/** 集表（平台级通用：集号/标题/状态/内容资产 + 最新 run 绑定） */
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

/** 批次表（通用；同模板多 run 调度与进度） */
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

/** 用量记录表（成本核算；runId NULL = 非 run 来源，如连通性测试） */
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

/** 发布登记表（发布渠道与数据登记；metrics 仅存不算） */
export const publications = sqliteTable('publications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  runId: integer('run_id'),        // 可空：允许登记非流水线内容
  assetId: integer('asset_id'),    // 可空：首选关联成片资产
  platform: text('platform').notNull(), // douyin|wechat_channels|kuaishou|xiaohongshu|bilibili|other
  url: text('url'),
  publishedAt: integer('published_at'),
  metrics: text('metrics').notNull().default('{}'), // JSON: {views,likes,comments,favorites,shares}（仅存不算）
  title: text('title'),            // 发布标题（A/B 测试识别）
  abGroup: text('ab_group'),       // A/B 测试分组标记
  note: text('note'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('idx_publications_project').on(t.projectId), index('idx_publications_asset').on(t.assetId)])

// ---------- 创作画布（写模型；节点状态/结果零存量，全部由 gen_tasks 派生） ----------

/** 创作画布文档（项目域） */
export const canvases = sqliteTable(
  'canvases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull(),
    name: text('name').notNull().default('未命名画布'),
    viewport: text('viewport').notNull().default('{"x":0,"y":0,"zoom":1}'), // JSON pan/zoom 持久化
    deletedAt: integer('deleted_at'), // 回收站（null=正常；非 null=软删时间戳）
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_canvases_project').on(t.projectId)],
)

/** 画布节点（最小化：不存状态与结果——由 gen_tasks.canvasNodeId 派生） */
export const canvasNodes = sqliteTable(
  'canvas_nodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    canvasId: integer('canvas_id').notNull(),
    kind: text('kind').notNull(), // asset|gen|text|entity|run
    assetId: integer('asset_id'), // kind=asset：引用项目资产
    title: text('title'),
    spec: text('spec'), // JSON：gen={genKind,prompt,...}；text={text}；entity={entityId}；run={runId}
    x: real('x').notNull().default(0),
    y: real('y').notNull().default(0),
    adoptedTaskId: integer('adopted_task_id'), // 结果采纳（gen）：gen_tasks.id；null=未采纳取最新成功
    seq: integer('seq'), // 故事板序号（1 起；排序/呈现/导出命名，不参与执行）
    groupId: integer('group_id'), // 成组归属（canvas_groups.id；null=未成组）
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_canvas_nodes_canvas').on(t.canvasId)],
)

/** 画布引用连线（手画；端口语义 reference|first_frame|last_frame|source） */
export const canvasEdges = sqliteTable(
  'canvas_edges',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    canvasId: integer('canvas_id').notNull(),
    from: integer('from').notNull(), // 源节点 id（同画布）
    to: integer('to').notNull(), // 目标节点 id（同画布）
    port: text('port').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_canvas_edges_unique').on(t.canvasId, t.from, t.to, t.port),
    index('idx_canvas_edges_canvas').on(t.canvasId),
  ],
)

/** 画布节点分组（成员归属存 canvas_nodes.group_id；x/y 为组锚点，正常渲染用成员派生包围盒） */
export const canvasGroups = sqliteTable(
  'canvas_groups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    canvasId: integer('canvas_id').notNull(),
    title: text('title').notNull().default('未命名分组'),
    color: text('color'), // UI 色 token（null=默认）
    collapsed: integer('collapsed').notNull().default(0), // 折叠态持久化（0/1）
    x: real('x').notNull().default(0), // 锚点（创建时=成员包围盒左上；空组显示用）
    y: real('y').notNull().default(0),
    /** 父组 id（NULL=顶层；组嵌套——防环与归属校验在服务层） */
    parentId: integer('parent_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_canvas_groups_canvas').on(t.canvasId)],
)

/** 画布文档快照（保留 id 重放恢复；doc = {nodes,edges,groups} 全量行 JSON） */
export const canvasSnapshots = sqliteTable(
  'canvas_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    canvasId: integer('canvas_id').notNull(),
    label: text('label').notNull(),
    doc: text('doc').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_canvas_snapshots_canvas').on(t.canvasId)],
)

/** 排产计划表（轻量调度：计划 → 幂等触发 → batch 创建；红线内自研，非重型引擎） */
export const schedules = sqliteTable(
  'schedules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull(),
    name: text('name').notNull(),
    templateKey: text('template_key').notNull(),
    // ISO 8601 或简单 cron 表达式（v1 仅支持一次性定时：scheduledAt 时刻触发一次）
    cronExpr: text('cron_expr').notNull(), // 预留；v1 固定为 'once'
    scheduledAt: integer('scheduled_at').notNull(), // 计划触发时间（unix ms）
    status: text('status').notNull().default('pending'), // pending|triggered|completed|cancelled|failed
    lastTriggeredAt: integer('last_triggered_at'),
    lastBatchId: integer('last_batch_id'), // 触发后创建的 batch id
    inputTemplate: text('input_template').notNull().default('{}'), // JSON：批量输入模板（触发时展开）
    note: text('note'),
    isActive: integer('is_active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_schedules_project').on(t.projectId),
    index('idx_schedules_status').on(t.status),
    index('idx_schedules_scheduled').on(t.scheduledAt),
  ],
)

/** 自动编排链（跨模板串链 orchestrator；段序列引用既有模板，不碰引擎） */
export const workflows = sqliteTable(
  'workflows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull(), // 链挂项目级
    name: text('name').notNull(),
    // draft|active|paused|done|cancelled
    status: text('status').notNull().default('draft'),
    autoAdvance: integer('auto_advance').notNull().default(0), // 0=安全默认关；1=完成自动级联
    budgetCap: real('budget_cap'), // 链级累计成本上限（元；NULL=不设链上限，仍受 project 预算约束）
    segments: text('segments').notNull().default('[]'), // JSON：[{ templateKey, inputSpec? }] 有序
    note: text('note'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_workflows_project').on(t.projectId), index('idx_workflows_status').on(t.status)],
)

/** 声音克隆音色库（平台级通用；声线引用语法 clone:{id}；合成须同 provider+model） */
export const voiceClones = sqliteTable('voice_clones', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(), // 音色名（用户可读；唯一）
  providerKey: text('provider_key').notNull(), // 克隆供应商（api_providers.key，如 aliyun_bailian_tts）
  model: text('model').notNull(), // 克隆目标模型（如 cosyvoice-v1；合成时需同模型使用）
  voiceId: text('voice_id').notNull(), // 供应商返回的克隆 voice 标识
  status: text('status').notNull().default('ready'), // v1 同步协议仅落成功行（ready）；预留异步协议
  meta: text('meta').notNull().default('{}'), // JSON：协议/参数留痕（如 { protocol:'dashscope-enrollment', prefix }）
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

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
export type Canvas = typeof canvases.$inferSelect
export type CanvasNode = typeof canvasNodes.$inferSelect
export type CanvasEdge = typeof canvasEdges.$inferSelect
export type CanvasGroup = typeof canvasGroups.$inferSelect
export type CanvasSnapshot = typeof canvasSnapshots.$inferSelect
export type VoiceClone = typeof voiceClones.$inferSelect
export type Schedule = typeof schedules.$inferSelect
export type Workflow = typeof workflows.$inferSelect

/** 预算告警记录（超阈告警留痕；24h 去抖） */
export const budgetAlerts = sqliteTable('budget_alerts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scope: text('scope').notNull(), // project|global
  scopeId: integer('scope_id'), // projectId（global 为 null）
  kind: text('kind').notNull(), // monthly|total
  budget: real('budget').notNull(),
  spent: real('spent').notNull(),
  ratio: real('ratio').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_budget_alerts_scope').on(t.scope)])

export type BudgetAlert = typeof budgetAlerts.$inferSelect

// ---------- 通用追溯层（内容/参考版本 + 执行真实输入快照；无短剧专属模型，加法迁移） ----------

/** 内容/参考对象版本（asset 不可变文件版本 / entity 字段快照；写后永不覆写） */
export const contentVersions = sqliteTable(
  'content_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull(),
    objKind: text('obj_kind').notNull(), // asset|entity
    objId: integer('obj_id').notNull(),
    revision: integer('revision').notNull(), // 对象内递增（1 起）
    payloadKind: text('payload_kind').notNull().default('file'), // file=asset 不可变文件｜json=entity 字段快照
    relPath: text('rel_path'), // payloadKind=file：不可变版本文件相对路径（versions/ 下）
    sha256: text('sha256'),
    doc: text('doc'), // payloadKind=json：实体 tracked 字段快照 JSON
    label: text('label'),
    source: text('source').notNull().default('edit'), // baseline|edit|import|generate|ref-upload|ref-gen|polish|restore
    meta: text('meta').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_cv_obj_rev').on(t.objKind, t.objId, t.revision),
    index('idx_cv_project').on(t.projectId),
  ],
)

/** 执行快照：每次生成/合成冻结其真实输入集合（一条 = 一次执行） */
export const execSnapshots = sqliteTable(
  'exec_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull(),
    execKind: text('exec_kind').notNull(), // pipeline_step|canvas_task|shot_task
    runId: integer('run_id'),
    stepId: integer('step_id'),
    taskId: integer('task_id'),
    templateKey: text('template_key'),
    model: text('model'),
    inputHash: text('input_hash'),
    frozenAt: integer('frozen_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_es_project').on(t.projectId),
    index('idx_es_task').on(t.taskId),
    index('idx_es_step').on(t.stepId),
  ],
)

/** 执行实际输入依赖边：used/skipped + 版本指针 + 镜头/端口语义定位（下游影响反查用） */
export const execInputs = sqliteTable(
  'exec_inputs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    snapshotId: integer('snapshot_id').notNull(),
    projectId: integer('project_id').notNull(),
    role: text('role').notNull(), // text|reference|first_frame|last_frame|source|mask|subtitle|bgm|sfx|prev_text|voice
    srcKind: text('src_kind').notNull(), // asset|entity
    srcId: integer('src_id').notNull(),
    versionId: integer('version_id'), // → content_versions.id（NULL=旧数据无版本，影响分析标「历史不可恢复」）
    used: integer('used').notNull().default(1), // 1=最终采用 0=计划但跳过
    skipReason: text('skip_reason'),
    shotId: text('shot_id'), // 镜头定位（分镜/合成；NULL=非镜头级）
    port: text('port'), // 画布端口语义定位
    ordinal: integer('ordinal').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_ei_snapshot').on(t.snapshotId),
    index('idx_ei_source').on(t.srcKind, t.srcId),
  ],
)

export type ContentVersion = typeof contentVersions.$inferSelect
export type ExecSnapshot = typeof execSnapshots.$inferSelect
export type ExecInput = typeof execInputs.$inferSelect

// ---------- 精确返修操作台账（precision-rework 规格 §5.1；只记操作与幂等回执，不存媒体副本/时间轴） ----------

/** 返修请求：同键同载荷回放、异载荷冲突；applied 为终态回执（resultJson 固定版本/产物关联） */
export const reworkRequests = sqliteTable(
  'rework_requests',
  {
    id: text('id').primaryKey(), // UUID（调用方 randomUUID 生成）
    projectId: integer('project_id').notNull(),
    runId: integer('run_id').notNull(),
    stepKey: text('step_key').notNull(),
    sessionId: integer('session_id'), // 可空：非轻松创作入口无会话
    requestKey: text('request_key').notNull(),
    requestHash: text('request_hash').notNull(),
    // parsing|uncertain|ready|blocked|applied
    state: text('state').notNull().default('parsing'),
    baseFingerprint: text('base_fingerprint'), // 基准指纹（ready 起必填；异基准预览失效）
    changesJson: text('changes_json').notNull().default('[]'),
    previewJson: text('preview_json').notNull().default('{}'),
    resultJson: text('result_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_rework_requests_run_key').on(t.runId, t.requestKey),
    index('idx_rework_requests_project').on(t.projectId),
    index('idx_rework_requests_run').on(t.runId),
  ],
)

export type ReworkRequest = typeof reworkRequests.$inferSelect

/** 创作控制态；生产状态始终由关联 run 投影。 */
export const creationSessions = sqliteTable('creation_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  requestKey: text('request_key').notNull(),
  status: text('status').notNull().default('draft'),
  plan: text('plan'),
  approvedPlan: text('approved_plan'),
  planRevision: integer('plan_revision').notNull().default(0),
  planHash: text('plan_hash'),
  preflight: text('preflight'),
  startKey: text('start_key'),
  runId: integer('run_id'),
  runHistory: text('run_history').notNull().default('[]'),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('idx_creation_request').on(t.requestKey),
  index('idx_creation_project').on(t.projectId),
  index('idx_creation_run').on(t.runId),
])

export const creationMessages = sqliteTable('creation_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  payload: text('payload'),
  requestKey: text('request_key'),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  index('idx_creation_messages_session').on(t.sessionId),
  uniqueIndex('idx_creation_message_request').on(t.sessionId, t.requestKey),
])

export type CreationSession = typeof creationSessions.$inferSelect
export type CreationMessage = typeof creationMessages.$inferSelect
