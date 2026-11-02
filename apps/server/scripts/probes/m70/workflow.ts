/**
 * 探针：专业工作流逐段批准（workflow 节）
 * - 建链两段独立；首段启用；无包 start 拒绝；携批准 start 绑定；
 * - autoAdvance 级联遇启用段 → paused/input，须当前段 re-preview + re-approve；
 * - nextSeq/previousRunId 漂移 → 旧包 409；并发 next 只加一个 run；
 * - routes/workflows start/resume 请求级覆盖；旧非启用链零改动。
 * 隔离：临时 SQLite（bootstrap 每次新建），fixtures 模板仅写临时目录；fetch 全程桩死。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { Checker } from '../../probe-lib'
import { ContinuityError, type Approval, type PreviewRequest, type TargetRequest } from '../../../src/services/continuity/contract'
import { withContinuityIO } from '../../../src/services/continuity/runtime'
import { initDatabase } from './bootstrap'
import { confirmEpisode, fakeIO, installTargetFixture, seedStory } from './fixtures'
import { test } from './fold'

const empty = { content: JSON.stringify({ subjects: [], topics: [], items: [], warnings: [], noChanges: true }),
  usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 }, provider: 'fixture', model: 'fixture' }

export async function runWorkflow(checker: Checker) {
  installTargetFixture()
  await initDatabase()
  await runWorkflowBody(checker)
}

async function runWorkflowBody(checker: Checker) {
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { and, eq, inArray } = await import('drizzle-orm')
  const { contentContinuityRecords: records, pipelineRuns, workflows } = await import('../../../src/db/schema')
  const { previewContext, freezeContext } = await import('../../../src/services/continuity/context')
  const { advanceWorkflow, createWorkflow, prepareFirstSegment, requestNextSegment, resumeWorkflow, startWorkflow, WorkflowError }
    = await import('../../../src/services/workflow')
  const { createRunRow } = await import('../../../src/services/run-create')
  const { engine } = await import('../../../src/pipeline/engine')
  const { RUN_LOGS_DIR } = await import('../../../src/env')
  const { Hono } = await import('hono')
  const { workflowsRoutes } = await import('../../../src/routes/workflows')
  // 服务：缺失即真实 RED（逐测试失败，不让整节崩溃）。
  const bridge = () => import('../../../src/services/continuity/workflow-bridge')

  mkdirSync(RUN_LOGS_DIR, { recursive: true })
  type Story = Awaited<ReturnType<typeof seedStory>>
  const codeOf = (status: number, name?: string) => (e: unknown) =>
    e instanceof ContinuityError && e.status === status && (!name || e.code === name)
  const wfError = (code: string) => (e: unknown) => e instanceof WorkflowError && e.code === code

  /** 确认前两集（仅推进临时 DB 台账，无任何图像/音频动作）。 */
  const setupStory = async () => {
    const f = await seedStory(), ef = fakeIO(empty)
    await withContinuityIO(ef.io, async () => {
      for (let i = 0; i < 2; i++) await confirmEpisode(f, i, ef.io)
    })
    return { f, ef }
  }

  const enabledSegments = (): Array<{ templateKey: string; inputSpec: Record<string, string> }> => [
    { templateKey: 'm70-fixture-episode', inputSpec: { brief: 'W第一段简报', episode_number: '2', with_continuity: 'true' } },
    { templateKey: 'm70-fixture-episode', inputSpec: { brief: 'W第二段简报', episode_number: '3', with_continuity: 'true' } },
  ]
  const plainSegments = (): Array<{ templateKey: string; inputSpec: Record<string, string> }> => [
    { templateKey: 'm70-fixture-episode', inputSpec: { brief: '旧链第一段', episode_number: '2' } },
    { templateKey: 'm70-fixture-episode', inputSpec: { brief: '旧链第二段', episode_number: '3' } },
  ]
  const makeChain = async (projectId: number, opts?: { autoAdvance?: number; budgetCap?: number | null;
    segments?: Array<{ templateKey: string; inputSpec: Record<string, string> }> }) =>
    createWorkflow({ projectId, name: '探针链', segments: opts?.segments ?? enabledSegments(),
      autoAdvance: opts?.autoAdvance ?? 0, budgetCap: opts?.budgetCap ?? null })

  const workflowTarget = (workflowId: number, nextSeq: number, previousRunId: number | null) =>
    ({ kind: 'workflow' as const, workflowId, nextSeq, previousRunId })

  /** 工作流目标包冻结（re-preview → re-approve 同源）：预览/freeze 零模型调用。 */
  const freezeWorkflowPack = async (story: Story, ef: ReturnType<typeof fakeIO>, workflowId: number,
    nextSeq: number, previousRunId: number | null): Promise<Approval> => {
    const req: PreviewRequest = { target: workflowTarget(workflowId, nextSeq, previousRunId), includePlans: false }
    const p = await withContinuityIO(ef.io, () => previewContext(story.projectId, req))
    assert.deepEqual(p.blockers, [])
    return withContinuityIO(ef.io, () => freezeContext(story.projectId, { target: req.target, includePlans: false,
      previewHash: p.doc.previewHash,
      acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID() }))
  }

  /** manual 异种包（kind 不为 workflow）：验证批准目标种类不匹配即 409。 */
  const freezeManualPack = async (story: Story, ef: ReturnType<typeof fakeIO>, episodeId: number, brief: string): Promise<Approval> => {
    const { loadTemplate } = await import('../../../src/pipeline/loader')
    const { prepareRunInput } = await import('../../../src/services/run-create')
    const tpl = loadTemplate('m70-fixture-episode')
    const norm = prepareRunInput(tpl, { brief, episode_number: 3, with_continuity: true })
    const target = { kind: 'manual' as const, episodeId, templateKey: 'm70-fixture-episode',
      input: norm as Extract<TargetRequest, { kind: 'manual' }>['input'] }
    const p = await withContinuityIO(ef.io, () => previewContext(story.projectId, { target, includePlans: false }))
    assert.deepEqual(p.blockers, [])
    return withContinuityIO(ef.io, () => freezeContext(story.projectId, { target, includePlans: false,
      previewHash: p.doc.previewHash,
      acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID() }))
  }

  const patchStartRun = (): { calls: number[]; restore: () => void } => {
    const calls: number[] = []
    const original = engine.startRun.bind(engine)
    ;(engine as unknown as { startRun: unknown }).startRun = (id: number): string => { calls.push(id); return 'started' }
    return { calls, restore: () => { delete (engine as unknown as { startRun?: unknown }).startRun; void original } }
  }
  // 节级引擎桩：本节全程不得真实执行 run（真实 startRun 会异步触发全局 pump，污染共享 SQLite）。
  const engineGuard = patchStartRun()
  const resetEngineCalls = () => { engineGuard.calls.length = 0 }

  const countRuns = async (workflowId: number) =>
    (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.workflowId, workflowId))).length
  const contextRow = async (contextId: number) =>
    (await db.select().from(records).where(eq(records.id, contextId)))[0]!
  const workflowRow = async (workflowId: number) =>
    (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0]!
  const runsAt = async (workflowId: number, seq: number) =>
    (await db.select().from(pipelineRuns).where(and(eq(pipelineRuns.workflowId, workflowId), eq(pipelineRuns.workflowSeq, seq))))
  /** 直接置 completed（引擎钩子由探针手动 advanceWorkflow 模拟，不真实执行任何步骤）。 */
  const completeRun = async (runId: number) => {
    await db.update(pipelineRuns).set({ status: 'completed', updatedAt: Date.now() }).where(eq(pipelineRuns.id, runId))
  }
  const runInput = (run: { input: string }) => JSON.parse(run.input) as Record<string, unknown>
  /** 只读 blocked 投影（bridge 缺失即测试失败 = RED 证据）。 */
  const blockOf = async (projectId: number, workflowId: number) => {
    const { readWorkflowContinuityBlock } = await bridge()
    return readWorkflowContinuityBlock(projectId, workflowId, db)
  }

  // ===== 测试主体（节级引擎桩全程生效，任何路径都不得真实执行 run）=====
  try {
  await t('7.1 无包启动启用链：409 continuity_gaps_unaccepted，零 run 零台账', async () => {
    const { f, ef } = await setupStory()
    const wf = await makeChain(f.projectId)
    await assert.rejects(withContinuityIO(ef.io, () => startWorkflow(wf.id)), codeOf(409, 'continuity_gaps_unaccepted'))
    assert.equal(await countRuns(wf.id), 0)
    assert.equal((await db.select().from(records).where(and(eq(records.projectId, f.projectId), eq(records.rowType, 'context')))).length, 0)
    assert.equal((await workflowRow(wf.id))!.status, 'draft')
  })

  await t('7.1 携批准启动：服务端追加槽位、台账绑定 run、engine 恰一次、重复 start 拒绝、预览/冻结零模型调用', async () => {
    const { f, ef } = await setupStory()
    const wf = await makeChain(f.projectId)
    resetEngineCalls()
    const callsBefore = ef.calls()
    const approval = await freezeWorkflowPack(f, ef, wf.id, 0, null)
    const { workflow, runId } = await withContinuityIO(ef.io, () => startWorkflow(wf.id, { continuityApproval: approval }))
    assert.equal(workflow.status, 'active')
    assert.deepEqual(engineGuard.calls, [runId])
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId))
    const input = runInput(run!)
    assert.deepEqual(input['continuity_context'], [approval.document.assetId])
    assert.equal(input['with_continuity'], true)
    assert.equal(run!.workflowSeq, 0)
    const row = await contextRow(approval.contextId)
    assert.equal(row.status, 'bound')
    assert.equal(row.runId, runId)
    // 既有状态闸优先于 already_started（draft|paused 之外一律 bad_start；幂等语义等同：不重复建 run/引擎）
    await assert.rejects(withContinuityIO(ef.io, () => startWorkflow(wf.id, { continuityApproval: approval })), wfError('bad_start'))
    assert.equal(engineGuard.calls.length, 1)
    assert.equal(ef.calls(), callsBefore)
  })

  await t('7.4 autoAdvance=0 完成→保持 active 等批准，只读投影出待批目标签名', async () => {
    const { f, ef } = await setupStory()
    const wf = await makeChain(f.projectId, { autoAdvance: 0 })
    const approval = await freezeWorkflowPack(f, ef, wf.id, 0, null)
    const { runId } = await withContinuityIO(ef.io, () => startWorkflow(wf.id, { continuityApproval: approval }))
    await completeRun(runId)
    await advanceWorkflow(runId)
    assert.equal((await workflowRow(wf.id))!.status, 'active')
    assert.equal(await countRuns(wf.id), 1)
    const block = await blockOf(f.projectId, wf.id)
    assert.equal(block?.code, 'continuity_gaps_unaccepted')
    assert.deepEqual(block?.target, { kind: 'workflow', workflowId: wf.id, nextSeq: 1, previousRunId: runId })
  })

  await t('7.1 autoAdvance=1 启用未批准：显式 paused/input，不落下一 run', async () => {
    const { f, ef } = await setupStory()
    const wf = await makeChain(f.projectId, { autoAdvance: 1 })
    const approval = await freezeWorkflowPack(f, ef, wf.id, 0, null)
    const { runId } = await withContinuityIO(ef.io, () => startWorkflow(wf.id, { continuityApproval: approval }))
    await completeRun(runId)
    await advanceWorkflow(runId)
    assert.equal((await workflowRow(wf.id))!.status, 'paused')
    assert.equal(await countRuns(wf.id), 1)
    const block = await blockOf(f.projectId, wf.id)
    assert.equal(block?.code, 'continuity_gaps_unaccepted')
    assert.deepEqual(block?.target, { kind: 'workflow', workflowId: wf.id, nextSeq: 1, previousRunId: runId })
  })

  await t('7.1 简报逐字口径：requestNextSegment blocked(input) → 带 nextApproval advanced 且包绑定', async () => {
    const { f, ef } = await setupStory()
    const wf = await makeChain(f.projectId, { autoAdvance: 1 })
    resetEngineCalls()
    const approval = await freezeWorkflowPack(f, ef, wf.id, 0, null)
    const { runId } = await withContinuityIO(ef.io, () => startWorkflow(wf.id, { continuityApproval: approval }))
    await completeRun(runId)
    await advanceWorkflow(runId)
    assert.equal((await workflowRow(wf.id))!.status, 'paused')
    const nextApproval = await freezeWorkflowPack(f, ef, wf.id, 1, runId)
    const blocked = await withContinuityIO(ef.io, () => requestNextSegment(wf.id))
    assert.equal(blocked.kind, 'blocked')
    if (blocked.kind === 'blocked') assert.equal(blocked.reason, 'input')
    const advanced = await withContinuityIO(ef.io, () => requestNextSegment(wf.id, { continuityApproval: nextApproval }))
    assert.equal(advanced.kind, 'advanced')
    assert.equal(advanced.kind === 'advanced' ? (await runsAt(wf.id, 1))[0]?.id : undefined, advanced.kind === 'advanced' ? advanced.runId : undefined)
    const [run1] = await runsAt(wf.id, 1)
    assert.deepEqual(runInput(run1!)['continuity_context'], [nextApproval.document.assetId])
    assert.deepEqual(engineGuard.calls, [runId, run1!.id])
    const row = await contextRow(nextApproval.contextId)
    assert.equal(row.status, 'bound')
    assert.equal(row.runId, run1!.id)
  })

  await t('7.1 错位/异种批准 409 continuity_context_changed；bridge 定位漂移 409 conflict；跨项目 404', async () => {
    const { f, ef } = await setupStory()
    const wf = await makeChain(f.projectId, { autoAdvance: 1 })
    const stale = await freezeWorkflowPack(f, ef, wf.id, 0, null)
    const { runId } = await withContinuityIO(ef.io, () => startWorkflow(wf.id, { continuityApproval: stale }))
    await completeRun(runId)
    await advanceWorkflow(runId)
    // stale 面向 seq0（已消费）；当前推进定位已是 seq1 → 旧包必须 409
    await assert.rejects(withContinuityIO(ef.io, () => requestNextSegment(wf.id, { continuityApproval: stale })), codeOf(409, 'continuity_context_changed'))
    const manual = await freezeManualPack(f, ef, f.episodes[2]!, '手工异种包')
    await assert.rejects(withContinuityIO(ef.io, () => requestNextSegment(wf.id, { continuityApproval: manual })), codeOf(409, 'continuity_context_changed'))
    const { resolveWorkflowContinuityTarget } = await bridge()
    await assert.rejects(resolveWorkflowContinuityTarget(f.projectId, workflowTarget(wf.id, 5, runId), db), codeOf(409, 'continuity_conflict'))
    await assert.rejects(resolveWorkflowContinuityTarget(f.projectId, workflowTarget(wf.id, 1, runId + 999), db), codeOf(409, 'continuity_conflict'))
    const other = await setupStory()
    await assert.rejects(resolveWorkflowContinuityTarget(other.f.projectId, workflowTarget(wf.id, 1, runId), db), codeOf(404, 'continuity_source_invalid'))
  })

  await t('7.1 并发批准续跑：同链互斥只建一个 run，engine 单发、台账单绑定', async () => {
    const { f, ef } = await setupStory()
    const wf = await makeChain(f.projectId, { autoAdvance: 1 })
    resetEngineCalls()
    const approval = await freezeWorkflowPack(f, ef, wf.id, 0, null)
    const { runId } = await withContinuityIO(ef.io, () => startWorkflow(wf.id, { continuityApproval: approval }))
    await completeRun(runId)
    await advanceWorkflow(runId)
    const nextApproval = await freezeWorkflowPack(f, ef, wf.id, 1, runId)
    const results = await Promise.allSettled([
      withContinuityIO(ef.io, () => requestNextSegment(wf.id, { continuityApproval: nextApproval })),
      withContinuityIO(ef.io, () => requestNextSegment(wf.id, { continuityApproval: nextApproval })),
    ])
    const advanced = results.filter(r => r.status === 'fulfilled' && (r.value as { kind: string }).kind === 'advanced')
    const rejected = results.filter(r => r.status === 'rejected')
    assert.equal(advanced.length, 1)
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0]!.reason instanceof WorkflowError)
    assert.equal(await countRuns(wf.id), 2)
    const rows = await runsAt(wf.id, 1)
    assert.equal(rows.length, 1)
    assert.deepEqual(engineGuard.calls, [runId, rows[0]!.id])
    assert.equal((await contextRow(nextApproval.contextId)).runId, rows[0]!.id)
  })

  await t('7.2 路由 start/resume：409/400 映射、台账绑定、resume{} 再暂停、携批准续跑闭环', async () => {
    const { f, ef } = await setupStory()
    const wf = await makeChain(f.projectId, { autoAdvance: 1 })
    const approval = await freezeWorkflowPack(f, ef, wf.id, 0, null)
    const app = new (Hono as typeof import('hono').Hono)()
    app.route('/api/v1', workflowsRoutes)
    const post = async (path: string, body: unknown) => app.request(path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    resetEngineCalls()
    const noPack = await withContinuityIO(ef.io, () => post(`/api/v1/workflows/${wf.id}/start`, {}))
    assert.equal(noPack.status, 409)
    assert.equal(((await noPack.json()) as { error: { code: string } }).error.code, 'continuity_gaps_unaccepted')
    assert.equal(await countRuns(wf.id), 0)
    const bad = await withContinuityIO(ef.io, () => post(`/api/v1/workflows/${wf.id}/start`, { continuity_approval: { contextId: 'x' } }))
    assert.equal(bad.status, 400)
    const ok = await withContinuityIO(ef.io, () => post(`/api/v1/workflows/${wf.id}/start`, { continuity_approval: approval }))
    assert.equal(ok.status, 200)
    const okBody = await ok.json() as { workflow: { status: string }; runId: number }
    assert.equal(okBody.workflow.status, 'active')
    assert.deepEqual(engineGuard.calls, [okBody.runId])
    assert.equal((await contextRow(approval.contextId)).runId, okBody.runId)
    await completeRun(okBody.runId)
    await advanceWorkflow(okBody.runId)
    assert.equal((await workflowRow(wf.id))!.status, 'paused')
    const resumeNo = await withContinuityIO(ef.io, () => post(`/api/v1/workflows/${wf.id}/resume`, {}))
    assert.equal(resumeNo.status, 200)
    assert.equal(((await resumeNo.json()) as { workflow: { status: string } }).workflow.status, 'paused')
    assert.equal(await countRuns(wf.id), 1)
    const nextApproval = await freezeWorkflowPack(f, ef, wf.id, 1, okBody.runId)
    const resumeOk = await withContinuityIO(ef.io, () => post(`/api/v1/workflows/${wf.id}/resume`, { continuity_approval: nextApproval }))
    assert.equal(resumeOk.status, 200)
    assert.equal(((await resumeOk.json()) as { workflow: { status: string } }).workflow.status, 'active')
    const rows = await runsAt(wf.id, 1)
    assert.equal(rows.length, 1)
    assert.equal((await contextRow(nextApproval.contextId)).runId, rows[0]!.id)
    assert.ok(engineGuard.calls.includes(rows[0]!.id))
  })

  await t('7.3 resolveWorkflowContinuityTarget 纯定位：解析 unit/模板/输入，零副作用（无 run/无状态变更/无台账）', async () => {
    const { f } = await setupStory()
    const wf = await makeChain(f.projectId)
    const { resolveWorkflowContinuityTarget } = await bridge()
    const material = await resolveWorkflowContinuityTarget(f.projectId, workflowTarget(wf.id, 0, null), db)
    assert.equal(material.unit.unitOrdinal, 2)
    assert.equal(material.templateKey, 'm70-fixture-episode')
    assert.equal(material.input['with_continuity'], true)
    assert.ok(!('continuity_context' in material.input))
    assert.equal(await countRuns(wf.id), 0)
    assert.equal((await workflowRow(wf.id))!.status, 'draft')
    assert.equal((await db.select().from(records).where(and(eq(records.projectId, f.projectId), eq(records.rowType, 'context')))).length, 0)
    await assert.rejects(resolveWorkflowContinuityTarget(f.projectId, workflowTarget(wf.id, 1, null), db), codeOf(409, 'continuity_conflict'))
  })

  await t('7.4 链级预算熔断优先于批准推进：blocked budget + paused，投影仍指待批段', async () => {
    const { f, ef } = await setupStory()
    const wf = await makeChain(f.projectId, { autoAdvance: 1, budgetCap: 0 })
    const approval = await freezeWorkflowPack(f, ef, wf.id, 0, null)
    const { runId } = await withContinuityIO(ef.io, () => startWorkflow(wf.id, { continuityApproval: approval }))
    await completeRun(runId)
    await advanceWorkflow(runId)
    assert.equal((await workflowRow(wf.id))!.status, 'paused')
    const nextApproval = await freezeWorkflowPack(f, ef, wf.id, 1, runId)
    const outcome = await withContinuityIO(ef.io, () => requestNextSegment(wf.id, { continuityApproval: nextApproval }))
    assert.deepEqual(outcome, { kind: 'blocked', reason: 'budget' })
    assert.equal(await countRuns(wf.id), 1)
    assert.equal((await workflowRow(wf.id))!.status, 'paused')
    const block = await blockOf(f.projectId, wf.id)
    assert.equal(block?.code, 'continuity_gaps_unaccepted')
    assert.deepEqual(block?.target, { kind: 'workflow', workflowId: wf.id, nextSeq: 1, previousRunId: runId })
  })

  await t('7.4 旧非启用链零改动：两段照常推进至 done、零台账、无阻塞投影', async () => {
    const { f } = await setupStory()
    const wf = await makeChain(f.projectId, { autoAdvance: 1, segments: plainSegments() })
    resetEngineCalls()
    const { runId } = await withContinuityIO(fakeIO(empty).io, () => startWorkflow(wf.id))
    assert.equal((await workflowRow(wf.id))!.status, 'active')
    await completeRun(runId)
    await advanceWorkflow(runId)
    const [run1] = await runsAt(wf.id, 1)
    assert.ok(run1, '旧链第二段必须照常创建')
    assert.deepEqual(engineGuard.calls, [runId, run1!.id])
    const input = runInput(run1!)
    assert.equal(input['with_continuity'], false)
    assert.ok(!('continuity_context' in input))
    await completeRun(run1!.id)
    await advanceWorkflow(run1!.id)
    assert.equal((await workflowRow(wf.id))!.status, 'done')
    const runIds = (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.workflowId, wf.id))).map(r => r.id)
    assert.equal((await db.select().from(records).where(inArray(records.runId, runIds))).length, 0)
    assert.equal(await blockOf(f.projectId, wf.id), null)
  })

  await t('7.4 prepareFirstSegment 选项同源：无批准 409、带批准追加槽位并可绑定（route 确认同口径）', async () => {
    const { f, ef } = await setupStory()
    const wf = await makeChain(f.projectId)
    await assert.rejects(withContinuityIO(ef.io, () => prepareFirstSegment({ projectId: f.projectId, segments: JSON.stringify(enabledSegments()) })), codeOf(409, 'continuity_gaps_unaccepted'))
    const approval = await freezeWorkflowPack(f, ef, wf.id, 0, null)
    const first = await withContinuityIO(ef.io, () => prepareFirstSegment({ projectId: f.projectId, segments: JSON.stringify(enabledSegments()) }, { continuityApproval: approval }))
    assert.equal(first.templateKey, 'm70-fixture-episode')
    assert.deepEqual(first.inputs['continuity_context'], [approval.document.assetId])
    assert.equal(first.inputs['with_continuity'], true)
    const run = await withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: first.templateKey,
      input: first.inputs, workflowId: wf.id, workflowSeq: 0, continuityApproval: approval }))
    assert.equal((await contextRow(approval.contextId)).runId, run.id)
  })
  } finally { engineGuard.restore() }
}
