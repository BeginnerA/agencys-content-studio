/**
 * [M29·R02] 通用追溯服务：内容/参考版本 + 执行真实输入快照 + 下游影响 + 版本还原。
 * 单一入口，供 asset-content / character / 各消费点 / routes/versions 调用。
 * 三条不变式：执行冻结真实输入；编辑不静默改写下游（影响只报告）；还原/锁版/选片三操作分离。
 * 设计边界：
 *  - content_versions 承载「可变对象」的版本链——可编辑文本资产（同 relPath 工作副本 + 不可变版本文件）
 *    与实体档案（无文件，doc JSON 快照）。媒体资产（图/视频/音）本身即不可变新行，无需 revision 链，
 *    其身份由 asset.id + sha256 冻结（exec_inputs.versionId=NULL，srcId 即版本身份）。
 *  - 所有物理文件写入走 versions/ 不可变目录；工作副本沿用同 relPath tmp+rename（不破坏 M25 探针与缓存 URL）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import {
  assets,
  canvasNodes,
  canvases,
  characters,
  contentVersions,
  execInputs,
  execSnapshots,
  type Asset,
  type ContentVersion,
  type ExecInput,
} from '../db/schema'
import { absPathOf, projectAbsDir, sha256Hex } from './storage'
import { parseNodeSpec, safeParseSpec } from './creation/spec'
import { createLogger } from '../logger'

const pvLog = createLogger('provenance')

/** 实体快照追踪字段（写入 content_versions.doc；与下游一致性/来源展示同源） */
const ENTITY_TRACKED = ['name', 'aliases', 'summary', 'appearance', 'negative', 'voice', 'states', 'refAssetIds', 'kind', 'projectId'] as const

export type ObjKind = 'asset' | 'entity'
export type VersionSource = 'baseline' | 'edit' | 'import' | 'generate' | 'ref-upload' | 'ref-gen' | 'polish' | 'restore'

export class ProvenanceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProvenanceError'
  }
}

/** 对象当前最新版本号（无版本返回 0） */
export async function currentRevision(objKind: ObjKind, objId: number): Promise<number> {
  const rows = await db
    .select({ revision: contentVersions.revision })
    .from(contentVersions)
    .where(and(eq(contentVersions.objKind, objKind), eq(contentVersions.objId, objId)))
    .orderBy(desc(contentVersions.revision))
    .limit(1)
  return rows[0]?.revision ?? 0
}

function versionFilePath(projectId: number, objId: number, revision: number, sha: string, ext: string): { abs: string; relPath: string } {
  const dir = join(projectAbsDir(projectId), 'versions')
  mkdirSync(dir, { recursive: true })
  const name = `v-asset-${objId}-${revision}-${sha.slice(0, 8)}.${ext || 'txt'}`
  return { abs: join(dir, name), relPath: join(String(projectId), 'versions', name) }
}

/**
 * 记录文本资产内容版本：写不可变版本文件 + content_versions 行（payloadKind=file）。
 * 调用方保证 content 已通过内容守卫（见 asset-content）。返回新版本行。
 */
export async function recordAssetTextVersion(p: {
  asset: Asset
  content: string
  source: VersionSource
  label?: string | null
  meta?: Record<string, unknown>
}): Promise<ContentVersion> {
  const { asset, content, source } = p
  const data = new TextEncoder().encode(content)
  const sha = sha256Hex(data)
  const revision = (await currentRevision('asset', asset.id)) + 1
  const { abs, relPath } = versionFilePath(asset.projectId, asset.id, revision, sha, asset.ext ?? 'txt')
  writeFileSync(abs, data)
  const now = Date.now()
  const rows = await db
    .insert(contentVersions)
    .values({
      projectId: asset.projectId,
      objKind: 'asset',
      objId: asset.id,
      revision,
      payloadKind: 'file',
      relPath,
      sha256: sha,
      doc: null,
      label: p.label ?? null,
      source,
      meta: JSON.stringify(p.meta ?? {}),
      createdAt: now,
    })
    .returning()
  return rows[0]!
}

