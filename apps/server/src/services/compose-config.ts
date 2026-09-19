/**
 * [M11] run 级合成设置服务（BGM 绑定 + _compose 配置）。
 * - BGM 事实源：assets 行 {projectId, runId, kind='audio', purpose='bgm', deletedAt=null}
 *   （至多 1 条有效——绑定即软删旧行；复制行/上传两类来源）
 * - BGM 默认不走 refs 通道（run 级直查）：任意模板快照版本的 run 可用；产物 params.bgm 记录审计
 *   （[M31] 例外：严格交付下仅当批准方案含 role:'bgm' ref 时按该 assetId 窄口径 opt-in 消费）
 * - _compose：run.input JSON 下划线内部键（transition / transition_duration / bgm_volume / bgm_fade / brand / multi_aspect）
 * - [M19] brand：品牌 run 级覆盖（字段级合并到平台/项目层；槽值 null = 清除该槽覆盖回落继承）
 * - [M19] SFX：per-shot 音效（purpose='sfx'，params.shotId 为键；每镜 ≤1 条有效；_compose.sfx_volume clamp 0–2）
 * - [M19] multi_aspect：多画幅原生渲染（enabled + aspects 1–3 + strategy crop|pad；未启用 → 合成链逐字节不变）
 * - run 状态校验：completed/failed（活跃/取消/其他一律拒绝——与工作台 assertRepairable 同语义）
 */
import { writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, pipelineRuns, type Asset, type PipelineRun } from '../db/schema'
import { WorkbenchError } from './shot'
import { mergeBrand, normalizeBrandPatch, type BrandConfig } from './brand-config'
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

/** [M19] 派生画幅枚举（主画幅之外的常用发布比例） */
export const ASPECTS = ['9:16', '1:1', '4:5', '16:9'] as const
/** [M19] 画幅适配策略：crop 居中裁切（不留边）| pad 等比缩放补黑边 */
export const ASPECT_STRATEGIES = ['crop', 'pad'] as const

/** [M19] 多画幅原生渲染配置（_compose.multi_aspect；aspects 去重后 1–3 项） */
export interface MultiAspectConfig {
  enabled: boolean
  aspects: string[]
  strategy: 'crop' | 'pad'
}

/** run 级合成配置（run.input._compose；解析经 readComposeConfig） */
export interface ComposeConfig {
  transition?: string
  transition_duration?: number
  bgm_volume?: number
  bgm_fade?: number
  /** [M19] per-shot 音效全局音量（默认 1；clamp 0–2） */
  sfx_volume?: number
  /** [M19] 品牌 run 级覆盖（字段级合并到平台/项目层） */
  brand?: BrandConfig
  /** [M19] 多画幅原生渲染（合成内多路输出） */
  multi_aspect?: MultiAspectConfig
}

/**
 * [M19] multi_aspect 入参规范化（写入口共用）：enabled 必为布尔；strategy 缺省 crop、非法拒绝；
 * aspects 去重后逐项校验 ∈ ASPECTS（启用时 1–3 项，未启用允许空）。
 */
export function normalizeMultiAspect(raw: unknown): MultiAspectConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkbenchError('bad_field', 'multi_aspect 需为对象 { enabled, aspects, strategy }')
  }
  const o = raw as Record<string, unknown>
  if (typeof o.enabled !== 'boolean') throw new WorkbenchError('bad_field', 'multi_aspect.enabled 需为布尔')
  const strategy = o.strategy === undefined ? 'crop' : o.strategy
  if (typeof strategy !== 'string' || !(ASPECT_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new WorkbenchError('bad_field', `multi_aspect.strategy 需为 ${ASPECT_STRATEGIES.join('|')}`)
  }
  if (o.aspects !== undefined && !Array.isArray(o.aspects)) {
    throw new WorkbenchError('bad_field', 'multi_aspect.aspects 需为数组')
  }
  const list = (o.aspects ?? []) as unknown[]
  const aspects: string[] = []
  for (const a of list) {
    if (typeof a !== 'string' || !(ASPECTS as readonly string[]).includes(a)) {
      throw new WorkbenchError('bad_field', `multi_aspect.aspects 含非法画幅（可用：${ASPECTS.join('|')}）`)
    }
    if (!aspects.includes(a)) aspects.push(a)
  }
  if (aspects.length > 3) throw new WorkbenchError('bad_field', 'multi_aspect.aspects 最多 3 项（编码耗时 ×(1+k)）')
  if (o.enabled && aspects.length === 0) throw new WorkbenchError('bad_field', '启用多画幅时 aspects 至少 1 项')
  return { enabled: o.enabled, aspects, strategy: strategy as 'crop' | 'pad' }
}

