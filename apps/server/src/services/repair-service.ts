/**
 * R06 修复闭环：修复建议服务
 *
 * 基于四维质量评分（scoreQuality）识别低分维度，生成修复建议并评估影响范围。
 * 所有计算均基于数据库已有追溯结构（exec_inputs / exec_snapshots），不调用任何付费模型。
 *
 * 质量阈值固定 70 分（百分制）；每个低分维度生成一条修复建议；
 * 影响范围基于 exec_inputs 的版本链反查共享相同数据源的其他 run。
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  execInputs,
  execSnapshots,
  pipelineRuns,
} from '../db/schema'
import { scoreQuality, type QualityScoreResult } from './eval-quality'
import { createLogger } from '../logger'

const log = createLogger('repair-service')

// ─── 公开类型 ────────────────────────────────────────────────────────────────

/** 单个质量问题的修复建议 */
export interface RepairIssue {
  /** 质量维度标识：citation | consistency | coherence | cost */
  dimension: string
  /** 当前得分（百分制 0-100） */
  score: number
  /** 及格阈值（百分制，当前固定 70） */
  threshold: number
  /** 针对该维度的修复建议（自解释文本） */
  suggestion: string
}

/** 一次修复提案：包含问题列表、影响范围与费用估算 */
export interface RepairProposal {
  /** 源 run id（待修复的 pipeline run） */
  runId: number
  /** 集号（同一 run 可按集分别评估） */
  episodeIdx: number
  /** 低于阈值的维度问题列表（全部 >= 阈值时为空数组） */
  issues: RepairIssue[]
  /** 影响范围：受共享数据源波及的其他 run 与集号 */
  impactScope: ImpactScope
  /** 费用估算（元）：影响集数 × 低分维度数 × 0.1 */
  estimatedCost: number
  /** 评分快照（调用方可用于持久化 scoreBefore） */
  scoreSnapshot: QualityScoreResult
}