/**
 * 懒补 baseline：可编辑文本资产首次编辑前，若版本链为空则把「当前工作副本内容」登记为 revision 1（baseline）。
 * 返回补登后的最新版本号（无文件时原样返回当前版本数）。
 */
export async function ensureAssetTextBaseline(assetId: number): Promise<number> {
  const existing = await currentRevision('asset', assetId)
  if (existing > 0) return existing
  const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  const a = rows[0]
  if (!a || a.kind !== 'text' || !a.relPath) return existing
  let content: string
  try {
    content = readFileSync(absPathOf(a.relPath), 'utf8')
  } catch {
    return existing // 文件缺失：不伪造 baseline
  }
  await recordAssetTextVersion({ asset: a, content, source: 'baseline', label: '初始内容' })
  return 1
}

/** 实体档案版本（无文件，payloadKind=json，doc 存追踪字段快照）。 */
export async function recordEntityVersion(p: {
  entityId: number
  projectId: number | null
  source: VersionSource
  label?: string | null
}): Promise<ContentVersion> {
  const rows = await db.select().from(characters).where(eq(characters.id, p.entityId)).limit(1)
  const e = rows[0]
  if (!e) throw new ProvenanceError('not_found', `实体 ${p.entityId} 不存在`)
  const doc: Record<string, unknown> = {}
  for (const f of ENTITY_TRACKED) doc[f] = e[f]
  const json = JSON.stringify(doc)
  const sha = createHash('sha256').update(json).digest('hex')
  const revision = (await currentRevision('entity', p.entityId)) + 1
  const now = Date.now()
  const inserted = await db
    .insert(contentVersions)
    .values({
      projectId: p.projectId ?? e.projectId ?? 0,
      objKind: 'entity',
      objId: p.entityId,
      revision,
      payloadKind: 'json',
      relPath: null,
      sha256: sha,
      doc: json,
      label: p.label ?? null,
      source: p.source,
      meta: '{}',
      createdAt: now,
    })
    .returning()
  return inserted[0]!
}

/** 校验版本归属（防跨对象读取/还原）：返回该版本行或抛 not_found/mismatch。 */
export async function assertVersionOwned(versionId: number, objKind: ObjKind, objId: number): Promise<ContentVersion> {
  const rows = await db.select().from(contentVersions).where(eq(contentVersions.id, versionId)).limit(1)
  const v = rows[0]
  if (!v) throw new ProvenanceError('not_found', `版本 ${versionId} 不存在`)
  if (v.objKind !== objKind || v.objId !== objId) throw new ProvenanceError('forbidden', '版本不属于该对象')
  return v
}

/** 对象版本列表（新→旧）。 */
export async function listVersions(objKind: ObjKind, objId: number): Promise<ContentVersion[]> {
  return db
    .select()
    .from(contentVersions)
    .where(and(eq(contentVersions.objKind, objKind), eq(contentVersions.objId, objId)))
    .orderBy(desc(contentVersions.revision))
}

/** 读取指定版本内容：file → 文本；json → 快照对象。 */
export async function readVersionContent(versionId: number): Promise<{ kind: 'text'; text: string } | { kind: 'json'; doc: Record<string, unknown> }> {
  const rows = await db.select().from(contentVersions).where(eq(contentVersions.id, versionId)).limit(1)
  const v = rows[0]
  if (!v) throw new ProvenanceError('not_found', `版本 ${versionId} 不存在`)
  if (v.payloadKind === 'file') {
    if (!v.relPath) throw new ProvenanceError('no_file', `版本 ${versionId} 无文件指针`)
    try {
      return { kind: 'text', text: readFileSync(absPathOf(v.relPath), 'utf8') }
    } catch {
      throw new ProvenanceError('file_missing', '版本文件已缺失（历史不可恢复）')
    }
  }
  return { kind: 'json', doc: JSON.parse(v.doc ?? '{}') as Record<string, unknown> }
}

