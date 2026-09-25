/**
 * 精确返修 · 结构化预览编译与请求状态查询（precision-rework 规格 §5/§6 预览侧）。
 *
 * - 预览 = 基准 cues + 契约 apply 的纯推导（零模型调用、零执行态写入）：固定 previewHash、
 *   完整依赖指纹与影响说明后写入 rework_requests（ready 回执，apply 只接 previewHash 引用）。
 * - 幂等：requestHash 由规范化 changes + 指纹派生，同键同内容回放既有预览，
 *   同键异内容 conflict（routes 层 409），绝不静默覆盖已展示给用户的预览。
 * - 无效/冲突 changes 也登记 blocked 回执（可经 requestId 回放失败原因），但不产出可确认预览。
 * - 验收红线：本模块不重置任务、不改 step/run 状态、不创建资产。
 */
import { createHash } from 'node:crypto'
import { hashJson } from '../creation-chat/contract'
import { applySubtitleChanges, normalizeSubtitleChanges, parseSubtitleChanges, type SubtitleDiffEntry } from './contract'
import { serializeSubtitleSrt, type ReworkError, type SubtitleCue } from './subtitle-text'
import { getReworkRequest, upsertReworkRequest } from './ledger'
import { assessSubtitleCapability, type SubtitleBaseline } from './baseline'
import type { ReworkRequest } from '../../db/schema'

function sha256Text(text: string): string {
  return createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')
}

export interface SubtitlePreviewImpact {
  /** 纯本地执行确认：零供应商调用、零新增用量 */
  localOnly: true
  modelCalls: 0
  /** 确认后将重置的本地步骤（仅合成步；执行细节由 apply 事务决定） */
  resetSteps: string[]
  /** 保留不复做的东西（诚实说明：源字幕/批准台词/原声/ASR 缓存/生成任务） */
  keepNotes: string[]
  /** 新版本需重新审阅：旧 gate 批准不自动沿用 */
  newReviewRequired: true
  /** 硬字幕开关当前态（true=将本地重合成烧录；false=仅显示字幕/SRT 路径） */
  subtitleBurn: boolean
}

export interface SubtitlePreview {
  stepKey: string
  baseFingerprint: string
  /** 预览固定指纹：changes 规范化 + 结果有效文本 hash + 依赖指纹（apply 必须原样回传） */
  previewHash: string
  durationMs: number
  baseCues: SubtitleCue[]
  finalCues: SubtitleCue[]
  diffs: SubtitleDiffEntry[]
  /** 修订后有效 SRT 文本 hash（版本文件内容寻址依据） */
  effectiveSha256: string
  origin: 'manual'
  impact: SubtitlePreviewImpact
  risks: string[]
}

export type PreviewOutcome =
  | { outcome: 'ready' | 'replayed'; requestId: string; preview: SubtitlePreview }
  | { outcome: 'conflict'; requestId: string; code: 'idempotency_conflict'; message: string }
  | { outcome: 'blocked'; requestId: string | null; code: string; message: string; errors?: ReworkError[] }

/** 预览结果的稳定请求指纹：规范化 changes 与乱序无关；同内容重复提交必命中回放 */
function previewRequestHash(baseline: SubtitleBaseline, stepKey: string, normalized: unknown[]): string {
  return hashJson({ stepKey, f: baseline.fingerprint, c: normalized })
}

async function registerBlocked(p: {
  baseline: SubtitleBaseline
  stepKey: string
  requestKey: string
  sessionId?: number | null
  rawChanges: unknown
  errors: ReworkError[]
}): Promise<{ requestId: string }> {
  const res = await upsertReworkRequest({
    projectId: p.baseline.projectId,
    runId: p.baseline.runId,
    stepKey: p.stepKey,
    sessionId: p.sessionId ?? null,
    requestKey: p.requestKey,
    requestHash: hashJson({ stepKey: p.stepKey, f: p.baseline.fingerprint, raw: p.rawChanges }),
    state: 'blocked',
    baseFingerprint: p.baseline.fingerprint,
    preview: { errors: p.errors },
  })
  return { requestId: res.row.id }
}

/**
 * 结构化预览编译（唯一入口，会话/工作台/画布/重合成共用，前端不得重算）。
 * 步骤：能力与基准 → schema 校验 → 规范化 → 应用与整体校验 → 固定预览与指纹 → 台账回执。
 */
