/**
 * [M4] 批次服务（E1）：串行默认调度 + 崩溃恢复对齐（spec §3.5 / §D 伪代码）
 * - 通用表（batches 无体裁逻辑）；调度逻辑零改动（复用 engine.startRun/cancelRun）
 * - pump 幂等：每轮从 DB 重算计数与槽位；批内互斥防 settle 风暴并发重入
 */
import { and, asc, eq, inArray, isNotNull, sum } from 'drizzle-orm'
import { db } from '../db'
import { batches, pipelineRuns, usageRecords, type PipelineRun } from '../db/schema'
import { createLogger } from '../logger'
import { engine } from '../pipeline/engine'
import { emitStudioEvent } from './events'
import { createRunRow, loadTemplateOrThrow, prepareRunInput, InvalidRunInputError } from './run-create'

const log = createLogger('batch')

/** finished 口径：终态 run */
const TERMINAL = ['completed', 'failed', 'cancelled']

/** 批内互斥：同批次同时只有一个 pump 在推进（防 settle 风暴并发重入） */
const pumps = new Set<number>()

export async function createBatch(p: {
  projectId: number
  templateKey: string
  name?: string
  schedule?: { max_concurrent?: number }
  inputs: Array<Record<string, unknown>>
}): Promise<{ batch: typeof batches.$inferSelect; runIds: number[] }> {
  if (!Array.isArray(p.inputs) || p.inputs.length === 0) {
    throw new InvalidRunInputError('bad_input', 'inputs 需为非空数组（批量输入组）')
  }
  // 阶段 A：全量校验（失败零落库；报错带组号）
  const template = loadTemplateOrThrow(p.templateKey)
  p.inputs.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidRunInputError('bad_input', `第 ${i + 1} 组输入：input 需为对象`)
    }
    try {
      prepareRunInput(template, raw)
    } catch (err) {
      if (err instanceof InvalidRunInputError) {
        throw new InvalidRunInputError(err.code, `第 ${i + 1} 组输入：${err.message}`)
      }
      throw err
    }
  })
  // 阶段 B：落批行 → 逐条落 run → 首轮 pump
  const t = Date.now()
  const fallbackName = `${template.name} × ${p.inputs.length}`
  const batch = (
    await db
      .insert(batches)
      .values({
        projectId: p.projectId,
        templateKey: p.templateKey,
        name: (p.name ?? '').trim() || fallbackName,
        status: 'running',
        schedule: JSON.stringify({ max_concurrent: clampConcurrent(p.schedule?.max_concurrent) }),
        total: p.inputs.length,
        finished: 0,
        succeeded: 0,
        failed: 0,
        createdAt: t,
        updatedAt: t,
      })
      .returning()
  )[0]!
  const runIds: number[] = []
  for (const [i, raw] of p.inputs.entries()) {
    const run = await createRunRow({
      projectId: p.projectId,
      templateKey: p.templateKey,
      input: raw,
      batchId: batch.id,
      batchSeq: i + 1,
    })
    runIds.push(run.id)
  }
  await pump(batch.id)
  const fresh = (await db.select().from(batches).where(eq(batches.id, batch.id)).limit(1))[0]!
  return { batch: fresh, runIds }
}

/** engine 钩子入口（index.ts 注册）：任何 run settle 都先推进所属批（若有），再扫停滞批 */
export async function notifyRunSettled(runId: number): Promise<void> {
  const rows = await db
    .select({ batchId: pipelineRuns.batchId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1)
  const batchId = rows[0]?.batchId
  // [M21 C6] 槽位释放与批次无关：批 settle 释放的全局槽位同样可救起其它批的 deferred run。
  // 因此属批分支不提前 return——先推进本批，再统一扫停滞批（否则批间救援被阻断）
  if (batchId) await pump(batchId)
  await pumpStalledBatches()
}

/** [M21 C6] 有 queued run 的 running 批次 → 逐批重试（幂等：pump 内已有 status 守卫与批内互斥；30s 定时器亦复用） */
export async function pumpStalledBatches(): Promise<void> {
  const rows = await db
    .selectDistinct({ batchId: pipelineRuns.batchId })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.status, 'queued'), isNotNull(pipelineRuns.batchId)))
  for (const r of rows) {
    if (r.batchId !== null) await pump(r.batchId)
  }
}

