/**
 * [M11] run 级合成设置服务（BGM 绑定 + _compose 配置）。
 * - BGM 事实源：assets 行 {projectId, runId, kind='audio', purpose='bgm', deletedAt=null}
 *   （至多 1 条有效——绑定即软删旧行；复制行/上传两类来源）
 * - BGM 不走 refs 通道（run 级直查）：任意模板快照版本的 run 可用；产物 params.bgm 记录审计
 * - _compose：run.input JSON 下划线内部键（transition / transition_duration / bgm_volume / bgm_fade）
 * - run 状态校验：completed/failed（活跃/取消/其他一律拒绝——与工作台 assertRepairable 同语义）
 */
import { writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, pipelineRuns, type Asset, type PipelineRun } from '../db/schema'
import { WorkbenchError } from './shot-workbench'
import {
  absPathOf,
  ensureProjectDirs,
  kindByExt,
  mimeOfExt,
  registerAsset,
  relPathOf,
  sanitizeName,
  sha256Hex,
} from './storage'

/** 转场枚举（对齐 ffmpeg xfade 常用子集） */
export const TRANSITIONS = ['none', 'fade', 'fadeblack', 'slideleft', 'slideright', 'dissolve'] as const

/** run 级合成配置（run.input._compose；解析经 readComposeConfig） */
export interface ComposeConfig {
  transition?: string
  transition_duration?: number
  bgm_volume?: number
  bgm_fade?: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** run 可编辑性校验（completed/failed 才可改合成设置） */
async function requireEditableRun(runId: number): Promise<PipelineRun> {
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = rows[0]
  if (!run) throw new WorkbenchError('not_found', `run ${runId} 不存在`, 404)
  if (run.status === 'running' || run.status === 'queued' || run.status === 'waiting_input') {
    throw new WorkbenchError('run_active', `run 正在执行/排队（${run.status}），请等待收敛后再操作`)
  }
  if (run.status === 'cancelled') {
    throw new WorkbenchError('run_cancelled', 'run 已取消，请走「断点续跑」创建续跑 run')
  }
  if (run.status !== 'completed' && run.status !== 'failed') {
    throw new WorkbenchError('bad_status', `run 状态 ${run.status} 不支持合成设置`)
  }
  return run
}

/** run.input._compose 解析（损坏/缺省 → {}；ffmpeg-merge 亦复用） */
export function readComposeConfig(inputJson: string | null): ComposeConfig {
  if (!inputJson) return {}
  try {
    const obj = JSON.parse(inputJson) as { _compose?: unknown }
    const c = obj._compose
    if (c && typeof c === 'object' && !Array.isArray(c)) return c as ComposeConfig
    return {}
  } catch {
    return {}
  }
}

/** 当前 BGM 资产（本 run 最新有效行；合成期 ffmpeg-merge 消费） */
export async function loadBgmAsset(runId: number): Promise<Asset | null> {
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.runId, runId), eq(assets.purpose, 'bgm'), isNull(assets.deletedAt)))
    .orderBy(desc(assets.updatedAt))
    .limit(1)
  return rows[0] ?? null
}

/** 配置 + BGM 聚合读（GET 两端点共用） */
export async function getComposeConfig(runId: number): Promise<{ config: ComposeConfig; bgm: Asset | null }> {
  const run = await requireEditableRun(runId)
  const bgm = await loadBgmAsset(runId)
  return { config: readComposeConfig(run.input), bgm }
}

/** 配置合并写（字段白名单 + 枚举 + clamp；只动 _compose 键） */
export async function updateComposeConfig(runId: number, patch: Record<string, unknown>): Promise<ComposeConfig> {
  const run = await requireEditableRun(runId)
  const next: ComposeConfig = { ...readComposeConfig(run.input) }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'transition') {
      if (typeof value !== 'string' || !(TRANSITIONS as readonly string[]).includes(value)) {
        throw new WorkbenchError('bad_field', `transition 需为 ${TRANSITIONS.join('|')}`)
      }
      next.transition = value
      continue
    }
    if (key === 'transition_duration' || key === 'bgm_volume' || key === 'bgm_fade') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new WorkbenchError('bad_field', `${key} 需为数字`)
      }
      if (key === 'transition_duration') next.transition_duration = clamp(value, 0.1, 2)
      else if (key === 'bgm_volume') next.bgm_volume = clamp(value, 0, 1)
      else next.bgm_fade = clamp(value, 0, 2)
      continue
    }
    throw new WorkbenchError('bad_field', `未知配置键：${key}`)
  }
  let inputObj: Record<string, unknown>
  try {
    inputObj = JSON.parse(run.input) as Record<string, unknown>
  } catch {
    throw new WorkbenchError('bad_input', 'run.input 不是合法 JSON，无法写入合成配置')
  }
  inputObj['_compose'] = next
  await db
    .update(pipelineRuns)
    .set({ input: JSON.stringify(inputObj), updatedAt: Date.now() })
    .where(eq(pipelineRuns.id, run.id))
  return next
}

