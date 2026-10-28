/**
 * M69 审片问题单服务（design §4.5/§4.7）。
 * - 状态机唯一实现：open → in_rework → pending_recheck → verified，旁路 dismissed / reopened。
 * - 复检只调用 recheckScope 记录证据；verify 必须人工且三重匹配（携带成片 = 复检成片 = 当前成片）。
 * - 视图投影（can / needsRecheck / staleRecheck / currentLocation）由服务端计算，前端零推断。
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import {
  assets,
  pipelineRuns,
  pipelineSteps,
  reworkRequests,
  reviewFindings,
  type Asset,
  type PipelineRun,
  type ReviewFinding,
} from '../../db/schema'
import {
  categoryAllowsScope,
  parseFinalTimeline,
  resolveReviewFinal,
  shotRange,
  validateTimeRange,
  type FinalTimeline,
  type ReviewCategory,
  type ReviewScopeKind,
  type ReviewSeverity,
} from './scope'
import {
  buildBaseSnapshot,
  parseBaseSnapshot,
  parseTimelineAudio,
  type AssetShaLookup,
  type TimelineAudioInput,
} from './snapshot'
import { recheckScope, type RecheckState } from './recheck'

export class ReviewError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ReviewError'
  }
}

export const DEFAULT_STEP_KEY = 'compose'
const ACTIVE_STATUSES = new Set(['queued', 'running'])
const CATEGORIES: ReviewCategory[] = ['visual', 'prop', 'lip_sync', 'subtitle', 'audio', 'pacing', 'other']
const SEVERITIES: ReviewSeverity[] = ['blocker', 'major', 'minor']
const STATUSES = ['open', 'in_rework', 'pending_recheck', 'verified', 'dismissed'] as const
type ReviewStatus = (typeof STATUSES)[number]

/** 局部更新载荷：只允许 review_findings 的插入字段（id 等主键不会出现在调用点） */
type FindingPatch = Partial<typeof reviewFindings.$inferInsert>

export interface FindingCan {
  link: boolean
  markRework: boolean
  recheck: boolean
  verify: boolean
  reopen: boolean
  dismiss: boolean
}

export interface FindingLocation {
  startMs: number
  endMs: number
  inRange: boolean
}

export interface FindingView {
  id: number
  stepKey: string
  baseFinalAssetId: number
  /** 基准成片资产行仍存在且未删（决定「看返修前」是否可用；文件缺失另由播放器 error 兜底） */
  baseAvailable: boolean
  scopeKind: ReviewScopeKind
  shotId: string | null
  startMs: number | null
  endMs: number | null
  category: ReviewCategory
  severity: ReviewSeverity
  note: string
  status: ReviewStatus
  reworkRequestId: string | null
  reworkNote: string | null
  createdAt: number
  updatedAt: number
  resolvedAt: number | null
  recheck: { state: RecheckState; finalAssetId: number; note: string; at: number } | null
  resolutionNote: string | null
  needsRecheck: boolean
  staleRecheck: boolean
  currentLocation: FindingLocation | null
  can: FindingCan
}

export interface FindingsList {
  stepKey: string
  capability: {
    readable: boolean
    writable: boolean
    has_timeline: boolean
    code: 'ok' | 'run_active' | 'run_cancelled' | 'no_final' | 'degraded_no_timeline'
    message: string
  }
  final: { assetId: number; durationMs: number | null; createdAt: number } | null
  timeline: {
    totalMs: number
    introMs: number
    outroMs: number
    segments: Array<{ shotId: string | null; assetId: number | null; kind: string; startMs: number; endMs: number; durMs: number }>
  } | null
  findings: FindingView[]
  summary: {
    total: number
    open: number
    in_rework: number
    pending_recheck: number
    verified: number
    dismissed: number
    blockers_open: number
  }
}

type CapabilityCode = FindingsList['capability']['code']

