/**
 * 权重调整测试
 *
 * 验证自定义权重对综合分的影响：
 *   - 默认权重（0.3/0.3/0.2/0.2）产生正确综合分
 *   - 自定义权重覆盖默认值并正确影响综合分
 *   - 极端权重（单维度 1.0 其余 0.0）退化为该维度分数
 *   - 权重快照写入数据库
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase, EXPECTED } from './bootstrap'
import { test } from './helpers'

export async function runWeights(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { pipelineRuns, qualityScores } = await import('../../../src/db/schema')
  const { scoreQuality } = await import('../../../src/services/eval-quality')
  const { eq } = await import('drizzle-orm')

  const [seedRun] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
  const runId = seedRun!.id

  await t('自定义权重（0.5/0.2/0.2/0.1）综合分 = 加权平均', async () => {
    const customWeights = { citation: 0.5, consistency: 0.2, coherence: 0.2, cost: 0.1 }
    const result = await scoreQuality({ runId, episodeIdx: 1, weights: customWeights })
    const expected =
      EXPECTED.citationScore * 0.5 +
      EXPECTED.consistencyScore * 0.2 +
      EXPECTED.coherenceScore * 0.2 +
      EXPECTED.costScore * 0.1
    assert.ok(
      Math.abs(result.overallScore - expected) < 0.02,
      `overallScore=${result.overallScore} expected≈${expected}`,
    )
  })

  await t('极端权重（仅引文 1.0）综合分退化为引文分数', async () => {
    // 使用不同 episodeIdx 避免与既有记录冲突
    const result = await scoreQuality({ runId, episodeIdx: 99, weights: { citation: 1.0, consistency: 0, coherence: 0, cost: 0 } })
    assert.ok(
      Math.abs(result.overallScore - EXPECTED.citationScore) < 0.02,
      `overallScore=${result.overallScore} expected≈citationScore=${EXPECTED.citationScore}`,
    )
  })

  await t('自定义权重已快照写入 quality_scores.weights', async () => {
    const customWeights = { citation: 0.4, consistency: 0.3, coherence: 0.2, cost: 0.1 }
    await scoreQuality({ runId, episodeIdx: 1, weights: customWeights })
    const [row] = await db.select().from(qualityScores).where(eq(qualityScores.runId, runId)).limit(1)
    const stored = JSON.parse(row!.weights)
    assert.equal(stored.citation, 0.4)
    assert.equal(stored.consistency, 0.3)
    assert.equal(stored.coherence, 0.2)
    assert.equal(stored.cost, 0.1)
  })

  await t('部分权重覆盖：只传 citation 时其余保持默认值', async () => {
    // 使用 episodeIdx=1 以匹配种子数据的连贯度预期值
    const result = await scoreQuality({ runId, episodeIdx: 1, weights: { citation: 0.6 } })
    // 默认值：consistency=0.3, coherence=0.2, cost=0.2
    // 传入 citation=0.6 覆盖默认 0.3
    const expected =
      EXPECTED.citationScore * 0.6 +
      EXPECTED.consistencyScore * 0.3 +
      EXPECTED.coherenceScore * 0.2 +
      EXPECTED.costScore * 0.2
    // 权重之和 = 0.6+0.3+0.2+0.2 = 1.3，服务层不重新归一化，直接加权后 clamp01
    const clampedExpected = Math.max(0, Math.min(1, expected))
    assert.ok(
      Math.abs(result.overallScore - clampedExpected) < 0.02,
      `overallScore=${result.overallScore} expected≈${clampedExpected}`,
    )
  })
}