/**
 * 还原文本资产到指定历史版本：把版本内容复制回工作副本（同 relPath tmp+rename），
 * 生成一条新 revision（source='restore'），移动当前指针、保留全部历史；清空 embedding 待重建。
 * 不改写任何下游产物。
 */
export async function restoreAssetTextVersion(assetId: number, versionId: number): Promise<Asset> {
  const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  const a = rows[0]
  if (!a) throw new ProvenanceError('not_found', `资产 ${assetId} 不存在`)
  if (a.kind !== 'text' || !a.relPath) throw new ProvenanceError('bad_kind', '仅文本资产可还原版本')
  const content = await readVersionContent(versionId)
  if (content.kind !== 'text') throw new ProvenanceError('bad_version', '目标版本非文本内容版本')
  const data = new TextEncoder().encode(content.text)
  const abs = absPathOf(a.relPath)
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, abs)
  await recordAssetTextVersion({ asset: a, content: content.text, source: 'restore', label: `还原自版本 ${versionId}` })
  const now = Date.now()
  const updated = await db
    .update(assets)
    .set({ fileSize: data.byteLength, sha256: sha256Hex(data), embedding: null, embeddingModel: null, updatedAt: now })
    .where(eq(assets.id, assetId))
    .returning()
  return updated[0]!
}

/** 还原实体档案到指定历史版本：应用快照字段 + 生成新版本（source='restore'）。 */
export async function restoreEntityVersion(entityId: number, versionId: number): Promise<void> {
  const content = await readVersionContent(versionId)
  if (content.kind !== 'json') throw new ProvenanceError('bad_version', '目标版本非实体快照')
  const doc = content.doc
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  for (const f of ENTITY_TRACKED) {
    if (f === 'projectId') continue // 归属不随版本还原迁移
    if (doc[f] !== undefined) patch[f === 'refAssetIds' ? 'refAssetIds' : f] = doc[f]
  }
  await db.update(characters).set(patch).where(eq(characters.id, entityId))
  await recordEntityVersion({ entityId, projectId: null, source: 'restore', label: `还原自版本 ${versionId}` })
}

// ---------- 执行真实输入快照 ----------

export interface ExecInputSpec {
  role: string
  srcKind: ObjKind
  srcId: number
  versionId?: number | null
  used?: boolean
  skipReason?: string | null
  shotId?: string | null
  port?: string | null
  ordinal?: number
}

export interface ExecSnapshotSpec {
  projectId: number
  execKind: 'pipeline_step' | 'canvas_task' | 'shot_task'
  runId?: number | null
  stepId?: number | null
  taskId?: number | null
  templateKey?: string | null
  model?: string | null
  inputs: ExecInputSpec[]
}

/** 记录一次执行快照 + 其全部实际输入依赖边（一个事务式批量写；返回 snapshotId）。 */
export async function recordExecSnapshot(p: ExecSnapshotSpec): Promise<number> {
  const now = Date.now()
  const hash = inputHashOf(p.inputs)
  const snap = await db
    .insert(execSnapshots)
    .values({
      projectId: p.projectId,
      execKind: p.execKind,
      runId: p.runId ?? null,
      stepId: p.stepId ?? null,
      taskId: p.taskId ?? null,
      templateKey: p.templateKey ?? null,
      model: p.model ?? null,
      inputHash: hash,
      frozenAt: now,
      createdAt: now,
    })
    .returning()
  const snapshotId = snap[0]!.id
  if (p.inputs.length > 0) {
    await db.insert(execInputs).values(
      p.inputs.map((i) => ({
        snapshotId,
        projectId: p.projectId,
        role: i.role,
        srcKind: i.srcKind,
        srcId: i.srcId,
        versionId: i.versionId ?? null,
        used: i.used === false ? 0 : 1,
        skipReason: i.skipReason ?? null,
        shotId: i.shotId ?? null,
        port: i.port ?? null,
        ordinal: i.ordinal ?? 0,
        createdAt: now,
      })),
    )
  }
  return snapshotId
}

