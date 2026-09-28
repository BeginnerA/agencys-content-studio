/**
 * 第四期 · 统一 QC 面板：核验编排 / verdict / 缓存 / 新鲜度（规格 2026-09-28 §3/§5）。
 *
 * **只读编排 + 零新列缓存**：定位成片 → 本地测量（measure）→ 一致性核验（consistency）→ 聚合三态 verdict
 * + missing[] → merge 进 `assets.params.qc`（镜像 `recordQuality`，保留其余键）。不 import 引擎、不写业务表、
 * 不改 delivery_checked / 批准链、零付费零模型。门禁不足 → 诚实 not_tested，绝不伪造通过。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, pipelineRuns, reworkRequests, type Asset } from '../../db/schema'
import { readComposeConfig } from '../compose-config'
import { absPathOf } from '../storage'
import { assessComposeInputCapability } from '../rework/capability'
import { probeMediaDuration } from '../ffmpeg'
import { fileExists, measureLoudness, probeMediaSpec } from './measure'
import { buildConsistencyChecks, parseTimeline } from './consistency'
import { type QcCheck, type QcRunResult, type QcReport, type QcVerdict } from './types'

/** 客观必需项：决定 ready/not_ready 的可测项（主观 manual 与音频失真不在其中，见规格 §3/§7.2）。 */
const OBJECTIVE_REQUIRED: QcCheck['key'][] = [
  'file_readable',
  'stream_spec',
  'duration_vs_timeline',
  'timeline_source',
  'shot_duration_applied',
  'rework_receipt_consistency',
  'subtitle_alignment_present',
  'audio_peak',
  'delivery_flag',
]

function jsonParams(a: Asset): Record<string, unknown> {
  if (!a.params) return {}
  try {
    const p = JSON.parse(a.params) as unknown
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 定位成片：优先 run 关联的最新未删除 final_video（QC 门禁比返修轻，草稿/失败成片亦可核验）。 */
async function locateFinal(runId: number): Promise<Asset | null> {
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.runId, runId), eq(assets.purpose, 'final_video'), eq(assets.kind, 'video'), isNull(assets.deletedAt)))
    .orderBy(desc(assets.id))
    .limit(1)
  return rows[0] ?? null
}

/** 台账最近 state='applied' 的 baseFingerprint（无 → null）。 */
async function lastAppliedFingerprint(runId: number): Promise<string | null> {
  const rows = await db
    .select()
    .from(reworkRequests)
    .where(and(eq(reworkRequests.runId, runId), eq(reworkRequests.state, 'applied')))
    .orderBy(desc(reworkRequests.updatedAt))
    .limit(1)
  return rows[0]?.baseFingerprint ?? null
}

/** 聚合三态 verdict + missing[]（保守：宁 needs_review 不误 ready；主观人工项恒入 missing）。 */
function decide(checks: QcCheck[], deliveryChecked: boolean): { verdict: QcVerdict; missing: string[] } {
  const byKey = new Map(checks.map((c) => [c.key, c]))
  const missing: string[] = []
  let anyFailedOrStale = false
  let anyUnclean = false
  for (const key of OBJECTIVE_REQUIRED) {
    const c = byKey.get(key)
    if (!c || c.status === 'not_applicable') continue
    if (c.status === 'failed' || c.status === 'stale') {
      anyFailedOrStale = true
      missing.push(key)
    } else if (c.status !== 'passed') {
      anyUnclean = true
      missing.push(key)
    }
  }
  // 主观人工复核：恒列入缺项（面板只读、不代签），但不阻断 ready 判定之外的可用性
  missing.push('manual_quality_review')
  const verdict: QcVerdict = anyFailedOrStale
    ? 'not_ready'
    : !anyUnclean && deliveryChecked
      ? 'ready'
      : 'needs_review'
  return { verdict, missing }
}

/** 物理规格 + 可读性 + 音频客观测量（本地测量层产出；不含一致性项）。 */
function buildMeasurementChecks(absPath: string | null): QcCheck[] {
  const out: QcCheck[] = []
  if (!absPath || !fileExists(absPath)) {
    out.push({ key: 'file_readable', status: 'failed', evidenceType: 'local_measurement', source: 'ffprobe', reason: '成片文件缺失或不可读' })
    out.push({ key: 'stream_spec', status: 'not_tested', evidenceType: 'local_measurement', source: 'ffprobe', reason: '文件不可读，跳过规格探测' })
    out.push({ key: 'audio_peak', status: 'not_tested', evidenceType: 'local_measurement', source: 'ffprobe', reason: '文件不可读，跳过响度测量' })
    return out
  }
  out.push({ key: 'file_readable', status: 'passed', evidenceType: 'local_measurement', source: 'ffprobe', value: true })
  const spec = probeMediaSpec(absPath)
  if (!spec) {
    out.push({ key: 'stream_spec', status: 'not_tested', evidenceType: 'local_measurement', source: 'ffprobe', reason: 'ffprobe 不可用或探测失败' })
  } else if (!spec.hasVideo) {
    out.push({ key: 'stream_spec', status: 'failed', evidenceType: 'local_measurement', source: 'ffprobe', reason: '成片无可解码视频流' })
  } else {
    out.push({
      key: 'stream_spec',
      status: 'passed',
      evidenceType: 'local_measurement',
      source: 'ffprobe',
      value: `${spec.container ?? '?'} ${spec.width ?? '?'}x${spec.height ?? '?'} @${spec.fps?.toFixed(2) ?? '?'}fps 音频:${spec.hasAudio ? '有' : '无'}`,
    })
  }
  // 音频客观测量（Q2：仅记录数值，失真/削波判定留人工；无音轨/无工具 → 对应值 null + not_tested）
  if (spec && !spec.hasAudio) {
    out.push({ key: 'audio_peak', status: 'not_applicable', evidenceType: 'local_measurement', source: 'ffprobe', reason: '成片无音频流' })
  } else {
    const loud = measureLoudness(absPath)
    if (loud.peakDbtp === null && loud.integratedLufs === null) {
      out.push({ key: 'audio_peak', status: 'not_tested', evidenceType: 'local_measurement', source: 'ffprobe', reason: '响度测量不可用（ffmpeg 缺失/超时）；削波/失真仍需人工听审' })
    } else {
      out.push({
        key: 'audio_peak',
        status: 'passed',
        evidenceType: 'local_measurement',
        source: 'ffprobe',
        value: `Peak ${loud.peakDbtp ?? '?'} dBTP / I ${loud.integratedLufs ?? '?'} LUFS`,
        reason: '客观测量；是否削波/失真属主观，需人工听审（manual_review_required）',
      })
    }
  }
  return out
}

