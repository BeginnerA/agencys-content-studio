/**
 * 修复存储测试
 *
 * 验证 repair_runs 表结构与读写正确性：
 *   - 表结构：13 列（id, source_run_id, episode_idx, status, issues, impact_scope,
 *     attempt_count, total_cost, score_before, score_after, stop_reason, created_at, updated_at）
 *   - 索引：2 个（idx_repair_runs_source, idx_repair_runs_status）
 *   - 外键：1 个（source_run_id → pipeline_runs.id）
 *   - JSON 字段：issues / impact_scope 以文本存储，可读回为对象
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase } from './bootstrap'
import { test } from './helpers'

export async function runStorage(checker: Checker) {
  const { sqlite } = await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  await t('repair_runs 表包含所有 13 列', async () => {
    const columns = (await sqlite.execute("PRAGMA table_info('repair_runs')")).rows.map(r => r.name)
    const expected = [
      'id', 'source_run_id', 'episode_idx', 'status', 'issues', 'impact_scope',
      'attempt_count', 'total_cost', 'score_before', 'score_after', 'stop_reason',
      'created_at', 'updated_at',
    ]
    assert.equal(columns.length, 13, `must have 13 columns, got ${columns.length}`)
    for (const col of expected) {
      assert.ok(columns.includes(col), `missing column: ${col}`)
    }
  })

  await t('repair_runs 表有 2 个命名索引（不含主键自动索引）', async () => {
    const indexes = await sqlite.execute("PRAGMA index_list('repair_runs')")
    const names = indexes.rows.map(r => r.name)
    assert.ok(names.includes('idx_repair_runs_source'), 'missing idx_repair_runs_source')
    assert.ok(names.includes('idx_repair_runs_status'), 'missing idx_repair_runs_status')
    // SQLite 自动为主键创建索引，因此总数 >= 2
    assert.ok(names.length >= 2, `must have at least 2 indexes, got ${names.length}`)
  })

  await t('repair_runs 表有 pipeline_runs 外键约束', async () => {
    const fks = await sqlite.execute("PRAGMA foreign_key_list('repair_runs')")
    const fk = fks.rows.find(r => r.table === 'pipeline_runs')
    assert.ok(fk, 'foreign key to pipeline_runs must exist')
    // 验证外键列
    assert.equal(fk.from, 'source_run_id', 'foreign key column must be source_run_id')
    assert.equal(fk.to, 'id', 'foreign key reference column must be id')
  })

  await t('issues 字段以 JSON 文本存储，可读回为数组', async () => {
    const { db } = await import('../../../src/db')
    const { repairRuns, pipelineRuns } = await import('../../../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { randomUUID } = await import('node:crypto')

    const [seedRun] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
    const repairId = randomUUID()
    const now = Date.now()
    const testIssues = [
      { dimension: 'citation', score: 60, threshold: 70, suggestion: '引文完整度不足' },
      { dimension: 'consistency', score: 0, threshold: 70, suggestion: '角色一致性不足' },
    ]

    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId: seedRun!.id,
      episodeIdx: 1,
      status: 'proposed',
      issues: JSON.stringify(testIssues),
      impactScope: JSON.stringify({ affectedRunIds: [], affectedEpisodes: [], sharedSources: [], snapshotCount: 0 }),
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const [row] = await db.select().from(repairRuns).where(eq(repairRuns.id, repairId)).limit(1)
    assert.ok(row, 'repair_runs row must exist after insert')
    const issues = JSON.parse(row!.issues)
    assert.ok(Array.isArray(issues), 'issues must be parsed as array')
    assert.equal(issues.length, 2, 'issues must have 2 items')
    assert.equal(issues[0].dimension, 'citation', 'first issue dimension must be citation')
  })

  await t('impact_scope 字段以 JSON 文本存储，可读回为对象', async () => {
    const { db } = await import('../../../src/db')
    const { repairRuns } = await import('../../../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { randomUUID } = await import('node:crypto')
    const { pipelineRuns } = await import('../../../src/db/schema')

    const [seedRun] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
    const repairId = randomUUID()
    const now = Date.now()
    const testImpact = {
      affectedRunIds: [1, 2, 3],
      affectedEpisodes: [1, 2],
      sharedSources: ['asset:100', 'asset:101'],
      snapshotCount: 5,
    }

    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId: seedRun!.id,
      episodeIdx: 1,
      status: 'proposed',
      issues: '[]',
      impactScope: JSON.stringify(testImpact),
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const [row] = await db.select().from(repairRuns).where(eq(repairRuns.id, repairId)).limit(1)
    assert.ok(row, 'repair_runs row must exist after insert')
    const impact = JSON.parse(row!.impactScope)
    assert.ok(typeof impact === 'object', 'impactScope must be parsed as object')
    assert.deepEqual(impact.affectedRunIds, [1, 2, 3], 'affectedRunIds must match')
    assert.deepEqual(impact.affectedEpisodes, [1, 2], 'affectedEpisodes must match')
    assert.equal(impact.snapshotCount, 5, 'snapshotCount must match')
  })

  await t('索引覆盖常用查询路径（source_run_id + status）', async () => {
    // 验证 idx_repair_runs_source 索引列
    const sourceIdx = await sqlite.execute("PRAGMA index_info('idx_repair_runs_source')")
    const sourceCols = sourceIdx.rows.map(r => r.name)
    assert.deepEqual(sourceCols, ['source_run_id'], 'idx_repair_runs_source must cover source_run_id')

    // 验证 idx_repair_runs_status 索引列
    const statusIdx = await sqlite.execute("PRAGMA index_info('idx_repair_runs_status')")
    const statusCols = statusIdx.rows.map(r => r.name)
    assert.deepEqual(statusCols, ['status'], 'idx_repair_runs_status must cover status')
  })

  await t('score_before / score_after 可为 NULL（初始状态无分数）', async () => {
    const { db } = await import('../../../src/db')
    const { repairRuns, pipelineRuns } = await import('../../../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { randomUUID } = await import('node:crypto')

    const [seedRun] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
    const repairId = randomUUID()
    const now = Date.now()

    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId: seedRun!.id,
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

    const [row] = await db.select().from(repairRuns).where(eq(repairRuns.id, repairId)).limit(1)
    assert.ok(row, 'row must exist')
    assert.equal(row!.scoreBefore, null, 'scoreBefore must be NULL initially')
    assert.equal(row!.scoreAfter, null, 'scoreAfter must be NULL initially')
  })
}