const CAP_MESSAGE: Record<CapabilityCode, string> = {
  ok: '可记录问题并复检',
  run_active: '运行正在执行，暂不可审片；完成或取消后可记录',
  run_cancelled: '运行已取消，仅可查看与编辑描述',
  no_final: '当前步骤尚无成片，仅可查看历史问题单',
  degraded_no_timeline: '成片缺少时间轴快照：只能记录全片/时间范围问题，shot 范围不可用',
}

interface ReviewContext {
  run: PipelineRun
  stepKey: string
  final: Asset | null
  timeline: FinalTimeline | null
  audio: TimelineAudioInput | null
  assetSha: AssetShaLookup
  /** run 内仍存在且未删的资产 id（判基准成片是否还可见） */
  assetIds: Set<number>
  currentFinalId: number | null
  code: CapabilityCode
  writable: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const strOrUndef = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

function requireNote(v: unknown, field = 'note'): string {
  if (typeof v !== 'string') throw new ReviewError('note_required', `${field} 需为字符串`)
  const t = v.trim()
  if (!t) throw new ReviewError('note_required', `${field} 不能为空`)
  if (t.length > 2000) throw new ReviewError('note_required', `${field} 不能超过 2000 字符`)
  return t
}

function optionalNote(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  return requireNote(v)
}

function parseSeverity(v: unknown): ReviewSeverity {
  if (typeof v !== 'string' || !SEVERITIES.includes(v as ReviewSeverity)) {
    throw new ReviewError('bad_severity', `severity 需为 ${SEVERITIES.join('/')}`)
  }
  return v as ReviewSeverity
}

function parseCategory(v: unknown): ReviewCategory {
  if (typeof v !== 'string' || !CATEGORIES.includes(v as ReviewCategory)) {
    throw new ReviewError('bad_scope', `category 需为 ${CATEGORIES.join('/')}`)
  }
  return v as ReviewCategory
}

type ParsedScope =
  | { kind: 'shot'; shotId: string }
  | { kind: 'time'; startMs: number; endMs: number }
  | { kind: 'global' }

function parseScope(v: unknown): ParsedScope {
  if (!isObj(v)) throw new ReviewError('bad_scope', 'scope 需为对象')
  const kind = v['kind']
  if (kind === 'shot') {
    if (typeof v['shot_id'] !== 'string' || !v['shot_id']) throw new ReviewError('bad_scope', 'shot 范围需提供 shot_id')
    return { kind: 'shot', shotId: v['shot_id'] }
  }
  if (kind === 'time') {
    const startMs = v['start_ms']
    const endMs = v['end_ms']
    if (typeof startMs !== 'number' || typeof endMs !== 'number') throw new ReviewError('bad_scope', 'time 范围需提供 start_ms/end_ms')
    return { kind: 'time', startMs, endMs }
  }
  if (kind === 'global') return { kind: 'global' }
  throw new ReviewError('bad_scope', 'scope.kind 需为 shot/time/global')
}

async function loadRun(runId: number): Promise<PipelineRun> {
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  if (!rows[0]) throw new ReviewError('run_not_found', `运行 ${runId} 不存在`)
  return rows[0]
}

async function loadShaMap(ids: Array<number | null | undefined>): Promise<Map<number, string | null>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0))]
  if (!uniq.length) return new Map()
  const rows = await db.select({ id: assets.id, sha256: assets.sha256 }).from(assets).where(inArray(assets.id, uniq))
  return new Map(rows.map((r) => [r.id, r.sha256]))
}

