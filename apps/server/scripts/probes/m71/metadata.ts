/**
 * 可复现性元数据测试
 *
 * 验证 scoreQuality 返回的 metadata 记录完整：
 *   - templateVersion：从 run.templateSnapshot 解析
 *   - promptVersion：从 run.templateSnapshot 解析
 *   - model：从 run.templateSnapshot 解析
 *   - params：从 run.templateSnapshot 解析
 *   - assetVersions：exec_inputs 中 src_kind='asset' 且 version_id IS NOT NULL 的映射
 *   - 元数据已持久化到 quality_scores.metadata
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase } from './bootstrap'
import { test } from './helpers'

export async function runMetadata(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { pipelineRuns, qualityScores } = await import('../../../src/db/schema')
  const { scoreQuality } = await import('../../../src/services/eval-quality')
  const { eq } = await import('drizzle-orm')

  const [seedRun] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
  const runId = seedRun!.id

  await t('metadata 包含 templateVersion（从 templateSnapshot 解析）', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    assert.equal(result.metadata.templateVersion, 'tpl-v3')
  })

  await t('metadata 包含 promptVersion（从 templateSnapshot 解析）', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    assert.equal(result.metadata.promptVersion, 'prompt-v7')
  })

  await t('metadata 包含 model（从 templateSnapshot 解析）', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    assert.equal(result.metadata.model, 'test-model-7b')
  })

  await t('metadata 包含 params（从 templateSnapshot 解析）', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    assert.deepEqual(result.metadata.params, { temperature: 0.7, maxTokens: 2048 })
  })

  await t('metadata 包含 assetVersions（exec_inputs 中 asset 类有版本指针的映射）', async () => {
    const result = await scoreQuality({ runId, episodeIdx: 1 })
    // 种子数据有 2 条 asset exec_input 带 versionId（srcId=100→v1, srcId=101→v2）
    assert.ok(typeof result.metadata.assetVersions === 'object', 'assetVersions must be an object')
    const keys = Object.keys(result.metadata.assetVersions)
    assert.ok(keys.length >= 2, `assetVersions should have ≥2 entries, got ${keys.length}`)
    // 键格式 'asset:<srcId>'，值格式 'v<versionId>'
    for (const [k, v] of Object.entries(result.metadata.assetVersions)) {
      assert.ok(k.startsWith('asset:'), `key ${k} must start with 'asset:'`)
      assert.ok((v as string).startsWith('v'), `value ${v} must start with 'v'`)
    }
  })

  await t('元数据已持久化到 quality_scores.metadata 列', async () => {
    await scoreQuality({ runId, episodeIdx: 1 })
    const [row] = await db.select().from(qualityScores).where(eq(qualityScores.runId, runId)).limit(1)
    assert.ok(row, 'quality_scores row must exist')
    const parsed = JSON.parse(row!.metadata)
    assert.equal(parsed.templateVersion, 'tpl-v3')
    assert.equal(parsed.promptVersion, 'prompt-v7')
    assert.equal(parsed.model, 'test-model-7b')
    assert.deepEqual(parsed.params, { temperature: 0.7, maxTokens: 2048 })
    assert.ok(typeof parsed.assetVersions === 'object')
  })

  await t('templateSnapshot 为 null 时元数据以空值兜底（不抛异常）', async () => {
    // 创建一条 templateSnapshot=null 的 run
    const [project] = await db.select({ id: pipelineRuns.projectId }).from(pipelineRuns).limit(1)
    const [newRun] = await db.insert(pipelineRuns).values({
      projectId: project!.id,
      templateKey: 'bare-run',
      templateSnapshot: null,
      input: '{}',
      status: 'completed',
      createdAt: 1, updatedAt: 1,
    }).returning()
    const result = await scoreQuality({ runId: newRun!.id, episodeIdx: 1 })
    assert.equal(result.metadata.templateVersion, '')
    assert.equal(result.metadata.promptVersion, '')
    assert.equal(result.metadata.model, '')
    assert.deepEqual(result.metadata.params, {})
  })
}