/**
 * 运行一次成片质量核验（默认按需重算并刷新缓存）。
 * @param opts.refreshCache 写 params.qc 缓存（缺省 true；探针/只读探查可关）。
 */
export async function runQcCheck(runId: number, opts: { refreshCache?: boolean } = {}): Promise<QcRunResult> {
  const runRows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = runRows[0]
  if (!run) return { outcome: 'blocked', code: 'run_not_found', message: `运行 ${runId} 不存在` }
  const final = await locateFinal(runId)
  if (!final || !final.relPath) return { outcome: 'blocked', code: 'no_final_video', message: '该运行没有可核验的成片资产' }

  const params = jsonParams(final)
  const absPath = absPathOf(final.relPath)
  const config = readComposeConfig(run.input)
  const shotDurations = (config.shot_durations ?? {}) as Record<string, number>

  const measured = probeMediaSpec(absPath)?.durationSec ?? probeMediaDuration(absPath)
  const timeline = parseTimeline(params)
  const currentFingerprint = (await assessComposeInputCapability(runId)).baseline?.fingerprint ?? null
  const lastFp = await lastAppliedFingerprint(runId)

  const checks: QcCheck[] = [
    ...buildMeasurementChecks(absPath),
    ...buildConsistencyChecks({ timeline, measuredDurationSec: measured, shotDurations, lastAppliedFingerprint: lastFp, currentFingerprint }),
    // 交付标记（只读呈现，不改写；Q1）
    typeof params.delivery_checked === 'boolean'
      ? { key: 'delivery_flag', status: params.delivery_checked ? 'passed' : 'not_tested', evidenceType: 'metadata', source: 'asset_params', value: params.delivery_checked, reason: params.delivery_checked ? undefined : '成片未标记 delivery_checked（可能非严格交付路径产物）' }
      : { key: 'delivery_flag', status: 'not_tested', evidenceType: 'metadata', source: 'asset_params', reason: 'params 无 delivery_checked 字段' },
    // 主观人工复核：恒 not_tested（第一期 §7.2：不新建自动 QC 算法、不调用多模态评分）
    { key: 'manual_quality_review', status: 'not_tested', evidenceType: 'manual_review', source: 'manual', reason: '视觉一致性/道具连续/听感失真需人工看片听审，面板不自动判过' },
  ]

  const deliveryChecked = params.delivery_checked === true
  const { verdict, missing } = decide(checks, deliveryChecked)

  const report: QcReport = {
    runId,
    finalAssetId: final.id,
    checkedAt: Date.now(),
    mediaSha256: final.sha256 ?? null,
    verdict,
    missing,
    checks,
  }

  if (opts.refreshCache !== false) await writeQcCache(final, report)
  return { outcome: 'ok', report }
}

/** merge 进 assets.params.qc（零新列，保留其余键；镜像 recordQuality）。 */
async function writeQcCache(final: Asset, report: QcReport): Promise<void> {
  const params = jsonParams(final)
  params.qc = report
  await db.update(assets).set({ params: JSON.stringify(params), updatedAt: Date.now() }).where(eq(assets.id, final.id))
}

/** 读缓存报告（refresh=0 时优先命中，且做新鲜度判定：成片 hash 变 → 顶层标 stale 于依据旧测的项）。 */
export async function readQcCache(runId: number): Promise<QcReport | null> {
  const final = await locateFinal(runId)
  if (!final) return null
  const cached = jsonParams(final).qc
  if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return null
  const report = cached as QcReport
  // 新鲜度：缓存 mediaSha256 与当前成片 hash 不符 → 相关 local_measurement/offline_probe 结论标 stale（不伪造通过）
  if (report.mediaSha256 !== (final.sha256 ?? null)) {
    for (const c of report.checks) {
      if (c.status === 'passed' && (c.evidenceType === 'local_measurement' || c.evidenceType === 'offline_probe')) {
        c.status = 'stale'
        c.reason = '缓存基准与当前成片 hash 不一致，结论待重算'
      }
    }
    if (report.verdict === 'ready') report.verdict = 'needs_review'
  }
  return { ...report, fromCache: true }
}
