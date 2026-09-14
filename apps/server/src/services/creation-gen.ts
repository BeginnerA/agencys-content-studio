import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, canvasEdges, canvasNodes, genTasks, projects } from '../db/schema'
import type { Asset, Canvas, CanvasNode, GenTask } from '../db/schema'
import { buildImageRequest, resolveEndpoint, getImageAdapter } from '../adapters/provider'
import { buildVideoRequest } from '../adapters/video'
import type { ImageEditRequest, VideoAdapter, VideoGenRequest } from '../adapters/types'
import { resolveVoiceChain } from '../pipeline/actions/tts'
import { buildTransitionPlan } from '../pipeline/actions/ffmpeg-merge'
import { createLogger } from '../logger'
import { assetToDataUri } from './asset-ref'
import {
  addAssetNode,
  canvasOfNode,
  findNode,
  loadInputPlan,
  pickDisplayTask,
  safeParseSpec,
  specProblems,
  type InputPlan,
  type NodeSpec,
} from './creation'
import { emitStudioEvent } from './events'
import { probeMediaDuration, resolveFfmpeg, resolveFfprobe } from './ffmpeg'
import { scheduleImageCheck } from './image-check'
import { chatCompleteDetailed, resolveLlmEndpoint, type ChatContentPart } from './llm'
import { saveGeneratedMedia } from './net'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf, writeTextAsset } from './storage'
import { combineStyleSnippets, resolveProjectStyleSnippets } from './style-preset'
import { resolveAudioEndpoint, synthSpeech } from './tts'
import { recordLlmUsage, recordUsage, resolveUnitPrice, type UsageKind, type UsageUnit } from './usage'

/**
 * [M16/M17] 创作画布执行通道（不复用 pipeline actions——其全为批处理/分镜驱动）：
 * - startCanvasNodeRun：readiness 预检 → 建 gen_tasks 行（runId/stepId 恒 null，canvasNodeId 归属）→ 入队异步执行；
 *   [M17] variants（1-4）：一次循环建 N 条任务，随信号量排队；响应 { taskId, taskIds }（taskId = 首条，兼容）；
 * - 执行镜像 ai_image / ai_video 的 runOneTask 生命周期：attempts 递增、processing→succeeded/failed、
 *   落盘 saveGeneratedMedia + scheduleImageCheck + recordUsage、失败自动重试 1 次（1.5s 间隔）；
 * - [M17/M18] 五执行径：编辑/图片/视频（M16 既有）+ audio（services/tts 声线四级链 + synthSpeech → purpose=creation_audio
 *   + recordUsage(tts/char)）+ compose（buildComposeArgs 纯函数 + resolveFfmpeg spawn → purpose=creation_compose）
 *   + llm（[M18] 指令 + 文本素材 + 参考图多模态 → chatCompleteDetailed → writeTextAsset(purpose=creation_llm) + recordLlmUsage）；
 * - [M17] prompt 端口语义：执行 prompt = plan.promptText（text 节点内容）> spec.prompt 兜底；
 * - 取消：复用 POST /tasks/:id/cancel（改 status=cancelled）；执行器各检查点弃存（视频轮询每轮检查；
 *   图片/音频生成不可中断、合成本地进程不可中断——完成后若已取消则弃存）；
 * - 并发：进程内信号量 ≤CANVAS_MAX_CONCURRENCY；崩溃恢复 recoverCanvasTasks（启动时调用）。
 */

const log = createLogger('creation-gen')

export const CANVAS_MAX_CONCURRENCY = 2
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 2 // 自动重试 1 次（镜像 ai_image maxRetry=1）
const COMPOSE_TIMEOUT_MS = 10 * 60 * 1000 // 合成子进程上限（对齐视频轮询）

const nowMs = (): number => Date.now()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 视频轮询中检测到取消：任务行已置 cancelled（取消端点写入），执行器直接退出 */
class CanvasTaskCancelled extends Error {}

// ---------- 进程内信号量（≤2） ----------

let active = 0
const waiters: Array<() => void> = []

