import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import { db } from '../../../db'
import { assets, genTasks } from '../../../db/schema'
import type { Asset, CanvasNode } from '../../../db/schema'
import { probeMediaDuration, resolveFfmpeg } from '../../ffmpeg'
import { createLogger } from '../../../logger'
import { pickDisplayTask } from '../inputs'
import { addAssetNode, canvasOfNode, findNode } from '../nodes'
import { safeParseSpec } from '../spec'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf } from '../../storage'
import { emitCanvasChanged } from './video'

const log = createLogger('creation-gen')

// ---------- [M18] 视频抽帧 ----------

/** [M18] 抽帧模式 */
export type FrameMode = 'first' | 'last' | 'custom'

/**
 * [M18] 抽帧时间点（秒；纯函数探针直测）：
 * - first：0.1s（避开淡入黑帧，对齐 thumb 先例；超短视频取中点）；
 * - last：时长−0.1（时长未知退化 0.1）；
 * - custom：clamp(time, 0, 时长−0.05)（时长未知仅下界）。
 */
export function frameTimeOf(mode: FrameMode, time: number | null, duration: number | null): number {
  const dur = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null
  const round = (v: number): number => Math.round(v * 1000) / 1000
  if (mode === 'last') return round(dur != null ? Math.max(0, dur - 0.1) : 0.1)
  if (mode === 'custom') {
    const t = typeof time === 'number' && Number.isFinite(time) ? Math.max(0, time) : 0
    return round(dur != null ? Math.min(t, Math.max(0, dur - 0.05)) : t)
  }
  return round(dur != null ? Math.min(0.1, dur / 2) : 0.1)
}

/** [M18] 抽帧 argv（全尺寸单帧 jpg；-ss 前置快速定位） */
export function buildFrameExtractArgs(src: string, out: string, timeSec: number): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(timeSec), '-i', src, '-frames:v', '1', '-q:v', '2', out]
}

/** [M18] 抽帧寻址降级梯度（秒）：请求时刻超出末帧 PTS（低帧率视频 dur−ε 越界）→ 逐级回退取最近可用帧 */
export const FRAME_SEEK_BACKOFFS = [0, 0.1, 0.3, 0.7, 1.5]

/** [M18] 内部：抽帧错误（retryable=false 时不做寻址降级：超时/进程启动失败/原子写失败） */
class FrameExtractError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'FrameExtractError'
  }
}

/** [M18] 单次抽帧（tmp+rename 原子写；超时 30s 强杀） */
async function runFrameExtractOnce(ffmpeg: string, srcAbs: string, outAbs: string, timeSec: number, attempt: number): Promise<void> {
  const tmp = `${outAbs}.${process.pid}.${Date.now()}.${attempt}.tmp.jpg`
  const args = buildFrameExtractArgs(srcAbs, tmp, timeSec)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let tail = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      rmSync(tmp, { force: true })
      reject(new FrameExtractError('抽帧超时（>30s）', false))
    }, 30_000)
    const child = spawn(ffmpeg, args, { windowsHide: true })
    child.stderr?.on('data', (buf: Buffer) => {
      tail = (tail + buf.toString('utf8')).slice(-1000)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rmSync(tmp, { force: true })
      reject(new FrameExtractError(`抽帧进程启动失败：${err.message}`, false))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        try {
          renameSync(tmp, outAbs)
          resolve()
        } catch (err) {
          rmSync(tmp, { force: true })
          reject(new FrameExtractError((err as Error).message, false))
        }
      } else {
        rmSync(tmp, { force: true })
        reject(new FrameExtractError(`抽帧失败（exit=${code}）：${tail.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ') || '(无输出)'}`, true))
      }
    })
  })
}

/**
 * [M18] 抽帧执行：ffmpeg 单帧 → 目标（tmp+rename 原子写；超时 30s；失败抛错含 stderr 尾部）。
 * 寻址降级：请求时刻无帧可取（超出末帧 PTS）→ 按 FRAME_SEEK_BACKOFFS 回退重试（仅 ffmpeg 非零退出时可降级）。
 */
export async function extractVideoFrame(srcAbs: string, outAbs: string, timeSec: number): Promise<void> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    throw new Error('未找到可用 ffmpeg：内置二进制与系统 PATH 均不可用；请先在仓库根 pnpm install（重新下载内置二进制），或在 .env 设 CSTUDIO_FFMPEG_PATH 指向 ffmpeg.exe')
  }
  mkdirSync(dirname(outAbs), { recursive: true })
  const targets = [...new Set(FRAME_SEEK_BACKOFFS.map((b) => Math.max(0, Math.round((timeSec - b) * 1000) / 1000)))]
  let lastErr: Error | null = null
  for (let i = 0; i < targets.length; i += 1) {
    try {
      await runFrameExtractOnce(ffmpeg, srcAbs, outAbs, targets[i]!, i)
      if (i > 0) log.info(`抽帧寻址降级：请求 ${timeSec}s 无帧可取 → 实际取 ${targets[i]}s`)
      return
    } catch (err) {
      if (!(err instanceof FrameExtractError) || !err.retryable) throw err
      lastErr = err
    }
  }
  throw lastErr ?? new Error('抽帧失败')
}

