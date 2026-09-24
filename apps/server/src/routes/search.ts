import { Hono } from 'hono'
import { ensureEmbedder } from '../services/embedding'
import { reindexAssetTexts, searchAll } from '../services/search'
import { HttpError, h } from './helpers'

export const searchRoutes = new Hono()

// GET /search?q=&limit= —— 跨域关键词 + 语义混合搜索（q 必填 ≤100 字符；每组默认 5 条、上限 20）
searchRoutes.get('/search', h(async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (!q) throw new HttpError(400, 'bad_query', 'q 必填（非空关键词）')
  if (q.length > 100) throw new HttpError(400, 'bad_query', `q 过长（≤100 字符，实际 ${q.length}）`)
  const limitRaw = Number(c.req.query('limit'))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 20) : 5
  return c.json(await searchAll(q, limit))
}))

// POST /search/reindex —— 文本资产语义索引全量重建（已有最新模型的行跳过 = 幂等；模型不可用 → 503 指引 model:prepare）
searchRoutes.post('/search/reindex', h(async (c) => {
  try {
    await ensureEmbedder()
  } catch (err) {
    throw new HttpError(503, 'model_unavailable', (err as Error).message)
  }
  return c.json(await reindexAssetTexts())
}))
