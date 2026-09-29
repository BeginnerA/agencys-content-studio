/**
 * 智能 BGM（M54 G4a/G4b）：混剪合成期「未手绑 BGM」时的自动补乐。
 * - auto：候选 = 项目内未删音频资产（含库复制行）∪ MONTAGE_BGM_DIR 曲库目录（首用复制入项目）；
 *   选曲规则收敛在 montage.pickBgm 纯函数（时长 ≥ 片长优先 → 最近片长 → updated_at desc）。
 * - music_gen：ai-provider-kit music 端点按 prompt 生成一首（付费，用量记录）；
 *   端点未配置/生成失败/超时 → 返回 null 由调用方降级 auto 库内（绝不断链）。
 * - 绑定语义与工作台 bindBgmFromAsset 同口径：purpose='bgm' + runId，先软删本 run 旧 bgm 行
 *   （至多 1 条有效不变量）→ 后续重合成经 loadBgmAsset 直接复用，不重复选曲/付费。
 * 零 diff 红线：仅模板显式映射 params.bgm_mode ∈ {auto, music_gen}、非严格且用户未手绑时被调用——
 *   存量模板不声明 bgm_mode（桥不映射）→ 本模块不执行，BGM 路径逐字节 = 现行为。
 *   M54-B 起不限混剪态：短剧链（mengbao-episode v13）同样经 bgm_mode 显式 opt-in 接入智能选曲。
 */
import { existsSync, copyFileSync, statSync } from 'node:fs'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, type Asset } from '../db/schema'
import { absPathOf, registerAsset, relPathOf } from './storage'
import { probeMediaDuration } from './ffmpeg'
import { loadBgmAsset, loadAssetById } from './compose-config'
import { pickBgm, scanBgmLibrary, type BgmCandidate } from '../pipeline/actions/ffmpeg-merge/montage'
import type { StepContext } from '../pipeline/context'
import { generateMusicAsset } from './music-gen'

export interface SmartBgmResult { asset: Asset; autoSelected: true; source: 'library' | 'project' | 'generated' }

/** 把选中的 bgm 行绑定到 run：软删旧行（至多 1 有效不变量）+ 新行 runId/purpose 落位 */
async function bindAsRunBgm(projectId: number, runId: number, picked: Asset): Promise<Asset> {
  const now = Date.now()
  const olds = await db
    .select()
    .from(assets)
    .where(and(eq(assets.runId, runId), eq(assets.purpose, 'bgm'), isNull(assets.deletedAt)))
  for (const o of olds) {
    await db.update(assets).set({ deletedAt: now, updatedAt: now }).where(eq(assets.id, o.id))
  }
  await db.update(assets).set({ purpose: 'bgm', runId, updatedAt: now }).where(eq(assets.id, picked.id))
  return (await db.select().from(assets).where(eq(assets.id, picked.id)))[0]!
}

/** 曲库目录文件复制入项目（source 音频行 + 时长回填；重名幂等：同 relPath 已存在直接复用） */
async function importLibraryTrack(projectId: number, abs: string, name: string): Promise<Asset | null> {
  const existing = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, projectId), eq(assets.name, name), eq(assets.purpose, 'source'), isNull(assets.deletedAt)))
  if (existing[0]) return existing[0]
  try {
    const ext = name.split('.').pop()!
    const rel = relPathOf(projectId, 'audio', `bgm-lib-${name}`)
    copyFileSync(abs, absPathOf(rel))
    return await registerAsset(projectId, {
      name, kind: 'audio', purpose: 'source', relPath: rel, ext, mime: 'audio/mpeg',
      fileSize: statSync(absPathOf(rel)).size,
      duration: probeMediaDuration(absPathOf(rel)) ?? undefined,
      tags: ['bgm_library'],
    })
  } catch {
    return null // 单文件复制失败不炸链（其余候选继续）
  }
}