async function acquireSlot(): Promise<void> {
  if (active < CANVAS_MAX_CONCURRENCY) {
    active += 1
    return
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
}

function releaseSlot(): void {
  const next = waiters.shift()
  if (next) {
    next() // 槽位移交（active 保持满额）
  } else {
    active -= 1
  }
}

// ---------- 纯函数（供探针直接断言） ----------

/** 任务 params 快照（gen_tasks.params JSON） */
export function buildNodeTaskParams(
  spec: NodeSpec,
  opts: { stylePresetIds: number[]; plan: InputPlan },
): Record<string, unknown> {
  return {
    size: spec.size ?? null,
    duration: spec.duration ?? null,
    resolution: spec.resolution ?? null,
    aspectRatio: spec.aspectRatio ?? null,
    useStylePreset: spec.useStylePreset !== false,
    stylePresetIds: opts.stylePresetIds,
    edit: spec.edit
      ? { mode: spec.edit.mode, maskAssetId: spec.edit.maskAssetId ?? null, expand: spec.edit.expand ?? null }
      : null,
    input: {
      referenceAssetIds: opts.plan.referenceAssetIds,
      firstFrameAssetId: opts.plan.firstFrameAssetId,
      lastFrameAssetId: opts.plan.lastFrameAssetId,
      sourceAssetId: opts.plan.sourceAssetId,
    },
  }
}

/** [M17/M18] 任务 params 扩展（buildNodeTaskParams 字段快照保持不变——probe-m16 精确断言）：audio 附加 voice/speed；compose 附加 fps（[M18] 仅显式含转场/BGM 字段时附加新键——旧形态输出不变，probe-m17 快照兼容） */
export function extendTaskParams(params: Record<string, unknown>, spec: NodeSpec): Record<string, unknown> {
  if (spec.genKind === 'audio') return { ...params, voice: spec.voice ?? null, speed: spec.speed ?? null }
  if (spec.genKind === 'compose') {
    const out: Record<string, unknown> = { ...params, fps: spec.fps ?? null }
    if (
      spec.transition !== undefined ||
      spec.transitionDuration !== undefined ||
      spec.bgmAssetId !== undefined ||
      spec.bgmVolume !== undefined ||
      spec.bgmFade !== undefined
    ) {
      out['transition'] = spec.transition ?? 'none'
      out['transitionDuration'] = spec.transitionDuration ?? null
      out['bgmAssetId'] = spec.bgmAssetId ?? null
      out['bgmVolume'] = spec.bgmVolume ?? null
      out['bgmFade'] = spec.bgmFade ?? null
    }
    return out
  }
  return params
}

/** 编辑请求构造（纯部分：spec + 媒体 URI → 请求字段；baseUrl/apiKey 由调用方注入） */
export function buildEditParams(
  spec: NodeSpec,
  media: { baseImage: string; mask?: string },
): Pick<ImageEditRequest, 'mode' | 'baseImage' | 'mask' | 'prompt' | 'expand' | 'size'> {
  const edit = spec.edit
  if (!edit) throw new Error('spec.edit 缺失（非编辑节点）')
  const out: Pick<ImageEditRequest, 'mode' | 'baseImage' | 'mask' | 'prompt' | 'expand' | 'size'> = {
    mode: edit.mode,
    baseImage: media.baseImage,
  }
  if (edit.mode === 'inpaint' || edit.mode === 'erase') {
    if (!media.mask) throw new Error('编辑模式缺少蒙版（inpaint/erase 需 mask）')
    out.mask = media.mask
  }
  if (spec.prompt.trim()) out.prompt = spec.prompt.trim()
  if (edit.expand) out.expand = edit.expand
  if (spec.size) out.size = spec.size
  return out
}

/** 风格尾追（单值版，对齐 ai_image injectStyleAnchor 的「视觉风格：…」格式） */
export function appendStyleSnippet(prompt: string, snippet: string | null): string {
  const s = typeof snippet === 'string' ? snippet.trim() : ''
  const base = prompt.trim()
  if (!s) return base
  return base ? `${base}\n视觉风格：${s}` : `视觉风格：${s}`
}

/** [M17] 合成输出尺寸（WxH，偶数） */
export interface ComposeSize {
  width: number
  height: number
}

/** [M17] resolution 解析（格式 WxH，对齐 ffmpeg-merge 约定；libx264 yuv420p 要求宽高为正偶数） */
export function parseResolution(res: string): ComposeSize {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(res.trim())
  if (!m) throw new Error(`resolution 非法: ${res}（需 WxH 如 1080x1920）`)
  const width = Number(m[1])
  const height = Number(m[2])
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error(`resolution 非法: ${res}（宽高需为正偶数）`)
  return { width, height }
}

/**
 * [M17/M18] 合成 argv 纯函数（探针直测快照）：
 * - N≥2：filter_complex 逐段归一（scale decrease + pad 居中 + setsar=1，指定 fps 时先归 fps）→ concat=[vout]；
 * - N=1：-map 0:v（指定 fps 时输出端 -r）；
 * - 音频（合成端口输入，M≥1）：amix=inputs=M:duration=longest=[aout] → -map [aout] + -c:a aac；M=0 → -an（BGM 启用时替代 -an）；
 * - [M18] 转场（transition≠none 且 durations 齐备）：归一链尾 +tpad 冻帧补足（前 n-1 段 d+T）+ settb=AVTB →
 *   xfade 链（offset=buildTransitionPlan.offsets；总长仍 Σd）；durations 缺失/不齐 → 宽容降级为 concat；
 * - [M18] BGM（bgmPath 非空且 durations 齐备）：-stream_loop -1 输入 + atrim=0:totalDur + volume + 首尾 afade（默认 1.5s）
 *   → 与原音轨 amix（duration=first:normalize=0；无原音轨 → BGM 单源 anull）；
 * - 编码：libx264 + yuv420p（对齐 ffmpeg-merge 设定）+ faststart。
 */
export function buildComposeArgs(opts: {
  videoPaths: string[]
  audioPaths: string[]
  outPath: string
  fps?: number | null
  size?: ComposeSize | null
  /** [M18] 各视频段时长（转场/BGM 计划依据；缺失/不齐/非法 → 转场与 BGM 宽容降级） */
  durations?: number[] | null
  transition?: string | null
  transitionDuration?: number | null
  /** [M18] BGM 本地路径（追加为最后一个 -stream_loop -1 输入） */
  bgmPath?: string | null
  bgmVolume?: number | null
  /** [M18] BGM 首尾淡入淡出（默认 true，时长 1.5s） */
  bgmFade?: boolean | null
}): string[] {
  const n = opts.videoPaths.length
  if (n === 0) throw new Error('合成缺少视频输入')
  const m = opts.audioPaths.length
  const fps = typeof opts.fps === 'number' && Number.isFinite(opts.fps) && opts.fps > 0 ? opts.fps : null

  // [M18] 转场计划：时长齐备且合法才启用（否则宽容降级 concat）
  const durations =
    Array.isArray(opts.durations) && opts.durations.length === n && opts.durations.every((d) => typeof d === 'number' && Number.isFinite(d) && d > 0)
      ? opts.durations
      : null
  const xplan = durations ? buildTransitionPlan(durations, String(opts.transition ?? 'none'), Number(opts.transitionDuration ?? 0.5)) : null
  const useX = !!xplan && xplan.enabled
  const totalDur = durations ? (useX ? xplan!.totalDur : Math.round(durations.reduce((s, d) => s + d, 0) * 1000) / 1000) : null
  // [M18] BGM：总长未知（durations 缺失）→ 降级禁用
  const bgm = totalDur != null && typeof opts.bgmPath === 'string' && opts.bgmPath ? opts.bgmPath : null
  const bgmVolume = typeof opts.bgmVolume === 'number' && Number.isFinite(opts.bgmVolume) ? Math.min(1, Math.max(0, opts.bgmVolume)) : 0.5
  const bgmFade = opts.bgmFade === false ? 0 : 1.5

  const args: string[] = ['-y']
  for (const p of opts.videoPaths) args.push('-i', p)
  for (const p of opts.audioPaths) args.push('-i', p)
  if (bgm) args.push('-stream_loop', '-1', '-i', bgm)

  const fc: string[] = []
  const maps: string[] = []
  if (n >= 2) {
    if (!opts.size) throw new Error('合成尺寸未知（多段合成需 resolution 或可探测的视频输入）')
    const { width, height } = opts.size
    for (let i = 0; i < n; i += 1) {
      let chain = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1${fps ? `,fps=${fps}` : ''}`
      if (useX) {
        // 前 n-1 段冻帧补足 T（转场期间被下一段覆盖；末镜不加）
        if (i < n - 1) chain += `,tpad=stop_mode=clone:stop_duration=${xplan!.durSec}`
        chain += ',settb=AVTB'
      }
      fc.push(`[${i}:v]${chain}[v${i}]`)
    }
    if (useX) {
      let prev = 'v0'
      const boundaries = xplan!.offsets.length
      for (let k = 0; k < boundaries; k += 1) {
        const outLabel = k < boundaries - 1 ? `x${k + 1}` : 'vout'
        fc.push(`[${prev}][v${k + 1}]xfade=transition=${xplan!.type}:duration=${xplan!.durSec}:offset=${xplan!.offsets[k]}[${outLabel}]`)
        prev = outLabel
      }
    } else {
      fc.push(`${opts.videoPaths.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vout]`)
    }
    maps.push('-map', '[vout]')
  } else {
    maps.push('-map', '0:v')
  }
  if (m > 0) {
    const ins = opts.audioPaths.map((_, k) => `[${n + k}:a]`).join('')
    if (bgm) {
      fc.push(`${ins}amix=inputs=${m}:duration=longest[amix]`)
      const bgmIdx = n + m
      let chain = `[${bgmIdx}:a]atrim=0:${totalDur},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bgmVolume}`
      if (bgmFade > 0) {
        chain += `,afade=t=in:st=0:d=${bgmFade},afade=t=out:st=${Math.max(0, Math.round((totalDur! - bgmFade) * 1000) / 1000)}:d=${bgmFade}`
      }
      fc.push(`${chain}[bgm]`)
      fc.push('[amix][bgm]amix=inputs=2:duration=first:normalize=0[aout]')
    } else {
      fc.push(`${ins}amix=inputs=${m}:duration=longest[aout]`)
    }
  } else if (bgm) {
    const bgmIdx = n
    let chain = `[${bgmIdx}:a]atrim=0:${totalDur},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bgmVolume}`
    if (bgmFade > 0) {
      chain += `,afade=t=in:st=0:d=${bgmFade},afade=t=out:st=${Math.max(0, Math.round((totalDur! - bgmFade) * 1000) / 1000)}:d=${bgmFade}`
    }
    fc.push(`${chain}[bgm]`)
    fc.push('[bgm]anull[aout]')
  }
  if (m > 0 || bgm) maps.push('-map', '[aout]')
  if (fc.length > 0) args.push('-filter_complex', fc.join(';'))
  args.push(...maps, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p')
  if (n === 1 && fps) args.push('-r', String(fps))
  if (m > 0 || bgm) args.push('-c:a', 'aac')
  else args.push('-an')
  args.push('-movflags', '+faststart', opts.outPath)
  return args
}

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

// ---------- 启动执行 ----------

/** [M18] 节点预检（spec/输入计划/问题清单一次性解析）——startCanvasNodeRun 与 run-preview 共用 */
export interface NodePreflight {
  node: CanvasNode
  canvas: Canvas
  spec: NodeSpec
  plan: InputPlan
  problems: string[]
}

export async function preflightNode(nodeId: number): Promise<NodePreflight> {
  const node = await findNode(nodeId)
  if (!node) throw new Error(`画布节点 ${nodeId} 不存在`)
  if (node.kind !== 'gen') throw new Error('仅生成节点可执行')
  const canvas = await canvasOfNode(nodeId)
  if (!canvas) throw new Error('画布不存在')
  const parsed = safeParseSpec(node.spec)
  if (!parsed.spec) throw new Error(`节点不可执行：${parsed.error}`)
  const spec = parsed.spec
  const incoming = await db
    .select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port })
    .from(canvasEdges)
    .where(eq(canvasEdges.to, nodeId))
  const plan = await loadInputPlan(node, incoming, spec)
  const problems = [...specProblems(spec, plan.promptText != null), ...plan.problems]
  if (spec.edit?.maskAssetId) {
    const m = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, spec.edit.maskAssetId), eq(assets.projectId, canvas.projectId)))
      .limit(1)
    if (!m[0]) problems.push(`蒙版资产 #${spec.edit.maskAssetId} 不存在或不属于项目`)
  }
  if (spec.bgmAssetId != null) {
    const b = await db
      .select({ id: assets.id, kind: assets.kind, deletedAt: assets.deletedAt })
      .from(assets)
      .where(and(eq(assets.id, spec.bgmAssetId), eq(assets.projectId, canvas.projectId)))
      .limit(1)
    if (!b[0] || b[0].deletedAt != null || b[0].kind !== 'audio') problems.push(`BGM 资产 #${spec.bgmAssetId} 不存在或不是本项目音频`)
  }
  if (spec.genKind === 'llm') {
    // [M18] LLM 未配置 → readiness problem 引导 Settings（口径与 chatCompleteDetailed 抛错一致）
    const ep = await resolveLlmEndpoint()
    if (!ep.baseUrl || !ep.apiKey) {
      problems.push('LLM 未配置：请在 Settings → AI 配置检查 llm 实例（或 .env 设置 AGENT_LLM_BASE_URL/AGENT_LLM_API_KEY）')
    }
  }
  return { node, canvas, spec, plan, problems }
}