async function loadContext(runId: number, stepKey: string): Promise<ReviewContext> {
  const run = await loadRun(runId)
  const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId))
  const runAssets = await db.select().from(assets).where(eq(assets.runId, runId))
  const resolved = resolveReviewFinal(steps, runAssets, stepKey)
  const final = resolved ? runAssets.find((a) => a.id === resolved.assetId) ?? null : null
  const timeline = final ? parseFinalTimeline(final.params) : null
  const audio = final ? parseTimelineAudio(final.params) : null

  const ids: Array<number | null> = [
    final?.id ?? null,
    ...(timeline?.segments.map((s) => s.assetId) ?? []),
    audio?.bgm?.assetId ?? null,
    ...(audio?.sfx.map((s) => s.assetId) ?? []),
  ]
  const shaMap = await loadShaMap(ids)
  const assetSha: AssetShaLookup = (id) => (id === null ? null : shaMap.get(id) ?? null)
  const assetIds = new Set(runAssets.filter((a) => a.deletedAt == null).map((a) => a.id))

  const code: CapabilityCode =
    run.status === 'cancelled'
      ? 'run_cancelled'
      : ACTIVE_STATUSES.has(run.status)
        ? 'run_active'
        : !final
          ? 'no_final'
          : !timeline
            ? 'degraded_no_timeline'
            : 'ok'

  return {
    run,
    stepKey,
    final,
    timeline,
    audio,
    assetSha,
    assetIds,
    currentFinalId: final?.id ?? null,
    code,
    writable: code === 'ok' || code === 'degraded_no_timeline',
  }
}

function locationOf(row: ReviewFinding, ctx: ReviewContext): FindingLocation | null {
  if (row.scopeKind === 'global') return null
  if (row.scopeKind === 'shot') {
    if (ctx.timeline && row.shotId) {
      const r = shotRange(ctx.timeline, row.shotId)
      if (r) return { ...r, inRange: true }
    }
    return row.startMs !== null && row.endMs !== null
      ? { startMs: row.startMs, endMs: row.endMs, inRange: false }
      : null
  }
  const total = ctx.timeline?.totalMs ?? (ctx.final?.duration != null ? Math.round(ctx.final.duration * 1000) : null)
  const inRange = total !== null && row.endMs !== null && row.endMs <= total
  return row.startMs !== null && row.endMs !== null
    ? { startMs: row.startMs, endMs: row.endMs, inRange }
    : null
}

function canOf(row: ReviewFinding, ctx: ReviewContext): FindingCan {
  // spec §4.5：cancelled 只能只读 + patch；run_active 只拦 create/recheck（apply 后要能立即 link），
  // 其余推进动作不因执行中而锁死。
  const cancelled = ctx.code === 'run_cancelled'
  const active = ctx.code === 'run_active'
  const hasFinal = ctx.currentFinalId !== null
  const status = row.status as ReviewStatus
  const pending = status === 'pending_recheck'
  return {
    link: !cancelled && (status === 'open' || status === 'in_rework'),
    markRework: !cancelled && (status === 'open' || status === 'in_rework'),
    recheck:
      !cancelled &&
      !active &&
      hasFinal &&
      (status === 'open' || status === 'in_rework' || pending) &&
      (pending ? row.recheckFinalAssetId !== ctx.currentFinalId : row.baseFinalAssetId !== ctx.currentFinalId),
    verify: !cancelled && pending && hasFinal && row.recheckFinalAssetId === ctx.currentFinalId,
    reopen: !cancelled && (status === 'verified' || status === 'dismissed' || status === 'in_rework'),
    dismiss: !cancelled && (status === 'open' || status === 'in_rework' || pending),
  }
}

