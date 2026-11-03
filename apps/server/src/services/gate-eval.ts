/**
 * Gate evaluation service — manages exemptions for quality issues and
 * re-evaluates stage gate status.
 *
 * A gate summarises whether all blocking issues for a given (run, episode, stage)
 * tuple have been resolved or exempted.  Operators can exempt individual blocking
 * issues (with a reason) and revoke those exemptions; every mutation triggers a
 * full re-evaluation so the gate row always reflects current state.
 */

import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { qualityGates, qualityIssues, type QualityIssue } from '../db/schema.js'
import type { GateStatus, Stage } from './stage-check.js'

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Exempt a blocking quality issue so it no longer fails the gate.
 *
 * Validates that the issue exists, has blocking severity, and has not already
 * been exempted.  After updating the issue row the parent gate is re-evaluated
 * and the fresh GateStatus is returned.
 */
export async function exemptIssue(
  issueId: number,
  operator: string,
  reason: string,
): Promise<GateStatus> {
  const issue = await lookupIssue(issueId)

  if (issue.severity !== 'blocking') {
    throw new Error(`Issue ${issueId} is not blocking (severity=${issue.severity}); only blocking issues can be exempted`)
  }

  if (issue.exempted === 1) {
    throw new Error(`Issue ${issueId} is already exempted`)
  }

  await db
    .update(qualityIssues)
    .set({
      exempted: 1,
      exemptedBy: operator,
      exemptedAt: Date.now(),
      exemptReason: reason,
    })
    .where(eq(qualityIssues.id, issueId))

  return reevaluateGate(issue.runId, issue.episodeIdx, issue.stage as Stage)
}

/**
 * Revoke a previously granted exemption, restoring the issue's blocking effect
 * on the gate.  Validates that the issue exists and is currently exempted.
 */
export async function unexemptIssue(issueId: number): Promise<GateStatus> {
  const issue = await lookupIssue(issueId)

  if (issue.exempted !== 1) {
    throw new Error(`Issue ${issueId} is not currently exempted; nothing to revoke`)
  }

  await db
    .update(qualityIssues)
    .set({
      exempted: 0,
      exemptedBy: null,
      exemptedAt: null,
      exemptReason: null,
    })
    .where(eq(qualityIssues.id, issueId))

  return reevaluateGate(issue.runId, issue.episodeIdx, issue.stage as Stage)
}

/**
 * Recompute the gate status for a single (run, episode, stage) triple.
 *
 * Counts blocking / warning / exempted issues, derives the aggregate status,
 * and upserts the quality_gates row so it is always in sync with the underlying
 * issues.  Returns the new GateStatus.
 */
export async function reevaluateGate(
  runId: number,
  episodeIdx: number,
  stage: Stage,
): Promise<GateStatus> {
  const rows = await db
    .select()
    .from(qualityIssues)
    .where(
      and(
        eq(qualityIssues.runId, runId),
        eq(qualityIssues.episodeIdx, episodeIdx),
        eq(qualityIssues.stage, stage),
      ),
    )

  const blockingIssues = rows.filter((r) => r.severity === 'blocking')
  const unexemptedBlocking = blockingIssues.filter((r) => r.exempted !== 1)
  const exemptedBlocking = blockingIssues.filter((r) => r.exempted === 1)
  const warnings = rows.filter((r) => r.severity === 'warning')

  const status: GateStatus['status'] =
    unexemptedBlocking.length > 0
      ? 'fail'
      : exemptedBlocking.length > 0
        ? 'exempt'
        : 'pass'

  const gateRow = {
    runId,
    episodeIdx,
    stage,
    status,
    blockingCount: blockingIssues.length,
    warningCount: warnings.length,
    exemptCount: exemptedBlocking.length,
    checkedAt: Date.now(),
  }

  await db
    .insert(qualityGates)
    .values(gateRow)
    .onConflictDoUpdate({
      target: [qualityGates.runId, qualityGates.episodeIdx, qualityGates.stage],
      set: {
        status: gateRow.status,
        blockingCount: gateRow.blockingCount,
        warningCount: gateRow.warningCount,
        exemptCount: gateRow.exemptCount,
        checkedAt: gateRow.checkedAt,
      },
    })

  return gateRow
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Fetch a single quality issue by primary key, throwing if it does not exist. */
async function lookupIssue(issueId: number): Promise<QualityIssue> {
  const matches = await db
    .select()
    .from(qualityIssues)
    .where(eq(qualityIssues.id, issueId))
    .limit(1)

  const issue = matches[0]
  if (!issue) {
    throw new Error(`Quality issue ${issueId} not found`)
  }

  return issue
}
