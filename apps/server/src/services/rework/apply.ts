/**
 * 精确返修 · 原子确认与本地续跑（precision-rework 规格 §5.3）。
 *
 * - 确认先重验完整依赖指纹与台账固定预览；任何不一致返回 stale_preview——
 *   不信前端数字，changes/基准/服务端回执三方对齐后才允许执行。
 * - applied 终态回执优先于 busy 判定（响应丢失可回放，第一次成功的结果永不因重发被覆写）。
 * - 同事务原子领用：request ready→applied、run 状态、compose step succeeded→pending 均为
 *   条件更新，并发竞争只有一方全部落锤；版本行与 _subtitleEdits 指针同事务写入，
 *   失败回滚不留当前指针变化（未引用的不可变文件留在盘上无害，不发布、不删除）。
 * - 只重置已确认的本地合成步并作废旧 gate 批准（新版本必须重新审阅）；
 *   不触任何 gen_task、不改源字幕/批准台词、零供应商调用。
 * - 事务提交后才 engine.startRun（不改引擎核心）；提交后进程中断沿用既有 queued 恢复路径。
 */
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { pipelineRuns, pipelineSteps, reworkRequests, type Asset, type ReworkRequest } from '../../db/schema'
import { engine } from '../../pipeline/engine'
import { applySubtitleChanges, type SubtitleChange } from './contract'
import { serializeSubtitleSrt, type SubtitleCue } from './subtitle-text'
import { assessSubtitleCapability } from './baseline'
import { ensureSubtitleDisplayAsset, getReworkRequest, recordSubtitleDisplayVersion, SUBTITLE_EDITS_KEY, type SubtitleEditRef } from './ledger'
import type { SubtitlePreview } from './preview'

export interface SubtitleApplyReceipt {
  runId: number
  stepKey: string
  assetId: number
  versionId: number
  sha256: string
  revision: number
  baseFingerprint: string
  previewHash: string
  /** 已入队标记（回执固定；真实执行由既有引擎/恢复路径推进） */
  enqueued: true
  appliedAt: number
}

export type SubtitleApplyOutcome =
  | { outcome: 'applied' | 'replayed'; requestId: string; result: SubtitleApplyReceipt }
  | { outcome: 'rejected'; requestId: string | null; code: string; message: string }

/** 事务内领用失败哨兵：回滚后按终态复查翻译为回放或确定性拒绝 */
class ClaimRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ClaimRejected'
  }
}

function sha256Text(text: string): string {
  return createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')
}

function receiptOf(row: ReworkRequest): SubtitleApplyReceipt | null {
  try {
    const r = JSON.parse(row.resultJson) as SubtitleApplyReceipt
    if (
      typeof r.runId === 'number' && typeof r.stepKey === 'string' && typeof r.assetId === 'number' &&
      typeof r.versionId === 'number' && typeof r.sha256 === 'string' && typeof r.revision === 'number' &&
      typeof r.baseFingerprint === 'string' && typeof r.previewHash === 'string' && r.enqueued === true
    ) return r
    return null
  } catch {
    return null
  }
}

const stale = (requestId: string, message: string): SubtitleApplyOutcome => ({
  outcome: 'rejected', requestId, code: 'stale_preview', message: `${message}，请重新预览确认后再提交`,
})

/**
 * 确认应用一个已就绪的字幕返修预览（唯一写路径；四入口经 routes 层汇聚于此）。
 * requestId 定位台账行；previewHash 必须与服务端固定预览逐字一致（防确认后前端篡改/预览错位）。
 */
