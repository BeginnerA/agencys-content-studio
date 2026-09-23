/**
 * M49 离线探针：「计费与幂等深化」审计修复 G1–G4——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m49.ts [--section=claim|resume|budget]
 *
 * 隔离策略：isolatedEnv('m49') 一次性临时目录（独立 studio.db + workspace），必须在任何 src 动态 import 前调用。
 * 零网络、零付费：占槽策略——settings concurrency.max=1 + engine.active 预占哨兵 runId，
 * 所有 engine.startRun 一律 deferred 归一 queued（不拉起真实执行链，零第三方提交），
 * 使 resume/批创建的终态断言无后台竞态。真实模板经复制 quick-video.yaml 进隔离 TEMPLATES_DIR 提供。
 *
 * 断言面：
 *  - claim（G1）：同一条 pending 排产计划并发双触发 → CAS 单赢家，仅建 1 批 2 run；重复触发零新建；
 *    空 inputTemplate → failed 终态（不再悬 pending 风暴）；
 *  - resume（G2+G4）：首跑 202 派生新 run（resumedFromRunId 戳记 / 步骤复制终态保留 / gen_tasks 整体迁移
 *    succeeded 保产物、非终态归零）；派生进行中 → 二次 resume 409 already_resumed；派生终态后 → 允许再续跑；
 *  - budget（G3）：超限项目 resume → 409 budget_monthly_exceeded；createBatch service → BudgetBlockedError；
 *    POST /projects/:id/batches route → 409 同 code。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, runSections } from './probe-lib'

const { cleanup } = isolatedEnv('m49')

const SECTIONS = ['claim', 'resume', 'budget'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m49')
const checker = makeChecker(log)
const check = checker.check

/** 复制真实模板进隔离 workspace（loader 从 TEMPLATES_DIR 读；quick-video 仅 1 个必填输入 idea） */
async function seedTemplate(): Promise<void> {
  const { TEMPLATES_DIR } = await import('../src/env')
  mkdirSync(TEMPLATES_DIR, { recursive: true })
  copyFileSync(join(process.cwd(), '../../workspace/templates/quick-video.yaml'), join(TEMPLATES_DIR, 'quick-video.yaml'))
}

/** 占满全局槽位（max=1 + 哨兵占 1）：此后一切 startRun 均 deferred → 探针零真实执行 */
async function holdSlots(): Promise<void> {
  const { db } = await import('../src/db')
  const { settings } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { refreshGlobalConcurrency, engine } = await import('../src/pipeline/engine')
  await db.delete(settings).where(eq(settings.key, 'concurrency'))
  await db.insert(settings).values({ key: 'concurrency', value: JSON.stringify({ max: 1 }), updatedAt: Date.now() } as never)
  await refreshGlobalConcurrency()
  ;(engine as unknown as { active: Set<number> }).active.add(999_999)
}

/** 建 run + 步骤 + 子任务（gen_tasks 1 succeeded 带产物 + 1 pending）；status 由调用方给 */
async function buildRunScene(name: string, runStatus: string) {
  const { db } = await import('../src/db')
  const { projects, pipelineRuns, pipelineSteps, genTasks } = await import('../src/db/schema')
  const { loadTemplate } = await import('../src/pipeline/loader')
  const now = Date.now()
  const [project] = await db.insert(projects).values({ name, createdAt: now, updatedAt: now }).returning()
  const [run] = await db.insert(pipelineRuns).values({
    projectId: project!.id, templateKey: 'quick-video', input: JSON.stringify({ idea: '探针创意' }),
    status: runStatus, templateSnapshot: JSON.stringify(loadTemplate('quick-video')), createdAt: now, updatedAt: now,
  } as never).returning()
  const stepA = (await db.insert(pipelineSteps).values({
    runId: run!.id, seq: 1, stepKey: 'draft', actionKey: 'ai_text', title: '步骤A', status: 'succeeded', output: '{"ok":1}', createdAt: now, updatedAt: now,
  } as never).returning())[0]!
  const stepB = (await db.insert(pipelineSteps).values({
    runId: run!.id, seq: 2, stepKey: 'voice', actionKey: 'tts', title: '步骤B', status: 'failed', error: 'boom', createdAt: now, updatedAt: now,
  } as never).returning())[0]!
  await db.insert(genTasks).values([
    { projectId: project!.id, runId: run!.id, stepId: stepA!.id, kind: 'text', status: 'succeeded', params: '{}', attempts: 1, resultAssetId: 4242, createdAt: now, updatedAt: now },
    { projectId: project!.id, runId: run!.id, stepId: stepB!.id, kind: 'audio', status: 'pending', params: '{}', attempts: 2, errorMsg: 'x', createdAt: now, updatedAt: now },
  ] as never)
  return { db, project: project!, run: run!, stepA: stepA!, stepB: stepB!, genTasks, pipelineRuns, now }
}

