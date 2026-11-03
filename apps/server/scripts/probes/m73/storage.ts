/**
 * Storage tests — verify quality_issues and quality_gates table schemas,
 * indexes, constraints, and data integrity through insert/update/delete cycles.
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase, getSeededRunId } from './bootstrap'
import { test } from './helpers'

export async function runStorage(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  const { sqlite } = await initDatabase()
  const { db } = await import('../../../src/db')
  const { qualityIssues, qualityGates, pipelineRuns } = await import('../../../src/db/schema')
  const { eq, and } = await import('drizzle-orm')

  const runId = await getSeededRunId()

  // ─── quality_issues table schema ──────────────────────────────────────────

  await t('quality_issues table has all 17 columns', async () => {
    const columns = (await sqlite.execute("PRAGMA table_info('quality_issues')")).rows.map((r: any) => r.name)
    const expected = [
      'id', 'run_id', 'episode_idx', 'stage', 'checker', 'dimension',
      'severity', 'check_type', 'target_type', 'target_id', 'evidence',
      'suggestion', 'exempted', 'exempted_by', 'exempted_at', 'exempt_reason',
      'created_at',
    ]
    assert.equal(columns.length, 17, `must have 17 columns, got ${columns.length}: ${columns.join(', ')}`)
    for (const col of expected) {
      assert.ok(columns.includes(col), `missing column: ${col}`)
    }
  })

  await t('quality_issues table has 3 named indexes', async () => {
    const indexes = await sqlite.execute("PRAGMA index_list('quality_issues')")
    const names = indexes.rows.map((r: any) => r.name)
    assert.ok(names.includes('idx_quality_issues_run'), 'missing idx_quality_issues_run')
    assert.ok(names.includes('idx_quality_issues_stage'), 'missing idx_quality_issues_stage')
    assert.ok(names.includes('idx_quality_issues_severity'), 'missing idx_quality_issues_severity')
  })

  await t('quality_issues has pipeline_runs foreign key', async () => {
    const fks = await sqlite.execute("PRAGMA foreign_key_list('quality_issues')")
    const fk = fks.rows.find((r: any) => r.table === 'pipeline_runs')
    assert.ok(fk, 'foreign key to pipeline_runs must exist')
    assert.equal(fk.from, 'run_id', 'foreign key column must be run_id')
    assert.equal(fk.to, 'id', 'foreign key reference column must be id')
  })

  await t('idx_quality_issues_run covers run_id', async () => {
    const info = await sqlite.execute("PRAGMA index_info('idx_quality_issues_run')")
    const cols = info.rows.map((r: any) => r.name)
    assert.deepEqual(cols, ['run_id'], 'index must cover run_id')
  })

  await t('idx_quality_issues_stage covers (run_id, stage)', async () => {
    const info = await sqlite.execute("PRAGMA index_info('idx_quality_issues_stage')")
    const cols = info.rows.map((r: any) => r.name)
    assert.deepEqual(cols, ['run_id', 'stage'], 'index must cover run_id + stage')
  })

  // ─── quality_gates table schema ───────────────────────────────────────────

  await t('quality_gates table has all 9 columns', async () => {
    const columns = (await sqlite.execute("PRAGMA table_info('quality_gates')")).rows.map((r: any) => r.name)
    const expected = [
      'id', 'run_id', 'episode_idx', 'stage', 'status',
      'blocking_count', 'warning_count', 'exempt_count', 'checked_at',
    ]
    assert.equal(columns.length, 9, `must have 9 columns, got ${columns.length}: ${columns.join(', ')}`)
    for (const col of expected) {
      assert.ok(columns.includes(col), `missing column: ${col}`)
    }
  })

  await t('quality_gates table has unique constraint on (run_id, episode_idx, stage)', async () => {
    const indexes = await sqlite.execute("PRAGMA index_list('quality_gates')")
    const uniqueIdx = indexes.rows.find((r: any) => r.name === 'idx_quality_gates_unique')
    assert.ok(uniqueIdx, 'unique index idx_quality_gates_unique must exist')
    assert.equal(uniqueIdx.unique, 1, 'idx_quality_gates_unique must be unique')

    const info = await sqlite.execute("PRAGMA index_info('idx_quality_gates_unique')")
    const cols = info.rows.map((r: any) => r.name)
    assert.deepEqual(cols, ['run_id', 'episode_idx', 'stage'], 'unique index must cover (run_id, episode_idx, stage)')
  })

  await t('quality_gates has pipeline_runs foreign key', async () => {
    const fks = await sqlite.execute("PRAGMA foreign_key_list('quality_gates')")
    const fk = fks.rows.find((r: any) => r.table === 'pipeline_runs')
    assert.ok(fk, 'foreign key to pipeline_runs must exist')
    assert.equal(fk.from, 'run_id', 'foreign key column must be run_id')
  })

  // ─── Data integrity: insert / update / delete cycles ──────────────────────

  await t('quality_issues: insert and read back with JSON evidence', async () => {
    const now = Date.now()
    const evidence = { key: 'test', value: 42, nested: { ok: true } }

    const [inserted] = await db.insert(qualityIssues).values({
      runId,
      episodeIdx: 1,
      stage: 'outline',
      checker: 'test.integrity',
      dimension: 'test',
      severity: 'info',
      checkType: 'deterministic',
      evidence: JSON.stringify(evidence),
      createdAt: now,
    }).returning()

    assert.ok(inserted, 'inserted row must be returned')
    assert.ok(inserted.id > 0, 'id must be auto-generated')

    // Read back and verify JSON round-trip
    const [row] = await db.select().from(qualityIssues).where(eq(qualityIssues.id, inserted.id))
    assert.ok(row, 'row must exist after insert')
    const parsed = JSON.parse(row!.evidence)
    assert.deepEqual(parsed, evidence, 'evidence JSON must round-trip correctly')
    assert.equal(row!.exempted, 0, 'exempted default must be 0')
    assert.equal(row!.exemptedBy, null, 'exemptedBy default must be null')

    // Clean up
    await db.delete(qualityIssues).where(eq(qualityIssues.id, inserted.id))
  })

  await t('quality_issues: update exemption fields', async () => {
    const now = Date.now()
    const [inserted] = await db.insert(qualityIssues).values({
      runId, episodeIdx: 1, stage: 'outline',
      checker: 'test.exempt', dimension: 'test',
      severity: 'blocking', checkType: 'deterministic',
      evidence: '{}', createdAt: now,
    }).returning()

    assert.ok(inserted, 'insert must return a row')
    const insertedId = inserted!.id

    // Update exemption fields
    await db.update(qualityIssues).set({
      exempted: 1,
      exemptedBy: 'tester',
      exemptedAt: now + 1000,
      exemptReason: 'acceptable risk',
    }).where(eq(qualityIssues.id, insertedId))

    const [row] = await db.select().from(qualityIssues).where(eq(qualityIssues.id, insertedId))
    assert.ok(row, 'row must exist after update')
    assert.equal(row!.exempted, 1, 'exempted must be 1 after update')
    assert.equal(row!.exemptedBy, 'tester', 'exemptedBy must match')
    assert.equal(row!.exemptReason, 'acceptable risk', 'exemptReason must match')

    // Clean up
    await db.delete(qualityIssues).where(eq(qualityIssues.id, insertedId))
  })

  await t('quality_gates: upsert on conflict (unique constraint)', async () => {
    const now = Date.now()

    // First insert
    await db.insert(qualityGates).values({
      runId, episodeIdx: 0, stage: 'outline',
      status: 'pending', blockingCount: 0, warningCount: 0,
      exemptCount: 0, checkedAt: now,
    })

    // Upsert with updated values
    await db.insert(qualityGates).values({
      runId, episodeIdx: 0, stage: 'outline',
      status: 'pass', blockingCount: 0, warningCount: 2,
      exemptCount: 0, checkedAt: now + 1000,
    }).onConflictDoUpdate({
      target: [qualityGates.runId, qualityGates.episodeIdx, qualityGates.stage],
      set: {
        status: 'pass',
        warningCount: 2,
        checkedAt: now + 1000,
      },
    })

    // Verify only one row exists with updated values
    const rows = await db.select().from(qualityGates).where(
      and(eq(qualityGates.runId, runId), eq(qualityGates.episodeIdx, 0), eq(qualityGates.stage, 'outline')),
    )
    assert.equal(rows.length, 1, 'upsert must not create duplicate rows')
    const upserted = rows[0]!
    assert.equal(upserted.status, 'pass', 'status must be updated')
    assert.equal(upserted.warningCount, 2, 'warningCount must be updated')

    // Clean up
    await db.delete(qualityGates).where(
      and(eq(qualityGates.runId, runId), eq(qualityGates.episodeIdx, 0), eq(qualityGates.stage, 'outline')),
    )
  })

  await t('quality_issues: delete removes row completely', async () => {
    const now = Date.now()
    const [inserted] = await db.insert(qualityIssues).values({
      runId, episodeIdx: 0, stage: 'scene',
      checker: 'test.delete', dimension: 'test',
      severity: 'info', checkType: 'deterministic',
      evidence: '{}', createdAt: now,
    }).returning()

    assert.ok(inserted, 'insert must return a row')
    const insertedId = inserted!.id

    // Verify exists
    const [before] = await db.select().from(qualityIssues).where(eq(qualityIssues.id, insertedId))
    assert.ok(before, 'row must exist before delete')

    // Delete
    await db.delete(qualityIssues).where(eq(qualityIssues.id, insertedId))

    // Verify gone
    const after = await db.select().from(qualityIssues).where(eq(qualityIssues.id, insertedId))
    assert.equal(after.length, 0, 'row must not exist after delete')
  })
}