function toView(row: ReviewFinding, ctx: ReviewContext): FindingView {
  return {
    id: row.id,
    stepKey: row.stepKey,
    baseFinalAssetId: row.baseFinalAssetId,
    baseAvailable: ctx.assetIds.has(row.baseFinalAssetId),
    scopeKind: row.scopeKind as ReviewScopeKind,
    shotId: row.shotId,
    startMs: row.startMs,
    endMs: row.endMs,
    category: row.category as ReviewCategory,
    severity: row.severity as ReviewSeverity,
    note: row.note,
    status: row.status as ReviewStatus,
    reworkRequestId: row.reworkRequestId,
    reworkNote: row.reworkNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    recheck:
      row.recheckState && row.recheckFinalAssetId !== null && row.recheckAt !== null
        ? {
            state: row.recheckState as RecheckState,
            finalAssetId: row.recheckFinalAssetId,
            note: row.recheckNote ?? '',
            at: row.recheckAt,
          }
        : null,
    resolutionNote: row.resolutionNote,
    needsRecheck: row.status === 'in_rework' && ctx.currentFinalId !== null && ctx.currentFinalId !== row.baseFinalAssetId,
    staleRecheck:
      row.status === 'pending_recheck' &&
      ctx.currentFinalId !== null &&
      row.recheckFinalAssetId !== null &&
      ctx.currentFinalId !== row.recheckFinalAssetId,
    currentLocation: locationOf(row, ctx),
    can: canOf(row, ctx),
  }
}

export async function listReviewFindings(runId: number, stepKey = DEFAULT_STEP_KEY): Promise<FindingsList> {
  const ctx = await loadContext(runId, stepKey)
  const rows = await db
    .select()
    .from(reviewFindings)
    .where(and(eq(reviewFindings.runId, runId), eq(reviewFindings.stepKey, stepKey)))
    .orderBy(desc(reviewFindings.createdAt), desc(reviewFindings.id))
  const findings = rows.map((r) => toView(r, ctx))
  const count = (s: ReviewStatus) => findings.filter((f) => f.status === s).length
  const durationMs =
    ctx.timeline?.totalMs ?? (ctx.final?.duration != null ? Math.round(ctx.final.duration * 1000) : null)

  return {
    stepKey,
    capability: {
      readable: true,
      writable: ctx.writable,
      has_timeline: ctx.timeline !== null,
      code: ctx.code,
      message: CAP_MESSAGE[ctx.code],
    },
    final: ctx.final
      ? { assetId: ctx.final.id, durationMs, createdAt: ctx.final.createdAt }
      : null,
    timeline: ctx.timeline
      ? {
          totalMs: ctx.timeline.totalMs,
          introMs: ctx.timeline.introMs,
          outroMs: ctx.timeline.outroMs,
          segments: ctx.timeline.segments.map((s) => ({
            shotId: s.shotId,
            assetId: s.assetId,
            kind: s.kind,
            startMs: s.startMs,
            endMs: s.endMs,
            durMs: s.durMs,
          })),
        }
      : null,
    findings,
    summary: {
      total: findings.length,
      open: count('open'),
      in_rework: count('in_rework'),
      pending_recheck: count('pending_recheck'),
      verified: count('verified'),
      dismissed: count('dismissed'),
      blockers_open: findings.filter((f) => f.severity === 'blocker' && f.status !== 'verified' && f.status !== 'dismissed').length,
    },
  }
}

async function getFinding(runId: number, fid: number): Promise<ReviewFinding> {
  const rows = await db.select().from(reviewFindings).where(eq(reviewFindings.id, fid)).limit(1)
  if (!rows[0] || rows[0].runId !== runId) throw new ReviewError('finding_not_found', `问题单 ${fid} 不存在`)
  return rows[0]
}

async function save(id: number, patch: FindingPatch): Promise<ReviewFinding> {
  const rows = await db
    .update(reviewFindings)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(reviewFindings.id, id))
    .returning()
  return rows[0]!
}

