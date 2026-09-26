/**
 * 精确返修 · 合成输入本地返修：结构化预览编译（切片2 规格 §3/§4，零执行）。
 *
 * 镜像字幕 buildSubtitlePreview 的唯一编译器范式，但覆盖合成输入四类变更：
 *   能力与基准（capability.assessComposeInputCapability，去字幕快照门禁）→ schema 校验（compose-input 契约）
 *   → **需查库的资产校验**（bgm/sfx 目标资产存在·未删·属本 run 项目·kind=audio；
 *     shot-select 目标须属某生成步骤 output 集合、与在用资产同 kind、同 shotId，即「不越步骤/不跨 kind 的同类候选」）
 *   → 语义编译（compileComposeInputChanges：冲突/clamp 委托真源/diff/no_effect/canonical 序）
 *   → 固定 previewHash + 影响声明（本地重编码、仅重置合成步、保留清单）→ 台账 ready/blocked 回执。
 * 验收红线（规格 §1/§5）：本模块纯读取——不重置任务、不改 step/run 状态、不创建/软删资产、零供应商调用；
 * 一切落库写入只发生在 rework_requests 台账（预览回执），实际生效由 apply（T4）原子领用。
 */
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { assets, pipelineSteps, type Asset } from '../../db/schema'
import { hashJson } from '../creation-chat/contract'
import { outputIdsOf, selectedMapOf, shotIdOfAsset } from '../shot/helpers'
import type { ComposeConfig } from '../compose-config'
import { assessComposeInputCapability, type ComposeInputBaseline } from './capability'
import {
  parseComposeInputChanges,
  compileComposeInputChanges,
  type ComposeInputCurrentState,
  type ComposeInputDiffEntry,
  type ComposeInputError,
  type ComposeInputChange,
} from './compose-input'
import { upsertReworkRequest } from './ledger'

export interface ComposeInputPreviewImpact {
  /** 本地重编码确认：零供应商调用、零新增用量；但必触发真实 FFmpeg 重合成（不承诺逐字节一致/不承诺即时完成） */
  localReencode: true
  modelCalls: 0
  charged: false
  /** 确认后将重置的步骤（仅合成步；执行细节由 apply 事务决定） */
  resetSteps: string[]
  /** 保留不复做的东西（诚实说明：源资产/未涉及镜头产物/原成片/台词分镜） */
  keepNotes: string[]
  /** 新版本需重新审阅：旧 gate 批准不自动沿用 */
  newReviewRequired: true
}

export interface ComposeInputPreview {
  stepKey: string
  baseFingerprint: string
  /** 预览固定指纹：规范化 changes + 依赖指纹派生（apply 必须原样回传） */
  previewHash: string
  finalAssetId: number
  /** 预览基准的当前合成配置（供 UI 展示 原值→新值 上下文） */
  currentConfig: ComposeConfig
  /** 预览基准的当前在用 BGM 资产 id（无则 null） */
  bgmAssetId: number | null
  diffs: ComposeInputDiffEntry[]
  impact: ComposeInputPreviewImpact
  risks: string[]
}

export type ComposeInputPreviewOutcome =
  | { outcome: 'ready' | 'replayed'; requestId: string; preview: ComposeInputPreview }
  | { outcome: 'conflict'; requestId: string; code: 'idempotency_conflict'; message: string }
  | { outcome: 'blocked'; requestId: string | null; code: string; message: string; errors?: ComposeInputError[] }

/** 预览结果的稳定请求指纹：规范化 changes 与乱序无关；同内容重复提交必命中回放 */
function previewRequestHash(baseline: ComposeInputBaseline, stepKey: string, normalized: ComposeInputChange[]): string {
  return hashJson({ stepKey, f: baseline.fingerprint, c: normalized })
}

