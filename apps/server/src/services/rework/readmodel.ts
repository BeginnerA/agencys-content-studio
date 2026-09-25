/**
 * 精确返修 · 成果版本投影（precision-rework 规格 §5.2-103/§6.2-133/§7-161，P8）。
 *
 * 读模型区分四种状态并一次性可查：
 * - 当前修订：_subtitleEdits 指针 + 版本历史（每条固定 versionId 与不可变文件下载引用）；
 * - 过期标记：与合成期复验同一算法（computeFingerprintForComposeRecheck），投影与消费不再两套口径；
 * - 待审：旧 gate 批准不沿用（apply 已删除）→ awaiting_review；无 gate 模板带人工修订 → manual_unreviewed；
 * - 未更新伪装的防线：成片快照 versionId ≠ 当前指针版本时 pending_recompose=true，
 *   绝不把旧片说成已按新修订产出。
 * 只读服务：零写入、零执行、零供应商调用。
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { assets, pipelineRuns, pipelineSteps, type Asset, type ContentVersion } from '../../db/schema'
import { templateForRun } from '../../pipeline/loader'
import { listVersions } from '../provenance'
import { assessSubtitleCapability, computeFingerprintForComposeRecheck, type SubtitleCapability } from './baseline'
import { parseSubtitleEdits, sanitizeSubtitleVersionMeta, subtitleDisplayAssetName, SUBTITLE_DISPLAY_PURPOSE, type SubtitleEditRef } from './ledger'
import type { SubtitleCue } from './subtitle-text'

export interface SubtitleVersionView {
  version_id: number
  revision: number
  sha256: string | null
  source: string
  label: string | null
  is_current: boolean
  parent_version_id: number | null
  request_id: string | null
  change_summary: string
  /** 固定版本的不可变文件下载引用（§5.2-103：下载不只固定逻辑 assetId） */
  download_url: string
  created_at: number
}

export interface SubtitleReadModel {
  capability: SubtitleCapability
  step_key: string
  baseline: {
    run_id: number
    final_asset_id: number
    duration_ms: number
    origin: 'source' | 'manual'
    source_ref: { assetId: number | null; sha256: string; timingSource: string }
    cues: SubtitleCue[]
  } | null
  current_edit: (SubtitleEditRef & { stale: boolean; stale_reason: 'ok' | 'fingerprint_drift' | 'unverifiable' }) | null
  versions: SubtitleVersionView[]
  review: {
    gate_required: boolean
    decision: 'approve' | 'reject' | 'skip' | null
    /** awaiting_review | gate_approved | gate_rejected | gate_skipped | manual_unreviewed | none */
    state: string
    note: string
  }
  output: {
    compose_status: string | null
    final_asset_id: number | null
    /** 当前指针版本是否已落到现有成片快照（false=旧片未重生，不得伪装已更新） */
    current_version_in_final: boolean
    /** 有已应用修订但成片尚未按该版本重合成 */
    pending_recompose: boolean
  }
}

/** 成片 params.timeline.subtitle.versionId 宽松读取（旧产物无该字段 → null，不报错不阻断投影） */
function finalSnapVersionId(asset: Asset | null): number | null {
  if (!asset) return null
  try {
    const params = JSON.parse(asset.params ?? '{}') as Record<string, unknown>
    const tl = params.timeline as Record<string, unknown> | undefined
    const sub = tl?.subtitle as Record<string, unknown> | undefined
    const v = sub?.versionId
    return typeof v === 'number' && Number.isInteger(v) ? v : null
  } catch {
    return null
  }
}

function toVersionView(v: ContentVersion, currentVersionId: number | null): SubtitleVersionView {
  const meta = sanitizeSubtitleVersionMeta(JSON.parse(v.meta) as unknown)
  return {
    version_id: v.id,
    revision: v.revision,
    sha256: v.sha256,
    source: v.source,
    label: v.label,
    is_current: v.id === currentVersionId,
    parent_version_id: meta.parentVersionId,
    request_id: meta.requestId,
    change_summary: meta.changeSummary,
    download_url: `/api/v1/assets/${v.objId}/versions/${v.id}/download`,
    created_at: v.createdAt,
  }
}