export async function createReviewFinding(
  runId: number,
  body: Record<string, unknown>,
): Promise<{ finding: FindingView; replayed: boolean }> {
  const stepKey = strOrUndef(body['step_key']) ?? DEFAULT_STEP_KEY
  const ctx = await loadContext(runId, stepKey)
  if (ctx.code === 'run_cancelled') throw new ReviewError('run_cancelled', '运行已取消，不能新增问题单')
  if (ctx.code === 'run_active') throw new ReviewError('run_active', '运行执行中不能新增问题单，请等待完成或取消')
  if (!ctx.final) throw new ReviewError('no_final', `步骤 ${stepKey} 当前没有成片`)

  const category = parseCategory(body['category'])
  const severity = parseSeverity(body['severity'])
  const note = requireNote(body['note'])
  const scope = parseScope(body['scope'])
  if (!categoryAllowsScope(category, scope.kind)) {
    throw new ReviewError('scope_category_mismatch', `类别 ${category} 不支持 ${scope.kind} 范围`)
  }

  let shotId: string | null = null
  let startMs: number | null = null
  let endMs: number | null = null
  if (scope.kind === 'shot') {
    if (!ctx.timeline) throw new ReviewError('no_timeline', '成片缺少时间轴快照，无法按镜头定位问题')
    const range = shotRange(ctx.timeline, scope.shotId)
    if (!range) throw new ReviewError('bad_scope', `镜头 ${scope.shotId} 不在当前成片时间轴`)
    shotId = scope.shotId
    startMs = range.startMs
    endMs = range.endMs
  } else if (scope.kind === 'time') {
    const fallback = ctx.final.duration != null ? Math.round(ctx.final.duration * 1000) : null
    const v = validateTimeRange(ctx.timeline, scope.startMs, scope.endMs, fallback)
    if (!v.ok) throw new ReviewError(v.code, v.message)
    startMs = scope.startMs
    endMs = scope.endMs
  }

  const clientKey = strOrUndef(body['client_key']) ?? null
  if (clientKey !== null && (clientKey.length === 0 || clientKey.length > 100)) {
    throw new ReviewError('bad_scope', 'client_key 需为 1-100 字符')
  }

  if (clientKey !== null) {
    const existing = (
      await db
        .select()
        .from(reviewFindings)
        .where(and(eq(reviewFindings.runId, runId), eq(reviewFindings.clientKey, clientKey)))
        .limit(1)
    )[0]
    if (existing) {
      const same =
        existing.stepKey === stepKey &&
        existing.category === category &&
        existing.severity === severity &&
        existing.note === note &&
        existing.scopeKind === scope.kind &&
        existing.shotId === shotId &&
        existing.startMs === startMs &&
        existing.endMs === endMs
      if (!same) throw new ReviewError('client_key_conflict', 'client_key 已被不同内容占用')
      return { finding: toView(existing, ctx), replayed: true }
    }
  }

  const snapshot = buildBaseSnapshot({
    stepKey,
    finalAssetId: ctx.final.id,
    finalSha256: ctx.final.sha256,
    timeline: ctx.timeline,
    scope,
    audio: ctx.audio,
    assetSha: ctx.assetSha,
  })
  const now = Date.now()
  const values = {
    projectId: ctx.run.projectId,
    runId,
    stepKey,
    baseFinalAssetId: ctx.final.id,
    clientKey,
    scopeKind: scope.kind,
    shotId,
    startMs,
    endMs,
    category,
    severity,
    note,
    status: 'open',
    baseSnapshot: JSON.stringify(snapshot),
    createdAt: now,
    updatedAt: now,
  }
  try {
    const row = (await db.insert(reviewFindings).values(values).returning())[0]!
    return { finding: toView(row, ctx), replayed: false }
  } catch (err) {
    // 并发首写碰撞：唯一索引兜底后复查，同载荷回放 / 异载荷冲突
    if (clientKey === null) throw err
    const raced = (
      await db
        .select()
        .from(reviewFindings)
        .where(and(eq(reviewFindings.runId, runId), eq(reviewFindings.clientKey, clientKey)))
        .limit(1)
    )[0]
    if (!raced) throw err
    const same =
      raced.stepKey === stepKey &&
      raced.category === category &&
      raced.severity === severity &&
      raced.note === note &&
      raced.scopeKind === scope.kind &&
      raced.shotId === shotId &&
      raced.startMs === startMs &&
      raced.endMs === endMs
    if (!same) throw new ReviewError('client_key_conflict', 'client_key 已被不同内容占用')
    return { finding: toView(raced, ctx), replayed: true }
  }
}

