/**
 * M51 离线探针：批次与运行删除（记录级清理）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m51.ts [--section=run|batch]
 *
 * 隔离策略：isolatedEnv('m51') 一次性临时目录（独立 studio.db + workspace），必须在任何 src 动态 import 前调用。
 * 零网络、零付费：全部场景直插 DB（不经 engine/模板执行链），删除守卫仅走 REST 路由层。
 *
 * 断言面：
 *  - run：非终态 409 run_active；终态 200 级联（steps/tasks/run 行）；保留面（assets/usage_records 不动）；
 *    引用解绑：会话指向被删 run → 回落同项目最近存活 run，无存活才置 NULL；剧集 latest_run_id 直接解绑置 NULL；
 *    重复删 404；批内删除后批次计数重算；
 *  - batch：批内存在未完成 run → 409 batch_running；全终态 → 批次 + 批内 run 级联删、资产保留；不存在 → 404。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m51')

const SECTIONS = ['run', 'batch'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m51')
const checker: Checker = makeChecker(log)
const check = checker.check

await runSections({ log, title: 'M51', checker, cleanup, sections: SECTIONS, registry: async () => {
  const { initDb } = await import('../src/db')
  await initDb()
  check(true, '初始化隔离库完成（零真实执行）')
}, runners: {
  // ============ run 删除：守卫 / 级联 / 保留面 / 解绑 / 幂等 / 批次计数 ============
  run: async () => {
    const { db } = await import('../src/db')
    const { assets, batches, creationSessions, episodes, genTasks, pipelineRuns, pipelineSteps, projects, series, usageRecords } = await import('../src/db/schema')
    const { eq, inArray } = await import('drizzle-orm')
    const { app } = await import('../src/app')
    const now = Date.now()
    const [project] = await db.insert(projects).values({ name: 'm51-run', genre: 'other', templateKey: 'quick-video', status: 'active', settings: '{}', tags: '[]', createdAt: now, updatedAt: now }).returning()
    const pid = project!.id
    const [run] = await db.insert(pipelineRuns).values({
      projectId: pid, templateKey: 'quick-video', status: 'queued', input: '{}', createdAt: now, updatedAt: now,
    } as never).returning()
    const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 1, stepKey: 'draft', actionKey: 'ai_text', status: 'failed', createdAt: now, updatedAt: now } as never).returning()
    await db.insert(genTasks).values({ projectId: pid, runId: run!.id, stepId: step!.id, kind: 'text', status: 'pending', params: '{}', attempts: 1, createdAt: now, updatedAt: now } as never)

    // ① 非终态守卫：queued 直删必须 409（先取消再删，与项目 purge 同口径）
    const denied = await app.request(`/api/v1/runs/${run!.id}`, { method: 'DELETE' })
    const deniedBody = await denied.json() as { error?: { code?: string } }
    check(denied.status === 409 && deniedBody.error?.code === 'run_active', `非终态守卫：queued run 删除 409（${denied.status}/${deniedBody.error?.code}）`)

    // ② 转终态 + 挂满引用面：产物资产 / 用量流水 / 会话锚点 / 剧集最近 run
    await db.update(pipelineRuns).set({ status: 'failed' }).where(eq(pipelineRuns.id, run!.id))
    const [asset] = await db.insert(assets).values({ projectId: pid, runId: run!.id, kind: 'text', purpose: 'script', name: '产物.md', createdAt: now, updatedAt: now } as never).returning()
    await db.insert(usageRecords).values({ projectId: pid, runId: run!.id, kind: 'tts', unit: 'char', quantity: 10, unitPrice: 0.1, cost: 1, currency: 'CNY', meta: '{}', createdAt: now } as never)
    // 批准锚点与被删派生 run 同步前进（端点 NEW），而回落目标 survivor 冻结旧端点（OLD）——仅端点差应触发对齐
    const approvedPlan = JSON.stringify({ v: 1, plan: { mode: 'static' }, sources: [{ id: 1, hash: 'x' }], templateHash: 'th', endpoints: { image: { model: 'NEW' } } })
    const survivorRecipe = JSON.stringify({ v: 1, plan: { mode: 'static' }, sources: [{ id: 1, hash: 'x' }], templateHash: 'th', endpoints: { image: { model: 'OLD' } } })
    const [sess] = await db.insert(creationSessions).values({ projectId: pid, requestKey: `m51${now}`, status: 'started', plan: '{}', planRevision: 1, planHash: 'h', preflight: '{}', runHistory: '[]', approvedPlan, runId: run!.id, createdAt: now, updatedAt: now } as never).returning()
    const [sr] = await db.insert(series).values({ projectId: pid, name: '探针剧', createdAt: now, updatedAt: now } as never).returning()
    const [ep] = await db.insert(episodes).values({ projectId: pid, seriesId: sr!.id, number: 1, status: 'locked', latestRunId: run!.id, createdAt: now, updatedAt: now } as never).returning()
    // 预建一个同项目存活 run（id 更大）：② 删除 run! 时会话应回落到它（不先置 NULL）
    const [survivor] = await db.insert(pipelineRuns).values({ projectId: pid, templateKey: 'quick-video', status: 'failed', input: JSON.stringify({ recipe: survivorRecipe }), createdAt: now, updatedAt: now } as never).returning()

    const okRes = await app.request(`/api/v1/runs/${run!.id}`, { method: 'DELETE' })
    const okBody = await okRes.json() as { ok?: boolean; runs?: number; steps?: number; tasks?: number }
    check(okRes.status === 200 && okBody.ok === true && okBody.runs === 1 && okBody.steps === 1 && okBody.tasks === 1,
      `终态删除 200 且计数准确（实际 ${okRes.status}/${JSON.stringify(okBody)}）`)
    check((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run!.id))).length === 0
      && (await db.select().from(pipelineSteps).where(inArray(pipelineSteps.runId, [run!.id]))).length === 0
      && (await db.select().from(genTasks).where(inArray(genTasks.runId, [run!.id]))).length === 0,
      '级联删除面：run 行 + steps + gen_tasks 全部清干净')

    // ③ 保留面（用户拍板）：产物资产与成本流水不动
    check((await db.select().from(assets).where(eq(assets.id, asset!.id)))[0]?.deletedAt == null, '保留面：run 产物资产行仍在（素材清理走资产入口）')
    check((await db.select().from(usageRecords).where(inArray(usageRecords.runId, [run!.id]))).length === 1, '保留面：用量流水保留（成本审计事实不随记录消失）')

    // ④ 引用解绑：会话回落到同项目最近存活 run（删续跑链末端不打断会话），剧集直接置 NULL
    check((await db.select().from(creationSessions).where(eq(creationSessions.id, sess!.id)))[0]!.runId === survivor!.id,
      '回落：② 删除会话当前 run 后指针改指同项目最近存活 run（制作进度/续跑入口不丢）')
    // 回落时同步把存活 run 的 input.recipe 前向对齐到批准锚点（仅端点漂移差），否则下次续跑 assertRecipeSources 被拒
    const [survivorFresh] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, survivor!.id))
    check(JSON.parse(survivorFresh!.input).recipe === approvedPlan, '回落锚点对齐：存活 run recipe 已推进到批准锚点（端点 NEW）')
    // 最后一个存活 run 也被删 → 项目内无 run 才置 NULL（会话退纯规划态）
    await app.request(`/api/v1/runs/${survivor!.id}`, { method: 'DELETE' })
    check((await db.select().from(creationSessions).where(eq(creationSessions.id, sess!.id)))[0]!.runId === null, '回落兜底：项目已无存活 run 时置 NULL')
    check((await db.select().from(episodes).where(eq(episodes.id, ep!.id)))[0]!.latestRunId === null, '解绑：episodes.latest_run_id 置 NULL（跨项目不可靠定位，宁可解绑不指错）')

    // ⑤ 重复删 → 404
    check((await app.request(`/api/v1/runs/${run!.id}`, { method: 'DELETE' })).status === 404, '幂等面：已删 run 再删 404')

    // ⑥ 批内删除 → 批次计数权威重算（防 total/finished 悬空）
    const [batchRow] = await db.insert(batches).values({ projectId: pid, templateKey: 'quick-video', name: '计数批', status: 'partial_failed', schedule: '{"max_concurrent":1}', total: 3, finished: 3, succeeded: 1, failed: 2, createdAt: now, updatedAt: now } as never).returning()
    const ids: number[] = []
    for (let i = 1; i <= 3; i++) {
      const [r] = await db.insert(pipelineRuns).values({ projectId: pid, templateKey: 'quick-video', status: i === 1 ? 'completed' : 'failed', input: '{}', batchId: batchRow!.id, batchSeq: i, createdAt: now, updatedAt: now } as never).returning()
      ids.push(r!.id)
    }
    await app.request(`/api/v1/runs/${ids[0]!}`, { method: 'DELETE' })
    const [batchFresh] = await db.select().from(batches).where(eq(batches.id, batchRow!.id))
    check(batchFresh!.total === 2 && batchFresh!.finished === 2 && batchFresh!.succeeded === 0 && batchFresh!.failed === 2,
      `批内删单 run 后批次计数重算（实际 total=${batchFresh!.total}/finished=${batchFresh!.finished}/succeeded=${batchFresh!.succeeded}/failed=${batchFresh!.failed}）`)
  },

  // ============ batch 删除：守卫 / 级联全批 / 404 ============
  batch: async () => {
    const { db } = await import('../src/db')
    const { assets, batches, genTasks, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
    const { eq, inArray } = await import('drizzle-orm')
    const { app } = await import('../src/app')
    const now = Date.now()
    const [project] = await db.insert(projects).values({ name: 'm51-batch', genre: 'other', templateKey: 'quick-video', status: 'active', settings: '{}', tags: '[]', createdAt: now, updatedAt: now }).returning()
    const [b1] = await db.insert(batches).values({ projectId: project!.id, templateKey: 'quick-video', name: '在途批', status: 'running', schedule: '{"max_concurrent":1}', total: 2, finished: 1, succeeded: 1, failed: 0, createdAt: now, updatedAt: now } as never).returning()
    const [done] = await db.insert(pipelineRuns).values({ projectId: project!.id, templateKey: 'quick-video', status: 'completed', input: '{}', batchId: b1!.id, batchSeq: 1, createdAt: now, updatedAt: now } as never).returning()
    const [pending] = await db.insert(pipelineRuns).values({ projectId: project!.id, templateKey: 'quick-video', status: 'queued', input: '{}', batchId: b1!.id, batchSeq: 2, createdAt: now, updatedAt: now } as never).returning()

    // ① 守卫：批内存在非终态 run → 409（先取消批次）
    const denied = await app.request(`/api/v1/batches/${b1!.id}`, { method: 'DELETE' })
    const deniedBody = await denied.json() as { error?: { code?: string } }
    check(denied.status === 409 && deniedBody.error?.code === 'batch_running', `批次守卫：批内有未完成 run → 409（${denied.status}/${deniedBody.error?.code}）`)
    check((await db.select().from(pipelineRuns).where(inArray(pipelineRuns.id, [done!.id, pending!.id]))).length === 2, '守卫拦截后批内 run 零误删')

    // ② 全终态 → 批次 + 批内全部 run/steps/tasks 级联删；产物资产保留
    await db.update(pipelineRuns).set({ status: 'cancelled' }).where(eq(pipelineRuns.id, pending!.id))
    await db.update(batches).set({ status: 'partial_failed' }).where(eq(batches.id, b1!.id))
    const [step] = await db.insert(pipelineSteps).values({ runId: done!.id, seq: 1, stepKey: 'draft', actionKey: 'ai_text', status: 'succeeded', createdAt: now, updatedAt: now } as never).returning()
    await db.insert(genTasks).values({ projectId: project!.id, runId: done!.id, stepId: step!.id, kind: 'text', status: 'succeeded', params: '{}', attempts: 1, createdAt: now, updatedAt: now } as never)
    const [art] = await db.insert(assets).values({ projectId: project!.id, runId: done!.id, kind: 'video', purpose: 'final_video', name: '成片.mp4', createdAt: now, updatedAt: now } as never).returning()
    const okRes = await app.request(`/api/v1/batches/${b1!.id}`, { method: 'DELETE' })
    const okBody = await okRes.json() as { ok?: boolean; runs?: number; steps?: number; tasks?: number }
    check(okRes.status === 200 && okBody.runs === 2 && okBody.steps === 1 && okBody.tasks === 1,
      `批次级联删除 200 且计数准确（实际 ${JSON.stringify(okBody)}）`)
    check((await db.select().from(batches).where(eq(batches.id, b1!.id))).length === 0
      && (await db.select().from(pipelineRuns).where(eq(pipelineRuns.batchId, b1!.id))).length === 0
      && (await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, done!.id))).length === 0,
      '级联面：批行 + 批内 run + steps 全清')
    check((await db.select().from(assets).where(eq(assets.id, art!.id)))[0]?.deletedAt == null, '保留面：批删不连坐成片资产')

    // ③ 不存在 → 404
    check((await app.request('/api/v1/batches/424242', { method: 'DELETE' })).status === 404, '不存在批次 → 404')
  },

  // ============ 回落锚点对齐的负向保护：plan 不一致时不得改写存活 run 历史快照 ============
  neg: async () => {
    const { db } = await import('../src/db')
    const { creationSessions, pipelineRuns, projects } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { app } = await import('../src/app')
    const now = Date.now()
    const [p] = await db.insert(projects).values({ name: `m51neg${now}`, genre: 'other', templateKey: 'quick-video', status: 'active', settings: '{}', tags: '[]', createdAt: now, updatedAt: now } as never).returning()
    const oldRecipe = JSON.stringify({ v: 1, plan: { script: 'B' }, sources: [{ id: 1, hash: 'x' }], templateHash: 'th', endpoints: { image: { model: 'OLD' } } })
    const newRecipe = JSON.stringify({ v: 1, plan: { script: 'A' }, sources: [{ id: 1, hash: 'x' }], templateHash: 'th', endpoints: { image: { model: 'NEW' } } })
    const [runOld] = await db.insert(pipelineRuns).values({ projectId: p!.id, templateKey: 'quick-video', status: 'failed', input: JSON.stringify({ recipe: oldRecipe }), createdAt: now, updatedAt: now } as never).returning()
    const [runNew] = await db.insert(pipelineRuns).values({ projectId: p!.id, templateKey: 'quick-video', status: 'failed', input: JSON.stringify({ recipe: newRecipe }), createdAt: now + 1, updatedAt: now + 1 } as never).returning()
    const [s2] = await db.insert(creationSessions).values({ projectId: p!.id, requestKey: `m51neg${now}`, status: 'started', plan: '{}', planRevision: 1, planHash: 'h', preflight: '{}', runHistory: '[]', approvedPlan: newRecipe, runId: runNew!.id, createdAt: now, updatedAt: now } as never).returning()
    const res = await app.request(`/api/v1/runs/${runNew!.id}`, { method: 'DELETE' })
    check(res.status === 200, `负向场景删除会话当前 run 200（实际 ${res.status}）`)
    check((await db.select().from(creationSessions).where(eq(creationSessions.id, s2!.id)))[0]!.runId === runOld!.id, '负向场景仍正常回落到存活 run')
    const [oldFresh] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runOld!.id))
    check(JSON.parse(oldFresh!.input).recipe === oldRecipe, '负向保护：回落 run 的 plan 与锚点不一致时不整段改写其历史 recipe（仅端点差才对齐）')
  },
} })