// ---------- [M18] 执行成本预估 ----------

/** [M18] 预估单行（unit 行；unitPrice/subtotal 为 null = 未计价） */
export interface PreviewUnitLine {
  unit: UsageUnit
  quantity: number
  unitPrice: number | null
  subtotal: number | null
}

/** [M18] 预估节点条目（ready = 无 problems 且非 busy） */
export interface PreviewNodeItem {
  nodeId: number
  title: string
  genKind: string
  ready: boolean
  busy: boolean
  problems: string[]
  units: PreviewUnitLine[]
  total: number | null
  unpriced: boolean
}

/** [M18] 预估响应（total.amount 仅含有价节点；unpriced = 未计价节点数） */
export interface PreviewCanvasResult {
  nodes: PreviewNodeItem[]
  total: { amount: number; unpriced: number; ready: number; blocked: number; busy: number }
}

/**
 * [M18] 画布执行成本预估（零副作用：不建任务、不发外部请求）：
 * - 节点集合：nodeIds 缺省 = 全部 gen 节点；显式 → 去重正整数（画布域校验）；
 * - 单位矩阵：image → 1 张；video → spec.duration ?? 5 秒；audio → 指令文本字数（promptText ?? spec.prompt）；
 *   compose → 本地零成本（total=0）；llm → unpriced（tokens 不可预知，前端显示「按量计费」）；
 * - 单价链：resolveUnitPrice（实例级 → settings.pricing → null）与 recordUsage 快照同源；
 * - 就绪性复用 preflightNode（与 startCanvasNodeRun 同源）。
 */