/** 无效/冲突变更登记 blocked 回执（可经 requestId 回放失败原因），但不产出可确认预览 */
async function registerBlocked(p: {
  baseline: ComposeInputBaseline
  stepKey: string
  requestKey: string
  sessionId?: number | null
  rawChanges: unknown
  errors: ComposeInputError[]
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

/** 按 id 批量取资产行（含软删行，交由调用方判 deletedAt——存在性/归属/类型统一 fail closed） */
async function loadAssetsById(ids: number[]): Promise<Map<number, Asset>> {
  if (ids.length === 0) return new Map()
  const rows = await db.select().from(assets).where(inArray(assets.id, [...new Set(ids)]))
  return new Map(rows.map((a) => [a.id, a]))
}

/** shot-select 校验期锁定的「同类候选换入」明细（apply 期据此重建生成步 output） */
export interface ComposeInputSelection {
  shotId: string
  stepKey: string
  stepId: number
  fromAssetId: number
  toAssetId: number
}

/**
 * 需查库的资产校验（规格 §67）：bgm/sfx 目标 kind=audio·未删·属本项目；
 * shot-select 目标须属某生成步骤 output、与在用资产同 kind·同 shotId（不越步骤、不跨 kind）。
 * 任一不满足收集为 ComposeInputError；同时把 shot-select 的「在用旧值」填进 current.selectedByShot 供 diff，
 * 并产出 selections（含产出步 stepId/stepKey + 新旧 assetId），供 apply 事务外重建生成步 output。
 * 纯读取：不改任何资产/步骤/映射。export 供 apply 复用同一校验口径（避免两套判定漂移）。
 */
export async function validateAssetBindings(p: {
  changes: ComposeInputChange[]
  projectId: number
  runId: number
  current: ComposeInputCurrentState
}): Promise<{ errors: ComposeInputError[]; selections: ComposeInputSelection[] }> {
  const errors: ComposeInputError[] = []
  const selections: ComposeInputSelection[] = []
  const audioTargets: Array<{ kind: 'bgm' | 'sfx'; assetId: number | null }> = []
  const selectTargets: Array<{ shotId: string; assetId: number }> = []
  for (const c of p.changes) {
    if (c.kind === 'bgm') audioTargets.push({ kind: 'bgm', assetId: c.assetId })
    else if (c.kind === 'sfx') audioTargets.push({ kind: 'sfx', assetId: c.assetId })
    else if (c.kind === 'shot-select') selectTargets.push({ shotId: c.shotId, assetId: c.assetId })
  }

  // 音频换绑（bgm/sfx）：null=移除无需校验；否则须 kind=audio·未删·属本项目·有文件
  const audioIds = audioTargets.map((t) => t.assetId).filter((id): id is number => id !== null)
  const audioMap = await loadAssetsById(audioIds)
  for (const t of audioTargets) {
    if (t.assetId === null) continue
    const a = audioMap.get(t.assetId)
    const label = t.kind === 'bgm' ? 'BGM' : 'SFX'
    if (!a || a.deletedAt !== null) { errors.push({ code: 'bad_asset', message: `${label} 目标资产 #${t.assetId} 不存在或已删除` }); continue }
    if (a.projectId !== p.projectId) { errors.push({ code: 'bad_asset', message: `${label} 目标资产 #${t.assetId} 不属于本项目` }); continue }
    if (a.kind !== 'audio') { errors.push({ code: 'bad_asset', message: `${label} 目标资产 #${t.assetId} 类型不符（需 audio）` }); continue }
    if (!a.relPath) { errors.push({ code: 'bad_asset', message: `${label} 目标资产 #${t.assetId} 无文件（relPath 缺失）` }) }
  }

  // 候选改选：目标资产定位其产出步 → 该步在用旧值须存在、同 kind、同 shotId（不越步骤）
  if (selectTargets.length > 0) {
    const selMap = await loadAssetsById(selectTargets.map((t) => t.assetId))
    const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, p.runId))
    for (const t of selectTargets) {
      const a = selMap.get(t.assetId)
      if (!a || a.deletedAt !== null) { errors.push({ code: 'bad_asset', message: `候选改选目标资产 #${t.assetId} 不存在或已删除` }); continue }
      if (a.projectId !== p.projectId) { errors.push({ code: 'bad_asset', message: `候选改选目标资产 #${t.assetId} 不属于本项目` }); continue }
      if (shotIdOfAsset(a) !== t.shotId) { errors.push({ code: 'bad_asset', message: `候选改选目标资产 #${t.assetId} 与镜头 ${t.shotId} 不匹配` }); continue }
      // 目标须落在某生成步骤 output 集合内，且该步对同镜已有在用版本（同 kind 由同步产出天然保证，显式校验兜底）
      let matched = false
      for (const s of steps) {
        if (!outputIdsOf(s).includes(a.id)) continue
        const { selected } = await selectedMapOf(s)
        const cur = selected.get(t.shotId)
        if (cur === undefined) continue
        const curAsset = (await loadAssetsById([cur])).get(cur)
        if (curAsset && curAsset.kind === a.kind) {
          p.current.selectedByShot[t.shotId] = cur
          selections.push({ shotId: t.shotId, stepKey: s.stepKey, stepId: s.id, fromAssetId: cur, toAssetId: a.id })
          matched = true
          break
        }
      }
      if (!matched) errors.push({ code: 'bad_asset', message: `候选改选目标资产 #${t.assetId} 不属于镜头 ${t.shotId} 在同一生成步骤内的同类候选` })
    }
  }
  return { errors, selections }
}