/** 单批推进（§D）：每轮从 DB 重算（幂等）；批内互斥 */
async function pump(batchId: number): Promise<void> {
  if (pumps.has(batchId)) return
  pumps.add(batchId)
  try {
    const batch = (await db.select().from(batches).where(eq(batches.id, batchId)).limit(1))[0]
    if (!batch || batch.status !== 'running') return
    const runs = await db.select().from(pipelineRuns).where(eq(pipelineRuns.batchId, batchId))
    const total = runs.length
    const finished = runs.filter((r) => TERMINAL.includes(r.status)).length
    const succeeded = runs.filter((r) => r.status === 'completed').length
    const failedN = runs.filter((r) => r.status === 'failed').length
    const active = runs.filter((r) => r.status === 'running' || r.status === 'waiting_input').length
    const t = Date.now()
    // ① 终态判定（gate 挂起计入 active，不触发终态——批次暂停）
    if (finished === total) {
      const next = succeeded === total ? 'completed' : succeeded > 0 ? 'partial_failed' : 'failed'
      await db
        .update(batches)
        .set({ status: next, total, finished, succeeded, failed: failedN, updatedAt: t })
        .where(eq(batches.id, batchId))
      emitStudioEvent({ type: 'batch.updated', runId: null, batchId, projectId: batch.projectId, status: next, finished, total })
      log.info(`batch ${batchId} 收敛为 ${next}（${succeeded}/${total} 成功）`)
      return
    }
    // ② 槽位推进：slots = 上限 − 活跃；已 startRun 但 DB 状态未翻转的 run 会在
    //    engine.startRun 的 active 判定中被幂等吸收（不超发）；下一轮 pump 补位
    const maxC = clampConcurrent(readMaxConcurrent(batch.schedule))
    const slots = maxC - active
    if (slots > 0) {
      const queued = runs
        .filter((r) => r.status === 'queued')
        .sort((a, b) => (a.batchSeq ?? 0) - (b.batchSeq ?? 0))
        .slice(0, slots)
      for (const r of queued) engine.startRun(r.id)
    }
    // ③ 计数回写 + 事件
    await db
      .update(batches)
      .set({ total, finished, succeeded, failed: failedN, updatedAt: t })
      .where(eq(batches.id, batchId))
    emitStudioEvent({ type: 'batch.updated', runId: null, batchId, projectId: batch.projectId, status: 'running', finished, total })
  } finally {
    pumps.delete(batchId)
  }
}

export async function cancelBatch(batchId: number): Promise<void> {
  const batch = (await db.select().from(batches).where(eq(batches.id, batchId)).limit(1))[0]
  if (!batch) throw new Error(`批次 ${batchId} 不存在`)
  if (batch.status === 'completed' || batch.status === 'cancelled') return
  const t = Date.now()
  // 先置批次终态：随后 run 取消触发的 settle → pump 因 status≠running 直接返回（不误推进）
  await db.update(batches).set({ status: 'cancelled', updatedAt: t }).where(eq(batches.id, batchId))
  const runs = await db.select().from(pipelineRuns).where(eq(pipelineRuns.batchId, batchId))
  for (const r of runs) {
    if (r.status === 'queued') {
      await db
        .update(pipelineRuns)
        .set({ status: 'cancelled', completedAt: t, updatedAt: t })
        .where(eq(pipelineRuns.id, r.id))
    } else if (r.status === 'running' || r.status === 'waiting_input') {
      await engine.cancelRun(r.id)
    }
  }
  // 计数回写（权威重算；pump 对非 running 批次不负责收尾）
  const fresh = await db.select().from(pipelineRuns).where(eq(pipelineRuns.batchId, batchId))
  const finished = fresh.filter((r) => TERMINAL.includes(r.status)).length
  const succeeded = fresh.filter((r) => r.status === 'completed').length
  const failedN = fresh.filter((r) => r.status === 'failed').length
  await db
    .update(batches)
    .set({ total: fresh.length, finished, succeeded, failed: failedN, updatedAt: Date.now() })
    .where(eq(batches.id, batchId))
  emitStudioEvent({ type: 'batch.updated', runId: null, batchId, projectId: batch.projectId, status: 'cancelled', finished, total: fresh.length })
}

/** 启动对齐：全部 running 批次重 pump（崩溃恢复后按槽位约束继续推进） */
export async function reconcileBatches(): Promise<void> {
  const rows = await db.select({ id: batches.id }).from(batches).where(eq(batches.status, 'running'))
  for (const r of rows) await pump(r.id)
  if (rows.length) log.info(`reconcile: ${rows.length} 个 running 批次已重对齐`)
}

/** 批次详情数据源：batch + runs（含 usage 成本合计） */
export async function summarizeBatch(batchId: number): Promise<{
  batch: typeof batches.$inferSelect
  runs: Array<PipelineRun & { cost: number | null }>
} | null> {
  const batch = (await db.select().from(batches).where(eq(batches.id, batchId)).limit(1))[0]
  if (!batch) return null
  const runs = await db
    .select()
    .from(pipelineRuns)
    .where(eq(pipelineRuns.batchId, batchId))
    .orderBy(asc(pipelineRuns.batchSeq))
  const runIds = runs.map((r) => r.id)
  const costRows = runIds.length
    ? await db
        .select({ runId: usageRecords.runId, cost: sum(usageRecords.cost) })
        .from(usageRecords)
        .where(inArray(usageRecords.runId, runIds))
        .groupBy(usageRecords.runId)
    : []
  const costByRun = new Map(costRows.map((r) => [r.runId, r.cost === null ? null : Number(r.cost)]))
  return { batch, runs: runs.map((r) => ({ ...r, cost: costByRun.get(r.id) ?? null })) }
}

/** 批次视图投影（REST 层与 [M23] overview 聚合共用；自 routes/batches.ts 迁入） */
export function toBatchView(b: typeof batches.$inferSelect): Record<string, unknown> {
  return {
    id: b.id,
    projectId: b.projectId,
    templateKey: b.templateKey,
    name: b.name,
    status: b.status,
    schedule: safeParse(b.schedule) ?? { max_concurrent: 1 },
    total: b.total,
    finished: b.finished,
    succeeded: b.succeeded,
    failed: b.failed,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
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

/** 并发上限归一 1–3（REST 层已对超限 400；此处兜底非 REST 调用） */
function clampConcurrent(v: number | undefined): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 3 ? v : 1
}

function readMaxConcurrent(schedule: string): number {
  try {
    const s = JSON.parse(schedule) as { max_concurrent?: number }
    return clampConcurrent(s.max_concurrent)
  } catch {
    return 1
  }
}