export async function previewCanvasRun(canvas: Canvas, nodeIds?: unknown): Promise<PreviewCanvasResult> {
  let ids: number[]
  if (nodeIds === undefined || nodeIds === null) {
    const rows = await db
      .select({ id: canvasNodes.id })
      .from(canvasNodes)
      .where(and(eq(canvasNodes.canvasId, canvas.id), eq(canvasNodes.kind, 'gen')))
    ids = rows.map((r) => r.id)
  } else {
    if (!Array.isArray(nodeIds)) throw new Error('nodeIds 需为正整数数组')
    ids = [...new Set(nodeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    if (ids.length === 0) throw new Error('nodeIds 需为正整数数组')
  }
  const busySet = new Set<number | null>(
    ids.length === 0
      ? []
      : (
          await db
            .select({ nodeId: genTasks.canvasNodeId })
            .from(genTasks)
            .where(and(inArray(genTasks.canvasNodeId, ids), inArray(genTasks.status, ['pending', 'processing'])))
        ).map((r) => r.nodeId),
  )

  const items: PreviewNodeItem[] = []
  for (const id of ids) {
    let pf: NodePreflight
    try {
      pf = await preflightNode(id)
      if (pf.canvas.id !== canvas.id) throw new Error(`节点 #${id} 不属于该画布`)
    } catch (err) {
      items.push({
        nodeId: id,
        title: `#${id}`,
        genKind: '',
        ready: false,
        busy: false,
        problems: [(err as Error).message],
        units: [],
        total: null,
        unpriced: false,
      })
      continue
    }
    const units: PreviewUnitLine[] = []
    let unpriced = false
    const pushUnit = async (
      kind: UsageKind,
      unit: UsageUnit,
      quantity: number,
      provider: string | null,
      model: string | null,
    ): Promise<void> => {
      const unitPrice = await resolveUnitPrice({ kind, provider, model, unit })
      const subtotal = unitPrice === null ? null : Math.round(quantity * unitPrice * 1e6) / 1e6
      if (unitPrice === null) unpriced = true
      units.push({ unit, quantity, unitPrice, subtotal })
    }
    if (pf.problems.length === 0) {
      if (pf.spec.genKind === 'image') {
        await pushUnit('image', 'image', 1, pf.spec.provider ?? null, pf.spec.model ?? null)
      } else if (pf.spec.genKind === 'video') {
        const duration = typeof pf.spec.duration === 'number' && pf.spec.duration > 0 ? pf.spec.duration : 5
        await pushUnit('video', 'second', duration, pf.spec.provider ?? null, pf.spec.model ?? null)
      } else if (pf.spec.genKind === 'audio') {
        const text = (pf.plan.promptText ?? pf.spec.prompt).trim()
        let provider = pf.spec.provider ?? null
        let model = pf.spec.model ?? null
        try {
          const endpoint = await resolveAudioEndpoint(pf.spec.provider)
          provider = endpoint.providerKey
          model = endpoint.model
        } catch { /* 音频端点未配置 → 退回 spec 声明（未命中即 unpriced） */ }
        await pushUnit('tts', 'char', text.length, provider, model)
      } else if ((pf.spec.genKind as string) === 'llm') {
        unpriced = true // [P4] tokens 不可预知（按量计费）
      }
      // compose：本地零成本（units 空 → total=0）
    }
    const busy = busySet.has(id)
    let total: number | null = null
    if (units.length > 0) {
      total = units.every((u) => u.subtotal != null)
        ? Math.round(units.reduce((s, u) => s + (u.subtotal ?? 0), 0) * 1e6) / 1e6
        : null
    } else if (pf.spec.genKind === 'compose') {
      total = 0
    }
    items.push({
      nodeId: id,
      title: pf.node.title ?? `#${id}`,
      genKind: pf.spec.genKind,
      ready: pf.problems.length === 0 && !busy,
      busy,
      problems: pf.problems,
      units,
      total,
      unpriced,
    })
  }

  const total = {
    amount: Math.round(items.reduce((s, it) => s + (it.total ?? 0), 0) * 1e6) / 1e6,
    unpriced: items.filter((it) => it.unpriced).length,
    ready: items.filter((it) => it.ready).length,
    blocked: items.filter((it) => !it.ready && !it.busy).length,
    busy: items.filter((it) => it.busy).length,
  }
  return { nodes: items, total }
}

export async function startCanvasNodeRun(
  nodeId: number,
  variants = 1,
): Promise<{ taskId: number; taskIds: number[] }> {
  if (!Number.isInteger(variants) || variants < 1 || variants > 4) throw new Error('variants 需为 1-4 的整数')
  const { node, canvas, spec, plan, problems } = await preflightNode(nodeId)

  const busy = await db
    .select({ id: genTasks.id })
    .from(genTasks)
    .where(and(eq(genTasks.canvasNodeId, nodeId), inArray(genTasks.status, ['pending', 'processing'])))
    .limit(1)
  if (busy.length > 0) throw new Error('节点已有进行中的任务（可先在检查器取消或等待完成）')
  if (problems.length > 0) throw new Error(`节点未就绪：${problems.join('；')}`)

  const styleResolved =
    spec.genKind === 'image' && spec.useStylePreset !== false
      ? await resolveProjectStyleSnippets(canvas.projectId)
      : []
  const params = extendTaskParams(buildNodeTaskParams(spec, { stylePresetIds: styleResolved.map((s) => s.id), plan }), spec)
  const now = nowMs()
  const taskIds: number[] = []
  for (let i = 0; i < variants; i += 1) {
    const [task] = await db
      .insert(genTasks)
      .values({
        projectId: canvas.projectId,
        runId: null,
        stepId: null,
        canvasNodeId: node.id,
        kind: spec.genKind,
        provider: spec.provider ?? null,
        model: spec.model ?? null,
        prompt: spec.prompt,
        params: JSON.stringify(params),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: genTasks.id })
    taskIds.push(task!.id)
  }
  emitCanvasChanged(canvas, node.id)
  for (const id of taskIds) {
    void runCanvasTask(id).catch((err) => log.error(`canvas task ${id} crashed: ${(err as Error).message}`))
  }
  return { taskId: taskIds[0]!, taskIds }
}

function emitCanvasChanged(canvas: Canvas, nodeId?: number): void {
  emitStudioEvent({ type: 'canvas.changed', canvasId: canvas.id, projectId: canvas.projectId, nodeId })
}

// ---------- 任务执行（镜像 runOneTask 生命周期） ----------

async function runCanvasTask(taskId: number): Promise<void> {
  await acquireSlot()
  try {
    const task = await reloadTask(taskId)
    if (!task || task.status !== 'pending') return // 排队期间被取消
    const node = task.canvasNodeId != null ? await findNode(task.canvasNodeId) : null
    if (!node || node.kind !== 'gen') {
      await failTask(taskId, '画布节点缺失', null)
      return
    }
    const canvas = await canvasOfNode(node.id)
    if (!canvas) {
      await failTask(taskId, '画布缺失', null)
      return
    }
    const parsed = safeParseSpec(node.spec)
    if (!parsed.spec) {
      await failTask(taskId, `spec 损坏：${parsed.error}`, canvas, node.id)
      return
    }
    const spec = parsed.spec
    let attempts = task.attempts
    for (;;) {
      if (await taskCancelled(taskId)) return // 任务行已 cancelled（取消端点）
      attempts += 1
      await db
        .update(genTasks)
        .set({ status: 'processing', attempts, errorMsg: null, updatedAt: nowMs() })
        .where(eq(genTasks.id, taskId))
      emitCanvasChanged(canvas, node.id)
      try {
        await executeOnce(taskId, task, node, canvas, spec)
        return
      } catch (err) {
        if (err instanceof CanvasTaskCancelled) return
        const msg = (err as Error).message
        if (attempts >= MAX_ATTEMPTS) {
          await failTask(taskId, msg, canvas, node.id)
          log.warn(`canvas task ${taskId} failed: ${msg}`)
          return
        }
        log.warn(`canvas task ${taskId} attempt ${attempts}/${MAX_ATTEMPTS} failed（1.5s 后重试）：${msg}`)
        await sleep(1_500)
      }
    }
  } finally {
    releaseSlot()
  }
}

/** 单次执行：输入解析 → 分派（audio/compose/llm 独立径；编辑/图片/视频主径）→ 落盘 → succeeded + 用量 */
async function executeOnce(taskId: number, task: GenTask, node: CanvasNode, canvas: Canvas, spec: NodeSpec): Promise<void> {
  const incoming = await db
    .select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port })
    .from(canvasEdges)
    .where(eq(canvasEdges.to, node.id))
  const plan = await loadInputPlan(node, incoming, spec)
  if (plan.problems.length > 0) throw new Error(`输入未就绪：${plan.problems.join('；')}`)
  // [M17] audio / compose 独立执行径（不展开风格与参考图 URI）
  if (spec.genKind === 'audio') return executeAudioOnce(taskId, canvas, node, spec, plan)
  if (spec.genKind === 'compose') return executeComposeOnce(taskId, canvas, node, spec, plan)
  if (spec.genKind === 'llm') return executeLlmOnce(taskId, canvas, node, spec, plan)
  const uriCache = new Map<number, string>()

  const styleSnippet =
    spec.genKind === 'image' && spec.useStylePreset !== false
      ? combineStyleSnippets((await resolveProjectStyleSnippets(canvas.projectId)).map((s) => s.snippet))
      : null
  let finalPrompt = (plan.promptText ?? spec.prompt).trim()
  let providerKey = ''
  let usedModel: string | null = null
  let source: { kind: 'url'; url: string } | { kind: 'base64'; data: string; mime: string } | null = null
  let width: number | undefined
  let height: number | undefined
  let thirdPartyTaskId: string | null = null

  if (spec.edit) {
    // 编辑通道：source → baseImage；mask（inpaint/erase）；adapter.edit（能力声明制）
    const sourceUri = plan.sourceAssetId != null ? await assetToDataUri(plan.sourceAssetId, uriCache) : null
    if (!sourceUri) throw new Error('编辑节点缺少源图产物')
    let maskUri: string | undefined
    if (spec.edit.mode === 'inpaint' || spec.edit.mode === 'erase') {
      maskUri = spec.edit.maskAssetId != null ? await assetToDataUri(spec.edit.maskAssetId, uriCache) : undefined
      if (!maskUri) throw new Error('缺少蒙版资产')
    }
    const endpoint = await resolveEndpoint('image', spec.provider)
    const adapter = getImageAdapter(endpoint.providerKey)
    if (!adapter.edit) throw new Error(`供应商「${endpoint.providerKey}」未实现图像编辑能力`)
    const editParams = buildEditParams(spec, { baseImage: sourceUri, mask: maskUri })
    // [M17] prompt 端口覆盖（text 节点内容优先于 spec.prompt；与图片/视频径一致）
    if (plan.promptText != null) editParams.prompt = plan.promptText
    const prompt = styleSnippet ? appendStyleSnippet(editParams.prompt ?? '', styleSnippet) : editParams.prompt
    const img = await adapter.edit({
      ...editParams,
      prompt,
      model: spec.model, // 缺省 → 适配器内置编辑模型（端点默认生成模型不适用于编辑）
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      extra: endpoint.extra,
    })
    providerKey = adapter.provider
    usedModel = spec.model ?? null
    source = img.kind === 'url' ? { kind: 'url', url: img.url } : { kind: 'base64', data: img.data, mime: img.mime }
    width = img.width
    height = img.height
  } else if (spec.genKind === 'image') {
    finalPrompt = styleSnippet ? appendStyleSnippet(finalPrompt, styleSnippet) : finalPrompt
    const refUris: string[] = []
    for (const id of plan.referenceAssetIds) {
      try {
        refUris.push(await assetToDataUri(id, uriCache))
      } catch (err) {
        log.warn(`参考图 asset#${id} 跳过（${(err as Error).message}）`)
      }
    }
    const { adapter, request } = await buildImageRequest({
      prompt: finalPrompt,
      provider: spec.provider,
      model: spec.model,
      size: spec.size,
      referenceImages: refUris.length > 0 ? refUris : undefined,
    })
    const img = await adapter.generate(request)
    providerKey = adapter.provider
    usedModel = request.model ?? null
    source = img.kind === 'url' ? { kind: 'url', url: img.url } : { kind: 'base64', data: img.data, mime: img.mime }
    width = img.width
    height = img.height
  } else {
    // 视频通道：首帧优先（规避帧/参考互斥，镜像 ai_video planVideoRefs 语义）
    const refUris: string[] = []
    for (const id of plan.referenceAssetIds) {
      try {
        refUris.push(await assetToDataUri(id, uriCache))
      } catch (err) {
        log.warn(`参考图 asset#${id} 跳过（${(err as Error).message}）`)
      }
    }
    let firstFrameUri: string | undefined
    if (plan.firstFrameAssetId != null) {
      try {
        firstFrameUri = await assetToDataUri(plan.firstFrameAssetId, uriCache)
      } catch (err) {
        log.warn(`首帧 asset#${plan.firstFrameAssetId} 跳过（${(err as Error).message}）`)
      }
    }
    let lastFrameUri: string | undefined
    if (plan.lastFrameAssetId != null) {
      try {
        lastFrameUri = await assetToDataUri(plan.lastFrameAssetId, uriCache)
      } catch (err) {
        log.warn(`尾帧 asset#${plan.lastFrameAssetId} 跳过（${(err as Error).message}）`)
      }
    }
    const { adapter, request } = await buildVideoRequest({
      prompt: finalPrompt,
      provider: spec.provider,
      model: spec.model,
      duration: spec.duration,
      resolution: spec.resolution,
      aspectRatio: spec.aspectRatio,
      firstFrameUrl: firstFrameUri,
      lastFrameUrl: lastFrameUri,
      ...(!firstFrameUri && refUris.length > 0 ? { extra: { referenceImageUrls: refUris } } : {}),
    })
    const gen = await adapter.generate(request)
    let videoUrl: string | null = gen.kind === 'url' ? gen.url : null
    if (gen.kind === 'poll') {
      thirdPartyTaskId = gen.taskId
      await db.update(genTasks).set({ taskId: gen.taskId, updatedAt: nowMs() }).where(eq(genTasks.id, taskId))
      log.info(`canvas task ${taskId} 已提交第三方（task_id=${gen.taskId}），开始轮询`)
      videoUrl = await pollCanvasVideoTask(taskId, adapter, request, gen.taskId)
    }
    providerKey = adapter.provider
    usedModel = request.model ?? null
    source =
      gen.kind === 'base64'
        ? { kind: 'base64', data: gen.data, mime: gen.mime }
        : videoUrl
          ? { kind: 'url', url: videoUrl }
          : null
    if (!source) throw new Error('第三方返回成功但缺少视频产物（url/base64）')
  }

  // 取消竞态：图片生成不可中断——生成完成后若已取消 → 弃存（视频轮询已在过程中中止）
  if (await taskCancelled(taskId)) return
  if (!source) throw new Error('生成结果为空')

  const asset = await saveGeneratedMedia({
    projectId: canvas.projectId,
    taskId,
    runId: null,
    kind: spec.genKind,
    purpose: spec.genKind === 'video' ? 'creation_video' : 'creation',
    prompt: finalPrompt || spec.prompt,
    params: {
      canvasId: canvas.id,
      nodeId: node.id,
      provider: providerKey,
      model: usedModel,
      taskId: thirdPartyTaskId,
      size: spec.size ?? null,
      duration: spec.duration ?? null,
      edit: spec.edit ? { mode: spec.edit.mode, maskAssetId: spec.edit.maskAssetId ?? null } : null,
    },
    source,
    width,
    height,
    duration: spec.duration,
  })
  scheduleImageCheck(asset)
  await db
    .update(genTasks)
    .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
    .where(eq(genTasks.id, taskId))
  emitCanvasChanged(canvas, node.id)

  // 用量记录（画布任务无 run；taskId 关联）
  if (spec.genKind === 'image') {
    await recordUsage({
      projectId: canvas.projectId,
      runId: null,
      taskId,
      assetId: asset.id,
      kind: 'image',
      unit: 'image',
      quantity: 1,
      provider: providerKey,
      model: usedModel,
    })
  } else if (typeof spec.duration === 'number' && spec.duration > 0) {
    await recordUsage({
      projectId: canvas.projectId,
      runId: null,
      taskId,
      assetId: asset.id,
      kind: 'video',
      unit: 'second',
      quantity: spec.duration,
      provider: providerKey,
      model: usedModel,
    })
  }
  log.info(`canvas node #${node.id} 生成完成 → asset#${asset.id}`)
}

