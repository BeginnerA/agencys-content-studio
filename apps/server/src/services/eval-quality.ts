/**
 * R01 质量基线：四维评分服务
 *
 * 四个维度均基于数据库已有追溯结构计算，不调用任何付费模型或外部服务：
 *   1. 引文完整度 —— exec_inputs 中携带 version_id（版本指针）的比例
 *   2. 角色一致性 —— 实体类 exec_inputs 引用的版本均处于 confirmed/frozen 稳定态的比例
 *   3. 剧情连贯度 —— continuity 台账中 context 类型记录已 bound/confirmed 的比例
 *   4. 费用效率 —— usage_records 中已计价（cost 非 NULL）的比例
 *
 * 加权平均使用调用方传入的权重（默认等权 0.3/0.3/0.2/0.2），结果写入 quality_scores 表。
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  contentContinuityRecords,
  execInputs,
  execSnapshots,
  pipelineRuns,
  qualityScores,
  usageRecords,
  contentVersions,
} from '../db/schema'
import { createLogger } from '../logger'

const log = createLogger('eval-quality')

// ─── 公开类型 ────────────────────────────────────────────────────────────────

export interface QualityScoreInput {
  runId: number
  episodeIdx: number
  weights?: {
    citation?: number
    consistency?: number
    coherence?: number
    cost?: number
  }
}

export interface QualityScoreResult {
  citationScore: number
  consistencyScore: number
  coherenceScore: number
  costScore: number
  overallScore: number
  metadata: QualityMetadata
}

export interface QualityMetadata {
  templateVersion: string
  promptVersion: string
  model: string
  params: Record<string, unknown>
  assetVersions: Record<string, string>
}

// ─── 默认权重 ────────────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = {
  citation: 0.3,
  consistency: 0.3,
  coherence: 0.2,
  cost: 0.2,
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 计算四维评分并持久化到 quality_scores 表。
 * 同 run + episodeIdx 重复调用会更新既有记录（unique 约束）。
 */
export async function scoreQuality(input: QualityScoreInput): Promise<QualityScoreResult> {
  const weights = { ...DEFAULT_WEIGHTS, ...input.weights }

  // 校验 run 存在
  const [run] = await db
    .select({ id: pipelineRuns.id, projectId: pipelineRuns.projectId, templateSnapshot: pipelineRuns.templateSnapshot })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, input.runId))
    .limit(1)
  if (!run) throw new Error(`scoreQuality: run ${input.runId} not found`)

  // 1. 引文完整度
  const citationScore = await calculateCitationScore(input.runId)

  // 2. 角色一致性
  const consistencyScore = await calculateConsistencyScore(input.runId)

  // 3. 剧情连贯度
  const coherenceScore = await calculateCoherenceScore(run.projectId, input.episodeIdx)

  // 4. 费用效率
  const costScore = await calculateCostScore(input.runId)

  // 5. 加权平均
  const overallScore = clamp01(
    citationScore * weights.citation +
    consistencyScore * weights.consistency +
    coherenceScore * weights.coherence +
    costScore * weights.cost,
  )

  // 6. 收集元数据
  const metadata = await collectMetadata(input.runId, run.templateSnapshot)

  // 7. 持久化（upsert：同 run+episode 覆盖）
  const now = Date.now()
  const existing = await db
    .select({ id: qualityScores.id })
    .from(qualityScores)
    .where(and(eq(qualityScores.runId, input.runId), eq(qualityScores.episodeIdx, input.episodeIdx)))
    .limit(1)

  if (existing.length > 0) {
    const existingId = existing[0]!.id
    await db
      .update(qualityScores)
      .set({
        citationScore,
        consistencyScore,
        coherenceScore,
        costScore,
        overallScore,
        weights: JSON.stringify(weights),
        metadata: JSON.stringify(metadata),
        updatedAt: now,
      })
      .where(eq(qualityScores.id, existingId))
  } else {
    await db.insert(qualityScores).values({
      runId: input.runId,
      episodeIdx: input.episodeIdx,
      citationScore,
      consistencyScore,
      coherenceScore,
      costScore,
      overallScore,
      weights: JSON.stringify(weights),
      metadata: JSON.stringify(metadata),
      createdAt: now,
      updatedAt: now,
    })
  }

  log.info('scoreQuality done', {
    runId: input.runId,
    episodeIdx: input.episodeIdx,
    citationScore,
    consistencyScore,
    coherenceScore,
    costScore,
    overallScore,
  })

  return { citationScore, consistencyScore, coherenceScore, costScore, overallScore, metadata }
}

