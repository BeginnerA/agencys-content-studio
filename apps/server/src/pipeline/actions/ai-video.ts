import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { genTasks, pipelineRuns, type GenTask } from '../../db/schema'
import { buildVideoRequest } from '../../adapters/video'
import type { VideoAdapter, VideoGenRequest } from '../../adapters/types'
import { saveGeneratedMedia } from '../../services/net'
import { emitStudioEvent } from '../../services/events'
import type { StepContext } from '../context'
import type { StepResult } from '../types'
import { RunCancelledError } from '../types'

interface ShotSpec {
  id: string
  image_prompt: string
  duration?: number
}

const nowMs = (): number => Date.now()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** 单镜头视频任务轮询上限（spec §5.1） */
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 10 * 60_000

/**
 * ai_video：批量镜头视频生成（spec §5.1，M2 启用）。
 * 输入 batch.field（默认 shots）→ 分镜 JSON 资产 → 每镜头一条 gen_task（kind=video）：
 * 适配器两形态——轮询型（提交拿 task_id → query 5s/次，超时 10min）与同步型（长请求直收
 * 字节，如 Pollinations）→ 均落盘为 video 资产（purpose=shot_video，params 溯源含 {taskId, provider}）。
 *
 * v1 为纯 prompt 驱动（文生视频，镜头 prompt 由 prompt_field 指定，缺省 shot.image_prompt）；
 * 首帧图/参考素材依赖公网可访 URL，待图床通道机制后扩展（适配器 extra 已预留
 * referenceImageUrls/firstFrameUrl 透传）。
 * 幂等：本 step 已 succeeded 的 task 跳过（断点续跑复用成功视频）；
 * failed 且 attempts 未超上限的 task 在本步重跑时自动补跑；
 * 未成功任务的 prompt/生成参数执行时与当前分镜/项目设置同步（修正分镜或调
 * 设置后续跑即生效），failed 且内容有变化的任务归零重排队。
 */
