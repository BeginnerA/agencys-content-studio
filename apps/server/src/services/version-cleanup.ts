import { statSync, unlinkSync } from 'node:fs'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, execInputs, pipelineRuns, pipelineSteps, type Asset } from '../db/schema'
import { createLogger } from '../logger'
import { absPathOf } from './storage'
import { thumbAbsPath } from './thumb'
import { parseSubtitleEdits } from './rework/ledger'

// 旧版本清理 + 回收空间（物理 GC）。
// 清理保留规则（统一）：组内最新 / isFavorite / 被任意步骤 output.asset_ids 引用（在用）→ 保留；
// 其余未软删行 → deletedAt 软删（可回溯）。回收空间 = 对已软删资产删物理文件，不可逆、显式触发。

const log = createLogger('version-cleanup')

export interface CleanupResult {
  /** 处理的版本组数 */
  groups: number
  /** 本次软删的版本数 */
  cleaned: number
  /** 组内保留（最新/收藏/在用）总数 */
  kept: number
  cleanedIds: number[]
}

export interface EmptyTrashResult {
  /** 彻底删除的回收站条目数（物理删文件 + 硬删行） */
  purged: number
  /** 实际删除的文件数（原文件 + 缩略图缓存） */
  files: number
  /** 释放字节数 */
  freedBytes: number
  /** 被字幕引用保护而跳过的条目数（文件与记录保留，仍可还原） */
  skipped: number
}

/**
 * 版本组批量清理：范围 = projectId（+ 可选 runId/stepId 限定）。
 * 组定义：taskId 非空→ 同 taskId 一组；taskId 为空（上传）→ (runId, stepId, params.shotId) 一组。
 * 引用集始终按项目全量扫描（保守：任一 run 的选中产物都豁免）。
 */
export async function cleanupVersions(opts: { projectId: number; runId?: number; stepId?: number }): Promise<CleanupResult> {
  const conds = [
    eq(assets.projectId, opts.projectId),
    inArray(assets.kind, ['image', 'video']),
    isNull(assets.deletedAt),
  ]
  if (opts.runId !== undefined) conds.push(eq(assets.runId, opts.runId))
  if (opts.stepId !== undefined) conds.push(eq(assets.stepId, opts.stepId))
  const rows = await db.select().from(assets).where(and(...conds))
  if (rows.length === 0) return { groups: 0, cleaned: 0, kept: 0, cleanedIds: [] }

  const referenced = await referencedAssetIds(opts.projectId)

  const groups = new Map<string, Asset[]>()
  for (const a of rows) {
    const key = groupKeyOf(a)
    if (!key) continue
    const list = groups.get(key) ?? []
    list.push(a)
    groups.set(key, list)
  }

  const toClean: number[] = []
  let kept = 0
  for (const list of groups.values()) {
    let latest: Asset | null = null
    for (const a of list) {
      if (!latest || a.createdAt > latest.createdAt || (a.createdAt === latest.createdAt && a.id > latest.id)) latest = a
    }
    for (const a of list) {
      const isKept = a.id === latest!.id || a.isFavorite === 1 || referenced.has(a.id)
      if (isKept) kept += 1
      else toClean.push(a.id)
    }
  }

  if (toClean.length > 0) {
    await db
      .update(assets)
      .set({ deletedAt: Date.now(), updatedAt: Date.now() })
      .where(inArray(assets.id, toClean))
  }
  log.info(`项目 #${opts.projectId} 版本清理：组 ${groups.size}，清理 ${toClean.length}，保留 ${kept}`)
  return { groups: groups.size, cleaned: toClean.length, kept, cleanedIds: toClean }
}

/**
 * 字幕引用保护集（precision-rework 规格 §5.2-104：清理/删除纳入当前指针、历史成片与执行快照）：
 * ① 项目内所有 run 的 _subtitleEdits 指针 assetId（当前修订逻辑资产）；
 * ② 项目内所有成片（含已软删）params.timeline.subtitle 的 assetId 与 sourceRef.assetId
 *   （历史成片有效/源字幕仍被引用，文件不可物理消失）。
 * 纯读；版本文件（versions/）不在 gc 射程，此处保护的是资产工作副本 relPath。
 */
