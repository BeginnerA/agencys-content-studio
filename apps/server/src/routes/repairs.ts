/**
 * R06 修复闭环：修复端点
 *
 * 提供修复提案、批准、取消、采纳、拒绝等 REST 端点。
 * 修复状态机：proposed → approved → running → completed/cancelled/failed
 *
 * 端点清单：
 *   POST /runs/:id/repair       — 启动修复（生成修复计划）
 *   GET  /repairs/:id           — 查询修复状态
 *   POST /repairs/:id/approve   — 批准修复（异步执行）
 *   POST /repairs/:id/cancel    — 取消修复
 *   POST /repairs/:id/accept    — 采纳修复结果
 *   POST /repairs/:id/reject    — 拒绝修复（保留旧版本）
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { pipelineRuns, repairRuns, type RepairRun } from '../db/schema'
import { proposeRepair } from '../services/repair-service'
import { executeRepair } from '../services/repair-executor'
import { HttpError, h, idParam, notFound } from './helpers'
import { randomUUID } from 'node:crypto'

export const repairsRoutes = new Hono()

// ─── POST /runs/:id/repair —— 启动修复（生成修复计划） ─────────────────────────

repairsRoutes.post('/runs/:id/repair', h(async (c) => {
  const runId = idParam(c)

  // 校验源 run 存在
  const runRows = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1)
  if (runRows.length === 0) return notFound(c, `run ${runId}`)

  // 解析请求体：episodeIdx 必填
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const episodeIdx = body['episodeIdx']
  if (typeof episodeIdx !== 'number' || !Number.isInteger(episodeIdx) || episodeIdx < 0) {
    throw new HttpError(400, 'bad_episode_idx', 'episodeIdx 必须是非负整数')
  }

  // 生成修复提案
  const proposal = await proposeRepair(runId, episodeIdx)

  // 无问题则拒绝
  if (proposal.issues.length === 0) {
    throw new HttpError(400, 'no_issues', '该集质量均达标，无需修复')
  }

  // 插入 repair_runs 记录（status='proposed'）
  const now = Date.now()
  const repairId = randomUUID()
  await db.insert(repairRuns).values({
    id: repairId,
    sourceRunId: runId,
    episodeIdx,
    status: 'proposed',
    issues: JSON.stringify(proposal.issues),
    impactScope: JSON.stringify(proposal.impactScope),
    attemptCount: 0,
    totalCost: 0,
    scoreBefore: null,
    scoreAfter: null,
    stopReason: null,
    createdAt: now,
    updatedAt: now,
  })

  return c.json({ repairId, proposal }, 202)
}))

// ─── GET /repairs/:id —— 查询修复状态 ─────────────────────────────────────────

repairsRoutes.get('/repairs/:id', h(async (c) => {
  const repairId = c.req.param('id')
  if (!repairId) throw new HttpError(400, 'bad_id', '修复 id 路径参数缺失')

  const rows = await db
    .select()
    .from(repairRuns)
    .where(eq(repairRuns.id, repairId))
    .limit(1)

  if (rows.length === 0) return notFound(c, `修复 ${repairId}`)

  return c.json({ repair: toRepairView(rows[0]!) })
}))

// ─── POST /repairs/:id/approve —— 批准修复（异步执行） ────────────────────────

repairsRoutes.post('/repairs/:id/approve', h(async (c) => {
  const repairId = c.req.param('id')
  if (!repairId) throw new HttpError(400, 'bad_id', '修复 id 路径参数缺失')

  const repair = await findRepair(repairId)
  if (!repair) return notFound(c, `修复 ${repairId}`)

  // 状态检查：只有 proposed 可批准
  if (repair.status !== 'proposed') {
    throw new HttpError(409, 'bad_status', `只有 proposed 状态可批准（当前 ${repair.status}）`)
  }

  // 更新状态为 approved
  const now = Date.now()
  await db
    .update(repairRuns)
    .set({ status: 'approved', updatedAt: now })
    .where(eq(repairRuns.id, repairId))

  // 异步执行修复（不等待完成）
  executeRepair(repairId).catch((err) => {
    // 异步错误仅记录日志，不影响 HTTP 响应
    console.error(`[repairs] executeRepair failed for ${repairId}:`, err)
  })

  return c.json({ success: true })
}))

// ─── POST /repairs/:id/cancel —— 取消修复 ─────────────────────────────────────

repairsRoutes.post('/repairs/:id/cancel', h(async (c) => {
  const repairId = c.req.param('id')
  if (!repairId) throw new HttpError(400, 'bad_id', '修复 id 路径参数缺失')

  const repair = await findRepair(repairId)
  if (!repair) return notFound(c, `修复 ${repairId}`)

  // 状态检查：proposed / approved / running 可取消
  const cancellableStatuses = ['proposed', 'approved', 'running']
  if (!cancellableStatuses.includes(repair.status)) {
    throw new HttpError(409, 'bad_status', `只有 ${cancellableStatuses.join('/')} 状态可取消（当前 ${repair.status}）`)
  }

  const now = Date.now()
  await db
    .update(repairRuns)
    .set({ status: 'cancelled', stopReason: 'user_cancelled', updatedAt: now })
    .where(eq(repairRuns.id, repairId))

  return c.json({ success: true })
}))

// ─── POST /repairs/:id/accept —— 采纳修复结果 ─────────────────────────────────

repairsRoutes.post('/repairs/:id/accept', h(async (c) => {
  const repairId = c.req.param('id')
  if (!repairId) throw new HttpError(400, 'bad_id', '修复 id 路径参数缺失')

  const repair = await findRepair(repairId)
  if (!repair) return notFound(c, `修复 ${repairId}`)

  // 状态检查：只有 completed 可采纳
  if (repair.status !== 'completed') {
    throw new HttpError(409, 'bad_status', `只有 completed 状态可采纳（当前 ${repair.status}）`)
  }

  // 记录采纳时间戳（完整版本管理需更复杂的逻辑，本次仅更新 updatedAt）
  const now = Date.now()
  await db
    .update(repairRuns)
    .set({ updatedAt: now })
    .where(eq(repairRuns.id, repairId))

  return c.json({ success: true })
}))

// ─── POST /repairs/:id/reject —— 拒绝修复（保留旧版本） ───────────────────────

repairsRoutes.post('/repairs/:id/reject', h(async (c) => {
  const repairId = c.req.param('id')
  if (!repairId) throw new HttpError(400, 'bad_id', '修复 id 路径参数缺失')

  const repair = await findRepair(repairId)
  if (!repair) return notFound(c, `修复 ${repairId}`)

  // 状态检查：只有 completed 可拒绝
  if (repair.status !== 'completed') {
    throw new HttpError(409, 'bad_status', `只有 completed 状态可拒绝（当前 ${repair.status}）`)
  }

  const now = Date.now()
  await db
    .update(repairRuns)
    .set({ status: 'cancelled', stopReason: 'user_rejected', updatedAt: now })
    .where(eq(repairRuns.id, repairId))

  return c.json({ success: true })
}))

// ─── 内部辅助 ─────────────────────────────────────────────────────────────────

/** 查询单条修复记录 */
async function findRepair(repairId: string): Promise<RepairRun | null> {
  const rows = await db
    .select()
    .from(repairRuns)
    .where(eq(repairRuns.id, repairId))
    .limit(1)
  return rows[0] ?? null
}

/** 将数据库行转换为前端视图对象（解析 JSON 字段） */
function toRepairView(r: RepairRun): Record<string, unknown> {
  return {
    id: r.id,
    sourceRunId: r.sourceRunId,
    episodeIdx: r.episodeIdx,
    status: r.status,
    issues: safeParseJson(r.issues),
    impactScope: safeParseJson(r.impactScope),
    attemptCount: r.attemptCount,
    totalCost: r.totalCost,
    scoreBefore: r.scoreBefore,
    scoreAfter: r.scoreAfter,
    stopReason: r.stopReason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** 安全解析 JSON 字符串，失败时返回原始字符串 */
function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
