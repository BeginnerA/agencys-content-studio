import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { assets, characters, pipelineRuns } from './schema'

/** 质量与角色一致性域表（从主 schema 拆出）：质量基线评分、修复闭环、多阶段质检门禁、实体参考分层与逐角色一致性评价。
 *  这些表以外键引用主 schema 的 pipelineRuns / characters / assets；引用以惰性回调登记，与主 schema 共用同一份表对象，
 *  故拆分不改变生成的 SQL 结构。 */

// ---------- 质量基线（四维评分 + 综合分 + 可复现性元数据） ----------

/** 质量评分：每个 run × 集号一条记录；四维评分 + 加权综合分 + 权重快照 + 元数据 */
export const qualityScores = sqliteTable(
  'quality_scores',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id').notNull().references(() => pipelineRuns.id),
    episodeIdx: integer('episode_idx').notNull(),
    citationScore: real('citation_score').notNull(),
    consistencyScore: real('consistency_score').notNull(),
    coherenceScore: real('coherence_score').notNull(),
    costScore: real('cost_score').notNull(),
    overallScore: real('overall_score').notNull(),
    weights: text('weights').notNull(),   // JSON: { citation, consistency, coherence, cost }
    metadata: text('metadata').notNull(), // JSON: { templateVersion, promptVersion, model, params, assetVersions }
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_quality_scores_run').on(t.runId),
    uniqueIndex('idx_quality_scores_run_episode').on(t.runId, t.episodeIdx),
  ],
)

export type QualityScore = typeof qualityScores.$inferSelect

// ---------- 修复闭环（repair_runs：跟踪修复流程状态与成本） ----------

/** 修复运行记录：source_run_id 指向原始 pipeline run；status 状态机 proposed→approved→running→completed/cancelled/failed */
export const repairRuns = sqliteTable(
  'repair_runs',
  {
    id: text('id').primaryKey(), // UUID（调用方 randomUUID 生成）
    sourceRunId: integer('source_run_id').notNull().references(() => pipelineRuns.id),
    episodeIdx: integer('episode_idx').notNull(),
    // proposed|approved|running|completed|cancelled|failed
    status: text('status').notNull(),
    issues: text('issues').notNull(), // JSON: 问题列表
    impactScope: text('impact_scope').notNull(), // JSON: 影响范围
    attemptCount: integer('attempt_count').notNull().default(0),
    totalCost: real('total_cost').notNull().default(0),
    scoreBefore: real('score_before'),
    scoreAfter: real('score_after'),
    stopReason: text('stop_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_repair_runs_source').on(t.sourceRunId),
    index('idx_repair_runs_status').on(t.status),
  ],
)

export type RepairRun = typeof repairRuns.$inferSelect

// ---------- 多阶段质量检查（统一问题记录 + 阶段门禁） ----------

/** 质量检查问题记录：每条问题关联到具体的 run、集、阶段、检查器、目标对象；exempted 标记是否已人工豁免 */
export const qualityIssues = sqliteTable(
  'quality_issues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id').notNull().references(() => pipelineRuns.id),
    episodeIdx: integer('episode_idx').notNull(),
    stage: text('stage').notNull(),
    checker: text('checker').notNull(),
    dimension: text('dimension').notNull(),
    severity: text('severity').notNull(),
    checkType: text('check_type').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    evidence: text('evidence').notNull(),
    suggestion: text('suggestion'),
    exempted: integer('exempted').notNull().default(0),
    exemptedBy: text('exempted_by'),
    exemptedAt: integer('exempted_at'),
    exemptReason: text('exempt_reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_quality_issues_run').on(t.runId),
    index('idx_quality_issues_stage').on(t.runId, t.stage),
    index('idx_quality_issues_severity').on(t.runId, t.severity),
  ],
)

export type QualityIssue = typeof qualityIssues.$inferSelect

/** 阶段门禁状态：汇总每个 (run, episode, stage) 的阻断/警告/豁免问题数；status: pending|pass|fail|exempt */
export const qualityGates = sqliteTable(
  'quality_gates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id').notNull().references(() => pipelineRuns.id),
    episodeIdx: integer('episode_idx').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull().default('pending'),
    blockingCount: integer('blocking_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),
    exemptCount: integer('exempt_count').notNull().default(0),
    checkedAt: integer('checked_at'),
  },
  (t) => [
    index('idx_quality_gates_run').on(t.runId),
    uniqueIndex('idx_quality_gates_unique').on(t.runId, t.episodeIdx, t.stage),
  ],
)

export type QualityGate = typeof qualityGates.$inferSelect

// ---------- 角色一致性（参考分层登记 + 逐角色评价结果） ----------

/** 实体参考图分层登记（role：base=基准定妆 / state=状态变体 / view=多视角补充；enabled=0 暂不参与选择） */
export const entityReferences = sqliteTable(
  'entity_references',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityId: integer('entity_id').notNull().references(() => characters.id),
    assetId: integer('asset_id').notNull().references(() => assets.id),
    role: text('role').notNull(), // base|state|view
    stateKey: text('state_key'), // role=state 时 = 该实体 states 数组某条目原文
    viewKey: text('view_key'), // role=view 时视角说明（自由文本）
    enabled: integer('enabled').notNull().default(1),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_entity_refs_pair').on(t.entityId, t.assetId),
    index('idx_entity_refs_entity').on(t.entityId),
  ],
)

/** 逐角色一致性评价结果（一 run×一实体一行，重评覆盖；score 为 0–10 均分，NULL=无法评价且 note 记原因） */
export const characterConsistencyResults = sqliteTable(
  'character_consistency_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id').notNull().references(() => pipelineRuns.id),
    entityId: integer('entity_id').notNull().references(() => characters.id),
    episodeIdx: integer('episode_idx').notNull().default(0),
    score: real('score'),
    assetTotal: integer('asset_total').notNull().default(0),
    assetSampled: integer('asset_sampled').notNull().default(0),
    refCount: integer('ref_count').notNull().default(0),
    model: text('model'),
    provider: text('provider'),
    note: text('note'),
    evaluatedAt: integer('evaluated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_char_consistency_pair').on(t.runId, t.entityId),
    index('idx_char_consistency_run').on(t.runId),
  ],
)
