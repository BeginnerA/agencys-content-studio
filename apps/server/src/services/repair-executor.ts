/**
 * R06 修复闭环：修复执行服务
 *
 * 接收已批准的修复记录（repair_runs.status='approved'），执行定向重跑 + 重新评分循环，
 * 直到满足停止条件（重试上限 / 费用上限 / 连续无改善）后终止。
 *
 * 定向重跑当前为模拟实现（仅递增 attempt_count），实际需对接单镜文本重跑与单镜媒体重跑逻辑。
 * 评分调用 scoreQuality（R01 四维评分），不调用任何付费模型。
 */
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { repairRuns } from '../db/schema'
import { scoreQuality, type QualityScoreResult } from './eval-quality'
import { createLogger } from '../logger'

const log = createLogger('repair-executor')

// ─── 公开类型 ────────────────────────────────────────────────────────────────

/** 修复执行结果 */
export interface RepairExecutionResult {
  /** 修复运行 id */
  repairRunId: string
  /** 最终状态：completed（正常终止）| failed（异常终止） */
  finalStatus: string
  /** 累计尝试次数 */
  attemptCount: number
  /** 累计费用（元） */
  totalCost: number
  /** 修复前综合质量分（百分制 0-100） */
  scoreBefore: number
  /** 修复后综合质量分（百分制 0-100） */
  scoreAfter: number
  /** 终止原因（自解释文本） */
  stopReason: string
}

