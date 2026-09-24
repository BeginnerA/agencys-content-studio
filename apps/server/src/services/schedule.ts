/**
 * 排产调度服务（B1/B5）
 * - 轻量自研调度器：60s 轮询 + 幂等触发（红线内：计划表 + 幂等触发，非重型引擎）
 * - 触发语义：scheduledAt ≤ now 且 status=pending → 创建 batch → 置 triggered
 * - 崩溃恢复：启动时立即 tick 一次（与 reconcileBatches 互补）
 */
import { and, asc, eq, isNull, lte } from 'drizzle-orm'
import { db } from '../db'
import { batches, projects, schedules } from '../db/schema'
import { createLogger } from '../logger'
import { createBatch } from './batch'
import { emitStudioEvent } from './events'

const log = createLogger('schedule')

const TICK_INTERVAL = 60_000 // 60s 轮询
let timer: ReturnType<typeof setInterval> | undefined

/** 启动调度器（幂等：重复调用只启动一次） */
export function startScheduler(): void {
  if (timer) return
  // 启动后立即 tick 一次（恢复窗口内的到期计划）
  void tick().catch((err) => log.error('startup tick failed', err))
  timer = setInterval(() => {
    void tick().catch((err) => log.error('scheduler tick failed', err))
  }, TICK_INTERVAL)
  log.info('scheduler started (60s tick)')
}

/** 停止调度器（优雅关闭） */
export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = undefined
    log.info('scheduler stopped')
  }
}

/** 单轮扫描：查找到期 pending 计划 → 幂等触发 */
async function tick(): Promise<void> {
  const now = Date.now()
  const due = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.status, 'pending'), eq(schedules.isActive, 1), lte(schedules.scheduledAt, now)))
    .orderBy(asc(schedules.scheduledAt))
    .limit(20) // 单轮最多处理 20 条（防风暴）
  if (!due.length) return
  log.info(`scheduler tick: ${due.length} 条到期计划`)
  for (const s of due) {
    await triggerSchedule(s.id).catch((err) => {
      log.error(`schedule ${s.id} trigger failed`, err)
    })
  }
}

/** 幂等触发单条计划：pending → 创建 batch → triggered（导出供探针验证 CAS 语义） */
export async function triggerSchedule(scheduleId: number): Promise<void> {
  // [审计G1] CAS claim：条件 UPDATE（pending+active → triggered）原子翻转，单赢家。
  // 原「先查再写」在 tick 异步链交错（setInterval 允许重叠）时可双建批次 = 无人值守双扣费；
  // 与 dialogue-subtitle 的 ASR claim 同一收口模式
  const t0 = Date.now()
  const claimed = await db
    .update(schedules)
    .set({ status: 'triggered', lastTriggeredAt: t0, updatedAt: t0 })
    .where(and(eq(schedules.id, scheduleId), eq(schedules.status, 'pending'), eq(schedules.isActive, 1)))
    .returning({ id: schedules.id })
  if (!claimed.length) return

  const row = (await db.select().from(schedules).where(eq(schedules.id, scheduleId)).limit(1))[0]
  if (!row) return

  // 解析输入模板
  let inputs: Array<Record<string, unknown>>
  try {
    const parsed = JSON.parse(row.inputTemplate)
    inputs = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    log.error(`schedule ${scheduleId} input_template JSON 损坏`)
    await db
      .update(schedules)
      .set({ status: 'failed', updatedAt: Date.now() })
      .where(eq(schedules.id, scheduleId))
    return
  }
  if (!inputs.length) {
    // [审计G1附带] 空数组定终态 failed：原实现悬 pending 会被每轮 tick 重复扫到（永远 claim→回滚风暴）
    log.warn(`schedule ${scheduleId} input_template 为空数组，置 failed 不再重试`)
    await db
      .update(schedules)
      .set({ status: 'failed', updatedAt: Date.now() })
      .where(eq(schedules.id, scheduleId))
    return
  }

  // 校验项目存在（不存在 → 回拨 pending 保持原重试语义，项目恢复/重建后下轮可触发）
  const projRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, row.projectId), isNull(projects.deletedAt)))
    .limit(1)
  if (!projRows[0]) {
    log.warn(`schedule ${scheduleId} 项目 ${row.projectId} 不存在或已删除，回拨 pending 待下轮重试`)
    await db
      .update(schedules)
      .set({ status: 'pending', lastTriggeredAt: null, updatedAt: Date.now() })
      .where(eq(schedules.id, scheduleId))
    return
  }

  // 创建 batch（复用 batch 服务全链校验；[审计G3] 预算闸门已在 createBatch 单一真源接入）
  try {
    const { batch } = await createBatch({
      projectId: row.projectId,
      templateKey: row.templateKey,
      name: `[排产] ${row.name}`,
      inputs,
    })
    const t = Date.now()
    // claim 已置 triggered + lastTriggeredAt；此处只补批次指向
    await db
      .update(schedules)
      .set({ lastBatchId: batch.id, updatedAt: t })
      .where(eq(schedules.id, scheduleId))
    emitStudioEvent({
      type: 'schedule.triggered',
      runId: null,
      scheduleId: row.id,
      projectId: row.projectId,
      batchId: batch.id,
    } as never)
    log.info(`schedule ${scheduleId} → batch ${batch.id}（${inputs.length} 组输入）`)
  } catch (err) {
    log.error(`schedule ${scheduleId} createBatch failed`, err)
    await db
      .update(schedules)
      .set({ status: 'failed', updatedAt: Date.now() })
      .where(eq(schedules.id, scheduleId))
  }
}