export async function applySubtitleRework(p: { requestId: string; previewHash: string }): Promise<SubtitleApplyOutcome> {
  let row: ReworkRequest
  try {
    row = await getReworkRequest(p.requestId)
  } catch {
    return { outcome: 'rejected', requestId: p.requestId, code: 'not_found', message: '返修请求不存在' }
  }
  // 先查已应用回执（在 run busy 判定之前）：响应丢失重发返回第一次的结果，绝不二次推进版本
  if (row.state === 'applied') {
    const past = receiptOf(row)
    if (!past) return { outcome: 'rejected', requestId: row.id, code: 'corrupt_receipt', message: '已应用回执损坏，请人工核对修订指针后再操作' }
    return { outcome: 'replayed', requestId: row.id, result: past }
  }
  if (row.state !== 'ready') {
    return { outcome: 'rejected', requestId: row.id, code: 'not_ready', message: `请求当前状态为 ${row.state}，仅就绪预览可确认` }
  }
  let preview: SubtitlePreview
  try {
    preview = JSON.parse(row.previewJson) as SubtitlePreview
  } catch {
    return { outcome: 'rejected', requestId: row.id, code: 'corrupt_receipt', message: '预览回执损坏，请重新预览' }
  }
  if (preview.previewHash !== p.previewHash) {
    return stale(row.id, '确认携带的 previewHash 与服务端固定预览不一致')
  }

  /* 重验完整依赖指纹 + 当前基准重算结果必须与确认时逐字节一致 */
  const { capability, baseline } = await assessSubtitleCapability(row.runId, row.stepKey)
  if (!capability.supported || !baseline) return stale(row.id, capability.message)
  if (baseline.fingerprint !== row.baseFingerprint || baseline.fingerprint !== preview.baseFingerprint) {
    return stale(row.id, '依赖基准已变化（选片/媒体/源字幕/时长/配置或品牌改动）')
  }
  let changes: SubtitleChange[]
  try {
    changes = JSON.parse(row.changesJson) as SubtitleChange[]
  } catch {
    return stale(row.id, '台账变更载荷损坏')
  }
  const applied = applySubtitleChanges({
    cues: JSON.parse(JSON.stringify(baseline.cues)) as SubtitleCue[],
    changes,
    durationMs: baseline.durationMs,
  })
  if (!applied.ok) return stale(row.id, applied.errors[0]?.message ?? '变更在当前基准上不可应用')
  const content = serializeSubtitleSrt(applied.finalCues)
  if (sha256Text(content) !== preview.effectiveSha256) {
    return stale(row.id, '当前基准重算的有效文本与确认时预览不一致（基准已漂移）')
  }

  /* 事务外先行准备：显示逻辑资产与工作副本落盘（失败即返回，当前指针零变化） */
  let asset: Asset
  try {
    asset = await ensureSubtitleDisplayAsset({ projectId: row.projectId, runId: row.runId, stepKey: row.stepKey, initialContent: content })
  } catch {
    return { outcome: 'rejected', requestId: row.id, code: 'storage_failed', message: '字幕版本文件准备失败，未应用任何修订' }
  }

  const cueIds: string[] = []
  for (const ch of changes) {
    if (ch.kind === 'subtitle-shift') cueIds.push(...ch.cueIds)
    else cueIds.push(ch.cueId)
  }

  let receipt: SubtitleApplyReceipt
  try {
    receipt = await db.transaction(async (tx) => {
      // 原子领用请求：并发竞争只有一方能把 ready 推到 applied（先占位，回执在事务尾部固定）
      const claimed = await tx
        .update(reworkRequests)
        .set({ state: 'applied', updatedAt: Date.now() })
        .where(and(eq(reworkRequests.id, row.id), eq(reworkRequests.state, 'ready')))
        .returning()
      if (!claimed.length) throw new ClaimRejected('already_claimed', '请求已被并发处理')
      const runRows = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, row.runId)).limit(1)
      const run = runRows[0]
      if (!run) throw new ClaimRejected('stale_run', '运行已不存在')
      if (run.status !== 'completed' && run.status !== 'failed') {
        throw new ClaimRejected('run_active', `运行状态为 ${run.status}，等待收敛后再确认`)
      }
      let inputObj: Record<string, unknown>
      try {
        inputObj = JSON.parse(run.input) as Record<string, unknown>
      } catch {
        throw new ClaimRejected('bad_input', 'run.input 不是合法 JSON，无法写入字幕修订')
      }
      const stepRows = await tx.select().from(pipelineSteps).where(eq(pipelineSteps.id, baseline.stepId)).limit(1)
      const step = stepRows[0]
      if (!step || step.status !== 'succeeded') {
        throw new ClaimRejected('stale_step', '合成步骤状态已变化，请重新预览确认')
      }
      // 版本同事务领用：事务失败版本行回滚，指针与回执绝不会指向不存在版本
      const v = await recordSubtitleDisplayVersion({
        projectId: row.projectId,
        runId: row.runId,
        stepKey: row.stepKey,
        content,
        source: 'edit',
        label: `人工修订（${cueIds.length} 条变更）`,
        meta: {
          sourceSubtitleId: baseline.sourceRef.assetId,
          sourceSha256: baseline.sourceRef.sha256,
          baseFinalId: baseline.finalAssetId,
          baseFingerprint: baseline.fingerprint,
          parentVersionId: baseline.currentEdit?.versionId ?? null,
          requestId: row.id,
          cueIds,
          changeSummary: `应用预览 ${preview.previewHash.slice(0, 12)} 的 ${cueIds.length} 条变更`,
        },
        executor: tx,
        asset,
      })
      const ref: SubtitleEditRef = {
        assetId: asset.id,
        versionId: v.version.id,
        sha256: v.version.sha256 ?? '',
        baseFingerprint: baseline.fingerprint,
        requestId: row.id,
      }
      const prevEdits = inputObj[SUBTITLE_EDITS_KEY]
      const editBase = prevEdits && typeof prevEdits === 'object' && !Array.isArray(prevEdits) ? (prevEdits as Record<string, unknown>) : {}
      inputObj[SUBTITLE_EDITS_KEY] = { ...editBase, [row.stepKey]: ref }
      // run：写修订指针 + 入队（条件领用旧状态，半途被人改状态则整体回滚）
      const now = Date.now()
      const moved = await tx
        .update(pipelineRuns)
        .set({ input: JSON.stringify(inputObj), status: 'queued', error: null, completedAt: null, currentStepKey: null, updatedAt: now })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, run.status)))
        .returning()
      if (!moved.length) throw new ClaimRejected('stale_run', '运行状态在确认瞬间变化，已整体回滚')
      // compose step：仅重置已确认本地合成步；旧 gate 批准删除作废（新版本必复审），历史 asset_ids 保留
      let out: Record<string, unknown> = {}
      try {
        out = JSON.parse(step.output ?? '{}') as Record<string, unknown>
      } catch {
        /* 损坏 output 按无 gate 处理：重置时整体留原 output 不动 */
      }
      const hasGate = 'gate' in out
      const stepPatch: Record<string, unknown> = { status: 'pending', error: null, completedAt: null, updatedAt: now }
      if (hasGate) {
        const { gate: _void, ...rest } = out
        stepPatch.output = JSON.stringify(rest)
      }
      const stepMoved = await tx
        .update(pipelineSteps)
        .set(stepPatch)
        .where(and(eq(pipelineSteps.id, step.id), eq(pipelineSteps.status, 'succeeded')))
        .returning()
      if (!stepMoved.length) throw new ClaimRejected('stale_step', '合成步骤状态在确认瞬间变化，已整体回滚')
      const rc: SubtitleApplyReceipt = {
        runId: run.id,
        stepKey: row.stepKey,
        assetId: asset.id,
        versionId: v.version.id,
        sha256: v.version.sha256 ?? '',
        revision: v.version.revision,
        baseFingerprint: baseline.fingerprint,
        previewHash: preview.previewHash,
        enqueued: true,
        appliedAt: now,
      }
      await tx.update(reworkRequests).set({ resultJson: JSON.stringify(rc), updatedAt: Date.now() }).where(eq(reworkRequests.id, row.id))
      return rc
    })
  } catch (err) {
    if (err instanceof ClaimRejected) {
      // 落锤失败方复查终态：赢家已完整提交则回放其回执（等价响应丢失重发）；否则透出真实原因
      const after = await getReworkRequest(row.id)
      if (after.state === 'applied') {
        const past = receiptOf(after)
        if (past) return { outcome: 'replayed', requestId: after.id, result: past }
      }
      return { outcome: 'rejected', requestId: row.id, code: err.code === 'already_claimed' ? 'conflict' : err.code, message: err.message }
    }
    throw err
  }

  // 事务提交后才启动现有引擎（不改引擎；queued 恢复路径兜底进程中断）
  engine.startRun(row.runId)
  return { outcome: 'applied', requestId: row.id, result: receipt }
}