/** 基准快照 → 当前状态（config/bgm/sfx 由 capability 基准；selectedByShot 由 shot-select 校验期回填）。export 供 apply 复用同一当前态口径 */
export function currentFromBaseline(baseline: ComposeInputBaseline): ComposeInputCurrentState {
  const sfxByShot: Record<string, number> = {}
  for (const x of baseline.sfx) sfxByShot[x.shotId] = x.assetId
  return { config: baseline.config, bgmAssetId: baseline.bgm.assetId, sfxByShot, selectedByShot: {} }
}

/**
 * 合成输入返修结构化预览（唯一入口，前端不得重算）。零执行态写入：只固定预览与台账回执。
 */
export async function buildComposeInputPreview(p: {
  runId: number
  stepKey?: string
  requestKey: string
  sessionId?: number | null
  changes: unknown
}): Promise<ComposeInputPreviewOutcome> {
  const stepKey = p.stepKey ?? 'compose'
  const { capability, baseline } = await assessComposeInputCapability(p.runId, stepKey)
  if (!baseline) return { outcome: 'blocked', requestId: null, code: capability.code, message: capability.message }

  const parsed = parseComposeInputChanges(p.changes)
  if (!parsed.ok) {
    const { requestId } = await registerBlocked({ baseline, stepKey, requestKey: p.requestKey, sessionId: p.sessionId, rawChanges: p.changes, errors: parsed.errors })
    return { outcome: 'blocked', requestId, code: parsed.errors[0]?.code ?? 'invalid_changes', message: parsed.errors[0]?.message ?? '变更无效', errors: parsed.errors }
  }

  // 需查库的资产校验（先于语义编译，fail closed；顺带回填 shot-select 在用旧值）
  const current = currentFromBaseline(baseline)
  const { errors: assetErrors } = await validateAssetBindings({ changes: parsed.changes, projectId: baseline.projectId, runId: baseline.runId, current })
  if (assetErrors.length > 0) {
    const { requestId } = await registerBlocked({ baseline, stepKey, requestKey: p.requestKey, sessionId: p.sessionId, rawChanges: p.changes, errors: assetErrors })
    return { outcome: 'blocked', requestId, code: assetErrors[0]?.code ?? 'bad_asset', message: assetErrors[0]?.message ?? '资产校验失败', errors: assetErrors }
  }

  // 镜头时长返修校验（切片2b 规格 §4）：从 baseline.shotAxis（params.timeline 只读派生）判定有效边界，fail closed。
  //   无时轴快照 → 整体拒绝（不可判定 Σ）；shotId 不在段内 → bad_shot；命中视频镜（motion）→ unsupported_motion（Q2 显式拒绝，不静默 no-op）。
  const durationChanges = parsed.changes.filter(
    (c): c is Extract<ComposeInputChange, { kind: 'shot-duration' }> => c.kind === 'shot-duration',
  )
  const axisByShot = new Map(baseline.shotAxis.map((s) => [s.shotId, s]))
  if (durationChanges.length > 0) {
    const axisErrors: ComposeInputError[] = []
    if (baseline.shotAxis.length === 0) {
      axisErrors.push({ code: 'no_timeline_axis', message: '成片缺少时轴快照（params.timeline），无法判定镜头有效时长边界，时长返修不可用' })
    } else {
      for (const c of durationChanges) {
        const seg = axisByShot.get(c.shotId)
        if (!seg) { axisErrors.push({ code: 'bad_shot', message: `镜头 ${c.shotId} 不在成片时轴段内，无法覆盖其显示时长` }); continue }
        if (seg.kind === 'video') axisErrors.push({ code: 'unsupported_motion', message: `镜头 ${c.shotId} 为视频镜（motion），其时长返修属中档（文件级裁切），本切片未含` })
      }
    }
    if (axisErrors.length > 0) {
      const { requestId } = await registerBlocked({ baseline, stepKey, requestKey: p.requestKey, sessionId: p.sessionId, rawChanges: p.changes, errors: axisErrors })
      return { outcome: 'blocked', requestId, code: axisErrors[0]?.code ?? 'bad_shot', message: axisErrors[0]?.message ?? '时长返修校验失败', errors: axisErrors }
    }
  }

  const compiled = compileComposeInputChanges({ changes: parsed.changes, current })
  if (!compiled.ok) {
    const { requestId } = await registerBlocked({ baseline, stepKey, requestKey: p.requestKey, sessionId: p.sessionId, rawChanges: p.changes, errors: compiled.errors })
    return { outcome: 'blocked', requestId, code: compiled.errors[0]?.code ?? 'compile_failed', message: compiled.errors[0]?.message ?? '变更编译失败', errors: compiled.errors }
  }
  const { normalized } = compiled
  // 时长 diff 附有效边界（Σ = durSec - silenceSec = 该镜对齐语音时长；请求短于 Σ → 合成期强制落 Σ 并告警，音画不脱节）。
  // 同时检测「有效段长无变化」（含 clamp 落回原值）：若唯一变更均不改变入轴段长 → 整体 no_effect（规格 §3/§8#4）。
  let durationEffectiveChanged = false
  for (const d of normalized.diffs) {
    if (d.kind !== 'shot-duration') continue
    const seg = axisByShot.get(d.field)
    if (!seg) continue
    const sigma = Math.max(0, Math.round((seg.durSec - seg.silenceSec) * 1000) / 1000)
    const requested = typeof d.after === 'number' ? d.after : null
    if (requested == null) continue
    if (requested < sigma) {
      d.willClampToSec = sigma
      d.warn = true
    }
    const effectiveNew = Math.max(requested, sigma)
    if (Math.abs(effectiveNew - seg.durSec) > 1e-6) durationEffectiveChanged = true
  }
  const onlyDurations = normalized.diffs.length > 0 && normalized.diffs.every((d) => d.kind === 'shot-duration')
  if (onlyDurations && !durationEffectiveChanged) {
    const errs: ComposeInputError[] = [{ code: 'no_effect', message: '时长覆盖后的有效段长与当前入轴段长一致（含短于语音时长被强制回落），成片不会产生任何变化' }]
    const { requestId } = await registerBlocked({ baseline, stepKey, requestKey: p.requestKey, sessionId: p.sessionId, rawChanges: p.changes, errors: errs })
    return { outcome: 'blocked', requestId, code: 'no_effect', message: errs[0]!.message, errors: errs }
  }
  const previewHash = hashJson({ f: baseline.fingerprint, c: normalized.changes })
  const risks: string[] = [
    '将本地重新合成：不产生模型费用，但需编码时间，且不承诺逐字节一致（音频混合/时间轴已变，无字幕式关烧录快速路径）',
    '新版本需重新审阅：旧 gate 批准不自动沿用',
    '依赖指纹任一变（旁路改配置/换绑/上游重跑）→ 本预览过期须重算',
  ]
  if (durationChanges.length > 0) {
    risks.push('镜头显示时长受「音画不脱节」约束：请求短于该镜对齐语音时长时自动延长至语音时长（预览 willClampToSec/warn 已标注），不截断台词；仅图片镜适用')
  }
  const preview: ComposeInputPreview = {
    stepKey,
    baseFingerprint: baseline.fingerprint,
    previewHash,
    finalAssetId: baseline.finalAssetId,
    currentConfig: baseline.config,
    bgmAssetId: baseline.bgm.assetId,
    diffs: normalized.diffs,
    impact: {
      localReencode: true,
      modelCalls: 0,
      charged: false,
      resetSteps: [stepKey],
      keepNotes: ['源 BGM/SFX 资产不删除（换绑仅切换在用指针，历史可回溯）', '未涉及镜头的生成产物与 gen_task 不重置', '原成片保留为历史版本，不覆盖', '批准台词/分镜/时间轴不改（本闸不重生媒体）'],
      newReviewRequired: true,
    },
    risks,
  }

  const res = await upsertReworkRequest({
    projectId: baseline.projectId,
    runId: baseline.runId,
    stepKey,
    sessionId: p.sessionId ?? null,
    requestKey: p.requestKey,
    requestHash: previewRequestHash(baseline, stepKey, normalized.changes),
    state: 'ready',
    baseFingerprint: baseline.fingerprint,
    changes: normalized.changes,
    preview,
  })
  if (res.outcome === 'conflict') {
    return { outcome: 'conflict', requestId: res.row.id, code: 'idempotency_conflict', message: '同请求键已存在不同载荷的返修请求' }
  }
  if (res.outcome === 'replayed') {
    if (res.row.state === 'blocked') {
      const errs = ((JSON.parse(res.row.previewJson) as { errors?: ComposeInputError[] }).errors ?? []) as ComposeInputError[]
      return { outcome: 'blocked', requestId: res.row.id, code: errs[0]?.code ?? 'invalid_changes', message: errs[0]?.message ?? '变更无效', errors: errs }
    }
    const stored = JSON.parse(res.row.previewJson) as ComposeInputPreview
    return { outcome: 'replayed', requestId: res.row.id, preview: stored }
  }
  return { outcome: 'ready', requestId: res.row.id, preview }
}
