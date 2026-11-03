/**
 * Stage-check: multi-stage quality check orchestration service.
 *
 * Runs deterministic quality checks at five pipeline stages (outline → episode →
 * scene → dialogue → final). Each stage has one or more checkers that inspect
 * database state and produce quality issues. Issues are persisted to the
 * quality_issues table, and a gate summary is upserted into quality_gates.
 *
 * Checkers that depend on external services (QC, delivery-cert, quality-scoring)
 * are connected through adapter functions in stage-check-adapters.ts.
 */

import { and, count, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  characterConsistencyResults,
  characters,
  contentContinuityRecords,
  contentVersions,
  execSnapshots,
  pipelineRuns,
  qualityGates,
  qualityIssues,
  reviewFindings,
} from '../db/schema.js'

// ─── Shared type definitions ────────────────────────────────────────────────
// These types are imported by the adapter layer and the gate
// evaluation service that together complete the quality-check pipeline.

export type Stage = 'outline' | 'episode' | 'scene' | 'dialogue' | 'final'
export type Severity = 'blocking' | 'warning' | 'info'
export type CheckType = 'deterministic' | 'subjective'

/** Input shape for writing a single quality issue row. */
export interface QualityIssueInput {
  runId: number
  episodeIdx: number
  stage: Stage
  checker: string
  dimension: string
  severity: Severity
  checkType: CheckType
  targetType?: string
  targetId?: string
  evidence: Record<string, unknown>
  suggestion?: string
}

/** Snapshot of a single stage gate after evaluation. */
export interface GateStatus {
  runId: number
  episodeIdx: number
  stage: Stage
  status: 'pending' | 'pass' | 'fail' | 'exempt'
  blockingCount: number
  warningCount: number
  exemptCount: number
  checkedAt?: number
}

/** Internal contract that every stage checker must satisfy. */
interface StageChecker {
  stage: Stage
  name: string
  dimension: string
  severity: Severity
  checkType: CheckType
  check: (runId: number, episodeIdx: number) => Promise<QualityIssueInput[]>
}

// ─── Deterministic checkers ─────────────────────────────────────────────────
// These read database state directly and need no external adapter.

/**
 * Outline → content.completeness
 *
 * Verifies that the project backing this run has at least one content version
 * record. When no versions exist the outline has not produced any durable
 * content, so the checker emits a blocking issue.
 */