// ---------- [M17/M18] audio / compose / llm 执行径 ----------

/** [M17/M18] compose 输入资产 → 本地路径 + 时长元数据（软删/无文件/缺文件即抛错，避免 ffmpeg 半途失败） */
interface ComposeInput {
  path: string
  duration: number | null
}

async function composeInputsOf(assetIds: number[], label: string): Promise<ComposeInput[]> {
  if (assetIds.length === 0) return []
  const rows = await db.select().from(assets).where(inArray(assets.id, assetIds))
  const byId = new Map(rows.map((a) => [a.id, a]))
  const out: ComposeInput[] = []
  for (const id of assetIds) {
    const a = byId.get(id)
    if (!a || a.deletedAt != null) throw new Error(`${label}输入 asset#${id} 已删除`)
    if (!a.relPath) throw new Error(`${label}输入 asset#${id} 无本地文件`)
    const abs = absPathOf(a.relPath)
    if (!existsSync(abs)) throw new Error(`${label}输入 asset#${id} 文件缺失（${a.relPath}）`)
    out.push({ path: abs, duration: typeof a.duration === 'number' && a.duration > 0 ? a.duration : null })
  }
  return out
}

/** [M17] 项目 settings.audio.voice（声线链第 4 级；缺失/损坏 → undefined） */
async function projectAudioVoice(projectId: number): Promise<string | undefined> {
  const rows = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1)
  try {
    const settings = JSON.parse(rows[0]?.settings ?? '{}') as Record<string, unknown>
    const audio = settings['audio'] as Record<string, unknown> | undefined
    const voice = audio?.['voice']
    return typeof voice === 'string' && voice.trim() ? voice.trim() : undefined
  } catch {
    return undefined
  }
}

