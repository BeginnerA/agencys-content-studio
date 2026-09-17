import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import { createLogger } from './logger'
import { WEB_DIST } from './env'
import { apiRoutes } from './routes/api-configs'
import { canvasRoutes } from './routes/canvas'
import { vendorRoutes } from './routes/vendor-credentials'
import { assetsRoutes } from './routes/assets'
import { batchesRoutes } from './routes/batches'
import { charactersRoutes } from './routes/characters'
import { complianceRoutes } from './routes/compliance'
import { composeRoutes } from './routes/compose'
import { creationRoutes } from './routes/creation'
import { exportsRoutes } from './routes/exports'
import { evalRoutes } from './routes/eval'
import { memoriesRoutes } from './routes/memories'
import { novelRoutes } from './routes/novel'
import { projectsRoutes } from './routes/projects'
import { promptsRoutes } from './routes/prompts'
import { publicationsRoutes } from './routes/publications'
import { runsRoutes } from './routes/runs'
import { seriesRoutes } from './routes/series'
import { shotsRoutes } from './routes/shots'
import { statsRoutes } from './routes/stats'
import { stylePresetsRoutes } from './routes/style-presets'
import { systemRoutes } from './routes/system'
import { tasksRoutes } from './routes/tasks'
import { templatesRoutes } from './routes/templates'
import { voiceCloneRoutes } from './routes/voice-clones'
import { schedulesRoutes } from './routes/schedules'
import { searchRoutes } from './routes/search'

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
api.route('/', seriesRoutes)
api.route('/', shotsRoutes)
api.route('/', composeRoutes)
api.route('/', batchesRoutes)
api.route('/', statsRoutes)
api.route('/', stylePresetsRoutes)
api.route('/', exportsRoutes)
api.route('/', publicationsRoutes)
api.route('/', tasksRoutes)
api.route('/', novelRoutes)
api.route('/', voiceCloneRoutes)
api.route('/', schedulesRoutes)
api.route('/', apiRoutes)
api.route('/', vendorRoutes)
api.route('/', canvasRoutes)
api.route('/', creationRoutes)
api.route('/', searchRoutes)
api.route('/', evalRoutes)
api.route('/', complianceRoutes)

app.route('/api/v1', api)

/**
 * [M14] Web 静态托管（桌面端 / 单端口部署）：dist 存在才启用（env 无值 = 现行为零变化）。
 * - 非 /api GET：命中 WEB_DIST 内真实文件 → 按 MIME 返回；否则回退 index.html（SPA 路由）。
 * - 防护：路径安全归一化后必须仍在 WEB_DIST 内；/api/* 未命中保持 JSON 404。
 */
if (existsSync(join(WEB_DIST, 'index.html'))) {
  app.get('*', (c) => {
    const pathname = c.req.path
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return c.json({ error: { code: 'not_found', message: `${pathname} 不存在` } }, 404)
    }
    let decoded = pathname
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      /* 非法编码 → 原样进入安全归一化 */
    }
    const hit = resolveWebFile(WEB_DIST, decoded)
    if (hit) return c.body(readFileSync(hit), 200, { 'Content-Type': mimeOf(hit) })
    return c.html(readFileSync(join(WEB_DIST, 'index.html'), 'utf8'))
  })
}

/** 404 兜底（JSON） */
app.notFound((c) => c.json({ error: { code: 'not_found', message: `${c.req.path} 不存在` } }, 404))

/** 统一错误兜底 */
app.onError((err, c) => {
  log.error('unhandled error', { path: c.req.path, message: (err as Error).message })
  return c.json({ error: { code: 'internal', message: (err as Error).message } }, 500)
})

/** [M14] 静态文件解析：路径安全归一化（剥离 '..' 等段）→ 仅 WEB_DIST 内真实文件命中 */
function resolveWebFile(distDir: string, pathname: string): string | null {
  const rel = pathname
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/')
  if (!rel) return null
  const base = normalize(distDir)
  const file = normalize(join(base, rel))
  if (file !== base && !file.startsWith(base + sep)) return null
  try {
    return statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

/** [M14] 扩展名 → Content-Type（未知 → octet-stream） */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}
function mimeOf(file: string): string {
  return MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}