// ─── 维度 1：引文完整度 ──────────────────────────────────────────────────────

/**
 * 语义：本 run 所有执行快照的输入依赖中，携带版本指针（version_id IS NOT NULL）的比例。
 * 版本指针意味着该输入可追溯到 content_versions 表的不可变记录，满足引文可复现要求。
 * 无执行快照时返回 0（无法评估 = 零分，不伪造正分）。
 */
async function calculateCitationScore(runId: number): Promise<number> {
  // 先取本 run 关联的 exec_snapshot ids
  const snapshots = await db
    .select({ id: execSnapshots.id })
    .from(execSnapshots)
    .where(eq(execSnapshots.runId, runId))
  if (snapshots.length === 0) return 0

  const snapshotIds = snapshots.map((s) => s.id)

  // 统计：总输入行数 & 有版本指针的行数
  const [stats] = await db
    .select({
      total: sql<number>`count(*)`,
      traced: sql<number>`sum(case when ${execInputs.versionId} is not null then 1 else 0 end)`,
    })
    .from(execInputs)
    .where(sql`${execInputs.snapshotId} IN (${sql.join(snapshotIds, sql`, `)})`)

  const total = Number(stats?.total ?? 0)
  if (total === 0) return 0
  const traced = Number(stats?.traced ?? 0)
  return clamp01(traced / total)
}

// ─── 维度 2：角色一致性 ──────────────────────────────────────────────────────

/**
 * 语义：本 run 引用的实体（角色/场景/道具）版本中，处于稳定态（非 superseded/failed）的比例。
 * 稳定版本意味着该实体在评分时刻仍然有效，角色外观/人设未发生漂移。
 * 无实体引用时返回 1（没有不一致的证据 = 默认满分，不惩罚空集）。
 */
async function calculateConsistencyScore(runId: number): Promise<number> {
  // 取本 run 所有 exec_inputs 中 src_kind='entity' 且带 version_id 的行
  const snapshots = await db
    .select({ id: execSnapshots.id })
    .from(execSnapshots)
    .where(eq(execSnapshots.runId, runId))
  if (snapshots.length === 0) return 1

  const snapshotIds = snapshots.map((s) => s.id)

  const entityInputs = await db
    .select({ versionId: execInputs.versionId })
    .from(execInputs)
    .where(
      and(
        sql`${execInputs.snapshotId} IN (${sql.join(snapshotIds, sql`, `)})`,
        eq(execInputs.srcKind, 'entity'),
        sql`${execInputs.versionId} IS NOT NULL`,
      ),
    )

  if (entityInputs.length === 0) return 1

  // 去重 version ids
  const versionIds = [...new Set(entityInputs.map((e) => e.versionId as number))]

  // 查询这些版本的状态
  const versions = await db
    .select({ id: contentVersions.id, source: contentVersions.source })
    .from(contentVersions)
    .where(sql`${contentVersions.id} IN (${sql.join(versionIds, sql`, `)})`)

  // 不稳定来源：superseded 表示已被替代（角色漂移）；failed 表示提取失败
  const unstable = new Set(['superseded', 'failed'])
  const stableCount = versions.filter((v) => !unstable.has(v.source)).length

  // 未找到版本记录的行视为不稳定（数据缺失 = 不可信）
  const foundIds = new Set(versions.map((v) => v.id))
  const missingCount = versionIds.filter((id) => !foundIds.has(id)).length

  const total = versionIds.length
  if (total === 0) return 1
  return clamp01((stableCount - missingCount) / total)
}

// ─── 维度 3：剧情连贯度 ──────────────────────────────────────────────────────

/**
 * 语义：指定项目 & 集号下，continuity 台账中 context 类型记录处于已确认（confirmed/frozen/bound）
 * 状态的比例。已确认的上下文意味着前序剧情信息已被正确提取并可用于后续集的创作参考。
 * 无台账记录时返回 0.5（中性分：无法评估但不惩罚）。
 */