/** [M17] ffprobe 探测视频宽高（失败 → null；宽高向下取偶） */
function probeVideoSize(file: string): ComposeSize | null {
  const ffprobe = resolveFfprobe()
  if (!ffprobe) return null
  try {
    const r = spawnSync(
      ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', file],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
    )
    if (r.error || r.status !== 0) return null
    const m = /^(\d+)x(\d+)/.exec(String(r.stdout ?? '').trim())
    if (!m) return null
    const width = Number(m[1])
    const height = Number(m[2])
    if (width <= 0 || height <= 0) return null
    return { width: width - (width % 2), height: height - (height % 2) }
  } catch {
    return null
  }
}

/** [M17] ffmpeg 执行（异步 spawn；超时 10min；stderr 尾部保留并在失败时附上） */
function runComposeFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let tail = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`ffmpeg 合成超时（>${COMPOSE_TIMEOUT_MS / 60_000} 分钟）`))
    }, COMPOSE_TIMEOUT_MS)
    child.stderr?.on('data', (buf: Buffer) => {
      tail = (tail + buf.toString('utf8')).slice(-2000)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 合成失败（exit=${code}）：${tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ') || '(无输出)'}`))
    })
  })
}

/** [M17] 音频执行径：声线链（params → settings → 实例 → alloy）→ synthSpeech → 落盘 → succeeded + 用量(tts/char) */
async function executeAudioOnce(taskId: number, canvas: Canvas, node: CanvasNode, spec: NodeSpec, plan: InputPlan): Promise<void> {
  const text = (plan.promptText ?? spec.prompt).trim()
  if (!text) throw new Error('音频文本为空（请在 prompt 填写内容或连线提示词节点）')
  const endpoint = await resolveAudioEndpoint(spec.provider)
  const settingsVoice = await projectAudioVoice(canvas.projectId)
  const { voice, source: voiceSource } = resolveVoiceChain({
    paramVoice: spec.voice,
    settingsVoice,
    instanceVoice: endpoint.voice,
  })
  log.info(`canvas node #${node.id} 音频合成：${endpoint.providerKey}/${endpoint.model} voice=${voice}（${voiceSource}）${text.length} 字`)
  const data = await synthSpeech(text, endpoint, { voice, speed: spec.speed })
  if (await taskCancelled(taskId)) return // 生成不可中断——完成后若已取消 → 弃存

  const fileName = `${Date.now()}-voice-node${node.id}.mp3`
  const relPath = relPathOf(canvas.projectId, 'creation_audio', fileName)
  ensureProjectDirs(canvas.projectId)
  writeFileSync(absPathOf(relPath), data)
  const asset = await registerAsset(canvas.projectId, {
    taskId,
    runId: null,
    kind: 'audio',
    purpose: 'creation_audio',
    relPath,
    name: fileName,
    mime: 'audio/mpeg',
    ext: 'mp3',
    fileSize: data.byteLength,
    prompt: text.slice(0, 4000),
    params: {
      canvasId: canvas.id,
      nodeId: node.id,
      provider: endpoint.providerKey,
      model: endpoint.model,
      voice,
      voiceSource,
      speed: spec.speed ?? null,
      chars: text.length,
    },
    tags: ['voice'],
  })
  await db
    .update(genTasks)
    .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
    .where(eq(genTasks.id, taskId))
  emitCanvasChanged(canvas, node.id)
  await recordUsage({
    projectId: canvas.projectId,
    runId: null,
    taskId,
    assetId: asset.id,
    kind: 'tts',
    unit: 'char',
    quantity: text.length,
    provider: endpoint.providerKey,
    model: endpoint.model,
  })
  log.info(`canvas node #${node.id} 音频完成 → asset#${asset.id}`)
}

