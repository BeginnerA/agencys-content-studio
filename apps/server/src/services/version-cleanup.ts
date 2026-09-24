import { statSync, unlinkSync } from 'node:fs'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, execInputs, pipelineRuns, pipelineSteps, type Asset } from '../db/schema'
import { createLogger } from '../logger'
import { absPathOf } from './storage'
import { thumbAbsPath } from './thumb'

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

export interface GcResult {
  /** 实际删除的文件数（原文件 + 缩略图缓存） */
  files: number
  /** 释放字节数 */
  freedBytes: number
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

/** 回收空间：删除项目内已软删资产的原文件 + 缩略图缓存；行保留（审计）；失败跳过、幂等 */
export async function gcProject(projectId: number): Promise<GcResult> {
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, projectId), isNotNull(assets.deletedAt)))
  let files = 0
  let freedBytes = 0
  for (const a of rows) {
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
  }
  log.info(`项目 #${projectId} 回收空间：${files} 个文件 / ${freedBytes} 字节`)
  return { files, freedBytes }
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