/**
 * [M18] 从视频节点抽帧：gen(video) 显示产物 · asset 节点视频资产 →
 * ffmpeg 单帧 jpg（全尺寸）→ registerAsset(purpose='creation_frame') → 新建 asset 节点（缺省源节点右下偏移）。
 * 软删/无文件/非视频/无产物 → 领域错误（route 层 400）。
 */
export async function extractNodeFrame(
  nodeId: number,
  opts: { mode?: unknown; time?: unknown; x?: unknown; y?: unknown },
): Promise<{ node: CanvasNode; asset: Asset }> {
  const src = await findNode(nodeId)
  if (!src) throw new Error(`画布节点 ${nodeId} 不存在`)
  const canvas = await canvasOfNode(nodeId)
  if (!canvas) throw new Error('画布不存在')
  const modeRaw = opts.mode === undefined || opts.mode === null ? 'first' : String(opts.mode)
  if (modeRaw !== 'first' && modeRaw !== 'last' && modeRaw !== 'custom') {
    throw new Error(`mode 非法（first|last|custom）：${modeRaw}`)
  }
  const mode = modeRaw as FrameMode
  let timeRaw: number | null = null
  if (opts.time !== undefined && opts.time !== null) {
    timeRaw = Number(opts.time)
    if (!Number.isFinite(timeRaw)) throw new Error('time 需为数值（秒）')
  }

  // 源资产解析：gen(video) 显示产物（采纳优先 → 最近成功）/ asset 视频
  let srcAssetId: number | null
  if (src.kind === 'gen') {
    const parsed = safeParseSpec(src.spec)
    if (!parsed.spec) throw new Error(`源节点 spec 损坏：${parsed.error}`)
    if (parsed.spec.genKind !== 'video') throw new Error('仅视频生成节点可抽帧')
    const taskRows = await db
      .select({ id: genTasks.id, status: genTasks.status, resultAssetId: genTasks.resultAssetId })
      .from(genTasks)
      .where(eq(genTasks.canvasNodeId, src.id))
      .orderBy(desc(genTasks.id))
      .limit(50)
    srcAssetId = pickDisplayTask(src.adoptedTaskId, taskRows)?.resultAssetId ?? null
    if (srcAssetId == null) throw new Error('视频节点暂无可用产物（请先执行生成）')
  } else if (src.kind === 'asset') {
    srcAssetId = src.assetId
    if (srcAssetId == null) throw new Error('素材节点缺少资产引用')
  } else {
    throw new Error('仅视频生成节点或视频素材节点可抽帧')
  }
  if (srcAssetId == null) throw new Error('仅视频生成节点或视频素材节点可抽帧')

  const rows = await db.select().from(assets).where(eq(assets.id, srcAssetId)).limit(1)
  const a = rows[0]
  if (!a || a.deletedAt != null) throw new Error(`源资产 #${srcAssetId} 不存在或已删除`)
  if (a.kind !== 'video') throw new Error(`源资产 #${srcAssetId} 不是视频（${a.kind}）`)
  if (!a.relPath) throw new Error(`源资产 #${srcAssetId} 无本地文件`)
  const srcAbs = absPathOf(a.relPath)
  if (!existsSync(srcAbs)) throw new Error(`源资产 #${srcAssetId} 文件缺失（${a.relPath}）`)

  const duration = (typeof a.duration === 'number' && a.duration > 0 ? a.duration : null) ?? probeMediaDuration(srcAbs)
  const timeSec = frameTimeOf(mode, timeRaw, duration)

  ensureProjectDirs(canvas.projectId)
  const fileName = `${Date.now()}-frame-node${src.id}.jpg`
  const relPath = relPathOf(canvas.projectId, 'creation_frame', fileName)
  const outAbs = absPathOf(relPath)
  await extractVideoFrame(srcAbs, outAbs, timeSec)
  const stat = statSync(outAbs, { throwIfNoEntry: false })
  const asset = await registerAsset(canvas.projectId, {
    kind: 'image',
    purpose: 'creation_frame',
    relPath,
    name: fileName,
    mime: 'image/jpeg',
    ext: 'jpg',
    fileSize: stat?.size,
    width: a.width ?? undefined,
    height: a.height ?? undefined,
    params: {
      canvasId: canvas.id,
      nodeId: src.id,
      sourceAssetId: srcAssetId,
      mode,
      timeSec,
      duration: duration ?? null,
    },
    tags: ['frame'],
  })
  const node = await addAssetNode(
    canvas,
    asset.id,
    opts.x === undefined ? src.x + 60 : opts.x,
    opts.y === undefined ? src.y + 140 : opts.y,
    `抽帧 ${timeSec}s`,
  )
  emitCanvasChanged(canvas, node.id)
  log.info(`canvas node #${src.id} 抽帧（${mode} @${timeSec}s）→ asset#${asset.id} + node#${node.id}`)
  return { node, asset }
}