// ---------- CRUD 辅助 ----------

export async function listSchedules(q: { projectId?: number; status?: string }): Promise<
  Array<typeof schedules.$inferSelect>
> {
  const conds = []
  if (q.projectId) conds.push(eq(schedules.projectId, q.projectId))
  if (q.status) conds.push(eq(schedules.status, q.status))
  return db
    .select()
    .from(schedules)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(schedules.scheduledAt))
    .limit(200)
}

export async function getSchedule(id: number): Promise<typeof schedules.$inferSelect | null> {
  const rows = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1)
  return rows[0] ?? null
}

export async function createSchedule(p: {
  projectId: number
  name: string
  templateKey: string
  scheduledAt: number
  inputTemplate: Array<Record<string, unknown>>
  note?: string
}): Promise<typeof schedules.$inferSelect> {
  const t = Date.now()
  const row = (
    await db
      .insert(schedules)
      .values({
        projectId: p.projectId,
        name: p.name.trim() || '未命名计划',
        templateKey: p.templateKey,
        cronExpr: 'once', // v1 仅一次性定时
        scheduledAt: p.scheduledAt,
        status: 'pending',
        inputTemplate: JSON.stringify(p.inputTemplate),
        note: p.note ?? null,
        isActive: 1,
        createdAt: t,
        updatedAt: t,
      })
      .returning()
  )[0]!
  return row
}

export async function cancelSchedule(id: number): Promise<void> {
  const row = await getSchedule(id)
  if (!row) throw new Error(`计划 ${id} 不存在`)
  if (row.status !== 'pending') throw new Error(`计划 ${id} 状态 ${row.status} 不可取消`)
  await db
    .update(schedules)
    .set({ status: 'cancelled', updatedAt: Date.now() })
    .where(eq(schedules.id, id))
}

export async function resetSchedule(id: number): Promise<void> {
  const row = await getSchedule(id)
  if (!row) throw new Error(`计划 ${id} 不存在`)
  if (row.status !== 'triggered' && row.status !== 'failed' && row.status !== 'cancelled') {
    throw new Error(`计划 ${id} 状态 ${row.status} 不可重置`)
  }
  await db
    .update(schedules)
    .set({ status: 'pending', lastTriggeredAt: null, lastBatchId: null, updatedAt: Date.now() })
    .where(eq(schedules.id, id))
}

export async function deleteSchedule(id: number): Promise<void> {
  const row = await getSchedule(id)
  if (!row) throw new Error(`计划 ${id} 不存在`)
  if (row.status === 'pending') {
    throw new Error('pending 状态请先取消再删除')
  }
  await db.delete(schedules).where(eq(schedules.id, id))
}

/** 日历视图：指定月份范围内的计划（含关联 batch 状态） */
export async function scheduleCalendar(q: {
  projectId?: number
  from: number
  to: number
}): Promise<Array<{
  id: number
  projectId: number
  name: string
  templateKey: string
  scheduledAt: number
  status: string
  lastBatchId: number | null
  batchStatus: string | null
  note: string | null
}>> {
  const conds = [
    lte(schedules.scheduledAt, q.to),
    // 不限制下限：已触发的计划 scheduledAt 可能在窗口前
  ]
  if (q.projectId) conds.push(eq(schedules.projectId, q.projectId))
  const rows = await db
    .select()
    .from(schedules)
    .where(and(...conds))
    .orderBy(asc(schedules.scheduledAt))
    .limit(500)

  // 关联 batch 状态
  const batchIds = rows.filter((r) => r.lastBatchId).map((r) => r.lastBatchId!)
  const batchMap = new Map<number, string>()
  if (batchIds.length) {
    const bRows = await db.select({ id: batches.id, status: batches.status }).from(batches)
    for (const b of bRows) batchMap.set(b.id, b.status)
  }

  return rows
    .filter((r) => r.scheduledAt >= q.from || r.status !== 'pending')
    .map((r) => ({
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      templateKey: r.templateKey,
      scheduledAt: r.scheduledAt,
      status: r.status,
      lastBatchId: r.lastBatchId,
      batchStatus: r.lastBatchId ? (batchMap.get(r.lastBatchId) ?? null) : null,
      note: r.note,
    }))
}
