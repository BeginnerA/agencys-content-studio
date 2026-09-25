/**
 * 精确返修 · 操作台账与字幕版本持久化（precision-rework 规格 §5.1/§5.2）。
 *
 * - rework_requests：只记操作与幂等回执——同键同载荷回放已有状态/结果，异载荷返回
 *   idempotency_conflict（routes 层映射 409）；applied 为终态，回执不可改写。
 * - subtitle_display 逻辑资产：每 run/composeStep 一份独立工作副本，版本复用 provenance
 *   原语落 content_versions + versions/ 不可变文件（逻辑资产指向当前版本，不覆盖历史）；
 *   原 purpose=subtitle 源资产不动。版本 meta 白名单消毒，永不含 ASR validationHash——
 *   人工版本不冒充机器验证。
 * - run.input._subtitleEdits：受控内部键，仅本模块写入（通用 compose/config 白名单不可写；
 *   与 _compose 同法直写 input JSON，不经 prepareRunInput 过滤通道）。
 * 无任何供应商调用、不改引擎、不依赖路由层（领域错误由 P4/P5 映射 HTTP）。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import {
  assets,
  pipelineRuns,
  reworkRequests,
  type Asset,
  type ContentVersion,
  type ReworkRequest,
} from '../../db/schema'
import { absPathOf, ensureProjectDirs, registerAsset, sanitizeName, sha256Hex } from '../storage'
import { recordAssetTextVersion } from '../provenance'

export type ReworkState = 'parsing' | 'uncertain' | 'ready' | 'blocked' | 'applied'

export class ReworkLedgerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ReworkLedgerError'
  }
}

// ---------- 返修请求台账（§5.1） ----------

export interface UpsertReworkInput {
  projectId: number
  runId: number
  stepKey: string
  sessionId?: number | null
  requestKey: string
  /** 请求内容指纹（调用方对规范化 changes/payload 计算；幂等判定唯一依据） */
  requestHash: string
  baseFingerprint?: string | null
  state?: ReworkState
  changes?: unknown[]
  preview?: unknown
}

export type UpsertReworkResult =
  | { outcome: 'created'; row: ReworkRequest }
  | { outcome: 'replayed'; row: ReworkRequest }
  /** 同键不同载荷：routes 层映射 idempotency_conflict/409；row 为既有行（不被改写） */
  | { outcome: 'conflict'; row: ReworkRequest }

export async function findReworkRequest(runId: number, requestKey: string): Promise<ReworkRequest | null> {
  const rows = await db
    .select()
    .from(reworkRequests)
    .where(and(eq(reworkRequests.runId, runId), eq(reworkRequests.requestKey, requestKey)))
    .limit(1)
  return rows[0] ?? null
}

export async function getReworkRequest(requestId: string): Promise<ReworkRequest> {
  const rows = await db.select().from(reworkRequests).where(eq(reworkRequests.id, requestId)).limit(1)
  if (!rows[0]) throw new ReworkLedgerError('not_found', `返修请求 ${requestId} 不存在`)
  return rows[0]
}

function resolveExisting(existing: ReworkRequest, requestHash: string): UpsertReworkResult {
  return existing.requestHash === requestHash
    ? { outcome: 'replayed', row: existing }
    : { outcome: 'conflict', row: existing }
}

/** 幂等登记：唯一索引 (run_id, request_key)；并发首请求碰撞时复查后按回放/冲突收敛 */
export async function upsertReworkRequest(input: UpsertReworkInput): Promise<UpsertReworkResult> {
  const existing = await findReworkRequest(input.runId, input.requestKey)
  if (existing) return resolveExisting(existing, input.requestHash)
  const now = Date.now()
  const values = {
    id: randomUUID(),
    projectId: input.projectId,
    runId: input.runId,
    stepKey: input.stepKey,
    sessionId: input.sessionId ?? null,
    requestKey: input.requestKey,
    requestHash: input.requestHash,
    state: input.state ?? 'parsing',
    baseFingerprint: input.baseFingerprint ?? null,
    changesJson: JSON.stringify(input.changes ?? []),
    previewJson: JSON.stringify(input.preview ?? {}),
    resultJson: '{}',
    createdAt: now,
    updatedAt: now,
  }
  try {
    const rows = await db.insert(reworkRequests).values(values).returning()
    return { outcome: 'created', row: rows[0]! }
  } catch (err) {
    const raced = await findReworkRequest(input.runId, input.requestKey)
    if (!raced) throw err
    return resolveExisting(raced, input.requestHash)
  }
}

export interface ReworkStatePatch {
  changes?: unknown[]
  preview?: unknown
  result?: Record<string, unknown>
}

