/**
 * 修复端点契约测试
 *
 * 验证 repairs.ts 路由端点的输入/输出/错误契约：
 *   - POST /runs/:id/repair：启动修复（生成修复计划）
 *   - GET /repairs/:id：查询修复状态
 *   - POST /repairs/:id/approve：批准修复（异步执行）
 *   - POST /repairs/:id/cancel：取消修复
 *   - POST /repairs/:id/accept：采纳修复结果
 *   - POST /repairs/:id/reject：拒绝修复
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase } from './bootstrap'
import { test } from './helpers'

/** 解析响应体（探针断言用，避免 Hono Response.json() 返回 unknown） */
async function json(res: Response): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return res.json()
}

export async function runEndpoints(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { repairRuns, pipelineRuns } = await import('../../../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { randomUUID } = await import('node:crypto')
  const { repairsRoutes } = await import('../../../src/routes/repairs')
  const { Hono } = await import('hono')

  // 构建测试用 Hono 应用
  const app = new Hono()
  app.route('/', repairsRoutes)

  // 取种子 run 的 id
  const [seedRun] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
  assert.ok(seedRun, 'seed run must exist')
  const sourceRunId = seedRun!.id

  // ─── POST /runs/:id/repair ─────────────────────────────────────────────────

  await t('POST /runs/:id/repair：契约正确（202 + repairId + proposal）', async () => {
    const res = await app.request(`/runs/${sourceRunId}/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 1 }),
    })
    assert.equal(res.status, 202, `status must be 202, got ${res.status}`)
    const data = await json(res)
    assert.ok(typeof data.repairId === 'string', 'repairId must be a string')
    assert.ok(data.proposal, 'proposal must exist')
    assert.ok(Array.isArray(data.proposal.issues), 'proposal.issues must be an array')
  })

  await t('POST /runs/:id/repair：错误契约——run 不存在（404）', async () => {
    const res = await app.request('/runs/999999/repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 1 }),
    })
    assert.equal(res.status, 404, `status must be 404, got ${res.status}`)
    const data = await json(res)
    assert.ok(data.error, 'error object must exist')
    assert.equal(data.error.code, 'not_found', 'error.code must be not_found')
  })

  await t('POST /runs/:id/repair：错误契约——episodeIdx 缺失（400）', async () => {
    const res = await app.request(`/runs/${sourceRunId}/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
    const data = await json(res)
    assert.ok(data.error, 'error object must exist')
    assert.equal(data.error.code, 'bad_episode_idx', 'error.code must be bad_episode_idx')
  })

  await t('POST /runs/:id/repair：错误契约——episodeIdx 非整数（400）', async () => {
    const res = await app.request(`/runs/${sourceRunId}/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx: 1.5 }),
    })
    assert.equal(res.status, 400, `status must be 400, got ${res.status}`)
  })

  // ─── GET /repairs/:id ──────────────────────────────────────────────────────

  await t('GET /repairs/:id：契约正确（200 + repair 对象）', async () => {
    // 先创建一条修复记录
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'proposed',
      issues: JSON.stringify([{ dimension: 'citation', score: 60, threshold: 70, suggestion: '测试建议' }]),
      impactScope: JSON.stringify({ affectedRunIds: [], affectedEpisodes: [], sharedSources: [], snapshotCount: 0 }),
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.request(`/repairs/${repairId}`)
    assert.equal(res.status, 200, `status must be 200, got ${res.status}`)
    const data = await json(res)
    assert.ok(data.repair, 'repair object must exist')
    assert.equal(data.repair.id, repairId, 'repair.id must match')
    assert.equal(data.repair.status, 'proposed', 'repair.status must be proposed')
  })

  await t('GET /repairs/:id：错误契约——修复不存在（404）', async () => {
    const res = await app.request('/repairs/non-existent-id')
    assert.equal(res.status, 404, `status must be 404, got ${res.status}`)
    const data = await json(res)
    assert.ok(data.error, 'error object must exist')
    assert.equal(data.error.code, 'not_found', 'error.code must be not_found')
  })

  // ─── POST /repairs/:id/approve ─────────────────────────────────────────────

  await t('POST /repairs/:id/approve：契约正确（200 + success）', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'proposed',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.request(`/repairs/${repairId}/approve`, { method: 'POST' })
    assert.equal(res.status, 200, `status must be 200, got ${res.status}`)
    const data = await json(res)
    assert.equal(data.success, true, 'success must be true')

    // 验证状态已离开 proposed（异步执行器可能已推进到 approved/running/completed）
    const [row] = await db.select().from(repairRuns).where(eq(repairRuns.id, repairId)).limit(1)
    assert.ok(row!.status !== 'proposed', `status must have left proposed (actual: ${row!.status})`)
  })

  await t('POST /repairs/:id/approve：错误契约——状态非 proposed（409）', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'completed',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.request(`/repairs/${repairId}/approve`, { method: 'POST' })
    assert.equal(res.status, 409, `status must be 409, got ${res.status}`)
    const data = await json(res)
    assert.equal(data.error.code, 'bad_status', 'error.code must be bad_status')
  })

  // ─── POST /repairs/:id/cancel ──────────────────────────────────────────────

  await t('POST /repairs/:id/cancel：契约正确（200 + success）', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'proposed',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.request(`/repairs/${repairId}/cancel`, { method: 'POST' })
    assert.equal(res.status, 200, `status must be 200, got ${res.status}`)
    const data = await json(res)
    assert.equal(data.success, true, 'success must be true')

    // 验证状态已更新为 cancelled
    const [row] = await db.select().from(repairRuns).where(eq(repairRuns.id, repairId)).limit(1)
    assert.equal(row!.status, 'cancelled', 'status must be cancelled after cancel')
  })

  await t('POST /repairs/:id/cancel：错误契约——状态为 completed（409）', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'completed',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.request(`/repairs/${repairId}/cancel`, { method: 'POST' })
    assert.equal(res.status, 409, `status must be 409, got ${res.status}`)
  })

  // ─── POST /repairs/:id/accept ──────────────────────────────────────────────

  await t('POST /repairs/:id/accept：契约正确（200 + success）', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'completed',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.request(`/repairs/${repairId}/accept`, { method: 'POST' })
    assert.equal(res.status, 200, `status must be 200, got ${res.status}`)
    const data = await json(res)
    assert.equal(data.success, true, 'success must be true')
  })

  await t('POST /repairs/:id/accept：错误契约——状态非 completed（409）', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'proposed',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.request(`/repairs/${repairId}/accept`, { method: 'POST' })
    assert.equal(res.status, 409, `status must be 409, got ${res.status}`)
  })

  // ─── POST /repairs/:id/reject ──────────────────────────────────────────────

  await t('POST /repairs/:id/reject：契约正确（200 + success）', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'completed',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.request(`/repairs/${repairId}/reject`, { method: 'POST' })
    assert.equal(res.status, 200, `status must be 200, got ${res.status}`)
    const data = await json(res)
    assert.equal(data.success, true, 'success must be true')

    // 验证状态已更新为 cancelled
    const [row] = await db.select().from(repairRuns).where(eq(repairRuns.id, repairId)).limit(1)
    assert.equal(row!.status, 'cancelled', 'status must be cancelled after reject')
  })

  await t('POST /repairs/:id/reject：错误契约——状态非 completed（409）', async () => {
    const repairId = randomUUID()
    const now = Date.now()
    await db.insert(repairRuns).values({
      id: repairId,
      sourceRunId,
      episodeIdx: 1,
      status: 'approved',
      issues: '[]',
      impactScope: '{}',
      attemptCount: 0,
      totalCost: 0,
      scoreBefore: null,
      scoreAfter: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.request(`/repairs/${repairId}/reject`, { method: 'POST' })
    assert.equal(res.status, 409, `status must be 409, got ${res.status}`)
  })
}