export async function patchReviewFinding(
  runId: number,
  fid: number,
  body: Record<string, unknown>,
): Promise<FindingView> {
  const row = await getFinding(runId, fid)
  const patch: FindingPatch = {}
  if (body['note'] !== undefined) patch.note = requireNote(body['note'])
  if (body['severity'] !== undefined) patch.severity = parseSeverity(body['severity'])
  if (!Object.keys(patch).length) return toView(row, await loadContext(runId, row.stepKey))
  const updated = await save(fid, patch)
  return toView(updated, await loadContext(runId, row.stepKey))
}

export async function linkFinding(
  runId: number,
  fid: number,
  body: Record<string, unknown>,
): Promise<FindingView> {
  const row = await getFinding(runId, fid)
  const ctx = await loadContext(runId, row.stepKey)
  if (ctx.code === 'run_cancelled') throw new ReviewError('run_cancelled', '运行已取消，不能关联返修')
  if (row.status !== 'open' && row.status !== 'in_rework') {
    throw new ReviewError('bad_transition', `状态 ${row.status} 不能关联返修`)
  }
  const requestId = body['request_id']
  if (typeof requestId !== 'string' || !requestId) throw new ReviewError('request_not_found', 'request_id 必填')
  const req = (await db.select().from(reworkRequests).where(eq(reworkRequests.id, requestId)).limit(1))[0]
  if (!req) throw new ReviewError('request_not_found', `返修请求 ${requestId} 不存在`)
  if (req.runId !== runId) throw new ReviewError('request_run_mismatch', '返修请求不属于该运行')
  if (req.stepKey !== row.stepKey) throw new ReviewError('bad_transition', `返修请求属于步骤 ${req.stepKey}，与问题单步骤 ${row.stepKey} 不一致`)
  if (req.state !== 'applied') throw new ReviewError('request_not_applied', `返修请求尚未应用（${req.state}）`)
  const updated = await save(fid, { status: 'in_rework', reworkRequestId: requestId })
  return toView(updated, ctx)
}

export async function markReworkFinding(
  runId: number,
  fid: number,
  body: Record<string, unknown>,
): Promise<FindingView> {
  const row = await getFinding(runId, fid)
  const ctx = await loadContext(runId, row.stepKey)
  if (ctx.code === 'run_cancelled') throw new ReviewError('run_cancelled', '运行已取消，不能标记返修')
  if (row.status !== 'open' && row.status !== 'in_rework') {
    throw new ReviewError('bad_transition', `状态 ${row.status} 不能标记返修`)
  }
  const note = optionalNote(body['note'])
  const updated = await save(fid, {
    status: 'in_rework',
    ...(note !== undefined ? { reworkNote: note } : {}),
  })
  return toView(updated, ctx)
}

export async function recheckFinding(runId: number, fid: number): Promise<FindingView> {
  const row = await getFinding(runId, fid)
  const ctx = await loadContext(runId, row.stepKey)
  if (ctx.code === 'run_cancelled') throw new ReviewError('run_cancelled', '运行已取消，不能复检')
  if (ctx.code === 'run_active') throw new ReviewError('run_active', '运行执行中，待新成片产出后再复检')
  if (!ctx.final) throw new ReviewError('no_final', `步骤 ${row.stepKey} 当前没有成片`)
  if (!['open', 'in_rework', 'pending_recheck'].includes(row.status)) {
    throw new ReviewError('bad_transition', `状态 ${row.status} 不能复检`)
  }
  const ref = row.status === 'pending_recheck' ? row.recheckFinalAssetId : row.baseFinalAssetId
  if (ctx.currentFinalId === ref) throw new ReviewError('final_unchanged', '成片未变化，无需复检')

  const snapshot = parseBaseSnapshot(row.baseSnapshot)
  const result = snapshot
    ? recheckScope({
        category: row.category as ReviewCategory,
        scopeKind: row.scopeKind as ReviewScopeKind,
        shotId: row.shotId,
        startMs: row.startMs,
        endMs: row.endMs,
        snapshot,
        timeline: ctx.timeline,
        audio: ctx.audio,
        assetSha: ctx.assetSha,
      })
    : { state: 'unverifiable' as const, note: '基准快照不可读，无法自动比对（需人工看片）' }

  const updated = await save(fid, {
    status: 'pending_recheck',
    recheckState: result.state,
    recheckFinalAssetId: ctx.currentFinalId,
    recheckNote: result.note,
    recheckAt: Date.now(),
  })
  return toView(updated, ctx)
}