/** [M19] multi_aspect 读取兜底（历史脏数据 / 结构缺失 → null = 不启用，合成链保持现行为） */
export function readMultiAspect(cfg: ComposeConfig): MultiAspectConfig | null {
  const m = cfg.multi_aspect
  if (!m || typeof m !== 'object' || m.enabled !== true) return null
  const aspects = Array.isArray(m.aspects)
    ? m.aspects.filter((a): a is string => typeof a === 'string' && (ASPECTS as readonly string[]).includes(a)).slice(0, 3)
    : []
  if (aspects.length === 0) return null
  return { enabled: true, aspects, strategy: m.strategy === 'pad' ? 'pad' : 'crop' }
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

/** [M31] 按 id 取有效资产（严格合成期 BGM opt-in 消费；项目/kind/内容摘要已由 assertRecipeSources 核验） */
export async function loadAssetById(assetId: number): Promise<Asset | null> {
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), isNull(assets.deletedAt)))
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
    if (key === 'transition_duration' || key === 'bgm_volume' || key === 'bgm_fade' || key === 'sfx_volume') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new WorkbenchError('bad_field', `${key} 需为数字`)
      }
      if (key === 'transition_duration') next.transition_duration = clamp(value, 0.1, 2)
      else if (key === 'bgm_volume') next.bgm_volume = clamp(value, 0, 1)
      else if (key === 'sfx_volume') next.sfx_volume = clamp(value, 0, 2)
      else next.bgm_fade = clamp(value, 0, 2)
      continue
    }
    if (key === 'multi_aspect') {
      if (value === null) {
        delete next.multi_aspect
        continue
      }
      next.multi_aspect = normalizeMultiAspect(value)
      continue
    }
    if (key === 'brand') {
      if (value === null) {
        delete next.brand
        continue
      }
      let patch: BrandConfig
      try {
        patch = normalizeBrandPatch(value)
      } catch (err) {
        throw new WorkbenchError('bad_field', (err as Error).message)
      }
      const merged = mergeBrand(next.brand, patch)
      // 槽级清除：patch 显式 null 的槽从 run 覆盖删除（回落继承）
      const raw = value as Record<string, unknown>
      for (const slot of ['subtitle', 'watermark', 'intro', 'outro'] as const) {
        if (raw[slot] === null) delete merged[slot]
      }
      next.brand = Object.keys(merged).length > 0 ? merged : undefined
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

// ===== [M19] per-shot 音效（SFX；镜像 BGM 先例，params.shotId 为键，每镜 ≤1 条有效） =====

/** 资产 params.shotId（SFX 匹配键，与 ai_image/ai_video 产物口径一致） */
function shotIdOfParams(paramsJson: string | null): string | null {
  if (!paramsJson) return null
  try {
    const p = JSON.parse(paramsJson) as { shotId?: unknown }
    return typeof p.shotId === 'string' && p.shotId ? p.shotId : null
  } catch {
    return null
  }
}

/** shotId 校验（非空字符串；trim 后返回） */
function requireShotId(shotId: string): string {
  const sid = typeof shotId === 'string' ? shotId.trim() : ''
  if (!sid) throw new WorkbenchError('bad_shot', 'shot_id 需为非空字符串')
  return sid
}

/** 本 run 全部有效 SFX 行（id 升序；列表端点与合成期共用） */
async function loadSfxRows(runId: number): Promise<Asset[]> {
  return await db
    .select()
    .from(assets)
    .where(and(eq(assets.runId, runId), eq(assets.purpose, 'sfx'), isNull(assets.deletedAt)))
    .orderBy(asc(assets.id))
}

/** shotId → 当前有效 SFX 资产（每镜 ≤1 条；params.shotId 缺失行防御跳过；合成期 ffmpeg-merge 消费） */
export async function loadSfxAssets(runId: number): Promise<Map<string, Asset>> {
  const map = new Map<string, Asset>()
  for (const a of await loadSfxRows(runId)) {
    const sid = shotIdOfParams(a.params)
    if (sid && !map.has(sid)) map.set(sid, a)
  }
  return map
}

/** SFX 列表（GET 端点；run 状态校验与 BGM 同语义） */
export async function getSfxList(runId: number): Promise<Array<{ shotId: string; asset: Asset }>> {
  await requireEditableRun(runId)
  const items: Array<{ shotId: string; asset: Asset }> = []
  for (const [shotId, asset] of await loadSfxAssets(runId)) items.push({ shotId, asset })
  return items
}

/** 软删该 run 该镜全部有效 SFX 行（绑定替换/移除共用） */
async function softDeleteSfxRows(runId: number, shotId: string): Promise<void> {
  const ids = (await loadSfxRows(runId)).filter((r) => shotIdOfParams(r.params) === shotId).map((r) => r.id)
  if (ids.length === 0) return
  const now = Date.now()
  await db.update(assets).set({ deletedAt: now, updatedAt: now }).where(inArray(assets.id, ids))
}

/**
 * 上传绑定 SFX：kind 校验（audio）→ 软删同镜旧行 → sha256 查重（命中复制行 / 未命中落盘 purpose=sfx 子目录）+ 建行。
 * 行属性：runId=本 run、stepId=null、params={shotId, source:'upload', original_name}。
 */
export async function bindSfxFromUpload(
  runId: number,
  shotId: string,
  file: { name: string; data: Uint8Array },
): Promise<Asset> {
  const run = await requireEditableRun(runId)
  const sid = requireShotId(shotId)
  const ext = extname(file.name)
  if (kindByExt(ext) !== 'audio') {
    throw new WorkbenchError('bad_kind', `文件类型不符（需音频，得到${ext ? ` ${ext}` : '未知类型'}）`)
  }
  const hash = sha256Hex(file.data)
  await softDeleteSfxRows(run.id, sid)
  const existed = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, run.projectId), eq(assets.sha256, hash), isNull(assets.deletedAt)))
    .limit(1)
  const base = {
    name: file.name,
    kind: 'audio' as const,
    purpose: 'sfx',
    mime: mimeOfExt(ext),
    ext: ext.slice(1),
    sha256: hash,
    params: { shotId: sid, source: 'upload', original_name: file.name },
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
  const relPath = relPathOf(run.projectId, 'sfx', fileName)
  writeFileSync(absPathOf(relPath), file.data)
  return await registerAsset(run.projectId, { ...base, relPath, fileSize: file.data.byteLength })
}

