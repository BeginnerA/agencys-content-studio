import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { projects } from '../db/schema'
import {
  createSeries,
  deleteEpisode,
  deleteSeries,
  findSeriesOfProject,
  latestRunStatus,
  listEpisodes,
  toEpisodeView,
  toSeriesView,
  updateEpisode,
  updateSeriesEpisodes,
} from '../services/series'
import { HttpError, h, idParam, notFound, wb } from './helpers'

/**
 * [M14] 剧集实体路由（平台级通用：剧 → 集两级，一项目一剧）。
 * - 写操作统一 wb() 包装：WorkbenchError 状态码透传（404 / 409 / 400）。
 * - status 派生：列表与单集出参以「最新 run 状态」优先（listEpisodes 单查询 join）。
 */
export const seriesRoutes = new Hono()

// GET /projects/:id/series —— 剧 + 集列表（项目无剧 → { series: null, episodes: [] }）
seriesRoutes.get(
  '/projects/:id/series',
  h(async (c) => {
    const projectId = idParam(c)
    if (!(await findLiveProject(projectId))) return notFound(c, `项目 ${projectId}`)
    const s = await findSeriesOfProject(projectId)
    if (!s) return c.json({ series: null, episodes: [] })
    return c.json({ series: toSeriesView(s), episodes: await listEpisodes(s.id) })
  }),
)

// POST /projects/:id/series —— 建剧（name / total_episodes 1..999 / content_asset_id?），生成 1..N 集行
seriesRoutes.post(
  '/projects/:id/series',
  h(async (c) => {
    const projectId = idParam(c)
    if (!(await findLiveProject(projectId))) return notFound(c, `项目 ${projectId}`)
    const body = await c.req.json().catch(() => {
      throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
    })
    const name = body['name']
    if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'bad_name', 'name 必填（非空字符串）')
    const total = body['total_episodes']
    if (!Number.isInteger(total)) throw new HttpError(400, 'bad_total', 'total_episodes 需为 1..999 的整数')
    const r = await wb(() =>
      createSeries({ projectId, name, totalEpisodes: total as number, contentAssetId: normAssetId(body['content_asset_id']) }),
    )
    return c.json({ series: toSeriesView(r.series), episodes: r.episodes.map((e) => toEpisodeView(e)) }, 201)
  }),
)

// PATCH /series/:id —— 集数调整（扩容追集 / 缩容仅删尾部空集，占用 → 409）
seriesRoutes.patch(
  '/series/:id',
  h(async (c) => {
    const seriesId = idParam(c)
    const body = await c.req.json().catch(() => {
      throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
    })
    const total = body['total_episodes']
    if (!Number.isInteger(total)) throw new HttpError(400, 'bad_total', 'total_episodes 需为 1..999 的整数（本端点仅支持集数调整）')
    const r = await wb(() => updateSeriesEpisodes(seriesId, total as number))
    return c.json({ series: toSeriesView(r.series), episodes: r.episodes })
  }),
)

// DELETE /series/:id —— 删剧（任集关联 run / 内容资产 → 409）
seriesRoutes.delete(
  '/series/:id',
  h(async (c) => {
    const seriesId = idParam(c)
    await wb(() => deleteSeries(seriesId))
    return c.json({ ok: true })
  }),
)

// PATCH /episodes/:id —— 单集更新（title / status(locked|planning|done) / content_asset_id）
seriesRoutes.patch(
  '/episodes/:id',
  h(async (c) => {
    const episodeId = idParam(c)
    const body = await c.req.json().catch(() => {
      throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
    })
    const patch: { title?: string | null; status?: string; contentAssetId?: number | null } = {}
    if (body['title'] !== undefined) {
      if (body['title'] !== null && typeof body['title'] !== 'string') throw new HttpError(400, 'bad_title', 'title 需为字符串或 null')
      patch.title = body['title'] === null ? null : (body['title'] as string).trim() || null
    }
    if (body['status'] !== undefined) {
      if (typeof body['status'] !== 'string') throw new HttpError(400, 'bad_status', 'status 需为字符串')
      patch.status = body['status']
    }
    if (body['content_asset_id'] !== undefined) {
      patch.contentAssetId = body['content_asset_id'] === null ? null : normAssetId(body['content_asset_id']) ?? null
    }
    if (Object.keys(patch).length === 0) {
      throw new HttpError(400, 'bad_patch', 'patch 至少包含 title / status / content_asset_id 之一')
    }
    const row = await wb(() => updateEpisode(episodeId, patch))
    return c.json({ episode: toEpisodeView(row, await latestRunStatus(row.latestRunId)) })
  }),
)

// DELETE /episodes/:id —— 删集（保留 run 与资产，仅删集行）
seriesRoutes.delete(
  '/episodes/:id',
  h(async (c) => {
    await wb(() => deleteEpisode(idParam(c)))
    return c.json({ ok: true })
  }),
)

/** 项目存在性（未删）校验 */
async function findLiveProject(projectId: number) {
  const rows = await db.select().from(projects).where(and(eq(projects.id, projectId), isNull(projects.deletedAt))).limit(1)
  return rows[0] ?? null
}

/** content_asset_id 归一化：undefined/null → undefined（不校验）；正整数 → number；其余 400 */
function normAssetId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'bad_asset', 'content_asset_id 非法')
  return n
}
