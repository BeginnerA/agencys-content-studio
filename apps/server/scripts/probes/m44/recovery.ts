import { eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'
import { seedDialogueRun } from './fixture'

/**
 * 对白恢复闭环（服务层）：ASR 批准快照漂移即阻止、已存原始响应的失败转写不被当作结果不明、
 * 已成功任务零重做零重复计费。engine.startRun 打桩，只验恢复决策不跑媒体。
 */
async function setupDialogue({ db, pipelineSteps, genTasks }: {
  db: typeof import('../../../src/db').db
  pipelineSteps: typeof import('../../../src/db/schema').pipelineSteps
  genTasks: typeof import('../../../src/db/schema').genTasks
}, plan: CreationPlan, f: Awaited<ReturnType<typeof seedDialogueRun>>, asr: { status: string; attempts: number; resultAssetId: number | null }) {
  const now = Date.now()
  const steps = await db.insert(pipelineSteps).values(f.template.steps.map((s, seq) => ({
    runId: f.run.id, seq, stepKey: s.key, actionKey: s.action, title: s.title,
    status: s.key === 'frames' ? 'skipped' : s.key === 'motion' ? 'succeeded' : s.key === 'captions' ? 'failed' : 'pending',
    createdAt: now, updatedAt: now,
  }))).returning()
  const motion = steps.find((s) => s.stepKey === 'motion')!
  const captions = steps.find((s) => s.stepKey === 'captions')!
  const videoTaskId = f.recipe.sources[0]!.id
  await db.insert(genTasks).values([
    ...plan.shots.map((s) => ({ projectId: f.project.id, runId: f.run.id, stepId: motion.id, kind: 'video', provider: 'volcengine_video', model: 'doubao-seedance-2-0-260128', prompt: '', params: JSON.stringify({ shotId: s.id }), status: 'succeeded', attempts: 1, taskId: 'vid-' + s.id, resultAssetId: videoTaskId, createdAt: now, updatedAt: now })),
    { projectId: f.project.id, runId: f.run.id, stepId: captions.id, kind: 'asr', provider: 'openai_audio', model: 'whisper-1', prompt: '', params: JSON.stringify({ shotId: 's1' }), status: asr.status, attempts: asr.attempts, resultAssetId: asr.resultAssetId, createdAt: now, updatedAt: now },
  ])
  return { steps, captions }
}

export async function probeDialogueRecovery({ check }: Checker, plan: CreationPlan): Promise<void> {
  const { db } = await import('../../../src/db')
  const { apiConfigs, creationMessages, creationSessions, genTasks, pipelineRuns, pipelineSteps } = await import('../../../src/db/schema')
  const { retryCreation } = await import('../../../src/services/creation-chat/execution')
  const { CreationError } = await import('../../../src/services/creation-chat/contract')
  const { engine } = await import('../../../src/pipeline/engine')
  const startRun = engine.startRun
  let starts = 0
  engine.startRun = ((runId: number) => { void runId; starts++; return 'started' }) as typeof engine.startRun
  const fetch0 = globalThis.fetch
  let netCalls = 0
  globalThis.fetch = async () => { netCalls++; throw new Error('M44 恢复探针禁止网络请求') }
  try {
    // 场景 A：严格 ASR 实例配置漂移 → 恢复前阻止，不进入复制。
    {
      const f = await seedDialogueRun(plan)
      await setupDialogue({ db, pipelineSteps, genTasks }, plan, f, { status: 'failed', attempts: 1, resultAssetId: f.recipe.sources[0]!.id })
      await db.update(apiConfigs).set({ pricing: JSON.stringify({ asr: { model: 'whisper-1', second: 0.09 } }) }).where(eq(apiConfigs.id, f.recipe.asr!.configId))
      const snapshot = async () => JSON.stringify(await Promise.all([
        db.select().from(pipelineRuns), db.select().from(pipelineSteps), db.select().from(genTasks),
        db.select().from(creationSessions), db.select().from(creationMessages),
      ]))
      const before = await snapshot()
      const startsBefore = starts
      const callsBefore = netCalls
      let code = '', status = 0
      try { await retryCreation(f.session.id, { runId: f.run.id, planRevision: f.session.planRevision, planHash: f.session.planHash, idempotencyKey: 'm44-rec-a' }) }
      catch (err) { if (err instanceof CreationError) { code = err.code; status = err.status } }
      check(code === 'configuration_changed' && status === 409, '恢复层统一返回 configuration_changed/409，未确认时拒绝 ASR 配置漂移')
      check(await snapshot() === before, '拒绝漂移后运行、步骤、任务、批准快照和消息均原样保留')
      check(starts === startsBefore, '拒绝漂移不启动引擎')
      check(netCalls === callsBefore, '拒绝漂移不发起供应商请求')
    }
    // 场景 B：转写已落原始响应、仅校验未过 → 不被当作结果不明，恢复成功且零联网零重发。
    {
      const f = await seedDialogueRun(plan)
      await setupDialogue({ db, pipelineSteps, genTasks }, plan, f, { status: 'failed', attempts: 1, resultAssetId: f.recipe.sources[0]!.id })
      const before = netCalls
      const res = await retryCreation(f.session.id, { runId: f.run.id, planRevision: f.session.planRevision, planHash: f.session.planHash, idempotencyKey: 'm44-rec-b' })
      const copiedVideo = await db.select().from(genTasks).where(eq(genTasks.kind, 'video'))
      const copiedAsr = await db.select().from(genTasks).where(eq(genTasks.kind, 'asr'))
      const newRun = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, res.runId)))[0]!
      check(starts === 1 && netCalls === before, '已捕获原始响应的失败转写恢复不强制人工核验也不自动重发请求')
      check(newRun.status === 'queued' && copiedVideo.filter((t) => t.runId === res.runId && t.status === 'succeeded').length === 4 && copiedAsr.filter((t) => t.runId === res.runId && t.status === 'pending').length === 1, '恢复新 run 复用已成功视频、转写回待办且不重复计费')
    }
    // 场景 C：ASR 有提交次数但无已捕获产物（受理状态确实不明）→ 仍要求显式核验。
    {
      const f = await seedDialogueRun(plan)
      await setupDialogue({ db, pipelineSteps, genTasks }, plan, f, { status: 'failed', attempts: 1, resultAssetId: null })
      let code = ''
      try { await retryCreation(f.session.id, { runId: f.run.id, planRevision: f.session.planRevision, planHash: f.session.planHash, idempotencyKey: 'm44-rec-c' }) }
      catch (err) { code = err instanceof CreationError ? err.code : '' }
      check(code === 'needs_verification', '结果确实不明的 ASR 提交仍阻止自动重发，要求显式核验')
    }
    // 两个恢复入口共用漂移读模型；仅改价也须确认，停用/协议失配不能虚报可用。
    const { Hono } = await import('hono')
    const { runsRoutes } = await import('../../../src/routes/runs')
    const { creationChatRoutes } = await import('../../../src/routes/creation-chat')
    const { recipeOf, assertRecipeSources } = await import('../../../src/services/creation-chat/recipe')
    const app = new Hono().route('/api/v1', runsRoutes).route('/api/v1', creationChatRoutes)
    type Drift = { service: string; from: string; to: string | null }
    for (const mode of ['price-run', 'price-session', 'disabled', 'protocol']) {
      const f = await seedDialogueRun(plan)
      await setupDialogue({ db, pipelineSteps, genTasks }, plan, f, { status: 'failed', attempts: 1, resultAssetId: f.recipe.sources[0]!.id })
      const runPath = `/api/v1/runs/${f.run.id}`
      const sessionPath = `/api/v1/creation-sessions/${f.session.id}`
      const getDrift = async () => {
        const r = await (await app.request(runPath)).json() as { resumeConfigDrift?: Drift[] }
        const s = await (await app.request(sessionPath)).json() as { progress?: { recovery?: { configDrift?: Drift[] } } }
        return { run: r.resumeConfigDrift ?? [], session: s.progress?.recovery?.configDrift ?? [] }
      }
      const clean = await getDrift()
      check(clean.run.length === 0 && clean.session.length === 0, `${mode}：配置未变化时两个详情均无漂移`)
      const change = mode === 'disabled' ? { isActive: 0 } : mode === 'protocol' ? { extra: JSON.stringify({ asr_model: 'whisper-1', asr_protocol: 'unsupported' }) } : { pricing: JSON.stringify({ asr: { model: 'whisper-1', second: 0.09 } }) }
      await db.update(apiConfigs).set(change).where(eq(apiConfigs.id, f.audio.id))
      const startsBefore = starts, callsBefore = netCalls
      const drift = await getDrift()
      const expected = [{ service: 'asr', from: 'whisper-1', to: mode.startsWith('price') ? 'whisper-1' : null }]
      check(JSON.stringify(drift.run) === JSON.stringify(expected), `${mode}：运行详情暴露独立 ASR 漂移（非 TTS 型号）`)
      check(JSON.stringify(drift.session) === JSON.stringify(expected), `${mode}：会话详情与运行详情使用同一漂移清单`)
      const viaSession = mode === 'price-session'
      const retryPath = viaSession ? `${sessionPath}/retry` : `${runPath}/resume`
      const base = viaSession ? { runId: f.run.id, planRevision: f.session.planRevision, planHash: f.session.planHash, idempotencyKey: 'm44-drift-session' } : {}
      const post = (body: object) => app.request(retryPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const denied = await post(base)
      const deniedBody = await denied.json() as { error?: { code: string } }
      check(denied.status === 409 && deniedBody.error?.code === 'configuration_changed' && starts === startsBefore, `${mode}：未确认通过 HTTP 拒绝，不启动引擎`)
      const accepted = await post({ ...base, ...(viaSession ? { acceptConfigDrift: true } : { accept_config_drift: true }) })
      if (mode.startsWith('price')) {
        const body = await accepted.json() as { run?: { id: number }; runId?: number }
        const newId = body.runId ?? body.run?.id ?? -1
        check(accepted.status === 202 && newId !== f.run.id && starts === startsBefore + 1, `${mode}：明确接受后才创建一个续跑 run`)
        const [newRun] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, newId))
        if (newRun) {
          const recipe = recipeOf(newRun)!
          check(recipe.asr?.unitPrice === 0.09 && recipe.asr.configHash !== f.recipe.asr!.configHash, `${mode}：新运行冻结当前 ASR 价格和配置指纹`)
          await assertRecipeSources(newRun, recipe)
          const [oldRun] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, f.run.id))
          check(oldRun?.input === f.run.input, `${mode}：刷新会话批准锚点，旧 run 快照不被改写`)
        }
      } else {
        check(accepted.status !== 202 && starts === startsBefore, `${mode}：没有可用严格 ASR 时即使确认也不启动`)
      }
      check(netCalls === callsBefore, `${mode}：详情、拒绝与确认恢复决策均不请求供应商`)
    }
  } finally { engine.startRun = startRun; globalThis.fetch = fetch0 }
}