/** 影响范围 */
export interface ImpactScope {
  /** 共享相同数据源的其他 run id（不含当前 run） */
  affectedRunIds: number[]
  /** 受影响 run 涉及的集号集合 */
  affectedEpisodes: number[]
  /** 作为关联桥梁的数据源（srcKind:srcId 列表，截断至上限） */
  sharedSources: string[]
  /** 当前 run 自身关联的 exec_snapshot 数量 */
  snapshotCount: number
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 质量及格阈值（百分制） */
const QUALITY_THRESHOLD = 70

/** 百分制换算因子（scoreQuality 返回 0-1 区间） */
const SCALE_FACTOR = 100

/** 单集单维度修复单价（元） */
const UNIT_COST_PER_EPISODE_DIMENSION = 0.1

/** 共享数据源追溯上限（防止极端情况下结果集过大） */
const MAX_SHARED_SOURCES = 50

/** 影响 run 查询上限 */
const MAX_AFFECTED_RUNS = 100

// ─── 维度 → 修复建议映射 ─────────────────────────────────────────────────────

/**
 * 每个维度的修复建议文本。
 * 建议内容自解释：读者无需查阅外部文档即可理解应执行什么操作。
 */
const DIMENSION_SUGGESTIONS: Record<string, string> = {
  citation:
    '引文完整度不足：部分执行输入缺少版本指针（version_id）。' +
    '建议重新执行缺失版本追溯的步骤，确保所有 exec_inputs 均关联 content_versions 记录。',
  consistency:
    '角色一致性不足：引用的实体版本中存在不稳定状态（superseded/failed）。' +
    '建议检查角色/场景/道具实体，将漂移版本重新确认或冻结为稳定态。',
  coherence:
    '剧情连贯度不足：continuity 台账中上下文记录未充分确认。' +
    '建议审查本集相关的 context 类型台账，将待确认记录标记为 confirmed/frozen。',
  cost:
    '费用效率不足：部分用量记录缺少计价信息（cost 为 NULL）。' +
    '建议检查对应 api_configs 的定价配置，确保所有消耗类型均有单位价格。',
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 为指定 run + 集号生成修复提案。
 *
 * 流程：
 *   1. 调用 scoreQuality 获取四维评分
 *   2. 将 0-1 分数转换为百分制，识别低于阈值（70 分）的维度
 *   3. 为每个低分维度生成一条修复建议
 *   4. 基于 exec_inputs 版本链计算影响范围（共享相同数据源的其他 run）
 *   5. 估算修复费用 = 影响集数 × 低分维度数 × 0.1
 */
export async function proposeRepair(runId: number, episodeIdx: number): Promise<RepairProposal> {
  // 1. 获取质量评分（scoreQuality 内部会持久化到 quality_scores 表）
  const scoreResult = await scoreQuality({ runId, episodeIdx })

  // 2. 识别低分维度（百分制 < 70）
  const dimensions = [
    { key: 'citation', score: scoreResult.citationScore },
    { key: 'consistency', score: scoreResult.consistencyScore },
    { key: 'coherence', score: scoreResult.coherenceScore },
    { key: 'cost', score: scoreResult.costScore },
  ]

  const issues: RepairIssue[] = []
  for (const dim of dimensions) {
    const percentile = dim.score * SCALE_FACTOR
    if (percentile < QUALITY_THRESHOLD) {
      issues.push({
        dimension: dim.key,
        score: Math.round(percentile * 100) / 100, // 保留两位小数
        threshold: QUALITY_THRESHOLD,
        suggestion: DIMENSION_SUGGESTIONS[dim.key] ?? `维度 ${dim.key} 得分偏低，建议检查相关数据质量。`,
      })
    }
  }

  // 3. 计算影响范围（基于 exec_inputs 版本链）
  const impactScope = await calculateImpactScope(runId)

  // 4. 费用估算：影响集数 × 低分维度数 × 单价
  const affectedEpisodeCount = Math.max(1, impactScope.affectedEpisodes.length)
  const estimatedCost = affectedEpisodeCount * issues.length * UNIT_COST_PER_EPISODE_DIMENSION

  log.info('proposeRepair done', {
    runId,
    episodeIdx,
    issueCount: issues.length,
    affectedRunCount: impactScope.affectedRunIds.length,
    affectedEpisodes: impactScope.affectedEpisodes.length,
    estimatedCost,
  })

  return {
    runId,
    episodeIdx,
    issues,
    impactScope,
    estimatedCost,
    scoreSnapshot: scoreResult,
  }
}

// ─── 影响范围计算 ────────────────────────────────────────────────────────────

/**
 * 基于 exec_inputs 的版本链反查共享相同数据源的其他 run。
 *
 * 算法：
 *   1. 取当前 run 的所有 exec_snapshot
 *   2. 收集这些 snapshot 的 exec_inputs 中引用的数据源（srcKind + srcId）
 *   3. 查找引用了相同数据源的其他 exec_snapshot → 对应的其他 run
 *   4. 汇总受影响 run 及其集号
 */
async function calculateImpactScope(sourceRunId: number): Promise<ImpactScope> {
  // 步骤 1：取当前 run 的所有 exec_snapshot id
  const ownSnapshots = await db
    .select({ id: execSnapshots.id })
    .from(execSnapshots)
    .where(eq(execSnapshots.runId, sourceRunId))

  const ownSnapshotIds = ownSnapshots.map((s) => s.id)

  if (ownSnapshotIds.length === 0) {
    return { affectedRunIds: [], affectedEpisodes: [], sharedSources: [], snapshotCount: 0 }
  }

  // 步骤 2：收集当前 run 引用的数据源（去重）
  const ownInputs = await db
    .select({
      srcKind: execInputs.srcKind,
      srcId: execInputs.srcId,
    })
    .from(execInputs)
    .where(
      and(
        inArray(execInputs.snapshotId, ownSnapshotIds),
        sql`${execInputs.used} = 1`,
      ),
    )
    .limit(MAX_SHARED_SOURCES * 10) // 宽限查询量，去重后截断

  // 去重为 "srcKind:srcId" 集合
  const sourceSet = new Set<string>()
  for (const inp of ownInputs) {
    sourceSet.add(`${inp.srcKind}:${inp.srcId}`)
    if (sourceSet.size >= MAX_SHARED_SOURCES) break
  }

  const sharedSources = [...sourceSet]

  if (sharedSources.length === 0) {
    return { affectedRunIds: [], affectedEpisodes: [], sharedSources: [], snapshotCount: ownSnapshotIds.length }
  }

  // 步骤 3：查找引用了相同数据源的其他 exec_snapshot
  // 解析 srcKind/srcId 用于 SQL 查询
  const sourceConditions = sharedSources.map((s) => {
    const [kind, idStr] = s.split(':')
    return { srcKind: kind!, srcId: Number(idStr!) }
  })

  // 构建 OR 条件：匹配任一 (srcKind, srcId) 组合
  const orConditions = sourceConditions.map((c) =>
    and(eq(execInputs.srcKind, c.srcKind), eq(execInputs.srcId, c.srcId)),
  )

  const otherSnapshots = await db
    .select({ distinctSnapshotId: sql<number>`DISTINCT ${execInputs.snapshotId}` })
    .from(execInputs)
    .where(
      and(
        sql`(${sql.join(orConditions.map((c) => sql`(${c})`), sql` OR `)})`,
        sql`${execInputs.used} = 1`,
      ),
    )
    .limit(MAX_SHARED_RUNS * 10)

  const otherSnapshotIds = otherSnapshots
    .map((s) => s.distinctSnapshotId)
    .filter((id) => !ownSnapshotIds.includes(id as number))

  if (otherSnapshotIds.length === 0) {
    return { affectedRunIds: [], affectedEpisodes: [], sharedSources, snapshotCount: ownSnapshotIds.length }
  }

  // 步骤 4：通过 exec_snapshots 找到对应的 run，再取 run 的集号信息
  const otherExecSnapshots = await db
    .select({
      distinctRunId: sql<number>`DISTINCT ${execSnapshots.runId}`,
    })
    .from(execSnapshots)
    .where(
      and(
        inArray(execSnapshots.id, otherSnapshotIds as number[]),
        sql`${execSnapshots.runId} IS NOT NULL`,
        sql`${execSnapshots.runId} != ${sourceRunId}`,
      ),
    )
    .limit(MAX_AFFECTED_RUNS)

  const affectedRunIds = otherExecSnapshots
    .map((s) => s.distinctRunId)
    .filter((id): id is number => id != null)

  if (affectedRunIds.length === 0) {
    return { affectedRunIds: [], affectedEpisodes: [], sharedSources, snapshotCount: ownSnapshotIds.length }
  }

  // 取受影响 run 的 projectId（用于查集号）
  const affectedRuns = await db
    .select({
      id: pipelineRuns.id,
      projectId: pipelineRuns.projectId,
    })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.id, affectedRunIds))