export async function buildSubtitlePreview(p: {
  runId: number
  stepKey?: string
  requestKey: string
  sessionId?: number | null
  changes: unknown
}): Promise<PreviewOutcome> {
  const stepKey = p.stepKey ?? 'compose'
  const { capability, baseline } = await assessSubtitleCapability(p.runId, stepKey)
  if (!baseline) return { outcome: 'blocked', requestId: null, code: capability.code, message: capability.message }

  const parsed = parseSubtitleChanges(p.changes)
  if (!parsed.ok) {
    const { requestId } = await registerBlocked({ baseline, stepKey, requestKey: p.requestKey, sessionId: p.sessionId, rawChanges: p.changes, errors: parsed.errors })
    return { outcome: 'blocked', requestId, code: 'invalid_changes', message: parsed.errors[0]?.message ?? '变更无效', errors: parsed.errors }
  }
  const normalized = normalizeSubtitleChanges(parsed.changes, baseline.cues)
  const applied = applySubtitleChanges({ cues: JSON.parse(JSON.stringify(baseline.cues)) as SubtitleCue[], changes: parsed.changes, durationMs: baseline.durationMs })
  if (!applied.ok) {
    const { requestId } = await registerBlocked({ baseline, stepKey, requestKey: p.requestKey, sessionId: p.sessionId, rawChanges: p.changes, errors: applied.errors })
    return { outcome: 'blocked', requestId, code: applied.errors[0]?.code ?? 'apply_failed', message: applied.errors[0]?.message ?? '变更应用失败', errors: applied.errors }
  }

  const effectiveSha256 = sha256Text(serializeSubtitleSrt(applied.finalCues))
  const previewHash = hashJson({ f: baseline.fingerprint, c: normalized, s: effectiveSha256 })
  const risks: string[] = [
    '新版本进入重新审阅：旧批准不会自动用于修订后的字幕',
    baseline.origin === 'manual' ? '在当前人工修订基础上继续修改（历史版本可另行预览恢复）' : '首次人工修订：源字幕与 ASR 来源等级保持不变',
  ]
  const preview: SubtitlePreview = {
    stepKey,
    baseFingerprint: baseline.fingerprint,
    previewHash,
    durationMs: baseline.durationMs,
    baseCues: baseline.cues,
    finalCues: applied.finalCues,
    diffs: applied.diffs,
    effectiveSha256,
    origin: 'manual',
    impact: {
      localOnly: true,
      modelCalls: 0,
      resetSteps: [stepKey],
      keepNotes: ['源字幕资产不改', '批准台词与配音位置（timeline.lines）不改', '原声/ASR 缓存与生成任务不重置', '历史成片保留为历史版本，不覆盖'],
      newReviewRequired: true,
      subtitleBurn: true,
    },
    risks,
  }

  const res = await upsertReworkRequest({
    projectId: baseline.projectId,
    runId: baseline.runId,
    stepKey,
    sessionId: p.sessionId ?? null,
    requestKey: p.requestKey,
    requestHash: previewRequestHash(baseline, stepKey, normalized),
    state: 'ready',
    baseFingerprint: baseline.fingerprint,
    changes: parsed.changes,
    preview,
  })
  if (res.outcome === 'conflict') {
    return { outcome: 'conflict', requestId: res.row.id, code: 'idempotency_conflict', message: '同请求键已存在不同载荷的返修请求' }
  }
  if (res.outcome === 'replayed') {
    if (res.row.state === 'blocked') {
      const errs = ((JSON.parse(res.row.previewJson) as { errors?: ReworkError[] }).errors ?? []) as ReworkError[]
      return { outcome: 'blocked', requestId: res.row.id, code: 'invalid_changes', message: errs[0]?.message ?? '变更无效', errors: errs }
    }
    const stored = JSON.parse(res.row.previewJson) as SubtitlePreview
    return { outcome: 'replayed', requestId: res.row.id, preview: stored }
  }
  return { outcome: 'ready', requestId: res.row.id, preview }
}

/** 请求状态回放视图（GET /runs/:id/rework/:requestId 数据源；纯读取零副作用） */
export interface ReworkRequestView {
  id: string
  runId: number
  stepKey: string
  state: ReworkRequest['state']
  baseFingerprint: string | null
  preview: SubtitlePreview | { errors?: ReworkError[] } | Record<string, never>
  result: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export async function getReworkRequestView(requestId: string): Promise<ReworkRequestView> {
  const row = await getReworkRequest(requestId)
  return {
    id: row.id,
    runId: row.runId,
    stepKey: row.stepKey,
    state: row.state,
    baseFingerprint: row.baseFingerprint,
    preview: JSON.parse(row.previewJson) as ReworkRequestView['preview'],
    result: JSON.parse(row.resultJson) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
