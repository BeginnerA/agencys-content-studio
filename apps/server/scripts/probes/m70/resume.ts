/**
 * 探针：普通断点续跑与未知费用闸（resume 节）
 * - 真实端点 POST /runs/:id/resume 全程必测（helper 不替代端点旁路），9.1 五场景各自独立 fixture；
 * - inherit：源目标步已成功 / 崩溃（输出已持久、步骤未提交）→ 保留终态 + 消费证据继承 + 零模型调用
 *   + 旧 context 绑定不挪给新 run + continuity_inherit 元数据可跨代传递；
 * - rerun：目标步需重跑且无新包 → 409 continuity_gaps_unaccepted 零 queued run；携 resume 包批准
 *   → 新 run 落库且同事务认领台账（CAS）；源快照/输入漂移 → 409 continuity_context_changed；
 * - 未知费用闸：undecided（unknown/dispatching）消费遗留必须精确 consent（exact useId + 包内
 *   duplicateCostAcceptance + accept_possible_duplicate_cost），缺任一 → 409 continuity_outcome_unknown；
 * - 9.2 故障注入：bind 阶段 before_publish fault 与 claim CAS 输家 → 事务回滚，新 run/绑定均不残留；
 * - off：未启用源 run 语义原样（genTasks 迁移 + 字幕剥离 + 快照继承）；null 快照启用 run 阻断 400；
 * - ：off/inherit 决策携带批准 → 409 continuity_conflict 显式拒绝，绝不静默忽略。
 * 隔离：临时 SQLite（bootstrap 每次新建），fixtures 模板仅写临时目录；fetch 全程桩死；不启动媒体生成；
 * 节级 engine.startRun 桩（不真实执行任何 run）。canary 自愈沿用 route 节同款探针基建（仅探针侧）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Checker } from '../../probe-lib'
import type { ChatMessage } from '../../../src/services/llm'
import { ContinuityError, type Approval, type PreviewRequest, type TargetRequest, type UseDoc } from '../../../src/services/continuity/contract'
import { canonicalHash } from '../../../src/services/continuity/fold'
import { withContinuityIO } from '../../../src/services/continuity/runtime'
import { initDatabase } from './bootstrap'
import { confirmEpisode, extractAndReview, fakeIO, installTargetFixture, makeStepContext, seedResumeRun, seedStory } from './fixtures'
import { test } from './fold'

const empty = { content: JSON.stringify({ subjects: [], topics: [], items: [], warnings: [], noChanges: true }),
  usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 }, provider: 'fixture', model: 'fixture' }
const script = { content: '第一场：剧本正文。', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, provider: 'fixture', model: 'fixture' }

const msgs = (): ChatMessage[] => [
  { role: 'system', content: '你是剧本引擎。' },
  { role: 'user', content: '【剧情连续性台账】续写第三集' },
]
const out = { name: '第三集剧本.md', purpose: 'script', format: 'markdown' }

export async function runResume(checker: Checker) {
  installTargetFixture()
  await initDatabase()
  await runResumeBody(checker)
}

async function runResumeBody(checker: Checker) {
  // libsql 0.18 连接池快照自愈（与 route 节同款的探针基建，不涉产品代码；全量回归共用一池时防陈旧读）。
  // 表名用 resume 专属 `_m70_probe_canary_resume`：全量回归 10 节共用一库，route 节已对同名金丝雀表
  // 累积了自己的高位水位（counter 从 0 起步），复用同一表会让 `MAX(v)===v` 永假（假阳性自愈失败）。
  const { db: rawDb, sqlite } = await import('../../../src/db')
  const { sql } = await import('drizzle-orm')
  await rawDb.run(sql`CREATE TABLE IF NOT EXISTS _m70_probe_canary_resume (v integer NOT NULL)`)
  let canarySeq = 0
  const reopenPool = async () => { await (sqlite as unknown as { reconnect(): Promise<void> }).reconnect() }
  const healIfStale = async (tag: string): Promise<void> => {
    const probe = async (v: number): Promise<boolean> => {
      await rawDb.run(sql`INSERT INTO _m70_probe_canary_resume (v) VALUES (${v})`)
      const row = await rawDb.get(sql`SELECT MAX(v) AS m FROM _m70_probe_canary_resume`) as { m?: number } | undefined
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
  const { and, desc, eq } = await import('drizzle-orm')
  const { assets, contentContinuityRecords: records, genTasks, pipelineRuns, pipelineSteps } = await import('../../../src/db/schema')
  const { previewContext, freezeContext, readContext } = await import('../../../src/services/continuity/context')
  const { documentTransaction, writeDocument } = await import('../../../src/services/continuity/store')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { prepareRunInput } = await import('../../../src/services/run-create')
  const { aiText } = await import('../../../src/pipeline/actions/ai-text')
  const { engine } = await import('../../../src/pipeline/engine')
  const { RUN_LOGS_DIR } = await import('../../../src/env')
  const { Hono } = await import('hono')
  const { runsRoutes } = await import('../../../src/routes/runs')
  // 服务：缺失即真实 RED（动态导入失败逐测试记录，不让整节崩溃）。
  const resumeService = () => import('../../../src/services/continuity/resume')

  mkdirSync(RUN_LOGS_DIR, { recursive: true })
  type Story = Awaited<ReturnType<typeof seedStory>>
  const codeOf = (status: number, name?: string) => (e: unknown) =>
    e instanceof ContinuityError && e.status === status && (!name || e.code === name)
  const hash64 = 'a'.repeat(64)

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
  app.route('/api/v1', runsRoutes)
  const resumeUrl = (runId: number) => `/api/v1/runs/${runId}/resume`
  const post = async (path: string, body: unknown): Promise<Response> => {
    const res = await app.request(path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    await healIfStale('post ' + path)
    return res
  }
  const errCode = async (res: Response): Promise<string> =>
    ((await res.json()) as { error?: { code?: string } }).error?.code ?? ''
  const get = async (path: string): Promise<Response> => {
    const res = await app.request(path)
    await healIfStale('get ' + path)
    return res
  }
  /** 运行详情内的续跑预检（与 POST resume 同源决策）：前端只认这个面，不自行推断。 */
  const preflightOf = async (runId: number) =>
    ((await (await get(`/api/v1/runs/${runId}`)).json()) as {
      continuityResume?: { kind: string; originalRunId?: number; originalStepId?: number
        useId?: number; unknownUseId?: number | null; code?: string }
    }).continuityResume

  const countRuns = async (projectId: number) =>
    (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId))).length
  const runById = async (id: number) => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)))[0]!
  const stepOf = async (runId: number, stepKey: string) => (await db.select().from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, stepKey))).orderBy(desc(pipelineSteps.id)).limit(1))[0]!
  const contextRow = async (contextId: number) => (await db.select().from(records).where(eq(records.id, contextId)))[0]!
  const runInput = (run: { input: string }) => JSON.parse(run.input) as Record<string, unknown>
  const stepOutput = (output: string | null) => JSON.parse(output ?? '{}') as Record<string, unknown>

  const setupStory = async () => {
    const f = await seedStory(), ef = fakeIO(empty)
    await withContinuityIO(ef.io, async () => {
      for (let i = 0; i < 2; i++) await confirmEpisode(f, i, ef.io)
    })
    return { f, ef }
  }

  /** 真实 freeze 链冻结「断点续跑目标包」：materializeTarget resume 支路读源 run 快照重导出。 */
  const freezeResumePack = async (f: Story, ef: ReturnType<typeof fakeIO>, srcRunId: number,
      opts: { consentUseId?: number } = {}): Promise<Approval> => {
    const target: TargetRequest = { kind: 'resume', runId: srcRunId }
    const req: PreviewRequest = { target, includePlans: false }
    const p = await withContinuityIO(ef.io, () => previewContext(f.projectId, req))
    assert.deepEqual(p.blockers, [])
    return withContinuityIO(ef.io, () => freezeContext(f.projectId, { target, includePlans: false,
      previewHash: p.doc.previewHash,
      acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID(),
      ...(opts.consentUseId !== undefined
        ? { duplicateCostAcceptance: { useId: opts.consentUseId, accepted: true as const } } : {}) }))
  }

  /** 手工建非启用/启用源 run（seedResumeRun）+ 真实目标步行行，可选 gen_tasks 行（迁移语义探针用）。 */
  const seedSourceWithStep = async (f: Story, input: Record<string, unknown>,
      opts: { snapshot?: boolean; tasks?: boolean } = {}): Promise<{ runId: number; stepId: number }> => {
    const runId = await seedResumeRun(f, 3, input, { snapshot: opts.snapshot })
    const tpl = loadTemplate('m70-fixture-episode')
    const def = tpl.steps[0]!
    const [step] = await db.insert(pipelineSteps).values({ runId, seq: 1, stepKey: def.key, actionKey: def.action,
      title: def.title, status: 'failed', attempts: 1, createdAt: 1, updatedAt: 1 }).returning()
    if (opts.tasks) {
      await db.insert(genTasks).values([
        { projectId: f.projectId, runId, stepId: step!.id, kind: 'text', params: '{}', status: 'pending',
          attempts: 2, errorMsg: '断点前失败', createdAt: 1, updatedAt: 1 },
        { projectId: f.projectId, runId, stepId: step!.id, kind: 'text', params: '{}', status: 'succeeded',
          attempts: 1, createdAt: 1, updatedAt: 1 },
      ])
    }
    return { runId, stepId: step!.id }
  }

  /** 9.1①/⑤ fixture：manual 包 → createRunRow → 真实 aiText 持久 completed 消费 + 输出资产，
   * 步骤状态按场景（succeeded=引擎完成态 / running=崩溃态「输出已持久、步骤未提交」），run 置 failed。 */
  const seedDerivedRunWithUse = async (f: Story, ef: ReturnType<typeof fakeIO>, brief: string,
      stepStatus: 'succeeded' | 'running'): Promise<{ runId: number; stepId: number; assetId: number; approval: Approval }> => {
    const tpl = loadTemplate('m70-fixture-episode')
    const norm = prepareRunInput(tpl, { brief, episode_number: 3, with_continuity: true })
    const req: PreviewRequest = { target: { kind: 'manual', episodeId: f.episodes[2]!, templateKey: 'm70-fixture-episode',
      input: norm as Extract<TargetRequest, { kind: 'manual' }>['input'] }, includePlans: false }
    const p = await withContinuityIO(ef.io, () => previewContext(f.projectId, req))
    assert.deepEqual(p.blockers, [])
    const approval = await withContinuityIO(ef.io, () => freezeContext(f.projectId, { target: req.target, includePlans: false,
      previewHash: p.doc.previewHash, acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID() }))
    const ctx = await makeStepContext(f, approval)
    const fake = fakeIO(script)
    const result = await withContinuityIO(fake.io, () => aiText(ctx))
    assert.equal(result.assetIds.length, 1)
    if (stepStatus === 'succeeded') {
      await db.update(pipelineSteps).set({ status: 'succeeded', completedAt: 1,
        output: JSON.stringify({ asset_ids: result.assetIds, gate: { decision: 'approve', at: 1 } }) })
        .where(eq(pipelineSteps.id, ctx.step.id))
    }
    await db.update(pipelineRuns).set({ status: 'failed', updatedAt: Date.now() }).where(eq(pipelineRuns.id, ctx.run.id))
    return { runId: ctx.run.id, stepId: ctx.step.id, assetId: result.assetIds[0]!, approval }
  }

  /** undecided 消费遗留（unknown/dispatching）：真实 UseDoc + 台账行，挂在源 run 的目标步上。 */
  const seedUndecidedUse = async (f: Story, runId: number, stepId: number, state: 'unknown' | 'dispatching'): Promise<number> => {
    const { resolveUnit } = await import('../../../src/services/continuity/scope')
    const unit = await resolveUnit(f.projectId, f.episodes[2]!, db)
    const base = { schemaVersion: 1 as const, context: { assetId: 1, versionId: 1, hash: hash64 }, entries: [],
      runId, stepId, round: 'initial', messages: msgs(), messagesHash: canonicalHash(msgs()),
      provider: 'fixture', model: 'fixture', configHash: hash64, sourceChangedAfterDispatch: false as const }
    const useDoc: UseDoc = state === 'dispatching'
      ? { ...base, state, submitted: null, billing: 'unknown', startedAt: 1, completedAt: null, output: null,
          usage: null, errorCode: null }
      : { ...base, state, submitted: true, billing: 'unknown', startedAt: 1, completedAt: null, output: null,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, errorCode: 'continuity_outcome_unknown' }
    let rowId = 0
    await documentTransaction(async ex => {
      const ref = await writeDocument(ex, unit, 'consumption', useDoc)
      const [row] = await ex.insert(records).values({ ...unit, rowType: 'consumption', status: state, runId, stepId,
        operationKey: randomUUID(), requestHash: hash64, documentAssetId: ref.assetId, documentVersionId: ref.versionId,
        documentHash: ref.hash, createdAt: 1, updatedAt: 1 }).returning()
      rowId = row!.id
    })
    return rowId
  }

  try {
  await t('9.0 服务契约：prepareContinuityResume 对缺失源 run 抛 404 continuity_source_invalid', async () => {
    const { prepareContinuityResume } = await resumeService()
    await assert.rejects(withContinuityIO(fakeIO(script).io, () =>
      db.transaction(tx => prepareContinuityResume(tx, 9_999_999, {}))), codeOf(404, 'continuity_source_invalid'))
  })

  await t('9.1① inherit：源目标步已成功 → 新 run 保留终态+证据继承+零模型调用，旧绑定不挪', async () => {
    const { f, ef } = await setupStory()
    const src = await seedDerivedRunWithUse(f, ef, '第三集续跑源简报', 'succeeded')
    // 详情预检与端点同源：目标步已成功且有持久证据 → inherit（前端不得误判 rerun 而携批准）。
    const pre = await preflightOf(src.runId)
    assert.equal(pre?.kind, 'inherit')
    assert.equal(pre?.originalRunId, src.runId)
    assert.equal(pre?.originalStepId, src.stepId)
    assert.equal(typeof pre?.useId, 'number')
    const callsBefore = ef.calls()
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    const res = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), {}))
    assert.equal(res.status, 202)
    const body = await res.json() as { run: { id: number; resumedFromRunId: number | null; templateSnapshot: string | null } }
    const fresh = await runById(body.run.id)
    assert.equal(fresh.resumedFromRunId, src.runId)
    assert.equal(fresh.status, 'queued')
    // 继承不重新执行目标步：终态保留 + 持久产物复用 + 元数据指向实际产生的原 run/step
    const step = await stepOf(fresh.id, 'write_script')
    assert.equal(step.status, 'succeeded')
    const output = stepOutput(step.output)
    assert.deepEqual(output['asset_ids'], [src.assetId])
    const meta = output['continuity_inherit'] as Record<string, unknown> | undefined
    assert.ok(meta, '目标步必须带 continuity_inherit 元数据')
    assert.equal(meta['originalRunId'], src.runId)
    assert.equal(meta['originalStepId'], src.stepId)
    assert.equal(typeof meta['useId'], 'number')
    // 输入槽位原样保留旧包资产；with_continuity 不被静默关闭
    const input = runInput(fresh)
    assert.deepEqual(input['continuity_context'], [src.approval.document.assetId])
    assert.equal(input['with_continuity'], true)
    assert.equal(fresh.templateSnapshot, (await runById(src.runId)).templateSnapshot)
    // 零模型调用（fake.calls 不变）
    assert.equal(ef.calls(), callsBefore)
    // 旧 context 绑定绝不挪给新 run：台账行仍绑定源 run
    const row = await contextRow(src.approval.contextId)
    assert.equal(row.status, 'bound')
    assert.equal(row.runId, src.runId)
    // 本 run 未新增 context 行，也无重复消费行
    assert.equal((await db.select().from(records).where(and(eq(records.runId, fresh.id), eq(records.rowType, 'context')))).length, 0)
    assert.equal(await countRuns(f.projectId), runsBefore + 1)
    assert.deepEqual(engineGuard.calls, [fresh.id])
    // 跨代传递：对派生 run 再续跑 → 继承仍成立且 useId 逐字传递（定位到实际产生的原 run/step）
    await db.update(pipelineRuns).set({ status: 'failed', updatedAt: Date.now() }).where(eq(pipelineRuns.id, fresh.id))
    resetEngineCalls()
    const again = await withContinuityIO(ef.io, () => post(resumeUrl(fresh.id), {}))
    assert.equal(again.status, 202)
    const againBody = await again.json() as { run: { id: number } }
    const step2 = await stepOf(againBody.run.id, 'write_script')
    assert.equal(step2.status, 'succeeded')
    const inherited = stepOutput(step2.output)['continuity_inherit'] as Record<string, unknown>
    assert.equal(inherited['originalRunId'], src.runId)
    assert.equal(inherited['originalStepId'], src.stepId)
    assert.equal(inherited['useId'], (output['continuity_inherit'] as Record<string, unknown>)['useId'])
    assert.equal(ef.calls(), callsBefore)
    assert.deepEqual(engineGuard.calls, [againBody.run.id])
  })

  await t('9.1⑤ 输出已持久、步骤未提交（崩溃态）：completed 消费优先复用，零模型调用', async () => {
    const { f, ef } = await setupStory()
    const src = await seedDerivedRunWithUse(f, ef, '第三集崩溃源简报', 'running')
    const callsBefore = ef.calls()
    resetEngineCalls()
    const res = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), {}))
    assert.equal(res.status, 202)
    const body = await res.json() as { run: { id: number } }
    const step = await stepOf(body.run.id, 'write_script')
    assert.equal(step.status, 'succeeded')
    assert.deepEqual(stepOutput(step.output)['asset_ids'], [src.assetId])
    assert.ok(stepOutput(step.output)['continuity_inherit'])
    assert.equal(ef.calls(), callsBefore)
    const [asset] = await db.select().from(assets).where(eq(assets.id, src.assetId))
    assert.equal(asset!.runId, src.runId)
    assert.equal(engineGuard.calls.length, 1)
  })

  await t('9.1② rerun 需重跑且无新包：409 continuity_gaps_unaccepted，零 queued run 零台账', async () => {
    const { f, ef } = await setupStory()
    const src = await seedSourceWithStep(f, { brief: '第三集重跑源', episode_number: 3, with_continuity: true })
    const callsBefore = ef.calls()
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    const contextsBefore = (await db.select({ id: records.id }).from(records).where(eq(records.projectId, f.projectId))).length
    // 预检只读：rerun + 无未知遗留，不改任何行（前端据此先冻 resume 包）。
    const pre = await preflightOf(src.runId)
    assert.deepEqual(pre, { kind: 'rerun', unknownUseId: null })
    assert.equal(await countRuns(f.projectId), runsBefore)
    assert.equal((await db.select({ id: records.id }).from(records).where(eq(records.projectId, f.projectId))).length, contextsBefore)
    const res = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), {}))
    assert.equal(res.status, 409)
    assert.equal(await errCode(res), 'continuity_gaps_unaccepted')
    assert.equal(await countRuns(f.projectId), runsBefore)
    assert.equal((await db.select({ id: records.id }).from(records).where(eq(records.projectId, f.projectId))).length, contextsBefore)
    assert.equal(engineGuard.calls.length, 0)
    assert.equal(ef.calls(), callsBefore)
  })

  await t('9.1③ 携 resume 包批准：rerun 新 run 落库 + 同事务认领台账 + 重复续跑 409 already_resumed', async () => {
    const { f, ef } = await setupStory()
    const src = await seedSourceWithStep(f, { brief: '第三集重跑源B', episode_number: 3, with_continuity: true })
    const approval = await freezeResumePack(f, ef, src.runId)
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    const res = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), { continuity_approval: approval }))
    assert.equal(res.status, 202)
    const body = await res.json() as { run: { id: number } }
    const fresh = await runById(body.run.id)
    assert.equal(fresh.resumedFromRunId, src.runId)
    assert.equal(fresh.status, 'queued')
    const input = runInput(fresh)
    assert.deepEqual(input['continuity_context'], [approval.document.assetId])
    assert.equal(input['with_continuity'], true)
    // 新 run 目标步 pending（将重新执行，走 continuity llm 链）
    const step = await stepOf(fresh.id, 'write_script')
    assert.equal(step.status, 'pending')
    // 同事务认领：台账行 bound 且指向新 run
    const row = await contextRow(approval.contextId)
    assert.equal(row.status, 'bound')
    assert.equal(row.runId, fresh.id)
    assert.equal(await countRuns(f.projectId), runsBefore + 1)
    assert.deepEqual(engineGuard.calls, [fresh.id])
    // 审计 G2 去重原样：同源已有进行中派生 run → 409 already_resumed
    const dup = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), { continuity_approval: approval }))
    assert.equal(dup.status, 409)
    assert.equal(await errCode(dup), 'already_resumed')
  })

  await t('9.1④ undecided 消费未同意：409 continuity_outcome_unknown 零 run；exact useId 矩阵', async () => {
    const { f, ef } = await setupStory()
    const src = await seedSourceWithStep(f, { brief: '第三集未知源', episode_number: 3, with_continuity: true })
    const unknownId = await seedUndecidedUse(f, src.runId, src.stepId, 'unknown')
    const approval = await freezeResumePack(f, ef, src.runId, { consentUseId: unknownId })
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    // ① 未携同意（连批准也没有）
    const bare = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), {}))
    assert.equal(bare.status, 409)
    assert.equal(await errCode(bare), 'continuity_outcome_unknown')
    // ② 携批准但缺 accept_possible_duplicate_cost（bool=true 不得一次性放行全部未知）
    const noFlag = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), { continuity_approval: approval }))
    assert.equal(noFlag.status, 409)
    assert.equal(await errCode(noFlag), 'continuity_outcome_unknown')
    // ③ 旗标开但 useId 不精确（指向他行）
    const wrongId = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId),
      { continuity_approval: approval, unknown_use_id: unknownId + 10_000, accept_possible_duplicate_cost: true }))
    assert.equal(wrongId.status, 409)
    assert.equal(await errCode(wrongId), 'continuity_outcome_unknown')
    // ④ 三要素齐（exact useId + 包内 consent + 显式旗标）→ 放行
    const ok = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId),
      { continuity_approval: approval, unknown_use_id: unknownId, accept_possible_duplicate_cost: true }))
    assert.equal(ok.status, 202)
    const okBody = await ok.json() as { run: { id: number } }
    const row = await contextRow(approval.contextId)
    assert.equal(row.status, 'bound')
    assert.equal(row.runId, okBody.run.id)
    assert.equal(await countRuns(f.projectId), runsBefore + 1)
  })

  await t('9.1④b dispatching 遗留：预检暴露 exact useId；缺同意冻结被拒，精确同意后放行', async () => {
    const { f, ef } = await setupStory()
    const src = await seedSourceWithStep(f, { brief: '第三集在途源', episode_number: 3, with_continuity: true })
    const dispatchingId = await seedUndecidedUse(f, src.runId, src.stepId, 'dispatching')
    // 预检与确认面必须给得出同一个 useId，否则「闸要求同意、确认面无从给出」是死路。
    assert.deepEqual(await preflightOf(src.runId), { kind: 'rerun', unknownUseId: dispatchingId })
    const noConsent = await withContinuityIO(ef.io, async () => {
      try { await freezeResumePack(f, ef, src.runId); return null } catch (e) { return e }
    })
    assert.ok(codeOf(409, 'continuity_outcome_unknown')(noConsent))
    const approval = await freezeResumePack(f, ef, src.runId, { consentUseId: dispatchingId })
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    const res = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId),
      { continuity_approval: approval, unknown_use_id: dispatchingId, accept_possible_duplicate_cost: true }))
    assert.equal(res.status, 202)
    assert.equal(await countRuns(f.projectId), runsBefore + 1)
    assert.equal(engineGuard.calls.length, 1)
  })

  await t('9.2 故障注入：bind 阶段 before_publish 抛错 → 事务回滚，新 run/绑定均不残留；重试可恢复', async () => {
    const { f, ef } = await setupStory()
    const src = await seedSourceWithStep(f, { brief: '第三集故障源', episode_number: 3, with_continuity: true })
    const approval = await freezeResumePack(f, ef, src.runId)
    const faultFake = fakeIO(script)
    faultFake.io.fault = point => { if (point === 'before_publish') throw new Error('注入故障') }
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    const res = await withContinuityIO(faultFake.io, () => post(resumeUrl(src.runId), { continuity_approval: approval }))
    // 注入的非领域错误经路由层既有约定映射（非 202 即失败路径）；回滚完整性才是本测核心。
    assert.notEqual(res.status, 202)
    // 新 run 与绑定均不残留：零孤儿 run；台账退回 frozen 且未指向任何 run
    assert.equal(await countRuns(f.projectId), runsBefore)
    const row = await contextRow(approval.contextId)
    assert.equal(row.status, 'frozen')
    assert.equal(row.runId, null)
    assert.equal(engineGuard.calls.length, 0)
    // 清除故障后重试成功（自愈路径）
    const retry = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), { continuity_approval: approval }))
    assert.equal(retry.status, 202)
    const retryBody = await retry.json() as { run: { id: number } }
    assert.equal((await contextRow(approval.contextId)).runId, retryBody.run.id)
  })

  await t('9.2 claim CAS 输家：包已绑定他 run → 409 continuity_context_claimed 回滚零孤儿', async () => {
    const { f, ef } = await setupStory()
    const { claimContext } = await import('../../../src/services/continuity/run-binding')
    const src = await seedSourceWithStep(f, { brief: '第三集竞争源', episode_number: 3, with_continuity: true })
    const approval = await freezeResumePack(f, ef, src.runId)
    const [dummy] = await db.insert(pipelineRuns).values({ projectId: f.projectId, templateKey: 'm70-fixture-episode',
      status: 'queued', input: '{}', createdAt: 1, updatedAt: 1 }).returning()
    await withContinuityIO(ef.io, () => claimContext(db, approval, dummy!))
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    const res = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), { continuity_approval: approval }))
    assert.equal(res.status, 409)
    assert.equal(await errCode(res), 'continuity_context_claimed')
    assert.equal(await countRuns(f.projectId), runsBefore)
    assert.equal((await contextRow(approval.contextId)).runId, dummy!.id)
    assert.equal(engineGuard.calls.length, 0)
  })

  await t('9.3 过期源：冻结后输入/快照漂移 → 409 continuity_context_changed 零 run', async () => {
    const { f, ef } = await setupStory()
    // ① 输入漂移（brief 被改）
    const a = await seedSourceWithStep(f, { brief: '第三集漂移源', episode_number: 3, with_continuity: true })
    const approvalA = await freezeResumePack(f, ef, a.runId)
    await db.update(pipelineRuns).set({ input: JSON.stringify({ brief: '被篡改的简报', episode_number: 3, with_continuity: true }),
      updatedAt: Date.now() }).where(eq(pipelineRuns.id, a.runId))
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    const resA = await withContinuityIO(ef.io, () => post(resumeUrl(a.runId), { continuity_approval: approvalA }))
    assert.equal(resA.status, 409)
    assert.equal(await errCode(resA), 'continuity_context_changed')
    // ② 快照漂移（同 key 不同内容：version 被改）
    const b = await seedSourceWithStep(f, { brief: '第三集快照漂移源', episode_number: 3, with_continuity: true })
    const approvalB = await freezeResumePack(f, ef, b.runId)
    const runsBeforeB = await countRuns(f.projectId)
    const srcRow = await runById(b.runId)
    const tampered = { ...JSON.parse(srcRow.templateSnapshot!), version: 99 }
    await db.update(pipelineRuns).set({ templateSnapshot: JSON.stringify(tampered), updatedAt: Date.now() }).where(eq(pipelineRuns.id, b.runId))
    const resB = await withContinuityIO(ef.io, () => post(resumeUrl(b.runId), { continuity_approval: approvalB }))
    assert.equal(resB.status, 409)
    assert.equal(await errCode(resB), 'continuity_context_changed')
    assert.equal(await countRuns(f.projectId), runsBeforeB)
    assert.equal(engineGuard.calls.length, 0)
  })

  await t('Minor⑤ off/inherit 决策携批准：409 continuity_conflict 显式拒绝，不静默忽略', async () => {
    const { f, ef } = await setupStory()
    // ① off：未启用源 run 携批准 → 显式冲突（绝不静默丢键当关闭）
    const legacy = await seedSourceWithStep(f, { brief: '第三集关闭源', episode_number: 3 })
    const approval = await freezeResumePack(f, ef, legacy.runId)
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    const res = await withContinuityIO(ef.io, () => post(resumeUrl(legacy.runId), { continuity_approval: approval }))
    assert.equal(res.status, 409)
    assert.equal(await errCode(res), 'continuity_conflict')
    assert.equal(await countRuns(f.projectId), runsBefore)
    // ② inherit：源目标步已成功仍携批准 → 显式冲突（继承不需要包，携带即调用方误判）
    const src = await seedDerivedRunWithUse(f, ef, '第三集继承携包源', 'succeeded')
    const pack = await freezeResumePack(f, ef, src.runId)
    resetEngineCalls()
    const res2 = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), { continuity_approval: pack }))
    assert.equal(res2.status, 409)
    assert.equal(await errCode(res2), 'continuity_conflict')
    assert.equal(engineGuard.calls.length, 0)
  })

  await t('9.4 off 路径零漂移：未启用源 run 续跑语义原样（genTasks 迁移 + 字幕剥离 + 快照继承）', async () => {
    const { f, ef } = await setupStory()
    const src = await seedSourceWithStep(f, { brief: '第三集普通源', episode_number: 3, _subtitleEdits: { baseline: '旧指针' } },
      { tasks: true })
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    assert.deepEqual(await preflightOf(src.runId), { kind: 'off' })
    const res = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), {}))
    assert.equal(res.status, 202)
    const body = await res.json() as { run: { id: number } }
    const fresh = await runById(body.run.id)
    // 原字段保留 + 字幕剥离：新 run 不带 _subtitleEdits，也无连续性键
    const input = runInput(fresh)
    assert.equal(input['brief'], '第三集普通源')
    assert.equal(input['_subtitleEdits'], undefined)
    assert.equal(input['with_continuity'], undefined)
    assert.equal(input['continuity_context'], undefined)
    assert.equal(fresh.templateSnapshot, (await runById(src.runId)).templateSnapshot)
    // 步骤复制与 genTasks 迁移口径原样：failed 步重置续跑
    const step = await stepOf(fresh.id, 'write_script')
    assert.equal(step.status, 'pending')
    assert.equal(step.input, null)
    assert.equal(step.attempts, 0)
    const tasks = await db.select().from(genTasks).where(eq(genTasks.runId, fresh.id))
    assert.equal(tasks.length, 2)
    const pendingTask = tasks.find(x => x.status === 'pending')!
    assert.ok(pendingTask)
    assert.equal(pendingTask.stepId, step.id)
    assert.equal(pendingTask.attempts, 0)
    assert.equal(pendingTask.errorMsg, null)
    const succeededTask = tasks.find(x => x.status === 'succeeded')!
    assert.ok(succeededTask)
    assert.equal(succeededTask.stepId, step.id)
    assert.equal((await db.select().from(records).where(eq(records.runId, fresh.id))).length, 0)
    assert.equal(await countRuns(f.projectId), runsBefore + 1)
    assert.deepEqual(engineGuard.calls, [fresh.id])
  })

  await t('9.4 快照边界：null 快照未启用 run 直接 off 续跑；启用 run 缺快照阻断 400 unsupported', async () => {
    const { f, ef } = await setupStory()
    // ① null 快照 + 未启用：非连续性语义原样放行
    const legacy = await seedSourceWithStep(f, { brief: '第三集遗留源', episode_number: 3 }, { snapshot: false })
    resetEngineCalls()
    const res = await withContinuityIO(ef.io, () => post(resumeUrl(legacy.runId), {}))
    assert.equal(res.status, 202)
    const legacyBody = await res.json() as { run: { id: number } }
    assert.equal((await runById(legacyBody.run.id)).templateSnapshot, null)
    assert.equal(engineGuard.calls.length, 1)
    // ② 启用但快照缺失：阻断（不许静默换最新模板或当关闭放行）
    const broken = await seedSourceWithStep(f, { brief: '第三集缺快照源', episode_number: 3, with_continuity: true },
      { snapshot: false })
    resetEngineCalls()
    const runsBefore = await countRuns(f.projectId)
    const res2 = await withContinuityIO(ef.io, () => post(resumeUrl(broken.runId), {}))
    assert.equal(res2.status, 400)
    assert.equal(await errCode(res2), 'continuity_unsupported')
    assert.equal(await countRuns(f.projectId), runsBefore)
    assert.equal(engineGuard.calls.length, 0)
  })

  await t('9.4 inherit 决策元数据可经 readContext 链路回读：useId 指向真实 completed 消费行', async () => {
    const { f, ef } = await setupStory()
    const src = await seedDerivedRunWithUse(f, ef, '第三集证据源', 'succeeded')
    resetEngineCalls()
    const res = await withContinuityIO(ef.io, () => post(resumeUrl(src.runId), {}))
    assert.equal(res.status, 202)
    const body = await res.json() as { run: { id: number } }
    const step = await stepOf(body.run.id, 'write_script')
    const meta = stepOutput(step.output)['continuity_inherit'] as { originalRunId: number; originalStepId: number; useId: number }
    const [useRow] = await db.select().from(records).where(eq(records.id, meta.useId))
    assert.equal(useRow!.rowType, 'consumption')
    assert.equal(useRow!.status, 'completed')
    assert.equal(useRow!.runId, meta.originalRunId)
    assert.equal(useRow!.stepId, meta.originalStepId)
    const doc = await readContext(f.projectId, src.approval, db)
    assert.equal(doc.target.request.kind, 'manual')
  })

  await t('引文漂移：源文本删引后零模型复核阻断，不可变版本与当前文件哈希不一致即拒绝', async () => {
    const { f, ef } = await setupStory()
    const { reviewEntry } = await import('../../../src/services/continuity/entries')
    // 建第三集带引文草稿（extractAndReview = 提取 + 人工编辑，产出含 evidence 的 draft）
    const draft = await withContinuityIO(ef.io, () => extractAndReview(f, 2, ef.io))
    assert.equal(draft.status, 'draft')
    assert.ok(draft.doc!.items.some(i => i.evidence.length > 0), '草稿须含引文证据')
    // 定位源资产物理文件并删除一段引文对应文本（模拟「删除原引文」）
    const { absPathOf } = await import('../../../src/services/storage')
    const [asset] = await db.select().from(assets).where(eq(assets.id, f.sources[2]!.assetId))
    const filePath = absPathOf(asset!.relPath!)
    const originalText = readFileSync(filePath, 'utf8')
    const deletedQuote = draft.doc!.items.find(i => i.evidence.length > 0)!.evidence[0]!.quote
    const modifiedText = originalText.replace(deletedQuote, '')
    assert.notEqual(modifiedText, originalText, '引文须出现在源文本中')
    writeFileSync(filePath, modifiedText, 'utf8')
    // 零模型复核：readContinuityVersion 检测不可变版本哈希与当前文件哈希不一致 → 409
    await assert.rejects(
      withContinuityIO(ef.io, () => reviewEntry(f.projectId, f.episodes[2]!,
        { parentId: draft.id, source: f.sources[2]!, operationKey: randomUUID() })),
      (e: unknown) => e instanceof ContinuityError && e.status === 409
        && e.code === 'continuity_source_changed'
    )
    // 路由层：ContinuityError 保真映射，错误信封 code = continuity_source_changed
    const { Hono: HonoClass } = await import('hono')
    const { createContinuityRoutes } = await import('../../../src/routes/continuity')
    const app2 = new (HonoClass as typeof import('hono').Hono)()
    app2.route('/api/v1', createContinuityRoutes(ef.io))
    const res = await app2.request(
      `/api/v1/projects/${f.projectId}/episodes/${f.episodes[2]}/continuity/review`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentId: draft.id, source: f.sources[2]!, operationKey: randomUUID() }) })
    assert.equal(res.status, 409)
    const body = await res.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'continuity_source_changed')
    assert.equal(typeof body.error.message, 'string')
  })

  } finally { engineGuard.restore() }
}
