import { Hono } from 'hono'
import { count, eq } from 'drizzle-orm'
import { db } from '../db'
import { genTasks, settings } from '../db/schema'
import { WORKSPACE_DIR } from '../env'
import { resolveFfmpeg } from '../services/ffmpeg'
import { createLogger } from '../logger'
import { HttpError, h } from './helpers'

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

// GET /settings —— 全部 KV（value 为解析后的 JSON）
systemRoutes.get('/settings', h(async (c) => {
  const rows = await db.select().from(settings)
  return c.json({
    items: rows.map((r) => ({ key: r.key, value: safeParseJson(r.value), updatedAt: r.updatedAt })),
  })
}))

// PUT /settings/:key —— upsert（body 即 value JSON；64KB 字节上限）
systemRoutes.put('/settings/:key', h(async (c) => {
  const key = c.req.param('key') ?? ''
  if (!/^[\w.-]+$/.test(key)) {
    throw new HttpError(400, 'bad_key', 'key 仅允许字母/数字/下划线/点/中划线')
  }
  const text = await c.req.text()
  if (Buffer.byteLength(text, 'utf8') > 65536) throw new HttpError(400, 'too_large', 'value 超 64KB 上限')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'bad_json', 'value 需为合法 JSON')
  }
  const t = Date.now()
  const existing = await db.select({ id: settings.id }).from(settings).where(eq(settings.key, key)).limit(1)
  if (existing[0]) {
    await db.update(settings).set({ value: JSON.stringify(value), updatedAt: t }).where(eq(settings.key, key))
  } else {
    await db.insert(settings).values({ key, value: JSON.stringify(value), updatedAt: t })
  }
  return c.json({ ok: true, key, updatedAt: t })
}))

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
