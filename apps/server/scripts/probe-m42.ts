/**
 * M42 探针（轻松创作第二批：中途审阅暂停 / 候选版本选择 / 自然语言局部返修）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m42.ts [--section=review-template|review-chain|review-api|candidates|rework|messages]
 *
 * 隔离策略：isolatedEnv('m42') 一次性临时目录（独立 studio.db + workspace），必须在任何 src import 前调用。
 * 模板目录**只读拷贝**进隔离区（不 bridge，探针自建闸门模板不得写回仓库），prompts 走 junction 桥接。
 * 零网络、零付费：LLM/媒体 fetch 全部阻断；引擎执行链只在离线 literal 模板上真跑，
 * 涉及 easy-video* 真模板的分节一律先 stub engine.startRun（审阅决策仍走真 engine.approveGate/rejectGate）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, REPO_ROOT, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup, tmp } = isolatedEnv('m42', { bridge: ['prompts'] })
cpSync(join(REPO_ROOT, 'workspace', 'templates'), join(tmp, 'workspace', 'templates'), { recursive: true })
process.env.PROBE_M42_KEY = 'probe-offline-secret-key-42c7'

const SECTIONS = ['review-template', 'review-chain', 'review-api', 'candidates', 'rework', 'messages'] as const

/** 3 镜 × 10 秒 = 30 秒（与 M30 同夹具，最小化漂移） */
function makePlan(mode: 'dynamic' | 'slideshow') {
  return {
    title: '咖啡冲煮三分钟', summary: '用三段讲清风味来源', genre: 'science' as const, duration: 30,
    aspectRatio: '9:16' as const, language: 'zh-CN' as const, mode, style: '轻松科普',
    script: '豆子决定风味。\n水温影响萃取。\n研磨匹配时间。',
    lines: [
      { id: 'l1', text: '豆子决定风味' },
      { id: 'l2', text: '水温影响萃取' },
      { id: 'l3', text: '研磨匹配时间' },
    ],
    shots: [
      { id: 's1', duration: 10, image_prompt: '咖啡豆特写', motion_prompt: '缓慢推近', lines: ['l1'] },
      { id: 's2', duration: 10, image_prompt: '手冲注水', motion_prompt: '水流环绕', lines: ['l2'] },
      { id: 's3', duration: 10, image_prompt: '研磨刻度', motion_prompt: '镜头下移', lines: ['l3'] },
    ],
  }
}