export async function subtitleReferenceIds(projectId: number): Promise<Set<number>> {
  const set = new Set<number>()
  const runs = await db.select({ input: pipelineRuns.input }).from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId))
  for (const r of runs) {
    for (const ref of Object.values(parseSubtitleEdits(r.input))) set.add(ref.assetId)
  }
  const finals = await db
    .select({ id: assets.id, params: assets.params })
    .from(assets)
    .where(and(eq(assets.projectId, projectId), eq(assets.purpose, 'final_video')))
  for (const f of finals) {
    if (!f.params) continue
    try {
      const p = JSON.parse(f.params) as Record<string, unknown>
      const sub = (p.timeline as Record<string, unknown> | undefined)?.subtitle as Record<string, unknown> | undefined
      if (!sub || typeof sub !== 'object') continue
      if (typeof sub.assetId === 'number') set.add(sub.assetId)
      const srcRef = sub.sourceRef as Record<string, unknown> | undefined
      if (srcRef && typeof srcRef.assetId === 'number') set.add(srcRef.assetId)
    } catch {
      /* 坏 params 跳过：既有消费侧容错语义 */
    }
  }
  return set
}

/**
 * 清空回收站（项目级，不可逆）：对回收站内未被字幕引用保护的条目执行批量「彻底删除」——
 * 物理删原文件 + 缩略图缓存并硬删数据行（与逐条 purgeAsset 同语义，条目从回收站消失）。
 * 仍被修订指针/历史成片字幕快照引用（含当前指针，规格 §5.2-104）的条目跳过：文件与记录保留，仍可还原。
 * 文件缺失/占用不阻塞其余条目；空回收站幂等（purged=0）。
 */
export async function emptyTrash(projectId: number): Promise<EmptyTrashResult> {
  const protectedIds = await subtitleReferenceIds(projectId)
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, projectId), isNotNull(assets.deletedAt)))
  let purged = 0
  let files = 0
  let freedBytes = 0
  let skipped = 0
  for (const a of rows) {
    if (protectedIds.has(a.id)) {
      skipped += 1
      continue
    }
    if (a.relPath) {
      const size = removeFile(absPathOf(a.relPath))
      if (size >= 0) {
        files += 1
        freedBytes += size
      }
    }
    const thumbSize = removeFile(thumbAbsPath(projectId, a.id))
    if (thumbSize >= 0) {
      files += 1
      freedBytes += thumbSize
    }
    await db.delete(assets).where(eq(assets.id, a.id))
    purged += 1
  }
  log.info(`项目 #${projectId} 清空回收站：彻底删除 ${purged} 条 / ${files} 个文件 / ${freedBytes} 字节；跳过（字幕引用）${skipped} 条`)
  return { purged, files, freedBytes, skipped }
}

/** 组键：任务组 t:<taskId>；上传组 u:<runId>:<stepId>:<shotId>；无组概念 → null（跳过） */
function groupKeyOf(a: Asset): string | null {
  if (a.taskId != null) return `t:${a.taskId}`
  const shotId = shotIdOf(a)
  if (!shotId) return null
  return `u:${a.runId ?? 0}:${a.stepId ?? 0}:${shotId}`
}

function shotIdOf(a: Asset): string | null {
  if (!a.params) return null
  try {
    const p = JSON.parse(a.params) as { shotId?: unknown }
    return typeof p.shotId === 'string' && p.shotId ? p.shotId : null
  } catch {
    return null
  }
}

