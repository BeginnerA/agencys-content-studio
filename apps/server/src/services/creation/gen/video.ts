import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { genTasks } from '../../../db/schema'
import type { Canvas, GenTask } from '../../../db/schema'
import type { VideoAdapter, VideoGenRequest } from '../../../adapters/types'
import { emitStudioEvent } from '../../events'
import { createLogger } from '../../../logger'

const log = createLogger('creation-gen')

const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 10 * 60 * 1000

export const nowMs = (): number => Date.now()
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 视频轮询中检测到取消：任务行已置 cancelled（取消端点写入），执行器直接退出 */
export class CanvasTaskCancelled extends Error {}

export function emitCanvasChanged(canvas: Canvas, nodeId?: number): void {
  emitStudioEvent({ type: 'canvas.changed', canvasId: canvas.id, projectId: canvas.projectId, nodeId })
}

/** 视频轮询：每轮检查取消；超时 10min / failed → 抛错 */
export async function pollCanvasVideoTask(
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

export async function reloadTask(taskId: number): Promise<GenTask | null> {
  const rows = await db.select().from(genTasks).where(eq(genTasks.id, taskId)).limit(1)
  return rows[0] ?? null
}

export async function taskCancelled(taskId: number): Promise<boolean> {
  const rows = await db.select({ status: genTasks.status }).from(genTasks).where(eq(genTasks.id, taskId)).limit(1)
  return rows[0]?.status === 'cancelled'
}
