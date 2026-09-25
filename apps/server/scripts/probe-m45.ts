/**
 * M45 探针（轻松创作第四批：成品品牌贯通——水印/片头尾/字幕样式）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m45.ts [--section=gate|preflight|confirm]
 *
 * 隔离策略：isolatedEnv('m45') 一次性临时目录（独立 studio.db + workspace），必须在任何 src import 前调用。
 * 模板目录只读拷贝进隔离区（preflight 的 templateHash 需要 easy-video），prompts 走 junction 桥接。
 * 零网络、零付费：fetch 全阻断，只放行 seedEndpoints 的假 LLM 端点（/chat/completions）；
 * 媒体调用计数断言 =0（品牌叠加是合成期 ffmpeg 处理，开关任何取值都不得起生成）。engine.startRun / isRunning 全程 stub。
 *
 * 品牌夹具：字幕样式配置（sanitizeSubtitleStyle 纯配置即产出非空 brand，无需文件系统/资产），
 * 是驱动 brandSummary / resolveBrandConfig 的最低耦合夹具；水印槽缺位 → 摘要 watermark=false（不夸大）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, REPO_ROOT, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup, tmp } = isolatedEnv('m45', { bridge: ['prompts'] })
cpSync(join(REPO_ROOT, 'workspace', 'templates'), join(tmp, 'workspace', 'templates'), { recursive: true })
process.env.PROBE_M45_KEY = 'probe-offline-secret-key-45a1'

const SECTIONS = ['gate', 'preflight', 'confirm'] as const

/** 3 镜 × 10 秒 = 30 秒（与 M43 同夹具，最小化漂移） */
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

