/**
 * M48 离线探针：阶段二「统一取消 / 续跑 / 预算」执行保障（审计 F02 / F03-TTS / F06）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m48.ts [--section=cancel|resume|budget]
 *
 * 隔离策略：isolatedEnv('m48') 一次性临时目录（独立 studio.db + workspace），必须在任何 src 动态 import 前调用。
 * 零网络、零付费：globalThis.fetch 全阻断，仅放行 `${baseUrl}/audio/speech` 并计数——该计数即
 * 「向第三方提交一次合成请求」的计费替身，据此断言取消停提交 / 续跑不重复计费。
 *
 * 断言面：
 *  - cancel（F02）：run 在首句合成期间被置 cancelled → tts cooperative 退出抛 RunCancelledError，
 *    第二句不再提交（audioCount 恒为 1），任务终态 1 succeeded + 1 cancelled（不重复计费）；
 *  - resume（F03-TTS）：3 句首跑各提交一次；同 run/step 再执行 → 全 succeeded 复用既有音频资产，
 *    audioCount 不增、返回资产序列逐字一致、tts 用量行仍 3（续跑不二次计费）；
 *  - budget（F06）：未配置放行 → 月费超限 project → budget_monthly_exceeded → 高阈值放行 → 全局超限 budget_global_monthly_exceeded。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { isolatedEnv, makeChecker, runSections } from './probe-lib'

const { cleanup } = isolatedEnv('m48')
process.env.PROBE_M48_KEY = 'offline-m48'

const SECTIONS = ['cancel', 'resume', 'budget'] as const
const AUDIO_BASE = 'http://localhost:0/offline'

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m48')
const checker = makeChecker(log)
const check = checker.check

/* ------------------------------------------------------------------ */
/* fetch 替身：唯一放行 /audio/speech，其余触网即抛；audioCount = 计费替身 */
/* ------------------------------------------------------------------ */
let audioCount = 0
let onAudio: ((n: number) => Promise<void> | void) | null = null

function installStub(): void {
  audioCount = 0
  onAudio = null
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? String(input)
    if (url.includes('/audio/speech')) {
      audioCount += 1
      if (onAudio) await onAudio(audioCount)
      const bytes = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5])
      // 最小 Response 替身：synthSpeech 仅用 ok / status / arrayBuffer()
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer, text: async () => '' } as unknown as Response
    }
    throw new Error(`探针禁止网络请求: ${url}`)
  }) as typeof fetch
}

/** 重置 audio 实例（每节确定性：仅一条活跃 openai_audio 端点，pricing 空 → recordUsage 成本为 null 不污染预算） */
async function seedAudioConfig(): Promise<void> {
  const { db } = await import('../src/db')
  const { apiConfigs } = await import('../src/db/schema')
  const now = Date.now()
  await db.delete(apiConfigs)
  await db.insert(apiConfigs).values({
    name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts',
    apiKeyRef: 'env:PROBE_M48_KEY', baseUrl: AUDIO_BASE, extra: '{}', pricing: '{}',
    isActive: 1, isDefault: 1, priority: 0, createdAt: now, updatedAt: now,
  } as never)
}

/** 建 3 句台词 project/run/step + lines 文本资产 + 手工 StepContext（tts 只需 run/step/def/settings/assetIdsOf/readText/assetsOf/log） */
async function buildTtsScene(name: string, runStatus: string) {
  const { db } = await import('../src/db')
  const { projects, pipelineRuns, pipelineSteps, assets } = await import('../src/db/schema')
  const { eq, inArray } = await import('drizzle-orm')
  const { ensureProjectDirs, writeTextAsset, readTextAsset } = await import('../src/services/storage')
  const now = Date.now()
  const [project] = await db.insert(projects).values({ name, createdAt: now, updatedAt: now }).returning()
  const [run] = await db.insert(pipelineRuns).values({
    projectId: project!.id, templateKey: 'tts-probe', input: '{}', status: runStatus, createdAt: now, updatedAt: now,
  } as never).returning()
  const [step] = await db.insert(pipelineSteps).values({
    runId: run!.id, seq: 1, stepKey: 'voice', actionKey: 'tts', createdAt: now, updatedAt: now,
  } as never).returning()
  ensureProjectDirs(project!.id)
  const content = JSON.stringify({ lines: [
    { id: 'l1', text: '第一句台词内容测试' },
    { id: 'l2', text: '第二句台词内容测试' },
    { id: 'l3', text: '第三句台词内容测试' },
  ] })
  const la = await writeTextAsset(project!.id, { name: 'lines.json', purpose: 'lines', format: 'json', content })
  const ctx = {
    run: run!, step: step!,
    template: { key: 'tts-probe', version: 1, name: '探针', genre: 'story', inputs: [], steps: [] },
    def: { key: 'voice', action: 'tts', title: '配音', inputs: { lines: 'lines' } },
    input: { lines: [la.id] },
    settings: {},
    log: () => {},
    assetIdsOf: (k: string) => (k === 'lines' ? [la.id] : []),
    readText: (id: number) => readTextAsset(id),
    pathOf: async () => { throw new Error('probe 不支持 pathOf') },
    assetsOf: async (ids: number[]) => (ids.length ? db.select().from(assets).where(inArray(assets.id, ids)) : []),
  }
  return { db, project: project!, run: run!, step: step!, ctx: ctx as never, eq, inArray }
}