function inputHashOf(inputs: ExecInputSpec[]): string {
  const canon = inputs
    .map((i) => `${i.role}:${i.srcKind}:${i.srcId}:${i.versionId ?? '-'}:${i.used === false ? 0 : 1}`)
    .sort()
    .join('|')
  return createHash('sha256').update(canon).digest('hex').slice(0, 32)
}

/**
 * 安全记录执行快照：任何异常仅告警，绝不影响实际生成（R02 零行为变更红线）。
 * 所有消费点接入一律经此入口，不裸调 recordExecSnapshot。
 */
export async function safeRecordExecSnapshot(p: ExecSnapshotSpec): Promise<void> {
  try {
    await recordExecSnapshot(p)
  } catch (err) {
    pvLog.warn(`执行快照记录失败（已忽略，不影响生成）：${(err as Error).message}`)
  }
}

/** 构造一个资产输入边（自动解析版本指针：文本可编辑资产带 versionId，媒体资产 versionId=null 身份即 asset.id）。 */
export async function assetInput(
  role: string,
  assetId: number,
  opts: { used?: boolean; skipReason?: string | null; shotId?: string | null; port?: string | null; ordinal?: number } = {},
): Promise<ExecInputSpec> {
  return {
    role,
    srcKind: 'asset',
    srcId: assetId,
    versionId: await versionIdForAsset(assetId),
    used: opts.used !== false,
    skipReason: opts.skipReason ?? null,
    shotId: opts.shotId ?? null,
    port: opts.port ?? null,
    ordinal: opts.ordinal ?? 0,
  }
}

/** 构造一个实体输入边（自动解析实体版本指针）。 */
export async function entityInput(
  role: string,
  entityId: number,
  opts: { used?: boolean; skipReason?: string | null; shotId?: string | null; port?: string | null; ordinal?: number } = {},
): Promise<ExecInputSpec> {
  return {
    role,
    srcKind: 'entity',
    srcId: entityId,
    versionId: await versionIdForEntity(entityId),
    used: opts.used !== false,
    skipReason: opts.skipReason ?? null,
    shotId: opts.shotId ?? null,
    port: opts.port ?? null,
    ordinal: opts.ordinal ?? 0,
  }
}

/** 解析资产当前应冻结的版本号（文本可编辑资产有版本链；媒体无 → null）。 */
export async function versionIdForAsset(assetId: number): Promise<number | null> {
  const rows = await db
    .select({ id: contentVersions.id })
    .from(contentVersions)
    .where(and(eq(contentVersions.objKind, 'asset'), eq(contentVersions.objId, assetId)))
    .orderBy(desc(contentVersions.revision))
    .limit(1)
  return rows[0]?.id ?? null
}

/** 解析实体当前应冻结的版本号。 */
export async function versionIdForEntity(entityId: number): Promise<number | null> {
  const rows = await db
    .select({ id: contentVersions.id })
    .from(contentVersions)
    .where(and(eq(contentVersions.objKind, 'entity'), eq(contentVersions.objId, entityId)))
    .orderBy(desc(contentVersions.revision))
    .limit(1)
  return rows[0]?.id ?? null
}

export interface ExecutionInputView extends ExecInput {
  versionRevision: number | null
}