/** 执行真实前端确认器、状态机及 SFC setup；API 打桩，不连接浏览器或生产服务。 */
export async function probeRecoveryClient({ check }: Checker): Promise<void> {
  const { runApi } = await import('../../../../web/src/lib/api/runs')
  const { creationChatApi } = await import('../../../../web/src/lib/api/creation-chat')
  const confirm = await import('../../../../web/src/lib/confirm')
  const { useEasyCreate } = await import('../../../../web/src/views/easy-create/use-creation-chat')
  const { ApiError } = await import('../../../../web/src/lib/api/core')
  type Detail = import('../../../../web/src/lib/types/creation-chat').CreationDetail
  type Retry = import('../../../../web/src/lib/types/creation-chat').CreationRetryBody
  type RunDetail = import('../../../../web/src/lib/types/base').RunDetail
  const original = { detail: runApi.detail, resume: runApi.resume, chatDetail: creationChatApi.detail, retry: creationChatApi.retry }
  const s = useEasyCreate()
  const drift = [{ service: 'asr', from: 'whisper-1', to: 'whisper-1' as string | null }]
  let rd = { run: { id: 41, status: 'failed' }, steps: [], creationSessionId: 7, resumeConfigDrift: drift } as unknown as RunDetail
  let posts: Record<string, unknown>[] = [], reads = 0
  let detail = { session: { id: 7, planRevision: 1, planHash: 'probe', status: 'started', project: null }, progress: { runId: 41, status: 'failed', uncertainTasks: [], recovery: { resumable: true, requiredTaskIds: [], queryTaskCount: 0, unpriced: [], configDrift: drift } }, result: null } as unknown as Detail
  const retries: Retry[] = []
  const fetch0 = globalThis.fetch
  let network = 0
  globalThis.fetch = async () => { network++; throw new Error('前端恢复探针禁止网络') }
  runApi.detail = async () => { reads++; return structuredClone(rd) }
  runApi.resume = async (_id, body) => { posts.push(body ?? {}); return { run: { ...rd.run, id: 42 } } }
  creationChatApi.detail = async () => structuredClone(detail)
  creationChatApi.retry = async (_id, body) => { retries.push(body); return { runId: 42 } }
  const tick = async () => { await Promise.resolve(); await Promise.resolve() }
  const seed = () => { s.state.currentId = detail.session.id; s.state.detail = structuredClone(detail); s.state.busyAction = false }
  try {
    let pending = confirm.confirmRunResume(41, () => true)
    await tick()
    check(confirm.confirmState.active?.opts.message.includes('原声转写 ASR') === true && confirm.confirmState.active.opts.message.includes('价格'), '共享确认器显示独立 ASR，型号相同时仍提示改价')
    confirm.settleConfirm(false)
    check(await pending === null && posts.length === 0 && reads === 1, '取消恢复只读取详情，不提交')
    pending = confirm.confirmRunResume(41, () => true); await tick(); confirm.settleConfirm(true); await pending
    check(posts.length === 1 && posts[0]!.accept_config_drift === true && !posts[0]!.confirm_ambiguous, '明确接受才传配置确认，不附带未知受理授权')
    rd.resumeNeedsVerification = true; rd.ambiguousTaskIds = [99]
    pending = confirm.confirmRunResume(41, () => true); await tick()
    check(confirm.confirmState.active?.opts.confirmText === '已核验并接受当前配置', '双重风险在同一确认动作中明确说明')
    confirm.settleConfirm(true); await pending
    check(posts[1]!.confirm_ambiguous === true && posts[1]!.accept_config_drift === true, '两类显式确认均按原恢复契约传递')
    let current = true
    pending = confirm.confirmRunResume(41, () => current); await tick(); current = false; confirm.settleConfirm(true)
    check(await pending === null && posts.length === 2, '确认期间切换目标不提交旧运行')
    rd.resumeConfigDrift = [{ ...drift[0]!, to: null }]
    let error = ''
    try { await confirm.confirmRunResume(41, () => true) } catch (e) { error = String(e) }
    check(error.includes('当前无可用配置') && !error.includes('实例已删除') && !confirm.confirmState.active && posts.length === 2, '不可用实例给出修复提示，不展示可接受并提交的入口')
    rd.resumeConfigDrift = []; rd.resumeNeedsVerification = false
    pending = confirm.confirmRunResume(41, () => true); await tick(); confirm.settleConfirm(true); await pending
    check(Object.keys(posts[2]!).length === 0, '未漂移恢复不自动发送任何风险接受字段')
    runApi.detail = async () => { throw new Error('详情读取失败') }
    try { await confirm.confirmRunResume(41, () => true) } catch { /* 只读失败必须阻止 */ }
    check(posts.length === 3 && !confirm.confirmState.active, '读详情失败不依赖旧详情绕过确认')

    seed()
    check(await s.retry([]) === null && retries.length === 0, '轻松创作未明确接受漂移时不发恢复请求')
    check(await s.retry([], false, true) === 42 && retries[0]?.acceptConfigDrift === true, '轻松创作明确接受后使用 camelCase 恢复契约')
    const firstKey = retries[0]!.idempotencyKey
    await s.retry([], false, true)
    check(retries[1]?.idempotencyKey === firstKey, '同一恢复决策重试复用幂等键')
    detail.progress!.recovery.configDrift = [{ ...drift[0]!, to: 'new-model' }]; seed(); await s.retry([], false, true)
    check(retries[2]?.idempotencyKey !== firstKey, '漂移清单改变使旧幂等票据失效')
    detail.progress!.recovery.configDrift = [{ ...drift[0]!, to: null }]; seed()
    check(await s.retry([], false, true) === null && retries.length === 3, '轻松创作即使传入接受也不能恢复不可用配置')
    detail.progress!.recovery.configDrift = []; seed(); await s.retry([], false, true)
    check(retries[3]?.acceptConfigDrift === undefined, '无漂移时不携带残留接受标志')
    detail.progress!.recovery.configDrift = drift
    creationChatApi.retry = async () => { throw new ApiError(409, 'configuration_changed', '配置已变更') }
    await s.retry([])
    check(s.state.detail?.progress?.recovery.configDrift?.length === 1, '旧详情收到配置冲突后只刷新本地风险清单，不自动确认重试')
    let resolveRetry!: (value: { runId: number }) => void
    creationChatApi.retry = async () => new Promise((resolve) => { resolveRetry = resolve })
    seed(); const oldRequest = s.retry([], false, true)
    s.leave(); s.state.currentId = 8; s.state.busyAction = true; s.state.error = '新会话状态'
    resolveRetry({ runId: 42 })
    check(await oldRequest === null && s.state.busyAction && s.state.error === '新会话状态', '切会话后旧恢复响应不导航、不清新会话忙态或错误')

    // 编译真实 SFC setup，执行 computed/watch/点击回调；仅图标渲染桩化，不复制确认状态逻辑。
    const { createRequire } = await import('node:module')
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { REPO_ROOT } = await import('../../probe-lib')
    const requireWeb = createRequire(join(REPO_ROOT, 'apps/web/package.json'))
    const vue = requireWeb('vue')
    const { parse, compileScript } = requireWeb('vue/compiler-sfc')
    const ts = requireWeb('typescript')
    const file = join(REPO_ROOT, 'apps/web/src/views/easy-create/CreationProgress.vue')
    const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
    const script = compileScript(descriptor, { id: 'm44-recovery-client' }).content
    const js = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const format = await import('../../../../web/src/lib/format')
    const exports: { default?: { setup: (props: unknown, ctx: unknown) => any } } = {}
    new Function('require', 'exports', js)((id: string) => {
      if (id === 'vue') return vue
      if (id.endsWith('/Icon.vue')) return { default: {} }
      if (id.endsWith('/format')) return format
      if (id.endsWith('/confirm')) return confirm
      throw new Error(`SFC 意外依赖：${id}`)
    }, exports)
    const scope = vue.effectScope()
    seed()
    const ui = scope.run(() => exports.default!.setup({ s }, { expose: () => {} }))!
    try {
      check(ui.acceptConfigDrift.value === false && ui.canRetry.value === false, '恢复面板默认未勾选配置接受且禁用恢复')
      ui.acceptConfigDrift.value = true
      check(ui.canRetry.value === true, '明确勾选后恢复面板才可提交')
      for (const change of [
        () => { s.state.detail!.session.id++ },
        () => { s.state.detail!.progress!.runId++ },
        () => { s.state.detail!.session.planRevision++ },
        () => { s.state.detail!.session.planHash += '-changed' },
        () => { s.state.detail!.progress!.recovery.configDrift = [{ ...drift[0]!, to: 'another-model' }] },
      ]) {
        ui.acceptConfigDrift.value = true; ui.acceptUnpriced.value = true; ui.resubmitIds.value = [99]
        change()
        check(!ui.acceptConfigDrift.value && !ui.acceptUnpriced.value && ui.resubmitIds.value.length === 0, '会话、运行、方案或漂移变化同步清除旧确认')
      }
      s.state.detail!.progress!.recovery.configDrift = [{ ...drift[0]!, to: null }]
      ui.acceptConfigDrift.value = true
      check(ui.configUnavailable.value && !ui.canRetry.value, '不可用配置即使残留勾选仍禁用恢复')
      s.state.detail!.progress!.recovery.configDrift = drift
      let submitted: unknown[] = []
      const retry0 = s.retry
      s.retry = async (...args) => { submitted = args; return 42 }
      try {
        await ui.onRetry(); check(submitted.length === 0, '恢复面板未勾选时点击回调也不提交')
        ui.acceptConfigDrift.value = true; await ui.onRetry()
        check(submitted[2] === true, '恢复面板将明确勾选传入真实状态机参数')
      } finally { s.retry = retry0 }
    } finally { scope.stop() }

    // 两个页面使用真实恢复回调；仅挂载副作用、路由导航和无关画布域打桩。
    for (const entry of ['run-detail/use-run-detail.ts', 'canvas/index.vue']) {
      const route = vue.reactive({ params: { id: '41' }, query: { run: '41' }, fullPath: '/original' })
      const disposed: Array<() => void> = []
      const navigations: unknown[] = []
      const module: any = {}
      const filename = join(REPO_ROOT, 'apps/web/src/views', entry)
      const source = readFileSync(filename, 'utf8')
      const content = entry.endsWith('.vue') ? compileScript(parse(source, { filename }).descriptor, { id: 'm44-entry' }).content : source
      const compiled = ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
      new Function('require', 'exports', compiled)((id: string) => {
        if (id === 'vue') return { ...vue, onMounted: () => {}, onBeforeUnmount: (fn: () => void) => disposed.push(fn) }
        if (id === 'vue-router') return { useRoute: () => route, useRouter: () => ({ push: (v: unknown) => navigations.push(v), replace: (v: unknown) => navigations.push(v) }) }
        if (id.endsWith('.vue')) return { default: {} }
        if (id.endsWith('/api')) return { runApi }
        if (id.endsWith('/confirm')) return confirm
        if (id.endsWith('/format')) return format
        if (id.endsWith('/socket')) return { useStudio: () => ({ leave: () => {} }) }
        if (id === './use-canvas-edit') return { useCanvasEdit: () => ({ editMode: vue.ref(false), dirty: vue.ref(false), overriddenCount: vue.ref(0) }) }
        if (id === './use-canvas-design') return { useCanvasDesign: () => ({}) }
        if (id === './use-canvas-realtime') return { useCanvasRealtime: () => ({ logText: vue.ref('') }) }
        throw new Error(`页面意外依赖：${id}`)
      }, module)
      const entryScope = vue.effectScope()
      const page = entryScope.run(() => entry.endsWith('.vue') ? module.default.setup({}, { expose: () => {} }) : module.useRunDetail({}))
      if (entry.endsWith('.vue')) page.runId.value = 41
      rd.resumeConfigDrift = drift
      runApi.detail = async () => { reads++; return structuredClone(rd) }
      const before = posts.length, readsBefore = reads
      try {
        let action = page.resumeRun(); await tick(); await page.resumeRun()
        check(!!confirm.confirmState.active && reads === readsBefore + 1, `${entry}：进入共享确认，弹窗期间连点只读一次详情`)
        confirm.settleConfirm(false); await action
        check(posts.length === before && navigations.length === 0, `${entry}：取消不提交、不跳转`)
        action = page.resumeRun(); await tick(); confirm.settleConfirm(true); await action
        check(posts.length === before + 1 && posts.at(-1)!.accept_config_drift === true && navigations.length === 1, `${entry}：明确接受才提交配置确认并导航`)
        action = page.resumeRun(); await tick()
        route.fullPath = '/another'; route.fullPath = '/original'
        confirm.settleConfirm(true); await action
        check(posts.length === before + 1 && navigations.length === 1, `${entry}：切走再切回也不能复用旧确认`)
        action = page.resumeRun(); await tick(); disposed.forEach((fn) => fn()); confirm.settleConfirm(true); await action
        check(posts.length === before + 1, `${entry}：页面卸载后确认不提交`)
      } finally { entryScope.stop(); confirm.settleConfirm(false) }
    }
    check(network === 0, '前端确认、恢复与状态重置验证零网络请求')
  } finally {
    s.leave(); confirm.settleConfirm(false)
    runApi.detail = original.detail; runApi.resume = original.resume
    creationChatApi.detail = original.chatDetail; creationChatApi.retry = original.retry
    globalThis.fetch = fetch0
  }
}
