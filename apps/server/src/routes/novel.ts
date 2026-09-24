/**
 * 小说改编链路由（spec §3.7）
 * - GET /runs/:id/novel-board —— 聚合读（切分 manifest × 事件状态 × 图谱 × 规划 × 剧本），只读零副作用
 * - POST /projects/:id/novel/append —— 增量章节追加（multipart；幂等去重，不级联重跑）
 */
import { Hono } from 'hono'
import { buildNovelBoard } from '../services/novel-board'
import { appendNovelChapters, NovelAppendError } from '../services/novel-append'
import { HttpError, h, idParam, notFound } from './helpers'

export const novelRoutes = new Hono()

// GET /runs/:id/novel-board —— 小说改编看板聚合读（run 无 text_split 步骤 → found=false；run 不存在 → 404）
novelRoutes.get('/runs/:id/novel-board', h(async (c) => {
  const runId = idParam(c)
  const board = await buildNovelBoard(runId)
  if (!board) return notFound(c, `run ${runId}`)
  return c.json(board)
}))

// POST /projects/:id/novel/append —— 自动连载增量导入（form: run_id + files[]）
novelRoutes.post('/projects/:id/novel/append', h(async (c) => {
  const projectId = idParam(c)
  const form = await c.req.formData().catch(() => { throw new HttpError(400, 'bad_form', '非 multipart/form-data 请求') })
  const runRaw = form.get('run_id')
  const runId = Number(typeof runRaw === 'string' ? runRaw : '')
  if (!Number.isInteger(runId) || runId <= 0) throw new HttpError(400, 'bad_run', 'run_id 必填（整数）')
  const files: Array<{ name: string; data: Uint8Array }> = []
  for (const file of form.getAll('files')) {
    if (typeof file === 'string') continue
    const buf = new Uint8Array(await file.arrayBuffer())
    if (buf.byteLength === 0) continue
    files.push({ name: file.name || `append-${Date.now()}`, data: buf })
  }
  if (files.length === 0) throw new HttpError(400, 'no_files', '未收到新文件')
  try {
    const result = await appendNovelChapters(projectId, runId, files)
    return c.json(result, 201)
  } catch (err) {
    if (err instanceof NovelAppendError) {
      throw new HttpError(err.code === 'not_found' ? 404 : 400, err.code, err.message)
    }
    throw err
  }
}))