/**
 * 状态推进：applied 为终态——重复进入返回原回执（幂等回放），离开终态拒绝 terminal_state。
 * patch 只在提供对应字段时改写对应列（resultJson 由 apply 一次性固定，之后不可变）。
 */
export async function advanceReworkRequestState(
  requestId: string,
  to: ReworkState,
  patch: ReworkStatePatch = {},
): Promise<ReworkRequest> {
  const row = await getReworkRequest(requestId)
  if (row.state === 'applied') {
    if (to === 'applied') return row
    throw new ReworkLedgerError('terminal_state', '请求已应用（applied），回执不可改写')
  }
  const set: Record<string, unknown> = { state: to, updatedAt: Date.now() }
  if (patch.changes !== undefined) set['changesJson'] = JSON.stringify(patch.changes)
  if (patch.preview !== undefined) set['previewJson'] = JSON.stringify(patch.preview)
  if (patch.result !== undefined) set['resultJson'] = JSON.stringify(patch.result)
  const rows = await db.update(reworkRequests).set(set).where(eq(reworkRequests.id, requestId)).returning()
  return rows[0]!
}

// ---------- 显示字幕版本持久化（§5.2） ----------

/** 人工修订显示字幕逻辑资产 purpose（源 purpose=subtitle 永不改写） */
export const SUBTITLE_DISPLAY_PURPOSE = 'subtitle_display'

export function subtitleDisplayAssetName(runId: number, stepKey: string): string {
  return `subtitle-display-run${runId}-${stepKey}`
}

/**
 * 定位/创建本 run+composeStep 的显示字幕逻辑资产（幂等复用，同 _compose 直写通道语义）。
 * 新资产先落 initialContent 工作副本（texts/ 下，显式 relPath——不依赖 purposeSubDir 归类）。
 */
export async function ensureSubtitleDisplayAsset(p: {
  projectId: number
  runId: number
  stepKey: string
  initialContent: string
}): Promise<Asset> {
  const name = subtitleDisplayAssetName(p.runId, p.stepKey)
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.purpose, SUBTITLE_DISPLAY_PURPOSE), eq(assets.runId, p.runId), eq(assets.name, name)))
    .limit(1)
  if (rows[0]) return rows[0]
  ensureProjectDirs(p.projectId)
  const data = new TextEncoder().encode(p.initialContent)
  const relPath = join(String(p.projectId), 'texts', `${sanitizeName(name)}.srt`)
  writeFileSync(absPathOf(relPath), data)
  return registerAsset(p.projectId, {
    name,
    kind: 'text',
    purpose: SUBTITLE_DISPLAY_PURPOSE,
    relPath,
    mime: 'application/x-subrip',
    ext: 'srt',
    fileSize: data.byteLength,
    sha256: sha256Hex(data),
    runId: p.runId,
    params: { composeStepKey: p.stepKey },
    tags: ['subtitle_display'],
  })
}

/** 版本 meta 白名单字段（§5.2 全清单）；sanitize 丢弃一切未声明键——validationHash 从此处被挡住 */
export interface SubtitleVersionMeta {
  sourceSubtitleId: number | null
  sourceSha256: string | null
  baseFinalId: number | null
  baseFingerprint: string | null
  parentVersionId: number | null
  requestId: string | null
  cueIds: string[]
  changeSummary: string
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export function sanitizeSubtitleVersionMeta(meta: unknown): SubtitleVersionMeta {
  const m = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? (meta as Record<string, unknown>) : {}
  return {
    sourceSubtitleId: numOrNull(m['sourceSubtitleId']),
    sourceSha256: strOrNull(m['sourceSha256']),
    baseFinalId: numOrNull(m['baseFinalId']),
    baseFingerprint: strOrNull(m['baseFingerprint']),
    parentVersionId: numOrNull(m['parentVersionId']),
    requestId: strOrNull(m['requestId']),
    cueIds: Array.isArray(m['cueIds']) ? m['cueIds'].filter((x): x is string => typeof x === 'string') : [],
    changeSummary: typeof m['changeSummary'] === 'string' ? m['changeSummary'] : '',
  }
}

/** 工作副本更新（tmp+rename，与 provenance 还原同法）：逻辑资产始终指向当前版本内容 */
function writeDisplayWorkingCopy(asset: Asset, content: string): void {
  const data = new TextEncoder().encode(content)
  const abs = absPathOf(asset.relPath!)
  mkdirSync(dirname(abs), { recursive: true })
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, abs)
}