  // 取当前 run 的 projectId 和集号对应的 episode 信息
  const [sourceRun] = await db
    .select({ projectId: pipelineRuns.projectId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, sourceRunId))
    .limit(1)

  if (!sourceRun) {
    return { affectedRunIds, affectedEpisodes: [], sharedSources, snapshotCount: ownSnapshotIds.length }
  }

  // 收集受影响 run 关联的集号（通过 episodes.latestRunId 反查）
  const affectedProjectIds = [...new Set(affectedRuns.map((r) => r.projectId))]
  const affectedEpisodes = await collectAffectedEpisodes(affectedProjectIds, affectedRunIds)

  return { affectedRunIds, affectedEpisodes, sharedSources, snapshotCount: ownSnapshotIds.length }
}

/**
 * 收集受影响 run 关联的集号。
 * 通过 episodes 表的 latestRunId 字段反查；若 run 未绑定到 episode 则跳过。
 */
async function collectAffectedEpisodes(projectIds: number[], runIds: number[]): Promise<number[]> {
  if (projectIds.length === 0 || runIds.length === 0) return []

  const episodeRows = await db
    .select({ number: sql<number>`DISTINCT ${sql.raw('number')}` })
    .from(sql`episodes`)
    .where(
      and(
        inArray(sql`project_id`, projectIds),
        inArray(sql`latest_run_id`, runIds),
      ),
    )
    .limit(MAX_SHARED_SOURCES)

  return episodeRows.map((e) => Number(e.number)).filter((n) => Number.isFinite(n) && n > 0)
}

// ─── 内部常量补充 ────────────────────────────────────────────────────────────

/** 影响 run 查询宽限量（与 MAX_AFFECTED_RUNS 配合） */
const MAX_SHARED_RUNS = 100
