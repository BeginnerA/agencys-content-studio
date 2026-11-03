/**
 * Adapter tests — verify that QC reports, delivery certs, and score results
 * are correctly converted into the unified QualityIssueInput format.
 *
 * Tests cover:
 *   - adaptQcToIssues: status filtering, stage mapping, severity mapping, checkType mapping
 *   - adaptCertToIssues: status filtering, fixed stage='final' and dimension='delivery'
 *   - adaptScoreToIssues: importability and function signature verification
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { test } from './helpers'
import type { QcReport, QcCheck } from '../../../src/services/qc/types'
import type { DeliveryCert, CertCheck } from '../../../src/services/delivery-cert/types'

export async function runAdapters(checker: Checker) {
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  const { adaptQcToIssues } = await import('../../../src/services/stage-check-adapters')
  const { adaptCertToIssues } = await import('../../../src/services/stage-check-adapters')
  const { adaptScoreToIssues } = await import('../../../src/services/stage-check-adapters')

  // ─── adaptQcToIssues ─────────────────────────────────────────────────────

  await t('adaptQcToIssues: only failed/stale/not_tested checks produce issues', () => {
    const report: QcReport = {
      runId: 1,
      finalAssetId: 100,
      checkedAt: Date.now(),
      mediaSha256: 'abc123',
      verdict: 'needs_review',
      missing: ['subtitle_alignment_present'],
      checks: [
        mkQcCheck('file_readable', 'passed', 'metadata', 'ffprobe'),
        mkQcCheck('stream_spec', 'failed', 'metadata', 'ffprobe', 'bad stream'),
        mkQcCheck('duration_vs_timeline', 'stale', 'local_measurement', 'params.timeline', 'stale duration'),
        mkQcCheck('subtitle_alignment_present', 'not_tested', 'offline_probe', '_compose'),
        mkQcCheck('audio_peak', 'not_applicable', 'metadata', 'ffprobe'),
      ],
    }

    const issues = adaptQcToIssues(1, 0, report)
    // passed and not_applicable → skipped; failed/stale/not_tested → issues
    assert.equal(issues.length, 3, `expected 3 issues, got ${issues.length}`)
    assert.ok(issues.every(i => i.runId === 1), 'all issues must reference runId=1')
    assert.ok(issues.every(i => i.episodeIdx === 0), 'all issues must reference episodeIdx=0')
  })

  await t('adaptQcToIssues: QC keys map to correct stages', () => {
    const report: QcReport = {
      runId: 1, finalAssetId: 100, checkedAt: 1, mediaSha256: null,
      verdict: 'not_ready', missing: [],
      checks: [
        // Dialogue-stage keys (from DIALOGUE_QC_KEYS set)
        mkQcCheck('subtitle_alignment_present', 'failed', 'metadata', 'ffprobe', 'misaligned'),
        mkQcCheck('duration_vs_timeline', 'failed', 'metadata', 'ffprobe', 'duration mismatch'),
        mkQcCheck('timeline_source', 'failed', 'metadata', 'params.timeline', 'no timeline'),
        mkQcCheck('shot_duration_applied', 'failed', 'metadata', 'ffprobe', 'not applied'),
        mkQcCheck('rework_receipt_consistency', 'failed', 'metadata', 'rework_ledger', 'inconsistent'),
        // Final-stage key
        mkQcCheck('file_readable', 'failed', 'metadata', 'ffprobe', 'unreadable'),
      ],
    }

    const issues = adaptQcToIssues(1, 0, report)
    const dialogueIssues = issues.filter(i => i.stage === 'dialogue')
    const finalIssues = issues.filter(i => i.stage === 'final')
    assert.equal(dialogueIssues.length, 5, `expected 5 dialogue issues, got ${dialogueIssues.length}`)
    assert.equal(finalIssues.length, 1, `expected 1 final issue, got ${finalIssues.length}`)
  })

  await t('adaptQcToIssues: severity mapping (failed → blocking, stale/not_tested → warning)', () => {
    const report: QcReport = {
      runId: 1, finalAssetId: 100, checkedAt: 1, mediaSha256: null,
      verdict: 'not_ready', missing: [],
      checks: [
        mkQcCheck('file_readable', 'failed', 'metadata', 'ffprobe', 'broken'),
        mkQcCheck('stream_spec', 'stale', 'metadata', 'ffprobe', 'outdated'),
        mkQcCheck('audio_peak', 'not_tested', 'metadata', 'ffprobe'),
      ],
    }

    const issues = adaptQcToIssues(1, 0, report)
    const failed = issues.find(i => i.checker === 'qc.file_readable')
    const stale = issues.find(i => i.checker === 'qc.stream_spec')
    const notTested = issues.find(i => i.checker === 'qc.audio_peak')
    assert.equal(failed?.severity, 'blocking', 'failed → blocking')
    assert.equal(stale?.severity, 'warning', 'stale → warning')
    assert.equal(notTested?.severity, 'warning', 'not_tested → warning')
  })

  await t('adaptQcToIssues: checkType mapping (manual_review → subjective, else → deterministic)', () => {
    const report: QcReport = {
      runId: 1, finalAssetId: 100, checkedAt: 1, mediaSha256: null,
      verdict: 'needs_review', missing: [],
      checks: [
        mkQcCheck('manual_quality_review', 'failed', 'manual_review', 'manual', 'poor quality'),
        mkQcCheck('file_readable', 'failed', 'metadata', 'ffprobe', 'broken'),
      ],
    }

    const issues = adaptQcToIssues(1, 0, report)
    const subjective = issues.find(i => i.checker === 'qc.manual_quality_review')
    const deterministic = issues.find(i => i.checker === 'qc.file_readable')
    assert.equal(subjective?.checkType, 'subjective', 'manual_review → subjective')
    assert.equal(deterministic?.checkType, 'deterministic', 'metadata → deterministic')
  })

  await t('adaptQcToIssues: evidence contains key, status, value, reason', () => {
    const report: QcReport = {
      runId: 1, finalAssetId: 42, checkedAt: 1, mediaSha256: null,
      verdict: 'not_ready', missing: ['file_readable'],
      checks: [
        mkQcCheck('file_readable', 'failed', 'metadata', 'ffprobe', 'file corrupt', 0),
      ],
    }

    const issues = adaptQcToIssues(1, 0, report)
    assert.equal(issues.length, 1)
    const ev = issues[0]!.evidence as Record<string, unknown>
    assert.equal(ev.key, 'file_readable', 'evidence.key must match check key')
    assert.equal(ev.status, 'failed', 'evidence.status must match check status')
    assert.equal(ev.value, 0, 'evidence.value must match check value')
    assert.equal(ev.reason, 'file corrupt', 'evidence.reason must match check reason')
    assert.equal(issues[0]!.targetId, '42', 'targetId must be finalAssetId as string')
    assert.equal(issues[0]!.dimension, 'technical', 'dimension must be technical')
  })

  // ─── adaptCertToIssues ───────────────────────────────────────────────────

  await t('adaptCertToIssues: only failed/stale checks produce issues', () => {
    const cert: DeliveryCert = {
      runId: 1, packageAssetId: 200, format: 'fcpxml', checkedAt: 1,
      packageSha256: 'def456', verdict: 'package_broken', missing: ['package_present'],
      checks: [
        mkCertCheck('package_present', 'passed', 'metadata', 'zip'),
        mkCertCheck('project_file_wellformed', 'failed', 'local_measurement', 'project_file', 'malformed'),
        mkCertCheck('duration_math_consistent', 'stale', 'offline_probe', 'manifest', 'outdated'),
        mkCertCheck('media_refs_resolvable', 'not_tested', 'metadata', 'media_fs'),
      ],
    }

    const issues = adaptCertToIssues(1, 0, cert)
    // passed and not_tested → skipped; failed/stale → issues
    assert.equal(issues.length, 2, `expected 2 issues, got ${issues.length}`)
  })

  await t('adaptCertToIssues: all issues have stage=final and dimension=delivery', () => {
    const cert: DeliveryCert = {
      runId: 1, packageAssetId: 200, format: 'edl', checkedAt: 1,
      packageSha256: null, verdict: 'package_broken', missing: [],
      checks: [
        mkCertCheck('package_present', 'failed', 'metadata', 'zip', 'missing'),
        mkCertCheck('cross_format_consistency', 'failed', 'local_measurement', 'manifest', 'inconsistent'),
      ],
    }

    const issues = adaptCertToIssues(1, 0, cert)
    assert.ok(issues.every(i => i.stage === 'final'), 'all issues must have stage=final')
    assert.ok(issues.every(i => i.dimension === 'delivery'), 'all issues must have dimension=delivery')
  })

  await t('adaptCertToIssues: severity is always blocking for cert failures', () => {
    const cert: DeliveryCert = {
      runId: 1, packageAssetId: null, format: 'otio', checkedAt: 1,
      packageSha256: null, verdict: 'needs_package', missing: [],
      checks: [
        mkCertCheck('package_present', 'failed', 'metadata', 'zip', 'no package'),
        mkCertCheck('project_file_wellformed', 'stale', 'local_measurement', 'project_file', 'stale check'),
      ],
    }

    const issues = adaptCertToIssues(1, 0, cert)
    assert.ok(issues.every(i => i.severity === 'blocking'), 'all cert issues must be blocking')
  })

  await t('adaptCertToIssues: checker prefix is delivery.* and targetId is packageAssetId', () => {
    const cert: DeliveryCert = {
      runId: 1, packageAssetId: 999, format: 'fcpxml', checkedAt: 1,
      packageSha256: 'x', verdict: 'package_broken', missing: [],
      checks: [
        mkCertCheck('media_refs_resolvable', 'failed', 'metadata', 'media_fs', 'broken ref'),
      ],
    }

    const issues = adaptCertToIssues(1, 0, cert)
    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.checker, 'delivery.media_refs_resolvable', 'checker must be delivery.*')
    assert.equal(issues[0]!.targetId, '999', 'targetId must be packageAssetId as string')
  })

  // ─── adaptScoreToIssues ──────────────────────────────────────────────────

  await t('adaptScoreToIssues: function is importable and has correct signature', () => {
    assert.equal(typeof adaptScoreToIssues, 'function', 'adaptScoreToIssues must be a function')
    // The function takes (runId, episodeIdx) and returns Promise<QualityIssueInput[]>
    // We verify the arity (2 params) without actually calling it (needs DB context)
    assert.equal(adaptScoreToIssues.length, 2, 'adaptScoreToIssues must accept 2 parameters')
  })
}

// ─── Mock constructors ─────────────────────────────────────────────────────

function mkQcCheck(
  key: QcReport['checks'][number]['key'],
  status: QcCheck['status'],
  evidenceType: QcCheck['evidenceType'],
  source: QcCheck['source'],
  reason?: string,
  value?: number | string | boolean | null,
): QcCheck {
  return { key, status, evidenceType, source, value: value ?? null, reason }
}

function mkCertCheck(
  key: CertCheck['key'],
  status: CertCheck['status'],
  evidenceType: CertCheck['evidenceType'],
  source: CertCheck['source'],
  reason?: string,
  value?: number | string | boolean | null,
): CertCheck {
  return { key, status, evidenceType, source, value: value ?? null, reason }
}