/**
 * 记录一个显示字幕版本：ensure 逻辑资产 → 写工作副本 → content_versions 不可变版本文件
 * （复用 recordAssetTextVersion，版本文件永不覆写）→ assets 行同步当前内容 hash。
 * baseline=首版（源内容登记），edit=人工修订版本；source 语义由调用方给出。
 * executor/asset 供 apply 事务内原子领用版本：事务失败时版本行回滚，未引用的
 * 不可变文件保留在盘上无害（不删除用户原文件，也不发布为当前版本）。
 */
export async function recordSubtitleDisplayVersion(p: {
  projectId: number
  runId: number
  stepKey: string
  content: string
  source: 'baseline' | 'edit'
  label?: string | null
  meta?: unknown
  executor?: Pick<typeof db, 'select' | 'insert' | 'update'>
  asset?: Asset
}): Promise<{ asset: Asset; version: ContentVersion }> {
  const executor = p.executor ?? db
  const asset = p.asset ?? (await ensureSubtitleDisplayAsset({
    projectId: p.projectId,
    runId: p.runId,
    stepKey: p.stepKey,
    initialContent: p.content,
  }))
  writeDisplayWorkingCopy(asset, p.content)
  const version = await recordAssetTextVersion({
    asset,
    content: p.content,
    source: p.source,
    label: p.label ?? null,
    meta: { ...sanitizeSubtitleVersionMeta(p.meta) },
    executor,
  })
  const data = new TextEncoder().encode(p.content)
  const updated = await executor
    .update(assets)
    .set({ fileSize: data.byteLength, sha256: sha256Hex(data), updatedAt: Date.now() })
    .where(eq(assets.id, asset.id))
    .returning()
  return { asset: updated[0]!, version }
}

// ---------- run.input._subtitleEdits 受控键（仅本模块可写） ----------

export const SUBTITLE_EDITS_KEY = '_subtitleEdits'

/** 某 composeStep 当前生效的人工修订指针：固定版本与基准依赖摘要（不可只按时间取最新资产） */
export interface SubtitleEditRef {
  assetId: number
  versionId: number
  sha256: string
  baseFingerprint: string
  requestId: string
}

const refShapeOk = (r: unknown): r is SubtitleEditRef => {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  const v = r as Record<string, unknown>
  return (
    numOrNull(v['assetId']) !== null &&
    numOrNull(v['versionId']) !== null &&
    typeof v['sha256'] === 'string' &&
    typeof v['baseFingerprint'] === 'string' &&
    typeof v['requestId'] === 'string'
  )
}

/** 纯解析（损坏/缺省 → {}；与 readComposeConfig 同容错语义，合成期读取不中断） */
export function parseSubtitleEdits(inputJson: string | null): Record<string, SubtitleEditRef> {
  if (!inputJson) return {}
  try {
    const obj = JSON.parse(inputJson) as Record<string, unknown>
    const raw = obj[SUBTITLE_EDITS_KEY]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, SubtitleEditRef> = {}
    for (const [stepKey, v] of Object.entries(raw as Record<string, unknown>)) {
      if (refShapeOk(v)) out[stepKey] = { assetId: v.assetId, versionId: v.versionId, sha256: v.sha256, baseFingerprint: v.baseFingerprint, requestId: v.requestId }
    }
    return out
  } catch {
    return {}
  }
}

export async function readSubtitleEdits(runId: number): Promise<Record<string, SubtitleEditRef>> {
  const rows = await db.select({ input: pipelineRuns.input }).from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  if (!rows[0]) throw new ReworkLedgerError('not_found', `运行 ${runId} 不存在`)
  return parseSubtitleEdits(rows[0].input)
}

/** 受控写入（专用服务通道）：只 merge 目标 stepKey 一条，保留 input 其余键（含 _compose） */
export async function writeSubtitleEdit(runId: number, stepKey: string, ref: SubtitleEditRef): Promise<void> {
  if (!refShapeOk(ref)) throw new ReworkLedgerError('invalid_ref', '_subtitleEdits 条目字段不完整')
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = rows[0]
  if (!run) throw new ReworkLedgerError('not_found', `运行 ${runId} 不存在`)
  let inputObj: Record<string, unknown>
  try {
    inputObj = JSON.parse(run.input) as Record<string, unknown>
  } catch {
    throw new ReworkLedgerError('bad_input', 'run.input 不是合法 JSON，无法写入字幕修订')
  }
  const prev = inputObj[SUBTITLE_EDITS_KEY]
  const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {}
  inputObj[SUBTITLE_EDITS_KEY] = { ...base, [stepKey]: ref }
  await db
    .update(pipelineRuns)
    .set({ input: JSON.stringify(inputObj), updatedAt: Date.now() })
    .where(eq(pipelineRuns.id, runId))
}
