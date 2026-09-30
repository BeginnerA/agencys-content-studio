/**
 * M56 探针（轻松创作「毕业通道」：把已确认并开始的方案，在同一项目起一个专业链 queued run）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m56.ts [--section=schema|episode|series|guards|drift]
 *
 * 背景：立项时曾误编号 M48，与已交付里程碑 M48（统一取消/续跑/预算）冲突，故按最新 roadmap 复核改用 M56（现有探针最高 m55）。
 *
 * 隔离策略：isolatedEnv('m56', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须在任何 src 动态 import 前调用。零网络、零付费模型调用：graduate 全程为纯 DB + 模板装载，
 *   - 探针 stub globalThis.fetch（计数）核验毕业路径不触碰任何远端；
 *   - stub engine.startRun（计数）核验「只建 queued、绝不自动启动/计费」；
 *   - 直插 active 项目 + started 会话（挂 easy run）+ 批准剧本资产（purpose=script, runId=会话 run），
 *     旁路 LLM 与真实媒体执行。
 *
 * 断言聚焦 M56 契约：批准剧本经既有 setting_docs（单集）/plan_doc（连载）锚定、毕业不新增模板步骤/不改结构（M60 后
 * 出厂版本为 mengbao-episode v15 / series-setup v4，毕业链仍零改动），幂等复用未启动专业 run、未确认拒绝、prev_script 不被误用。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m56', { bridge: ['templates', 'prompts'] })

const SECTIONS = ['schema', 'episode', 'series', 'guards', 'drift'] as const

/** 3 镜 × 10 秒 = 30 秒（与 m40 同构，最小合法方案；mode 决定 graduate 是否注入 motion） */
function makePlan(mode: 'dynamic' | 'slideshow') {
  return {
    title: '小镖客的最后一程', summary: '萌宝镖客最后一次护送', genre: 'story' as const, duration: 30,
    aspectRatio: '9:16' as const, language: 'zh-CN' as const, mode, style: '古风热血',
    script: '风沙起。\n刀出鞘。\n人未归。',
    lines: [
      { id: 'l1', text: '风沙起' },
      { id: 'l2', text: '刀出鞘' },
      { id: 'l3', text: '人未归' },
    ],
    shots: [
      { id: 's1', duration: 10, image_prompt: '大漠孤城', motion_prompt: '缓慢推近', lines: ['l1'] },
      { id: 's2', duration: 10, image_prompt: '少年拔刀', motion_prompt: '镜头环绕', lines: ['l2'] },
      { id: 's3', duration: 10, image_prompt: '空鞍归马', motion_prompt: '镜头下移', lines: ['l3'] },
    ],
  }
}

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m56')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const errOf = async (fn: () => Promise<unknown>): Promise<Error | null> => {
    try { await fn(); return null } catch (err) { return err instanceof Error ? err : new Error(String(err)) }
  }
  // 从异常读契约字段（code/status 均可选，避免 Error→具体形状的不安全转换）
  const fieldOf = (e: Error | null, key: 'code' | 'status'): unknown => (e as unknown as Record<string, unknown> | null)?.[key]

  // ---- 零网络哨兵：任何 fetch 调用都计数（graduate 应恒为 0）----
  let fetchCalls = 0
  const stubFetch = (async (input: string | URL | Request): Promise<Response> => {
    fetchCalls += 1
    void input
    return new Response('{}', { status: 599, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const runners: Record<string, () => Promise<void>> = {
    // ================= schema：毕业请求契约（纯函数，零 DB） =================
    schema: async () => {
      const { graduateSchema } = await import('../src/services/creation-chat/graduate')
      check(graduateSchema.parse({ mode: 'episode' }).mode === 'episode', 'episode 合法请求通过')
      check(graduateSchema.parse({ mode: 'series' }).mode === 'series', 'series 合法请求通过')
      check(graduateSchema.parse({ mode: 'episode', episodeNumber: 3 }).episodeNumber === 3, '集号可选且透传')
      check((await errOf(async () => graduateSchema.parse({ mode: 'documentary' }))) !== null, '未知 mode → 拒绝（枚举收紧）')
      check((await errOf(async () => graduateSchema.parse({ mode: 'episode', bogusKey: 1 }))) !== null, '未知字段 → strict 拒绝（契约不外扩）')
      check((await errOf(async () => graduateSchema.parse({ mode: 'episode', episodeNumber: 0 }))) !== null, '集号 0 → 越下界拒绝')
      check((await errOf(async () => graduateSchema.parse({ mode: 'episode', episodeNumber: 10000 }))) !== null, '集号 10000 → 越上界拒绝')
    },

    // ================= episode：单集升级（建 mengbao-episode queued run + setting_docs 锚定 + 幂等） =================
    episode: async () => {
      const { db, initDb } = await import('../src/db')
      const { creationMessages, creationSessions, pipelineRuns, projects } = await import('../src/db/schema')
      const { and, eq } = await import('drizzle-orm')
      const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
      const { graduateCreation } = await import('../src/services/creation-chat/graduate')
      const { writeTextAsset } = await import('../src/services/storage')
      const engine = await import('../src/pipeline/engine')
      await initDb()

      const origFetch = globalThis.fetch
      const origStart = engine.engine.startRun.bind(engine.engine)
      let started = 0
      globalThis.fetch = stubFetch
      engine.engine.startRun = ((runId: number): 'started' => { started += 1; void runId; return 'started' }) as typeof engine.engine.startRun
      try {
        const t = Date.now()
        const [p] = await db.insert(projects).values({ name: '小镖客的最后一程', genre: 'drama_short', templateKey: 'mengbao-episode', status: 'active', brief: '萌宝镖客最后一次护送的连载短剧', tags: JSON.stringify(['轻松创作']), createdAt: t, updatedAt: t }).returning()
        const [er] = await db.insert(pipelineRuns).values({ projectId: p!.id, templateKey: 'easy-video', status: 'completed', input: '{}', templateSnapshot: '{}', createdAt: t, updatedAt: t } as never).returning()
        const plan = creationPlanSchema.parse(makePlan('dynamic'))
        const key = `m56ep${t}${Math.random().toString(36).slice(2, 6)}`
        await db.insert(creationSessions).values({ projectId: p!.id, requestKey: key, status: 'started', plan: JSON.stringify(plan), planRevision: 1, planHash: 'c'.repeat(64), preflight: '{}', runHistory: '[]', runId: er!.id, createdAt: t, updatedAt: t })
        const [s] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
        const script = await writeTextAsset(p!.id, { name: '已批准脚本.md', content: '# 剧本\n第一场 大漠孤城……', purpose: 'script', runId: er!.id })

        fetchCalls = 0
        const res = await graduateCreation(s!.id, { mode: 'episode', episodeNumber: 2 })
        check(res.reused === false && res.templateKey === 'mengbao-episode' && res.runId > 0, '单集升级：新建 mengbao-episode run 且标记非复用')
        const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, res.runId))
        check(!!run && run.status === 'queued', '毕业只建 queued run（不自动启动、不额外一步）')
        check(started === 0, 'engine.startRun 全程未被调用（毕业零执行零计费）')
        check(fetchCalls === 0, '毕业路径零网络（未触碰任何远端）')
        const input = JSON.parse(run!.input) as Record<string, unknown>
        const settingDocs = Array.isArray(input.setting_docs) ? input.setting_docs.map(Number) : []
        check(settingDocs.includes(script.id), '批准剧本经既有 setting_docs 作强锚定喂入专业链')
        check(typeof input.brief === 'string' && (input.brief as string).length > 0, 'brief 用项目真源非空')
        check(input.episode_number === 2, '集号按请求写入（episodeNumber=2）')
        check(input.motion === true, '方案为 dynamic → motion 透传为 true')
        check(input.prev_script === undefined, '绝不把本集剧本塞进 prev_script（避免被写成第 2 集承接）')
        const msgs = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, s!.id))
        check(msgs.some((m) => m.role === 'assistant' && (m.payload ?? '').includes('"kind":"graduate"')), '毕业留痕随会话消息落库（payload.kind=graduate）')

        // 幂等：同项目对同一批准剧本再次升级 → 复用未启动 run，不新建
        const res2 = await graduateCreation(s!.id, { mode: 'episode', episodeNumber: 2 })
        const sameTpl = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(and(eq(pipelineRuns.projectId, p!.id), eq(pipelineRuns.templateKey, 'mengbao-episode')))
        check(res2.reused === true && res2.runId === res.runId, '再次升级命中未启动专业 run → 幂等复用（不重复建）')
        check(sameTpl.length === 1, '同项目 mengbao-episode 专业 run 仅一条（幂等不留冗余）')
      } finally {
        globalThis.fetch = origFetch
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },

    // ================= series：连载立项（series-setup queued + plan_doc 锚定 + 幂等） =================
    series: async () => {
      const { db, initDb } = await import('../src/db')
      const { creationSessions, pipelineRuns, projects } = await import('../src/db/schema')
      const { and, eq } = await import('drizzle-orm')
      const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
      const { graduateCreation } = await import('../src/services/creation-chat/graduate')
      const { writeTextAsset } = await import('../src/services/storage')
      await initDb()

      const origFetch = globalThis.fetch
      globalThis.fetch = stubFetch
      try {
        const t = Date.now()
        const [p] = await db.insert(projects).values({ name: '萌宝镖客', genre: 'drama_short', templateKey: 'mengbao-episode', status: 'active', brief: '萌宝镖客连载短剧的整季立项', tags: JSON.stringify(['轻松创作']), createdAt: t, updatedAt: t }).returning()
        const [er] = await db.insert(pipelineRuns).values({ projectId: p!.id, templateKey: 'easy-dialogue', status: 'completed', input: '{}', templateSnapshot: '{}', createdAt: t, updatedAt: t } as never).returning()
        const plan = creationPlanSchema.parse(makePlan('slideshow'))
        const key = `m56se${t}${Math.random().toString(36).slice(2, 6)}`
        await db.insert(creationSessions).values({ projectId: p!.id, requestKey: key, status: 'started', plan: JSON.stringify(plan), planRevision: 1, planHash: 'd'.repeat(64), preflight: '{}', runHistory: '[]', runId: er!.id, createdAt: t, updatedAt: t })
        const [s] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
        const script = await writeTextAsset(p!.id, { name: '已批准脚本.md', content: '# 全季策划\n角色与分集地图……', purpose: 'script', runId: er!.id })

        fetchCalls = 0
        const res = await graduateCreation(s!.id, { mode: 'series' })
        check(res.reused === false && res.templateKey === 'series-setup' && res.runId > 0, '连载立项：新建 series-setup run 且标记非复用')
        const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, res.runId))
        check(!!run && run.status === 'queued', '连载立项只建 queued run（用户到工作台核对后自行启动）')
        check(fetchCalls === 0, '连载立项路径零网络')
        const input = JSON.parse(run!.input) as Record<string, unknown>
        const planDoc = Array.isArray(input.plan_doc) ? input.plan_doc.map(Number) : []
        check(planDoc.includes(script.id), '批准剧本经既有 plan_doc 喂入整剧立项')
        check(typeof input.genre === 'string' && (input.genre as string).length > 0, 'genre 用项目真源非空')
        check(input.setting_docs === undefined && input.episode_number === undefined, '连载立项不误带单集键（setting_docs/episode_number 不越界）')

        const res2 = await graduateCreation(s!.id, { mode: 'series' })
        const sameTpl = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(and(eq(pipelineRuns.projectId, p!.id), eq(pipelineRuns.templateKey, 'series-setup')))
        check(res2.reused === true && res2.runId === res.runId && sameTpl.length === 1, '连载立项幂等复用未启动 run（不重复建）')
      } finally {
        globalThis.fetch = origFetch
      }
    },

    // ================= guards：未确认拒绝 / 无剧本仍可建 / 会话不存在 =================
    guards: async () => {
      const { db, initDb } = await import('../src/db')
      const { creationSessions, pipelineRuns, projects } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { graduateCreation } = await import('../src/services/creation-chat/graduate')
      await initDb()

      // ① 未确认（会话无 runId）→ not_confirmed 409
      const t = Date.now()
      const [p1] = await db.insert(projects).values({ name: '聊了一半未开始', genre: 'drama_short', templateKey: 'easy-video', status: 'draft', brief: '尚未点开始制作', tags: JSON.stringify(['轻松创作']), createdAt: t, updatedAt: t }).returning()
      const key1 = `m56g1${t}${Math.random().toString(36).slice(2, 6)}`
      await db.insert(creationSessions).values({ projectId: p1!.id, requestKey: key1, status: 'ready', plan: null, planRevision: 0, runHistory: '[]', createdAt: t, updatedAt: t })
      const [s1] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key1))
      const e1 = await errOf(async () => graduateCreation(s1!.id, { mode: 'episode' }))
      check(fieldOf(e1, 'code') === 'not_confirmed' && fieldOf(e1, 'status') === 409, '未确认会话 → not_confirmed 409（先开始制作再升级）')

      // ② 已确认但无批准剧本资产 → 仍建 run，但 setting_docs 锚定缺席（不崩、不硬造）
      const [p2] = await db.insert(projects).values({ name: '已批准但无剧本资产', genre: 'drama_short', templateKey: 'mengbao-episode', status: 'active', brief: '有 run 但没落剧本资产', tags: JSON.stringify(['轻松创作']), createdAt: t, updatedAt: t }).returning()
      const [er2] = await db.insert(pipelineRuns).values({ projectId: p2!.id, templateKey: 'easy-video', status: 'completed', input: '{}', templateSnapshot: '{}', createdAt: t, updatedAt: t } as never).returning()
      const key2 = `m56g2${t}${Math.random().toString(36).slice(2, 6)}`
      await db.insert(creationSessions).values({ projectId: p2!.id, requestKey: key2, status: 'started', plan: null, planRevision: 1, planHash: 'e'.repeat(64), preflight: '{}', runHistory: '[]', runId: er2!.id, createdAt: t, updatedAt: t })
      const [s2] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key2))
      const res2 = await graduateCreation(s2!.id, { mode: 'episode' })
      const [run2] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, res2.runId))
      const in2 = JSON.parse(run2!.input) as Record<string, unknown>
      check(res2.runId > 0 && run2!.status === 'queued' && in2.setting_docs === undefined, '无批准剧本资产 → 照常建 queued 专业 run 但不硬造锚定输入（brief 仍真源）')

      // ③ 会话不存在 → not_found
      check((await errOf(async () => graduateCreation(9999999, { mode: 'episode' }))) !== null, '不存在的会话编号 → 拒绝（not_found）')
    },

    // ================= drift：毕业链结构不变（后续里程碑升版本也不得动毕业锚定面） =================
    drift: async () => {
      const { loadTemplate } = await import('../src/pipeline/loader')
      const ep = loadTemplate('mengbao-episode')
      check(ep.version === 15, 'mengbao-episode 当前 v15（M60 仅放宽 setting_docs 接受 json，毕业锚定面未动）')
      check(JSON.stringify(ep.steps).includes('write_script'), 'write_script 步骤仍在位（毕业不 skip 任何步、不删结构）')
      check(ep.inputs.some((i) => i.key === 'setting_docs' && i.kind === 'files'), 'setting_docs 仍为既有 files 输入（锚定依赖未新增列/键）')
      const se = loadTemplate('series-setup')
      check(se.version === 4 && se.inputs.some((i) => i.key === 'plan_doc'), 'series-setup 当前 v4（M60 增商业结构步）且 plan_doc 输入在位（连载锚定输入未动）')
    },
  }

  await runSections({ log, title: 'M56', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