/** 离线探针模板：literal 产物（零网络零计费）+ required 闸，用于真跑引擎的挂起/放行/驳回语义 */
const PROBE_TPL = `key: m42-gate-probe
version: 1
name: M42 闸门探针
description: 离线探针模板（literal 产物 + required gate），验证中途审阅暂停与决策续跑
genre: other
scene: produce
inputs:
  - { key: topic, label: 主题, kind: text, required: false, default: probe }
steps:
  - key: draft
    action: literal
    title: 生成待审草案
    inputs: {}
    params: { payload: '离线草案', name_tpl: 'draft.txt' }
    gate: { mode: required, message: '草案已生成，请审阅后继续' }
  - key: polish
    action: literal
    title: 审阅后终稿
    after: [draft]
    inputs: {}
    params: { payload: '终稿', name_tpl: 'final.txt' }
`

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m42')
  const checker: Checker = makeChecker(log)
  const check = checker.check
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('探针禁止外部网络') }

  const errOf = async (fn: () => Promise<unknown>): Promise<Error | null> => {
    try { await fn(); return null } catch (err) { return err instanceof Error ? err : new Error(String(err)) }
  }
  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    const e = await errOf(fn)
    return e && typeof (e as { code?: unknown }).code === 'string' ? (e as unknown as { code: string }).code : e ? 'other' : 'none'
  }
  const until = async (fn: () => Promise<boolean>, ms = 12000): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await fn()) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }

  const mkProject = async (name: string): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    return (await db.insert(projects).values({ name, genre: 'talking_head', templateKey: 'talking-clip', status: 'draft', settings: '{}', tags: '[]', createdAt: t, updatedAt: t }).returning())[0]!.id
  }

  type SeedOpts = { unpriced?: ('image' | 'video' | 'audio')[]; videoModel?: string; durations?: number[]; aspectRatios?: string[] }
  const seedEndpoints = async (over: SeedOpts = {}): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    await initDb()
    const { apiConfigs } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    for (const kind of ['llm', 'audio', 'image', 'video'] as const) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, kind))
    const t = Date.now()
    const price = (u: string): string => (over.unpriced ?? []).length ? JSON.stringify({}) : JSON.stringify({ [u]: 0.1 })
    const insert = (v: Record<string, unknown>): Promise<unknown> => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M42_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: v.pricing ?? '{}', isActive: v.isActive ?? 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
    await insert({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
    await insert({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', extra: { voice: 'alloy' }, pricing: price('char') })
    await insert({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: price('image') })
    await insert({
      name: 'video', providerKey: 'siliconflow_video', serviceType: 'video', model: over.videoModel ?? 'Wan2.2-I2V-A14B',
      extra: { creationCapabilities: { model: over.videoModel ?? 'Wan2.2-I2V-A14B', verified: true, modes: ['i2v', 't2v'], durations: over.durations ?? [10], aspectRatios: over.aspectRatios ?? ['9:16', '16:9', '1:1'], resolution: '720p' } },
      pricing: price('second'),
    })
  }

  /** 旁路 LLM 直建「待确认」会话（与 M30 同口径） */
  const makeReadySession = async (mode: 'dynamic' | 'slideshow') => {
    const { db } = await import('../src/db')
    const { creationSessions } = await import('../src/db/schema')
    const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
    const { preflightPlan } = await import('../src/services/creation-chat/preflight')
    const projectId = await mkProject(`probe-m42-${mode}-${Date.now()}`)
    const plan = creationPlanSchema.parse(makePlan(mode))
    const pf = await preflightPlan(projectId, plan)
    const t = Date.now()
    const [s] = await db.insert(creationSessions).values({
      projectId, requestKey: `m42ready${mode}${t}`, status: pf.ready ? 'ready' : 'draft', plan: JSON.stringify(plan),
      planRevision: 1, planHash: pf.execution ? hashJson({ plan, execution: pf.execution }) : null, preflight: JSON.stringify(pf), runHistory: '[]', createdAt: t, updatedAt: t,
    }).returning()
    return { projectId, sessionId: s!.id, plan, pf }
  }

  const runners: Record<string, () => Promise<void>> = {
    // ============ review-template：变体模板同构 / 确认选键 / 哈希收口 / 恢复路径零破坏 ============
    'review-template': async () => {
      const { db } = await import('../src/db')
      const { creationSessions, pipelineRuns, pipelineSteps, genTasks, projects } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { loadTemplate } = await import('../src/pipeline/loader')
      const { hashJson } = await import('../src/services/creation-chat/contract')
      const { CREATION_TEMPLATE_KEYS, isCreationTemplate, recipeOf, assertRecipeSources } = await import('../src/services/creation-chat/recipe')
      const { confirmCreation, retryCreation } = await import('../src/services/creation-chat/execution')
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      let started = 0
      engine.engine.startRun = ((runId: number) => { void runId; started += 1; return 'started' }) as typeof engine.engine.startRun

      try {
        check(isCreationTemplate('easy-video') && isCreationTemplate('easy-video-review') && isCreationTemplate('easy-dialogue') && isCreationTemplate('easy-dialogue-review') && CREATION_TEMPLATE_KEYS.size === 4 && !isCreationTemplate('quick-video') && !isCreationTemplate('talking-clip'), '创作模板键集合含旁白/对白原模板与审阅变体，且不误伤其它模板')
        const base = loadTemplate('easy-video')
        const variant = loadTemplate('easy-video-review')
        check(JSON.stringify(variant.steps.map((s) => ({ ...s, gate: undefined }))) === JSON.stringify(base.steps), '变体除 gate 外步骤定义逐字同构（inputs/params/batch/when/after 零漂移）')
        check(base.steps.every((s) => !s.gate), '原 easy-video 模板不含任何 gate（现存会话恢复路径零破坏）')
        check(variant.steps.filter((s) => s.gate).map((s) => s.key).join() === 'images,frames', '审阅闸只挂图文画面与动态首帧两步')
        check(variant.steps.every((s) => !s.gate?.skip_label), '变体不声明 skip_label（免审＝不勾选审阅，不提供闸门跳过入口）')
        check(!!variant.steps.find((s) => s.key === 'frames')?.gate?.message?.includes('动态镜头'), '首帧闸文案明告「继续后才开始高费用生成」')
        check(variant.inputs.map((i) => i.key).join() === base.inputs.map((i) => i.key).join(), '变体启动输入契约与原模板一致（run.input 复用）')

        await seedEndpoints()
        // —— 勾选审阅 → 变体模板 + 哈希按变体重算 ——
        const a = await makeReadySession('slideshow')
        const sA = (await db.select().from(creationSessions).where(eq(creationSessions.id, a.sessionId)))[0]!
        const runA = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, (await confirmCreation(a.sessionId, { planRevision: sA.planRevision, planHash: sA.planHash, idempotencyKey: 'm42revA0001', acceptUnpriced: false, reviewGate: true })).runId)))[0]!
        const recipeA = recipeOf(runA)!
        check(runA.templateKey === 'easy-video-review' && started === 1, '勾选「首帧后审阅」→ run 以变体模板启动并只启动一次')
        check(recipeA.templateHash === hashJson(loadTemplate('easy-video-review')), 'recipe 模板哈希按所选变体键重算')
        check(JSON.parse(String(runA.templateSnapshot)).steps.some((s: { key: string; gate?: unknown }) => s.key === 'images' && !!s.gate), 'run 模板快照固化 gate（执行期不读在线模板）')
        check((await errOf(() => assertRecipeSources(runA, recipeA))) === null, '审阅变体 run 的执行期自校验通过（recipe/快照/源资产三重一致）')
        const [projA] = await db.select().from(projects).where(eq(projects.id, a.projectId))
        check(projA!.templateKey === 'talking-clip' && projA!.status === 'active', '项目专业默认模板（talking-clip）与 run 执行模板（easy-video-review）解耦；确认不会把 easy-* 写回项目默认字段')
        check(sA.planHash === hashJson({ plan: a.plan, execution: a.pf.execution }), '审阅勾选不入 planHash（确认沿用原方案哈希）')

        // —— 不勾选 → 原模板零改动（与 M41 行为一致） ——
        const b = await makeReadySession('dynamic')
        const sB = (await db.select().from(creationSessions).where(eq(creationSessions.id, b.sessionId)))[0]!
        const runB = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, (await confirmCreation(b.sessionId, { planRevision: sB.planRevision, planHash: sB.planHash, idempotencyKey: 'm42revB0001', acceptUnpriced: false })).runId)))[0]!
        check(runB.templateKey === 'easy-video' && recipeOf(runB)!.templateHash === hashJson(loadTemplate('easy-video')), '未勾选审阅 → 仍用原模板与原哈希（默认行为零回归）')
        check(recipeOf({ ...runB, templateKey: 'ghost' }) === null && recipeOf({ ...runA, templateKey: 'quick-video' }) === null, '非创作模板不解析 recipe（不越界接管专业 run）')

        // —— 恢复路径：变体按自身键通过；哈希与原模板互换必须被拦 ——
        await db.update(pipelineRuns).set({ status: 'failed' }).where(eq(pipelineRuns.id, runA.id))
        const retriedA = await retryCreation(a.sessionId, { planRevision: sA.planRevision, planHash: sA.planHash, idempotencyKey: 'm42revA0002', acceptUnpriced: false, runId: runA.id })
        const runA2 = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, retriedA.runId)))[0]!
        check(runA2.id !== runA.id && runA2.templateKey === 'easy-video-review' && started === 3, '审阅会话断点恢复 → 新 run 沿用变体模板（原实现会误拦）')
        await db.update(pipelineRuns).set({ status: 'failed' }).where(eq(pipelineRuns.id, runA2.id))
        const wrongHash = JSON.stringify({ ...JSON.parse(String(JSON.parse(runA2.input).recipe)), templateHash: hashJson(loadTemplate('easy-video')) })
        await db.update(pipelineRuns).set({ input: JSON.stringify({ ...JSON.parse(runA2.input), recipe: wrongHash }) }).where(eq(pipelineRuns.id, runA2.id))
        const orphanErr = await errOf(() => retryCreation(a.sessionId, { planRevision: sA.planRevision, planHash: sA.planHash, idempotencyKey: 'm42revA0003', acceptUnpriced: false, runId: runA2.id }))
        check(!!orphanErr && /方案/.test(orphanErr.message), '只改 run 内 recipe 与已批准方案不一致 → 恢复被拦（不越权执行）')
        await db.update(creationSessions).set({ approvedPlan: wrongHash }).where(eq(creationSessions.id, a.sessionId))
        const tamperErr = await errOf(() => retryCreation(a.sessionId, { planRevision: sA.planRevision, planHash: sA.planHash, idempotencyKey: 'm42revA0004', acceptUnpriced: false, runId: runA2.id }))
        check(!!tamperErr && /模板/.test(tamperErr.message), '审阅 run 的哈希被换成原模板值 → 执行期与恢复期双重拦截')
        await db.update(pipelineRuns).set({ status: 'failed' }).where(eq(pipelineRuns.id, runB.id))
        check((await retryCreation(b.sessionId, { planRevision: sB.planRevision, planHash: sB.planHash, idempotencyKey: 'm42revB0002', acceptUnpriced: false, runId: runB.id })).runId > 0, '原 easy-video 失败会话恢复仍通过（模板未变，零破坏）')
        // 恢复产生的 queued run 在本节不会真启动；先落终态，避免下游导入 app 时的启动恢复发出媒体请求
        await db.update(pipelineRuns).set({ status: 'failed' }).where(eq(pipelineRuns.status, 'queued'))

        // —— [方案C] 专业端不得直接「启动」创作模板；但「续跑」改为委派会话恢复真源 retryCreation：
        //     干净失败 run 就地安全续跑，被篡改/有状态不明任务的 run 仍被 retryCreation 各守卫 409 拦截 ——
        const { app } = await import('../src/app')
        const direct = await app.request(`/api/v1/projects/${a.projectId}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template_key: 'easy-video-review', input: {} }) })
        check(direct.status === 400, '项目页直启审阅变体 run → 400（仍须从会话确认方案）')
        // 被篡改哈希的 runA2：专业 resume 委派 retryCreation → assertRecipeSources 抛停机型普通 Error（模板版本漂移），
        // 专业端无法处理 → 统一归为须回会话核验 409 creation_confirmation_required（不泄漏成 400、不落朴素 generic resume）
        const resume = await app.request(`/api/v1/runs/${runA2.id}/resume`, { method: 'POST' })
        const resumeBody = (await resume.json()) as { error?: { code?: string; message?: string } }
        check(resume.status === 409 && String(resumeBody.error?.code) === 'creation_confirmation_required', 'C：被篡改创作 run 走专业 resume → 委派 retryCreation 命中模板漂移守卫，映射为 409 引导回会话（防越权/重复计费）')
        // 全新干净失败 run（无 gen_tasks → 无状态不明任务、recipe 未篡改）：专业 resume 就地委派恢复成功、产出新 run
        const c3 = await makeReadySession('slideshow')
        const sC = (await db.select().from(creationSessions).where(eq(creationSessions.id, c3.sessionId)))[0]!
        const runC = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, (await confirmCreation(c3.sessionId, { planRevision: sC.planRevision, planHash: sC.planHash, idempotencyKey: 'm42pro-clean-1', acceptUnpriced: false })).runId)))[0]!
        await db.update(pipelineRuns).set({ status: 'failed' }).where(eq(pipelineRuns.id, runC.id))
        const resumeC = await app.request(`/api/v1/runs/${runC.id}/resume`, { method: 'POST' })
        const bodyC = (await resumeC.json()) as { run?: { id?: number } }
        check(resumeC.status === 202 && typeof bodyC.run?.id === 'number' && bodyC.run.id > runC.id, 'C：干净失败创作 run 专业 resume 就地委派 retryCreation 成功、返回续跑新 run（免跳会话）')
        // 会话已把 runId 前移到续跑新 run：原 runC 再 resume → 无归属会话 → 409 creation_confirmation_required
        const resumeC2 = await app.request(`/api/v1/runs/${runC.id}/resume`, { method: 'POST' })
        check(resumeC2.status === 409 && String((await resumeC2.json() as { error?: { code?: string } }).error?.code) === 'creation_confirmation_required', 'C：会话 runId 已前移，原失败 run 再 resume → 409 引导回会话（避免脱离会话状态机）')
        // [方案C 同源收口] 级联重跑也是重复计费入口：含「受理状态不明」任务的失败创作 run，
        // 级联会重置链内非成功任务（歧义任务无 task_id 可续轮询→引擎重新提交）→ assertChainRepairable 必须与 resume 同源 409
        const c4 = await makeReadySession('slideshow')
        const sC4 = (await db.select().from(creationSessions).where(eq(creationSessions.id, c4.sessionId)))[0]!
        const runC4 = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, (await confirmCreation(c4.sessionId, { planRevision: sC4.planRevision, planHash: sC4.planHash, idempotencyKey: 'm42-casc-amb-1', acceptUnpriced: false })).runId)))[0]!
        await db.update(pipelineRuns).set({ status: 'failed' }).where(eq(pipelineRuns.id, runC4.id))
        // 引擎 startRun 被 stub → createRunRow 不会懒建步骤行；此处手建一步供歧义任务 FK 挂载（assertChainRepairable 的
        // 创作+歧义守卫先于步骤解析，故级联预览必然 409）
        const tC4 = Date.now()
        const [firstStep] = await db.insert(pipelineSteps).values({ runId: runC4.id, seq: 1, stepKey: 'images', actionKey: 'ai_image', title: '生成画面', status: 'failed', createdAt: tC4, updatedAt: tC4 }).returning()
        await db.insert(genTasks).values({ projectId: c4.projectId, runId: runC4.id, stepId: firstStep!.id, kind: 'image', params: '{}', status: 'failed', attempts: 1, errorMsg: '已提交无回执', createdAt: tC4, updatedAt: tC4 })
        const cascadePrev = await app.request(`/api/v1/runs/${runC4.id}/steps/images/rerun-cascade`, { method: 'GET' })
        const cascadeBody = (await cascadePrev.json()) as { error?: { code?: string } }
        check(cascadePrev.status === 409 && String(cascadeBody.error?.code) === 'creation_confirmation_required', 'C：含受理状态不明任务的创作 run 级联重跑预览 → 409 同源拦截（防级联重新提交重复扣费）')
      } finally {
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },

    // ============ review-chain：引擎真跑离线闸门（挂起 / 放行续跑 / 驳回重跑） ============
    'review-chain': async () => {
      const { initDb, db } = await import('../src/db')
      const { pipelineRuns, pipelineSteps } = await import('../src/db/schema')
      const { eq, and } = await import('drizzle-orm')
      const { saveTemplate } = await import('../src/pipeline/loader')
      const { createRunRow } = await import('../src/services/run-create')
      const { ensureProjectDirs } = await import('../src/services/storage')
      const { engine } = await import('../src/pipeline/engine')
      await initDb()
      saveTemplate('m42-gate-probe', PROBE_TPL)
      const runOf = async (id: number) => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)))[0]!
      const stepOf = async (runId: number, key: string) => (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, key))))[0]!

      const projectId = await mkProject('m42-chain')
      ensureProjectDirs(projectId)
      const run = await createRunRow({ projectId, templateKey: 'm42-gate-probe', input: { topic: '闸门' } })
      engine.startRun(run.id)
      check(await until(async () => (await runOf(run.id)).status === 'waiting_input'), '闸门步骤产物完成后 run 挂起为 waiting_input（引擎既有语义）')
      const hung = await runOf(run.id)
      const draft = await stepOf(run.id, 'draft')
      check(draft.status === 'waiting_input' && !!draft.output?.includes('asset_ids'), '挂起发生在产物落地之后：本步保留待审产物而非空挂')
      check((await stepOf(run.id, 'polish')).status === 'pending', '审阅未决策前下游步骤不启动（费用与产物都不继续）')
      check(hung.currentStepKey === 'draft', 'run.currentStepKey 指向待审步骤（前端定位面板）')
      const projected = JSON.stringify({ status: hung.status, current: hung.currentStepKey })
      check(projected.includes('waiting_input'), '等待态可被投影透传（不改引擎状态语义）')

      await engine.approveGate(run.id, 'draft', { note: '画面可以' })
      check(await until(async () => (await runOf(run.id)).status === 'completed'), '放行 → 自动续跑至完成')
      const approved = await stepOf(run.id, 'draft')
      check(approved.status === 'succeeded' && JSON.parse(approved.output!).gate?.decision === 'approve' && !!approved.output?.includes('画面可以'), 'approve 落本步 succeeded 并留决策与意见痕迹')
      check((await stepOf(run.id, 'polish')).status === 'succeeded', '下游步骤在放行后才执行（顺序可信）')

      const run2 = await createRunRow({ projectId, templateKey: 'm42-gate-probe', input: { topic: '闸门' } })
      engine.startRun(run2.id)
      check(await until(async () => (await runOf(run2.id)).status === 'waiting_input'), '第二次制作同样在闸前挂起（闸门不被上次决策记忆）')
      await engine.rejectGate(run2.id, 'draft', { note: '重做' })
      const rejected = await stepOf(run2.id, 'draft')
      check(rejected.status === 'pending' && !!rejected.output?.includes('reject'), '驳回 → 本步回到 pending，修改意见留在 output')
      check(await until(async () => (await runOf(run2.id)).status === 'completed'), '驳回后该步整体重跑并继续（引擎既有语义：重跑轮不再二次挂起）')
      const rerun = await stepOf(run2.id, 'draft')
      check(rerun.attempts === 2 && rerun.status === 'succeeded', '驳回＝整步重做（attempts+1，产物重新生成＝可能再次计费）')
      const sameRun = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run2.id))
      check(sameRun.length === 1, '驳回重跑在原 run 内推进，不新建 run（与会话恢复路径区分）')
    },

    // ============ review-api：会话侧闸门代理端点（决策 / 幂等 / 归属 / 文案 / 投影） ============
    'review-api': async () => {
      const { db } = await import('../src/db')
      const { creationMessages, creationSessions, pipelineRuns, pipelineSteps } = await import('../src/db/schema')
      const { and, eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { creationDetail } = await import('../src/services/creation-chat/store')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')
      const { ensureProjectDirs, relPathOf, absPathOf, registerAsset } = await import('../src/services/storage')
      const { writeFileSync } = await import('node:fs')
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      engine.engine.startRun = ((runId: number) => { void runId; return 'started' }) as typeof engine.engine.startRun

      // 真模板 run 的媒体步骤无法离线执行 → 按引擎落库口径直插「等待审阅」步骤行，再走真 engine 决策
      const waitingRun = async (mode: 'dynamic' | 'slideshow', stepKey: string, title: string) => {
        const ready = await makeReadySession(mode)
        const s = (await db.select().from(creationSessions).where(eq(creationSessions.id, ready.sessionId)))[0]!
        const { runId } = await confirmCreation(ready.sessionId, { planRevision: s.planRevision, planHash: s.planHash, idempotencyKey: `m42api${stepKey}${Date.now()}`, acceptUnpriced: false, reviewGate: true })
        ensureProjectDirs(ready.projectId)
        const seq = ['voice', 'captions', 'images', 'frames', 'motion', 'compose']
        await db.insert(pipelineSteps).values(seq.map((key, i) => ({
          runId, seq: i, stepKey: key, actionKey: key === 'voice' ? 'tts' : key === 'compose' ? 'ffmpeg_merge' : 'ai_image', title: key,
          status: key === stepKey ? 'waiting_input' : i < seq.indexOf(stepKey) ? 'succeeded' : 'pending', createdAt: Date.now(), updatedAt: Date.now(),
        })))
        const rel = relPathOf(ready.projectId, 'shot_image', `${stepKey}-${Date.now()}.txt`)
        writeFileSync(absPathOf(rel), 'offline-fixture')
        const asset = await registerAsset(ready.projectId, { name: `${stepKey}-1`, kind: 'image', relPath: rel, runId, params: { shotId: 's1' } })
        await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [asset.id] }) }).where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, stepKey)))
        await db.update(pipelineRuns).set({ status: 'waiting_input', currentStepKey: stepKey }).where(eq(pipelineRuns.id, runId))
        return { ...ready, runId }
      }
      const post = (id: number, data: unknown) => app.request(`/api/v1/creation-sessions/${id}/gate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      const stepRow = async (runId: number, key: string) => (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, key))))[0]!
      const gateMessages = async (id: number) => (await db.select().from(creationMessages).where(eq(creationMessages.sessionId, id))).filter((m) => JSON.parse(String(m.payload)).kind === 'gate')

      try {
        check((await post(999999, { stepKey: 'images', decision: 'approve', idempotencyKey: 'm42gate-404-1' })).status === 404, '不存在的会话 → 404（不新建兜底行）')
        // —— approve 通路 ——
        const a = await waitingRun('slideshow', 'images', '生成图文画面')
        const pending = await creationDetail(a.sessionId)
        check(pending.progress?.status === 'waiting_input' && pending.progress?.review?.stepKey === 'images', '详情投影透出等待审阅态与挂起步')
        check(!!pending.progress?.review?.message?.includes('图文画面已生成'), '审阅文案取自 run 冻结模板快照（不是在线模板）')
        check(pending.progress?.stages.find((s) => s.key === 'images')?.status === 'waiting_input', '阶段状态透出待审阅（前端可标「待审阅」）')
        check((await creationDetail(a.sessionId)).progress?.steps.find((s) => s.key === 'compose')?.status === 'pending', '审阅期间下游步骤仍未启动')
        const ok = await post(a.sessionId, { stepKey: 'images', decision: 'approve', note: '构图可以', idempotencyKey: 'm42gate-a-1' })
        const body = await ok.json() as { progress?: { review?: unknown }; messages?: unknown[] }
        check(ok.status === 200 && !!body.progress, 'approve 决策返回最新详情快照')
        const approvedStep = await stepRow(a.runId, 'images')
        check(approvedStep.status === 'succeeded' && JSON.parse(String(approvedStep.output)).gate?.decision === 'approve', '会话侧决策走真引擎闸门（本步定稿）')
        check(body.progress?.review == null && (await creationDetail(a.sessionId)).progress?.review == null, '决策后审阅面板条件消失（不再重复出面板）')
        const msgs = await gateMessages(a.sessionId)
        check(msgs.length === 1 && msgs[0]!.role === 'system' && msgs[0]!.content.includes('继续制作'), '决策以可见消息进对话流（system 角色，不进后续规划上下文）')
        const replay = await post(a.sessionId, { stepKey: 'images', decision: 'approve', idempotencyKey: 'm42gate-a-1' })
        check(replay.status === 200 && (await gateMessages(a.sessionId)).length === 1, '同幂等键重放 → 不重复决策、不重复留言（网络重试安全）')
        // —— reject 通路（含计费警示） ——
        const b = await waitingRun('dynamic', 'frames', '生成动态镜头首帧')
        const rej = await post(b.sessionId, { stepKey: 'frames', decision: 'reject', note: '主体不对', idempotencyKey: 'm42gate-b-1' })
        const rejStep = await stepRow(b.runId, 'frames')
        check(rej.status === 200 && rejStep.status === 'pending' && JSON.parse(String(rejStep.output)).gate?.note === '主体不对', 'reject → 该阶段整步重做，意见留痕并注入重跑输入')
        const rejMsg = (await gateMessages(b.sessionId))[0]!
        check(rejMsg.content.includes('费用') && rejMsg.content.includes('整体重做'), '驳回消息明告将重新生成并可能计费（不静默扣费）')
        // —— 边界与归属守卫 ——
        const wrongStep = await post(a.sessionId, { stepKey: 'motion', decision: 'approve', idempotencyKey: 'm42gate-a-2' })
        check(wrongStep.status === 409 && String((await wrongStep.json() as { error?: { code?: string } }).error?.code) === 'not_waiting', '非等待步决策 → 409 not_waiting（不瞎改状态）')
        const badBody = await post(a.sessionId, { stepKey: 'images', decision: 'skip', idempotencyKey: 'm42gate-a-3' })
        check(badBody.status === 422, 'decision 非 approve|reject → 422（会话侧不放开 skip）')
        const extraKey = await post(a.sessionId, { stepKey: 'images', decision: 'approve', idempotencyKey: 'm42gate-a-4', hacker: 1 })
        check(extraKey.status === 422, '未知字段被 .strict() 拒绝')
        const missingKey = await post(a.sessionId, { stepKey: 'images', decision: 'approve' })
        check(missingKey.status === 422, '缺幂等键的决策被拒（拒绝不可重试的写操作）')
        const noRun = await makeReadySession('slideshow')
        check((await post(noRun.sessionId, { stepKey: 'images', decision: 'approve', idempotencyKey: 'm42gate-c-1' })).status === 409, '尚未开始制作的会话 → 409（没有待审阅内容）')
        const foreign = await mkProject('m42-foreign')
        const [foreignRun] = await db.insert(pipelineRuns).values({ projectId: foreign, templateKey: 'm42-gate-probe', status: 'waiting_input', input: '{}', createdAt: Date.now(), updatedAt: Date.now() }).returning()
        await db.update(creationSessions).set({ runId: foreignRun!.id }).where(eq(creationSessions.id, b.sessionId))
        check((await post(b.sessionId, { stepKey: 'frames', decision: 'approve', idempotencyKey: 'm42gate-b-2' })).status === 409, '会话指向他项目 run → 409 归属拦截（不越权决策）')
      } finally {
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },

    // ============ candidates：多版本候选投影 / 选定补全提交 / 本地重合成（零模型调用） ============
    candidates: async () => {
      const { db, initDb } = await import('../src/db')
      const { assets, creationMessages, creationSessions, genTasks, pipelineRuns, pipelineSteps } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
      const { creationDetail } = await import('../src/services/creation-chat/store')
      const { ensureProjectDirs, registerAsset, relPathOf, absPathOf, writeTextAsset } = await import('../src/services/storage')
      const { writeFileSync, rmSync } = await import('node:fs')
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      let starts = 0
      engine.engine.startRun = ((runId: number) => { starts += 1; void runId; return 'started' }) as typeof engine.engine.startRun
      // 任何外部请求都必须被看见（计数后照旧阻断）：选片/重合成不得触发模型
      let netCalls = 0
      const blocker = globalThis.fetch
      globalThis.fetch = async (input) => { netCalls += 1; void input; throw new Error('探针禁止外部网络') }
      await initDb()

      try {
        const plan = creationPlanSchema.parse(makePlan('dynamic'))
        const projectId = await mkProject('m42-cand')
        ensureProjectDirs(projectId)
        const sb = await writeTextAsset(projectId, { name: '已批准分镜.json', purpose: 'storyboard', format: 'storyboard-json', content: JSON.stringify(plan.shots), params: {} })
        const [run] = await db.insert(pipelineRuns).values({ projectId, templateKey: 'easy-video', status: 'completed', input: JSON.stringify({ shots: [sb.id] }), createdAt: Date.now(), updatedAt: Date.now() }).returning()
        const runId = run!.id
        const defs: Array<[string, string]> = [['voice', 'tts'], ['captions', 'subtitle'], ['images', 'ai_image'], ['frames', 'ai_image'], ['motion', 'ai_video'], ['compose', 'ffmpeg_merge']]
        const stepRows = await db.insert(pipelineSteps).values(defs.map(([key, action], i) => ({
          runId, seq: i, stepKey: key, actionKey: action, title: key, status: 'succeeded',
          input: action === 'ai_image' || action === 'ai_video' ? JSON.stringify({ shots: [sb.id] }) : null,
          createdAt: Date.now(), updatedAt: Date.now(),
        }))).returning()
        const step = (key: string) => stepRows.find((s) => s.stepKey === key)!
        const [session] = await db.insert(creationSessions).values({
          projectId, requestKey: `m42cand${Date.now()}`, status: 'started', plan: JSON.stringify(plan), approvedPlan: JSON.stringify(plan),
          planRevision: 1, planHash: '0'.repeat(64), runHistory: '[]', runId, createdAt: Date.now(), updatedAt: Date.now(),
        }).returning()
        const sessionId = session!.id
        const img = async (name: string, shotId: string, taskId?: number, missing = false) => {
          const rel = relPathOf(projectId, 'images', `${name}.txt`)
          writeFileSync(absPathOf(rel), 'offline-fixture')
          const a = await registerAsset(projectId, { name, kind: 'image', relPath: rel, runId, stepId: step('frames').id, taskId, params: { shotId } })
          if (missing) rmSync(absPathOf(rel), { force: true })
          return a
        }
        const [task1] = await db.insert(genTasks).values({ projectId, runId, stepId: step('frames').id, kind: 'image', params: JSON.stringify({ shotId: 's1' }), status: 'succeeded', attempts: 2, createdAt: Date.now(), updatedAt: Date.now() }).returning()
        // 第 1 镜三个版本：在用 v1（重生成后用户又选回旧版）、任务最新 v2、文件已丢 v3
        const v1 = await img('f1a', 's1', task1!.id)
        const v2 = await img('f1b', 's1', task1!.id)
        const v3 = await img('f1c', 's1', task1!.id, true)
        const others = [await img('f2', 's2'), await img('f3', 's3')]
        await db.update(genTasks).set({ resultAssetId: v2.id }).where(eq(genTasks.id, task1!.id))
        const framesOut = [v1.id, others[0]!.id, others[1]!.id]
        await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: framesOut }) }).where(eq(pipelineSteps.id, step('frames').id))

        const detail0 = await creationDetail(sessionId)
        const cand0 = detail0.artifacts.shots[0]!.image
        check(cand0.candidates.length === 3 && cand0.selected?.assetId === v1.id, '同镜多版本全部可见，在用者为 output 里的那一版')
        check(cand0.candidates.some((c) => c.assetId === v2.id && c.available) && cand0.candidates.find((c) => c.assetId === v3.id)?.available === false, '缺文件的候选以不可用占位保留（不静默消失）')
        check(detail0.artifacts.shots[1]!.image.candidates.length === 1 && detail0.artifacts.shots[2]!.image.candidates.length === 1, '无多版本的镜头只有一个候选（不虚构选择）')
        check(!JSON.stringify(detail0.artifacts).includes('relPath') && !JSON.stringify(detail0.artifacts).includes(tmp), '候选视图只含安全元信息，不外泄本地路径')

        const get = (q: string) => app.request(`/api/v1/creation-sessions/${sessionId}/board?${q}`)
        const boardRes = await get('step=frames')
        const board = await boardRes.json() as { shots?: Array<{ shotId: string; versions: unknown[]; selectedAssetId: number | null }>; repairable?: { ok: boolean } }
        check(boardRes.status === 200 && board.shots?.[0]?.versions.length === 3 && board.shots[0].selectedAssetId === v1.id && board.repairable?.ok === true, '候选看板直返工作台同一份聚合（版本×在用×可返修）')
        check((await get('step=compose')).status === 400 && (await get('step=motion')).status === 200, 'step 白名单只放开生成步（合成步无选片语义）')
        check((await app.request('/api/v1/creation-sessions/999999/board?step=frames')).status === 404, '不存在的会话 → 404')
        const [noRunSession] = await db.insert(creationSessions).values({ projectId, requestKey: `m42candnorun${Date.now()}`, status: 'draft', plan: JSON.stringify(plan), runHistory: '[]', createdAt: Date.now(), updatedAt: Date.now() }).returning()
        check((await app.request(`/api/v1/creation-sessions/${noRunSession!.id}/board?step=frames`)).status === 409, '尚未开始制作的会话 → 409（没有可候选版本）')

        const postSel = (data: unknown, sid = sessionId) => app.request(`/api/v1/creation-sessions/${sid}/selection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        // —— 只提一镜，其余镜头服务端补全为全量（子集替换语义不外露） ——
        const sel = await postSel({ stepKey: 'frames', picks: [{ shot_id: 's1', asset_id: v2.id }], idempotencyKey: 'm42sel-1' })
        const selBody = await sel.json() as { artifacts?: typeof detail0.artifacts }
        const out1 = JSON.parse(String((await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, step('frames').id)))[0]!.output)).asset_ids as number[]
        check(sel.status === 200 && out1.length === 3 && out1[0] === v2.id && out1[1] === others[0]!.id && out1[2] === others[1]!.id, '漏提镜头不被剔除：服务端按在用值补全为全量')
        check(selBody.artifacts?.shots[0]?.image.selected?.assetId === v2.id, '选定返回的最新详情里在用版本已切换')
        // —— 归属与状态守卫 ——
        const foreignProject = await mkProject('m42-cand-foreign')
        ensureProjectDirs(foreignProject)
        const foreign = await img('foreign', 's1')
        await db.update(assets).set({ projectId: foreignProject }).where(eq(assets.id, foreign.id))
        const delAsset = await img('deleted', 's2')
        await db.update(assets).set({ deletedAt: Date.now() }).where(eq(assets.id, delAsset.id))
        const crossRun = await registerAsset(projectId, { name: 'crossrun', kind: 'image', relPath: relPathOf(projectId, 'images', 'crossrun.txt'), runId: 999999, stepId: 999999, params: { shotId: 's3' } })
        const bad = async (picks: Array<{ shot_id: string; asset_id: number }>) => await postSel({ stepKey: 'frames', picks, idempotencyKey: `m42sel-${picks[0]!.asset_id}` })
        check((await bad([{ shot_id: 's1', asset_id: foreign.id }])).status === 400, '他项目资产被拒（不越权选片）')
        check((await bad([{ shot_id: 's2', asset_id: delAsset.id }])).status === 400, '已删除资产不可选定')
        check((await bad([{ shot_id: 's3', asset_id: crossRun.id }])).status === 400, '跨 run 资产不可选定（不越权引用）')
        const afterBad = JSON.parse(String((await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, step('frames').id)))[0]!.output)).asset_ids as number[]
        check(JSON.stringify(afterBad) === JSON.stringify(out1), '被拒的提交不产生部分改写（校验先于写入）')
        check((await postSel({ stepKey: 'frames', picks: [{ shot_id: 'ghost', asset_id: v1.id }], idempotencyKey: 'm42sel-ghost' })).status === 409, '分镜里不存在的镜头 → 409（不静默接受幽灵 id）')
        check((await postSel({ stepKey: 'frames', picks: [{ shot_id: 's1', asset_id: v1.id }], idempotencyKey: 'm42sel-x', hacker: 1 })).status === 422, '未知字段被 .strict() 拒绝')
        check((await postSel({ stepKey: 'frames', picks: [{ shot_id: 's1', asset_id: v1.id }] })).status === 422, '缺幂等键的写操作被拒')
        await db.update(pipelineRuns).set({ status: 'waiting_input' }).where(eq(pipelineRuns.id, runId))
        const activeRes = await bad([{ shot_id: 's1', asset_id: v1.id }])
        const activeCode = String((await activeRes.json() as { error?: { code?: string } }).error?.code)
        check(activeRes.status === 400 && activeCode === 'run_active', '等待审阅/在途期间不得改选版本（run_active 门禁原样透传，不塌成 503）')
        await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, runId))

        // —— 本地重合成：只重置合成步，零模型调用 ——
        const postRec = (data: unknown) => app.request(`/api/v1/creation-sessions/${sessionId}/recompose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        const rec = await postRec({ idempotencyKey: 'm42rec-1' })
        const recBody = await rec.json() as { progress?: { status: string }; messages?: Array<{ payload: unknown; role: string }> }
        const composeRow = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, step('compose').id)))[0]!
        const queuedRun = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0]!
        check(rec.status === 202 && composeRow.status === 'pending' && queuedRun.status === 'queued' && starts === 1, '重新合成 → 仅合成步回 pending、run 转排队并启动一次')
        check(netCalls === 0, '选片与重新合成全程零外部请求（本地合成，不调用付费模型）')
        const recMsgs = (await db.select().from(creationMessages).where(eq(creationMessages.sessionId, sessionId))).filter((m) => JSON.parse(String(m.payload)).kind === 'recompose')
        check(recMsgs.length === 1 && recMsgs[0]!.role === 'system' && recMsgs[0]!.content.includes('本地合成'), '重合成以可见 system 消息进对话流（不进 LLM 上下文）')
        check(recBody.progress?.status === 'queued' && !!recBody.messages?.some((m) => JSON.stringify(m.payload).includes('recompose')), '决策后返回最新快照（前端据此继续轮询回显新成片）')
        await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, runId))
        await db.update(pipelineSteps).set({ status: 'succeeded' }).where(eq(pipelineSteps.id, step('compose').id))
        const replay = await postRec({ idempotencyKey: 'm42rec-1' })
        const replayCompose = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, step('compose').id)))[0]!
        const replayMsgs = (await db.select().from(creationMessages).where(eq(creationMessages.sessionId, sessionId))).filter((m) => JSON.parse(String(m.payload)).kind === 'recompose')
        check(replay.status === 202 && starts === 1 && replayCompose.status === 'succeeded' && replayMsgs.length === 1, '同幂等键重放 → 不二次重置、不二次启动、不重复留言')
        const finalRel = relPathOf(projectId, 'exports', 'new-final.txt')
        writeFileSync(absPathOf(finalRel), 'offline-fixture')
        const newerFinal = await registerAsset(projectId, { name: 'new-final', kind: 'video', purpose: 'final_video', relPath: finalRel, runId, params: { delivery_checked: true } })
        const finalDetail = await creationDetail(sessionId)
        check(finalDetail.result?.videoId === newerFinal.id && finalDetail.artifacts.shots[0]?.image.candidates.length === 3, '重合成后详情指向最新合格成片（不回退旧版），候选版本仍可见')
        check(netCalls === 0 && (await creationDetail(999999).catch(() => null)) === null, '详情读取不触发任何外部调用；不存在会话按错误处理')
      } finally {
        globalThis.fetch = blocker
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },

    // ============ rework：一句话定位镜头 → LLM 解析预览 → 显式确认 → 批准链同事务改写 + 只重置目标镜 ============
    rework: async () => {
      const { db, initDb } = await import('../src/db')
      const { assets, creationMessages, creationSessions, genTasks, pipelineRuns, pipelineSteps } = await import('../src/db/schema')
      const { and, eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { ensureProjectDirs, readTextAsset } = await import('../src/services/storage')
      const { hashJson } = await import('../src/services/creation-chat/contract')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')
      const { assertRecipeSources, recipeOf } = await import('../src/services/creation-chat/recipe')
      const { resetShotsForRework } = await import('../src/services/shot/reset')
      const { creationDetail } = await import('../src/services/creation-chat/store')
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      let starts = 0
      engine.engine.startRun = ((runId: number) => { starts += 1; void runId; return 'started' }) as typeof engine.engine.startRun
      type Preview = Awaited<ReturnType<typeof import('../src/services/creation-chat/rework').planRework>>
      type PlanBody = { reworkPreview?: Preview }
      type ApplyBody = { progress?: { status: string }; artifacts?: { documents: Array<{ assetId: number; label: string }> } }
      // 只允许文本模型端点：任何媒体域名直接抛错（解析与确认全程零媒体计费）
      let llmCalls = 0
      let mediaCalls = 0
      let llmReply = '{}'
      const blocker = globalThis.fetch
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (!url.startsWith('http://localhost:0/offline')) throw new Error('探针禁止外部网络')
        if (!url.includes('/chat/completions')) {
          mediaCalls += 1
          throw new Error('返修本身不得直接调媒体生成')
        }
        llmCalls += 1
        void init
        return Response.json({ choices: [{ message: { content: llmReply }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } })
      }
      await initDb()

      /** 已完成制作的批准链会话：走真 confirmCreation（recipe/源资产/模板快照全真实），只把执行痕迹手工补齐 */
      const fixture = async (mode: 'dynamic' | 'slideshow', over: SeedOpts = {}) => {
        await seedEndpoints(over)
        const ready = await makeReadySession(mode)
        const s = (await db.select().from(creationSessions).where(eq(creationSessions.id, ready.sessionId)))[0]!
        const { runId } = await confirmCreation(ready.sessionId, { planRevision: s.planRevision, planHash: s.planHash, idempotencyKey: `m42rwf${Date.now()}${mode}`, acceptUnpriced: true })
        ensureProjectDirs(ready.projectId)
        const t = Date.now()
        const defs: Array<[string, string]> = [['voice', 'tts'], ['captions', 'subtitle'], ['images', 'ai_image'], ['frames', 'ai_image'], ['motion', 'ai_video'], ['compose', 'ffmpeg_merge']]
        const stepRows = await db.insert(pipelineSteps).values(defs.map(([key, action], i) => ({ runId, seq: i, stepKey: key, actionKey: action, title: key, status: 'succeeded', createdAt: t, updatedAt: t }))).returning()
        const stepId = (k: string) => stepRows.find((r) => r.stepKey === k)!.id
        for (const [k, kind, field] of [['images', 'image', 'image_prompt'], ['motion', 'video', 'motion_prompt']] as const) {
          await db.insert(genTasks).values(ready.plan.shots.map((sh) => ({
            projectId: ready.projectId, runId, stepId: stepId(k), kind, prompt: String(sh[field]),
            params: JSON.stringify({ shotId: sh.id }), status: 'succeeded', attempts: 1, createdAt: t, updatedAt: t,
          })))
        }
        await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, runId))
        const taskRow = async (k: string, shotId: string) => (await db.select().from(genTasks).where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, stepId(k))))).find((x) => JSON.parse(String(x.params)).shotId === shotId)!
        const stepRow = async (k: string) => (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, k))))[0]!
        const runRow = async () => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0]!
        const sessRow = async () => (await db.select().from(creationSessions).where(eq(creationSessions.id, ready.sessionId)))[0]!
        const msgs = async (kind: string) => (await db.select().from(creationMessages).where(eq(creationMessages.sessionId, ready.sessionId))).filter((m) => JSON.parse(String(m.payload)).kind === kind)
        return { ...ready, runId, taskRow, stepRow, runRow, sessRow, msgs }
      }
      const post = (sid: number, tail: string, data: unknown) => app.request(`/api/v1/creation-sessions/${sid}/${tail}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      const errCode = async (res: Response): Promise<string> => String((await res.json() as { error?: { code?: string } }).error?.code)

      try {
        // —— slideshow：改画面提示词（解析 → 确认 → 只重置该镜任务 + 本地合成步） ——
        const a = await fixture('slideshow')
        check((await errOf(async () => assertRecipeSources(await a.runRow(), recipeOf(await a.runRow())!))) === null, '对照基线：未返修的批准链执行期自校验通过')
        const NEW = '夜晚街景，霓虹反光，湿地面倒映招牌'
        llmReply = JSON.stringify({ targets: [{ shot_index: 2, image_prompt: NEW }], unclear: null })
        const parseRes = await post(a.sessionId, 'rework/plan', { instruction: '第 2 镜改成夜晚街景', requestKey: 'm42rwp-1' })
        const pv = (await parseRes.json() as PlanBody).reworkPreview!
        check(parseRes.status === 200 && pv.unclear === null && pv.targets.length === 1 && pv.targets[0]!.index === 2 && pv.targets[0]!.imageFrom === '手冲注水' && pv.targets[0]!.imageCost === 0.1, '解析预览逐镜给出「原提示词 → 新提示词 + 单价」（确认前可审）')
        check(pv.estimate.knownCost === 0.1 && pv.estimate.unpriced.length === 0 && llmCalls === 1, '费用预估按批准单价给出（图像按张）；解析只调一次文本模型')
        const before = await a.taskRow('images', 's2')
        check(before.status === 'succeeded' && before.prompt === '手冲注水' && (await a.runRow()).status === 'completed', '解析阶段零写入：任务与 run 状态原样不动（不预付费用）')
        check((await a.msgs('rework_plan')).length === 1 && (await a.msgs('rework_plan'))[0]!.role === 'system', '解析结果以 system 消息落库（可回放、不重复计费）')

        const startsBefore = starts
        const applyRes = await post(a.sessionId, 'rework', { planRevision: pv.planRevision, planHash: pv.planHash, idempotencyKey: 'm42rwa-1', acceptUnpriced: false, ops: [{ shot_id: 's2', image_prompt: NEW }] })
        const applyBody = (await applyRes.json()) as ApplyBody
        check(applyRes.status === 202 && applyBody.progress?.status === 'queued' && starts === startsBefore + 1, '确认返修 → run 转排队并启动一次（返回最新快照供前端继续轮询）')
        const runA = await a.runRow()
        const recipe = recipeOf(runA)!
        check(recipe.plan.shots[1]!.image_prompt === NEW && recipe.plan.shots[0]!.image_prompt === '咖啡豆特写', '批准方案已改写（服务端按 ops 重算，不信前端数字）')
        check((await errOf(() => assertRecipeSources(runA, recipe))) === null, '返修后执行期自校验全链仍自洽（源资产哈希/模板/归属/输入引用）——最大风险点')
        const sessA = await a.sessRow()
        check(sessA.planRevision === 2 && hashJson(JSON.parse(String(sessA.approvedPlan))) === hashJson(recipe), 'approvedPlan = 新 recipe 且会话哈希与 run 内快照逐字一致')
        const pfExecution = (JSON.parse(String(sessA.preflight)) as { execution: Record<string, unknown> }).execution
        check(sessA.planHash === hashJson({ plan: recipe.plan, execution: { ...pfExecution, plan: recipe.plan } }), 'planHash 随新版本方案重算（后续确认不会拿旧哈希放行）')
        const input = JSON.parse(String(runA.input)) as { shots: number[]; recipe: string; script: number[]; lines: number[] }
        check(JSON.stringify(input.shots) === JSON.stringify([recipe.sources[2]!.id]) && input.recipe === JSON.stringify(recipe), 'run.input 的分镜引用与批准快照一并改写（执行期唯一解析源）')
        check(JSON.parse(await readTextAsset(recipe.sources[2]!.id)).map((s: { id: string }) => s.id).join() === 's1,s2,s3', '新分镜文本资产落盘可读（版本链真源）')
        check((await db.select().from(assets).where(eq(assets.projectId, a.projectId))).filter((x) => x.purpose === 'storyboard').length === 2, '旧版分镜资产保留（返修可回溯，不覆盖历史）')
        const t2 = await a.taskRow('images', 's2')
        check(t2.status === 'pending' && t2.prompt === NEW && t2.attempts === 0, '目标镜任务重置且提示词同步为已批准值（不触发“已批准任务参数变化”守卫），旧产物留作候选版本')
        check((await a.taskRow('images', 's1')).status === 'succeeded' && (await a.taskRow('images', 's3')).status === 'succeeded' && (await a.taskRow('motion', 's2')).status === 'succeeded', '其他镜头与其他步骤任务零重置（只重做定位到的那一镜）')
        check((await a.stepRow('images')).status === 'pending' && (await a.stepRow('compose')).status === 'pending', '目标步与本地合成步一并回 pending（完成后自动出新成片，无需手动重合成）')
        check((await a.stepRow('voice')).status === 'succeeded' && (await a.stepRow('captions')).status === 'succeeded' && (await a.stepRow('frames')).status === 'succeeded', '配音/字幕/首帧等已成功步骤零重置（不重复计费）')
        const rwMsg = (await a.msgs('rework'))[0]!
        check((await a.msgs('rework')).length === 1 && rwMsg.role === 'system' && rwMsg.content.includes('第 2 镜') && rwMsg.content.includes('¥0.10') && rwMsg.content.includes('本地合成不再计费'), '返修以 system 消息进对话流（写明镜头、预估费用与自动合成）')
        check(applyBody.artifacts?.documents.find((d) => d.label === '批准分镜')?.assetId === recipe.sources[2]!.id, '成果面板的「批准分镜」自动指向新版本资产')

        // —— 幂等与过期防护 ——
        await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, a.runId))
        await db.update(pipelineSteps).set({ status: 'succeeded' }).where(and(eq(pipelineSteps.runId, a.runId), eq(pipelineSteps.stepKey, 'compose')))
        const replayPayload = { planRevision: pv.planRevision, planHash: pv.planHash, idempotencyKey: 'm42rwa-1', acceptUnpriced: false, ops: [{ shot_id: 's2', image_prompt: NEW }] }
        const replay = await post(a.sessionId, 'rework', replayPayload)
        check(replay.status === 202 && starts === startsBefore + 1 && (await a.stepRow('compose')).status === 'succeeded' && (await a.msgs('rework')).length === 1, '同幂等键重放 → 不二次重置、不二次启动、不重复留言（网络重试安全）')
        const stale = await post(a.sessionId, 'rework', { planRevision: 1, planHash: pv.planHash, idempotencyKey: 'm42rwa-2', acceptUnpriced: false, ops: [{ shot_id: 's1', image_prompt: '随便改改' }] })
        check(stale.status === 409 && (await errCode(stale)) === 'stale_plan', '方案版本已推进 → 旧解析确认被拒（不拿过期预估执行）')
        const strict = await post(a.sessionId, 'rework', { ...replayPayload, hacker: 1 })
        check(strict.status === 422, '未知字段被 .strict() 拒')
        const noKey = await post(a.sessionId, 'rework', { planRevision: 2, planHash: pv.planHash, acceptUnpriced: false, ops: [{ shot_id: 's1', image_prompt: 'x' }] })
        check(noKey.status === 422, '缺幂等键的返修被拒（拒绝不可重试的计费写操作）')

        // —— dynamic：只能改动态提示词（画面改动不猜、不半做） ——
        const b = await fixture('dynamic')
        llmReply = JSON.stringify({ targets: [{ shot_index: 1, image_prompt: '更亮的白天街景' }], unclear: '动态片画面需重做首帧，请整版重新规划' })
        const bPv = (await (await post(b.sessionId, 'rework/plan', { instruction: '第 1 镜画面太暗', requestKey: 'm42rwp-b' })).json() as PlanBody).reworkPreview!
        check(bPv.targets.length === 0 && !!bPv.unclear && bPv.notes.length === 1, '动态模式的画面改动诉求不猜、不半做：明确回话并引导整版重规划（避免付费后必然被守卫拒绝）')
        llmReply = JSON.stringify({ targets: [{ shot_index: 3, motion_prompt: '镜头缓慢右移，光斑流动' }], unclear: null })
        const bPv2 = (await (await post(b.sessionId, 'rework/plan', { instruction: '第 3 镜动起来更慢', requestKey: 'm42rwp-b2' })).json() as PlanBody).reworkPreview!
        check(bPv2.targets[0]!.motionCost === 1 && bPv2.estimate.knownCost === 1, '动态返修按批准秒数计费（10 秒 × 0.1）')
        const bStarts = starts
        const bApply = await post(b.sessionId, 'rework', { planRevision: bPv2.planRevision, planHash: bPv2.planHash, idempotencyKey: 'm42rwa-b', acceptUnpriced: false, ops: [{ shot_id: 's3', motion_prompt: '镜头缓慢右移，光斑流动' }] })
        check(bApply.status === 202 && starts === bStarts + 1 && (await b.taskRow('motion', 's3')).status === 'pending' && (await b.stepRow('frames')).status === 'succeeded', '动态返修只重置该镜视频任务；首帧保持已成功（不级联重做）')
        check(recipeOf(await b.runRow())!.plan.shots[2]!.motion_prompt === '镜头缓慢右移，光斑流动', '动态提示词改写进批准方案（新首帧不会被静默重做）')

        // —— 歧义/越界与未计价项 ——
        const d = await fixture('slideshow')
        llmReply = JSON.stringify({ targets: [{ shot_index: 9, image_prompt: '不存在的镜头' }], unclear: null })
        const ghostPv = (await (await post(d.sessionId, 'rework/plan', { instruction: '最后那一段改一下', requestKey: 'm42rwp-d0' })).json() as PlanBody).reworkPreview!
        check(ghostPv.targets.length === 0 && !!ghostPv.unclear, '镜头序号越界 → 不猜，直接 unclear')
        llmReply = JSON.stringify({ targets: [{ shot_index: 3, image_prompt: '微距特写，咖啡豆纹理' }], unclear: null })
        const dParse = await post(d.sessionId, 'rework/plan', { instruction: '第 3 镜改成微距特写', requestKey: 'm42rwp-d' })
        const dPv = (await dParse.json() as PlanBody).reworkPreview!
        const calls = llmCalls
        const dPv2 = (await (await post(d.sessionId, 'rework/plan', { instruction: '第 3 镜改成微距特写', requestKey: 'm42rwp-d' })).json() as PlanBody).reworkPreview!
        check(llmCalls === calls && JSON.stringify(dPv2) === JSON.stringify(dPv), '同解析键同指令 → 回放上次结果，不再花一次模型费用')
        const conflict = await post(d.sessionId, 'rework/plan', { instruction: '第 1 镜改成微距特写', requestKey: 'm42rwp-d' })
        check(conflict.status === 409, '同解析键换指令 → 409 键冲突（幂等锚点不被复用）')
        const ghostOp = await post(d.sessionId, 'rework', { planRevision: dPv.planRevision, planHash: dPv.planHash, idempotencyKey: 'm42rwa-d0', acceptUnpriced: false, ops: [{ shot_id: 'ghost', image_prompt: '越界镜头' }] })
        check(ghostOp.status === 409 && (await errCode(ghostOp)) === 'unknown_shot', '分镜外镜头的确认提交 → 409（不静默接受幽灵 id）')
        const noChange = await post(d.sessionId, 'rework', { planRevision: dPv.planRevision, planHash: dPv.planHash, idempotencyKey: 'm42rwa-d1', acceptUnpriced: false, ops: [{ shot_id: 's3', image_prompt: '研磨刻度' }] })
        check(noChange.status === 409 && (await errCode(noChange)) === 'no_change', '与当前方案一致的改写 → 409 no_change（不花无意义的钱）')
        check((await d.taskRow('images', 's3')).status === 'succeeded' && (await d.sessRow()).planRevision === 1, '被拒的确认零重置、零版本链写入')

        const c = await fixture('slideshow', { unpriced: ['image'] })
        llmReply = JSON.stringify({ targets: [{ shot_index: 1, image_prompt: '清晨逆光，雾气未散' }], unclear: null })
        const cPv = (await (await post(c.sessionId, 'rework/plan', { instruction: '第 1 镜改清晨逆光', requestKey: 'm42rwp-c' })).json() as PlanBody).reworkPreview!
        check(cPv.estimate.unpriced.length === 1 && cPv.estimate.knownCost === 0, '单价未知的返修如实标为未计价（不按零元误导用户）')
        const cNoAccept = await post(c.sessionId, 'rework', { planRevision: cPv.planRevision, planHash: cPv.planHash, idempotencyKey: 'm42rwa-c1', acceptUnpriced: false, ops: [{ shot_id: 's1', image_prompt: '清晨逆光，雾气未散' }] })
        check(cNoAccept.status === 409 && (await c.taskRow('images', 's1')).status === 'succeeded', '未接受未计价项 → 409 且零重置')
        const cOk = await post(c.sessionId, 'rework', { planRevision: cPv.planRevision, planHash: cPv.planHash, idempotencyKey: 'm42rwa-c2', acceptUnpriced: true, ops: [{ shot_id: 's1', image_prompt: '清晨逆光，雾气未散' }] })
        check(cOk.status === 202 && (await c.taskRow('images', 's1')).status === 'pending', '显式接受未计价项后才执行')

        // —— 状态与归属门禁 ——
        await db.update(pipelineRuns).set({ status: 'running' }).where(eq(pipelineRuns.id, c.runId))
        const busy = await post(c.sessionId, 'rework/plan', { instruction: '第 2 镜改暗一些', requestKey: 'm42rwp-c2' })
        check(busy.status === 409 && (await c.msgs('rework_plan')).length === 1, '在途 run 不得解析返修（未收敛前镜头表不是最终产物）')
        await db.update(pipelineRuns).set({ status: 'waiting_input' }).where(eq(pipelineRuns.id, c.runId))
        const waiting = await post(c.sessionId, 'rework', { planRevision: cPv.planRevision, planHash: cPv.planHash, idempotencyKey: 'm42rwa-c3', acceptUnpriced: true, ops: [{ shot_id: 's2', image_prompt: '雪天窗外' }] })
        const waitingMsg = String((await waiting.json() as { error?: { message?: string } }).error?.message)
        check(waiting.status === 409 && waitingMsg.includes('审阅'), '等待审阅期间不得叠加返修（先完成审阅决策，避免两个闸口互踩）')
        await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, c.runId))
        // 上一次返修已把目标步回 pending；先恢复成「已收敛」，才能隔离出「他步失败」这一个变量
        await db.update(pipelineSteps).set({ status: 'succeeded' }).where(eq(pipelineSteps.runId, c.runId))
        await db.update(pipelineSteps).set({ status: 'failed' }).where(and(eq(pipelineSteps.runId, c.runId), eq(pipelineSteps.stepKey, 'voice')))
        const revBefore = (await c.sessRow()).planRevision
        const csess = await c.sessRow()
        const ofRes = await post(c.sessionId, 'rework', { planRevision: csess.planRevision!, planHash: String(csess.planHash), idempotencyKey: 'm42rwa-c4', acceptUnpriced: true, ops: [{ shot_id: 's2', image_prompt: '雪天窗外' }] })
        check(ofRes.status === 400 && (await errCode(ofRes)) === 'other_failed', '存在返修范围外失败步骤 → 400 other_failed 原样透传（不塌成 503 掩盖真实原因）')
        check((await c.sessRow()).planRevision === revBefore && (await db.select().from(assets).where(eq(assets.projectId, c.projectId))).filter((x) => x.purpose === 'storyboard').length === 2, '被拒的返修不产生半途改写（方案版本与分镜链零变化）')
        await db.update(pipelineSteps).set({ status: 'succeeded' }).where(and(eq(pipelineSteps.runId, c.runId), eq(pipelineSteps.stepKey, 'voice')))

        // —— 专业工作台仍不放开（返修只开会话内通道） ——
        const regen = await app.request(`/api/v1/runs/${d.runId}/shots/regenerate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step_key: 'images', shot_id: 's2' }) })
        check(regen.status === 409, '通用工作台单镜重生成对创作 run 仍 409（预算/确认闸不因返修而绕过）')
        check(await codeOf(() => resetShotsForRework(d.runId, [{ stepKey: 'images', shots: [{ shotId: 's1', prompt: 'x' }] }], { allowCreation: false })) === 'creation_confirmation_required', '内部允许通道需显式 allowCreation（默认拒绝）')
        check(await codeOf(() => resetShotsForRework(d.runId, [{ stepKey: 'images', shots: [{ shotId: 'ghost', prompt: 'x' }] }], { allowCreation: true })) === 'no_task', '镜头无对应任务 → no_task（校验先于写入）')
        check((await d.taskRow('images', 's1')).status === 'succeeded' && (await d.stepRow('compose')).status === 'succeeded', '半途失败的批量重置不留下部分写入')
        const noRun = await makeReadySession('slideshow')
        check((await post(noRun.sessionId, 'rework/plan', { instruction: '第 1 镜改夜景', requestKey: 'm42rwp-nr' })).status === 409, '尚未开始制作的会话 → 409（没有可返修的镜头）')
        check((await post(999999, 'rework/plan', { instruction: '第 1 镜改夜景', requestKey: 'm42rwp-404' })).status === 404, '不存在的会话 → 404')
        check(llmCalls > 0 && mediaCalls === 0, '全程只命中文本模型端点：解析与确认都不直接调媒体生成（生成由续跑后的引擎与预算门禁负责）')
        check((await creationDetail(a.sessionId)).messages.some((m) => m.role === 'system' && JSON.stringify(m.payload).includes('"kind":"rework"')), '返修决策在详情对话流可见（刷新不丢历史）')
      } finally {
        globalThis.fetch = blocker
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },

    // ============ messages：审阅/返修/重合成决策进对话流，但绝不进后续规划的 LLM 上下文 ============
    messages: async () => {
      const { db, initDb } = await import('../src/db')
      const { creationMessages } = await import('../src/db/schema')
      const { app } = await import('../src/app')
      const { creationDetail } = await import('../src/services/creation-chat/store')
      await initDb()
      await seedEndpoints()
      // 无 run 的会话才会进规划通路（有 run 时发消息只「记为下一版建议」不调 LLM）
      const s = await makeReadySession('slideshow')
      const notes: Array<[string, string]> = [
        ['gate', '你已点击继续制作：审阅通过后开始后续步骤。'],
        ['rework', '已开始局部返修：第 2 镜（画面提示词）。预估费用 ¥0.10'],
        ['recompose', '已按你选定的镜头版本重新合成成片（本地合成，不调用付费生成模型）。'],
      ]
      for (const [kind, content] of notes) await db.insert(creationMessages).values({ sessionId: s.sessionId, role: 'system', content, requestKey: `m42msg-${kind}`, payload: JSON.stringify({ kind, runId: 1 }), createdAt: Date.now() })
      const detail = await creationDetail(s.sessionId)
      check(notes.every(([, content]) => detail.messages.some((m) => m.role === 'system' && m.content === content)), '三类决策消息都在对话流可见（用户可回溯发生了什么）')
      let captured = ''
      const blocker = globalThis.fetch
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).startsWith('http://localhost:0/offline')) throw new Error('探针禁止外部网络')
        if (String(input).includes('/chat/completions')) captured = String(init?.body ?? '')
        return Response.json({ choices: [{ message: { content: JSON.stringify({ kind: 'clarify', message: '请补充时长', questions: ['要多长？'] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })
      }
      try {
        const res = await app.request(`/api/v1/creation-sessions/${s.sessionId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '再加一句关于咖啡豆的旁白', requestKey: 'm42msg-send' }) })
        check(res.status === 200 && captured.includes('咖啡豆'), '规划请求仍带用户真实对话上下文')
        check(!!captured && !notes.some(([, content]) => captured.includes(content)), '决策/返修/重合成消息不污染后续规划（system 角色被历史查询排除）')
      } finally {
        globalThis.fetch = blocker
      }
    },
  }

  await runSections({ log, title: 'M42', checker, sections: SECTIONS, runners, cleanup: () => { globalThis.fetch = originalFetch; envCleanup() } })
}
void main()