async function checkContentCompleteness(
  runId: number,
  episodeIdx: number,
): Promise<QualityIssueInput[]> {
  // Resolve the project that owns this run
  const [run] = await db
    .select({ projectId: pipelineRuns.projectId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1)

  if (!run) {
    return [{
      runId,
      episodeIdx,
      stage: 'outline',
      checker: 'content.completeness',
      dimension: 'content.completeness',
      severity: 'blocking',
      checkType: 'deterministic',
      evidence: { reason: 'run_not_found', runId },
      suggestion: 'Verify the run exists before checking outline completeness.',
    }]
  }

  const [row] = await db
    .select({ n: count() })
    .from(contentVersions)
    .where(eq(contentVersions.projectId, run.projectId))

  if ((row?.n ?? 0) === 0) {
    return [{
      runId,
      episodeIdx,
      stage: 'outline',
      checker: 'content.completeness',
      dimension: 'content.completeness',
      severity: 'blocking',
      checkType: 'deterministic',
      evidence: { projectId: run.projectId, versionCount: 0 },
      suggestion: 'Generate outline content before advancing to the episode stage.',
    }]
  }

  return []
}

/**
 * Episode → continuity.confirmed
 *
 * Looks at entry-type continuity records for this run and episode. If fewer
 * than 80 % of them carry the 'confirmed' status, a blocking issue is raised
 * because downstream stages depend on a stable continuity baseline.
 */
async function checkContinuityConfirmed(
  runId: number,
  episodeIdx: number,
): Promise<QualityIssueInput[]> {
  const baseWhere = and(
    eq(contentContinuityRecords.runId, runId),
    eq(contentContinuityRecords.rowType, 'entry'),
    eq(contentContinuityRecords.unitId, episodeIdx),
  )

  const [totalRow] = await db
    .select({ n: count() })
    .from(contentContinuityRecords)
    .where(baseWhere)

  const totalEntries = totalRow?.n ?? 0

  // No entry records at all → nothing to confirm; skip silently
  if (totalEntries === 0) return []

  const [confirmedRow] = await db
    .select({ n: count() })
    .from(contentContinuityRecords)
    .where(and(baseWhere, eq(contentContinuityRecords.status, 'confirmed')))

  const confirmedCount = confirmedRow?.n ?? 0
  const rate = confirmedCount / totalEntries

  if (rate < 0.8) {
    return [{
      runId,
      episodeIdx,
      stage: 'episode',
      checker: 'continuity.confirmed',
      dimension: 'continuity.confirmed',
      severity: 'blocking',
      checkType: 'deterministic',
      evidence: {
        totalEntries,
        confirmedCount,
        confirmationRate: Math.round(rate * 1000) / 10,
        threshold: 80,
      },
      suggestion: `Confirm remaining continuity entries (currently ${Math.round(rate * 100)}%, need ≥ 80%).`,
    }]
  }

  return []
}

/**
 * Scene → snapshot.coverage
 *
 * Ensures at least one execution snapshot exists for this run. Snapshots
 * freeze the exact inputs of every generation step, so their absence means
 * downstream reproducibility checks have nothing to anchor on.
 */
async function checkSnapshotCoverage(
  runId: number,
  episodeIdx: number,
): Promise<QualityIssueInput[]> {
  const [row] = await db
    .select({ n: count() })
    .from(execSnapshots)
    .where(eq(execSnapshots.runId, runId))

  if ((row?.n ?? 0) === 0) {
    return [{
      runId,
      episodeIdx,
      stage: 'scene',
      checker: 'snapshot.coverage',
      dimension: 'snapshot.coverage',
      severity: 'warning',
      checkType: 'deterministic',
      evidence: { snapshotCount: 0 },
      suggestion: 'Run at least one generation step to produce execution snapshots.',
    }]
  }

  return []
}

// ─── Adapter-backed checkers ─────────────────────────────────────────────────
// The following checkers delegate to external services through adapter functions
// that translate domain-specific reports into the unified QualityIssueInput shape.

/**
 * Dialogue → qc.subtitle_alignment
 *
 * Delegates to the QC adapter to verify subtitle timing alignment.
 * Only subtitle-related issues from the QC report are returned.
 */
async function checkQcSubtitleAlignment(
  runId: number,
  episodeIdx: number,
): Promise<QualityIssueInput[]> {
  const { runQcCheck } = await import('./qc/report.js')
  const result = await runQcCheck(runId)
  if (result.outcome !== 'ok') return []
  const { adaptQcToIssues } = await import('./stage-check-adapters.js')
  return adaptQcToIssues(runId, episodeIdx, result.report).filter(i => i.checker.startsWith('qc.subtitle'))
}

/**
 * Dialogue → review.findings
 *
 * Checks the review_findings table for unresolved issues. Findings whose
 * status is neither 'verified' nor 'dismissed' are considered open and
 * produce a warning-level issue.
 */
async function checkReviewFindings(
  runId: number,
  episodeIdx: number,
): Promise<QualityIssueInput[]> {
  const unresolved = await db
    .select({ id: reviewFindings.id, category: reviewFindings.category, severity: reviewFindings.severity })
    .from(reviewFindings)
    .where(
      and(
        eq(reviewFindings.runId, runId),
        sql`${reviewFindings.status} NOT IN ('verified', 'dismissed')`,
      ),
    )

  if (unresolved.length > 0) {
    return [{
      runId,
      episodeIdx,
      stage: 'dialogue',
      checker: 'review.findings',
      dimension: 'review.findings',
      severity: 'warning',
      checkType: 'deterministic',
      evidence: {
        unresolvedCount: unresolved.length,
        findings: unresolved.map((f) => ({
          id: f.id,
          category: f.category,
          severity: f.severity,
        })),
      },
      suggestion: 'Address or dismiss open review findings before advancing.',
    }]
  }

  return []
}

/**
 * Final → qc.verdict
 *
 * Delegates to the QC adapter for the overall quality-control verdict.
 * When QC cannot run (no final video or run not found), emits a single
 * blocking issue explaining why the verdict is unavailable.
 */
async function checkQcVerdict(
  runId: number,
  episodeIdx: number,
): Promise<QualityIssueInput[]> {
  const { runQcCheck } = await import('./qc/report.js')
  const result = await runQcCheck(runId)
  if (result.outcome !== 'ok') {
    return [{
      runId,
      episodeIdx,
      stage: 'final',
      checker: 'qc.verdict',
      dimension: 'technical',
      severity: 'blocking',
      checkType: 'deterministic',
      evidence: { reason: result.outcome === 'blocked' ? result.message : 'no_final_video' },
      suggestion: result.outcome === 'blocked' ? result.message : '无成片文件可核验',
    }]
  }
  const { adaptQcToIssues } = await import('./stage-check-adapters.js')
  return adaptQcToIssues(runId, episodeIdx, result.report)
}

/**
 * Final → delivery.cert
 *
 * Delegates to the delivery-certification adapter to verify that the
 * episode meets delivery requirements (format, bitrate, codecs, etc.).
 * When no delivery package exists, returns an empty array (the absence
 * of a package is not itself a blocking issue at this stage).
 */
async function checkDeliveryCert(
  runId: number,
  episodeIdx: number,
): Promise<QualityIssueInput[]> {
  const { runDeliveryCert } = await import('./delivery-cert/certify.js')
  const result = await runDeliveryCert(runId)
  if (result.outcome !== 'ok') return []
  const { adaptCertToIssues } = await import('./stage-check-adapters.js')
  return adaptCertToIssues(runId, episodeIdx, result.cert)
}

/**
 * Final → quality.score
 *
 * Delegates to the quality-scoring adapter to check that each dimension
 * of the quality score meets the minimum threshold (0.7).
 */
async function checkQualityScore(
  runId: number,
  episodeIdx: number,
): Promise<QualityIssueInput[]> {
  const { adaptScoreToIssues } = await import('./stage-check-adapters.js')
  return adaptScoreToIssues(runId, episodeIdx)
}

/**
 * Final → character.consistency
 *
 * Reads persisted per-character consistency results (written by the
 * consistency-eval service; this checker never calls a model). Absence of
 * any evaluation is reported as an info issue — a result that was never
 * measured must not read as a pass.
 *
 * Per-entity mapping (score is a 0–10 mean, normalized by /10):
 *   null   → info  (unevaluable; persisted note carried into evidence)
 *   < 0.5  → blocking
 *   < 0.7  → warning
 *   ≥ 0.7  → no issue
 */
async function checkCharacterConsistency(
  runId: number,
  episodeIdx: number,
): Promise<QualityIssueInput[]> {
  const rows = await db
    .select({
      entityId: characterConsistencyResults.entityId,
      entityName: characters.name,
      score: characterConsistencyResults.score,
      assetTotal: characterConsistencyResults.assetTotal,
      assetSampled: characterConsistencyResults.assetSampled,
      note: characterConsistencyResults.note,
    })
    .from(characterConsistencyResults)
    .leftJoin(characters, eq(characterConsistencyResults.entityId, characters.id))
    .where(eq(characterConsistencyResults.runId, runId))
    .orderBy(characterConsistencyResults.entityId)

  if (rows.length === 0) {
    return [{
      runId,
      episodeIdx,
      stage: 'final',
      checker: 'character.consistency',
      dimension: 'consistency',
      severity: 'info',
      checkType: 'deterministic',
      evidence: { reason: 'not_evaluated' },
      suggestion: '角色一致性评价未运行，结果待人工确认；可在运行详情发起评价后复检。',
    }]
  }

  const issues: QualityIssueInput[] = []
  for (const r of rows) {
    const entityName = r.entityName ?? `实体${r.entityId}`
    const base = {
      runId,
      episodeIdx,
      stage: 'final' as const,
      checker: 'character.consistency',
      dimension: 'consistency',
      checkType: 'subjective' as const,
      targetType: 'entity',
      targetId: String(r.entityId),
    }
    if (r.score === null) {
      issues.push({
        ...base,
        severity: 'info',
        evidence: { entityId: r.entityId, entityName, note: r.note },
        suggestion: `角色「${entityName}」无法评价（${r.note ?? '原因未记录'}），补参考图或重试评价后复检。`,
      })
      continue
    }
    const norm = Math.round((r.score / 10) * 100) / 100
    if (norm < 0.5) {
      issues.push({
        ...base,
        severity: 'blocking',
        evidence: { entityId: r.entityId, entityName, score: r.score, normalized: norm, assetTotal: r.assetTotal, assetSampled: r.assetSampled },
        suggestion: `角色「${entityName}」跨镜一致性 ${r.score}/10（低于 5），建议核对分层参考绑定并重生成偏离镜头。`,
      })
    } else if (norm < 0.7) {
      issues.push({
        ...base,
        severity: 'warning',
        evidence: { entityId: r.entityId, entityName, score: r.score, normalized: norm, assetTotal: r.assetTotal, assetSampled: r.assetSampled },
        suggestion: `角色「${entityName}」跨镜一致性 ${r.score}/10（低于 7），建议人工抽查离群镜头。`,
      })
    }
  }
  return issues
}

// ─── Checker registry ───────────────────────────────────────────────────────
// Ordered by stage progression. Multiple checkers can target the same stage;
// they all run when that stage is evaluated.

const CHECKERS: StageChecker[] = [
  {
    stage: 'outline',
    name: 'content.completeness',
    dimension: 'content.completeness',
    severity: 'blocking',
    checkType: 'deterministic',
    check: checkContentCompleteness,
  },
  {
    stage: 'episode',
    name: 'continuity.confirmed',
    dimension: 'continuity.confirmed',
    severity: 'blocking',
    checkType: 'deterministic',
    check: checkContinuityConfirmed,
  },
  {
    stage: 'scene',
    name: 'snapshot.coverage',
    dimension: 'snapshot.coverage',
    severity: 'warning',
    checkType: 'deterministic',
    check: checkSnapshotCoverage,
  },
  {
    stage: 'dialogue',
    name: 'qc.subtitle_alignment',
    dimension: 'qc.subtitle_alignment',
    severity: 'blocking',
    checkType: 'subjective',
    check: checkQcSubtitleAlignment,
  },
  {
    stage: 'dialogue',
    name: 'review.findings',
    dimension: 'review.findings',
    severity: 'warning',
    checkType: 'deterministic',
    check: checkReviewFindings,
  },
  {
    stage: 'final',
    name: 'qc.verdict',
    dimension: 'qc.verdict',
    severity: 'blocking',
    checkType: 'subjective',
    check: checkQcVerdict,
  },
  {
    stage: 'final',
    name: 'delivery.cert',
    dimension: 'delivery.cert',
    severity: 'blocking',
    checkType: 'subjective',
    check: checkDeliveryCert,
  },
  {
    stage: 'final',
    name: 'quality.score',
    dimension: 'quality.score',
    severity: 'warning',
    checkType: 'subjective',
    check: checkQualityScore,
  },
  {
    // Registered severity describes the checker family; per-issue severity is
    // derived dynamically from each persisted score (info / warning / blocking).
    stage: 'final',
    name: 'character.consistency',
    dimension: 'consistency',
    severity: 'warning',
    checkType: 'subjective',
    check: checkCharacterConsistency,
  },
]

// ─── Orchestration functions ────────────────────────────────────────────────

/** Stage order used for sequential iteration. */
const STAGE_ORDER: Stage[] = ['outline', 'episode', 'scene', 'dialogue', 'final']

/**
 * Run all five stages sequentially for a given run and episode.
 * Returns the gate status for every stage.
 */
export async function runAllStages(
  runId: number,
  episodeIdx: number,
): Promise<GateStatus[]> {
  const results: GateStatus[] = []
  for (const stage of STAGE_ORDER) {
    const gate = await runStage(runId, episodeIdx, stage)
    results.push(gate)
  }
  return results
}

/**
 * Run every checker registered for a single stage, persist the resulting
 * issues, and upsert the gate summary.
 *
 * Steps:
 *  1. Execute each checker's `check` function and collect issues.
 *  2. Delete any previously recorded issues for this (run, episode, stage).
 *  3. Insert the freshly produced issues into quality_issues.
 *  4. Count blocking / warning issues and derive the gate status.
 *  5. Upsert the gate row into quality_gates (unique on run + episode + stage).
 */
export async function runStage(
  runId: number,
  episodeIdx: number,
  stage: Stage,
): Promise<GateStatus> {
  const stageCheckers = CHECKERS.filter((c) => c.stage === stage)

  // 1. Collect issues from every checker
  const allIssues: QualityIssueInput[] = []
  for (const checker of stageCheckers) {
    const issues = await checker.check(runId, episodeIdx)
    allIssues.push(...issues)
  }

  // 2. Clear previous issues for this stage so we don't accumulate duplicates
  await db
    .delete(qualityIssues)
    .where(
      and(
        eq(qualityIssues.runId, runId),
        eq(qualityIssues.episodeIdx, episodeIdx),
        eq(qualityIssues.stage, stage),
      ),
    )

  // 3. Persist new issues
  const now = Date.now()
  for (const issue of allIssues) {
    await db.insert(qualityIssues).values({
      runId: issue.runId,
      episodeIdx: issue.episodeIdx,
      stage: issue.stage,
      checker: issue.checker,
      dimension: issue.dimension,
      severity: issue.severity,
      checkType: issue.checkType,
      targetType: issue.targetType ?? null,
      targetId: issue.targetId ?? null,
      evidence: JSON.stringify(issue.evidence),
      suggestion: issue.suggestion ?? null,
      createdAt: now,
    })
  }

  // 4. Evaluate gate status from the persisted issues
  const blockingCount = allIssues.filter((i) => i.severity === 'blocking').length
  const warningCount = allIssues.filter((i) => i.severity === 'warning').length
  // Exempt counting is handled by the gate-eval service when人工豁免 is applied;
  // at check time no issues are exempt yet.
  const exemptCount = 0

  const gateStatus: GateStatus['status'] = blockingCount > 0 ? 'fail' : 'pass'

  // 5. Upsert gate row — one row per (runId, episodeIdx, stage)
  await db.insert(qualityGates).values({
    runId,
    episodeIdx,
    stage,
    status: gateStatus,
    blockingCount,
    warningCount,
    exemptCount,
    checkedAt: now,
  }).onConflictDoUpdate({
    target: [qualityGates.runId, qualityGates.episodeIdx, qualityGates.stage],
    set: {
      status: gateStatus,
      blockingCount,
      warningCount,
      exemptCount,
      checkedAt: now,
    },
  })

  return {
    runId,
    episodeIdx,
    stage,
    status: gateStatus,
    blockingCount,
    warningCount,
    exemptCount,
    checkedAt: now,
  }
}