/** 执行过程中的上下文，在循环与递归调用间传递 */
interface ExecutionContext {
  repairRunId: string
  sourceRunId: number
  episodeIdx: number
  attemptCount: number
  totalCost: number
  scoreBefore: number
  previousOverallScore: number
  noImprovementStreak: number
  /** 终止原因：循环结束时由 shouldStop 填充 */
  stopReason?: string
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 最大重试次数 */
const MAX_RETRY_COUNT = 3

/** 费用上限（元） */
const MAX_TOTAL_COST = 10.0

/** 最小改善阈值（百分制 0-100 分数点） */
const MIN_IMPROVEMENT_THRESHOLD = 5

/** 连续无改善次数上限：达到此值后终止修复 */
const MAX_NO_IMPROVEMENT_STREAK = 2

/** 评分缩放因子：scoreQuality 返回 0-1 区间，乘以 100 转为百分制 */
const SCORE_SCALE_FACTOR = 100

// ─── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 执行修复流程。
 *
 * 步骤：
 *   1. 加载修复记录（repair_runs 表）
 *   2. 校验状态必须为 'approved'
 *   3. 更新状态为 'running'
 *   4. 记录修复前分数（scoreBefore）
 *   5. 进入执行循环：定向重跑 → 重新评分 → 停止条件判断
 *   6. 满足停止条件时更新为 'completed'，异常时更新为 'failed'
 *
 * 停止条件（任一满足即终止）：
 *   - 重试次数 >= MAX_RETRY_COUNT（3）
 *   - 累计费用 >= MAX_TOTAL_COST（10 元）
 *   - 连续 MAX_NO_IMPROVEMENT_STREAK（2）次提升 < MIN_IMPROVEMENT_THRESHOLD（5 分）
 */
export async function executeRepair(repairRunId: string): Promise<RepairExecutionResult> {
  // 1. 加载修复记录
  const rows = await db
    .select()
    .from(repairRuns)
    .where(eq(repairRuns.id, repairRunId))
    .limit(1)

  if (rows.length === 0) {
    throw new Error(`executeRepair: repair run '${repairRunId}' not found`)
  }

  const repairRun = rows[0]!

  // 2. 校验状态：只有 approved 状态的修复记录才能执行
  if (repairRun.status !== 'approved') {
    throw new Error(
      `executeRepair: repair run '${repairRunId}' status is '${repairRun.status}', expected 'approved'`,
    )
  }

  // 3. 更新状态为 running
  await updateRepairStatus(repairRunId, 'running')

  try {
    // 4. 记录修复前分数：调用 scoreQuality 获取当前质量评分
    const beforeScore = await scoreQuality({
      runId: repairRun.sourceRunId,
      episodeIdx: repairRun.episodeIdx,
    })
    const scoreBefore = beforeScore.overallScore * SCORE_SCALE_FACTOR

    log.info('executeRepair: starting repair loop', {
      repairRunId,
      sourceRunId: repairRun.sourceRunId,
      episodeIdx: repairRun.episodeIdx,
      scoreBefore: Math.round(scoreBefore * 100) / 100,
    })

    // 5. 构建执行上下文
    const ctx: ExecutionContext = {
      repairRunId,
      sourceRunId: repairRun.sourceRunId,
      episodeIdx: repairRun.episodeIdx,
      attemptCount: repairRun.attemptCount,
      totalCost: repairRun.totalCost,
      scoreBefore,
      previousOverallScore: scoreBefore,
      noImprovementStreak: 0,
    }

    // 6. 执行修复循环
    await runRepairLoop(ctx)

    // 7. 循环正常终止 → 标记完成
    const finalScore = ctx.previousOverallScore
    await updateRepairStatus(repairRunId, 'completed', ctx.stopReason)
    await updateRepairResult(repairRunId, ctx.attemptCount, ctx.totalCost, ctx.scoreBefore, finalScore)

    log.info('executeRepair: completed', {
      repairRunId,
      attemptCount: ctx.attemptCount,
      totalCost: Math.round(ctx.totalCost * 100) / 100,
      scoreBefore: Math.round(ctx.scoreBefore * 100) / 100,
      scoreAfter: Math.round(finalScore * 100) / 100,
      stopReason: ctx.stopReason,
    })

    return {
      repairRunId,
      finalStatus: 'completed',
      attemptCount: ctx.attemptCount,
      totalCost: ctx.totalCost,
      scoreBefore: ctx.scoreBefore,
      scoreAfter: finalScore,
      stopReason: ctx.stopReason!,
    }
  } catch (error) {
    // 异常 → 标记失败
    const message = error instanceof Error ? error.message : String(error)
    await updateRepairStatus(repairRunId, 'failed', `执行异常: ${message}`)

    log.error('executeRepair: failed', { repairRunId, error: message })

    return {
      repairRunId,
      finalStatus: 'failed',
      attemptCount: repairRun.attemptCount,
      totalCost: repairRun.totalCost,
      scoreBefore: repairRun.scoreBefore ?? 0,
      scoreAfter: repairRun.scoreAfter ?? 0,
      stopReason: `执行异常: ${message}`,
    }
  }
}

// ─── 修复执行循环 ────────────────────────────────────────────────────────────

/**
 * 执行修复循环：定向重跑 → 重新评分 → 停止条件判断。
 * 满足停止条件后通过 ctx.stopReason 记录终止原因，由调用方更新数据库状态。
 */
async function runRepairLoop(ctx: ExecutionContext): Promise<void> {
  while (true) {
    // 递增尝试计数
    ctx.attemptCount++

    // 执行定向重跑（模拟：实际需调用单镜文本/媒体重跑服务）
    await executeTargetedRerun(ctx.sourceRunId, ctx.episodeIdx)

    // 模拟单轮费用（实际应从 re-run 结果中累计）
    const roundCost = 0.5
    ctx.totalCost += roundCost

    // 重新评分
    const newScore: QualityScoreResult = await scoreQuality({
      runId: ctx.sourceRunId,
      episodeIdx: ctx.episodeIdx,
    })
    const newOverall = newScore.overallScore * SCORE_SCALE_FACTOR

    // 更新修复后分数
    const scoreAfter = newOverall

    // 持久化本轮结果（attempt_count / total_cost / score_before / score_after）
    await updateRepairResult(
      ctx.repairRunId,
      ctx.attemptCount,
      ctx.totalCost,
      ctx.scoreBefore,
      scoreAfter,
    )

    log.info('runRepairLoop: iteration done', {
      repairRunId: ctx.repairRunId,
      attempt: ctx.attemptCount,
      roundCost,
      newOverall: Math.round(newOverall * 100) / 100,
    })

    // 检查停止条件
    const stopResult = shouldStop(ctx, newOverall)
    if (stopResult.shouldStop) {
      ctx.stopReason = stopResult.reason
      ctx.previousOverallScore = newOverall
      return
    }

    // 更新无改善计数：提升不足则累加，否则归零
    const improvement = newOverall - ctx.previousOverallScore
    ctx.noImprovementStreak = improvement < MIN_IMPROVEMENT_THRESHOLD
      ? ctx.noImprovementStreak + 1
      : 0

    // 记录当前分数作为下一轮的基准
    ctx.previousOverallScore = newOverall

    // 未达到停止条件 → 继续下一轮修复
  }
}

// ─── 停止条件判断 ────────────────────────────────────────────────────────────

/** 停止条件判断结果 */
interface StopCheckResult {
  /** 是否应停止 */
  shouldStop: boolean
  /** 停止原因（自解释文本；shouldStop=false 时为 undefined） */
  reason?: string
}

/**
 * 检查是否应停止修复循环。
 *
 * 三个停止条件（任一满足即返回 true）：
 *   1. 重试次数已达上限（>= MAX_RETRY_COUNT）
 *   2. 累计费用已达上限（>= MAX_TOTAL_COST）
 *   3. 连续无改善次数已达上限（>= MAX_NO_IMPROVEMENT_STREAK）
 *      —— "无改善"定义为本轮综合分提升 < MIN_IMPROVEMENT_THRESHOLD
 */
function shouldStop(ctx: ExecutionContext, currentOverallScore: number): StopCheckResult {
  // 条件 1：重试次数上限
  if (ctx.attemptCount >= MAX_RETRY_COUNT) {
    return {
      shouldStop: true,
      reason: `已达最大重试次数（${MAX_RETRY_COUNT} 次），终止修复`,
    }
  }

  // 条件 2：费用上限
  if (ctx.totalCost >= MAX_TOTAL_COST) {
    return {
      shouldStop: true,
      reason: `累计费用 ${ctx.totalCost.toFixed(2)} 元已达上限 ${MAX_TOTAL_COST} 元，终止修复`,
    }
  }

  // 条件 3：连续无改善
  if (ctx.noImprovementStreak >= MAX_NO_IMPROVEMENT_STREAK) {
    return {
      shouldStop: true,
      reason: `连续 ${MAX_NO_IMPROVEMENT_STREAK} 次提升不足 ${MIN_IMPROVEMENT_THRESHOLD} 分，终止修复`,
    }
  }

  return { shouldStop: false }
}

/**
 * 判断是否需要继续修复（shouldStop 的反面）。
 * 导出供外部调用方（如 API 层）预判修复走向。
 */
export function needsMoreRepair(ctx: ExecutionContext, currentOverallScore: number): boolean {
  return !shouldStop(ctx, currentOverallScore).shouldStop
}

// ─── 定向重跑（模拟） ────────────────────────────────────────────────────────

/**
 * 执行定向重跑。
 *
 * 当前为模拟实现：仅记录日志，不实际调用生成管线。
 * 实际实现需对接单镜文本重跑与单镜媒体重跑服务，
 * 根据 issues 中识别的低分维度定向重执行对应步骤。
 */
async function executeTargetedRerun(sourceRunId: number, episodeIdx: number): Promise<void> {
  log.info('executeTargetedRerun: simulated rerun', {
    sourceRunId,
    episodeIdx,
    note: '定向重跑为模拟实现，实际需调用 M30/M31 单镜重跑逻辑',
  })
}

// ─── 数据库更新辅助 ──────────────────────────────────────────────────────────

/**
 * 更新修复记录状态与终止原因。
 * 同时更新 updated_at 时间戳。
 */
async function updateRepairStatus(
  repairRunId: string,
  status: string,
  stopReason?: string,
): Promise<void> {
  const now = Date.now()
  await db
    .update(repairRuns)
    .set({ status, stopReason: stopReason ?? null, updatedAt: now })
    .where(eq(repairRuns.id, repairRunId))
}

/**
 * 更新修复记录的执行结果字段：尝试次数、累计费用、修复前后分数。
 * 同时更新 updated_at 时间戳。
 */
async function updateRepairResult(
  repairRunId: string,
  attemptCount: number,
  totalCost: number,
  scoreBefore: number,
  scoreAfter: number,
): Promise<void> {
  const now = Date.now()
  await db
    .update(repairRuns)
    .set({ attemptCount, totalCost, scoreBefore, scoreAfter, updatedAt: now })
    .where(eq(repairRuns.id, repairRunId))
}
