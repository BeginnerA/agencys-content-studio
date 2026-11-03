/**
 * Gate evaluation tests — verify exemptIssue, unexemptIssue, and reevaluateGate.
 *
 * Tests cover:
 *   - reevaluateGate: status transitions (fail → exempt → pass)
 *   - exemptIssue: validation (non-blocking throws, already-exempted throws, non-existent throws)
 *   - unexemptIssue: validation (non-exempted throws)
 *   - Counting: blockingCount, warningCount, exemptCount accuracy
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase, getSeededRunId } from './bootstrap'
import { test } from './helpers'

export async function runGateEval(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  const { db } = await import('../../../src/db')
  const { qualityIssues, qualityGates, pipelineRuns } = await import('../../../src/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const { reevaluateGate, exemptIssue, unexemptIssue } = await import('../../../src/services/gate-eval')

  const runId = await getSeededRunId()
  const episodeIdx = 1
  const stage = 'outline' as const

  // Helper: insert a quality issue directly
  async function insertIssue(severity: string, exempted = 0): Promise<number> {
    const now = Date.now()
    const [row] = await db.insert(qualityIssues).values({
      runId,
      episodeIdx,
      stage,
      checker: 'test.checker',
      dimension: 'test.dimension',
      severity,
      checkType: 'deterministic',
      evidence: JSON.stringify({ test: true }),
      exempted,
      createdAt: now,
    }).returning()
    return row!.id
  }

  // Helper: clean up test issues and gates for this (run, episode, stage)
  async function cleanupStage() {
    await db.delete(qualityIssues).where(
      and(eq(qualityIssues.runId, runId), eq(qualityIssues.episodeIdx, episodeIdx), eq(qualityIssues.stage, stage)),
    )
    await db.delete(qualityGates).where(
      and(eq(qualityGates.runId, runId), eq(qualityGates.episodeIdx, episodeIdx), eq(qualityGates.stage, stage)),
    )
  }

  // ─── reevaluateGate: status derivation ─────────────────────────────────────

  await t('reevaluateGate: blocking issues → status=fail', async () => {
    await cleanupStage()
    await insertIssue('blocking')
    await insertIssue('blocking')
    await insertIssue('warning')

    const gate = await reevaluateGate(runId, episodeIdx, stage)
    assert.equal(gate.status, 'fail', 'status must be fail when unexempted blocking issues exist')
    assert.equal(gate.blockingCount, 2, 'blockingCount must be 2')
    assert.equal(gate.warningCount, 1, 'warningCount must be 1')
    assert.equal(gate.exemptCount, 0, 'exemptCount must be 0')

    await cleanupStage()
  })

  await t('reevaluateGate: all blocking issues exempted → status=exempt', async () => {
    await cleanupStage()
    const id1 = await insertIssue('blocking')
    const id2 = await insertIssue('blocking')

    // Exempt both
    await db.update(qualityIssues).set({ exempted: 1, exemptedBy: 'tester', exemptedAt: Date.now(), exemptReason: 'test' })
      .where(eq(qualityIssues.id, id1))
    await db.update(qualityIssues).set({ exempted: 1, exemptedBy: 'tester', exemptedAt: Date.now(), exemptReason: 'test' })
      .where(eq(qualityIssues.id, id2))

    const gate = await reevaluateGate(runId, episodeIdx, stage)
    assert.equal(gate.status, 'exempt', 'status must be exempt when all blocking issues are exempted')
    assert.equal(gate.blockingCount, 2, 'blockingCount still counts all blocking issues')
    assert.equal(gate.exemptCount, 2, 'exemptCount must be 2')

    await cleanupStage()
  })

  await t('reevaluateGate: no blocking issues → status=pass', async () => {
    await cleanupStage()
    await insertIssue('warning')
    await insertIssue('info')

    const gate = await reevaluateGate(runId, episodeIdx, stage)
    assert.equal(gate.status, 'pass', 'status must be pass when no blocking issues exist')
    assert.equal(gate.blockingCount, 0, 'blockingCount must be 0')
    assert.equal(gate.warningCount, 1, 'warningCount must be 1')

    await cleanupStage()
  })

  await t('reevaluateGate: upserts quality_gates row', async () => {
    await cleanupStage()
    await insertIssue('blocking')

    await reevaluateGate(runId, episodeIdx, stage)

    const [gateRow] = await db.select().from(qualityGates).where(
      and(eq(qualityGates.runId, runId), eq(qualityGates.episodeIdx, episodeIdx), eq(qualityGates.stage, stage)),
    )
    assert.ok(gateRow, 'quality_gates row must exist after reevaluateGate')
    assert.equal(gateRow.status, 'fail', 'gate status must be fail')
    assert.ok(typeof gateRow.checkedAt === 'number', 'checkedAt must be a timestamp')

    await cleanupStage()
  })

  // ─── exemptIssue: happy path ──────────────────────────────────────────────

  await t('exemptIssue: exempting a blocking issue changes gate to exempt/pass', async () => {
    await cleanupStage()
    const id = await insertIssue('blocking')

    // Before exemption: gate should be fail
    const before = await reevaluateGate(runId, episodeIdx, stage)
    assert.equal(before.status, 'fail', 'before exemption, gate must be fail')

    // Exempt the blocking issue
    const after = await exemptIssue(id, 'operator', 'acceptable risk')
    assert.equal(after.status, 'exempt', 'after exempting the only blocking issue, gate must be exempt')
    assert.equal(after.exemptCount, 1, 'exemptCount must be 1')

    await cleanupStage()
  })

  await t('exemptIssue: sets exemption metadata on the issue row', async () => {
    await cleanupStage()
    const id = await insertIssue('blocking')

    await exemptIssue(id, 'test_operator', 'test reason')

    const [issue] = await db.select().from(qualityIssues).where(eq(qualityIssues.id, id))
    assert.ok(issue, 'issue must exist after exempt')
    assert.equal(issue!.exempted, 1, 'exempted flag must be 1')
    assert.equal(issue!.exemptedBy, 'test_operator', 'exemptedBy must match operator')
    assert.equal(issue!.exemptReason, 'test reason', 'exemptReason must match reason')
    assert.ok(typeof issue!.exemptedAt === 'number' && issue!.exemptedAt > 0, 'exemptedAt must be a timestamp')

    await cleanupStage()
  })

  // ─── exemptIssue: validation errors ───────────────────────────────────────

  await t('exemptIssue: non-blocking issue throws', async () => {
    await cleanupStage()
    const id = await insertIssue('warning')

    await assert.rejects(
      () => exemptIssue(id, 'operator', 'test'),
      /not blocking/,
      'exempting a warning issue must throw',
    )

    await cleanupStage()
  })

  await t('exemptIssue: already-exempted issue throws', async () => {
    await cleanupStage()
    const id = await insertIssue('blocking')
    await exemptIssue(id, 'operator', 'first exemption')

    await assert.rejects(
      () => exemptIssue(id, 'operator', 'second exemption'),
      /already exempted/,
      'double exemption must throw',
    )

    await cleanupStage()
  })

  await t('exemptIssue: non-existent issue throws', async () => {
    await assert.rejects(
      () => exemptIssue(999999, 'operator', 'test'),
      /not found/,
      'non-existent issue must throw',
    )
  })

  // ─── unexemptIssue: happy path ────────────────────────────────────────────

  await t('unexemptIssue: revoking exemption restores fail status', async () => {
    await cleanupStage()
    const id = await insertIssue('blocking')

    // Exempt then unexempt
    await exemptIssue(id, 'operator', 'test')
    const after = await unexemptIssue(id)
    assert.equal(after.status, 'fail', 'after unexempt, gate must be fail again')
    assert.equal(after.exemptCount, 0, 'exemptCount must be 0 after unexempt')

    await cleanupStage()
  })

  // ─── unexemptIssue: validation errors ─────────────────────────────────────

  await t('unexemptIssue: non-exempted issue throws', async () => {
    await cleanupStage()
    const id = await insertIssue('blocking')

    await assert.rejects(
      () => unexemptIssue(id),
      /not currently exempted/,
      'unexempting a non-exempted issue must throw',
    )

    await cleanupStage()
  })

  await t('unexemptIssue: non-existent issue throws', async () => {
    await assert.rejects(
      () => unexemptIssue(999999),
      /not found/,
      'non-existent issue must throw',
    )
  })

  // ─── Mixed exemption scenarios ────────────────────────────────────────────

  await t('reevaluateGate: partial exemption → still fail', async () => {
    await cleanupStage()
    const id1 = await insertIssue('blocking')
    await insertIssue('blocking') // id2 — not exempted

    await exemptIssue(id1, 'operator', 'one of two')

    const gate = await reevaluateGate(runId, episodeIdx, stage)
    assert.equal(gate.status, 'fail', 'partial exemption must still be fail (1 unexempted blocking remains)')
    assert.equal(gate.blockingCount, 2, 'blockingCount must count all blocking issues')
    assert.equal(gate.exemptCount, 1, 'exemptCount must count only exempted ones')

    await cleanupStage()
  })
}