export async function verifyFinding(
  runId: number,
  fid: number,
  body: Record<string, unknown>,
): Promise<FindingView> {
  const row = await getFinding(runId, fid)
  const ctx = await loadContext(runId, row.stepKey)
  if (ctx.code === 'run_cancelled') throw new ReviewError('run_cancelled', '运行已取消，不能终判')
  if (row.status !== 'pending_recheck') throw new ReviewError('bad_transition', `状态 ${row.status} 不是待复检`)
  const result = body['result']
  if (result !== 'verified' && result !== 'reopened') {
    throw new ReviewError('bad_result', 'result 需为 verified 或 reopened')
  }
  const finalAssetId = body['final_asset_id']
  if (typeof finalAssetId !== 'number' || !Number.isInteger(finalAssetId) || finalAssetId <= 0) {
    throw new ReviewError('bad_scope', 'final_asset_id 需为正整数')
  }
  if (ctx.currentFinalId !== row.recheckFinalAssetId) {
    throw new ReviewError('stale_recheck', '成片在复检后已再次变化，请重新复检')
  }
  if (finalAssetId !== ctx.currentFinalId) {
    throw new ReviewError('stale_final', '提交的成片与当前成片不一致，请刷新后重试')
  }
  const note = optionalNote(body['note'])
  const now = Date.now()
  const patch =
    result === 'verified'
      ? { status: 'verified', resolvedAt: now, resolutionNote: note ?? null }
      : { status: 'open', resolvedAt: null, resolutionNote: note ?? null }
  const updated = await save(fid, patch)
  return toView(updated, ctx)
}

export async function dismissFinding(
  runId: number,
  fid: number,
  body: Record<string, unknown>,
): Promise<FindingView> {
  const row = await getFinding(runId, fid)
  const ctx = await loadContext(runId, row.stepKey)
  if (ctx.code === 'run_cancelled') throw new ReviewError('run_cancelled', '运行已取消，不能忽略')
  if (!['open', 'in_rework', 'pending_recheck'].includes(row.status)) {
    throw new ReviewError('bad_transition', `状态 ${row.status} 不能忽略`)
  }
  const note = optionalNote(body['note'])
  const updated = await save(fid, {
    status: 'dismissed',
    resolvedAt: Date.now(),
    resolutionNote: note ?? null,
  })
  return toView(updated, ctx)
}

export async function reopenFinding(
  runId: number,
  fid: number,
  body: Record<string, unknown>,
): Promise<FindingView> {
  const row = await getFinding(runId, fid)
  const ctx = await loadContext(runId, row.stepKey)
  if (ctx.code === 'run_cancelled') throw new ReviewError('run_cancelled', '运行已取消，不能重开')
  if (!['verified', 'dismissed', 'in_rework'].includes(row.status)) {
    throw new ReviewError('bad_transition', `状态 ${row.status} 不能重开`)
  }
  const note = optionalNote(body['note'])
  const updated = await save(fid, {
    status: 'open',
    resolvedAt: null,
    resolutionNote: note ?? null,
  })
  return toView(updated, ctx)
}
