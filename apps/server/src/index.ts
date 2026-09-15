import { serve } from '@hono/node-server'
import type { Server as HttpServer } from 'node:http'
import { eq } from 'drizzle-orm'
import { Server } from 'socket.io'
import { app } from './app'
import { db, initDb } from './db'
import { pipelineRuns } from './db/schema'
import { env } from './env'
import { createLogger } from './logger'
import { engine, onRunSettled, recoverInterruptedState } from './pipeline/engine'
import { notifyRunSettled, reconcileBatches } from './services/batch'
import { recoverCanvasTasks } from './services/creation/gen'
import { recoverEntityRefTasks } from './services/entity-refgen'
import { onStudioEvent } from './services/events'

const log = createLogger('main')

/** runId → projectId 缓存：多数事件不带 projectId，投递 project room 前补查一次 */
const projectIdCache = new Map<number, number>()
async function projectIdOf(runId: number): Promise<number> {
  const hit = projectIdCache.get(runId)
  if (hit) return hit
  const rows = await db
    .select({ projectId: pipelineRuns.projectId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1)
  const pid = rows[0]?.projectId ?? 0
  if (pid) projectIdCache.set(runId, pid)
  return pid
}

async function main(): Promise<void> {
  await initDb()

  const httpServer = serve(
    { fetch: app.fetch, port: env.port },
    (info) => log.info(`server listening on http://127.0.0.1:${info.port}`),
  )

  const io = new Server(httpServer as HttpServer, { cors: { origin: true } })
  const studio = io.of('/studio')
  studio.on('connection', (socket) => {
    socket.on('join', (room: string) => {
      if (typeof room === 'string' && /^(run|project|canvas):\d+$/.test(room)) socket.join(room)
    })
    socket.on('leave', (room: string) => {
      if (typeof room === 'string' && /^(run|project|canvas):\d+$/.test(room)) socket.leave(room)
    })
    socket.on('disconnect', () => log.debug('socket disconnected', { id: socket.id }))
  })

  // 进程内事件 → /studio：投递 run:{id}（如有）+ canvas:{id}（[M16]）+ project:{id} room
  // （batch.updated / canvas.changed 等无 runId 事件经 projectId 投递；两者俱无 → 丢弃）
  onStudioEvent((e) => {
    const runId = 'runId' in e ? e.runId : null
    const rooms: string[] = []
    if (runId !== null && runId !== undefined) rooms.push(`run:${runId}`)
    if (e.type === 'canvas.changed') rooms.push(`canvas:${e.canvasId}`)
    const pid = 'projectId' in e && e.projectId ? e.projectId : 0
    if (!rooms.length && !pid) return
    void (async () => {
      const projectId = pid || (runId !== null && runId !== undefined ? await projectIdOf(runId) : 0)
      if (projectId) rooms.push(`project:${projectId}`)
      if (rooms.length) studio.to(rooms).emit('studio.event', e)
    })().catch((err) => log.error(`studio event bridge failed (${e.type})`, err))
  })

  // [M4] 先注册终态监听（批 pump 钩子），再 recover——避免恢复期通知落空
  onRunSettled((runId) => {
    void notifyRunSettled(runId).catch((err) => log.error(`settle→pump run ${runId} 失败`, err))
  })

  // 崩溃恢复：running → failed(interrupted)；queued 重新入队执行
  const { requeued } = await recoverInterruptedState()
  for (const runId of requeued) {
    log.info(`recover: requeue run ${runId}`)
    try { await engine.startRun(runId) } catch (err) { log.error(`recover: run ${runId} startRun failed`, err) }
  }
  // [M4] 批内 queued run 统一经批调度（recover 已过滤 batchId；此处按槽位约束推进）
  await reconcileBatches()

  // [M16] 画布任务崩溃恢复：pending/processing 的 canvas 任务 → failed('服务重启中断')
  await recoverCanvasTasks()

  // [M19 P6] 素材批量生成任务崩溃恢复：本域 pending/processing → failed（不自动重排队，用户可在素材页重新发起）
  await recoverEntityRefTasks()

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`received ${signal}, shutting down`)
    await new Promise((resolve) => io.close(() => resolve(null)))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  log.error('fatal startup error', err)
  process.exit(1)
})