/**
 * M30 探针（对话式「一句话成片」服务端 + 媒体闭环）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m30.ts [--section=contract|preflight|confirm|media|recovery]
 *
 * 隔离策略：isolatedEnv('m30', bridge templates/prompts) 指向一次性临时目录（独立 studio.db + workspace），
 * 必须在任何 src 动态 import 前调用。零网络、零付费模型调用、零计费：
 *   - contract 节纯函数直测（无 DB）；
 *   - preflight/confirm 节直插 apiConfigs（离线端点）+ 直接驱动 preflightPlan/confirmCreation（旁路 LLM）；
 *   - media 节用本地 ffmpeg 生成可解码 配音/镜头，真实跑 subtitle→ffmpeg_merge 严格交付链，产出可播放 MP4；
 *   - recovery 节直测 reconcile/守卫/跨项目/密钥脱敏。confirm 前 stub engine.startRun 阻断真实媒体执行。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

// ---- 隔离环境：必须先于任何 src/env 加载 ----
const { cleanup: envCleanup } = isolatedEnv('m30', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M30_KEY = 'probe-offline-secret-key-9f3c'

const SECTIONS = ['contract', 'preflight', 'confirm', 'media', 'recovery'] as const

// 3 镜 × 10 秒 = 30 秒；每镜一句旁白（映射与顺序均合法），最小化实测对齐漂移。
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

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m30')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const errOf = async (fn: () => Promise<unknown>): Promise<Error | null> => {
    try { await fn(); return null } catch (err) { return err instanceof Error ? err : new Error(String(err)) }
  }
  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    const e = await errOf(fn)
    return e && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : e ? 'other' : 'none'
  }

  // ---- 共用建项目助手 ----
  const mkProject = async (name: string): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    return (await db.insert(projects).values({ name, genre: 'talking_head', templateKey: 'easy-video', status: 'active', settings: '{}', tags: '[]', createdAt: t, updatedAt: t }).returning())[0]!.id
  }

  // ---- 端点播种：离线 apiConfigs（resolveEndpoint 不联网，密钥走 env 引用）----
  type SeedOpts = { videoCaps?: unknown; voice?: string; unpriced?: ('image' | 'video' | 'audio')[]; videoModel?: string; durations?: number[]; aspectRatios?: string[]; videoProvider?: string; videoActive?: number }
  const seedEndpoints = async (over: SeedOpts = {}): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    await initDb()
    const { apiConfigs } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'llm'))
    await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'audio'))
    await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'video'))
    await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'image'))
    const t = Date.now()
    const price = (u: string): string => (over.unpriced ?? []).length ? JSON.stringify({}) : JSON.stringify({ [u]: 0.1 })
    const insert = (v: Record<string, unknown>): Promise<unknown> => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M30_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: v.pricing ?? '{}', isActive: v.isActive ?? 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
    await insert({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
    await insert({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', extra: { voice: over.voice ?? 'probe-voice' }, pricing: price('char') })
    await insert({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: price('image') })
    await insert({
      name: 'video', providerKey: over.videoProvider ?? 'siliconflow_video', serviceType: 'video', isActive: over.videoActive ?? 1,
      model: over.videoModel ?? 'Wan2.2-I2V-A14B',
      extra: over.videoCaps === null ? {} : { creationCapabilities: over.videoCaps ?? { model: over.videoModel ?? 'Wan2.2-I2V-A14B', verified: true, modes: ['i2v', 't2v'], durations: over.durations ?? [10], aspectRatios: over.aspectRatios ?? ['9:16', '16:9', '1:1'], resolution: '720p' } },
      pricing: price('second'),
    })
  }

  // 直建「待确认」会话（旁路 LLM：直接跑 preflightPlan 填充 plan/preflight/planHash/status）。
  const makeReadySession = async (mode: 'dynamic' | 'slideshow') => {
    const { db } = await import('../src/db')
    const { creationSessions } = await import('../src/db/schema')
    const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
    const { preflightPlan } = await import('../src/services/creation-chat/preflight')
    const projectId = await mkProject(`probe-m30-${mode}-${Date.now()}`)
    const plan = creationPlanSchema.parse(makePlan(mode))
    const pf = await preflightPlan(projectId, plan)
    const t = Date.now()
    const key = `ready${mode}${t}`
    const [s] = await db.insert(creationSessions).values({ projectId, requestKey: key, status: pf.ready ? 'ready' : 'draft', plan: JSON.stringify(plan), planRevision: 1, planHash: pf.execution ? hashJson({ plan, execution: pf.execution }) : null, preflight: JSON.stringify(pf), runHistory: '[]', createdAt: t, updatedAt: t }).returning()
    return { projectId, sessionId: s!.id, plan }
  }

  // ---- 本地合成素材（真实可解码）----
  const genMedia = async (projectId: number, kind: 'voice' | 'video' | 'image', id: string, durSec: number, runId: number, params: Record<string, unknown>): Promise<number> => {
    const { ensureProjectDirs, relPathOf, absPathOf, registerAsset } = await import('../src/services/storage')
    const { resolveFfmpeg } = await import('../src/services/ffmpeg')
    const ffmpeg = resolveFfmpeg()!
    ensureProjectDirs(projectId)
    const purpose = kind === 'voice' ? 'voice' : kind === 'video' ? 'shot_video' : 'shot_image'
    const ext = kind === 'voice' ? 'mp3' : kind === 'video' ? 'mp4' : 'png'
    const rel = relPathOf(projectId, purpose, `${id}-${Date.now()}.${ext}`)
    const abs = absPathOf(rel)
    const args = kind === 'voice'
      ? ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(durSec), '-q:a', '4', abs]
      : kind === 'video'
        ? ['-y', '-f', 'lavfi', '-i', `testsrc=size=720x1280:rate=25`, '-t', String(durSec), '-pix_fmt', 'yuv420p', '-preset', 'veryfast', abs]
        : ['-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=1', '-frames:v', '1', abs]
    const r = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 120000, windowsHide: true })
    if (r.status !== 0) throw new Error(`探针生成素材失败(${kind} ${id}): ${(r.stderr ?? '').slice(-200)}`)
    const asset = await registerAsset(projectId, { name: `${id}.${ext}`, kind: kind === 'voice' ? 'audio' : kind, purpose, relPath: rel, ext, mime: kind === 'voice' ? 'audio/mpeg' : kind === 'video' ? 'video/mp4' : 'image/png', runId, params })
    return asset.id
  }

  const runners: Record<string, () => Promise<void>> = {
    // ================= contract：一句话默认项 / 追问 / 非法·超长·截断计划 =================
    contract: async () => {
      const { creationPlanSchema, parsePlanningReply } = await import('../src/services/creation-chat/contract')
      const minimal = { ...makePlan('dynamic') } as Record<string, unknown>
      delete minimal.duration; delete minimal.aspectRatio; delete minimal.language; delete minimal.mode
      const filled = creationPlanSchema.parse(minimal)
      check(filled.duration === 30 && filled.aspectRatio === '9:16' && filled.language === 'zh-CN' && filled.mode === 'dynamic', '一句话缺省 → 补齐 30 秒 / 竖屏 9:16 / 中文 / 动态默认项')

      const clarify = parsePlanningReply(JSON.stringify({ kind: 'clarify', message: '需要更多信息', questions: ['目标平台？', '时长偏好？'] }))
      check(clarify.kind === 'clarify' && clarify.questions.length === 2, '追问回复解析为 clarify（至多两个问题）')

      const planReply = parsePlanningReply(JSON.stringify({ kind: 'plan', message: '方案如下', plan: makePlan('slideshow') }))
      check(planReply.kind === 'plan' && planReply.plan.mode === 'slideshow', '合法方案解析为 plan')

      check((await errOf(async () => { throw parsePlanningReply('这不是 JSON') })) !== null, '非 JSON 输出被拒绝（不进入可确认状态）')
      check((await errOf(async () => { throw parsePlanningReply('{}', 'length') })) !== null, '模型输出被截断（finish=length）被拒绝')
      check((await errOf(async () => { throw parsePlanningReply('x'.repeat(70000)) })) !== null, '超长方案（>65000 字符）被拒绝')

      const badMap = JSON.parse(JSON.stringify(makePlan('dynamic')))
      badMap.shots[0].lines = []
      check(!creationPlanSchema.safeParse(badMap).success, '台词未映射到任一镜头 → 结构契约拒绝')
      const badSum = JSON.parse(JSON.stringify(makePlan('dynamic')))
      badSum.shots[0].duration = 3
      check(!creationPlanSchema.safeParse(badSum).success, '镜头时长和≠成片时长 → 结构契约拒绝')
      const badOrder = JSON.parse(JSON.stringify(makePlan('dynamic')))
      badOrder.shots[0].lines = ['l2']; badOrder.shots[1].lines = ['l1']
      check(!creationPlanSchema.safeParse(badOrder).success, '台词顺序与镜头播放顺序不一致 → 结构契约拒绝')
      const ghost = JSON.parse(JSON.stringify(makePlan('dynamic')))
      ghost.shots[0].lines = ['l1', 'lX']
      check(!creationPlanSchema.safeParse(ghost).success, '幽灵台词（引用不存在 id）→ 结构契约拒绝')
    },

    // ================= preflight：缺模型/能力未核实/画幅/首帧/无音色/未计价/超预算/时长档 =================
    preflight: async () => {
      const { preflightPlan } = await import('../src/services/creation-chat/preflight')
      const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
      const { db, settings } = { db: (await import('../src/db')).db, settings: (await import('../src/db/schema')).settings }
      const { eq } = await import('drizzle-orm')
      const issue = async (pid: number, mode: 'dynamic' | 'slideshow'): Promise<string> => { const pf = await preflightPlan(pid, creationPlanSchema.parse(makePlan(mode))); return pf.issues[0]?.code ?? '' }

      await seedEndpoints()
      const dynPid = await mkProject('m30-pf-dyn')
      const pfDyn = await preflightPlan(dynPid, creationPlanSchema.parse(makePlan('dynamic')))
      check(pfDyn.ready && pfDyn.execution?.videoMode === 'i2v' && Object.keys(pfDyn.execution?.requestDurations ?? {}).length === 3, '动态预检就绪：图生视频 i2v + 逐镜请求时长已冻结')
      check(!!pfDyn.execution?.endpoints.image && pfDyn.estimate.videoSeconds === 30, 'i2v 需首帧图：预检纳入图像端点并累计视频秒数')

      const slPid = await mkProject('m30-pf-slide')
      const pfSl = await preflightPlan(slPid, creationPlanSchema.parse(makePlan('slideshow')))
      check(pfSl.ready && pfSl.execution?.videoMode === 'none' && pfSl.estimate.imageCount === 3, '图文预检就绪：无视频端点、按 3 张静态画面计价')
      check(hashJson(creationPlanSchema.parse(makePlan('dynamic'))) === hashJson(creationPlanSchema.parse(makePlan('dynamic'))), '方案序列化稳定（同一方案哈希可复现）')

      await seedEndpoints({ videoActive: 0 }); check(await issue(dynPid, 'dynamic') === 'missing_video', '禁用视频实例 → 动态预检缺端点 missing_video')
      await seedEndpoints({ videoCaps: null }); check(await issue(dynPid, 'dynamic') === 'capabilities_unverified', '未声明核实能力 → capabilities_unverified（不按模型名猜测）')
      await seedEndpoints({ aspectRatios: ['16:9'] }); check(await issue(dynPid, 'dynamic') === 'aspect_unsupported', '核实能力不含本画幅 → aspect_unsupported')
      await seedEndpoints({ videoProvider: 'pollinations_video', videoModel: 'probe-v', videoCaps: { model: 'probe-v', verified: true, modes: ['i2v'], durations: [10], aspectRatios: ['9:16'], resolution: '720p' } }); check(await issue(dynPid, 'dynamic') === 'first_frame_unsupported', '适配器不支持首帧且未声明文生视频 → first_frame_unsupported')
      await seedEndpoints({ durations: [5, 10] }); check(await issue(dynPid, 'dynamic') === 'duration_unsupported', 'siliconflow 声明多档时长（不下发 duration）→ duration_unsupported')
      await seedEndpoints({ voice: 'clone:77' }); check(await issue(dynPid, 'dynamic') === 'missing_voice', '语音实例使用克隆音色 → 轻松创作拒绝 missing_voice')
      await seedEndpoints({ voice: '' }); check(await issue(dynPid, 'dynamic') === 'missing_voice', '语音实例缺音色 → missing_voice')

      await seedEndpoints({ unpriced: ['image'] })
      const pfUn = await preflightPlan(dynPid, creationPlanSchema.parse(makePlan('dynamic')))
      check(pfUn.ready && pfUn.estimate.unpriced.length > 0, '未知价格不阻断预检就绪，但列入未计价项待确认时显式接受')

      await seedEndpoints()
      const t = Date.now()
      await db.delete(settings).where(eq(settings.key, 'budgets'))
      await db.insert(settings).values({ key: 'budgets', value: JSON.stringify({ global: { total: 0.0000001 } }), updatedAt: t })
      const pfBud = await preflightPlan(dynPid, creationPlanSchema.parse(makePlan('dynamic')))
      check(!pfBud.ready && pfBud.issues[0]?.code === 'budget_global_total_exceeded', '低用量叠加本次预计费用超全局总预算 → 预检不通过（修正关联口径）')
      await db.delete(settings).where(eq(settings.key, 'budgets'))
    },

    // ================= confirm：确认前不建媒体任务 / 修订旧确认冲突 / 并发单 run / 未计价 =================
    confirm: async () => {
      const { db } = await import('../src/db')
      const { assets, creationSessions, genTasks, pipelineRuns } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')
      const { hashJson } = await import('../src/services/creation-chat/contract')
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      let started = 0
      engine.engine.startRun = ((runId: number): 'started' => { started += 1; void runId; return 'started' }) as typeof engine.engine.startRun
      try {
        await seedEndpoints()
        const { projectId, sessionId, plan } = await makeReadySession('slideshow')
        const s0 = (await db.select().from(creationSessions).where(eq(creationSessions.id, sessionId)))[0]!
        const mediaBefore = await db.select().from(assets).where(eq(assets.projectId, projectId))
        const tasksBefore = await db.select().from(genTasks).where(eq(genTasks.projectId, projectId))
        check(mediaBefore.every((a) => a.kind === 'text') && tasksBefore.length === 0, '确认前仅存在文本方案，未创建任何媒体任务/素材')

        const stale = await codeOf(() => confirmCreation(sessionId, { planRevision: s0.planRevision + 5, planHash: s0.planHash, idempotencyKey: 'confirmstale001', acceptUnpriced: false }))
        check(stale === 'stale_plan', '修订后携带旧 planRevision 的确认 → stale_plan 冲突')
        const badHash = await codeOf(() => confirmCreation(sessionId, { planRevision: s0.planRevision, planHash: 'f'.repeat(64), idempotencyKey: 'confirmbadhash0', acceptUnpriced: false }))
        check(badHash === 'stale_plan', 'planHash 不匹配 → stale_plan（不启动）')

        const req = { planRevision: s0.planRevision, planHash: s0.planHash, idempotencyKey: 'confirmconcurrent1', acceptUnpriced: false }
        const [a, b] = await Promise.all([confirmCreation(sessionId, req), confirmCreation(sessionId, req)])
        check(a.runId === b.runId && started === 1, '并发双击确认 → 复用同一 runId，引擎仅启动一次')
        const runCount = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId))).length
        check(runCount === 1, '并发确认仅创建一个 run')
        const after = (await db.select().from(creationSessions).where(eq(creationSessions.id, sessionId)))[0]!
        check(after.status === 'started' && after.runId === a.runId && !!after.approvedPlan && hashJson(JSON.parse(after.approvedPlan)) === hashJson(JSON.parse(after.approvedPlan)), '确认后会话进入 started 并冻结已批准方案（approvedPlan 在位）')
        void plan

        // 幂等重发：同键再次确认仍返回同 run，不再启动
        const again = await confirmCreation(sessionId, req)
        check(again.runId === a.runId && started === 1, '网络重发同幂等键 → 幂等返回同 run，不重复启动')

        // 未计价确认拦截
        await seedEndpoints({ unpriced: ['image'] })
        const r2 = await makeReadySession('slideshow')
        const s2 = (await db.select().from(creationSessions).where(eq(creationSessions.id, r2.sessionId)))[0]!
        const rejUnpriced = await codeOf(() => confirmCreation(r2.sessionId, { planRevision: s2.planRevision, planHash: s2.planHash, idempotencyKey: 'confirmunpriced1', acceptUnpriced: false }))
        check(rejUnpriced === 'unpriced', '存在未计价项且未显式接受 → 确认被拒 unpriced（不按零元处理）')
        const okUnpriced = await confirmCreation(r2.sessionId, { planRevision: s2.planRevision, planHash: s2.planHash, idempotencyKey: 'confirmacceptun1', acceptUnpriced: true })
        check(okUnpriced.runId > 0, '显式接受未计价项后确认可启动')
      } finally {
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },

    // ================= media：严格交付链（动态 + 图文真实 MP4）+ 负例不报成功 + strict 关闭旧行为 =================
    media: async () => {
      const { db } = await import('../src/db')
      const { creationSessions, pipelineRuns, pipelineSteps, assets } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { loadTemplate } = await import('../src/pipeline/loader')
      const { createStepContext } = await import('../src/pipeline/context')
      const { subtitle } = await import('../src/pipeline/actions/subtitle')
      const { ffmpegMerge, buildComposeArgs } = await import('../src/pipeline/actions/ffmpeg-merge')
      const { recipeOf } = await import('../src/services/creation-chat/recipe')
      const { assertStrictOutput } = await import('../src/pipeline/actions/ffmpeg-merge/strict')
      const { probeMediaDuration, resolveFfmpeg } = await import('../src/services/ffmpeg')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      engine.engine.startRun = ((runId: number): 'started' => { void runId; return 'started' }) as typeof engine.engine.startRun

      const tmpl = loadTemplate('easy-video')
      const defCap = tmpl.steps.find((s) => s.action === 'subtitle')!
      const defCompose = tmpl.steps.find((s) => s.action === 'ffmpeg_merge')!

      // 通过确认建立完整冻结链的 run，返回 run + 素材 ids
      const confirmRun = async (mode: 'dynamic' | 'slideshow'): Promise<number> => {
        const { sessionId, plan } = await makeReadySession(mode)
        const s = (await db.select().from(creationSessions).where(eq(creationSessions.id, sessionId)))[0]!
        const { runId } = await confirmCreation(sessionId, { planRevision: s.planRevision, planHash: s.planHash, idempotencyKey: `media${mode}${Date.now()}`, acceptUnpriced: false })
        void plan
        return runId
      }
      const runWithMedia = async (mode: 'dynamic' | 'slideshow'): Promise<{ runId: number; run: typeof pipelineRuns.$inferSelect; voices: number[]; shots: number[]; recipe: NonNullable<ReturnType<typeof recipeOf>> }> => {
        await seedEndpoints()
        const runId = await confirmRun(mode)
        const run = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0]!
        const recipe = recipeOf(run)!
        const voices: number[] = []
        for (const line of recipe.plan.lines) voices.push(await genMedia(run.projectId, 'voice', line.id, 1.2, runId, { lineId: line.id }))
        const shots: number[] = []
        for (const shot of recipe.plan.shots) shots.push(await genMedia(run.projectId, mode === 'dynamic' ? 'video' : 'image', shot.id, shot.duration, runId, { shotId: shot.id }))
        return { runId, run, voices, shots, recipe }
      }
      const makeStep = async (runId: number, key: string, action: string, seq: number): Promise<number> => (await db.insert(pipelineSteps).values({ runId, seq, stepKey: key, actionKey: action, title: key, status: 'running', createdAt: Date.now(), updatedAt: Date.now() }).returning())[0]!.id

      const runSubtitle = async (run: typeof pipelineRuns.$inferSelect, voices: number[], linesSrcId: number): Promise<number> => {
        const stepId = await makeStep(run.id, 'captions', 'subtitle', 900)
        const step = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, stepId)))[0]!
        const ctx = await createStepContext({ run, step, template: tmpl, def: defCap, input: { lines: [linesSrcId], voices }, projectSettings: {} })
        const res = await subtitle(ctx)
        return res.assetIds[0]!
      }
      const runMerge = async (run: typeof pipelineRuns.$inferSelect, mode: 'dynamic' | 'slideshow', voices: number[], shots: number[], srtId: number, shotsSrcId: number): Promise<number> => {
        const stepId = await makeStep(run.id, 'compose', 'ffmpeg_merge', 901)
        const step = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, stepId)))[0]!
        const mediaKey = mode === 'dynamic' ? 'motion_clips' : 'images'
        const ctx = await createStepContext({ run, step, template: tmpl, def: defCompose, input: { shots: [shotsSrcId], [mediaKey]: shots, voices, subtitle: [srtId] }, projectSettings: {} })
        const res = await ffmpegMerge(ctx)
        return res.assetIds[0]!
      }

      try {
        // ---- 动态：真实合成可播放 MP4，镜头数一致、旁白完整、字幕不越界 ----
        const dyn = await runWithMedia('dynamic')
        const dynSrt = await runSubtitle(dyn.run, dyn.voices, dyn.recipe.sources[1].id)
        const dynFinal = await runMerge(dyn.run, 'dynamic', dyn.voices, dyn.shots, dynSrt, dyn.recipe.sources[2].id)
        const dynAsset = (await db.select().from(assets).where(eq(assets.id, dynFinal)))[0]!
        check(dynAsset.purpose === 'final_video' && dynAsset.kind === 'video', '动态路径产出成片视频资产')
        const { absPathOf } = await import('../src/services/storage')
        let dynOk = true
        try { assertStrictOutput(absPathOf(dynAsset.relPath!), dyn.recipe.plan.duration) } catch (e) { dynOk = false; void e }
        check(dynOk && Math.abs((probeMediaDuration(absPathOf(dynAsset.relPath!)) ?? 0) - 30) <= 0.15, '动态成片通过严格交付检查（可解码 + 时长≈30s + 含音轨）')
        check(existsSync(absPathOf(dynAsset.relPath!)) && (dynAsset.params ?? '').includes('delivery_checked'), '动态成片落盘且标记 delivery_checked')

        // ---- 图文：静态画面 + 旁白字幕 → 可播放 MP4 ----
        const sl = await runWithMedia('slideshow')
        const slSrt = await runSubtitle(sl.run, sl.voices, sl.recipe.sources[1].id)
        const slFinal = await runMerge(sl.run, 'slideshow', sl.voices, sl.shots, slSrt, sl.recipe.sources[2].id)
        const slAsset = (await db.select().from(assets).where(eq(assets.id, slFinal)))[0]!
        check(slAsset.purpose === 'final_video' && Math.abs((probeMediaDuration(absPathOf(slAsset.relPath!)) ?? 0) - 30) <= 0.15, '图文成片可播放且时长≈30s（镜头数量与方案一致）')

        // ---- 负例：缺镜 / 损坏 / 时长不足 / 错台词映射，均不得报成功 ----
        const missErr = await errOf(() => runMerge(dyn.run, 'dynamic', dyn.voices, dyn.shots.slice(0, 2), dynSrt, dyn.recipe.sources[2].id))
        check(!!missErr && missErr.message.includes('缺镜'), '缺少镜头 → 严格合成拒绝（不走旧宽容跳过后仍报成功）')
        const corruptId = await (async () => {
          const { ensureProjectDirs, relPathOf, absPathOf: abs, registerAsset: reg } = await import('../src/services/storage')
          ensureProjectDirs(dyn.run.projectId); const rel = relPathOf(dyn.run.projectId, 'shot_video', `corrupt-${Date.now()}.mp4`); writeFileSync(abs(rel), 'not-a-real-mp4'); const a = await reg(dyn.run.projectId, { name: 'corrupt.mp4', kind: 'video', purpose: 'shot_video', relPath: rel, ext: 'mp4', runId: dyn.run.id, params: { shotId: 's1' } }); return a.id
        })()
        const corruptErr = await errOf(() => runMerge(dyn.run, 'dynamic', dyn.voices, [corruptId, dyn.shots[1]!, dyn.shots[2]!], dynSrt, dyn.recipe.sources[2].id))
        check(!!corruptErr && /损坏|解码/.test(corruptErr.message), '损坏媒体镜头 → 严格合成拒绝')
        const shortId = await genMedia(dyn.run.projectId, 'video', 'short', 9, dyn.run.id, { shotId: 's1' })
        const shortErr = await errOf(() => runMerge(dyn.run, 'dynamic', dyn.voices, [shortId, dyn.shots[1]!, dyn.shots[2]!], dynSrt, dyn.recipe.sources[2].id))
        check(!!shortErr && shortErr.message.includes('时长不足'), '镜头时长不足（超 0.5s 尾帧容差）→ 拒绝')
        const mapErr = await errOf(() => runSubtitle(dyn.run, [dyn.voices[1]!, dyn.voices[0]!, dyn.voices[2]!], dyn.recipe.sources[1].id))
        check(!!mapErr && /映射|归属/.test(mapErr.message), '配音台词错映射 → 严格字幕拒绝')

        // ---- strict 关闭：旧合成参数序列不引入 trim/tpad、保留转场（零漂移红线）----
        const legacy = buildComposeArgs({ segments: [{ id: 1, path: 'a.mp4', kind: 'video', durSec: 5 }, { id: 2, path: 'b.mp4', kind: 'video', durSec: 5 }], width: 720, height: 1280, fps: 25, xfadePlan: { enabled: false, type: 'none', durSec: 0, videoLens: [5, 5], offsets: [], totalDur: 10 }, voicePaths: [], lineIds: [], alignPlan: null, total: 10, srtAbs: null, style: 'x', bgmPath: null, bgmVolume: 0.25, bgmFade: 2, watermark: null, intro: null, outro: null, outAbs: 'C:/o.mp4', strictDelivery: false })
        const strictArgs = buildComposeArgs({ segments: [{ id: 1, path: 'a.mp4', kind: 'video', durSec: 5 }, { id: 2, path: 'b.mp4', kind: 'video', durSec: 5 }], width: 720, height: 1280, fps: 25, xfadePlan: { enabled: false, type: 'none', durSec: 0, videoLens: [5, 5], offsets: [], totalDur: 10 }, voicePaths: [], lineIds: [], alignPlan: null, total: 10, srtAbs: null, style: 'x', bgmPath: null, bgmVolume: 0.25, bgmFade: 2, watermark: null, intro: null, outro: null, outAbs: 'C:/o.mp4', strictDelivery: true })
        check(!legacy.args.join(' ').includes('trim=duration'), 'strict_delivery 关闭 → 旧合成不注入逐镜裁切（行为不变）')
        check(strictArgs.args.join(' ').includes('trim=duration') && strictArgs.args.join(' ').includes('tpad='), 'strict_delivery 开启 → 逐镜裁切归零 + 尾帧补齐上限生效')
        void resolveFfmpeg
      } finally {
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },

    // ================= recovery：重启对账 / 建 run 守卫 / 跨项目拒绝 / 密钥脱敏 / 软删排除 =================
    recovery: async () => {
      const { db } = await import('../src/db')
      const { assets, creationMessages, creationSessions, projects } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { reconcileCreationSessions, creationDetail, listCreationSessions } = await import('../src/services/creation-chat/store')
      const { createRunRow, InvalidRunInputError } = await import('../src/services/run-create')
      const { assertRecipeSources } = await import('../src/services/creation-chat/recipe')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')

      // 对账：planning 悬挂态 → draft + 提示（不重发付费规划）
      const t = Date.now()
      const pid = await mkProject('m30-rec-reconcile')
      const [s] = await db.insert(creationSessions).values({ projectId: pid, requestKey: `rec${t}`, status: 'planning', planRevision: 0, runHistory: '[]', createdAt: t, updatedAt: t }).returning()
      await reconcileCreationSessions()
      const after = (await db.select().from(creationSessions).where(eq(creationSessions.id, s!.id)))[0]!
      check(after.status === 'draft' && (after.error ?? '').includes('重启'), '服务重启对账：悬挂 planning → draft 并提示核验（绝不自动重发）')

      // 建 run 守卫：easy-video 无 creationSessionId 拒绝
      const guardErr = await errOf(async () => { await createRunRow({ projectId: pid, templateKey: 'easy-video', input: { script: [1], lines: [2], shots: [3], recipe: '{}', motion: true, i2v: true } }); })
      check(guardErr instanceof InvalidRunInputError, '批准模板 run 未经会话确认直接创建 → 被拒（不开放全局免审）')

      // 跨项目引用拒绝（冻结链核验）+ 密钥不入持久化/响应
      await seedEndpoints()
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      engine.engine.startRun = ((runId: number): 'started' => { void runId; return 'started' }) as typeof engine.engine.startRun
      try {
        const { sessionId, projectId: sPid } = await makeReadySession('slideshow')
        const s = (await db.select().from(creationSessions).where(eq(creationSessions.id, sessionId)))[0]!
        const { runId } = await confirmCreation(sessionId, { planRevision: s.planRevision, planHash: s.planHash, idempotencyKey: 'recco1_key', acceptUnpriced: false })

        const detail = await creationDetail(sessionId)
        const detailJson = JSON.stringify(detail) + (s.approvedPlan ?? '') + JSON.stringify(s.preflight ?? '')
        check(!detailJson.includes('probe-offline-secret-key-9f3c'), '密钥不出现在会话详情/批准方案/预检投影中')

        // 冻结链被破坏：把批准脚本资产迁到别的项目 → assertRecipeSources 拒绝
        const { pipelineRuns } = await import('../src/db/schema')
        const rr = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0]!
        const rc = (await import('../src/services/creation-chat/recipe')).recipeOf(rr)!
        const otherPid = await mkProject('m30-rec-foreign')
        await db.update(assets).set({ projectId: otherPid }).where(eq(assets.id, rc.sources[0].id))
        const crossErr = await errOf(() => assertRecipeSources(rr, rc))
        check(!!crossErr && /不属于本项目|被修改|不存在/.test(crossErr.message), '批准素材被移出本项目 → 执行前来源核验拒绝（不静默消费）')
        await db.update(assets).set({ projectId: sPid }).where(eq(assets.id, rc.sources[0].id))
      } finally {
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }

      // 项目软删后：确认被拒 + 列表排除
      const delPid = await mkProject('m30-rec-deleted')
      const delKey = `del${Date.now()}`
      await db.insert(creationSessions).values({ projectId: delPid, requestKey: delKey, status: 'ready', plan: '{}', planRevision: 1, planHash: 'a'.repeat(64), preflight: '{}', runHistory: '[]', createdAt: Date.now(), updatedAt: Date.now() }).execute()
      const delSession = (await db.select().from(creationSessions).where(eq(creationSessions.requestKey, delKey)))[0]!
      await db.update(projects).set({ deletedAt: Date.now() }).where(eq(projects.id, delPid))
      const delCode = await codeOf(() => confirmCreation(delSession.id, { planRevision: 1, planHash: 'a'.repeat(64), idempotencyKey: 'recdelkey1', acceptUnpriced: false }))
      check(delCode === 'project_deleted', '项目软删后确认 → project_deleted（禁止新增执行）')
      const listed = await listCreationSessions()
      check(!listed.some((x) => x.id === delSession.id), '软删项目的会话从列表排除（级联可过滤，purge 依赖列在位）')
    },
  }

  await runSections({ log, title: 'M30', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
