/**
 * [M19] 成片多画幅派生（spec §2.3 ⑤ A 路径：对已合成成片做单路 ffmpeg 重编码）。
 * - 源 = 该 run 最新有效 final_video（无 / 文件缺失 → no_final「尚未合成成片」）
 * - 尺寸与几何与 B 路径（合成内多路）同源：resolveAspectSize / aspectGeometryFilter
 * - 幂等复用：同 run + aspect + strategy + source_asset_id 且文件仍在 → { reused: true }（不发 ffmpeg）
 * - 落资产 purpose='final_video_derived'，params { source:'derived', source_asset_id, aspect, strategy }
 * - 音频 -c:a copy（画幅变更不动音轨）；视频 libx264 crf20 与合成同参
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, pipelineRuns, type Asset } from '../db/schema'
import { aspectGeometryFilter, resolveAspectSize } from '../pipeline/actions/ffmpeg-merge'
import { ASPECTS, ASPECT_STRATEGIES } from './compose-config'
import { probeMediaDuration, probeMediaSize, resolveFfmpeg } from './ffmpeg'
import { WorkbenchError } from './shot'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf } from './storage'

export type AspectStrategy = 'crop' | 'pad'

export interface DeriveResult {
  asset: Asset
  reused: boolean
}

/** params JSON 解析（非对象/损坏 → {}；幂等比对用） */
function paramsOf(a: Asset): Record<string, unknown> {
  try {
    const p = JSON.parse(a.params ?? '{}') as unknown
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 画幅文件名 slug：'9:16' → '9x16' */
function aspectSlug(aspect: string): string {
  return aspect.replace(':', 'x')
}

/** 源成片资产（本 run 最新有效 final_video；文件缺失视为无） */
async function loadFinalVideo(runId: number): Promise<Asset | null> {
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.runId, runId), eq(assets.purpose, 'final_video'), isNull(assets.deletedAt)))
    .orderBy(desc(assets.updatedAt))
    .limit(1)
  const row = rows[0]
  if (!row || !row.relPath || !existsSync(absPathOf(row.relPath))) return null
  return row
}

/** 幂等命中：同 run + aspect + strategy + 源资产 的既有派生行（文件在） */
async function findReusable(runId: number, aspect: string, strategy: AspectStrategy, sourceId: number): Promise<Asset | null> {
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.runId, runId), eq(assets.purpose, 'final_video_derived'), isNull(assets.deletedAt)))
    .orderBy(desc(assets.updatedAt))
  for (const a of rows) {
    const p = paramsOf(a)
    if (
      p.source === 'derived'
      && p.aspect === aspect
      && p.strategy === strategy
      && p.source_asset_id === sourceId
      && a.relPath
      && existsSync(absPathOf(a.relPath))
    ) {
      return a
    }
  }
  return null
}

/** 执行 ffmpeg（派生为端点触发，无 step 上下文；stderr 尾部入错误信息） */
function runFfmpegRaw(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let tail = ''
    child.stderr?.on('data', (buf: Buffer) => {
      const trimmed = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim()).pop() ?? ''
      if (trimmed) tail = trimmed.length > 300 ? trimmed.slice(-300) : trimmed
    })
    child.on('error', (err) => reject(new WorkbenchError('ffmpeg_spawn', `ffmpeg 启动失败：${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new WorkbenchError('ffmpeg_failed', `ffmpeg 退出码 ${code}：${tail}`, 502))
    })
  })
}

/**
 * [M19] 派生一路画幅（A 路径）。
 * aspect ∈ ASPECTS；strategy ∈ crop（默认）|pad；入参非法 → bad_aspect/bad_strategy。
 */
export async function deriveAspect(runId: number, aspect: string, strategy?: string): Promise<DeriveResult> {
  if (typeof aspect !== 'string' || !(ASPECTS as readonly string[]).includes(aspect)) {
    throw new WorkbenchError('bad_aspect', `aspect 需为 ${ASPECTS.join('|')}`)
  }
  const st = strategy === undefined || strategy === null ? 'crop' : strategy
  if (typeof st !== 'string' || !(ASPECT_STRATEGIES as readonly string[]).includes(st)) {
    throw new WorkbenchError('bad_strategy', `strategy 需为 ${ASPECT_STRATEGIES.join('|')}`)
  }
  const strat = st as AspectStrategy

  const runRows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = runRows[0]
  if (!run) throw new WorkbenchError('not_found', `run ${runId} 不存在`, 404)

  const source = await loadFinalVideo(runId)
  if (!source) throw new WorkbenchError('no_final', '尚未合成成片（无 final_video 产物），请先执行合成')

  const reusable = await findReusable(runId, aspect, strat, source.id)
  if (reusable) return { asset: reusable, reused: true }

  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) throw new WorkbenchError('no_ffmpeg', '未找到可用 ffmpeg（检查「设置 · 本地能力」或安装后重试）')

  const srcAbs = absPathOf(source.relPath!)
  const size = source.width && source.height
    ? { width: source.width, height: source.height }
    : probeMediaSize(srcAbs)
  if (!size) throw new WorkbenchError('no_size', '源成片尺寸探测失败（资产缺少 width/height 且 ffprobe 不可用）')
  const { w, h } = resolveAspectSize(size.width, size.height, aspect)

  let ep: string
  try {
    const input = JSON.parse(run.input ?? '{}') as Record<string, unknown>
    ep = String(input['episode_number'] ?? Date.now()).padStart(3, '0')
  } catch {
    ep = String(Date.now())
  }
  ensureProjectDirs(run.projectId)
  const name = `ep${ep}-final-${aspectSlug(aspect)}-${Date.now()}.mp4`
  const relPath = relPathOf(run.projectId, 'final_video_derived', name)
  const outAbs = absPathOf(relPath)

  await runFfmpegRaw(ffmpeg, [
    '-y',
    '-i',
    srcAbs,
    '-vf',
    aspectGeometryFilter(strat, w, h),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outAbs,
  ])
  if (!existsSync(outAbs)) throw new WorkbenchError('ffmpeg_failed', '派生完成但产物文件缺失', 502)

  const duration = source.duration ?? probeMediaDuration(outAbs)
  const asset = await registerAsset(run.projectId, {
    runId,
    stepId: source.stepId ?? undefined,
    name,
    kind: 'video',
    purpose: 'final_video_derived',
    relPath,
    mime: 'video/mp4',
    ext: 'mp4',
    fileSize: statSync(outAbs).size,
    width: w,
    height: h,
    duration: duration !== null ? Math.round(duration) : undefined,
    params: {
      source: 'derived',
      source_asset_id: source.id,
      aspect,
      strategy: strat,
      native: false,
      resolution: `${w}x${h}`,
      duration: duration !== null ? Math.round(duration * 1000) / 1000 : null,
    },
    tags: ['final', 'derived', aspectSlug(aspect)],
  })
  return { asset, reused: false }
}