/**
 * [M18] LLM 文本执行径：指令（prompt 端口文本 > spec.prompt）+ 文本素材（text 端口 ≤4 段拼接）+
 * 参考图（≤4 多模态 ChatContentPart，镜像 style-preset 先例）→ chatCompleteDetailed →
 * writeTextAsset(purpose='creation_llm') → succeeded + recordLlmUsage（tokens_in/out）。
 */
async function executeLlmOnce(taskId: number, canvas: Canvas, node: CanvasNode, spec: NodeSpec, plan: InputPlan): Promise<void> {
  const instruction = (plan.promptText ?? spec.prompt).trim()
  if (!instruction) throw new Error('LLM 指令为空（请在 prompt 填写指令或连线文本节点）')
  const uriCache = new Map<number, string>()
  const imageParts: ChatContentPart[] = []
  for (const id of plan.referenceAssetIds) {
    try {
      imageParts.push({ type: 'image_url', image_url: { url: await assetToDataUri(id, uriCache) } })
    } catch (err) {
      log.warn(`LLM 参考图 asset#${id} 跳过（${(err as Error).message}）`)
    }
  }
  let body = instruction
  if (plan.textInputs.length > 0) {
    const sections = plan.textInputs.map((t, i) => `--- 素材 ${i + 1} ---\n${t}`).join('\n\n')
    body = `${sections}\n\n---\n\n指令：${instruction}`
  }
  const endpoint = await resolveLlmEndpoint()
  log.info(
    `canvas node #${node.id} LLM 开始：${endpoint.providerKey}/${endpoint.model}（素材 ${plan.textInputs.length} 段，参考图 ${imageParts.length} 张）`,
  )
  const res = await chatCompleteDetailed(
    [
      {
        role: 'system',
        content:
          '你是创作画布的文本处理引擎。按用户指令处理提供的资料（文本素材与图片）：结合资料内容完成任务；' +
          '只输出任务要求的结果本体，不输出任何解释性前言或后记。',
      },
      { role: 'user', content: imageParts.length > 0 ? [{ type: 'text', text: body }, ...imageParts] : body },
    ],
    endpoint,
    { temperature: spec.temperature ?? 0.8, maxTokens: spec.maxTokens ?? 12000, timeoutMs: 600_000 },
  )
  if (await taskCancelled(taskId)) return // 生成不可中断——完成后若已取消 → 弃存
  const text = res.content.trim()
  if (!text) throw new Error('LLM 返回为空')
  const asset = await writeTextAsset(canvas.projectId, {
    name: `LLM 文本 #${node.id}.md`,
    content: text,
    purpose: 'creation_llm',
    taskId,
    runId: null,
    prompt: instruction.slice(0, 4000),
    params: {
      canvasId: canvas.id,
      nodeId: node.id,
      provider: res.provider,
      model: res.model,
      temperature: spec.temperature ?? null,
      materials: plan.textInputs.length,
      images: imageParts.length,
      chars: text.length,
    },
    tags: ['llm'],
  })
  await db
    .update(genTasks)
    .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
    .where(eq(genTasks.id, taskId))
  emitCanvasChanged(canvas, node.id)
  await recordLlmUsage({ projectId: canvas.projectId, runId: null, provider: res.provider, model: res.model, usage: res.usage })
  log.info(`canvas node #${node.id} LLM 完成 → asset#${asset.id}（${text.length} 字符）`)
}

