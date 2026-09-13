import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, canvasEdges, genTasks } from '../db/schema'
import type { Canvas, CanvasNode, GenTask } from '../db/schema'
import { buildImageRequest, resolveEndpoint, getImageAdapter } from '../adapters/provider'
import { buildVideoRequest } from '../adapters/video'
import type { ImageEditRequest, VideoAdapter, VideoGenRequest } from '../adapters/types'
import { createLogger } from '../logger'
import { assetToDataUri } from './asset-ref'
import {
  canvasOfNode,
  findNode,
  loadInputPlan,
  safeParseSpec,
  specProblems,
  type InputPlan,
  type NodeSpec,
} from './creation'
import { emitStudioEvent } from './events'
import { scheduleImageCheck } from './image-check'
import { saveGeneratedMedia } from './net'
import { combineStyleSnippets, resolveProjectStyleSnippets } from './style-preset'
import { recordUsage } from './usage'

/**
 * [M16] 创作画布执行通道（不复用 pipeline actions——其全为批处理/分镜驱动）：
 * - startCanvasNodeRun：readiness 预检 → 建 gen_tasks 行（runId/stepId 恒 null，canvasNodeId 归属）→ 入队异步执行；
 * - 执行镜像 ai_image / ai_video 的 runOneTask 生命周期：attempts 递增、processing→succeeded/failed、
 *   落盘 saveGeneratedMedia + scheduleImageCheck + recordUsage、失败自动重试 1 次（1.5s 间隔）；
 * - 取消：复用 POST /tasks/:id/cancel（改 status=cancelled）；执行器各检查点弃存（视频轮询每轮检查；
 *   图片生成不可中断——完成后若已取消则弃存）；
 * - 并发：进程内信号量 ≤CANVAS_MAX_CONCURRENCY；崩溃恢复 recoverCanvasTasks（启动时调用）。
 */

const log = createLogger('creation-gen')

export const CANVAS_MAX_CONCURRENCY = 2
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 2 // 自动重试 1 次（镜像 ai_image maxRetry=1）

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

// ---------- 启动执行 ----------

export async function startCanvasNodeRun(nodeId: number): Promise<{ taskId: number }> {
  const node = await findNode(nodeId)
  if (!node) throw new Error(`画布节点 ${nodeId} 不存在`)
  if (node.kind !== 'gen') throw new Error('仅生成节点可执行')
  const canvas = await canvasOfNode(nodeId)
  if (!canvas) throw new Error('画布不存在')
  const parsed = safeParseSpec(node.spec)
  if (!parsed.spec) throw new Error(`节点不可执行：${parsed.error}`)
  const spec = parsed.spec

  const busy = await db
    .select({ id: genTasks.id })
    .from(genTasks)
    .where(and(eq(genTasks.canvasNodeId, nodeId), inArray(genTasks.status, ['pending', 'processing'])))
    .limit(1)
  if (busy.length > 0) throw new Error('节点已有进行中的任务（可先在检查器取消或等待完成）')

  const incoming = await db
    .select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port })
    .from(canvasEdges)
    .where(eq(canvasEdges.to, nodeId))
  const plan = await loadInputPlan(node, incoming, spec)
  const problems = [...specProblems(spec), ...plan.problems]
  if (spec.edit?.maskAssetId) {
    const m = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, spec.edit.maskAssetId), eq(assets.projectId, canvas.projectId)))
      .limit(1)
    if (!m[0]) problems.push(`蒙版资产 #${spec.edit.maskAssetId} 不存在或不属于项目`)
  }
  if (problems.length > 0) throw new Error(`节点未就绪：${problems.join('；')}`)

  const styleResolved =
    spec.genKind === 'image' && spec.useStylePreset !== false
      ? await resolveProjectStyleSnippets(canvas.projectId)
      : []
  const params = buildNodeTaskParams(spec, { stylePresetIds: styleResolved.map((s) => s.id), plan })
  const now = nowMs()
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
    .returning()
  emitCanvasChanged(canvas, node.id)
  void runCanvasTask(task!.id).catch((err) => log.error(`canvas task ${task!.id} crashed: ${(err as Error).message}`))
  return { taskId: task!.id }
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

/** 单次执行：输入解析 → 生成（编辑/图片/视频三径）→ 落盘 → succeeded + 用量 */
async function executeOnce(taskId: number, task: GenTask, node: CanvasNode, canvas: Canvas, spec: NodeSpec): Promise<void> {
  const incoming = await db
    .select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port })
    .from(canvasEdges)
    .where(eq(canvasEdges.to, node.id))
  const plan = await loadInputPlan(node, incoming, spec)
  if (plan.problems.length > 0) throw new Error(`输入未就绪：${plan.problems.join('；')}`)
  const uriCache = new Map<number, string>()

  const styleSnippet =
    spec.genKind === 'image' && spec.useStylePreset !== false
      ? combineStyleSnippets((await resolveProjectStyleSnippets(canvas.projectId)).map((s) => s.snippet))
      : null
  let finalPrompt = spec.prompt.trim()
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