/** 某次执行（按 snapshot / task / step）当时的实际输入清单（含版本序号）。 */
export async function getExecutionInputs(where: { snapshotId?: number; taskId?: number; stepId?: number }): Promise<{ snapshotId: number; inputs: ExecutionInputView[] } | null> {
  let snapId = where.snapshotId ?? null
  if (snapId == null && where.taskId != null) {
    const s = await db.select().from(execSnapshots).where(eq(execSnapshots.taskId, where.taskId)).orderBy(desc(execSnapshots.id)).limit(1)
    snapId = s[0]?.id ?? null
  }
  if (snapId == null && where.stepId != null) {
    const s = await db.select().from(execSnapshots).where(eq(execSnapshots.stepId, where.stepId)).orderBy(desc(execSnapshots.id)).limit(1)
    snapId = s[0]?.id ?? null
  }
  if (snapId == null) return null
  const rows = await db.select().from(execInputs).where(eq(execInputs.snapshotId, snapId)).orderBy(execInputs.ordinal, execInputs.id)
  const versionIds = [...new Set(rows.map((r) => r.versionId).filter((x): x is number => x != null))]
  const revMap = new Map<number, number>()
  if (versionIds.length > 0) {
    const vs = await db.select().from(contentVersions).where(inArray(contentVersions.id, versionIds))
    for (const v of vs) revMap.set(v.id, v.revision)
  }
  return { snapshotId: snapId, inputs: rows.map((r) => ({ ...r, versionRevision: r.versionId != null ? revMap.get(r.versionId) ?? null : null })) }
}

export interface ImpactRow {
  snapshotId: number
  execKind: string
  runId: number | null
  stepId: number | null
  taskId: number | null
  role: string
  shotId: string | null
  used: number
  versionRevision: number | null
  currentRevision: number
  /** 捕获版本落后于当前版本 → 上游已变更；无版本指针 → 历史不可恢复 */
  status: 'upstream_changed' | 'current' | 'no_history'
  frozenAt: number
}

/**
 * 下游影响：给定对象（asset/entity），反查消费它的执行，标出「上游已变更 / 当前一致 / 历史不可恢复」。
 * 只报告不生成——返回清单供 UI 引导用户按范围决策。
 */
export async function downstreamImpact(p: { objKind: ObjKind; objId: number }): Promise<ImpactRow[]> {
  const cur = await currentRevision(p.objKind, p.objId)
  const rows = await db
    .select()
    .from(execInputs)
    .where(and(eq(execInputs.srcKind, p.objKind), eq(execInputs.srcId, p.objId)))
    .orderBy(desc(execInputs.id))
  if (rows.length === 0) return []
  const snapIds = [...new Set(rows.map((r) => r.snapshotId))]
  const snaps = await db.select().from(execSnapshots).where(inArray(execSnapshots.id, snapIds))
  const snapMap = new Map(snaps.map((s) => [s.id, s]))
  const versionIds = [...new Set(rows.map((r) => r.versionId).filter((x): x is number => x != null))]
  const revMap = new Map<number, number>()
  if (versionIds.length > 0) {
    const vs = await db.select().from(contentVersions).where(inArray(contentVersions.id, versionIds))
    for (const v of vs) revMap.set(v.id, v.revision)
  }
  return rows.map((r) => {
    const snap = snapMap.get(r.snapshotId)
    const capRev = r.versionId != null ? revMap.get(r.versionId) ?? null : null
    const status: ImpactRow['status'] = capRev == null ? 'no_history' : capRev < cur ? 'upstream_changed' : 'current'
    return {
      snapshotId: r.snapshotId,
      execKind: snap?.execKind ?? 'unknown',
      runId: snap?.runId ?? null,
      stepId: snap?.stepId ?? null,
      taskId: snap?.taskId ?? null,
      role: r.role,
      shotId: r.shotId,
      used: r.used,
      versionRevision: capRev,
      currentRevision: cur,
      status,
      frozenAt: snap?.frozenAt ?? r.createdAt,
    }
  })
}

// ---------- [M29·R02] 锁定下次执行输入（三操作分离之「锁版」） ----------
// 语义：把某生成节点对指定上游节点的消费输入钉到某个历史产物资产，仅在「下一次执行」生效，
// 走既有 loadInputPlan 的 spec.pin 解析（缺省仍走最新/采纳）。与「采用历史产物」(adoptedTaskId 选片)、
// 「还原内容版本」互不混淆——不改选片、不改内容、不触发生成。

export interface InputLockView {
  upstreamNodeId: number
  assetId: number
}

