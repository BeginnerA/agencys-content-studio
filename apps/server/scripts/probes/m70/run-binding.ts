import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { Checker } from '../../probe-lib'
import type { StepContext } from '../../../src/pipeline/context'
import { ContinuityError, type Approval, type PreviewRequest, type TargetRequest } from '../../../src/services/continuity/contract'
import { withContinuityIO } from '../../../src/services/continuity/runtime'
import { initDatabase } from './bootstrap'
import { confirmEpisode, fakeIO, installTargetFixture, makeStepContext, seedStory } from './fixtures'
import { test } from './fold'

const empty = { content: JSON.stringify({ subjects: [], topics: [], items: [], warnings: [], noChanges: true }),
  usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 }, provider: 'fixture', model: 'fixture' }
const script = { content: '第一场：剧本正文。', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, provider: 'fixture', model: 'fixture' }

export async function runRunBinding(checker: Checker) {
  installTargetFixture()
  await initDatabase()
  await runRunBindingBody(checker)
}

async function runRunBindingBody(checker: Checker) {
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { and, eq } = await import('drizzle-orm')
  const { apiConfigs, batches, contentContinuityRecords: records, execInputs, execSnapshots, pipelineRuns, pipelineSteps, usageRecords } = await import('../../../src/db/schema')
  const { assets } = await import('../../../src/db/schema')
  const { previewContext, freezeContext } = await import('../../../src/services/continuity/context')
  const { createRunRow, InvalidRunInputError, prepareRunInput } = await import('../../../src/services/run-create')
  const { loadTemplate, validateTemplateText } = await import('../../../src/pipeline/loader')
  const { writeTextAsset } = await import('../../../src/services/storage')
  const { assertProjectAssets } = await import('../../../src/pipeline/refs')
  const { RefResolveError } = await import('../../../src/pipeline/types')
  const { resolveRunPrefill } = await import('../../../src/services/run-prefill')
  const { aiText } = await import('../../../src/pipeline/actions/ai-text')
  const { createStepContext } = await import('../../../src/pipeline/context')
  const { engine } = await import('../../../src/pipeline/engine')
  const { RUN_LOGS_DIR } = await import('../../../src/env')
  const { Hono } = await import('hono')
  const { runsRoutes } = await import('../../../src/routes/runs')
  const { batchesRoutes } = await import('../../../src/routes/batches')
  // 服务：缺失即真实 RED（逐测试失败，不让整节崩溃）。
  const binding = () => import('../../../src/services/continuity/run-binding')
  const templateErrors = () => import('../../validate-templates')

  mkdirSync(RUN_LOGS_DIR, { recursive: true })
  type Story = Awaited<ReturnType<typeof seedStory>>
  const badInput = (e: unknown) => e instanceof InvalidRunInputError && e.code === 'bad_input'
  const codeOf = (status: number, name?: string) => (e: unknown) =>
    e instanceof ContinuityError && e.status === status && (!name || e.code === name)

  const countRuns = async (projectId: number) =>
    (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId))).length
  const contextRow = async (contextId: number) => {
    const [row] = await db.select().from(records).where(eq(records.id, contextId))
    return row!
  }
  const patchStartRun = (): { calls: number[]; restore: () => void } => {
    const calls: number[] = []
    const original = engine.startRun.bind(engine)
    ;(engine as unknown as { startRun: unknown }).startRun = (id: number): string => { calls.push(id); return 'started' }
    return { calls, restore: () => { delete (engine as unknown as { startRun?: unknown }).startRun; void original } }
  }
  /** 普通路径 LLM 桩：api_configs 实例 + fetch 只放行 /chat/completions（与 bootstrap 全阻断桩衔接）。 */
  const stubLlmFetch = async () => {
    await db.insert(apiConfigs).values({ name: 'probe', serviceType: 'llm', providerKey: 'probe', baseUrl: 'https://llm-probe.invalid/v1',
      apiKeyRef: 'env:M70_PROBE_LLM_KEY', model: 'probe-model', priority: 0, isDefault: 1, isActive: 1, createdAt: 1, updatedAt: 1 })
    process.env.M70_PROBE_LLM_KEY = 'probe-key'
    const bodies: Array<Record<string, unknown>> = []
    const previous = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes('/chat/completions')) throw new Error(`M70 run-binding 探针禁止外部请求：${String(url)}`)
      bodies.push(init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {})
      return new Response(JSON.stringify({ choices: [{ message: { content: '普通路径产物文本。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { bodies, restore: () => { globalThis.fetch = previous } }
  }
  const mkApp = async () => {
    const app = new (Hono as typeof import('hono').Hono)()
    app.route('/api/v1', runsRoutes)
    app.route('/api/v1', batchesRoutes)
    return app
  }
  const post = async (app: import('hono').Hono, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  /** 确认前两集并分别冻结 mengbao / fixture 目标包（第三集）。冻结输入 = prepareRunInput 归一化结果，
   * 与 createRunRow 的 claim 侧 effectiveInput(norm) 哈希口径一致。 */
  const setupStory = async () => {
    const f = await seedStory(), ef = fakeIO(empty)
    await withContinuityIO(ef.io, async () => {
      for (let i = 0; i < 2; i++) await confirmEpisode(f, i, ef.io)
    })
    return { f, ef }
  }
  const freezePack = async (f: Story, ef: ReturnType<typeof fakeIO>, templateKey: 'mengbao-episode' | 'm70-fixture-episode' | 'm70-fixture-mixed',
    brief: string): Promise<Approval> => {
    const tpl = loadTemplate(templateKey)
    const norm = prepareRunInput(tpl, { brief, episode_number: 3, with_continuity: true })
    const req: PreviewRequest = { target: { kind: 'manual', episodeId: f.episodes[2]!, templateKey,
      input: norm as Extract<TargetRequest, { kind: 'manual' }>['input'] }, includePlans: false }
    const p = await withContinuityIO(ef.io, () => previewContext(f.projectId, req))
    assert.deepEqual(p.blockers, [])
    return withContinuityIO(ef.io, () => freezeContext(f.projectId, { target: req.target, includePlans: false,
      previewHash: p.doc.previewHash, acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID() }))
  }
  const enabledRaw = (approval: Approval, brief = '第三集简报'): Record<string, unknown> =>
    ({ brief, episode_number: 3, with_continuity: true, continuity_context: [approval.document.assetId] })

  await t('6.1 关闭开关+携包：bad_input 拒绝且不落 run、不动台账', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'mengbao-episode', '第三集简报A')
    const before = await countRuns(f.projectId)
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: { brief: '第三集简报A', episode_number: 3, with_continuity: false, continuity_context: [approval.document.assetId] },
      continuityApproval: approval })), badInput)
    assert.equal(await countRuns(f.projectId), before)
    assert.equal((await contextRow(approval.contextId)).status, 'frozen')
  })

  await t('6.1 未声明模板+原始启用：先判不支持再丢键，按 bad_input 拒绝', async () => {
    const { f } = await setupStory()
    // 缺 episode_number 声明（requireTargetInputs 失败 = 不支持）
    await assert.rejects(createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-noin',
      input: { brief: 'x', with_continuity: true } }), badInput)
    // 缺 continuity_context 声明（有目标步但无槽位声明，normalize 静默丢键前必须拦截）
    await assert.rejects(createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-noslot',
      input: { brief: 'x', episode_number: 3, with_continuity: true, continuity_context: [1] } }), badInput)
    // 非启用但携保留键：不许当「关闭」放行
    await assert.rejects(createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-noin',
      input: { brief: 'x', continuity_context: [1] } }), badInput)
  })

  await t('6.1 跨项目批准：continuity_source_invalid 404 且不落 run', async () => {
    const a = await setupStory(), b = await setupStory()
    const approval = await freezePack(a.f, a.ef, 'mengbao-episode', '跨项目批准')
    const before = await countRuns(b.f.projectId)
    await assert.rejects(withContinuityIO(b.ef.io, () => createRunRow({ projectId: b.f.projectId, templateKey: 'mengbao-episode',
      input: { brief: '跨项目批准', episode_number: 3, with_continuity: true, continuity_context: [approval.document.assetId] },
      continuityApproval: approval })), codeOf(404, 'continuity_source_invalid'))
    assert.equal(await countRuns(b.f.projectId), before)
  })

  await t('6.1 跨集批准（集号不符）：continuity_source_invalid 400', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'mengbao-episode', '第三集包')
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: { brief: '第二集冒用', episode_number: 2, with_continuity: true, continuity_context: [approval.document.assetId] },
      continuityApproval: approval })), codeOf(400, 'continuity_source_invalid'))
  })

  await t('6.1 伪造/多资产槽位：与批准包单一真实资产不符即 bad_input', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'mengbao-episode', '第三集简报F')
    const stranger = await writeTextAsset(f.projectId, { name: `${randomUUID()}.md`, content: '普通剧本资产', purpose: 'script' })
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: { brief: '第三集简报F', episode_number: 3, with_continuity: true, continuity_context: [stranger.id] },
      continuityApproval: approval })), badInput)
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: { brief: '第三集简报F', episode_number: 3, with_continuity: true,
        continuity_context: [approval.document.assetId, approval.document.assetId] }, continuityApproval: approval })), badInput)
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: { brief: '第三集简报F', episode_number: 3, with_continuity: true, continuity_context: [] },
      continuityApproval: approval })), badInput)
  })

  await t('6.1 启用缺批准 / 批准+关闭：双向 bad_input', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'mengbao-episode', '第三集简报G')
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: enabledRaw(approval) })), badInput)
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: { brief: '第三集简报G', episode_number: 3 }, continuityApproval: approval })), badInput)
  })

  await t('6.1 幂等复用：两次同目标仅一个 run（brief 6.1 示例逐字口径）', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'mengbao-episode', '第三集简报H')
    const raw = enabledRaw(approval, '第三集简报H')
    const before = await countRuns(f.projectId)
    const a = await withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode', input: raw, continuityApproval: approval }))
    const b = await withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode', input: raw, continuityApproval: approval }))
    assert.equal(a.id, b.id)
    assert.equal(a.status, 'queued')
    assert.equal(await countRuns(f.projectId), before + 1)
    const row = await contextRow(approval.contextId)
    assert.equal(row.status, 'bound')
    assert.equal(row.runId, a.id)
    // 布尔兼容口径：true/1/'1' 与 true 同义，仍复用同一 run；非法布尔表示 bad_input
    const c = await withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: { ...raw, with_continuity: 1 as unknown as boolean }, continuityApproval: approval }))
    assert.equal(c.id, a.id)
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: { ...raw, with_continuity: 'yes' as unknown as boolean }, continuityApproval: approval })), badInput)
  })

  await t('6.1 并发同包创建：CAS 仲裁后双方收敛到同一 run，无孤儿', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'mengbao-episode', '第三集简报I')
    const raw = enabledRaw(approval, '第三集简报I')
    const before = await countRuns(f.projectId)
    const [x, y] = await Promise.all([
      withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode', input: raw, continuityApproval: approval })),
      withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode', input: raw, continuityApproval: approval })),
    ])
    assert.equal(x.id, y.id)
    assert.equal(await countRuns(f.projectId), before + 1)
    assert.equal((await contextRow(approval.contextId)).runId, x.id)
  })

  await t('6.1 已绑定不同输入/不同模板：continuity_context_changed 409', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'mengbao-episode', '第三集简报J')
    await withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: enabledRaw(approval, '第三集简报J'), continuityApproval: approval }))
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: enabledRaw(approval, '改写后的第三集简报'), continuityApproval: approval })), codeOf(409, 'continuity_context_changed'))
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-episode',
      input: enabledRaw(approval, '第三集简报J'), continuityApproval: approval })), codeOf(409, 'continuity_context_changed'))
  })

  await t('6.1 claimContext 输家：CAS 失败回 claimed，台账不变', async () => {
    const { f, ef } = await setupStory()
    const { claimContext } = await binding()
    const approval = await freezePack(f, ef, 'mengbao-episode', '第三集简报K')
    const winner = await withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'mengbao-episode',
      input: enabledRaw(approval, '第三集简报K'), continuityApproval: approval }))
    const [loser] = await db.insert(pipelineRuns).values({ projectId: f.projectId, templateKey: 'mengbao-episode',
      status: 'queued', input: '{}', createdAt: 1, updatedAt: 1 }).returning()
    await assert.rejects(claimContext(db, approval, loser!), codeOf(409, 'continuity_context_claimed'))
    const row = await contextRow(approval.contextId)
    assert.equal(row.runId, winner.id)
  })

  await t('6.1 批量同包双行：整体回滚，批/run 不留孤儿，台账退回 frozen', async () => {
    const { f, ef } = await setupStory()
    const { createBatch } = await import('../../../src/services/batch')
    const approval = await freezePack(f, ef, 'm70-fixture-episode', '第三集简报L')
    const raw = enabledRaw(approval, '第三集简报L')
    const runsBefore = await countRuns(f.projectId)
    await assert.rejects(createBatch({ projectId: f.projectId, templateKey: 'm70-fixture-episode',
      inputs: [raw, raw], continuityApprovals: [approval, approval] }), codeOf(409, 'continuity_context_claimed'))
    assert.equal(await countRuns(f.projectId), runsBefore)
    assert.equal((await db.select().from(batches).where(eq(batches.projectId, f.projectId))).length, 0)
    const row = await contextRow(approval.contextId)
    assert.equal(row.status, 'frozen')
    assert.equal(row.runId, null)
  })

  await t('6.1 批量异包双行：各自独立冻结各自绑定，批行齐整', async () => {
    const { f, ef } = await setupStory()
    const { createBatch } = await import('../../../src/services/batch')
    const a = await freezePack(f, ef, 'm70-fixture-episode', '第三集简报M1')
    const b = await freezePack(f, ef, 'm70-fixture-episode', '第三集简报M2')
    const guard = patchStartRun()
    try {
      const { batch, runIds } = await withContinuityIO(ef.io, () => createBatch({ projectId: f.projectId,
        templateKey: 'm70-fixture-episode', inputs: [enabledRaw(a, '第三集简报M1'), enabledRaw(b, '第三集简报M2')],
        continuityApprovals: [a, b] }))
      assert.equal(runIds.length, 2)
      assert.equal(batch.total, 2)
      const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.batchId, batch.id))
      assert.equal(rows.length, 2)
      assert.deepEqual(rows.map(r => r.batchSeq).sort(), [1, 2])
      for (const [approval, runId] of [[a, runIds[0]!], [b, runIds[1]!]] as const) {
        const row = await contextRow(approval.contextId)
        assert.equal(row.status, 'bound')
        assert.equal(row.runId, runId)
      }
      assert.ok(guard.calls.every(id => runIds.includes(id)))
    } finally { guard.restore() }
  })

  await t('6.1 相同正文不同入口归属不得复用：batch 携已绑批准 → claimed 整体回滚', async () => {
    const { f, ef } = await setupStory()
    const { createBatch } = await import('../../../src/services/batch')
    const approval = await freezePack(f, ef, 'm70-fixture-episode', '第三集简报N')
    await withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-episode',
      input: enabledRaw(approval, '第三集简报N'), continuityApproval: approval }))
    const runsBefore = await countRuns(f.projectId)
    await assert.rejects(createBatch({ projectId: f.projectId, templateKey: 'm70-fixture-episode',
      inputs: [enabledRaw(approval, '第三集简报N')], continuityApprovals: [approval] }), codeOf(409, 'continuity_context_claimed'))
    assert.equal(await countRuns(f.projectId), runsBefore)
    assert.equal((await db.select().from(batches).where(eq(batches.projectId, f.projectId))).length, 0)
  })

  await t('6.1 路由单发：202 queued、台账绑定 run、startRun 恰一次；非法批准映射 4xx', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'm70-fixture-episode', '第三集简报O')
    const app = await mkApp()
    const guard = patchStartRun()
    try {
      const res = await withContinuityIO(ef.io, () => post(app, `/api/v1/projects/${f.projectId}/runs`, {
        template_key: 'm70-fixture-episode', input: enabledRaw(approval, '第三集简报O'), continuity_approval: approval }))
      assert.equal(res.status, 202)
      const body = await res.json() as { run: { id: number; status: string } }
      assert.equal(body.run.status, 'queued')
      assert.deepEqual(guard.calls, [body.run.id])
      const row = await contextRow(approval.contextId)
      assert.equal(row.runId, body.run.id)
      // 幂等复用：非 queued 状态的既有 run 不重新 engine.start
      await db.update(pipelineRuns).set({ status: 'running' }).where(eq(pipelineRuns.id, body.run.id))
      const again = await withContinuityIO(ef.io, () => post(app, `/api/v1/projects/${f.projectId}/runs`, {
        template_key: 'm70-fixture-episode', input: enabledRaw(approval, '第三集简报O'), continuity_approval: approval }))
      assert.equal(again.status, 202)
      const againBody = await again.json() as { run: { id: number } }
      assert.equal(againBody.run.id, body.run.id)
      assert.equal(guard.calls.length, 1)
      // 启用缺批准 → 400；跨项目批准 → 404
      const missing = await withContinuityIO(ef.io, () => post(app, `/api/v1/projects/${f.projectId}/runs`, {
        template_key: 'm70-fixture-episode', input: { brief: 'x', episode_number: 3, with_continuity: true,
          continuity_context: [approval.document.assetId] } }))
      assert.equal(missing.status, 400)
      const other = await setupStory()
      const cross = await withContinuityIO(other.ef.io, () => post(app, `/api/v1/projects/${other.f.projectId}/runs`, {
        template_key: 'm70-fixture-episode', input: enabledRaw(approval, 'x'), continuity_approval: approval }))
      assert.equal(cross.status, 404)
    } finally { guard.restore() }
  })

  await t('6.1 路由批量：continuity_approvals 按索引对应，各自绑定；长度不符 400', async () => {
    const { f, ef } = await setupStory()
    const a = await freezePack(f, ef, 'm70-fixture-episode', '第三集简报P1')
    const b = await freezePack(f, ef, 'm70-fixture-episode', '第三集简报P2')
    const app = await mkApp()
    const guard = patchStartRun()
    try {
      const res = await withContinuityIO(ef.io, () => post(app, `/api/v1/projects/${f.projectId}/batches`, {
        template_key: 'm70-fixture-episode', inputs: [enabledRaw(a, '第三集简报P1'), enabledRaw(b, '第三集简报P2')],
        continuity_approvals: [a, b] }))
      assert.equal(res.status, 201)
      const body = await res.json() as { runIds: number[] }
      assert.equal(body.runIds.length, 2)
      for (const [approval, runId] of [[a, body.runIds[0]!], [b, body.runIds[1]!]] as const) {
        assert.equal((await contextRow(approval.contextId)).runId, runId)
      }
      const mismatch = await withContinuityIO(ef.io, () => post(app, `/api/v1/projects/${f.projectId}/batches`, {
        template_key: 'm70-fixture-episode', inputs: [enabledRaw(a, '第三集简报P1')], continuity_approvals: [a, b] }))
      assert.equal(mismatch.status, 400)
    } finally { guard.restore() }
  })

  await t('6.5 非连续性 ai_text 原路不变：旧链参数、旧产物/用量，零台账写入', async () => {
    const { f, ef } = await setupStory()
    const stub = await stubLlmFetch()
    try {
      const run = await createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-episode',
        input: { brief: '关闭路径', episode_number: 3 } })
      const def = loadTemplate('m70-fixture-episode').steps[0]!
      const [step] = await db.insert(pipelineSteps).values({ runId: run.id, seq: 1, stepKey: def.key, actionKey: def.action,
        title: def.title, status: 'running', createdAt: 1, updatedAt: 1 }).returning()
      const ctx = await createStepContext({ run, step: step!, template: loadTemplate('m70-fixture-episode'), def,
        input: JSON.parse(run.input) as Record<string, unknown> })
      const result = await aiText(ctx)
      assert.equal(stub.bodies.length, 1)
      assert.equal(stub.bodies[0]!['temperature'], 0.8)
      assert.equal(stub.bodies[0]!['max_tokens'], 12000)
      assert.equal(result.assetIds.length, 1)
      const [asset] = await db.select().from(assets).where(eq(assets.id, result.assetIds[0]!))
      assert.equal(asset!.purpose, 'script')
      assert.ok((await db.select().from(usageRecords).where(eq(usageRecords.runId, run.id))).length >= 1)
      assert.equal((await db.select().from(records).where(eq(records.runId, run.id))).length, 0)
      assert.equal((await db.select().from(execSnapshots).where(and(eq(execSnapshots.runId, run.id)))).length, 1)
      void ef
    } finally { stub.restore() }
  })

  await t('6.5 启用目标端到端：冻结渲染注入一次、槽位跳过、continuity llmOptions 链、completed 台账', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'm70-fixture-episode', '第三集简报Q')
    const ctx = await makeStepContext(f, approval)
    const fake = fakeIO(script)
    const result = await withContinuityIO(fake.io, () => aiText(ctx))
    assert.equal(fake.calls(), 1)
    const opts = fake.optionsLog[0] as { temperature: number; maxTokens: number; timeoutMs: number }
    assert.equal(opts.temperature, 0)
    assert.equal(opts.maxTokens, 24000)
    assert.equal(opts.timeoutMs, 600000)
    const messages = fake.messages[0]!
    assert.equal(messages.length, 2)
    const user = messages[1]!.content as string
    const doc = await (await import('../../../src/services/continuity/context')).readContext(f.projectId, approval, db)
    assert.ok(user.includes(doc.rendered))
    assert.equal(user.split(doc.rendered).length - 1, 1)
    assert.ok(!user.includes('--- continuity_context'))
    assert.ok(user.includes('仅使用隔离测试输入生成本集剧本。'))
    assert.equal(result.assetIds.length, 1)
    const [asset] = await db.select().from(assets).where(eq(assets.id, result.assetIds[0]!))
    assert.equal(asset!.runId, ctx.run.id)
    assert.equal(asset!.stepId, ctx.step.id)
    const [useRow] = await db.select().from(records).where(and(eq(records.runId, ctx.run.id), eq(records.rowType, 'consumption')))
    assert.equal(useRow!.status, 'completed')
    assert.ok((await db.select().from(usageRecords).where(eq(usageRecords.runId, ctx.run.id))).length >= 1)
    const [snap] = await db.select().from(execSnapshots).where(eq(execSnapshots.runId, ctx.run.id))
    assert.ok(snap, '执行快照必须存在')
    const edges = await db.select().from(execInputs).where(eq(execInputs.snapshotId, snap!.id))
    assert.ok(edges.some(i => i.role === 'continuity_context' && i.srcId === approval.document.assetId))
  })

  await t('6.5 启用 run 的非目标步骤原路：普通模型链，零消费台账', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'm70-fixture-mixed', '第三集简报R')
    const stub = await stubLlmFetch()
    try {
      const tpl = loadTemplate('m70-fixture-mixed')
      const run = await withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-mixed',
        input: enabledRaw(approval, '第三集简报R'), continuityApproval: approval }))
      const def = tpl.steps[1]!
      const [step] = await db.insert(pipelineSteps).values({ runId: run.id, seq: 2, stepKey: def.key, actionKey: def.action,
        title: def.title, status: 'running', createdAt: 1, updatedAt: 1 }).returning()
      const ctx = await createStepContext({ run, step: step!, template: tpl, def, input: JSON.parse(run.input) as Record<string, unknown> })
      const result = await aiText(ctx)
      assert.equal(stub.bodies.length, 1)
      assert.equal(result.assetIds.length, 1)
      assert.equal((await db.select().from(records).where(eq(records.runId, run.id))).length, 1) // 仅 context 行
      assert.equal((await db.select().from(records).where(and(eq(records.runId, run.id), eq(records.rowType, 'consumption')))).length, 0)
    } finally { stub.restore() }
  })

  await t('6.5 batch 步 + 启用：创建期拒绝；执行期 batch early return 前拦 continuity_unsupported', async () => {
    const { f, ef } = await setupStory()
    // batchrole 模板无合法目标步（role+batch），承接包只能经合法模板冻结；创建期闸在批准被读取前先拦
    const approval = await freezePack(f, ef, 'm70-fixture-episode', '第三集简报S')
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-batchrole',
      input: enabledRaw(approval, '第三集简报S'), continuityApproval: approval })), badInput)
    const tpl = loadTemplate('m70-fixture-batchrole')
    const run = await createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-batchrole',
      input: { brief: 'x', episode_number: 3 } })
    await db.update(pipelineRuns).set({ input: JSON.stringify(enabledRaw(approval, '第三集简报S')) }).where(eq(pipelineRuns.id, run.id))
    const [fresh] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id))
    const def = tpl.steps[0]!
    const [step] = await db.insert(pipelineSteps).values({ runId: run.id, seq: 1, stepKey: def.key, actionKey: def.action,
      title: def.title, status: 'running', createdAt: 1, updatedAt: 1 }).returning()
    const ctx = await createStepContext({ run: fresh!, step: step!, template: tpl, def, input: enabledRaw(approval, '第三集简报S') })
    await assert.rejects(aiText(ctx), codeOf(400, 'continuity_unsupported'))
  })

  await t('6.5 目标步找不到 bound 台账行：continuity_source_invalid 404（不派发模型）', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezePack(f, ef, 'm70-fixture-episode', '第三集简报T')
    const tpl = loadTemplate('m70-fixture-episode')
    const run = await withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-episode',
      input: enabledRaw(approval, '第三集简报T'), continuityApproval: approval }))
    await db.delete(records).where(eq(records.id, approval.contextId))
    const def = tpl.steps[0]!
    const [step] = await db.insert(pipelineSteps).values({ runId: run.id, seq: 1, stepKey: def.key, actionKey: def.action,
      title: def.title, status: 'running', createdAt: 1, updatedAt: 1 }).returning()
    const ctx = await createStepContext({ run, step: step!, template: tpl, def, input: JSON.parse(run.input) as Record<string, unknown> })
    await assert.rejects(withContinuityIO(fakeIO(script).io, () => aiText(ctx)), codeOf(404, 'continuity_source_invalid'))
  })

  await t('6.5 run-prefill：两保留键不复用，with_continuity 重置 false', async () => {
    const { f } = await setupStory()
    const t0 = Date.now() + 60_000 // 保证为同模板最新 run（resolveRunPrefill 按 updatedAt 取最近一条）
    const [run] = await db.insert(pipelineRuns).values({ projectId: f.projectId, templateKey: 'mengbao-episode', status: 'completed',
      input: JSON.stringify({ brief: '上次的简报', episode_number: 2, with_continuity: true, continuity_context: [42] }),
      createdAt: t0, updatedAt: t0 }).returning()
    const prefill = await resolveRunPrefill(f.projectId, 'mengbao-episode')
    assert.equal(prefill.lastRunId, run!.id)
    assert.deepEqual(prefill.inputs['with_continuity'], { value: false, source: 'template_default' })
    assert.ok(!('continuity_context' in prefill.inputs))
  })

  await t('6.5 refs 通用素材归属检查：保留 purpose 不得当普通素材放行', async () => {
    const { f } = await setupStory()
    const use = await writeTextAsset(f.projectId, { name: `${randomUUID()}.json`, purpose: 'continuity_use', format: 'continuity-json', content: '{}' })
    await assert.rejects(assertProjectAssets(f.projectId, [use.id], '探针引用'), RefResolveError)
    const normal = await writeTextAsset(f.projectId, { name: `${randomUUID()}.md`, content: '普通', purpose: 'script' })
    assert.deepEqual(await assertProjectAssets(f.projectId, [normal.id], '探针引用'), [normal.id])
  })

  await t('6.5 模板校验器：非法 role / 多目标 / batch 目标 / 上限只能下调', async () => {
    const { continuityTemplateErrors } = await templateErrors()
    const base = (steps: string, extra = ''): string => `key: m70-probe-neg
name: 探针负例
version: 1
genre: drama_short
inputs:
  - { key: brief, label: 简报, kind: text, required: true }
  - { key: episode_number, label: 集号, kind: int, required: true }
  - { key: with_continuity, label: 开关, kind: bool, required: false, default: false }
  - { key: continuity_context, label: 包, kind: files, required: false }
${extra}steps:
${steps}
`
    const roleStep = `  - key: write_script
    action: ai_text
    title: 剧本
    inputs: {}
    params: { continuity_role: episode_script, prompt_inline: x }
`
    const parse = (text: string) => {
      const res = validateTemplateText(text)
      assert.deepEqual(res.errors, [])
      return res.template!
    }
    assert.deepEqual(continuityTemplateErrors(parse(base(roleStep))), [])
    const bogus = base(roleStep.replace('episode_script', 'bogus'))
    assert.ok(continuityTemplateErrors(parse(bogus)).some(e => e.includes('continuity_role')))
    const doubled = base(`${roleStep}  - key: write_script_alt
    action: ai_text
    title: 备选
    inputs: {}
    params: { continuity_role: episode_script, prompt_inline: y }
`)
    assert.ok(continuityTemplateErrors(parse(doubled)).some(e => e.includes('仅允许一个')))
    const batched = base(roleStep.replace('params: { continuity_role: episode_script, prompt_inline: x }',
      'params: { continuity_role: episode_script, prompt_inline: x }\n    batch: { field: shots }'))
    assert.ok(continuityTemplateErrors(parse(batched)).some(e => e.includes('batch')))
    const raised = base(roleStep, 'defaults:\n  continuity:\n    max_render_chars: 30000\n')
    assert.ok(continuityTemplateErrors(parse(raised)).some(e => e.includes('24000')))
    const lowered = base(roleStep, 'defaults:\n  continuity:\n    max_render_chars: 2000\n')
    assert.deepEqual(continuityTemplateErrors(parse(lowered)), [])
    const missingEpisode = base(roleStep).replace('  - { key: episode_number, label: 集号, kind: int, required: true }\n', '')
    assert.ok(continuityTemplateErrors(parse(missingEpisode)).some(e => e.includes('episode_number')))
    const plain = `key: m70-probe-plain
name: 无目标
version: 1
genre: drama_short
inputs:
  - { key: brief, label: 简报, kind: text, required: true }
steps:
  - key: only
    action: ai_text
    title: 普通步
    inputs: {}
    params: { prompt_inline: y }
`
    assert.deepEqual(continuityTemplateErrors(parse(plain)), [])
  })
}