/** [M17/M18] 合成执行径：输入路径解析（+时长元数据）→ ffmpeg（resolution 优先；多段缺省探测第一段；[M18] 转场/BGM）→ 落盘 → succeeded（无外部用量） */
async function executeComposeOnce(taskId: number, canvas: Canvas, node: CanvasNode, spec: NodeSpec, plan: InputPlan): Promise<void> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    throw new Error('未找到可用 ffmpeg：内置二进制与系统 PATH 均不可用；请先在仓库根 pnpm install（重新下载内置二进制），或在 .env 设 CSTUDIO_FFMPEG_PATH 指向 ffmpeg.exe')
  }
  const videoIns = await composeInputsOf(plan.videoAssetIds, '视频')
  const audioIns = await composeInputsOf(plan.audioAssetIds, '音频')
  const videoPaths = videoIns.map((v) => v.path)
  const audioPaths = audioIns.map((a) => a.path)
  // [M18] 段时长：资产元数据优先，缺失 ffprobe 兜底；任一未知 → durations=null → 转场/BGM 宽容降级
  const resolvedDurs = videoIns.map((v) => v.duration ?? probeMediaDuration(v.path))
  const durations = resolvedDurs.every((d): d is number => typeof d === 'number' && d > 0) ? resolvedDurs : null
  let bgmPath: string | null = null
  if (spec.bgmAssetId != null) {
    const [b] = await composeInputsOf([spec.bgmAssetId], '背景音乐')
    bgmPath = b?.path ?? null
    if (bgmPath && !durations) log.warn(`画布节点 #${node.id} 已设置 BGM/转场但视频段时长未知（宽容降级跳过）`)
  }
  let size: ComposeSize | null = null
  if (spec.resolution) {
    size = parseResolution(spec.resolution)
  } else if (videoPaths.length >= 2) {
    size = probeVideoSize(videoPaths[0]!)
    if (!size) throw new Error('合成尺寸未知：请设置 resolution（WxH 如 1080x1920），或确保 ffprobe 可用（自动探测第一段视频尺寸）')
  }
  const fileName = `${Date.now()}-compose-node${node.id}.mp4`
  const relPath = relPathOf(canvas.projectId, 'creation_compose', fileName)
  const outAbs = absPathOf(relPath)
  ensureProjectDirs(canvas.projectId)
  const args = buildComposeArgs({
    videoPaths,
    audioPaths,
    outPath: outAbs,
    fps: spec.fps,
    size,
    durations,
    transition: spec.transition ?? null,
    transitionDuration: spec.transitionDuration ?? null,
    bgmPath,
    bgmVolume: spec.bgmVolume ?? null,
    bgmFade: spec.bgmFade ?? null,
  })
  if (await taskCancelled(taskId)) return
  const transDesc = spec.transition && spec.transition !== 'none' && durations ? `转场=${spec.transition}` : ''
  const bgmDesc = bgmPath && durations ? 'BGM=有' : ''
  log.info(
    `canvas node #${node.id} 合成开始：${videoPaths.length} 视频 + ${audioPaths.length} 音频${size ? ` → ${size.width}x${size.height}` : ''}${spec.fps ? ` @${spec.fps}fps` : ''}${transDesc ? ` ${transDesc}` : ''}${bgmDesc ? ` ${bgmDesc}` : ''}`,
  )
  await runComposeFfmpeg(ffmpeg, args)
  if (await taskCancelled(taskId)) {
    rmSync(outAbs, { force: true }) // 本地进程不可中断——完成后若已取消 → 弃存
    return
  }
  const stat = statSync(outAbs, { throwIfNoEntry: false })
  if (!stat) throw new Error('合成完成但未生成输出文件')
  const duration = probeMediaDuration(outAbs)
  const asset = await registerAsset(canvas.projectId, {
    taskId,
    runId: null,
    kind: 'video',
    purpose: 'creation_compose',
    relPath,
    name: fileName,
    mime: 'video/mp4',
    ext: 'mp4',
    fileSize: stat.size,
    width: size?.width,
    height: size?.height,
    duration: duration ?? undefined,
    params: {
      canvasId: canvas.id,
      nodeId: node.id,
      resolution: spec.resolution ?? (size ? `${size.width}x${size.height}` : null),
      fps: spec.fps ?? null,
      videos: plan.videoAssetIds,
      audios: plan.audioAssetIds,
      duration: duration ?? null,
      transition: spec.transition ?? null,
      transitionDuration: spec.transitionDuration ?? null,
      bgmAssetId: spec.bgmAssetId ?? null,
    },
    tags: ['compose'],
  })
  await db
    .update(genTasks)
    .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
    .where(eq(genTasks.id, taskId))
  emitCanvasChanged(canvas, node.id)
  log.info(`canvas node #${node.id} 合成完成 → asset#${asset.id}（${Math.round(stat.size / 1024)} KB${duration ? `, ${Math.round(duration * 10) / 10}s` : ''}）`)
}

/** 视频轮询：每轮检查取消；超时 10min / failed → 抛错 */
async function pollCanvasVideoTask(
  taskId: number,
  adapter: VideoAdapter,
  request: VideoGenRequest,
  thirdPartyId: string,
): Promise<string | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    if (await taskCancelled(taskId)) throw new CanvasTaskCancelled()
    let res: { status: 'pending' | 'processing' | 'completed' | 'failed'; url?: string; error?: string }
    try {
      res = await adapter.query(thirdPartyId, { baseUrl: request.baseUrl, apiKey: request.apiKey })
    } catch (err) {
      log.warn(`轮询查询异常（继续等待）: ${(err as Error).message}`)
      res = { status: 'processing' }
    }
    if (res.status === 'completed') return res.url ?? null
    if (res.status === 'failed') throw new Error(res.error ?? '第三方任务失败')
    if (Date.now() > deadline) throw new Error(`视频任务轮询超时（>10 分钟，task_id=${thirdPartyId}）`)
    await sleep(POLL_INTERVAL_MS)
  }
}

// ---------- 状态工具与恢复 ----------

async function reloadTask(taskId: number): Promise<GenTask | null> {
  const rows = await db.select().from(genTasks).where(eq(genTasks.id, taskId)).limit(1)
  return rows[0] ?? null
}

async function taskCancelled(taskId: number): Promise<boolean> {
  const rows = await db.select({ status: genTasks.status }).from(genTasks).where(eq(genTasks.id, taskId)).limit(1)
  return rows[0]?.status === 'cancelled'
}

async function failTask(taskId: number, msg: string, canvas: Canvas | null, nodeId?: number): Promise<void> {
  await db
    .update(genTasks)
    .set({ status: 'failed', errorMsg: msg, completedAt: nowMs(), updatedAt: nowMs() })
    .where(eq(genTasks.id, taskId))
  if (canvas) emitCanvasChanged(canvas, nodeId)
}

/** 启动恢复：画布任务（canvasNodeId 非空）pending/processing → failed「服务重启中断」（不自动重排队） */
export async function recoverCanvasTasks(): Promise<{ failed: number }> {
  const now = nowMs()
  const rows = await db
    .update(genTasks)
    .set({ status: 'failed', errorMsg: '服务重启中断', completedAt: now, updatedAt: now })
    .where(and(isNotNull(genTasks.canvasNodeId), inArray(genTasks.status, ['pending', 'processing'])))
    .returning({ id: genTasks.id })
  return { failed: rows.length }
}

/**
 * [M18] 一键停止全部：该画布全部 pending/processing 任务 → cancelled
 * （复刻 tasks.ts 单任务取消语义：errorMsg='user cancelled' + completedAt）；返回停止数。
 */
export async function cancelCanvasTasks(canvas: Canvas): Promise<{ cancelled: number }> {
  const now = nowMs()
  const targets = await db
    .select({ id: genTasks.id })
    .from(genTasks)
    .innerJoin(canvasNodes, eq(genTasks.canvasNodeId, canvasNodes.id))
    .where(and(eq(canvasNodes.canvasId, canvas.id), inArray(genTasks.status, ['pending', 'processing'])))
  if (targets.length > 0) {
    await db
      .update(genTasks)
      .set({ status: 'cancelled', errorMsg: 'user cancelled', completedAt: now, updatedAt: now })
      .where(inArray(genTasks.id, targets.map((t) => t.id)))
    emitCanvasChanged(canvas)
  }
  return { cancelled: targets.length }
}
