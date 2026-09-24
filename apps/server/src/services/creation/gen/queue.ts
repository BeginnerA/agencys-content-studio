import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../../../db'
import { canvasNodes, genTasks } from '../../../db/schema'
import type { Canvas } from '../../../db/schema'
import { createLogger } from '../../../logger'
import { resolveProjectStyleSnippets } from '../../style-preset'
import { canvasOfNode, findNode } from '../nodes'
import { safeParseSpec } from '../spec'
import { executeOnce } from './execute'
import { buildNodeTaskParams, extendTaskParams } from './params'
import { preflightNode } from './preflight'
import { CanvasTaskCancelled, emitCanvasChanged, nowMs, reloadTask, sleep, taskCancelled } from './video'

const log = createLogger('creation-gen')

export const CANVAS_MAX_CONCURRENCY = 2

const MAX_ATTEMPTS = 2 // 自动重试 1 次（镜像 ai_image maxRetry=1）

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
 * 一键停止全部：该画布全部 pending/processing 任务 → cancelled
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
