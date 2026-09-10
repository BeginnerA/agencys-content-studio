import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { genTasks, pipelineRuns, type GenTask } from '../../db/schema'
import { buildImageRequest } from '../../adapters/provider'
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

/**
 * ai_image：批量镜头出图（spec §5.3）。
 * 输入 batch.field（默认 shots）→ 分镜 JSON 资产 → 每镜头一条 gen_task；
 * 并发上限 batch.max_concurrent（默认 2），失败按 batch.retry 重试。
 * 幂等：本 step 已 succeeded 的 task 跳过（断点续跑复用成功图）；
 * failed 且 attempts 未超上限的 task 在本步重跑时自动补跑；
 * 未成功任务的 prompt/参数执行时与当前分镜同步（修正分镜后续跑即生效），
 * failed 且有变化的任务归零重排队。
 */
export async function aiImage(ctx: StepContext): Promise<StepResult> {
  const batch = ctx.def.batch ?? { field: 'shots', maxConcurrent: 2, retry: 1 }
  const field = batch.field ?? 'shots'
  const concurrency = Math.max(1, batch.maxConcurrent ?? 2)
  const maxRetry = Math.max(0, batch.retry ?? 1)

  const sbIds = ctx.assetIdsOf(field)
  if (sbIds.length === 0) throw new Error(`inputs.${field} 无分镜资产`)
  const raw = await ctx.readText(sbIds[0]!)
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
  for (const s of shots) {
    if (typeof s?.image_prompt !== 'string' || !s.image_prompt.trim()) {
      throw new Error(`shot ${String(s?.id ?? '?')} 缺 image_prompt`)
    }
  }

  const imgCfg = (ctx.settings.image ?? {}) as Record<string, unknown>
  const provider = typeof imgCfg['provider'] === 'string' ? imgCfg['provider'] : undefined
  const model = typeof imgCfg['model'] === 'string' ? imgCfg['model'] : undefined
  const size = typeof imgCfg['size'] === 'string' ? imgCfg['size'] : '832x1248'
  const refIds = ctx.assetIdsOf('characters')
  if (refIds.length > 0) {
    ctx.log(`角色参考图 ${refIds.length} 张（M1 同步接口仅本地留档，不参与生成）`)
  }
  ctx.log(`批量出图：${shots.length} 镜头 × ${provider ?? '默认供应商'}（并发 ${concurrency}，失败重试 ${maxRetry} 次）`)

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
    const promptText = shot.image_prompt.trim()
    const paramsJson = JSON.stringify({ size, shotId: shot.id, duration: shot.duration ?? null, refAssetIds: refIds })
    const existingTask = taskByShotId.get(shot.id)
    if (!existingTask) {
      const t = nowMs()
      const row = await db
        .insert(genTasks)
        .values({
          projectId: ctx.run.projectId,
          runId: ctx.run.id,
          stepId: ctx.step.id,
          kind: 'image',
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
      // 未成功任务同步最新 prompt/参数（修正分镜或调设置后续跑即生效）；
      // failed 且有变化 → 归零重排队；succeeded 保持产物溯源不动
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
    throw new Error(`出图失败 ${failures.length} 个镜头（可修正后断点续跑/重试任务）：${sample}`)
  }

  // 产物按 shots 顺序聚合
  const assetIds = shots
    .map((s) => taskByShotId.get(s.id)!.resultAssetId)
    .filter((id): id is number => typeof id === 'number')
  if (assetIds.length !== shots.length) {
    throw new Error(`产物与镜头数不符（${assetIds.length}/${shots.length}），请重试`)
  }
  ctx.log(`出图完成：${assetIds.length} 张 → ${assetIds.join(', ')}`)
  return { assetIds }
}

/** 单任务执行：attempts 续增，达上限后不再重试 */
async function runOneTask(
  ctx: StepContext,
  task: GenTask,
  cfg: { provider?: string; model?: string; maxRetry: number },
): Promise<{ shotId: string; error: string } | null> {
  const parsed = JSON.parse(task.params) as { size?: string; shotId?: string }
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
      const { adapter, request } = await buildImageRequest({
        prompt: task.prompt ?? '',
        provider: cfg.provider,
        model: cfg.model,
        size: parsed.size,
      })
      const img = await adapter.generate(request)
      const asset = await saveGeneratedMedia({
        projectId: ctx.run.projectId,
        stepId: ctx.step.id,
        taskId: task.id,
        kind: 'image',
        purpose: 'shot_image',
        prompt: task.prompt ?? '',
        params: { shotId, size: parsed.size, provider: adapter.provider },
        source: img.kind === 'url' ? { kind: 'url', url: img.url } : { kind: 'base64', data: img.data, mime: img.mime },
        width: img.width,
        height: img.height,
      })
      await db
        .update(genTasks)
        .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
        .where(eq(genTasks.id, task.id))
      task.status = 'succeeded'
      task.resultAssetId = asset.id
      emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'succeeded' })
      ctx.log(`shot ${shotId} 出图完成 → asset#${asset.id}`)
      return null
    } catch (err) {
      const msg = (err as Error).message
      if (attempts >= maxAttempts) {
        await db
          .update(genTasks)
          .set({ status: 'failed', errorMsg: msg, completedAt: nowMs(), updatedAt: nowMs() })
          .where(eq(genTasks.id, task.id))
        emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'failed', error: msg })
        ctx.log(`shot ${shotId} 出图失败（已尝试 ${maxAttempts} 次）：${msg}`)
        return { shotId, error: msg }
      }
      ctx.log(`shot ${shotId} 第 ${attempts}/${maxAttempts} 次失败，1.5s 后重试：${msg}`)
      await sleep(1500)
    }
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