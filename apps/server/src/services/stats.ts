/**
 * [M4] 统计概览服务（E4 数据面；spec §4.4 形状）
 * - 路由薄壳：views/interactions 求和口径与 publications 路由共用（publicationTotals）
 */
import { and, count, eq, gte, isNull, sum, type SQL } from 'drizzle-orm'
import { db } from '../db'
import { assets, pipelineRuns, projects, publications, usageRecords } from '../db/schema'

const DAY = 86_400_000

/** 本地日 key（yyyy-mm-dd；与 usage.ts 的 strftime localtime 口径一致） */
function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}

/** 近 N 天窗口起点（本地日零点，含今日） */
function windowStart(days: number): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime() - (days - 1) * DAY
}

/** publications.metrics 求和口径（publications 路由共用）：views；interactions=likes+comments+favorites+shares */
export function publicationTotals(list: Array<{ metrics: string }>): { views: number; interactions: number } {
  let views = 0
  let interactions = 0
  for (const p of list) {
    let m: Record<string, unknown> = {}
    try {
      m = JSON.parse(p.metrics) as Record<string, unknown>
    } catch {
      m = {}
    }
    const n = (k: string): number =>
      typeof m[k] === 'number' && Number.isFinite(m[k]) ? (m[k] as number) : 0
    views += n('views')
    interactions += n('likes') + n('comments') + n('favorites') + n('shares')
  }
  return { views, interactions }
}

export async function buildOverview(q: { projectId?: number; days?: number }): Promise<{
  projects: number
  runs: { total: number; byStatus: Record<string, number>; successRate: number }
  cost: { total: number; last30d: number }
  assets: { total: number; byKind: Record<string, number> }
  activity: Array<{ day: string; runs: number; cost: number }>
  activeDays: number
  publications: { total: number; views: number; interactions: number }
}> {
  const days = typeof q.days === 'number' && q.days > 0 ? Math.min(q.days, 365) : 30
  const from = windowStart(days)
  const pid = q.projectId

  // ① 项目数（未删除；带 project 过滤时即 0/1）
  const projConds = [isNull(projects.deletedAt)]
  if (pid) projConds.push(eq(projects.id, pid))
  const projectCount = (await db.select({ n: count() }).from(projects).where(and(...projConds)))[0]?.n ?? 0

  // ② 运行（byStatus + 完成率：completed / 终态数）
  const runRows = await db
    .select({ status: pipelineRuns.status, createdAt: pipelineRuns.createdAt })
    .from(pipelineRuns)
    .where(pid ? eq(pipelineRuns.projectId, pid) : undefined)
  const byStatus: Record<string, number> = {}
  for (const r of runRows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  const term = (byStatus['completed'] ?? 0) + (byStatus['failed'] ?? 0) + (byStatus['cancelled'] ?? 0)
  const successRate = term > 0 ? Math.round(((byStatus['completed'] ?? 0) / term) * 1e4) / 1e4 : 0

  // ③ 成本（usage_records 合计；total=全时间，last30d=近 30 天固定窗口）
  const pidConds = pid ? [eq(usageRecords.projectId, pid)] : []
  const sumCost = async (conds: SQL | undefined): Promise<number> => {
    const rows = await db.select({ v: sum(usageRecords.cost) }).from(usageRecords).where(conds)
    return Number(rows[0]?.v ?? 0)
  }
  const cost = {
    total: await sumCost(and(...pidConds)),
    last30d: await sumCost(and(...pidConds, gte(usageRecords.createdAt, Date.now() - 30 * DAY))),
  }

  // ④ 资产（未删除）
  const assetConds = [isNull(assets.deletedAt)]
  if (pid) assetConds.push(eq(assets.projectId, pid))
  const assetRows = await db.select({ kind: assets.kind }).from(assets).where(and(...assetConds))
  const byKind: Record<string, number> = {}
  for (const a of assetRows) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1

  // ⑤ 活跃度：近 days 天逐日 run 数 + 成本（含空日补零，供柱状图直接渲染）
  const activityMap = new Map<string, { runs: number; cost: number }>()
  for (let i = 0; i < days; i++) activityMap.set(dayKey(new Date(from + i * DAY)), { runs: 0, cost: 0 })
  for (const r of runRows) {
    if (r.createdAt < from) continue
    const hit = activityMap.get(dayKey(new Date(r.createdAt)))
    if (hit) hit.runs += 1
  }
  const usageRows = await db
    .select({ createdAt: usageRecords.createdAt, cost: usageRecords.cost })
    .from(usageRecords)
    .where(and(...pidConds, gte(usageRecords.createdAt, from)))
  for (const u of usageRows) {
    const hit = activityMap.get(dayKey(new Date(u.createdAt)))
    if (hit) hit.cost += u.cost ?? 0
  }
  const activity = [...activityMap.entries()].map(([day, v]) => ({
    day,
    runs: v.runs,
    cost: Math.round(v.cost * 1e6) / 1e6,
  }))

  // ⑥ 发布登记（views/interactions 汇总）
  const pubRows = await db
    .select({ metrics: publications.metrics })
    .from(publications)
    .where(pid ? eq(publications.projectId, pid) : undefined)

  return {
    projects: projectCount,
    runs: { total: runRows.length, byStatus, successRate },
    cost,
    assets: { total: assetRows.length, byKind },
    activity,
    activeDays: activity.filter((a) => a.runs > 0).length,
    publications: { total: pubRows.length, ...publicationTotals(pubRows) },
  }
}