/** 项目音频复制行绑定（relPath 复用；不污染源资产行） */
export async function bindSfxFromAsset(runId: number, shotId: string, assetId: number): Promise<Asset> {
  const run = await requireEditableRun(runId)
  const sid = requireShotId(shotId)
  const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  const a = rows[0]
  if (!a) throw new WorkbenchError('bad_asset', `资产 #${assetId} 不存在`)
  if (a.projectId !== run.projectId) throw new WorkbenchError('bad_asset', `资产 #${assetId} 不属于本项目`)
  if (a.deletedAt) throw new WorkbenchError('bad_asset', `资产 #${assetId} 已删除`)
  if (a.kind !== 'audio') throw new WorkbenchError('bad_asset', `资产 #${assetId} 类型不符（需 audio）`)
  if (!a.relPath) throw new WorkbenchError('bad_asset', `资产 #${assetId} 无文件（relPath 缺失）`)
  await softDeleteSfxRows(run.id, sid)
  return await registerAsset(run.projectId, {
    name: a.name,
    kind: 'audio',
    purpose: 'sfx',
    mime: a.mime ?? undefined,
    ext: a.ext ?? undefined,
    sha256: a.sha256 ?? undefined,
    relPath: a.relPath,
    fileSize: a.fileSize ?? undefined,
    duration: a.duration ?? undefined,
    params: { shotId: sid, source: 'asset', source_asset_id: assetId, original_name: a.name },
    runId: run.id,
  })
}

/** 移除该镜 SFX（软删全部有效行） */
export async function removeSfx(runId: number, shotId: string): Promise<void> {
  await requireEditableRun(runId)
  await softDeleteSfxRows(runId, requireShotId(shotId))
}