/** 库内自动选曲（G4a）：0 候选/均未命中 → null（调用方 log 后按无 BGM 继续，不抛错） */
export async function resolveAutoBgm(ctx: StepContext, totalSec: number): Promise<SmartBgmResult | null> {
  const projectId = ctx.run.projectId
  // 候选 1：项目内音频资产（未删；未绑 run 或已绑本 run 皆可视作可用乐库——绑其他 run 的不抢）
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, projectId), eq(assets.kind, 'audio'), isNull(assets.deletedAt)))
  const usable = rows.filter((a) => (a.runId === null || a.runId === ctx.run.id) && a.relPath && existsSync(absPathOf(a.relPath)))
  // 候选 2：MONTAGE_BGM_DIR 曲库（逐文件首用复制入项目，成为候选 1 的一员）
  const libFiles = scanBgmLibrary(process.env.MONTAGE_BGM_DIR)
  for (const f of libFiles) {
    const imported = await importLibraryTrack(projectId, f.abs, f.name)
    if (imported && imported.relPath && existsSync(absPathOf(imported.relPath)) && !usable.some((u) => u.id === imported.id)) usable.push(imported)
  }
  const cands: BgmCandidate[] = usable.map((a) => ({
    id: a.id,
    path: absPathOf(a.relPath!),
    durationSec: typeof a.duration === 'number' && a.duration > 0 ? a.duration : probeMediaDuration(absPathOf(a.relPath!)),
    updatedAt: a.updatedAt ?? a.createdAt ?? 0,
  }))
  const picked = pickBgm(cands, totalSec)
  if (!picked) {
    ctx.log(`智能 BGM（auto）：无可用候选乐曲（项目音频 ${cands.length} 条），按无 BGM 继续`)
    return null
  }
  const row = usable.find((a) => a.id === picked.id)!
  const bound = await bindAsRunBgm(projectId, ctx.run.id, row)
  ctx.log(`智能 BGM（auto）：选中 asset#${bound.id}（${bound.name}，${picked.durationSec ?? '?'}s / 片长 ${totalSec}s）已绑定本 run`)
  let inLibrary = false
  try {
    inLibrary = (JSON.parse(row.tags ?? '[]') as unknown[]).includes('bgm_library')
  } catch { /* 脏 tags 宽容非库内 */ }
  return { asset: bound, autoSelected: true, source: inLibrary ? 'library' : 'project' }
}

/** 智能 BGM 总入口：music_gen 先试生成（付费可见），失败/未配置 → 降级库内 auto */
export async function resolveSmartBgm(ctx: StepContext, mode: 'auto' | 'music_gen', totalSec: number, prompt: string): Promise<SmartBgmResult | null> {
  if (mode === 'music_gen') {
    const asset = await generateMusicAsset(ctx, prompt)
    if (asset) {
      const bound = await bindAsRunBgm(ctx.run.projectId, ctx.run.id, asset)
      ctx.log(`AI 生成 BGM 完成：asset#${bound.id}（${bound.duration ?? '?'}s）已绑定本 run`)
      return { asset: bound, autoSelected: true, source: 'generated' }
    }
    ctx.log('AI 生成 BGM 未成行（端点未配置/失败/超时），已降级库内自动选曲')
  }
  return resolveAutoBgm(ctx, totalSec)
}

/**
 * 合成期 BGM 总解析（自 ffmpeg-merge/index.ts 拆出：≤800 行红线，行为零变更）：
 * 严格 = 方案批准 role:'bgm' 窄口径 opt-in（默认无 ref → 无 BGM 逐字节不变，智能补乐亦不进严格链）；
 * 非严格 = run 级直查手绑；未手绑且 bgm_mode ∈ {auto, music_gen}（模板显式映射）→ 智能补乐，
 * 选中绑定后回落既有 bgmPath 链。混剪（photo-montage v2）与短剧（mengbao-episode v13）同源能力。
 * 存量模板不映射 bgm_mode → 智能块不执行，BGM 路径逐字节 = 现行为。
 */
export async function resolveMergeBgm(opts: {
  ctx: StepContext
  strict: boolean
  params: Record<string, unknown>
  total: number
  strictBgmAssetId: number | null
}): Promise<{ asset: Asset | null; path: string | null; autoSelected: boolean }> {
  const { ctx, params } = opts
  let asset: Asset | null
  if (opts.strict) {
    asset = opts.strictBgmAssetId !== null ? await loadAssetById(opts.strictBgmAssetId) : null
  } else {
    asset = await loadBgmAsset(ctx.run.id)
  }
  let path: string | null = null
  if (asset) {
    if (asset.relPath && existsSync(absPathOf(asset.relPath))) path = absPathOf(asset.relPath)
    else ctx.log(`BGM 资产 #${asset.id} 文件缺失，已跳过混音`)
  }
  // M54 智能 BGM：非严格、未手绑且模板显式映射 bgm_mode 时自动补乐（auto 库内选曲 / music_gen 先 AI 生成再降级）
  let autoSelected = false
  const bgmModeRaw = typeof params['bgm_mode'] === 'string' ? String(params['bgm_mode']).trim() : ''
  if (!opts.strict && !asset && (bgmModeRaw === 'auto' || bgmModeRaw === 'music_gen')) {
    const promptText = typeof params['bgm_prompt'] === 'string' && params['bgm_prompt'].trim() ? params['bgm_prompt'].trim() : '温暖抒情的背景音乐，器乐为主，适合相册视频'
    const smart = await resolveSmartBgm(ctx, bgmModeRaw as 'auto' | 'music_gen', opts.total, promptText)
    if (smart) {
      asset = smart.asset
      path = smart.asset.relPath ? absPathOf(smart.asset.relPath) : null
      autoSelected = true
    }
  }
  return { asset, path, autoSelected }
}