/** 软删该 run 全部有效 bgm 行（绑定替换/移除共用） */
async function softDeleteBgmRows(runId: number): Promise<void> {
  const now = Date.now()
  await db
    .update(assets)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(assets.runId, runId), eq(assets.purpose, 'bgm'), isNull(assets.deletedAt)))
}

/**
 * 上传绑定：kind 校验（audio）→ 软删旧行 → sha256 查重（命中复制行 / 未命中落盘 purpose=bgm 子目录）+ 建行。
 * 行属性：runId=本 run、stepId=null、params={source:'upload', original_name}。
 */
export async function bindBgmFromUpload(
  runId: number,
  file: { name: string; data: Uint8Array },
): Promise<Asset> {
  const run = await requireEditableRun(runId)
  const ext = extname(file.name)
  if (kindByExt(ext) !== 'audio') {
    throw new WorkbenchError('bad_kind', `文件类型不符（需音频，得到${ext ? ` ${ext}` : '未知类型'}）`)
  }
  const hash = sha256Hex(file.data)
  await softDeleteBgmRows(run.id)
  const existed = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, run.projectId), eq(assets.sha256, hash), isNull(assets.deletedAt)))
    .limit(1)
  const base = {
    name: file.name,
    kind: 'audio' as const,
    purpose: 'bgm',
    mime: mimeOfExt(ext),
    ext: ext.slice(1),
    sha256: hash,
    params: { source: 'upload', original_name: file.name },
    runId: run.id,
  }
  const src = existed[0]
  if (src && src.relPath) {
    return await registerAsset(run.projectId, {
      ...base,
      relPath: src.relPath,
      fileSize: src.fileSize ?? file.data.byteLength,
      duration: src.duration ?? undefined,
    })
  }
  ensureProjectDirs(run.projectId)
  const fileName = `${Date.now()}-${sanitizeName(file.name)}`
  const relPath = relPathOf(run.projectId, 'bgm', fileName)
  writeFileSync(absPathOf(relPath), file.data)
  return await registerAsset(run.projectId, { ...base, relPath, fileSize: file.data.byteLength })
}

/** 项目音频复制行绑定（relPath 复用；不污染源资产行） */
export async function bindBgmFromAsset(runId: number, assetId: number): Promise<Asset> {
  const run = await requireEditableRun(runId)
  const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  const a = rows[0]
  if (!a) throw new WorkbenchError('bad_asset', `资产 #${assetId} 不存在`)
  if (a.projectId !== run.projectId) throw new WorkbenchError('bad_asset', `资产 #${assetId} 不属于本项目`)
  if (a.deletedAt) throw new WorkbenchError('bad_asset', `资产 #${assetId} 已删除`)
  if (a.kind !== 'audio') throw new WorkbenchError('bad_asset', `资产 #${assetId} 类型不符（需 audio）`)
  if (!a.relPath) throw new WorkbenchError('bad_asset', `资产 #${assetId} 无文件（relPath 缺失）`)
  await softDeleteBgmRows(run.id)
  return await registerAsset(run.projectId, {
    name: a.name,
    kind: 'audio',
    purpose: 'bgm',
    mime: a.mime ?? undefined,
    ext: a.ext ?? undefined,
    sha256: a.sha256 ?? undefined,
    relPath: a.relPath,
    fileSize: a.fileSize ?? undefined,
    duration: a.duration ?? undefined,
    params: { source: 'asset', source_asset_id: assetId, original_name: a.name },
    runId: run.id,
  })
}

/** 移除 BGM（软删本 run 全部有效行） */
export async function removeBgm(runId: number): Promise<void> {
  await requireEditableRun(runId)
  await softDeleteBgmRows(runId)
}
