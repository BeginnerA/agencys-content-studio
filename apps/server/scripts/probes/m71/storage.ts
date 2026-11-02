/**
 * 评分存储测试
 *
 * 验证 quality_scores 表结构与读写正确性：
 *   - 表结构包含所有必需列
 *   - 索引存在（run_id 单列索引 + run_id×episode_idx 唯一索引）
 *   - 外键约束（run_id → pipeline_runs.id）
 *   - JSON 字段（weights / metadata）可读回
 *   - UNIQUE 约束防止同 run+episode 重复记录
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase } from './bootstrap'
import { test } from './helpers'

export async function runStorage(checker: Checker) {
  const { sqlite } = await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  await t('quality_scores 表包含所有必需列', async () => {
    const columns = (await sqlite.execute("PRAGMA table_info('quality_scores')")).rows.map(r => r.name)
    for (const col of ['id', 'run_id', 'episode_idx', 'citation_score', 'consistency_score',
      'coherence_score', 'cost_score', 'overall_score', 'weights', 'metadata', 'created_at', 'updated_at']) {
      assert.ok(columns.includes(col), `missing column: ${col}`)
    }
  })

  await t('quality_scores 表有 run_id 索引和 run_id×episode_idx 唯一索引', async () => {
    const indexes = await sqlite.execute("PRAGMA index_list('quality_scores')")
    const names = indexes.rows.map(r => r.name)
    assert.ok(names.includes('idx_quality_scores_run'), 'missing idx_quality_scores_run')
    assert.ok(names.includes('idx_quality_scores_run_episode'), 'missing idx_quality_scores_run_episode')
  })

  await t('quality_scores 表有 pipeline_runs 外键约束', async () => {
    const fks = await sqlite.execute("PRAGMA foreign_key_list('quality_scores')")
    const fk = fks.rows.find(r => r.table === 'pipeline_runs')
    assert.ok(fk, 'foreign key to pipeline_runs must exist')
  })

  await t('weights 和 metadata 以 JSON 文本存储，可读回为对象', async () => {
    const { db } = await import('../../../src/db')
    const { qualityScores } = await import('../../../src/db/schema')
    const { scoreQuality } = await import('../../../src/services/eval-quality')
    const { pipelineRuns } = await import('../../../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const [seedRun] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
    await scoreQuality({ runId: seedRun!.id, episodeIdx: 1 })
    const [row] = await db.select().from(qualityScores).where(eq(qualityScores.runId, seedRun!.id)).limit(1)
    assert.ok(row, 'quality_scores row must exist after scoring')
    const weights = JSON.parse(row.weights)
    const metadata = JSON.parse(row.metadata)
    assert.ok(typeof weights === 'object' && weights.citation !== undefined, 'weights must be valid JSON object')
    assert.ok(typeof metadata === 'object' && metadata.templateVersion !== undefined, 'metadata must be valid JSON object')
  })

  await t('UNIQUE 约束阻止同 run+episode 重复插入（由服务层 upsert 处理）', async () => {
    // 验证 unique 索引确实存在即可——实际 upsert 行为在 service 节测试
    const idxInfo = await sqlite.execute("PRAGMA index_info('idx_quality_scores_run_episode')")
    const cols = idxInfo.rows.map(r => r.name)
    assert.deepEqual(cols.sort(), ['episode_idx', 'run_id'])
    // unique 标志
    const indexes = await sqlite.execute("PRAGMA index_list('quality_scores')")
    const uniqueIdx = indexes.rows.find(r => r.name === 'idx_quality_scores_run_episode')
    assert.equal(uniqueIdx!.unique, 1, 'idx_quality_scores_run_episode must be UNIQUE')
  })
}