const ALIYUN = { providerKey: 'aliyun_bailian_video', model: 'Wan3.0-I2V' }

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m45')
  const checker: Checker = makeChecker(log)
  const check = checker.check
  const originalFetch = globalThis.fetch

  let mediaCalls = 0
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('http://localhost:0/offline')) { mediaCalls += 1; throw new Error('探针禁止外部网络') }
    if (!url.includes('/chat/completions')) { mediaCalls += 1; throw new Error('M45 写路径不得直接调媒体生成') }
    void init
    return Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } })
  }
  // engine.startRun 全程 stub；isRunning → false（confirm 落 queued run，retry 需 !isRunning）
  const { engine } = await import('../src/pipeline/engine')
  engine.startRun = ((runId: number) => { void runId; return 'started' }) as typeof engine.startRun
  engine.isRunning = (() => false) as typeof engine.isRunning

  const mkProject = async (name: string, settingsJson = '{}'): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    return (await db.insert(projects).values({ name, genre: 'talking_head', templateKey: 'easy-video', status: 'draft', settings: settingsJson, tags: '[]', createdAt: t, updatedAt: t }).returning())[0]!.id
  }

  type VideoSeed = { providerKey: string; model: string; extra?: Record<string, unknown> }
  const seedEndpoints = async (video: VideoSeed = ALIYUN): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    await initDb()
    const { apiConfigs } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    for (const kind of ['llm', 'audio', 'image', 'video'] as const) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, kind))
    const t = Date.now()
    const insert = (v: Record<string, unknown>): Promise<unknown> => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M45_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: String(v.pricing ?? '{}'), isActive: 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
    await insert({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
    await insert({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', extra: { voice: 'alloy' }, pricing: '{"char":0.1}' })
    await insert({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: '{"image":0.1}' })
    await insert({ name: 'video', serviceType: 'video', pricing: '{"second":0.1}', ...video })
  }

  const BRAND_SUBTITLE = JSON.stringify({ brand: { subtitle: { font: 'ProbeSerif', color: '#00FF00' } } })

  /** 旁路 LLM 直建「待确认」会话（与 M43 同口径）；branded 时项目 settings 挂字幕样式品牌 */
  const makeReadySession = async (mode: 'dynamic' | 'slideshow', opts?: { branded?: boolean }) => {
    const { db } = await import('../src/db')
    const { creationSessions } = await import('../src/db/schema')
    const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
    const { preflightPlan } = await import('../src/services/creation-chat/preflight')
    const projectId = await mkProject(`probe-m45-${mode}-${Date.now()}`, opts?.branded ? BRAND_SUBTITLE : '{}')
    const plan = creationPlanSchema.parse(makePlan(mode))
    const pf = await preflightPlan(projectId, plan)
    const t = Date.now()
    const [s] = await db.insert(creationSessions).values({
      projectId, requestKey: `m45ready${mode}${t}`, status: pf.ready ? 'ready' : 'draft', plan: JSON.stringify(plan),
      planRevision: 1, planHash: pf.execution ? hashJson({ plan, execution: pf.execution }) : null, preflight: JSON.stringify(pf), runHistory: '[]', createdAt: t, updatedAt: t,
    }).returning()
    return { projectId, sessionId: s!.id, plan, pf }
  }

  const sessRow = async (id: number) => {
    const { db } = await import('../src/db')
    const { creationSessions } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    return (await db.select().from(creationSessions).where(eq(creationSessions.id, id)))[0]!
  }
  const runRow = async (id: number) => {
    const { db } = await import('../src/db')
    const { pipelineRuns } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    return (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)))[0]!
  }

  const runners: Record<string, () => Promise<void>> = {
    // ============ gate：模板集合 / _compose 解析 / 门真值表 / resolveBrandConfig 真值 ============
    gate: async () => {
      const { isCreationTemplate } = await import('../src/services/creation-chat/recipe')
      const { readComposeConfig } = await import('../src/services/compose-config')
      const { resolveBrandConfig } = await import('../src/services/brand-config')
      await seedEndpoints()
      check(isCreationTemplate('easy-video') && isCreationTemplate('easy-video-review') && isCreationTemplate('easy-dialogue'), '创作批准链模板集合 → 严格 run 获得默认继承资格')
      check(!isCreationTemplate('talking-head') && !isCreationTemplate('short-video'), '非创建模板键不在集合内')

      check(readComposeConfig(null).brandApply === undefined, '空 input → brandApply=undefined（缺省继承，不误判为关）')
      check(readComposeConfig('{"_compose":{"brandApply":false}}').brandApply === false, '解析 _compose.brandApply=false')
      check(readComposeConfig('{"_compose":{"brandApply":true}}').brandApply === true, '解析 _compose.brandApply=true')
      const both = readComposeConfig('{"_compose":{"brand":{"subtitle":{"color":"#FFFFFF"}},"brandApply":false}}')
      check(both.brandApply === false && !!both.brand, 'brand（对象覆盖）与 brandApply（开关）同级不同键，无碰撞')

      // 字幕烧录开关解析（与 brandApply 同族：缺省=烧录，不误判为关）
      check(readComposeConfig(null).subtitleBurn === undefined, '空 input → subtitleBurn=undefined（缺省烧录，不误判为关）')
      check(readComposeConfig('{"_compose":{"subtitleBurn":false}}').subtitleBurn === false, '解析 _compose.subtitleBurn=false（关字幕烧录）')
      check(readComposeConfig('{"_compose":{"subtitleBurn":true}}').subtitleBurn === true, '解析 _compose.subtitleBurn=true')
      const bothSub = readComposeConfig('{"_compose":{"brandApply":false,"subtitleBurn":false}}')
      check(bothSub.brandApply === false && bothSub.subtitleBurn === false, 'brandApply（品牌样式）与 subtitleBurn（有无硬字幕）同级不同键，无碰撞')

      // 烧录门真值表：burn = srtExists && subtitleBurn !== false（ffmpeg-merge index.ts L423 同口径）
      const burn = (srtExists: boolean, subtitleBurn: boolean | undefined): boolean => srtExists && subtitleBurn !== false
      check(burn(true, undefined) === true, '缺省 subtitleBurn → 烧录（现状逐字节不变）')
      check(burn(true, false) === false, 'subtitleBurn=false → 不烧（srtAbs 置空，无 subtitles 滤镜）')
      check(burn(false, undefined) === false, '无 SRT 资产 → 无从烧录（与开关无关）')

      // ffmpeg-merge 门条件真值表：apply = !strict || (isCreationTemplate(key) && brandApply !== false)
      const apply = (strict: boolean, key: string, brandApply: boolean | undefined): boolean =>
        !strict || (isCreationTemplate(key) && brandApply !== false)
      check(apply(false, 'talking-head', undefined) && apply(false, 'talking-head', false), '非严格（专业）→ resolve（应用品牌，行为不变，即便误带 false）')
      check(apply(true, 'easy-video', undefined) === true, '严格+创建+缺省 → resolve（新默认继承）')
      check(apply(true, 'easy-video', false) === false, '严格+创建+逐次关 → 不 resolve（brand={}）')
      check(apply(true, 'talking-head', undefined) === false, '严格+非创建 → 从不 resolve（爆炸半径受 isCreationTemplate 限定）')

      const brandless = await mkProject('m45-gate-brandless')
      check(Object.keys(await resolveBrandConfig(brandless, null)).length === 0, '项目+平台均未配 → resolveBrandConfig 返回 {}（合成逐字节不变基线）')
      const branded = await mkProject('m45-gate-branded', BRAND_SUBTITLE)
      const rb = await resolveBrandConfig(branded, null)
      check(!!rb.subtitle && rb.subtitle?.font === 'ProbeSerif' && !rb.watermark, '字幕样式配置（纯配置无文件）→ 非空 brand；未配水印槽缺位')
      check(mediaCalls === 0, 'gate 节零媒体调用')
    },

    // ============ preflight：brandSummary 槽位透出 / 仅顶层不改 planHash ============
    preflight: async () => {
      const { preflightPlan } = await import('../src/services/creation-chat/preflight')
      const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
      await seedEndpoints()
      const plan = creationPlanSchema.parse(makePlan('dynamic'))
      const pA = await mkProject('m45-pf-brandless')
      const pB = await mkProject('m45-pf-branded', BRAND_SUBTITLE)
      const pfA = await preflightPlan(pA, plan)
      const pfB = await preflightPlan(pB, plan)
      check(pfA.ready && pfB.ready && !!pfA.execution && !!pfB.execution, '两项目预检均就绪（brandSummary 独立于 ready，异常不左摇预检）')
      check(pfA.brandSummary?.available === false, '未配品牌 → available=false（确认卡不渲染开关，逐字节不变）')
      check(pfB.brandSummary?.available === true && pfB.brandSummary?.subtitle === true && pfB.brandSummary?.watermark === false, '配字幕 → available=true 且槽位如实（水印缺位 false，不夸大）')
      check(hashJson({ plan, execution: pfA.execution }) === hashJson({ plan, execution: pfB.execution }), 'brandSummary 仅顶层透出 → execution 与 planHash 逐字节不变')
      check(mediaCalls === 0, 'preflight 节零媒体调用')
    },

    // ============ confirm：默认无 _compose / false 落库且配方不污染 / retry 克隆 / 契约 ============
    confirm: async () => {
      const { db } = await import('../src/db')
      const { pipelineRuns } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { confirmCreation, retryCreation } = await import('../src/services/creation-chat/execution')
      const { recipeOf } = await import('../src/services/creation-chat/recipe')
      const { readComposeConfig } = await import('../src/services/compose-config')
      const { confirmationSchema } = await import('../src/services/creation-chat/contract')
      await seedEndpoints()

      // 默认确认（不传 brandApply）：run.input 无 _compose（与旧版逐字节一致）
      const d = await makeReadySession('dynamic', { branded: true })
      const s = await sessRow(d.sessionId)
      const rDef = await confirmCreation(d.sessionId, { planRevision: s.planRevision, planHash: s.planHash, idempotencyKey: 'm45-def001', acceptUnpriced: false })
      const runDef = await runRow(rDef.runId)
      check(!('_compose' in (JSON.parse(runDef.input) as Record<string, unknown>)), '默认确认 → run.input 无 _compose 键（与旧版逐字一致）')
      check(readComposeConfig(runDef.input).brandApply === undefined, '默认 run → 门读 brandApply=undefined → 严格 run 继承品牌')

      // brandApply=false：开关绕过 normalizeInput 直落库；recipe 不污染；不作废方案
      const d2 = await makeReadySession('dynamic', { branded: true })
      const s2 = await sessRow(d2.sessionId)
      const rOff = await confirmCreation(d2.sessionId, { planRevision: s2.planRevision, planHash: s2.planHash, idempotencyKey: 'm45-off001', acceptUnpriced: false, brandApply: false })
      const runOff = await runRow(rOff.runId)
      const offInput = JSON.parse(runOff.input) as Record<string, unknown>
      check((offInput._compose as { brandApply?: unknown } | undefined)?.brandApply === false, 'brandApply=false → 落 run.input._compose.brandApply=false（normalizeInput 丢弃非声明键后经建后直写补回）')
      check(readComposeConfig(runOff.input).brandApply === false, 'ffmpeg-merge 门经 readComposeConfig 见 false → 严格合成分支 brand={}')
      check(!!recipeOf(runOff), '_compose 内部键不影响 recipeOf 解析（recipe 仍是合法快照）')
      check(recipeOf(runOff)!.refs.length === (d2.pf.execution?.refs.length ?? -1), 'brandApply=false 不改写 recipe refs（开关不作废批准方案）')
      const s2After = await sessRow(d2.sessionId)
      check(s2After.planHash === s2.planHash && s2After.planRevision === s2.planRevision, '开关不入 planHash：确认不抬 revision、不作废方案（价格注册表无品牌维度前提成立）')

      // 断点续跑：retryCreation 克隆整个 input 并显式补回 _compose → 开关随续跑保留
      await db.update(pipelineRuns).set({ status: 'failed' }).where(eq(pipelineRuns.id, rOff.runId))
      const rt = await retryCreation(d2.sessionId, { runId: rOff.runId, planRevision: s2After.planRevision, planHash: s2After.planHash, idempotencyKey: 'm45-retry1', acceptUnpriced: false, verifiedFailedTaskIds: [] })
      const runRetry = await runRow(rt.runId)
      check(readComposeConfig(runRetry.input).brandApply === false, '断点续跑克隆 _compose → brandApply=false 随续跑保留（开关非一次性消耗）')

      // subtitleBurn=false：逐次关硬字幕 → 落 _compose.subtitleBurn=false（同 brandApply 通道，normalizeInput 丢弃后建后直写补回），不影响 brandApply
      const dSub = await makeReadySession('dynamic', { branded: true })
      const sSub = await sessRow(dSub.sessionId)
      const rSub = await confirmCreation(dSub.sessionId, { planRevision: sSub.planRevision, planHash: sSub.planHash, idempotencyKey: 'm45-sub001', acceptUnpriced: false, subtitleBurn: false })
      const runSub = await runRow(rSub.runId)
      check((JSON.parse(runSub.input)._compose as { subtitleBurn?: unknown } | undefined)?.subtitleBurn === false, 'subtitleBurn=false → 落 run.input._compose.subtitleBurn=false')
      check(readComposeConfig(runSub.input).subtitleBurn === false, 'ffmpeg-merge 门经 readComposeConfig 见 subtitleBurn=false → 不烧硬字幕')
      check(readComposeConfig(runSub.input).brandApply === undefined, 'subtitleBurn 不影响 brandApply（两键独立，不误伤品牌叠加）')
      // 断点续跑：_compose 整体克隆 → subtitleBurn=false 随续跑保留
      await db.update(pipelineRuns).set({ status: 'failed' }).where(eq(pipelineRuns.id, rSub.runId))
      const sSubAfter = await sessRow(dSub.sessionId)
      const rtSub = await retryCreation(dSub.sessionId, { runId: rSub.runId, planRevision: sSubAfter.planRevision, planHash: sSubAfter.planHash, idempotencyKey: 'm45-subretry', acceptUnpriced: false, verifiedFailedTaskIds: [] })
      check(readComposeConfig((await runRow(rtSub.runId)).input).subtitleBurn === false, '断点续跑克隆 _compose → subtitleBurn=false 随续跑保留')
      // 契约：confirmationSchema 缺省 subtitleBurn=true
      check(confirmationSchema.parse({ planRevision: 1, planHash: 'a'.repeat(64), idempotencyKey: 'm45-sub-def', acceptUnpriced: false }).subtitleBurn === true, 'confirmationSchema 缺省 subtitleBurn=true（不传 = 维持烧录）')

      // 契约：confirmationSchema 默认 true / .strict() 拒未知键 / 路由级放行 false
      check(confirmationSchema.parse({ planRevision: 1, planHash: 'a'.repeat(64), idempotencyKey: 'm45-key-default', acceptUnpriced: false }).brandApply === true, 'confirmationSchema 缺省 brandApply=true')
      let threw = false
      try { confirmationSchema.parse({ planRevision: 1, planHash: 'a'.repeat(64), idempotencyKey: 'm45-key-strict', acceptUnpriced: false, hacker: 1 }) } catch { threw = true }
      check(threw, 'confirmationSchema .strict() 拒未知键（两端契约对齐）')
      const d3 = await makeReadySession('dynamic', { branded: true })
      const s3 = await sessRow(d3.sessionId)
      const httpRes = await app.request(`/api/v1/creation-sessions/${d3.sessionId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planRevision: s3.planRevision, planHash: s3.planHash, idempotencyKey: 'm45-http', acceptUnpriced: false, brandApply: false }) })
      check(httpRes.status === 202, '确认路由接受 brandApply:false（202 受理；.strict 显式声明该键，否则 422）')
      check(mediaCalls === 0, 'confirm 节零媒体调用（品牌叠加是合成期处理，开关任何取值都不起生成）')
    },
  }

  await runSections({ log, title: 'M45', checker, sections: SECTIONS, runners, cleanup: () => { globalThis.fetch = originalFetch; envCleanup() } })
}
void main()
