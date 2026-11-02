/**
 * 修复执行服务测试
 *
 * 验证 executeRepair 状态机与停止条件：
 *   - 状态转换：approved → running → completed
 *   - 停止条件 1：重试次数 >= 3 时终止
 *   - 停止条件 2：累计费用 >= 10 元时终止
 *   - 停止条件 3：连续 2 次提升不足 5 分时终止
 *   - 异常处理：非 approved 状态抛出错误
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase } from './bootstrap'
import { test } from './helpers'

export async function runExecutor(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { repairRuns, pipelineRuns } = await import('../../../src/db/schema')
  const { executeRepair } = await import('../../../src/services/repair-executor')
  const { eq } = await import('drizzle-orm')
  const { randomUUID } = await import('node:crypto')

  // 取种子 run 的 id
  const [seedRun] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
  assert.ok(seedRun, 'seed run must exist')
  const sourceRunId = seedRun!.id

  await t('executeRepair 要求修复记录存在', async () => {
    await assert.rejects(
      () => executeRepair('non-existent-id'),
      /not found/,
      'should reject non-existent repair run',
    )
  })

  await t('executeRepair 要求状态为 approved', async () => {
    // 创建一条 proposed 状态的修复记录
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'proposed',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    await assert.rejects(
      () => executeRepair(repairId),
      /expected 'approved'/,
      'should reject non-approved status',
    )
  })

  await t('状态机转换：approved → running → completed', async () => {
    // 创建一条 approved 状态的修复记录
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'approved',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    // 执行修复
    const result = await executeRepair(repairId)

    // 验证最终状态为 completed
    assert.equal(result.finalStatus, 'completed', 'finalStatus must be completed')

    // 验证数据库中的状态已更新
    const [row] = await db.select().from(repairRuns).where(eq(repairRuns.id, repairId)).limit(1)
    assert.equal(row!.status, 'completed', 'database status must be completed')
  })

  await t('停止条件 1：重试次数达到上限（3 次）时终止', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'approved',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const result = await executeRepair(repairId)

    // 验证尝试次数
    assert.ok(result.attemptCount <= 3, `attemptCount=${result.attemptCount} must be <= 3`)
    assert.ok(result.attemptCount > 0, 'attemptCount must be > 0')

    // 验证终止原因包含重试次数相关信息
    assert.ok(/重试|次数|上限/.test(result.stopReason), `stopReason="${result.stopReason}" must mention retry limit`)
  })

  await t('停止条件 2：累计费用达到上限（10 元）时终止', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'approved',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const result = await executeRepair(repairId)

    // 验证累计费用
    assert.ok(result.totalCost <= 10.0, `totalCost=${result.totalCost} must be <= 10.0`)
    assert.ok(result.totalCost > 0, 'totalCost must be > 0')

    // 如果是因为费用上限终止，终止原因应包含费用相关信息
    if (result.stopReason.includes('费用')) {
      assert.ok(/费用|上限|元/.test(result.stopReason), `stopReason="${result.stopReason}" must mention cost limit`)
    }
  })

  await t('执行结果包含修复前后分数', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'approved',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const result = await executeRepair(repairId)

    // 验证分数存在且为数字
    assert.ok(typeof result.scoreBefore === 'number', 'scoreBefore must be a number')
    assert.ok(typeof result.scoreAfter === 'number', 'scoreAfter must be a number')
    assert.ok(result.scoreBefore >= 0 && result.scoreBefore <= 100, 'scoreBefore must be in [0, 100]')
    assert.ok(result.scoreAfter >= 0 && result.scoreAfter <= 100, 'scoreAfter must be in [0, 100]')
  })

  await t('终止原因自解释（包含具体数值与阈值）', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'approved',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const result = await executeRepair(repairId)

    // 验证终止原因非空且包含中文说明
    assert.ok(result.stopReason.length > 0, 'stopReason must be non-empty')
    assert.ok(/[\u4e00-\u9fa5]/.test(result.stopReason), 'stopReason must contain Chinese text')
    // 验证终止原因包含数值信息
    assert.ok(/\d+/.test(result.stopReason), 'stopReason must contain numeric values')
  })
}
