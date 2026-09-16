/**
 * [M4] 统计 REST（E4）：/stats/usage 用量聚合 + /stats/overview 看板概览
 * [M20] 增强：/stats/cost-breakdown 跨项目成本分解
 * [M20] B7：CSV 导出（runs/publications/usage）+ 趋势对比基线
 * - 薄壳：查询参数解析 → services 直通（探针可直接断言服务层）
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import { pipelineRuns, projects, publications, usageRecords } from '../db/schema'
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

// [M20] GET /stats/cost-breakdown?from=&to= —— 跨项目成本分解（provider_model × project 双维度）
statsRoutes.get('/stats/cost-breakdown', h(async (c) => {
  const num = (k: string): number | undefined => {
    const v = c.req.query(k)
    return v === undefined || v === '' ? undefined : Number(v)
  }
  const from = num('from')
  const to = num('to')
  // 并行查三个维度：全局按 provider_model、全局按 project、全局按 kind
  const [byPm, byProj, byKind] = await Promise.all([
    usageSummary({ from, to, groupBy: 'provider_model' }),
    usageSummary({ from, to, groupBy: 'project' }),
    usageSummary({ from, to, groupBy: 'kind' }),
  ])
  return c.json({ byProviderModel: byPm, byProject: byProj, byKind, totals: byPm.totals })
}))

// ---------- [M20] B7 CSV 导出 ----------

/** CSV 转义（字段含逗号/引号/换行 → 双引号包裹） */
function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** GET /stats/csv/runs?project_id=&from=&to= —— 运行复盘 CSV */
statsRoutes.get('/stats/csv/runs', h(async (c) => {
  const num = (k: string): number | undefined => {
    const v = c.req.query(k)
    return v === undefined || v === '' ? undefined : Number(v)
  }
  const conds: ReturnType<typeof eq>[] = []
  const pid = num('project_id')
  if (pid) conds.push(eq(pipelineRuns.projectId, pid))
  const from = num('from')
  if (from) conds.push(gte(pipelineRuns.createdAt, from))
  const to = num('to')
  if (to) conds.push(lte(pipelineRuns.createdAt, to))
  const rows = await db
    .select({
      id: pipelineRuns.id, projectId: pipelineRuns.projectId, templateKey: pipelineRuns.templateKey,
      status: pipelineRuns.status, batchId: pipelineRuns.batchId, batchSeq: pipelineRuns.batchSeq,
      error: pipelineRuns.error, createdAt: pipelineRuns.createdAt,
      completedAt: pipelineRuns.completedAt,
    })
    .from(pipelineRuns)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(pipelineRuns.createdAt))
    .limit(5000)
  const header = 'id,project_id,template_key,status,batch_id,batch_seq,error,created_at,completed_at'
  const lines = rows.map((r) => [
    r.id, r.projectId, csvEscape(r.templateKey), r.status,
    r.batchId ?? '', r.batchSeq ?? '', csvEscape(r.error),
    r.createdAt, r.completedAt ?? '',
  ].join(','))
  const csv = [header, ...lines].join('\n')
  return c.body(csv, 200 as never, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="runs.csv"' } as never)
}))

/** GET /stats/csv/publications?project_id= —— 发布复盘 CSV */
statsRoutes.get('/stats/csv/publications', h(async (c) => {
  const pid = c.req.query('project_id')
  const conds = []
  if (pid) conds.push(eq(publications.projectId, Number(pid)))
  const rows = await db.select().from(publications)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(publications.createdAt))
    .limit(5000)
  const header = 'id,project_id,platform,title,ab_group,url,published_at,views,likes,comments,favorites,shares,note'
  const lines = rows.map((r) => {
    let m: Record<string, unknown> = {}
    try { m = JSON.parse(r.metrics) } catch { /* skip */ }
    const n = (k: string) => typeof m[k] === 'number' ? m[k] : 0
    return [
      r.id, r.projectId, r.platform, csvEscape(r.title), csvEscape(r.abGroup),
      csvEscape(r.url), r.publishedAt ?? '', n('views'), n('likes'), n('comments'),
      n('favorites'), n('shares'), csvEscape(r.note),
    ].join(',')
  })
  const csv = [header, ...lines].join('\n')
  return c.body(csv, 200 as never, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="publications.csv"' } as never)
}))

/** GET /stats/csv/usage?project_id=&from=&to=&group_by= —— 用量 CSV */
statsRoutes.get('/stats/csv/usage', h(async (c) => {
  const raw = c.req.query('group_by') ?? 'provider_model'
  if (!(GROUPS as readonly string[]).includes(raw)) throw new HttpError(400, 'bad_group_by', `group_by 需为 ${GROUPS.join('|')}`)
  const num = (k: string): number | undefined => {
    const v = c.req.query(k)
    return v === undefined || v === '' ? undefined : Number(v)
  }
  const result = await usageSummary({
    projectId: num('project_id'), from: num('from'), to: num('to'),
    groupBy: raw as UsageGroupBy,
  })
  const header = 'key,count,quantity,cost,unpriced'
  const lines = result.items.map((it) => [csvEscape(it.key), it.count, it.quantity, it.cost, it.unpriced].join(','))
  lines.push(['TOTAL', result.totals.quantity, result.totals.cost, result.totals.unpriced].join(','))
  const csv = [header, ...lines].join('\n')
  return c.body(csv, 200 as never, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="usage.csv"' } as never)
}))

// ---------- [M20] B7 趋势对比基线 ----------

/** GET /stats/compare?days=&project_id= —— 当前周期 vs 上一周期对比 */
statsRoutes.get('/stats/compare', h(async (c) => {
  const days = Math.min(365, Math.max(7, Number(c.req.query('days') ?? '30')))
  const pid = c.req.query('project_id') ? Number(c.req.query('project_id')) : undefined
  const now = Date.now()
  const currentFrom = now - days * 86_400_000
  const prevFrom = now - 2 * days * 86_400_000
  const prevTo = currentFrom
  const [current, prev] = await Promise.all([
    buildOverview({ projectId: pid, days }),
    buildOverview({ projectId: pid, days }),
  ])
  // prev 用精确时间窗口重算（buildOverview 内部用 days 推算 from，此处用 usageSummary 精确）
  const [prevUsage, currUsage] = await Promise.all([
    usageSummary({ projectId: pid, from: prevFrom, to: prevTo, groupBy: 'kind' }),
    usageSummary({ projectId: pid, from: currentFrom, groupBy: 'kind' }),
  ])
  return c.json({
    days,
    current: { runs: current.runs, cost: current.cost, publications: current.publications },
    previous: { runs: prev.runs, cost: { total: prevUsage.totals.cost, last30d: prevUsage.totals.cost }, publications: prev.publications },
    delta: {
      runsTotal: current.runs.total - prev.runs.total,
      costTotal: current.cost.total - prevUsage.totals.cost,
      successRate: current.runs.successRate - prev.runs.successRate,
    },
  })
}))
