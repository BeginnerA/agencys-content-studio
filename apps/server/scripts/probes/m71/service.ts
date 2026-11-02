/**
 * 评分服务测试
 *
 * 验证 scoreQuality 四维评分计算正确性：
 *   - 引文完整度：exec_inputs 中携带 version_id 的比例
 *   - 角色一致性：entity 类输入引用的版本处于稳定态的比例
 *   - 剧情连贯度：context 类型台账记录已确认状态的比例
 *   - 费用效率：usage_records 中已计价的比例
 *   - 综合分：加权平均
 *   - 持久化：quality_scores 表写入成功
 *   - 幂等性：同 run+episode 重复调用覆盖既有记录
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase, EXPECTED } from './bootstrap'
import { test } from './helpers'

export async function runService(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { pipelineRuns, qualityScores } = await import('../../../src/db/schema')
  const { scoreQuality } = await import('../../../src/services/eval-quality')
  const { eq } = await import('drizzle-orm')

  // 取种子 run 的 id
  const [seedRun] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
  assert.ok(seedRun, 'seed run must exist')
  const runId = seedRun!.id

  await t('scoreQuality 返回四维分数均在 [0, 1] 区间', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    for (const [key, value] of Object.entries({
      citationScore: result.citationScore,
      consistencyScore: result.consistencyScore,
      coherenceScore: result.coherenceScore,
      costScore: result.costScore,
      overallScore: result.overallScore,
    })) {
      assert.ok(value >= 0 && value <= 1, `${key}=${value} out of [0,1]`)
    }
  })

  await t('引文完整度 = 有版本指针的 exec_input 比例（种子数据 3/5 = 0.6）', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    assert.ok(
      Math.abs(result.citationScore - EXPECTED.citationScore) < 0.01,
      `citationScore=${result.citationScore} expected≈${EXPECTED.citationScore}`,
    )
  })

  await t('角色一致性 = 稳定版本比例（种子数据 entity→superseded → 0）', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    assert.ok(
      Math.abs(result.consistencyScore - EXPECTED.consistencyScore) < 0.01,
      `consistencyScore=${result.consistencyScore} expected≈${EXPECTED.consistencyScore}`,
    )
  })

  await t('剧情连贯度 = context 已确认比例（种子数据 2/2 frozen+bound → 1.0）', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    assert.ok(
      Math.abs(result.coherenceScore - EXPECTED.coherenceScore) < 0.01,
      `coherenceScore=${result.coherenceScore} expected≈${EXPECTED.coherenceScore}`,
    )
  })

  await t('费用效率 = 已计价 usage 比例（种子数据 2/3）', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    assert.ok(
      Math.abs(result.costScore - EXPECTED.costScore) < 0.01,
      `costScore=${result.costScore} expected≈${EXPECTED.costScore}`,
    )
  })

  await t('默认等权综合分 = 加权平均（0.3/0.3/0.2/0.2）', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    const expected =
      EXPECTED.citationScore * 0.3 +
      EXPECTED.consistencyScore * 0.3 +
      EXPECTED.coherenceScore * 0.2 +
      EXPECTED.costScore * 0.2
    assert.ok(
      Math.abs(result.overallScore - expected) < 0.02,
      `overallScore=${result.overallScore} expected≈${expected}`,
    )
  })

  await t('评分结果已持久化到 quality_scores 表', async () => {
    const rows = await db.select().from(qualityScores).where(eq(qualityScores.runId, runId))
    assert.ok(rows.length >= 1, 'quality_scores must have at least 1 row for seed run')
    const row = rows[0]!
    assert.equal(row.episodeIdx, 1)
    assert.ok(row.weights.length > 0, 'weights JSON must be non-empty')
    assert.ok(row.metadata.length > 0, 'metadata JSON must be non-empty')
  })

  await t('同 run+episode 重复调用覆盖既有记录（幂等 upsert）', async () => {
    const before = await db.select({ id: qualityScores.id }).from(qualityScores).where(eq(qualityScores.runId, runId))
    const countBefore = before.length
    await scoreQuality({ runId, episodeIdx: 1 })
    const after = await db.select({ id: qualityScores.id }).from(qualityScores).where(eq(qualityScores.runId, runId))
    assert.equal(after.length, countBefore, 'upsert must not create duplicate rows')
  })

  await t('不存在的 runId 抛出明确错误', async () => {
    await assert.rejects(
      () => scoreQuality({ runId: 999999, episodeIdx: 1 }),
      /not found/,
    )
  })
}
