/**
 * [M23] 全景聚合读模型（E1/E2，spec §2.4）：项目内全部 run 的跨批次/跨模板聚合
 * - batches：批次头（toBatchView 同构）+ 组内 runs（batchSeq 升序；含 cost/快照版本）
 * - standaloneRuns：无批次归属 runs（createdAt 降序）
 * - stats：项目级 run 计数（按状态）+ 总成本（成本口径对齐 summarizeBatch：usage 按 run 聚合）
 * - [M27] workflows：编排链概览（每段取 workflowId+seq 最新 run 的 status/cost 派生；无链则空数组）
 * 纯读零写；project 缺失 → null（路由层转 404）。
 */
import { and, desc, eq, inArray, isNull, sum } from 'drizzle-orm'
import { db } from '../db'
import { batches, pipelineRuns, projects, usageRecords, workflows } from '../db/schema'
import { toBatchView } from './batch'
import { loadTemplate } from '../pipeline/loader'

/** 全景 run 摘要（批次组内与独立组同构） */
export interface OverviewRunLite {
  id: number
  batchSeq: number | null
  templateKey: string
  /** 固化快照版本（快照缺失 → null） */
  templateVersion: number | null
  status: string
  error: string | null
  input: unknown
  cost: number | null
  startedAt: number | null
  completedAt: number | null
  createdAt: number
}

/** [M27] 编排链段概览（每段取 workflowId+seq 最新 run；无 run → runId/status/cost 均 null） */
export interface WorkflowSegmentLite {
  seq: number
  templateKey: string
  templateName: string
  runId: number | null
  runStatus: string | null
  cost: number | null
}

/** [M27] 编排链概览（全景「编排链」区数据源） */
export interface WorkflowOverviewLite {
  id: number
  name: string
  status: string
  autoAdvance: number
  segments: WorkflowSegmentLite[]
}

export interface CanvasOverview {
  project: { id: number; name: string }
  batches: Array<Record<string, unknown> & { runs: OverviewRunLite[] }>
  standaloneRuns: OverviewRunLite[]
  stats: { runCount: number; byStatus: Record<string, number>; totalCost: number }
  /** [M27] 编排链（旧前端超集兼容；无链 → []） */
  workflows: WorkflowOverviewLite[]
}

export async function buildCanvasOverview(projectId: number): Promise<CanvasOverview | null> {
  const projRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1)
  const project = projRows[0]
  if (!project) return null

  const [batchRows, runRows] = await Promise.all([
    db.select().from(batches).where(eq(batches.projectId, projectId)).orderBy(desc(batches.createdAt)),
    db.select().from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId)).orderBy(desc(pipelineRuns.createdAt)),
  ])

  // 成本聚合（一次查询；口径对齐 summarizeBatch：SUM(usage.cost) GROUP BY run）
  const runIds = runRows.map((r) => r.id)
  const costRows = runIds.length
    ? await db
        .select({ runId: usageRecords.runId, cost: sum(usageRecords.cost) })
        .from(usageRecords)
        .where(inArray(usageRecords.runId, runIds))
        .groupBy(usageRecords.runId)
    : []
  const costByRun = new Map(costRows.map((r) => [r.runId, r.cost === null ? null : Number(r.cost)]))

  const toLite = (r: typeof pipelineRuns.$inferSelect): OverviewRunLite => ({
    id: r.id,
    batchSeq: r.batchSeq,
    templateKey: r.templateKey,
    templateVersion: snapshotVersion(r.templateSnapshot),
    status: r.status,
    error: r.error,
    input: safeParse(r.input),
    cost: costByRun.get(r.id) ?? null,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    createdAt: r.createdAt,
  })

  // 分组：批次组内按 batchSeq 升序；无批次归属 → standalone（保持 createdAt 降序）
  const runsByBatch = new Map<number, OverviewRunLite[]>()
  const standaloneRuns: OverviewRunLite[] = []
  for (const r of runRows) {
    if (r.batchId == null) {
      standaloneRuns.push(toLite(r))
    } else {
      const list = runsByBatch.get(r.batchId) ?? []
      list.push(toLite(r))
      runsByBatch.set(r.batchId, list)
    }
  }
  for (const list of runsByBatch.values()) list.sort((a, b) => (a.batchSeq ?? 0) - (b.batchSeq ?? 0))

  const byStatus: Record<string, number> = {}
  let totalCost = 0
  for (const r of runRows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    const c = costByRun.get(r.id)
    if (typeof c === 'number') totalCost += c
  }

  // [M27] 编排链聚合：每 (workflowId, seq) 取最新 run（runRows 已 createdAt 降序 → 首个命中即最新）
  const wfRows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.projectId, projectId))
    .orderBy(desc(workflows.createdAt))
  const latestBySeg = new Map<string, (typeof pipelineRuns.$inferSelect)>()
  for (const r of runRows) {
    if (r.workflowId == null) continue
    const key = `${r.workflowId}:${r.workflowSeq ?? 0}`
    if (!latestBySeg.has(key)) latestBySeg.set(key, r)
  }
  const workflowsOut: WorkflowOverviewLite[] = wfRows.map((w) => ({
    id: w.id,
    name: w.name,
    status: w.status,
    autoAdvance: w.autoAdvance,
    segments: parseSegs(w.segments).map((s, i) => {
      const run = latestBySeg.get(`${w.id}:${i}`) ?? null
      return {
        seq: i,
        templateKey: s.templateKey,
        templateName: templateNameOf(s.templateKey),
        runId: run?.id ?? null,
        runStatus: run?.status ?? null,
        cost: run ? costByRun.get(run.id) ?? null : null,
      }
    }),
  }))

  return {
    project: { id: project.id, name: project.name },
    batches: batchRows.map((b) => ({ ...toBatchView(b), runs: runsByBatch.get(b.id) ?? [] })),
    standaloneRuns,
    stats: { runCount: runRows.length, byStatus, totalCost },
    workflows: workflowsOut,
  }
}

/** 段 JSON 宽松解析（脏数据 → []） */
function parseSegs(raw: string): Array<{ templateKey: string }> {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as Array<{ templateKey: string }>).filter((s) => s && typeof s.templateKey === 'string') : []
  } catch {
    return []
  }
}

/** 模板显示名（缺失/异常 → 回退 key，不阻断全景读取） */
function templateNameOf(key: string): string {
  try {
    return loadTemplate(key).name || key
  } catch {
    return key
  }
}

function snapshotVersion(snapshot: string | null): number | null {
  if (!snapshot) return null
  try {
    const v = (JSON.parse(snapshot) as { version?: unknown }).version
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}

function safeParse(s: string | null): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
