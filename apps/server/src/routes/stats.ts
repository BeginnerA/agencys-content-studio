/**
 * [M4] 统计 REST（E4）：/stats/usage 用量聚合 + /stats/overview 看板概览
 * - 薄壳：查询参数解析 → services 直通（探针可直接断言服务层）
 */
import { Hono } from 'hono'
import { usageSummary, type UsageGroupBy } from '../services/usage'
import { buildOverview } from '../services/stats'
import { HttpError, h } from './helpers'

export const statsRoutes = new Hono()

const GROUPS = ['kind', 'provider', 'model', 'provider_model', 'unit', 'day', 'project', 'run'] as const

// GET /stats/usage?project_id=&run_id=&batch_id=&from=&to=&group_by=
statsRoutes.get('/stats/usage', h(async (c) => {
  const raw = c.req.query('group_by') ?? 'kind'
  if (!(GROUPS as readonly string[]).includes(raw)) {
    throw new HttpError(400, 'bad_group_by', `group_by 需为 ${GROUPS.join('|')}`)
  }
  const num = (k: string): number | undefined => {
    const v = c.req.query(k)
    return v === undefined || v === '' ? undefined : Number(v)
  }
  return c.json(
    await usageSummary({
      projectId: num('project_id'),
      runId: num('run_id'),
      batchId: num('batch_id'),
      from: num('from'),
      to: num('to'),
      groupBy: raw as UsageGroupBy,
    }),
  )
}))

// GET /stats/overview?project_id=&days=
statsRoutes.get('/stats/overview', h(async (c) => {
  const projectId = c.req.query('project_id')
  const days = c.req.query('days')
  return c.json(
    await buildOverview({
      projectId: projectId ? Number(projectId) : undefined,
      days: days ? Number(days) : undefined,
    }),
  )
}))
