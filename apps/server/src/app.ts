import { Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import { createLogger } from './logger'
import { apiRoutes } from './routes/api-configs'
import { assetsRoutes } from './routes/assets'
import { batchesRoutes } from './routes/batches'
import { charactersRoutes } from './routes/characters'
import { exportsRoutes } from './routes/exports'
import { memoriesRoutes } from './routes/memories'
import { projectsRoutes } from './routes/projects'
import { promptsRoutes } from './routes/prompts'
import { publicationsRoutes } from './routes/publications'
import { runsRoutes } from './routes/runs'
import { statsRoutes } from './routes/stats'
import { systemRoutes } from './routes/system'
import { tasksRoutes } from './routes/tasks'
import { templatesRoutes } from './routes/templates'

const log = createLogger('app')

export const app = new Hono()

app.use('*', honoLogger((msg, ...rest) => log.info(msg.replace(/\n$/, ''), rest)))

const api = new Hono()
api.route('/', systemRoutes)
api.route('/', templatesRoutes)
api.route('/', promptsRoutes)
api.route('/', projectsRoutes)
api.route('/', assetsRoutes)
api.route('/', memoriesRoutes)
api.route('/', charactersRoutes)
api.route('/', runsRoutes)
api.route('/', batchesRoutes)
api.route('/', statsRoutes)
api.route('/', exportsRoutes)
api.route('/', publicationsRoutes)
api.route('/', tasksRoutes)
api.route('/', apiRoutes)

app.route('/api/v1', api)

/** 404 兜底（JSON） */
app.notFound((c) => c.json({ error: { code: 'not_found', message: `${c.req.path} 不存在` } }, 404))

/** 统一错误兜底 */
app.onError((err, c) => {
  log.error('unhandled error', { path: c.req.path, message: (err as Error).message })
  return c.json({ error: { code: 'internal', message: (err as Error).message } }, 500)
})