await runSections({ log, title: 'M49', checker, cleanup, sections: SECTIONS, registry: async () => {
  const { initDb } = await import('../src/db')
  await initDb()
  await seedTemplate()
  await holdSlots()
  check(true, '初始化隔离库 + 模板复制 + 占槽完成（零真实执行）')
}, runners: {
  // ============ G1：排产触发 CAS（并发单赢家，不双建批次） ============
  claim: async () => {
    const { db } = await import('../src/db')
    const { schedules, batches, pipelineRuns } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { triggerSchedule } = await import('../src/services/schedule')
    const scene = await buildRunScene('m49-claim', 'completed')
    const now = Date.now()
    const [sched] = await db.insert(schedules).values({
      projectId: scene.project.id, name: '排产探针', templateKey: 'quick-video', cronExpr: 'once',
      scheduledAt: now - 1000, status: 'pending', isActive: 1,
      inputTemplate: JSON.stringify([{ idea: '探针一' }, { idea: '探针二' }]), createdAt: now, updatedAt: now,
    } as never).returning()
    // 并发双触发：模拟 tick 异步链交错（setInterval 允许重叠），CAS 必须只放一个赢家
    await Promise.all([triggerSchedule(sched!.id), triggerSchedule(sched!.id)])
    const bs = await db.select().from(batches)
    check(bs.length === 1, `G1 排产 CAS：并发双触发仅建 1 批（实际 ${bs.length}）`)
    const runs = await db.select().from(pipelineRuns).where(eq(pipelineRuns.batchId, bs[0]!.id))
    check(runs.length === 2, `G1 排产 CAS：批内 2 条 run 原子落库（实际 ${runs.length}）`)
    const [fresh] = await db.select().from(schedules).where(eq(schedules.id, sched!.id))
    check(fresh!.status === 'triggered' && fresh!.lastBatchId === bs[0]!.id, 'G1 排产 CAS：计划终态 triggered 且指向唯一批')
    // 再触发一次：非 pending → claim 失败 → 零新建（幂等）
    await triggerSchedule(sched!.id)
    check((await db.select().from(batches)).length === 1, 'G1 排产 CAS：triggered 后重复触发零新建批')
    // 空 inputTemplate → failed 定终态（不再悬 pending 被每轮扫描）
    const [empty] = await db.insert(schedules).values({
      projectId: scene.project.id, name: '空模板排产', templateKey: 'quick-video', cronExpr: 'once',
      scheduledAt: now - 1000, status: 'pending', isActive: 1, inputTemplate: '[]', createdAt: now, updatedAt: now,
    } as never).returning()
    await triggerSchedule(empty!.id)
    const [emptyFresh] = await db.select().from(schedules).where(eq(schedules.id, empty!.id))
    check(emptyFresh!.status === 'failed', `G1 排产附带：空输入数组定终态 failed（实际 ${emptyFresh!.status}）`)
  },

  // ============ G2+G4：resume 去重 + 原子迁移（route 级全栈验证） ============
  resume: async () => {
    const { app } = await import('../src/app')
    const scene = await buildRunScene('m49-resume', 'failed')
    const callResume = async (runId: number) =>
      app.request(`/api/v1/runs/${runId}/resume`, { method: 'POST' })
    const first = await callResume(scene.run.id)
    check(first.status === 202, `G2 resume 首跑：202 受理（实际 HTTP ${first.status}）`)
    const body = await first.json() as { run: { id: number } }
    const derivedId = body.run.id
    const { db, genTasks, pipelineRuns } = scene
    const { pipelineSteps } = await import('../src/db/schema')
    const { eq, and, asc } = await import('drizzle-orm')
    const [derived] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, derivedId))
    check(derived!.resumedFromRunId === scene.run.id, 'G2 resume 首跑：派生 run 戳记 resumedFromRunId=源 run')
    const dSteps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, derivedId)).orderBy(asc(pipelineSteps.seq))
    check(dSteps.length === 2 && dSteps[0]!.status === 'succeeded' && dSteps[1]!.status === 'pending',
      `G4 迁移原子：步骤复制 2 条且终态保留/重置正确（实际 ${dSteps.map((s) => s.status).join('/')}）`)
    const [taskSucceeded] = await db.select().from(genTasks).where(and(eq(genTasks.runId, derivedId), eq(genTasks.kind, 'text')))
    const [taskPending] = await db.select().from(genTasks).where(and(eq(genTasks.runId, derivedId), eq(genTasks.kind, 'audio')))
    check(taskSucceeded?.resultAssetId === 4242, 'G4 迁移原子：succeeded 子任务随派生保留 resultAssetId（复用不二次计费）')
    check(taskPending?.status === 'pending' && taskPending.attempts === 0 && taskPending.stepId === dSteps[1]!.id,
      'G4 迁移原子：非终态子任务归零并挂到派生 step')
    // 派生 run 进行中（占槽 → 恒 queued 非终态）：二次 resume 必须 409 already_resumed
    const second = await callResume(scene.run.id)
    const secondBody = await second.json() as { error?: { code?: string } }
    check(second.status === 409 && secondBody.error?.code === 'already_resumed',
      `G2 防双击：派生进行中二次 resume 拦截（${second.status}/${secondBody.error?.code}）`)
    // 派生进入终态后允许再次续跑（「同时至多一个活跃派生」语义闭环）
    await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, derivedId))
    const third = await callResume(scene.run.id)
    check(third.status === 202, `G2 防双击：派生终态后允许再续跑（实际 HTTP ${third.status}）`)
  },

  // ============ G3：新承诺入口预算闸门（resume route + createBatch service/route） ============
  budget: async () => {
    const { db } = await import('../src/db')
    const { usageRecords, batches } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { saveBudget, BudgetBlockedError } = await import('../src/services/budget')
    const batchesBefore = (await db.select().from(batches)).length
    const scene = await buildRunScene('m49-budget', 'failed')
    const now = Date.now()
    // 已累计花费 50 元（直插带 cost 用量行），月预算 40 → 一切新承诺入口应拦
    await db.insert(usageRecords).values({
      projectId: scene.project.id, kind: 'tts', unit: 'char', quantity: 1000, unitPrice: 0.05, cost: 50, currency: 'CNY', meta: '{}', createdAt: now,
    } as never)
    await saveBudget({ projects: { [String(scene.project.id)]: { monthly: 40 } } })
    const { app } = await import('../src/app')
    const res = await app.request(`/api/v1/runs/${scene.run.id}/resume`, { method: 'POST' })
    const resBody = await res.json() as { error?: { code?: string } }
    check(res.status === 409 && resBody.error?.code === 'budget_monthly_exceeded',
      `G3 预算闸门：resume 超限拦截（${res.status}/${resBody.error?.code}）`)
    const { createBatch } = await import('../src/services/batch')
    let threw: unknown = null
    try {
      await createBatch({ projectId: scene.project.id, templateKey: 'quick-video', inputs: [{ idea: '超限一批' }] })
    } catch (err) { threw = err }
    check(threw instanceof BudgetBlockedError && threw.code === 'budget_monthly_exceeded',
      `G3 预算闸门：createBatch service 抛 BudgetBlockedError（实际 ${threw instanceof Error ? threw.constructor.name : String(threw)}）`)
    check((await db.select().from(batches)).length === batchesBefore, 'G3 预算闸门：超限批创建零新增落库（阶段 A/B 校验先于一切写）')
    const routeRes = await app.request(`/api/v1/projects/${scene.project.id}/batches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template_key: 'quick-video', inputs: [{ idea: '超限一批' }] }),
    })
    const routeBody = await routeRes.json() as { error?: { code?: string } }
    check(routeRes.status === 409 && routeBody.error?.code === 'budget_monthly_exceeded',
      `G3 预算闸门：POST /projects/:id/batches route 转 409（${routeRes.status}/${routeBody.error?.code}）`)
  },
} })
