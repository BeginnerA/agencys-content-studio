import { Hono } from 'hono'
import { count } from 'drizzle-orm'
import { db } from '../db'
import { genTasks } from '../db/schema'
import { WORKSPACE_DIR } from '../env'
import { resolveFfmpeg } from '../services/ffmpeg'
import { createLogger } from '../logger'

const log = createLogger('route:system')

export const systemRoutes = new Hono()

/** GET /api/v1/health —— 进程存活 + 依赖探测 */
systemRoutes.get('/health', async (c) => {
  const ffmpeg = resolveFfmpeg()
  const ffmpegState = ffmpeg ? 'ok' : 'missing'
  return c.json({
    ok: true,
    db: 'ok',
    ffmpeg: ffmpegState,
    ffmpegPath: ffmpeg,
    workspace: WORKSPACE_DIR,
    ts: Date.now(),
  })
})

/** GET /api/v1/system/status —— 运行态（任务统计/队列深度） */
systemRoutes.get('/system/status', async (c) => {
  try {
    const byStatus = await db
      .select({ status: genTasks.status, n: count() })
      .from(genTasks)
      .groupBy(genTasks.status)
    const tasks = Object.fromEntries(byStatus.map((r) => [r.status, r.n]))
    return c.json({ ok: true, tasks, ts: Date.now() })
  } catch (err) {
    log.error('status query failed', err)
    return c.json({ ok: false, tasks: {}, error: (err as Error).message }, 500)
  }
})
