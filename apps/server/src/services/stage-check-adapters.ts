/**
 * Stage-check adapters: convert QC reports, delivery-cert reports, and
 * quality scores into the unified QualityIssueInput format consumed by the
 * stage-check orchestration pipeline.
 *
 * Each adapter is a pure mapping function (no DB writes) that translates
 * domain-specific check results into the shared issue shape.
 */

import type { QcReport, QcCheck } from './qc/types.js'
import type { DeliveryCert, CertCheck } from './delivery-cert/types.js'
import { scoreQuality } from './eval-quality.js'
import type { QualityIssueInput, Stage } from './stage-check.js'

// ─── QC check-key → stage mapping ────────────────────────────────────────────
// Dialogue-stage checks are timeline / duration / subtitle related;
// everything else maps to the final stage.

const DIALOGUE_QC_KEYS: ReadonlySet<string> = new Set([
  'duration_vs_timeline',
  'timeline_source',
  'shot_duration_applied',
  'subtitle_alignment_present',
  'rework_receipt_consistency',
])

function qcKeyToStage(key: string): Stage {
  return DIALOGUE_QC_KEYS.has(key) ? 'dialogue' : 'final'
}

// ─── QC statuses that produce issues ─────────────────────────────────────────

const QC_ISSUE_STATUSES: ReadonlySet<string> = new Set(['failed', 'stale', 'not_tested'])

// ─── adaptQcToIssues ─────────────────────────────────────────────────────────

/**
 * Convert a QcReport into QualityIssueInput records.
 * Only checks with a non-passing status (failed / stale / not_tested) are
 * emitted; passed and not_applicable checks are silently skipped.
 */
export function adaptQcToIssues(
  runId: number,
  episodeIdx: number,
  report: QcReport,
): QualityIssueInput[] {
  const issues: QualityIssueInput[] = []

  for (const check of report.checks) {
    if (!QC_ISSUE_STATUSES.has(check.status)) continue

    issues.push({
      runId,
      episodeIdx,
      stage: qcKeyToStage(check.key),
      checker: `qc.${check.key}`,
      dimension: 'technical',
      severity: check.status === 'failed' ? 'blocking' : 'warning',
      checkType: check.evidenceType === 'manual_review' ? 'subjective' : 'deterministic',
      targetType: 'asset',
      targetId: String(report.finalAssetId),
      evidence: {
        key: check.key,
        status: check.status,
        value: check.value ?? null,
        reason: check.reason ?? null,
      },
      suggestion: check.reason,
    })
  }

  return issues
}

// ─── Cert statuses that produce issues ───────────────────────────────────────

const CERT_ISSUE_STATUSES: ReadonlySet<string> = new Set(['failed', 'stale'])

// ─── adaptCertToIssues ───────────────────────────────────────────────────────

/**
 * Convert a DeliveryCert into QualityIssueInput records.
 * Only checks with failed or stale status are emitted.
 */
export function adaptCertToIssues(
  runId: number,
  episodeIdx: number,
  cert: DeliveryCert,
): QualityIssueInput[] {
  const issues: QualityIssueInput[] = []

  for (const check of cert.checks) {
    if (!CERT_ISSUE_STATUSES.has(check.status)) continue

    issues.push({
      runId,
      episodeIdx,
      stage: 'final',
      checker: `delivery.${check.key}`,
      dimension: 'delivery',
      severity: 'blocking',
      checkType: check.evidenceType === 'manual_review' ? 'subjective' : 'deterministic',
      targetType: 'asset',
      targetId: cert.packageAssetId ? String(cert.packageAssetId) : undefined,
      evidence: {
        key: check.key,
        status: check.status,
        value: check.value ?? null,
        reason: check.reason ?? null,
      },
      suggestion: check.reason,
    })
  }

  return issues
}

// ─── Score threshold ─────────────────────────────────────────────────────────

const SCORE_THRESHOLD = 0.7

// ─── adaptScoreToIssues ──────────────────────────────────────────────────────

/**
 * Call scoreQuality and convert any dimension below the threshold into a
 * QualityIssueInput record.
 */
export async function adaptScoreToIssues(
  runId: number,
  episodeIdx: number,
): Promise<QualityIssueInput[]> {
  const result = await scoreQuality({ runId, episodeIdx })
  const issues: QualityIssueInput[] = []

  if (result.citationScore < SCORE_THRESHOLD) {
    issues.push({
      runId,
      episodeIdx,
      stage: 'final',
      checker: 'quality.citation',
      dimension: 'citation',
      severity: 'warning',
      checkType: 'subjective',
      evidence: { score: result.citationScore, threshold: SCORE_THRESHOLD },
      suggestion: '引文完整度不足：部分执行输入缺少版本指针',
    })
  }

  if (result.consistencyScore < SCORE_THRESHOLD) {
    issues.push({
      runId,
      episodeIdx,
      stage: 'final',
      checker: 'quality.consistency',
      dimension: 'consistency',
      severity: 'warning',
      checkType: 'subjective',
      evidence: { score: result.consistencyScore, threshold: SCORE_THRESHOLD },
      suggestion: '角色一致性不足：引用的实体版本存在不稳定状态',
    })
  }

  if (result.coherenceScore < SCORE_THRESHOLD) {
    issues.push({
      runId,
      episodeIdx,
      stage: 'final',
      checker: 'quality.coherence',
      dimension: 'coherence',
      severity: 'warning',
      checkType: 'subjective',
      evidence: { score: result.coherenceScore, threshold: SCORE_THRESHOLD },
      suggestion: '剧情连贯度不足：连续性台账中上下文记录未充分确认',
    })
  }

  if (result.costScore < SCORE_THRESHOLD) {
    issues.push({
      runId,
      episodeIdx,
      stage: 'final',
      checker: 'quality.cost',
      dimension: 'cost',
      severity: 'info',
      checkType: 'deterministic',
      evidence: { score: result.costScore, threshold: SCORE_THRESHOLD },
      suggestion: '费用效率不足：部分用量记录缺少计价信息',
    })
  }

  return issues
}
