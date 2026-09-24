import { serve } from '@hono/node-server'
import type { Server as HttpServer } from 'node:http'
import { eq } from 'drizzle-orm'
import { Server } from 'socket.io'
import { app } from './app'
import { db, initDb } from './db'
import { pipelineRuns } from './db/schema'
import { env } from './env'
import { createLogger } from './logger'
import { engine, onRunSettled, recoverInterruptedState, refreshGlobalConcurrency } from './pipeline/engine'
import { notifyRunSettled, reconcileBatches, pumpStalledBatches } from './services/batch'
import { advanceWorkflow } from './services/workflow'
import { registerAutoSummaryHook } from './services/memory-autosummary'
import { startScheduler, stopScheduler } from './services/schedule'
import { purgeExpiredCanvases } from './services/trash-sweep'
import { recoverCanvasTasks } from './services/creation/gen'
import { recoverEntityRefTasks } from './services/entity-refgen'
import { onStudioEvent } from './services/events'
import { notifyCreationSettled, reconcileCreationSessions } from './services/creation-chat/store'
import { refreshTemplateVectors } from './services/template-recommend'

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
  await reconcileCreationSessions()
  onRunSettled((runId) => { void notifyCreationSettled(runId).catch(() => log.warn('创作会话时间更新失败，可通过 HTTP 重拉状态')) })

  const httpServer = serve(
    { fetch: app.fetch, port: env.port, hostname: env.host },
    (info) => log.info(`server listening on http://${env.host}:${info.port}`),
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

  // 进程内事件 → /studio：投递 run:{id}（如有）+ canvas:{id}（ ）+ project:{id} room
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

  // 先注册终态监听（批 pump 钩子），再 recover——避免恢复期通知落空
  onRunSettled((runId) => {
    void notifyRunSettled(runId).catch((err) => log.error(`settle→pump run ${runId} 失败`, err))
  })

  // 编排链推进钩子（与批 pump 并列、互不影响；settle 异常隔离，不波及引擎主流程）
  onRunSettled((runId) => {
    void advanceWorkflow(runId).catch((err) => log.error(`settle→advance run ${runId} 失败`, err))
  })

  // 自动摘要钩子（settings memory.auto_summary 缺省关；内部门控，fire-and-forget 隔离）
  registerAutoSummaryHook()

  // 全局并发上限载入（startRun 同步闸门读缓存；先于恢复启动）
  await refreshGlobalConcurrency()

  // 崩溃恢复：running → failed(interrupted)；queued 重新入队执行
  const { requeued } = await recoverInterruptedState()
  for (const runId of requeued) {
    log.info(`recover: requeue run ${runId}`)
    try { engine.startRun(runId) } catch (err) { log.error(`recover: run ${runId} startRun failed`, err) }
  }
  // 恢复后全局补位：首波被 defer（闸门满）的 run 交给泵拉起
  await engine.pumpGlobal()
  // 批内 queued run 统一经批调度（recover 已过滤 batchId；此处按槽位约束推进）
  await reconcileBatches()

  // 画布任务崩溃恢复：pending/processing 的 canvas 任务 → failed('服务重启中断')
  await recoverCanvasTasks()

  // 素材批量生成任务崩溃恢复：本域 pending/processing → failed（不自动重排队，用户可在素材页重新发起）
  await recoverEntityRefTasks()

  // 启动排产调度器（60s 轮询 + 幂等触发）
  startScheduler()

  // 自然语言→模板推荐 embedding 预计算（首次加载 2–3 秒，fire-and-forget；失败已内部兑底为关键词回落）
  void refreshTemplateVectors().catch((err) => log.warn('template recommend embedding 预计算失败（回落 keyword）', err))

  // 回收站保留期自动清理：启动执行一次 + 6h 周期（unref 防挂起；autoPurge=false 由服务内跳过）
  void purgeExpiredCanvases().catch((err) => log.error('trash sweep failed', err))
  const trashSweepTimer = setInterval(
    () => void purgeExpiredCanvases().catch((err) => log.error('trash sweep failed', err)),
    6 * 60 * 60 * 1000,
  )
  trashSweepTimer.unref()

  // 全局并发 pump 定时兜底（30s）：异常态自愈（settle 丢失等）；
  // 批停滞扫描同样兜底（可救起「settle 链路未覆盖」等极端残留的 queued 批 run）
  const globalPumpTimer = setInterval(() => {
    void engine.pumpGlobal()
    void pumpStalledBatches().catch((err) => log.error('stalled batch scan failed', err))
  }, 30_000)

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`received ${signal}, shutting down`)
    stopScheduler()
    clearInterval(globalPumpTimer)
    clearInterval(trashSweepTimer)
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