/** 字幕读模型投影（GET /runs/:id/subtitles 数据源；纯读取零副作用） */
export async function subtitleReadModel(runId: number, stepKey: string): Promise<SubtitleReadModel> {
  const { capability, baseline } = await assessSubtitleCapability(runId, stepKey)

  // 指针与过期复验：即使能力不满足也如实投影（历史成片区要能看到指针与过期原因）
  const runRows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = runRows[0] ?? null
  const edit = run ? parseSubtitleEdits(run.input)[stepKey] ?? null : null

  let stale = false
  let staleReason: 'ok' | 'fingerprint_drift' | 'unverifiable' = 'ok'
  if (edit) {
    const current = await computeFingerprintForComposeRecheck(runId, stepKey)
    if (current === null) {
      stale = true
      staleReason = 'unverifiable'
    } else if (current !== edit.baseFingerprint) {
      stale = true
      staleReason = 'fingerprint_drift'
    }
  }

  // 显示字幕逻辑资产与版本历史
  const displayRows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.purpose, SUBTITLE_DISPLAY_PURPOSE), eq(assets.runId, runId), eq(assets.name, subtitleDisplayAssetName(runId, stepKey))))
    .limit(1)
  const displayAsset = displayRows[0] ?? null
  const versionRows: ContentVersion[] = displayAsset ? await listVersions('asset', displayAsset.id) : []
  const versions = versionRows.map((v) => toVersionView(v, edit?.versionId ?? null))

  // compose 步状态 + gate + 当前成片绑定
  const stepRows = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId)).orderBy(pipelineSteps.seq)
  const step = stepRows.find((s) => s.stepKey === stepKey && s.actionKey === 'ffmpeg_merge') ?? stepRows.find((s) => s.stepKey === stepKey) ?? null
  let stepOutput: Record<string, unknown> = {}
  try {
    stepOutput = JSON.parse(step?.output ?? '{}') as Record<string, unknown>
  } catch {
    stepOutput = {}
  }
  const gate = stepOutput.gate as Record<string, unknown> | undefined
  const decision = gate && (gate.decision === 'approve' || gate.decision === 'reject' || gate.decision === 'skip') ? (gate.decision as 'approve' | 'reject' | 'skip') : null

  let gateRequired = false
  try {
    if (run) gateRequired = !!templateForRun(run).steps.find((s) => s.key === stepKey)?.gate
  } catch {
    gateRequired = false // 模板缺失/损坏：按无 gate 保守投影（人工修订仍标未复核）
  }

  let reviewState: string
  let reviewNote: string
  if (decision === 'approve') {
    reviewState = 'gate_approved'
    reviewNote = '当前成片已获人工审阅批准'
  } else if (decision === 'reject') {
    reviewState = 'gate_rejected'
    reviewNote = '人工审阅未接受该成果'
  } else if (decision === 'skip') {
    reviewState = 'gate_skipped'
    reviewNote = '该步按模板声明免审放行'
  } else if (gateRequired && step?.status === 'succeeded') {
    reviewState = 'awaiting_review'
    reviewNote = '成果待审阅：字幕修订应用后旧批准已作废，必须重新审阅'
  } else if (edit) {
    reviewState = 'manual_unreviewed'
    reviewNote = '人工字幕修订尚未经复核（该模板无独立审阅闸门，技术成功不等于内容通过）'
  } else {
    reviewState = 'none'
    reviewNote = ''
  }

  // 成片绑定版本：currentEdit 存在且现成片快照 versionId 不等于指针版本 → 旧片未重生
  let finalAssetId: number | null = null
  const outIds = Array.isArray(stepOutput.asset_ids) ? stepOutput.asset_ids.filter((x): x is number => typeof x === 'number') : []
  if (outIds.length) finalAssetId = outIds[outIds.length - 1]!
  else if (baseline) finalAssetId = baseline.finalAssetId
  const finalRows = finalAssetId ? await db.select().from(assets).where(eq(assets.id, finalAssetId)).limit(1) : []
  const snapVersionId = finalSnapVersionId(finalRows[0] ?? null)
  const currentVersionInFinal = edit ? snapVersionId === edit.versionId : true
  const pendingRecompose = !!edit && !currentVersionInFinal

  return {
    capability,
    step_key: stepKey,
    baseline: baseline
      ? {
          run_id: baseline.runId,
          final_asset_id: baseline.finalAssetId,
          duration_ms: baseline.durationMs,
          origin: baseline.origin,
          source_ref: baseline.sourceRef,
          cues: baseline.cues,
        }
      : null,
    current_edit: edit ? { ...edit, stale, stale_reason: staleReason } : null,
    versions,
    review: { gate_required: gateRequired, decision, state: reviewState, note: reviewNote },
    output: {
      compose_status: step?.status ?? null,
      final_asset_id: finalAssetId,
      current_version_in_final: currentVersionInFinal,
      pending_recompose: pendingRecompose,
    },
  }
}