await runSections({ log, title: 'M48', checker, cleanup, sections: SECTIONS, registry: async () => {
  const { initDb } = await import('../src/db')
  await initDb()
  check(true, '初始化隔离库完成')
}, runners: {
  // ============ F02：取消协作停提交 ============
  cancel: async () => {
    const { tts } = await import('../src/pipeline/actions/tts')
    const { RunCancelledError } = await import('../src/pipeline/types')
    const { genTasks, pipelineRuns } = await import('../src/db/schema')
    const { and, eq } = await import('drizzle-orm')
    await seedAudioConfig()
    const { db, run, step, ctx } = await buildTtsScene('m48-cancel', 'running')
    installStub()
    // 首句合成完成时把 run 置 cancelled → 第二句合成前 runCancelled 命中退出
    onAudio = async (n) => { if (n === 1) await db.update(pipelineRuns).set({ status: 'cancelled' }).where(eq(pipelineRuns.id, run.id)) }
    let threw: unknown = null
    try { await tts(ctx) } catch (err) { threw = err }
    check(threw instanceof RunCancelledError, 'F02 取消：tts 抛 RunCancelledError（cooperative 退出）')
    check(audioCount === 1, `F02 取消：取消后第二句不再提交第三方（audioCount=${audioCount}，期望 1）`)
    const tasks = await db.select().from(genTasks).where(and(eq(genTasks.runId, run.id), eq(genTasks.stepId, step.id)))
    const succeeded = tasks.filter((t) => t.status === 'succeeded').length
    const cancelled = tasks.filter((t) => t.status === 'cancelled').length
    check(succeeded === 1 && cancelled === 1 && tasks.length === 3,
      `F02 取消：任务终态 1 succeeded + 1 cancelled + 1 pending（实际 ${succeeded}/${cancelled}/${tasks.length}）`)
  },

  // ============ F03-TTS：续跑复用不重复计费 ============
  resume: async () => {
    const { tts } = await import('../src/pipeline/actions/tts')
    const { usageRecords } = await import('../src/db/schema')
    const { and, eq } = await import('drizzle-orm')
    await seedAudioConfig()
    const { db, run, ctx } = await buildTtsScene('m48-resume', 'running')
    installStub()
    const first = await tts(ctx)
    check(audioCount === 3, `F03-TTS 首跑：3 句各提交一次（audioCount=${audioCount}）`)
    const firstIds = [...first.assetIds]
    check(firstIds.length === 3, 'F03-TTS 首跑：返回 3 个音频资产')
    // 续跑：同 run/step 再执行 → 全 succeeded → 复用不重复合成
    const second = await tts(ctx)
    check(audioCount === 3, `F03-TTS 续跑：零新增合成（audioCount 仍 ${audioCount}，不二次计费）`)
    check(JSON.stringify(second.assetIds) === JSON.stringify(firstIds), 'F03-TTS 续跑：返回资产序列与首跑逐字一致（复用既有产物）')
    const ttsUsage = await db.select().from(usageRecords).where(and(eq(usageRecords.runId, run.id), eq(usageRecords.kind, 'tts')))
    check(ttsUsage.length === 3, `F03-TTS 续跑：tts 用量行仍 3（续跑不重复计费，实际 ${ttsUsage.length}）`)
  },

  // ============ F06：预算闸门（run 创建 / workflow 首段同源） ============
  budget: async () => {
    const { db } = await import('../src/db')
    const { projects, usageRecords, settings } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { checkBudget, saveBudget } = await import('../src/services/budget')
    const now = Date.now()
    const [project] = await db.insert(projects).values({ name: 'm48-budget', createdAt: now, updatedAt: now }).returning()
    await db.delete(settings).where(eq(settings.key, 'budgets'))
    check(await checkBudget({ projectId: project!.id }) === null, 'F06 预算：未配置预算 → 放行（不拦截）')
    // 直接落一条带 cost 的月内用量（recordUsage 无 cost 入参，此处模拟已累计花费 50 元）
    await db.insert(usageRecords).values({
      projectId: project!.id, kind: 'tts', unit: 'char', quantity: 1000, unitPrice: 0.05, cost: 50, currency: 'CNY', meta: '{}', createdAt: now,
    } as never)
    await saveBudget({ projects: { [String(project!.id)]: { monthly: 40 } } })
    const hit = await checkBudget({ projectId: project!.id })
    check(hit?.code === 'budget_monthly_exceeded', `F06 预算：项目月度超限拦截（code=${hit?.code ?? 'null'}）`)
    await saveBudget({ projects: { [String(project!.id)]: { monthly: 500 } } })
    check(await checkBudget({ projectId: project!.id }) === null, 'F06 预算：未超限放行')
    await saveBudget({ global: { monthly: 10 } })
    const g = await checkBudget({ projectId: project!.id })
    check(g?.code === 'budget_global_monthly_exceeded', `F06 预算：全局月度超限拦截（code=${g?.code ?? 'null'}）`)
  },
} })