export async function aiVideo(ctx: StepContext): Promise<StepResult> {
  const batch = ctx.def.batch ?? { field: 'shots', maxConcurrent: 2, retry: 1 }
  const field = batch.field ?? 'shots'
  const concurrency = Math.max(1, batch.maxConcurrent ?? 2)
  const maxRetry = Math.max(0, batch.retry ?? 1)

  const shotIds = ctx.assetIdsOf(field)
  if (shotIds.length === 0) throw new Error(`inputs.${field} 无分镜资产`)
  const raw = await ctx.readText(shotIds[0]!)
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch (err) {
    throw new Error(`分镜 JSON 解析失败: ${(err as Error).message}`)
  }
  const shots: ShotSpec[] = Array.isArray(obj)
    ? (obj as ShotSpec[])
    : ((obj as { shots?: ShotSpec[] }).shots ?? [])
  if (!Array.isArray(shots) || shots.length === 0) throw new Error('分镜内容缺 shots 数组')
  const promptField = (ctx.def.params?.prompt_field as string | undefined) ?? 'image_prompt'
  for (const s of shots) {
    const p = s as unknown as Record<string, unknown>
    if (typeof p[promptField] !== 'string' || !String(p[promptField]).trim()) {
      throw new Error(`shot ${String(s?.id ?? '?')} 缺 ${promptField}`)
    }
  }

  const vidCfg = (ctx.settings.video ?? {}) as Record<string, unknown>
  const provider = typeof vidCfg['provider'] === 'string' ? vidCfg['provider'] : undefined
  const model = typeof vidCfg['model'] === 'string' ? vidCfg['model'] : undefined
  const fallbackDuration = typeof vidCfg['duration'] === 'number' ? vidCfg['duration'] : undefined
  const resolution = typeof vidCfg['resolution'] === 'string' ? vidCfg['resolution'] : undefined
  const aspectRatio = typeof vidCfg['aspect_ratio'] === 'string' ? vidCfg['aspect_ratio'] : undefined
  const episode = ctx.run.input ? safeGet(ctx.run.input, 'episode_number') : undefined

  ctx.log(
    `批量生成视频：${shots.length} 镜头 × ${provider ?? '默认供应商'}（并发 ${concurrency}，失败重试 ${maxRetry} 次，prompt 字段 ${promptField}）`,
  )

  // 既有任务（幂等续跑）：shotId → task 行
  const existing = await db
    .select()
    .from(genTasks)
    .where(and(eq(genTasks.runId, ctx.run.id), eq(genTasks.stepId, ctx.step.id)))
  const taskByShotId = new Map<string, GenTask>()
  for (const t of existing) {
    try {
      const p = JSON.parse(t.params) as { shotId?: string }
      if (p.shotId) taskByShotId.set(p.shotId, t)
    } catch {
      // 参数损坏任务：跳过（不参与队列也不视为成功）
    }
  }

  for (const shot of shots) {
    const promptText = String((shot as unknown as Record<string, unknown>)[promptField]).trim()
    const paramsJson = JSON.stringify({
      shotId: shot.id,
      duration: shot.duration ?? fallbackDuration ?? null,
      resolution: resolution ?? null,
      aspectRatio: aspectRatio ?? null,
      episode: episode ?? null,
    })
    const existingTask = taskByShotId.get(shot.id)
    if (!existingTask) {
      const t = nowMs()
      const row = await db
        .insert(genTasks)
        .values({
          projectId: ctx.run.projectId,
          runId: ctx.run.id,
          stepId: ctx.step.id,
          kind: 'video',
          provider: provider ?? null,
          model: model ?? null,
          prompt: promptText,
          params: paramsJson,
          status: 'pending',
          attempts: 0,
          createdAt: t,
          updatedAt: t,
        })
        .returning()
      taskByShotId.set(shot.id, row[0]!)
    } else if (existingTask.status !== 'succeeded' && existingTask.status !== 'cancelled') {
      // 未成功任务同步最新 prompt/参数：用户修正分镜（如内容审核改词）或调整
      // 项目 video 设置后，断点续跑/重跑即生效；failed 且有变化 → 归零重排队
      // （与 resume 迁移语义一致）；succeeded 保持产物溯源不动
      const changed = existingTask.prompt !== promptText || existingTask.params !== paramsJson
      if (changed) {
        const requeue = existingTask.status === 'failed'
        await db
          .update(genTasks)
          .set({
            prompt: promptText,
            params: paramsJson,
            ...(requeue ? { status: 'pending', attempts: 0, errorMsg: null } : {}),
            updatedAt: nowMs(),
          })
          .where(eq(genTasks.id, existingTask.id))
        existingTask.prompt = promptText
        existingTask.params = paramsJson
        if (requeue) {
          existingTask.status = 'pending'
          existingTask.attempts = 0
          existingTask.errorMsg = null
        }
      }
    }
  }

  // 执行队列：非 succeeded 且有重试余量；cancelled 不参与
  const queue = shots
    .map((s) => taskByShotId.get(s.id)!)
    .filter((t) => {
      if (t.status === 'succeeded' || t.status === 'cancelled') return false
      if (t.status === 'failed' && t.attempts > maxRetry) return false
      return true
    })
  const doneCount = shots.length - queue.length
  if (doneCount > 0) ctx.log(`跳过已有成功产物的 ${doneCount} 个镜头`)
  if (queue.length === 0) ctx.log('全部镜头已有成功产物，无新生成')

  const failures: Array<{ shotId: string; error: string }> = []
  await runPool(queue, concurrency, async (task) => {
    const fail = await runOneTask(ctx, task, { provider, model, maxRetry })
    if (fail) failures.push(fail)
  })

  if (failures.length > 0) {
    const sample = failures
      .slice(0, 3)
      .map((f) => `shot ${f.shotId}: ${f.error}`)
      .join('；')
    throw new Error(`视频生成失败 ${failures.length} 个镜头（可修正后断点续跑/重试任务）：${sample}`)
  }

  // 产物按 shots 顺序聚合
  const assetIds = shots
    .map((s) => taskByShotId.get(s.id)!.resultAssetId)
    .filter((id): id is number => typeof id === 'number')
  if (assetIds.length !== shots.length) {
    throw new Error(`产物与镜头数不符（${assetIds.length}/${shots.length}），请重试`)
  }
  ctx.log(`视频生成完成：${assetIds.length} 段 → ${assetIds.join(', ')}`)
  return { assetIds }
}