/** 载入可锁定的生成节点及其所属项目（非 gen 节点 / 缺画布 → 抛错）。 */
async function loadLockableNode(nodeId: number): Promise<{ specRaw: string | null; canvasId: number; projectId: number }> {
  const nodes = await db.select().from(canvasNodes).where(eq(canvasNodes.id, nodeId)).limit(1)
  const node = nodes[0]
  if (!node) throw new ProvenanceError('not_found', `节点 ${nodeId} 不存在`)
  if (node.kind !== 'gen') throw new ProvenanceError('bad_node', '仅生成节点支持锁定输入')
  const cs = await db.select({ projectId: canvases.projectId }).from(canvases).where(eq(canvases.id, node.canvasId)).limit(1)
  const canvas = cs[0]
  if (!canvas) throw new ProvenanceError('not_found', `画布 ${node.canvasId} 不存在`)
  return { specRaw: node.spec ?? null, canvasId: node.canvasId, projectId: canvas.projectId }
}

/** 当前锁定清单（脏 spec 容错；不抛）。 */
export async function listCanvasInputLocks(nodeId: number): Promise<InputLockView[]> {
  const { specRaw } = await loadLockableNode(nodeId)
  const pin = safeParseSpec(specRaw ?? '').spec?.pin ?? {}
  return Object.entries(pin)
    .map(([k, v]) => ({ upstreamNodeId: Number(k), assetId: v }))
    .filter((e) => Number.isInteger(e.upstreamNodeId) && e.upstreamNodeId > 0)
}

/** 锁定/更新生成节点对某上游节点的输入资产（写 spec.pin，下次执行生效）。 */
export async function lockCanvasInput(nodeId: number, upstreamNodeId: number, assetId: number): Promise<InputLockView[]> {
  if (!Number.isInteger(upstreamNodeId) || upstreamNodeId <= 0) throw new ProvenanceError('bad_input', 'upstreamNodeId 需为正整数')
  if (!Number.isInteger(assetId) || assetId <= 0) throw new ProvenanceError('bad_input', 'assetId 需为正整数')
  const { specRaw, canvasId, projectId } = await loadLockableNode(nodeId)
  const up = await db
    .select({ id: canvasNodes.id })
    .from(canvasNodes)
    .where(and(eq(canvasNodes.id, upstreamNodeId), eq(canvasNodes.canvasId, canvasId)))
    .limit(1)
  if (!up.length) throw new ProvenanceError('bad_input', '上游节点不存在或不在同一画布')
  const arows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.projectId, projectId), isNull(assets.deletedAt)))
    .limit(1)
  if (!arows.length) throw new ProvenanceError('bad_input', '锁定资产不存在或不属于本项目')
  const parsed = parseNodeSpec(JSON.parse(specRaw ?? '{}'))
  parsed.pin = { ...(parsed.pin ?? {}), [String(upstreamNodeId)]: assetId }
  await db.update(canvasNodes).set({ spec: JSON.stringify(parsed), updatedAt: Date.now() }).where(eq(canvasNodes.id, nodeId))
  return listCanvasInputLocks(nodeId)
}

/** 解除某上游节点的锁定（回落最新/采纳）。 */
export async function unlockCanvasInput(nodeId: number, upstreamNodeId: number): Promise<InputLockView[]> {
  if (!Number.isInteger(upstreamNodeId) || upstreamNodeId <= 0) throw new ProvenanceError('bad_input', 'upstreamNodeId 需为正整数')
  const { specRaw } = await loadLockableNode(nodeId)
  const parsed = parseNodeSpec(JSON.parse(specRaw ?? '{}'))
  if (parsed.pin) {
    delete parsed.pin[String(upstreamNodeId)]
    if (Object.keys(parsed.pin).length === 0) delete parsed.pin
  }
  await db.update(canvasNodes).set({ spec: JSON.stringify(parsed), updatedAt: Date.now() }).where(eq(canvasNodes.id, nodeId))
  return listCanvasInputLocks(nodeId)
}