async function calculateCoherenceScore(projectId: number, episodeIdx: number): Promise<number> {
  const confirmedStates = ['confirmed', 'frozen', 'bound'] as const

  // 查询本集相关的 context 类型台账记录
  const records = await db
    .select({ status: contentContinuityRecords.status, rowType: contentContinuityRecords.rowType })
    .from(contentContinuityRecords)
    .where(
      and(
        eq(contentContinuityRecords.projectId, projectId),
        eq(contentContinuityRecords.unitKind, 'episode'),
        eq(contentContinuityRecords.unitId, episodeIdx),
        eq(contentContinuityRecords.rowType, 'context'),
      ),
    )

  if (records.length === 0) {
    // 也检查 entry 类型记录作为降级信号：有 entry 但无 context 说明提取不完整
    const entries = await db
      .select({ id: contentContinuityRecords.id })
      .from(contentContinuityRecords)
      .where(
        and(
          eq(contentContinuityRecords.projectId, projectId),
          eq(contentContinuityRecords.unitKind, 'episode'),
          eq(contentContinuityRecords.unitId, episodeIdx),
          eq(contentContinuityRecords.rowType, 'entry'),
        ),
      )
      .limit(1)
    // 有 entry 无 context = 提取不完整，给低分；完全无记录 = 中性分
    return entries.length > 0 ? 0.3 : 0.5
  }

  const confirmedCount = records.filter((r) =>
    (confirmedStates as readonly string[]).includes(r.status),
  ).length

  return clamp01(confirmedCount / records.length)
}

// ─── 维度 4：费用效率 ────────────────────────────────────────────────────────

/**
 * 语义：本 run 的用量记录中，已计价（cost IS NOT NULL）的比例。
 * 高计价覆盖率意味着成本可追溯、可审计，满足费用透明要求。
 * 无用量记录时返回 1（无消耗 = 无费用问题）。
 */
async function calculateCostScore(runId: number): Promise<number> {
  const [stats] = await db
    .select({
      total: sql<number>`count(*)`,
      priced: sql<number>`sum(case when ${usageRecords.cost} is not null then 1 else 0 end)`,
    })
    .from(usageRecords)
    .where(eq(usageRecords.runId, runId))

  const total = Number(stats?.total ?? 0)
  if (total === 0) return 1
  const priced = Number(stats?.priced ?? 0)
  return clamp01(priced / total)
}

// ─── 元数据收集 ──────────────────────────────────────────────────────────────

/**
 * 从 run 的 templateSnapshot 和 execSnapshots 中提取可复现性元数据。
 * 缺失字段以空字符串/空对象兜底，不抛异常。
 */
async function collectMetadata(runId: number, templateSnapshotJson: string | null): Promise<QualityMetadata> {
  // 解析模板快照
  let templateVersion = ''
  let promptVersion = ''
  let model = ''
  let params: Record<string, unknown> = {}

  if (templateSnapshotJson) {
    try {
      const snap = JSON.parse(templateSnapshotJson) as Record<string, unknown>
      templateVersion = String(snap.version ?? snap.templateVersion ?? '')
      promptVersion = String(snap.promptVersion ?? '')
      model = String(snap.model ?? snap.llmModel ?? '')
      params = (snap.params && typeof snap.params === 'object' ? snap.params : {}) as Record<string, unknown>
    } catch {
      // 快照解析失败不影响评分，元数据留空
    }
  }

  // 收集资产版本指针（exec_inputs 中 src_kind='asset' 的 version_id 映射）
  const assetVersions: Record<string, string> = {}
  const snapshots = await db
    .select({ id: execSnapshots.id })
    .from(execSnapshots)
    .where(eq(execSnapshots.runId, runId))

  if (snapshots.length > 0) {
    const snapshotIds = snapshots.map((s) => s.id)
    const assetInputs = await db
      .select({
        srcId: execInputs.srcId,
        versionId: execInputs.versionId,
      })
      .from(execInputs)
      .where(
        and(
          sql`${execInputs.snapshotId} IN (${sql.join(snapshotIds, sql`, `)})`,
          eq(execInputs.srcKind, 'asset'),
          sql`${execInputs.versionId} IS NOT NULL`,
        ),
      )
      .limit(100) // 防止极端情况下结果集过大

    for (const inp of assetInputs) {
      assetVersions[`asset:${inp.srcId}`] = `v${inp.versionId}`
    }
  }

  return { templateVersion, promptVersion, model, params, assetVersions }
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/** 将分数限制在 [0, 1] 区间 */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}