/** 单任务执行：提交第三方 → 轮询 → 下载落盘；attempts 续增，达上限后不再重试 */
async function runOneTask(
  ctx: StepContext,
  task: GenTask,
  cfg: { provider?: string; model?: string; maxRetry: number },
): Promise<{ shotId: string; error: string } | null> {
  const parsed = JSON.parse(task.params) as {
    shotId?: string
    duration?: number | null
    resolution?: string | null
    aspectRatio?: string | null
  }
  const shotId = parsed.shotId ?? '?'
  const maxAttempts = cfg.maxRetry + 1
  let attempts = task.attempts
  for (;;) {
    if (await runCancelled(ctx.run.id)) {
      await db
        .update(genTasks)
        .set({ status: 'cancelled', errorMsg: 'run cancelled', updatedAt: nowMs() })
        .where(eq(genTasks.id, task.id))
      throw new RunCancelledError()
    }
    attempts += 1
    await db
      .update(genTasks)
      .set({ status: 'processing', attempts, errorMsg: null, updatedAt: nowMs() })
      .where(eq(genTasks.id, task.id))
    emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'processing' })
    try {
      const { adapter, request } = await buildVideoRequest({
        prompt: task.prompt ?? '',
        provider: cfg.provider,
        model: cfg.model,
        duration: parsed.duration ?? undefined,
        resolution: parsed.resolution ?? undefined,
        aspectRatio: parsed.aspectRatio ?? undefined,
      })
      const gen = await adapter.generate(request)
      let videoUrl: string | null = gen.kind === 'url' ? gen.url : null
      let thirdPartyTaskId: string | null = gen.kind === 'poll' ? gen.taskId : null
      if (gen.kind === 'poll') {
        await db
          .update(genTasks)
          .set({ taskId: gen.taskId, updatedAt: nowMs() })
          .where(eq(genTasks.id, task.id))
        ctx.log(`shot ${shotId} 已提交第三方（task_id=${gen.taskId}），开始轮询`)
        videoUrl = await pollVideoTask(ctx, task, adapter, request, gen.taskId)
      }
      // 产物形态：poll/url 型 → 远程 URL 下载；base64 型（同步长请求适配器）→ 字节直存
      const source =
        gen.kind === 'base64'
          ? ({ kind: 'base64', data: gen.data, mime: gen.mime } as const)
          : videoUrl
            ? ({ kind: 'url', url: videoUrl } as const)
            : null
      if (!source) throw new Error('第三方返回成功但缺少视频产物（url/base64）')
      const asset = await saveGeneratedMedia({
        projectId: ctx.run.projectId,
        stepId: ctx.step.id,
        taskId: task.id,
        kind: 'video',
        purpose: 'shot_video',
        prompt: task.prompt ?? '',
        params: {
          shotId,
          provider: adapter.provider,
          model: request.model ?? null,
          taskId: thirdPartyTaskId,
          duration: parsed.duration ?? null,
          resolution: parsed.resolution ?? null,
        },
        source,
        duration: parsed.duration ?? undefined,
      })
      await db
        .update(genTasks)
        .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
        .where(eq(genTasks.id, task.id))
      task.status = 'succeeded'
      task.resultAssetId = asset.id
      emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'succeeded' })
      ctx.log(`shot ${shotId} 视频生成完成 → asset#${asset.id}`)
      return null
    } catch (err) {
      const msg = (err as Error).message
      if (attempts >= maxAttempts) {
        await db
          .update(genTasks)
          .set({ status: 'failed', errorMsg: msg, completedAt: nowMs(), updatedAt: nowMs() })
          .where(eq(genTasks.id, task.id))
        emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'failed', error: msg })
        ctx.log(`shot ${shotId} 视频生成失败（已尝试 ${maxAttempts} 次）：${msg}`)
        return { shotId, error: msg }
      }
      ctx.log(`shot ${shotId} 第 ${attempts}/${maxAttempts} 次失败，1.5s 后重试：${msg}`)
      await sleep(1500)
    }
  }
}

/** 轮询第三方任务至完成；run cancelled / 超时 10min / failed → 抛错 */
async function pollVideoTask(
  ctx: StepContext,
  task: GenTask,
  adapter: VideoAdapter,
  request: VideoGenRequest,
  taskId: string,
): Promise<string | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    if (await runCancelled(ctx.run.id)) {
      await db
        .update(genTasks)
        .set({ status: 'cancelled', errorMsg: 'run cancelled', updatedAt: nowMs() })
        .where(eq(genTasks.id, task.id))
      throw new RunCancelledError()
    }
    let res: { status: 'pending' | 'processing' | 'completed' | 'failed'; url?: string; error?: string }
    try {
      res = await adapter.query(taskId, { baseUrl: request.baseUrl, apiKey: request.apiKey })
    } catch (err) {
      // 单次查询网络抖动：记日志继续轮询，累计超时兜底
      ctx.log(`shot 轮询查询异常（继续等待）: ${(err as Error).message}`)
      res = { status: 'processing' }
    }
    if (res.status === 'completed') return res.url ?? null
    if (res.status === 'failed') throw new Error(res.error ?? '第三方任务失败')
    if (Date.now() > deadline) throw new Error(`视频任务轮询超时（>10 分钟，task_id=${taskId}）`)
    await sleep(POLL_INTERVAL_MS)
  }
}

async function runCancelled(runId: number): Promise<boolean> {
  const rows = await db
    .select({ status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1)
  return rows[0]?.status === 'cancelled'
}

/** run.input JSON 快照安全取值（episode 溯源用） */
function safeGet(inputJson: string, key: string): string | number | undefined {
  try {
    const v = (JSON.parse(inputJson) as Record<string, unknown>)[key]
    return typeof v === 'string' || typeof v === 'number' ? v : undefined
  } catch {
    return undefined
  }
}

/** 简易并发池：all 结束后统一返回（任务内部已捕获失败） */
async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      await fn(items[idx]!)
    }
  })
  await Promise.all(workers)
}
