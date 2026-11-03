/**
 * Stage check integration tests — verify runStage and runAllStages orchestration.
 *
 * Tests cover:
 *   - runStage for each of the 5 stages (outline, episode, scene, dialogue, final)
 *   - Quality issues are persisted correctly
 *   - Quality gates are upserted correctly
 *   - runAllStages returns 5 GateStatus entries
 *   - Gate status derivation from persisted issues
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase, getSeededRunId } from './bootstrap'
import { test } from './helpers'

export async function runService(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  const { db } = await import('../../../src/db')
  const { qualityIssues, qualityGates } = await import('../../../src/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const { runStage, runAllStages } = await import('../../../src/services/stage-check')
  type Stage = 'outline' | 'episode' | 'scene' | 'dialogue' | 'final'

  const runId = await getSeededRunId()
  const episodeIdx = 1

  // Helper: clean up all issues and gates for this run/episode
  async function cleanupRun() {
    await db.delete(qualityIssues).where(
      and(eq(qualityIssues.runId, runId), eq(qualityIssues.episodeIdx, episodeIdx)),
    )
    await db.delete(qualityGates).where(
      and(eq(qualityGates.runId, runId), eq(qualityGates.episodeIdx, episodeIdx)),
    )
  }

  // ─── runStage: outline ────────────────────────────────────────────────────

  await t('runStage(outline): returns GateStatus with correct shape', async () => {
    await cleanupRun()
    const gate = await runStage(runId, episodeIdx, 'outline')

    assert.equal(gate.runId, runId, 'runId must match')
    assert.equal(gate.episodeIdx, episodeIdx, 'episodeIdx must match')
    assert.equal(gate.stage, 'outline', 'stage must be outline')
    assert.ok(['pass', 'fail', 'exempt', 'pending'].includes(gate.status), 'status must be valid')
    assert.ok(typeof gate.blockingCount === 'number', 'blockingCount must be a number')
    assert.ok(typeof gate.warningCount === 'number', 'warningCount must be a number')
    assert.ok(typeof gate.exemptCount === 'number', 'exemptCount must be a number')
    assert.ok(typeof gate.checkedAt === 'number', 'checkedAt must be a timestamp')

    await cleanupRun()
  })

  await t('runStage(outline): seed data has content versions → pass', async () => {
    await cleanupRun()
    const gate = await runStage(runId, episodeIdx, 'outline')

    // Seed data includes 2 content versions → content.completeness check passes
    assert.equal(gate.status, 'pass', 'outline should pass when content versions exist')
    assert.equal(gate.blockingCount, 0, 'no blocking issues expected')

    await cleanupRun()
  })

  await t('runStage(outline): persists gate row in quality_gates', async () => {
    await cleanupRun()
    await runStage(runId, episodeIdx, 'outline')

    const [row] = await db.select().from(qualityGates).where(
      and(eq(qualityGates.runId, runId), eq(qualityGates.episodeIdx, episodeIdx), eq(qualityGates.stage, 'outline')),
    )
    assert.ok(row, 'quality_gates row must exist after runStage')
    assert.equal(row.stage, 'outline', 'gate stage must be outline')

    await cleanupRun()
  })

  // ─── runStage: episode ────────────────────────────────────────────────────

  await t('runStage(episode): seed data has 80% confirmed entries → pass', async () => {
    await cleanupRun()
    const gate = await runStage(runId, episodeIdx, 'episode')

    // Seed data: 10 entries, 8 confirmed = 80% → passes threshold
    assert.equal(gate.status, 'pass', 'episode should pass with 80% confirmation rate')
    assert.equal(gate.blockingCount, 0, 'no blocking issues expected')

    await cleanupRun()
  })

  // ─── runStage: scene ──────────────────────────────────────────────────────

  await t('runStage(scene): seed data has exec snapshots → pass', async () => {
    await cleanupRun()
    const gate = await runStage(runId, episodeIdx, 'scene')

    // Seed data: 2 exec snapshots → snapshot.coverage passes
    assert.equal(gate.status, 'pass', 'scene should pass when snapshots exist')
    assert.equal(gate.blockingCount, 0, 'no blocking issues expected')

    await cleanupRun()
  })

  // ─── runStage: dialogue ───────────────────────────────────────────────────

  await t('runStage(dialogue): returns GateStatus (may have review findings)', async () => {
    await cleanupRun()
    const gate = await runStage(runId, episodeIdx, 'dialogue')

    assert.equal(gate.runId, runId, 'runId must match')
    assert.equal(gate.stage, 'dialogue', 'stage must be dialogue')
    assert.ok(['pass', 'fail'].includes(gate.status), 'dialogue status must be pass or fail')
    // Seed data has 1 unresolved review finding → warning issue → status still pass (no blocking)
    assert.equal(gate.status, 'pass', 'dialogue should pass (review findings are warnings, not blocking)')

    await cleanupRun()
  })

  await t('runStage(dialogue): review findings produce warning issues', async () => {
    await cleanupRun()
    await runStage(runId, episodeIdx, 'dialogue')

    const issues = await db.select().from(qualityIssues).where(
      and(eq(qualityIssues.runId, runId), eq(qualityIssues.episodeIdx, episodeIdx), eq(qualityIssues.stage, 'dialogue')),
    )
    // Should have at least the review.findings warning
    const reviewIssues = issues.filter(i => i.checker === 'review.findings')
    assert.ok(reviewIssues.length >= 1, 'should have at least 1 review.findings issue')
    assert.equal(reviewIssues[0]!.severity, 'warning', 'review findings issue must be warning severity')

    await cleanupRun()
  })

  // ─── runStage: final ──────────────────────────────────────────────────────

  await t('runStage(final): returns GateStatus with valid shape', async () => {
    await cleanupRun()
    const gate = await runStage(runId, episodeIdx, 'final')

    assert.equal(gate.runId, runId, 'runId must match')
    assert.equal(gate.stage, 'final', 'stage must be final')
    assert.ok(['pass', 'fail'].includes(gate.status), 'final status must be pass or fail')
    assert.ok(typeof gate.checkedAt === 'number', 'checkedAt must be set')

    await cleanupRun()
  })

  // ─── runAllStages ─────────────────────────────────────────────────────────

  await t('runAllStages: returns 5 GateStatus entries (one per stage)', async () => {
    await cleanupRun()
    const gates = await runAllStages(runId, episodeIdx)

    assert.equal(gates.length, 5, `expected 5 gates, got ${gates.length}`)
    const stages = gates.map(g => g.stage)
    assert.ok(stages.includes('outline'), 'must include outline')
    assert.ok(stages.includes('episode'), 'must include episode')
    assert.ok(stages.includes('scene'), 'must include scene')
    assert.ok(stages.includes('dialogue'), 'must include dialogue')
    assert.ok(stages.includes('final'), 'must include final')

    await cleanupRun()
  })

  await t('runAllStages: all entries have consistent runId and episodeIdx', async () => {
    await cleanupRun()
    const gates = await runAllStages(runId, episodeIdx)

    for (const gate of gates) {
      assert.equal(gate.runId, runId, 'all gates must reference the same runId')
      assert.equal(gate.episodeIdx, episodeIdx, 'all gates must reference the same episodeIdx')
    }

    await cleanupRun()
  })

  await t('runAllStages: creates quality_gates rows for all 5 stages', async () => {
    await cleanupRun()
    await runAllStages(runId, episodeIdx)

    const gateRows = await db.select().from(qualityGates).where(
      and(eq(qualityGates.runId, runId), eq(qualityGates.episodeIdx, episodeIdx)),
    )
    assert.equal(gateRows.length, 5, `expected 5 gate rows, got ${gateRows.length}`)
    const stages = gateRows.map(r => r.stage)
    assert.ok(stages.includes('outline'), 'must have outline gate')
    assert.ok(stages.includes('episode'), 'must have episode gate')
    assert.ok(stages.includes('scene'), 'must have scene gate')
    assert.ok(stages.includes('dialogue'), 'must have dialogue gate')
    assert.ok(stages.includes('final'), 'must have final gate')

    await cleanupRun()
  })

  // ─── Idempotency: re-running a stage replaces previous issues ─────────────

  await t('runStage: re-running replaces previous issues (no duplicates)', async () => {
    await cleanupRun()

    // Run twice
    await runStage(runId, episodeIdx, 'outline')
    await runStage(runId, episodeIdx, 'outline')

    const issues = await db.select().from(qualityIssues).where(
      and(eq(qualityIssues.runId, runId), eq(qualityIssues.episodeIdx, episodeIdx), eq(qualityIssues.stage, 'outline')),
    )
    // Outline stage with seed data should produce 0 issues (content versions exist)
    assert.equal(issues.length, 0, 're-running should not create duplicate issues')

    // Gate row should still exist (upserted)
    const [gate] = await db.select().from(qualityGates).where(
      and(eq(qualityGates.runId, runId), eq(qualityGates.episodeIdx, episodeIdx), eq(qualityGates.stage, 'outline')),
    )
    assert.ok(gate, 'gate row must still exist after re-run')

    await cleanupRun()
  })
}
