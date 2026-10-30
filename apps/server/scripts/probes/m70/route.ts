/**
 * M70 Task 8 探针：智能创作 route 接线与等待投影（route 节）
 * - route/template、route/chain 确认经真实端点 /confirm、/advance-chain：显式批准 → createRunRow 绑定台账；
 * - 未批准 / LLM 决策塞包 / 过期 decision / 另一会话包 / 同 key 不同包 → 409 或既有 schema 错误；
 * - chain 下一段：无批准 blocked+paused 投影，携 workflow 包批准 advanced；旧 easy 分支零经过；
 * - 未声明/batch 目标步 unsupported；等待投影区分 budget/failure。
 * 隔离：临时 SQLite（bootstrap 每次新建），fixtures 模板仅写临时目录；fetch 全程桩死；不启动媒体生成。
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

export async function runRoute(checker: Checker) {
  installTargetFixture()
  await initDatabase()
  await runRouteBody(checker)
}

async function runRouteBody(checker: Checker) {
  // libsql 0.18 连接池自愈（仅探针基础设施，不涉产品代码）：并发下某条池化连接可能被
  // 「未 finalize 的语句」钉住 WAL 读快照——该连接 autocommit=ON（release 守卫的 inTransaction
  // 看不见），其后落在它上面的读会看到过期视图（新表/新行不可见）、写会 SQLITE_BUSY_SNAPSHOT(517)。
  // 全量回归 9 节共用一库一池时在 route 节后段稳定触发。这里用金丝雀表探测，命中即
  // client.reopen() 重开全部池化连接；reopen 后仍不一致才算真故障（不掩盖产品缺陷）。
  const { db: rawDb, sqlite } = await import('../../../src/db')
  const { sql } = await import('drizzle-orm')
  await rawDb.run(sql`CREATE TABLE IF NOT EXISTS _m70_probe_canary (v integer NOT NULL)`)
  let canarySeq = 0
  const reopenPool = async () => { await (sqlite as unknown as { reconnect(): Promise<void> }).reconnect() }
  const healIfStale = async (tag: string): Promise<void> => {
    const probe = async (v: number): Promise<boolean> => {
      await rawDb.run(sql`INSERT INTO _m70_probe_canary (v) VALUES (${v})`)
      const row = await rawDb.get(sql`SELECT MAX(v) AS m FROM _m70_probe_canary`) as { m?: number } | undefined
      return row?.m === v
    }
    canarySeq++
    let ok: boolean
    try { ok = await probe(canarySeq) } catch { ok = false }
    if (ok) return
    console.error(`[m70-probe] 池化连接快照过期（${tag}）→ sqlite.reconnect() 自愈`)
    await reopenPool()
    canarySeq++
    assert.equal(await probe(canarySeq), true, `连接池 reopen 后金丝雀仍不一致（${tag}）`)
  }
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, async () => {
    await healIfStale(name.slice(0, 30))
    await body()
  })
  const { db } = await import('../../../src/db')
  const { and, eq } = await import('drizzle-orm')
  const { contentContinuityRecords: records, creationSessions, pipelineRuns, usageRecords, workflows } = await import('../../../src/db/schema')
  const { previewContext, freezeContext, readContext } = await import('../../../src/services/continuity/context')
  const { readWorkflowContinuityBlock } = await import('../../../src/services/continuity/workflow-bridge')
  const { requestNextSegment } = await import('../../../src/services/workflow')
  const { saveBudget } = await import('../../../src/services/budget')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { prepareRunInput } = await import('../../../src/services/run-create')
  const { engine } = await import('../../../src/pipeline/engine')
  const { RUN_LOGS_DIR } = await import('../../../src/env')
  const { Hono } = await import('hono')
  const { creationChatRoutes } = await import('../../../src/routes/creation-chat')
  const { createSession } = await import('../../../src/services/creation-chat/planning')
  const { agentDecisionSchema, agentRouteReplySchema } = await import('../../../src/services/creation-chat/agent/decision-schema')
  const { hashJson } = await import('../../../src/services/creation-chat/contract')

  mkdirSync(RUN_LOGS_DIR, { recursive: true })
  type Story = Awaited<ReturnType<typeof seedStory>>
  const codeOf = (status: number, name?: string) => (e: unknown) =>
    e instanceof ContinuityError && e.status === status && (!name || e.code === name)
  const snapshot = { key: 'm70-fixture-episode', version: 1 }
  const specOf = (brief: string, episode: number) => ({
    brief: { kind: 'text', value: brief }, episode_number: { kind: 'number', value: episode },
    with_continuity: { kind: 'boolean', value: true },
  })
  const templateDecision = (brief: string, templateKey = 'm70-fixture-episode') => ({
    mode: 'template' as const, roleKey: 'planner', rationale: '单模板直出，段间无链',
    templateRun: { templateKey, catalogSnapshot: { key: templateKey, version: 1 }, inputSpec: specOf(brief, 2) },
  })
  const chainDecision = (brief1: string, brief2: string) => ({
    mode: 'chain' as const, roleKey: 'planner', rationale: '两段链式推进，段间暂停等批准',
    chain: [
      { templateKey: 'm70-fixture-episode', catalogSnapshot: snapshot, title: '第一段', inputSpec: specOf(brief1, 2) },
      { templateKey: 'm70-fixture-episode', catalogSnapshot: snapshot, title: '第二段', inputSpec: specOf(brief2, 3) },
    ],
  })

  /** 确认前两集（仅推进临时 DB 台账，无任何图像/音频动作）。 */
  const setupStory = async () => {
    const f = await seedStory(), ef = fakeIO(empty)
    await withContinuityIO(ef.io, async () => {
      for (let i = 0; i < 2; i++) await confirmEpisode(f, i, ef.io)
    })
    return { f, ef }
  }

  /** 已有三集项目的 route 会话：既有建会话服务（deferPlanning 零 LLM）→ 重指项目 → 冻结 decision（rev1/ready）。 */
  const makeRouteSession = async (story: Story, decisionInput: unknown): Promise<{ sessionId: number; decisionHash: string; revision: number }> => {
    const detail = await createSession({ content: 'M70 route 探针：为已有三集项目接承接包', requestKey: `route_probe_${randomUUID()}`, deferPlanning: true })
    const sessionId = detail.session.id
    const decision = agentDecisionSchema.parse(decisionInput)
    const decisionHash = hashJson(decision)
    await db.update(creationSessions).set({ projectId: story.projectId, status: 'ready', decision: JSON.stringify(decision),
      decisionHash, planRevision: 1, preflight: JSON.stringify({ ready: true, issues: [], summary: { mode: decision.mode, templateKeys: [] } }),
      error: null, updatedAt: Date.now() }).where(eq(creationSessions.id, sessionId))
    return { sessionId, decisionHash, revision: 1 }
  }

  const routeTarget = (sessionId: number, decisionRevision: number, decisionHash: string): Extract<TargetRequest, { kind: 'route' }> =>
    ({ kind: 'route', sessionId, decisionRevision, decisionHash })

  /** route 目标包冻结（re-preview → re-approve 同源）：预览/freeze 零模型调用。 */
  const freezeRoutePack = async (story: Story, ef: ReturnType<typeof fakeIO>, sessionId: number,
    decisionRevision: number, decisionHash: string): Promise<Approval> => {
    const target = routeTarget(sessionId, decisionRevision, decisionHash)
    const p = await withContinuityIO(ef.io, () => previewContext(story.projectId, { target, includePlans: false } satisfies PreviewRequest))
    assert.deepEqual(p.blockers, [])
    return withContinuityIO(ef.io, () => freezeContext(story.projectId, { target, includePlans: false,
      previewHash: p.doc.previewHash,
      acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID() }))
  }

  /** workflow 目标包冻结（chain 下一段批准用，与 workflow 节同源）。 */
  const freezeWorkflowPack = async (story: Story, ef: ReturnType<typeof fakeIO>, workflowId: number,
    nextSeq: number, previousRunId: number | null): Promise<Approval> => {
    const target: Extract<TargetRequest, { kind: 'workflow' }> = { kind: 'workflow', workflowId, nextSeq, previousRunId }
    const p = await withContinuityIO(ef.io, () => previewContext(story.projectId, { target, includePlans: false }))
    assert.deepEqual(p.blockers, [])
    return withContinuityIO(ef.io, () => freezeContext(story.projectId, { target, includePlans: false,
      previewHash: p.doc.previewHash,
      acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID() }))
  }

  /** manual 异种包（kind 不为 route）：验证批准目标种类不匹配即 409。 */
  const freezeManualPack = async (story: Story, ef: ReturnType<typeof fakeIO>, episodeId: number, brief: string): Promise<Approval> => {
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

  const app = new (Hono as typeof import('hono').Hono)()
  app.route('/api/v1', creationChatRoutes)
  const confirmUrl = (sessionId: number) => '/api/v1/creation-sessions/' + sessionId + '/confirm'
  const advanceUrl = (sessionId: number) => '/api/v1/creation-sessions/' + sessionId + '/advance-chain'
  const detailUrl = (sessionId: number) => '/api/v1/creation-sessions/' + sessionId
  type Res = Response
  const post = async (path: string, body: unknown): Promise<Res> => {
    const res = await app.request(path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    await healIfStale('post ' + path)
    return res
  }
  const get = async (path: string): Promise<Res> => {
    const res = await app.request(path, { method: 'GET' })
    await healIfStale('get ' + path)
    return res
  }
  const errBody = async (res: Res) => (await res.json()) as { error?: { code?: string }; advance?: { outcome?: string; runId?: number }; session?: { chainAwaiting?: boolean; chainContinuityBlock?: { code: string; target: unknown } | null } }

  const projectRuns = async (projectId: number) =>
    (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId))).length
  const projectWorkflows = async (projectId: number) =>
    (await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.projectId, projectId))).length
  const projectContexts = async (projectId: number) =>
    (await db.select({ id: records.id }).from(records).where(and(eq(records.projectId, projectId), eq(records.rowType, 'context')))).length
  const contextRow = async (contextId: number) =>
    (await db.select().from(records).where(eq(records.id, contextId)))[0]!
  const workflowRow = async (workflowId: number) =>
    (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0]!
  const runsAt = async (workflowId: number, seq: number) =>
    (await db.select().from(pipelineRuns).where(and(eq(pipelineRuns.workflowId, workflowId), eq(pipelineRuns.workflowSeq, seq))))
  const runInput = (run: { input: string }) => JSON.parse(run.input) as Record<string, unknown>
  /** 直接置 completed（引擎钩子由探针手动模拟，不真实执行任何步骤）。 */
  const completeRun = async (runId: number) => {
    await db.update(pipelineRuns).set({ status: 'completed', updatedAt: Date.now() }).where(eq(pipelineRuns.id, runId))
  }
  /** 只读 blocked 投影（服务级，供与 detail 投影互证）。 */
  const blockOf = async (projectId: number, workflowId: number) => readWorkflowContinuityBlock(projectId, workflowId, db)
  /** 项目 run 基线（seedStory 预置三集 completed run；断言相对基线，不误计预置）。 */
  const runsBaseline = async (projectId: number) => projectRuns(projectId)

  // ===== 测试主体（节级引擎桩全程生效，任何路径都不得真实执行 run）=====
  try {
  await t('8.1 route/template 确认：202 + route 目标台账绑定 + engine 恰一次 + 确认零模型调用', async () => {
    const { f, ef } = await setupStory()
    const s = await makeRouteSession(f, templateDecision('R第一集简报'))
    const approval = await freezeRoutePack(f, ef, s.sessionId, s.revision, s.decisionHash)
    const callsBefore = ef.calls()
    resetEngineCalls()
    const res = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId),
      { decisionRevision: s.revision, decisionHash: s.decisionHash, idempotencyKey: 'route_confirm_01', acceptUnpriced: true, continuityApproval: approval }))
    assert.equal(res.status, 202)
    const body = await res.json() as { runId: number; workflowId?: number }
    assert.equal(typeof body.runId, 'number')
    const record = await readContext(f.projectId, approval, db)
    assert.equal(record.target.request.kind, 'route')
    if (record.target.request.kind === 'route') {
      assert.equal(record.target.request.sessionId, s.sessionId)
      assert.equal(record.target.request.decisionRevision, 1)
    }
    assert.equal(record.target.unit.unitOrdinal, 2)
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, body.runId))
    const input = runInput(run!)
    assert.deepEqual(input['continuity_context'], [approval.document.assetId])
    assert.equal(input['with_continuity'], true)
    const row = await contextRow(approval.contextId)
    assert.equal(row.status, 'bound')
    assert.equal(row.runId, body.runId)
    assert.deepEqual(engineGuard.calls, [body.runId])
    assert.equal(ef.calls(), callsBefore)
  })

  await t('8.2 同 key 不同包冻结 409 conflict；确认幂等回放 202 同 run；同位异包不偷绑', async () => {
    const { f, ef } = await setupStory()
    const s = await makeRouteSession(f, templateDecision('R幂等简报'))
    const target = routeTarget(s.sessionId, s.revision, s.decisionHash)
    const p = await withContinuityIO(ef.io, () => previewContext(f.projectId, { target, includePlans: false }))
    const approval = await withContinuityIO(ef.io, () => freezeContext(f.projectId, { target, includePlans: false,
      previewHash: p.doc.previewHash,
      acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: 'route_op_key_01' }))
    resetEngineCalls()
    const body = { decisionRevision: s.revision, decisionHash: s.decisionHash, idempotencyKey: 'route_confirm_02', acceptUnpriced: true, continuityApproval: approval }
    const ok = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId), body))
    assert.equal(ok.status, 202)
    const okBody = await ok.json() as { runId: number }
    assert.deepEqual(engineGuard.calls, [okBody.runId])
    // 同 operationKey 不同请求（换包哈希）→ 冻结回放冲突 409，绝不覆盖原包
    await assert.rejects(withContinuityIO(ef.io, () => freezeContext(f.projectId, { target, includePlans: false,
      previewHash: 'f'.repeat(64), acceptedGaps: [], operationKey: 'route_op_key_01' })), codeOf(409, 'continuity_conflict'))
    // 同 key 幂等回放：202 同 run，不重绑不重拉引擎
    const replay = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId), body))
    assert.equal(replay.status, 202)
    assert.equal(((await replay.json()) as { runId: number }).runId, okBody.runId)
    assert.deepEqual(engineGuard.calls, [okBody.runId])
    // 同位置另一包（独立 operationKey）可冻结；对已启动会话确认不偷绑（B 包保持 frozen）
    const other = await freezeRoutePack(f, ef, s.sessionId, s.revision, s.decisionHash)
    const again = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId),
      { ...body, continuityApproval: other }))
    assert.equal(again.status, 202)
    assert.equal(((await again.json()) as { runId: number }).runId, okBody.runId)
    assert.equal((await contextRow(other.contextId)).status, 'frozen')
  })

  await t('8.2 未批准：template/chain 均 409 continuity_gaps_unaccepted，零 run 零台账零引擎', async () => {
    const { f, ef } = await setupStory()
    resetEngineCalls()
    const runs0 = await runsBaseline(f.projectId)
    const st = await makeRouteSession(f, templateDecision('R无包简报'))
    const resT = await withContinuityIO(ef.io, () => post(confirmUrl(st.sessionId),
      { decisionRevision: st.revision, decisionHash: st.decisionHash, idempotencyKey: 'route_confirm_03', acceptUnpriced: true }))
    assert.equal(resT.status, 409)
    assert.equal(((await resT.json()) as { error: { code: string } }).error.code, 'continuity_gaps_unaccepted')
    assert.equal(await projectRuns(f.projectId), runs0)
    assert.equal(await projectWorkflows(f.projectId), 0)
    assert.equal(await projectContexts(f.projectId), 0)
    const ch = await makeRouteSession(f, chainDecision('C无包一段', 'C无包二段'))
    const resC = await withContinuityIO(ef.io, () => post(confirmUrl(ch.sessionId),
      { decisionRevision: ch.revision, decisionHash: ch.decisionHash, idempotencyKey: 'route_confirm_03b', acceptUnpriced: true }))
    assert.equal(resC.status, 409)
    assert.equal(((await resC.json()) as { error: { code: string } }).error.code, 'continuity_gaps_unaccepted')
    assert.equal(await projectRuns(f.projectId), runs0)
    assert.equal(await projectWorkflows(f.projectId), 0)
    assert.equal(engineGuard.calls.length, 0)
  })

  await t('8.2 LLM 决策塞包：契约级拒绝（agent 契约 strict），会话不可经 route 确认且零副作用', async () => {
    const { f, ef } = await setupStory()
    const s = await makeRouteSession(f, templateDecision('R塞包简报'))
    const approval = await freezeRoutePack(f, ef, s.sessionId, s.revision, s.decisionHash)
    // 契约级：LLM 回复/权威决策契约均 strict，不收 continuityApproval 键
    const decision = agentDecisionSchema.parse(templateDecision('R塞包简报'))
    assert.equal(agentDecisionSchema.safeParse({ ...decision, continuityApproval: approval }).success, false)
    assert.equal(agentRouteReplySchema.safeParse({ kind: 'route', mode: 'template', message: '塞包', rationale: '塞包',
      continuityApproval: approval }).success, false)
    // 请求级：被篡改决策（模拟 LLM 塞包落库）解析失败 → routeDecisionOf null → 走 easy 契约拒绝（422），零 run
    const [row] = await db.select().from(creationSessions).where(eq(creationSessions.id, s.sessionId))
    const tampered = { ...JSON.parse(row!.decision!), continuityApproval: approval }
    await db.update(creationSessions).set({ decision: JSON.stringify(tampered), updatedAt: Date.now() }).where(eq(creationSessions.id, s.sessionId))
    resetEngineCalls()
    const runs0 = await runsBaseline(f.projectId)
    const res = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId),
      { decisionRevision: s.revision, decisionHash: s.decisionHash, idempotencyKey: 'route_confirm_04', acceptUnpriced: true }))
    assert.equal(res.status, 422)
    assert.equal(await projectRuns(f.projectId), runs0)
    assert.equal(engineGuard.calls.length, 0)
    assert.equal((await contextRow(approval.contextId)).status, 'frozen')
  })

  await t('8.2/8.5 decision 变更后旧包 409 continuity_context_changed；冻结新包后 202 绑定', async () => {
    const { f, ef } = await setupStory()
    const s = await makeRouteSession(f, templateDecision('R第一版简报'))
    const stale = await freezeRoutePack(f, ef, s.sessionId, s.revision, s.decisionHash)
    // 决策推进 rev2：换简报文本 → 新 decisionHash（与 persistRouteDecision 的 revision+1 同律）
    const d1 = agentDecisionSchema.parse(templateDecision('R第一版简报'))
    const d2 = agentDecisionSchema.parse(templateDecision('R第二版简报'))
    const hash2 = hashJson(d2)
    await db.update(creationSessions).set({ decision: JSON.stringify(d2), decisionHash: hash2, planRevision: 2, status: 'ready', updatedAt: Date.now() })
      .where(eq(creationSessions.id, s.sessionId))
    resetEngineCalls()
    const runs0 = await runsBaseline(f.projectId)
    const res = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId),
      { decisionRevision: 2, decisionHash: hash2, idempotencyKey: 'route_confirm_05', acceptUnpriced: true, continuityApproval: stale }))
    assert.equal(res.status, 409)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'continuity_context_changed')
    assert.equal(await projectRuns(f.projectId), runs0)
    assert.equal(engineGuard.calls.length, 0)
    const fresh = await freezeRoutePack(f, ef, s.sessionId, 2, hash2)
    const ok = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId),
      { decisionRevision: 2, decisionHash: hash2, idempotencyKey: 'route_confirm_05b', acceptUnpriced: true, continuityApproval: fresh }))
    assert.equal(ok.status, 202)
    const okBody = await ok.json() as { runId: number }
    assert.equal((await contextRow(fresh.contextId)).runId, okBody.runId)
    assert.equal((await contextRow(stale.contextId)).status, 'frozen')
    assert.deepEqual(engineGuard.calls, [okBody.runId])
  })

  await t('8.2 另一会话冻结的包 409 continuity_context_changed，零副作用', async () => {
    const { f, ef } = await setupStory()
    const a = await makeRouteSession(f, templateDecision('RA会话简报'))
    const b = await makeRouteSession(f, templateDecision('RB会话简报'))
    const packB = await freezeRoutePack(f, ef, b.sessionId, b.revision, b.decisionHash)
    resetEngineCalls()
    const runs0 = await runsBaseline(f.projectId)
    const res = await withContinuityIO(ef.io, () => post(confirmUrl(a.sessionId),
      { decisionRevision: a.revision, decisionHash: a.decisionHash, idempotencyKey: 'route_confirm_06', acceptUnpriced: true, continuityApproval: packB }))
    assert.equal(res.status, 409)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'continuity_context_changed')
    assert.equal(await projectRuns(f.projectId), runs0)
    assert.equal(await projectWorkflows(f.projectId), 0)
    assert.equal((await contextRow(packB.contextId)).status, 'frozen')
    assert.equal(engineGuard.calls.length, 0)
  })

  await t('8.5 route/chain 确认：202 + workflow active + 首段绑定 + 段定义与决策一致（不偷换）', async () => {
    const { f, ef } = await setupStory()
    const s = await makeRouteSession(f, chainDecision('C第一段简报', 'C第二段简报'))
    const decision = agentDecisionSchema.parse(chainDecision('C第一段简报', 'C第二段简报'))
    const approval = await freezeRoutePack(f, ef, s.sessionId, s.revision, s.decisionHash)
    const callsBefore = ef.calls()
    resetEngineCalls()
    const res = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId),
      { decisionRevision: s.revision, decisionHash: s.decisionHash, idempotencyKey: 'route_confirm_07', acceptUnpriced: true, continuityApproval: approval }))
    assert.equal(res.status, 202)
    const body = await res.json() as { runId: number; workflowId: number }
    assert.equal(typeof body.workflowId, 'number')
    const wf = await workflowRow(body.workflowId)
    assert.equal(wf.status, 'active')
    // 段定义逐项与决策一致：模板键 + 简报 + 集号均不偷换
    const segments = JSON.parse(wf.segments) as Array<{ templateKey: string; inputSpec?: Record<string, string> }>
    assert.equal(segments.length, decision.chain!.length)
    assert.equal(segments[0]!.templateKey, decision.chain![0]!.templateKey)
    assert.equal(segments[0]!.inputSpec?.brief, 'C第一段简报')
    assert.equal(segments[0]!.inputSpec?.episode_number, '2')
    assert.equal(segments[1]!.templateKey, decision.chain![1]!.templateKey)
    assert.equal(segments[1]!.inputSpec?.brief, 'C第二段简报')
    assert.equal(segments[1]!.inputSpec?.episode_number, '3')
    const [run0] = await runsAt(body.workflowId, 0)
    assert.equal(run0!.id, body.runId)
    const input = runInput(run0!)
    assert.deepEqual(input['continuity_context'], [approval.document.assetId])
    assert.equal(input['with_continuity'], true)
    // 台账批准目标 = route 决策的第一段（集 2），绝不为后续段预支
    const record = await readContext(f.projectId, approval, db)
    assert.equal(record.target.unit.unitOrdinal, 2)
    assert.equal((await contextRow(approval.contextId)).runId, body.runId)
    assert.deepEqual(engineGuard.calls, [body.runId])
    assert.equal(ef.calls(), callsBefore)
  })

  await t('8.2/8.3 chain 确认携异种 manual 包 409 continuity_context_changed，链零建立', async () => {
    const { f, ef } = await setupStory()
    const s = await makeRouteSession(f, chainDecision('C异种一段', 'C异种二段'))
    const manual = await freezeManualPack(f, ef, f.episodes[2]!, '手工异种包')
    resetEngineCalls()
    const runs0 = await runsBaseline(f.projectId)
    const res = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId),
      { decisionRevision: s.revision, decisionHash: s.decisionHash, idempotencyKey: 'route_confirm_08', acceptUnpriced: true, continuityApproval: manual }))
    assert.equal(res.status, 409)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'continuity_context_changed')
    assert.equal(await projectRuns(f.projectId), runs0)
    assert.equal(await projectWorkflows(f.projectId), 0)
    assert.equal((await contextRow(manual.contextId)).status, 'frozen')
    assert.equal(engineGuard.calls.length, 0)
  })

  await t('8.5 chain 下一段：无批准 blocked+paused 投影 → 携 workflow 包批准 advanced 绑定', async () => {
    const { f, ef } = await setupStory()
    const s = await makeRouteSession(f, chainDecision('C续跑一段', 'C续跑二段'))
    const approval = await freezeRoutePack(f, ef, s.sessionId, s.revision, s.decisionHash)
    resetEngineCalls()
    const ok = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId),
      { decisionRevision: s.revision, decisionHash: s.decisionHash, idempotencyKey: 'route_confirm_09', acceptUnpriced: true, continuityApproval: approval }))
    assert.equal(ok.status, 202)
    const okBody = await ok.json() as { runId: number; workflowId: number }
    await completeRun(okBody.runId)
    // 无批准续跑：202 + outcome blocked（简报逐字口径），链 paused，会话投影出待批卡
    const blocked = await withContinuityIO(ef.io, () => post(advanceUrl(s.sessionId), { idempotencyKey: 'route_advance_01' }))
    assert.equal(blocked.status, 202)
    const blockedBody = await errBody(blocked)
    assert.equal(blockedBody.advance?.outcome, 'blocked')
    assert.equal((await workflowRow(okBody.workflowId)).status, 'paused')
    assert.equal(blockedBody.session?.chainAwaiting, true)
    assert.deepEqual(blockedBody.session?.chainContinuityBlock, { code: 'continuity_gaps_unaccepted',
      target: { kind: 'workflow', workflowId: okBody.workflowId, nextSeq: 1, previousRunId: okBody.runId } })
    // 携下一推进位置的 workflow 包批准 → advanced + run1 绑定 + 引擎单发
    const next = await freezeWorkflowPack(f, ef, okBody.workflowId, 1, okBody.runId)
    const advanced = await withContinuityIO(ef.io, () => post(advanceUrl(s.sessionId),
      { idempotencyKey: 'route_advance_02', continuityApproval: next }))
    assert.equal(advanced.status, 202)
    const advancedBody = await errBody(advanced)
    assert.equal(advancedBody.advance?.outcome, 'advanced')
    const run1 = (await runsAt(okBody.workflowId, 1))[0]!
    assert.equal(run1.id, advancedBody.advance?.runId)
    assert.deepEqual(runInput(run1)['continuity_context'], [next.document.assetId])
    assert.equal((await contextRow(next.contextId)).runId, run1.id)
    assert.deepEqual(engineGuard.calls, [okBody.runId, run1.id])
  })

  await t('8.4 等待投影行走：active 等待 → paused 带阻塞 → budget 熔断不伪装 → 解除恢复 → 失败不伪装', async () => {
    const { f, ef } = await setupStory()
    const s = await makeRouteSession(f, chainDecision('C投影一段', 'C投影二段'))
    const approval = await freezeRoutePack(f, ef, s.sessionId, s.revision, s.decisionHash)
    const ok = await withContinuityIO(ef.io, () => post(confirmUrl(s.sessionId),
      { decisionRevision: s.revision, decisionHash: s.decisionHash, idempotencyKey: 'route_confirm_10', acceptUnpriced: true, continuityApproval: approval }))
    assert.equal(ok.status, 202)
    const okBody = await ok.json() as { runId: number; workflowId: number }
    await completeRun(okBody.runId)
    const readAwaiting = async () => {
      const res = await get(detailUrl(s.sessionId))
      assert.equal(res.status, 200)
      const body = await errBody(res)
      return { awaiting: body.session?.chainAwaiting, block: body.session?.chainContinuityBlock ?? null }
    }
    // ① active 正常等待（既有口径不变）：待批且无阻塞签名
    assert.deepEqual(await readAwaiting(), { awaiting: true, block: null })
    // ② paused + 明确 continuity input 阻塞 → 仍算等待，附阻塞签名
    const blocked = await withContinuityIO(ef.io, () => requestNextSegment(okBody.workflowId))
    assert.deepEqual(blocked, { kind: 'blocked', reason: 'input' })
    const pausedView = await readAwaiting()
    assert.equal(pausedView.awaiting, true)
    assert.equal(pausedView.block?.code, 'continuity_gaps_unaccepted')
    // ③ 项目预算熔断：不伪装待承接（阻塞签名仍在，仅不出卡）
    await db.insert(usageRecords).values({ projectId: f.projectId, kind: 'llm', quantity: 1, unit: 'tokens_in', unitPrice: 1, cost: 1, createdAt: Date.now() })
    await saveBudget({ projects: { [String(f.projectId)]: { total: 0 } } })
    assert.equal(await readAwaiting().then(v => v.awaiting), false)
    assert.ok(await blockOf(f.projectId, okBody.workflowId))
    // ④ 预算解除 → 恢复待批投影
    await saveBudget({})
    assert.equal(await readAwaiting().then(v => v.awaiting), true)
    // ⑤ 段落失败：不伪装待承接（bridge 仍报 conflict 签名，卡不出现）
    await db.update(pipelineRuns).set({ status: 'failed', updatedAt: Date.now() }).where(eq(pipelineRuns.id, okBody.runId))
    assert.equal(await readAwaiting().then(v => v.awaiting), false)
    assert.ok(await blockOf(f.projectId, okBody.workflowId))
  })

  await t('8.4 旧 easy 分支零经过新批准逻辑：preflight 409 非 continuity；塞 continuityApproval 422 schema 拒绝', async () => {
    const { f } = await setupStory()
    const plan = {
      title: 'E计划', summary: 'E摘要', genre: 'story', duration: 30, aspectRatio: '9:16', language: 'zh-CN',
      mode: 'dynamic', style: 'E风格', script: 'E脚本内容。',
      lines: [ { id: 'l1', text: '第一句台词。' }, { id: 'l2', text: '第二句台词。' } ],
      shots: [
        { id: 's1', duration: 15, image_prompt: '画面一', motion_prompt: '运动一', lines: ['l1'] },
        { id: 's2', duration: 15, image_prompt: '画面二', motion_prompt: '运动二', lines: ['l2'] },
      ],
    }
    const [session] = await db.insert(creationSessions).values({ projectId: f.projectId, requestKey: `easy_probe_${randomUUID()}`,
      status: 'ready', plan: JSON.stringify(plan), planHash: 'a'.repeat(64), planRevision: 1,
      preflight: JSON.stringify({ ready: true, issues: [] }), createdAt: Date.now(), updatedAt: Date.now() }).returning()
    const runs0 = await runsBaseline(f.projectId)
    const base = { planRevision: 1, planHash: 'a'.repeat(64), idempotencyKey: 'easy_confirm_01', acceptUnpriced: true }
    const res = await post(confirmUrl(session!.id), base)
    assert.equal(res.status, 409)
    const code = ((await res.json()) as { error: { code: string } }).error.code
    assert.equal(typeof code, 'string')
    assert.ok(!code.startsWith('continuity'), `easy 预检失败码不得是连续性码：${code}`)
    assert.equal(await projectRuns(f.projectId), runs0)
    const packed = await post(confirmUrl(session!.id), { ...base, idempotencyKey: 'easy_confirm_02',
      continuityApproval: { contextId: 1, document: { assetId: 1, versionId: 1, hash: 'b'.repeat(64) }, approvalHash: 'c'.repeat(64) } })
    assert.equal(packed.status, 422)
    assert.equal(await projectRuns(f.projectId), runs0)
  })

  await t('8.3 未声明/batch 目标步：route 冻结 unsupported 400，不临时改 YAML 伪装批准', async () => {
    const { f, ef } = await setupStory()
    const runs0 = await runsBaseline(f.projectId)
    for (const key of ['m70-fixture-dup', 'm70-fixture-batchrole']) {
      const s = await makeRouteSession(f, templateDecision(`R${key}简报`, key))
      await assert.rejects(withContinuityIO(ef.io, () => previewContext(f.projectId,
        { target: routeTarget(s.sessionId, s.revision, s.decisionHash), includePlans: false })), codeOf(400, 'continuity_unsupported'))
    }
    assert.equal(await projectRuns(f.projectId), runs0)
    assert.equal(await projectContexts(f.projectId), 0)
  })

  } finally { engineGuard.restore() }
}