/** 项目全量引用集：所有步骤 output.asset_ids 并集 ∪ 执行快照实际消费过的资产（保守豁免在用/历史依赖产物，防物理 GC 造成追溯悬空） */
async function referencedAssetIds(projectId: number): Promise<Set<number>> {
  const runRows = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId))
  const runIds = runRows.map((r) => r.id)
  const set = new Set<number>()
  // 追溯依赖：曾被任一次执行快照消费的资产行不物理删（否则历史影响指向空文件）
  const consumed = await db
    .select({ srcId: execInputs.srcId })
    .from(execInputs)
    .where(and(eq(execInputs.projectId, projectId), eq(execInputs.srcKind, 'asset')))
  for (const r of consumed) set.add(r.srcId)
  if (runIds.length === 0) return set
  const stepRows = await db
    .select({ output: pipelineSteps.output })
    .from(pipelineSteps)
    .where(inArray(pipelineSteps.runId, runIds))
  for (const s of stepRows) {
    if (!s.output) continue
    try {
      const o = JSON.parse(s.output) as { asset_ids?: unknown }
      if (!Array.isArray(o.asset_ids)) continue
      for (const v of o.asset_ids) {
        const n = Number(v)
        if (Number.isInteger(n) && n > 0) set.add(n)
      }
    } catch {
      /* 坏 JSON 跳过 */
    }
  }
  return set
}

/** 删除单个文件；返回释放字节数，文件不存在/占用 → -1（跳过） */
function removeFile(abs: string): number {
  try {
    const size = statSync(abs).size
    unlinkSync(abs)
    return size
  } catch {
    return -1
  }
}

/** 单个文件是否存在（还原前校验物理文件未被 GC 清除） */
function fileExists(abs: string): boolean {
  try { statSync(abs); return true } catch { return false }
}

/** 资产回收站领域错误（路由映射 HTTP 状态码：not_found→404 / bad_state|file_purged→409 / 其余→400） */
export class CleanupError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

/**
 * 回收站还原：清除软删标记（deletedAt→null）使资产重回列表。
 * 拒绝：未删除（幂等提示）；不存在（not_found）；磁盘文件已不存在 → 无法还原（否则会得到坏资产）。
 */
export async function restoreAsset(assetId: number): Promise<Asset> {
  const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  const a = rows[0]
  if (!a) throw new CleanupError('not_found', `资产 ${assetId} 不存在`)
  if (a.deletedAt === null) throw new CleanupError('bad_state', '该资产未被删除')
  if (a.relPath && !fileExists(absPathOf(a.relPath)))
    throw new CleanupError('file_purged', '该资产文件已被清除，无法还原')
  const updated = await db
    .update(assets)
    .set({ deletedAt: null, updatedAt: Date.now() })
    .where(eq(assets.id, assetId))
    .returning()
  log.info(`还原资产 #${assetId}`)
  return updated[0]!
}

/**
 * 回收站彻底删除（单条，不可逆）：物理删原文件 + 缩略图缓存，并硬删数据行。
 * 说明：项目级 emptyTrash 是本操作的批量版（同语义：删文件 + 硬删行；字幕引用保护条目跳过）。
 * 历史运行 / 画布对该 assetId 的软引用将变悬空（消费侧已按「已删除/不可用」容错）。
 */
export async function purgeAsset(assetId: number): Promise<{ files: number; freedBytes: number }> {
  const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  const a = rows[0]
  if (!a) throw new CleanupError('not_found', `资产 ${assetId} 不存在`)
  if ((await subtitleReferenceIds(a.projectId)).has(a.id)) {
    throw new CleanupError('referenced', '该字幕仍被修订指针或历史成片快照引用，拒绝彻底删除（避免重合成/追溯悬空）')
  }
  let files = 0
  let freedBytes = 0
  if (a.relPath) {
    const s = removeFile(absPathOf(a.relPath))
    if (s >= 0) {
      files += 1
      freedBytes += s
    }
  }
  const ts = removeFile(thumbAbsPath(a.projectId, a.id))
  if (ts >= 0) {
    files += 1
    freedBytes += ts
  }
  await db.delete(assets).where(eq(assets.id, assetId))
  log.info(`彻底删除资产 #${assetId}：${files} 文件 / ${freedBytes} 字节`)
  return { files, freedBytes }
}
