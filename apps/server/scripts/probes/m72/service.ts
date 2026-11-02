/**
 * 修复建议服务测试
 *
 * 验证 proposeRepair 正确性：
 *   - 问题识别：低分维度（< 70 分）被正确识别
 *   - 建议生成：每个低分维度对应一条修复建议
 *   - 影响范围：基于 exec_inputs 版本链计算共享数据源
 *   - 费用估算：影响集数 × 低分维度数 × 0.1
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase, EXPECTED } from './bootstrap'
import { test } from './helpers'

export async function runService(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { pipelineRuns } = await import('../../../src/db/schema')
  const { proposeRepair } = await import('../../../src/services/repair-service')

  // 取种子 run 的 id
  const [seedRun] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
  assert.ok(seedRun, 'seed run must exist')
  const runId = seedRun!.id

  await t('proposeRepair 返回结构完整的修复提案', async () => {
    const proposal = await proposeRepair(runId, 1)
    assert.equal(proposal.runId, runId)
    assert.equal(proposal.episodeIdx, 1)
    assert.ok(Array.isArray(proposal.issues), 'issues must be an array')
    assert.ok(proposal.impactScope, 'impactScope must exist')
    assert.ok(typeof proposal.estimatedCost === 'number', 'estimatedCost must be a number')
    assert.ok(proposal.scoreSnapshot, 'scoreSnapshot must exist')
  })

  await t('问题识别正确：低分维度（< 70 分）被识别为问题', async () => {
    const proposal = await proposeRepair(runId, 1)
    // 预期低分维度：citation (60), consistency (0), cost (66.7)
    // 预期达标维度：coherence (100)
    const issueDimensions = proposal.issues.map(i => i.dimension).sort()
    assert.ok(issueDimensions.includes('citation'), 'citation should be an issue (score=60 < 70)')
    assert.ok(issueDimensions.includes('consistency'), 'consistency should be an issue (score=0 < 70)')
    assert.ok(issueDimensions.includes('cost'), 'cost should be an issue (score≈66.7 < 70)')
    assert.ok(!issueDimensions.includes('coherence'), 'coherence should NOT be an issue (score=100 >= 70)')
  })

  await t('每个问题包含正确的分数与阈值', async () => {
    const proposal = await proposeRepair(runId, 1)
    for (const issue of proposal.issues) {
      assert.ok(issue.score < 70, `issue ${issue.dimension} score=${issue.score} must be < 70`)
      assert.equal(issue.threshold, 70, 'threshold must be 70')
      assert.ok(typeof issue.suggestion === 'string' && issue.suggestion.length > 0, 'suggestion must be non-empty')
    }
  })

  await t('建议文本自解释（包含维度标识与操作指引）', async () => {
    const proposal = await proposeRepair(runId, 1)
    for (const issue of proposal.issues) {
      // 建议文本必须包含维度相关的关键词，让读者无需查阅外部文档即可理解
      assert.ok(issue.suggestion.length >= 20, `suggestion for ${issue.dimension} too short`)
      // 检查建议文本包含中文操作指引
      assert.ok(/建议|检查|审查|确保/.test(issue.suggestion), `suggestion for ${issue.dimension} must contain actionable guidance`)
    }
  })

  await t('影响范围结构完整', async () => {
    const proposal = await proposeRepair(runId, 1)
    const { impactScope } = proposal
    assert.ok(Array.isArray(impactScope.affectedRunIds), 'affectedRunIds must be an array')
    assert.ok(Array.isArray(impactScope.affectedEpisodes), 'affectedEpisodes must be an array')
    assert.ok(Array.isArray(impactScope.sharedSources), 'sharedSources must be an array')
    assert.ok(typeof impactScope.snapshotCount === 'number', 'snapshotCount must be a number')
    // 种子数据有 2 个 exec_snapshot
    assert.equal(impactScope.snapshotCount, 2, 'snapshotCount must match seed data (2 snapshots)')
  })

  await t('费用估算公式正确：影响集数 × 低分维度数 × 0.1', async () => {
    const proposal = await proposeRepair(runId, 1)
    const issueCount = proposal.issues.length
    const affectedEpisodeCount = Math.max(1, proposal.impactScope.affectedEpisodes.length)
    const expectedCost = affectedEpisodeCount * issueCount * 0.1
    assert.ok(
      Math.abs(proposal.estimatedCost - expectedCost) < 0.001,
      `estimatedCost=${proposal.estimatedCost} expected=${expectedCost}`,
    )
  })

  await t('评分快照包含四维分数', async () => {
    const proposal = await proposeRepair(runId, 1)
    const { scoreSnapshot } = proposal
    assert.ok(typeof scoreSnapshot.citationScore === 'number', 'citationScore must exist')
    assert.ok(typeof scoreSnapshot.consistencyScore === 'number', 'consistencyScore must exist')
    assert.ok(typeof scoreSnapshot.coherenceScore === 'number', 'coherenceScore must exist')
    assert.ok(typeof scoreSnapshot.costScore === 'number', 'costScore must exist')
    assert.ok(typeof scoreSnapshot.overallScore === 'number', 'overallScore must exist')
  })

  await t('评分快照与预期分数一致', async () => {
    const proposal = await proposeRepair(runId, 1)
    const { scoreSnapshot } = proposal
    assert.ok(Math.abs(scoreSnapshot.citationScore - EXPECTED.citationScore) < 0.01, 'citationScore mismatch')
    assert.ok(Math.abs(scoreSnapshot.consistencyScore - EXPECTED.consistencyScore) < 0.01, 'consistencyScore mismatch')
    assert.ok(Math.abs(scoreSnapshot.coherenceScore - EXPECTED.coherenceScore) < 0.01, 'coherenceScore mismatch')
    assert.ok(Math.abs(scoreSnapshot.costScore - EXPECTED.costScore) < 0.01, 'costScore mismatch')
  })
}
