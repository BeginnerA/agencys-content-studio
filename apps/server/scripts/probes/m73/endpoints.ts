/**
 * Endpoint contract tests — verify the 5 REST endpoints for quality gates.
 *
 * Tests cover:
 *   - POST /runs/:id/quality-gates: trigger all-stage check (valid/invalid body)
 *   - GET /runs/:id/quality-gates: query all gates for a run
 *   - GET /runs/:id/quality-gates/:stage: query single stage gate + issues
 *   - POST /quality-gates/issues/:id/exempt: exempt a blocking issue
 *   - POST /quality-gates/issues/:id/unexempt: cancel an exemption
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase, getSeededRunId } from './bootstrap'
import { test } from './helpers'

/** Parse response body as JSON (typed accessor for Hono Response). */
async function json(res: Response): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return res.json()
}

export async function runEndpoints(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  const { db } = await import('../../../src/db')
  const { qualityGates, qualityIssues, pipelineRuns } = await import('../../../src/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const { qualityGatesRoutes } = await import('../../../src/routes/quality-gates')
  const { Hono } = await import('hono')

  // Build test Hono app with quality gates routes mounted at root
  const app = new Hono()
  app.route('/', qualityGatesRoutes)

  const runId = await getSeededRunId()

  // Helper: clean up all issues and gates for this run
  async function cleanupRun() {
    await db.delete(qualityIssues).where(eq(qualityIssues.runId, runId))
    await db.delete(qualityGates).where(eq(qualityGates.runId, runId))
  }

  // ─── POST /runs/:id/quality-gates ─────────────────────────────────────────

  await t('POST /runs/:id/quality-gates: valid request returns 201 with gates array', async () => {
    await cleanupRun()
    const res = await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 0 }),
    })
    assert.equal(res.status, 201, `status must be 201, got ${res.status}`)
    const data = await json(res)
    assert.ok(Array.isArray(data.gates), 'response must contain gates array')
    assert.equal(data.gates.length, 5, `must have 5 gates (one per stage), got ${data.gates.length}`)
    await cleanupRun()
  })

  await t('POST /runs/:id/quality-gates: each gate has correct shape', async () => {
    await cleanupRun()
    const res = await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 0 }),
    })
    const data = await json(res)
    for (const gate of data.gates) {
      assert.equal(gate.runId, runId, 'gate.runId must match')
      assert.equal(gate.episodeIdx, 0, 'gate.episodeIdx must match')
      assert.ok(typeof gate.stage === 'string', 'gate.stage must be a string')
      assert.ok(['pass', 'fail', 'exempt', 'pending'].includes(gate.status), `gate.status=${gate.status} must be valid`)
      assert.ok(typeof gate.blockingCount === 'number', 'gate.blockingCount must be a number')
      assert.ok(typeof gate.warningCount === 'number', 'gate.warningCount must be a number')
    }
    await cleanupRun()
  })

  await t('POST /runs/:id/quality-gates: bad JSON body → 400', async () => {
    const res = await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
    const data = await json(res)
    assert.equal(data.error.code, 'bad_json', 'error code must be bad_json')
  })

  await t('POST /runs/:id/quality-gates: missing episodeIdx → 400', async () => {
    const res = await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
    const data = await json(res)
    assert.equal(data.error.code, 'bad_episode_idx', 'error code must be bad_episode_idx')
  })

  await t('POST /runs/:id/quality-gates: negative episodeIdx → 400', async () => {
    const res = await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: -1 }),
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
  })

  await t('POST /runs/:id/quality-gates: non-integer episodeIdx → 400', async () => {
    const res = await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 1.5 }),
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
  })

  // ─── GET /runs/:id/quality-gates ──────────────────────────────────────────

  await t('GET /runs/:id/quality-gates: returns gates after trigger', async () => {
    await cleanupRun()
    // First trigger to create gates
    await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 0 }),
    })

    // Then query
    const res = await app.request(`/runs/${runId}/quality-gates?episodeIdx=0`)
    assert.equal(res.status, 200, `status must be 200, got ${res.status}`)
    const data = await json(res)
    assert.ok(Array.isArray(data.gates), 'response must contain gates array')
    // Unconditional count: the trigger above writes exactly one gate per stage, so a missing
    // gate (a dropped stage) must fail here rather than pass on "any gate present".
    assert.equal(data.gates.length, 5, `trigger creates one gate per stage (5), got ${data.gates.length}`)
    assert.deepEqual(
      [...data.gates].map((g: { stage: string }) => g.stage).sort(),
      ['dialogue', 'episode', 'final', 'outline', 'scene'],
      'all five stages carry a gate row',
    )
    await cleanupRun()
  })

  await t('GET /runs/:id/quality-gates: defaults episodeIdx to 0 when omitted', async () => {
    await cleanupRun()
    // Create gates for episode 0
    await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 0 }),
    })

    // Query without episodeIdx param
    const res = await app.request(`/runs/${runId}/quality-gates`)
    assert.equal(res.status, 200, `status must be 200, got ${res.status}`)
    const data = await json(res)
    assert.ok(Array.isArray(data.gates), 'response must contain gates array')
    await cleanupRun()
  })

  // ─── GET /runs/:id/quality-gates/:stage ───────────────────────────────────

  await t('GET /runs/:id/quality-gates/:stage: returns gate + issues for valid stage', async () => {
    await cleanupRun()
    // Trigger first
    await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 0 }),
    })

    const res = await app.request(`/runs/${runId}/quality-gates/outline?episodeIdx=0`)
    assert.equal(res.status, 200, `status must be 200, got ${res.status}`)
    const data = await json(res)
    assert.ok(data.gate, 'response must contain gate object')
    assert.equal(data.gate.stage, 'outline', 'gate.stage must be outline')
    assert.ok(Array.isArray(data.issues), 'response must contain issues array')
    await cleanupRun()
  })

  await t('GET /runs/:id/quality-gates/:stage: invalid stage → 400', async () => {
    const res = await app.request(`/runs/${runId}/quality-gates/invalid_stage`)
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
    const data = await json(res)
    assert.equal(data.error.code, 'bad_stage', 'error code must be bad_stage')
  })

  await t('GET /runs/:id/quality-gates/:stage: non-existent gate → 404', async () => {
    await cleanupRun()
    const res = await app.request(`/runs/${runId}/quality-gates/scene?episodeIdx=0`)
    assert.equal(res.status, 404, `status must be 404, got ${res.status}`)
    const data = await json(res)
    assert.equal(data.error.code, 'not_found', 'error code must be not_found')
    await cleanupRun()
  })

  await t('GET /runs/:id/quality-gates/:stage: issues have parsed evidence JSON', async () => {
    await cleanupRun()
    // Trigger to create issues
    await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 0 }),
    })

    // The seeded open review finding makes the dialogue stage emit a review.findings issue every run,
    // so this assertion is unconditional: an empty dialogue issue set is a regression, not a pass.
    const res = await app.request(`/runs/${runId}/quality-gates/dialogue?episodeIdx=0`)
    assert.equal(res.status, 200, `status must be 200, got ${res.status}`)
    const data = await json(res)
    assert.ok(Array.isArray(data.issues), 'response must contain issues array')
    assert.ok(data.issues.length > 0, 'dialogue stage must carry the seeded review.findings issue')
    for (const issue of data.issues) {
      // Evidence must be parsed from its stored JSON string into an object by the endpoint
      assert.equal(typeof issue.evidence, 'object', `evidence must be parsed to an object, got ${typeof issue.evidence}`)
      assert.notEqual(issue.evidence, null, 'parsed evidence must not be null')
    }
    // The review.findings issue in particular carries the findings array in its evidence
    const reviewIssue = data.issues.find((i: { checker: string }) => i.checker === 'review.findings')
    assert.ok(reviewIssue, 'dialogue stage must expose the review.findings checker issue')
    assert.ok(Array.isArray(reviewIssue.evidence.findings), 'review.findings evidence carries the findings list')
    await cleanupRun()
  })

  // ─── POST /quality-gates/issues/:id/exempt ────────────────────────────────

  await t('POST /quality-gates/issues/:id/exempt: valid exemption returns gate', async () => {
    await cleanupRun()
    // Trigger to create issues
    await app.request(`/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 0 }),
    })

    // The final stage always emits a blocking qc.verdict issue when the run has no final video,
    // which is the isolated-env case — so a blocking issue to exempt is guaranteed, never skipped.
    const blockingIssues = await db.select().from(qualityIssues).where(
      and(eq(qualityIssues.runId, runId), eq(qualityIssues.severity, 'blocking'), eq(qualityIssues.exempted, 0)),
    )
    assert.ok(blockingIssues.length > 0, 'fixture must produce a blocking issue to exempt (final-stage qc.verdict)')

    const issueId = blockingIssues[0]!.id
    const res = await app.request(`/quality-gates/issues/${issueId}/exempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'acceptable for testing' }),
    })
    assert.equal(res.status, 200, `status must be 200, got ${res.status}`)
    const data = await json(res)
    assert.ok(data.gate, 'response must contain gate object')

    // The exempted issue flips its flag and, once it was the only blocking issue in its stage,
    // the re-evaluated gate reads exempt — proving the write actually reached the source of truth.
    const [row] = await db.select().from(qualityIssues).where(eq(qualityIssues.id, issueId)).limit(1)
    assert.equal(row!.exempted, 1, 'issue row must record the exemption')
    assert.equal(row!.exemptReason, 'acceptable for testing', 'exemption reason persisted verbatim')
    const [gateRow] = await db.select().from(qualityGates).where(
      and(eq(qualityGates.runId, runId), eq(qualityGates.episodeIdx, 0), eq(qualityGates.stage, row!.stage)),
    ).limit(1)
    assert.ok(gateRow, 're-evaluated gate row must exist for the stage')
    assert.equal(gateRow!.status, 'exempt', `stage gate becomes exempt once its blocking issue is waived, got ${gateRow!.status}`)
    await cleanupRun()
  })

  await t('POST /quality-gates/issues/:id/exempt: bad id → 400', async () => {
    const res = await app.request('/quality-gates/issues/abc/exempt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
  })

  await t('POST /quality-gates/issues/:id/exempt: missing reason → 400', async () => {
    const res = await app.request('/quality-gates/issues/1/exempt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
    const data = await json(res)
    assert.equal(data.error.code, 'bad_reason', 'error code must be bad_reason')
  })

  await t('POST /quality-gates/issues/:id/exempt: empty reason → 400', async () => {
    const res = await app.request('/quality-gates/issues/1/exempt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '   ' }),
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
  })

  await t('POST /quality-gates/issues/:id/exempt: bad JSON → 400', async () => {
    const res = await app.request('/quality-gates/issues/1/exempt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
  })

  // ─── POST /quality-gates/issues/:id/unexempt ──────────────────────────────

  await t('POST /quality-gates/issues/:id/unexempt: bad id → 400', async () => {
    const res = await app.request('/quality-gates/issues/abc/unexempt', {
      method: 'POST',
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
  })

  await t('POST /quality-gates/issues/:id/unexempt: non-existent issue → 400', async () => {
    const res = await app.request('/quality-gates/issues/999999/unexempt', {
      method: 'POST',
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
    const data = await json(res)
    assert.ok(data.error, 'error object must exist')
  })

  await t('POST /quality-gates/issues/:id/unexempt: non-exempted issue → 400', async () => {
    await cleanupRun()
    // Create a blocking issue
    const now = Date.now()
    const [inserted] = await db.insert(qualityIssues).values({
      runId, episodeIdx: 0, stage: 'outline',
      checker: 'test.endpoint', dimension: 'test',
      severity: 'blocking', checkType: 'deterministic',
      evidence: '{}', createdAt: now,
    }).returning()

    const res = await app.request(`/quality-gates/issues/${inserted!.id}/unexempt`, {
      method: 'POST',
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
    await cleanupRun()
  })
}
