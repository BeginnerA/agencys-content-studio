/**
 * M40 探针（轻松创作「确认才立项 + 立项信息智能填写」）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m40.ts [--section=meta|contract|draft|plan|confirm|delete]
 *
 * 隔离策略：isolatedEnv('m40', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须在任何 src 动态 import 前调用。零网络、零付费模型调用：
 *   - meta/contract 节纯函数与 schema 直测（无 DB）；
 *   - draft 节直插 draft 项目 + 会话，走 app.request 内存 HTTP 核验「不进项目列表」；
 *   - plan 节 stub globalThis.fetch 回放 OpenAI 兼容响应，直测规划后的智能填写与回落可见性；
 *   - confirm 节直插离线 apiConfigs + 待确认会话（旁路 LLM），stub engine.startRun 阻断真实媒体执行；
 *   - delete 节走 app.request 内存 HTTP 删会话，核验「未立项连影子项目一并清除 / 已立项只删记录 / 在途拒绝」。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { existsSync } from 'node:fs'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m40', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M40_KEY = 'probe-offline-secret-key-40a1'

const SECTIONS = ['meta', 'contract', 'draft', 'plan', 'confirm', 'delete'] as const

/** 3 镜 × 10 秒 = 30 秒（与 m30 同构，最小合法方案） */
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
  const log = createLogger('probe-m40')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const errOf = async (fn: () => Promise<unknown>): Promise<Error | null> => {
    try { await fn(); return null } catch (err) { return err instanceof Error ? err : new Error(String(err)) }
  }
  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    const e = await errOf(fn)
    return e && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : e ? 'other' : 'none'
  }

  // ---- 立项建议（LLM 侧形状：与 plan 同级的 project 对象）----
  const suggestion = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: '咖啡冲煮风味指南', genre: 'talking_head', templateKey: 'mengbao-episode',
    tags: ['咖啡', '科普', '冲煮'], brief: '三段讲清咖啡风味来源的 30 秒短视频', ...over,
  })

  // ---- LLM 响应 stub（OpenAI 兼容）----
  interface StubCall { url: string; body: Record<string, unknown> }
  const stubCalls: StubCall[] = []
  let stubReply: (call: StubCall) => { status: number; body: unknown } = () => ({ status: 200, body: {} })
  const llmReply = (content: string): { status: number; body: unknown } => ({
    status: 200,
    body: { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
  })
  const stubFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) as Record<string, unknown> } catch { /* 非 JSON */ }
    }
    const call: StubCall = { url: typeof input === 'string' ? input : String(input), body }
    stubCalls.push(call)
    const r = stubReply(call)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const runners: Record<string, () => Promise<void>> = {
    // ================= meta：真源派生与逐项校验（纯函数，零 DB） =================
    meta: async () => {
      const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
      const { PROJECT_GENRES, deriveProjectMeta, projectGenreLabel, projectMetaPrompt, renderMetaNotes, sanitizeProjectMeta } = await import('../src/services/creation-chat/project-meta')
      const dynamic = creationPlanSchema.parse(makePlan('dynamic'))
      const slide = creationPlanSchema.parse(makePlan('slideshow'))
      const story = creationPlanSchema.parse({ ...makePlan('dynamic'), genre: 'story', title: '小镖客的最后一程' })

      const dScience = deriveProjectMeta(dynamic)
      check(dScience.genre === 'talking_head', '规则派生：科普 dynamic → 载体口播')
      check(deriveProjectMeta(story).genre === 'drama_short', '规则派生：故事 dynamic → 载体短剧')
      check(deriveProjectMeta(slide).genre === 'note', '规则派生：slideshow（静态多图配音）→ 载体图文')
      check(dScience.name === dynamic.title && dScience.brief === dynamic.summary, '规则派生：名称取方案标题、简介取方案摘要')
      check(dScience.tags[0] === '轻松创作' && new Set(dScience.tags).size === dScience.tags.length && dScience.tags.length <= 6, '规则派生：标签含来源标记且去重、不超 6 个')
      check(dScience.templateKey === 'easy-video', '规则派生：模板回落本次真实执行模板 easy-video')
      const longTitle = creationPlanSchema.parse({ ...makePlan('dynamic'), title: 'x'.repeat(100) })
      check(deriveProjectMeta(longTitle).name.length === 60, '规则派生：超长标题截断到 60 字')

      const passthrough = sanitizeProjectMeta(undefined, dynamic)
      check(passthrough.notes.length === 0 && JSON.stringify(passthrough.meta) === JSON.stringify(deriveProjectMeta(dynamic)), '无建议 → 全量规则派生且零噪音（notes 空）')
      const good = sanitizeProjectMeta(suggestion() as never, dynamic)
      check(good.notes.length === 0 && good.meta.name === '咖啡冲煮风味指南' && good.meta.templateKey === 'mengbao-episode' && good.meta.tags.join(',') === '咖啡,科普,冲煮', '合法建议：名称/载体/模板/标签逐项采纳，notes 空')
      const badGenre = sanitizeProjectMeta(suggestion({ genre: 'documentary' }) as never, dynamic)
      check(badGenre.meta.genre === 'talking_head' && badGenre.notes.some((n) => n.includes('不在平台字典')), '载体不在字典 → 回落规则派生值并产出可见调整说明')
      const badTpl = sanitizeProjectMeta(suggestion({ templateKey: 'no-such-template' }) as never, dynamic)
      check(badTpl.meta.templateKey === 'easy-video' && badTpl.notes.some((n) => n.includes('在平台不存在')), '模板 key 不存在 → 回落 easy-video 并明告（不静默降级）')
      const longName = sanitizeProjectMeta(suggestion({ name: 'y'.repeat(90) }) as never, dynamic)
      check(longName.meta.name.length === 60 && longName.notes.some((n) => n.includes('超过 60 字')), '名称超上限 → 截断并明告')
      const manyTags = sanitizeProjectMeta(suggestion({ tags: Array.from({ length: 9 }, (_, i) => `标签${i}`) }) as never, dynamic)
      check(manyTags.meta.tags.length === 6 && manyTags.notes.some((n) => n.includes('保留前 6 个')), '标签超过 6 个 → 保留前 6 并明告')
      check(sanitizeProjectMeta(suggestion({ tags: '咖啡' }) as never, dynamic).notes.some((n) => n.includes('标签')), '标签格式错误 → 回落自动生成并明告')
      check(sanitizeProjectMeta(suggestion({ name: '   ' }) as never, dynamic).notes.some((n) => n.includes('为空')), '名称为空串 → 回落并明告（不当作有效值入库）')
      const base = deriveProjectMeta(story)
      const partial = sanitizeProjectMeta({ genre: 'note' } as never, story, base)
      check(partial.meta.name === base.name && partial.meta.genre === 'note' && partial.notes.length === 0, '已有基准值（草稿行现值）优先规则派生，且缺项静默不产噪音')
      const prompt = projectMetaPrompt()
      check(prompt.includes('与 plan 同级') && PROJECT_GENRES.every((g) => prompt.includes(g.value)) && prompt.includes('easy-video（轻松创作') && prompt.includes('mengbao-episode'), '立项注入消息：含同级位置说明 + 载体字典 + 真实模板候选')
      check(renderMetaNotes([]) === '' && renderMetaNotes(['a']).includes('立项信息已按平台真源调整'), 'notes 渲染：空则不打扰、非空则统一前缀')
      check(projectGenreLabel('note') === '图文' && projectGenreLabel('unknown_x') === 'unknown_x', '载体标签：字典内中文、字典外原样回落')
    },

    // ================= contract：回复/确认契约向后兼容 + 立项不入哈希 =================
    contract: async () => {
      const { confirmationSchema, creationPlanSchema, hashJson, parsePlanningReply, projectMetaSchema } = await import('../src/services/creation-chat/contract')
      const plan = makePlan('dynamic')
      const withMeta = parsePlanningReply(JSON.stringify({ kind: 'plan', message: '方案来了', project: suggestion(), plan }))
      check(withMeta.kind === 'plan' && (withMeta as { project?: { name?: string } }).project?.name === '咖啡冲煮风味指南', '回复带 project → 解析成功并透出建议值')
      const noMeta = parsePlanningReply(JSON.stringify({ kind: 'plan', message: '方案来了', plan }))
      check(noMeta.kind === 'plan' && (noMeta as { project?: unknown }).project === undefined, '回复不含 project → 旧契约向后兼容')
      const sloppy = parsePlanningReply(JSON.stringify({ kind: 'plan', message: '方案来了', project: { name: 'z'.repeat(300), genre: 'story_time', extraKey: 1, tags: 'x' }, plan }))
      check(sloppy.kind === 'plan', 'project 建议越界/含未知键 → 整份方案不致命（避免把已花钱的规划判为 invalid_plan）')
      const nested = await codeOf(async () => parsePlanningReply(JSON.stringify({ kind: 'plan', message: 'm', plan: { ...plan, project: suggestion() } })))
      check(nested === 'invalid_plan', 'project 误写进 plan 内部 → 仍按方案结构契约拒绝（不静默接受错位）')
      const okMeta = projectMetaSchema.parse(suggestion())
      check(okMeta.tags.length === 3 && typeof okMeta.brief === 'string', '严格形 schema 接纳规范建议')
      const strictReject = await codeOf(async () => projectMetaSchema.parse({ ...suggestion(), cover: 1 }))
      check(strictReject !== 'none', '严格形 schema 拒绝未知字段（入库前必须过此关）')
      const p = creationPlanSchema.parse(plan)
      const confirm = confirmationSchema.parse({ planRevision: 1, planHash: 'a'.repeat(64), idempotencyKey: 'm40confirmkey1', acceptUnpriced: false, project: { name: '手改名' } })
      check(confirm.project?.name === '手改名', '确认请求可携带立项覆盖值')
      check(hashJson({ plan: p, execution: null }) === hashJson({ plan: creationPlanSchema.parse(plan), execution: null }), 'planHash 只由方案与执行决定（改立项信息不作废确认）')
      check((await errOf(async () => confirmationSchema.parse({ planRevision: 1, planHash: 'a'.repeat(64), idempotencyKey: 'm40confirmkey2', acceptUnpriced: false, bogus: 1 }))) !== null, '确认请求未知字段仍被拒（契约不外扩）')
    },

    // ================= draft：未立项项目不进项目列表（HTTP 面） =================
    draft: async () => {
      const { db, initDb } = await import('../src/db')
      const { creationSessions, projects } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { creationDetail } = await import('../src/services/creation-chat/store')
      await initDb()
      const t = Date.now()
      const [draft] = await db.insert(projects).values({ name: '做一条咖啡科普', genre: 'other', templateKey: 'easy-video', status: 'draft', brief: '做一条 30 秒的咖啡科普', tags: JSON.stringify(['轻松创作']), createdAt: t, updatedAt: t }).returning()
      const [kept] = await db.insert(projects).values({ name: '既有正式项目', genre: 'drama_short', templateKey: 'mengbao-episode', status: 'active', tags: '[]', createdAt: t, updatedAt: t }).returning()
      const key = `m40draft${t}`
      await db.insert(creationSessions).values({ projectId: draft!.id, requestKey: key, status: 'ready', plan: JSON.stringify(makePlan('dynamic')), planRevision: 1, planHash: 'b'.repeat(64), preflight: '{}', runHistory: '[]', createdAt: t, updatedAt: t })
      const [session] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))

      const listRes = await app.request('/api/v1/projects')
      const listBody = (await listRes.json()) as { items: Array<{ id: number }> }
      check(listRes.status === 200 && !listBody.items.some((x) => x.id === draft!.id) && listBody.items.some((x) => x.id === kept!.id), 'GET /projects：draft 不出列表、active 正常在列')
      const draftQ = (await (await app.request('/api/v1/projects?status=draft')).json()) as { items: Array<{ id: number }> }
      check(!draftQ.items.some((x) => x.id === draft!.id), '?status=draft 也不暴露影子草稿（只开放 active|archived）')
      const archivedQ = (await (await app.request('/api/v1/projects?status=archived')).json()) as { items: Array<{ id: number }> }
      check(!archivedQ.items.some((x) => x.id === draft!.id), '已归档列表同样不含草稿（不会换个 Tab 冒出来）')
      const detailRes = await app.request(`/api/v1/projects/${draft!.id}`)
      check(detailRes.status === 200, '直连项目详情仍可访问（草稿只是不进列表，不是权限隐藏）')
      const view = await creationDetail(session!.id)
      check(view.session.project?.isDraft === true && view.session.project?.id === draft!.id, '会话详情透出立项预览：isDraft=true + 当前 5 项值')
      check(Array.isArray(view.session.project?.tags) && view.session.project?.tags[0] === '轻松创作', '预览标签为数组（前端可直接编辑）')
      await db.delete(projects).where(eq(projects.id, kept!.id))
    },

    // ================= plan：规划后智能填写（stub LLM，零网络） =================
    plan: async () => {
      const { db, initDb } = await import('../src/db')
      const { apiConfigs, creationMessages, creationSessions, projects } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { sendCreationMessage } = await import('../src/services/creation-chat/planning')
      const { creationDetail } = await import('../src/services/creation-chat/store')
      await initDb()
      const origFetch = globalThis.fetch
      globalThis.fetch = stubFetch
      const mkDraftSession = async (status: 'draft' | 'active', name: string): Promise<{ projectId: number; sessionId: number }> => {
        const t = Date.now()
        const [p] = await db.insert(projects).values({ name, genre: 'other', templateKey: 'easy-video', status, brief: name, tags: JSON.stringify(['轻松创作']), createdAt: t, updatedAt: t }).returning()
        const key = `m40plan${t}${Math.random().toString(36).slice(2, 6)}`
        await db.insert(creationSessions).values({ projectId: p!.id, requestKey: key, status: 'draft', planRevision: 0, runHistory: '[]', createdAt: t, updatedAt: t })
        const [s] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
        return { projectId: p!.id, sessionId: s!.id }
      }
      const seedEndpoints = async (): Promise<void> => {
        for (const st of ['llm', 'audio', 'image', 'video']) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, st))
        const t = Date.now()
        const insert = (v: Record<string, unknown>): Promise<unknown> => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M40_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: v.pricing ?? '{}', isActive: 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
        await insert({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
        await insert({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', extra: { voice: 'probe-voice' }, pricing: '{"char":0.1}' })
        await insert({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: '{"image":0.1}' })
        await insert({ name: 'video', providerKey: 'siliconflow_video', serviceType: 'video', model: 'Wan2.2-I2V-A14B', extra: { creationCapabilities: { model: 'Wan2.2-I2V-A14B', verified: true, modes: ['i2v', 't2v'], durations: [10], aspectRatios: ['9:16', '16:9', '1:1'], resolution: '720p' } }, pricing: '{"second":0.1}' })
      }
      try {
        await seedEndpoints()
        stubReply = () => llmReply(JSON.stringify({ kind: 'plan', message: '方案已生成，确认后开始制作', project: suggestion(), plan: makePlan('dynamic') }))
        const first = await mkDraftSession('draft', '做一条 30 秒的咖啡科普短视频')
        const detail = await sendCreationMessage(first.sessionId, { content: '做一条 30 秒的咖啡科普短视频，轻松一点。', requestKey: `m40msg1${Date.now()}` })
        const [p1] = await db.select().from(projects).where(eq(projects.id, first.projectId))
        check(detail.session.status === 'ready', 'stub 规划走通 → 会话进入 ready')
        check(p1!.name === '咖啡冲煮风味指南' && p1!.genre === 'talking_head' && p1!.templateKey === 'mengbao-episode', '规划即智能填写：名称/载体/模板取建议值')
        check(JSON.parse(p1!.tags).join(',') === '咖啡,科普,冲煮' && (p1!.brief ?? '').includes('30 秒短视频'), '规划即智能填写：标签与简介落库（用户不必再改一遍）')
        check(p1!.status === 'draft', '规划完成仍是 draft —— 未点开始制作就不立项')
        check(detail.session.project?.isDraft === true && detail.session.project?.name === '咖啡冲煮风味指南', '详情预览回读同一份立项值')
        const listed = (await (await app.request('/api/v1/projects')).json()) as { items: Array<{ id: number }> }
        check(!listed.items.some((x) => x.id === first.projectId), '该阶段项目列表依然查不到（轻松创作列表外零噪音）')
        const msgs1 = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, first.sessionId))
        check(msgs1.some((m) => m.role === 'assistant' && !m.content.includes('真源调整')), '建议值全部合法 → 回复不追加调整说明（无调整不打扰）')
        const [s1] = await db.select().from(creationSessions).where(eq(creationSessions.id, first.sessionId))
        const hashWithMeta = s1!.planHash

        // 第二版：建议含非法模板 + 非法载体 → 回落可见
        stubReply = () => llmReply(JSON.stringify({ kind: 'plan', message: '已按你的补充更新方案', project: suggestion({ templateKey: 'no-such-template', genre: 'documentary', name: '咖啡冲煮进阶' }), plan: makePlan('dynamic') }))
        const detail2 = await sendCreationMessage(first.sessionId, { content: '再加一句研磨建议。', requestKey: `m40msg2${Date.now()}` })
        const [p2] = await db.select().from(projects).where(eq(projects.id, first.projectId))
        const msgs2 = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, first.sessionId))
        const assistant2 = msgs2.filter((m) => m.role === 'assistant').map((m) => m.content).find((c) => c.includes('立项信息已按平台真源调整'))
        check(detail2.session.status === 'ready' && p2!.templateKey === 'easy-video' && p2!.genre === 'talking_head', '越界建议 → 逐项回落真源值')
        check(!!assistant2 && assistant2.includes('在平台不存在') && assistant2.includes('不在平台字典'), '回落过程随回复可见（不静默降级）')
        check(p2!.name === '咖啡冲煮进阶', '同批次内合法字段照常采纳（只回退出问题的那一项）')
        const [s2] = await db.select().from(creationSessions).where(eq(creationSessions.id, first.sessionId))
        check(s2!.planHash === hashWithMeta, '立项建议变化不改 planHash（同一方案不会因元信息重算而作废）')

        // 无建议（旧模型/省略 project）→ 规则派生兜底
        stubReply = () => llmReply(JSON.stringify({ kind: 'plan', message: '方案已生成', plan: makePlan('slideshow') }))
        const second = await mkDraftSession('draft', '把长文做成图文配音视频')
        await sendCreationMessage(second.sessionId, { content: '把长文做成图文配音视频。', requestKey: `m40msg3${Date.now()}` })
        const [p3] = await db.select().from(projects).where(eq(projects.id, second.projectId))
        check(p3!.genre === 'note' && p3!.templateKey === 'easy-video' && JSON.parse(p3!.tags).includes('轻松创作'), 'LLM 未给 project → 规则派生兜底填写（不留脏值）')

        // 已立项项目不被后续规划覆写
        stubReply = () => llmReply(JSON.stringify({ kind: 'plan', message: '方案已生成', project: suggestion({ name: '不该覆盖' }), plan: makePlan('dynamic') }))
        const third = await mkDraftSession('active', '用户已改名的好项目')
        await sendCreationMessage(third.sessionId, { content: '再出一条续集方案。', requestKey: `m40msg4${Date.now()}` })
        const [p4] = await db.select().from(projects).where(eq(projects.id, third.projectId))
        check(p4!.name === '用户已改名的好项目' && p4!.status === 'active', '已立项（active）项目的名称不被规划覆写（项目归用户所有）')

        // 澄清回复不动立项值
        stubReply = () => llmReply(JSON.stringify({ kind: 'clarify', message: '先确认一下时长', questions: ['要 30 秒还是 45 秒？'] }))
        const fourth = await mkDraftSession('draft', '只会被追问的会话')
        await sendCreationMessage(fourth.sessionId, { content: '帮我做条视频。', requestKey: `m40msg5${Date.now()}` })
        const [p5] = await db.select().from(projects).where(eq(projects.id, fourth.projectId))
        check(p5!.name === '只会被追问的会话' && p5!.status === 'draft', 'clarify 回复不改写立项值（追问阶段仍保持占位）')
      } finally {
        globalThis.fetch = origFetch
      }
    },

    // ================= confirm：点「开始制作」才立项（含覆盖与幂等） =================
    confirm: async () => {
      const { db, initDb } = await import('../src/db')
      const { apiConfigs, creationMessages, creationSessions, projects } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
      const { preflightPlan } = await import('../src/services/creation-chat/preflight')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')
      const { sanitizeProjectMeta } = await import('../src/services/creation-chat/project-meta')
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      let started = 0
      engine.engine.startRun = ((runId: number): 'started' => { started += 1; void runId; return 'started' }) as typeof engine.engine.startRun
      try {
        await initDb()
        for (const st of ['llm', 'audio', 'image', 'video']) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, st))
        const t0 = Date.now()
        const insertCfg = (v: Record<string, unknown>): Promise<unknown> => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M40_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: v.pricing ?? '{}', isActive: 1, isDefault: 1, priority: 0, createdAt: t0, updatedAt: t0 } as never)
        await insertCfg({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
        await insertCfg({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', extra: { voice: 'probe-voice' }, pricing: '{"char":0.1}' })
        await insertCfg({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: '{"image":0.1}' })
        await insertCfg({ name: 'video', providerKey: 'siliconflow_video', serviceType: 'video', model: 'Wan2.2-I2V-A14B', extra: { creationCapabilities: { model: 'Wan2.2-I2V-A14B', verified: true, modes: ['i2v', 't2v'], durations: [10], aspectRatios: ['9:16', '16:9', '1:1'], resolution: '720p' } }, pricing: '{"second":0.1}' })

        // 直建「待确认」会话（项目为 draft 影子态，旁路 LLM）
        const makeReadyDraftSession = async (meta: { name: string; genre: string; tags: string[] }): Promise<{ projectId: number; sessionId: number; planRevision: number; planHash: string }> => {
          const t = Date.now()
          const [p] = await db.insert(projects).values({ name: meta.name, genre: meta.genre, templateKey: 'easy-video', status: 'draft', brief: '规划阶段写入的简介', tags: JSON.stringify(meta.tags), createdAt: t, updatedAt: t }).returning()
          const plan = creationPlanSchema.parse(makePlan('slideshow'))
          const pf = await preflightPlan(p!.id, plan)
          const key = `m40cfm${t}${Math.random().toString(36).slice(2, 6)}`
          await db.insert(creationSessions).values({ projectId: p!.id, requestKey: key, status: pf.ready ? 'ready' : 'draft', plan: JSON.stringify(plan), planRevision: 1, planHash: pf.execution ? hashJson({ plan, execution: pf.execution }) : null, preflight: JSON.stringify(pf), runHistory: '[]', createdAt: t, updatedAt: t })
          const [s] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
          return { projectId: p!.id, sessionId: s!.id, planRevision: s!.planRevision, planHash: s!.planHash! }
        }

        check(true, 'confirm 节离线端点与待确认草稿会话就绪')
        const a = await makeReadyDraftSession({ name: '咖啡冲煮三分钟', genre: 'talking_head', tags: ['轻松创作', '口播'] })
        const resA = await confirmCreation(a.sessionId, { planRevision: a.planRevision, planHash: a.planHash, idempotencyKey: 'm40confirmA1', acceptUnpriced: false, project: { name: '我的咖啡课', genre: 'note', tags: ['咖啡', '教学'], templateKey: 'mengbao-episode', brief: '用户手改简介' } })
        const [pa] = await db.select().from(projects).where(eq(projects.id, a.projectId))
        check(pa!.status === 'active', '点开始制作（确认）→ 项目才转正为 active')
        check(pa!.name === '我的咖啡课' && pa!.genre === 'note' && pa!.templateKey === 'mengbao-episode' && JSON.parse(pa!.tags).join(',') === '咖啡,教学' && pa!.brief === '用户手改简介', '确认携带的覆盖值逐项入库')
        check(resA.runId > 0 && started === 1, '立项与启动同一次确认完成（不额外多一步操作）')
        const listed = (await (await app.request('/api/v1/projects')).json()) as { items: Array<{ id: number; name: string }> }
        check(listed.items.some((x) => x.id === a.projectId && x.name === '我的咖啡课'), '转正后项目出现在项目列表（名称已是智能/手改结果）')
        const msgsA = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, a.sessionId))
        const projMsg = msgsA.map((m) => m.content).find((c) => c.includes('已创建项目'))
        check(!!projMsg && !projMsg.includes('真源调整'), '立项消息在位且无调整噪音（覆盖值全部合法）')

        const b = await makeReadyDraftSession({ name: '咖啡冲煮三分钟', genre: 'talking_head', tags: ['轻松创作'] })
        await confirmCreation(b.sessionId, { planRevision: b.planRevision, planHash: b.planHash, idempotencyKey: 'm40confirmB1', acceptUnpriced: false })
        const [pb] = await db.select().from(projects).where(eq(projects.id, b.projectId))
        check(pb!.status === 'active' && pb!.name === '咖啡冲煮三分钟' && pb!.genre === 'talking_head', '不带覆盖值 → 沿用规划时智能填写的草稿行值转正')

        const c = await makeReadyDraftSession({ name: '咖啡冲煮三分钟', genre: 'talking_head', tags: ['轻松创作'] })
        const resC = await confirmCreation(c.sessionId, { planRevision: c.planRevision, planHash: c.planHash, idempotencyKey: 'm40confirmC1', acceptUnpriced: false, project: { templateKey: 'ghost-template', genre: 'meme' } })
        const [pc] = await db.select().from(projects).where(eq(projects.id, c.projectId))
        const msgsC = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, c.sessionId))
        check(resC.runId > 0 && pc!.templateKey === 'easy-video' && pc!.genre === 'talking_head', '非法覆盖 → 真源回落且照常启动（不因元信息 nit 打断制作）')
        check(msgsC.some((m) => m.content.includes('立项信息已按平台真源调整')), '非法覆盖的调整说明落进对话流（可见）')

        const d = await makeReadyDraftSession({ name: '咖啡冲煮三分钟', genre: 'talking_head', tags: ['轻松创作'] })
        const reqD = { planRevision: d.planRevision, planHash: d.planHash, idempotencyKey: 'm40confirmD1', acceptUnpriced: false, project: { name: '重复提交测试' } }
        const [da, dbr] = await Promise.all([confirmCreation(d.sessionId, reqD), confirmCreation(d.sessionId, reqD)])
        check(da.runId === dbr.runId && started === 4, '并发/重发确认 → 同一 run，立项只发生一次')
        const [pd] = await db.select().from(projects).where(eq(projects.id, d.projectId))
        const msgsD = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, d.sessionId))
        check(pd!.status === 'active' && msgsD.filter((m) => m.content.includes('已创建项目')).length === 1, '幂等重发不重复写立项、不重复插立项消息')

        const plan = creationPlanSchema.parse(makePlan('slideshow'))
        const s1 = sanitizeProjectMeta(suggestion({ name: 'X' }), plan)
        const s2 = sanitizeProjectMeta(suggestion({ name: 'Y' }), plan)
        check(s1.meta.tags.length === 3 && s2.meta.name === 'Y' && s1.notes.length === 0 && s2.notes.length === 0, 'sanitize 幂等：同输入同输出（确认路径纯函数无副作用）')
      } finally {
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },

    // ================= delete：删会话（未立项连影子项目一并清除 / 已立项只删记录 / 在途拒绝） =================
    delete: async () => {
      const { db, initDb } = await import('../src/db')
      const { assets, creationMessages, creationSessions, pipelineRuns, projects } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { ensureProjectDirs, projectAbsDir, writeTextAsset } = await import('../src/services/storage')
      const { listCreationSessions } = await import('../src/services/creation-chat/store')
      const t = Date.now()
      const one = async <T,>(rows: Promise<T[]>): Promise<T | undefined> => (await rows)[0]
      const mkProj = async (status: 'draft' | 'active', name: string): Promise<number> => {
        const at = Date.now()
        const [p] = await db.insert(projects).values({ name, genre: 'other', templateKey: 'easy-video', status, brief: name, tags: JSON.stringify(['轻松创作']), createdAt: at, updatedAt: at }).returning()
        return p!.id
      }
      const mkSession = async (projectId: number, over: Record<string, unknown>): Promise<number> => {
        const at = Date.now()
        const key = `m40del${at}${Math.random().toString(36).slice(2, 8)}`
        await db.insert(creationSessions).values({ projectId, requestKey: key, status: 'draft', runHistory: '[]', createdAt: at, updatedAt: at, ...over })
        const [s] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
        return s!.id
      }
      const mkRun = async (projectId: number, status: string): Promise<number> => {
        const at = Date.now()
        const [r] = await db.insert(pipelineRuns).values({ projectId, templateKey: 'easy-video', status, input: '{}', templateSnapshot: '{}', createdAt: at, updatedAt: at } as never).returning()
        return r!.id
      }
      const del = async (sessionId: number): Promise<{ status: number; body: Record<string, unknown> }> => {
        const res = await app.request(`/api/v1/creation-sessions/${sessionId}`, { method: 'DELETE' })
        return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
      }
      await initDb()

      // ① 未立项：会话 + 参考素材 + 影子项目一并清除（含磁盘目录）
      const p1 = await mkProj('draft', '聊了一半放弃的创作')
      const s1 = await mkSession(p1, { status: 'draft' })
      await db.insert(creationMessages).values([
        { sessionId: s1, role: 'user', content: '帮我做条视频', payload: null, createdAt: t },
        { sessionId: s1, role: 'assistant', content: '先确认一下时长', payload: null, createdAt: t },
      ])
      await writeTextAsset(p1, { name: '参考图.png', content: 'probe', purpose: 'reference' })
      ensureProjectDirs(p1)
      check(!!await one(db.select({ id: assets.id }).from(assets).where(eq(assets.projectId, p1))), 'delete 节备好了影子项目的参考素材行')
      const r1 = await del(s1)
      check(r1.status === 200 && r1.body.mode === 'draft_purged', '未立项会话删除 → 200 且 mode=draft_purged（连带回收影子项目）')
      check(!await one(db.select({ id: projects.id }).from(projects).where(eq(projects.id, p1))), '影子项目行已物理清除（库里不再积不可见行）')
      check(!await one(db.select({ id: creationSessions.id }).from(creationSessions).where(eq(creationSessions.id, s1))), '会话行已删除')
      check((await db.select({ id: creationMessages.id }).from(creationMessages).where(eq(creationMessages.sessionId, s1))).length === 0, '会话消息一并级联删除')
      check((await db.select({ id: assets.id }).from(assets).where(eq(assets.projectId, p1))).length === 0, '影子项目的参考素材记录一并清除')
      check(!existsSync(projectAbsDir(p1)), '影子项目磁盘目录已回收')
      check(!(await listCreationSessions()).some((x) => x.id === s1), '删除后会话从轻松创作列表消失')

      // ② 已立项（项目 active + run 已完成）：只删会话记录，项目与产物保留
      const p2 = await mkProj('active', '用户已立项的作品')
      const s2 = await mkSession(p2, { status: 'started', runId: await mkRun(p2, 'completed') })
      await db.insert(creationMessages).values({ sessionId: s2, role: 'user', content: '已完成制作的会话', payload: null, createdAt: t })
      const r2 = await del(s2)
      check(r2.status === 200 && r2.body.mode === 'session_only', '已立项会话删除 → 200 且 mode=session_only（不越权删项目）')
      const kept = await one(db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projects).where(eq(projects.id, p2)))
      check(!!kept && kept.name === '用户已立项的作品' && kept.status === 'active', '已立项项目与其名称原样保留（用户资产不被会话删除波及）')
      check(!!await one(db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, p2))), '立项后的 run 与产物记录保留')
      check(typeof r2.body.reason === 'string' && (r2.body.reason as string).includes('项目页'), '保留项目的原因随响应明告（不静默）')
      check(!!await one(db.select({ id: creationMessages.id }).from(creationMessages).where(eq(creationMessages.sessionId, s2))) === false, '已立项路径仅删本会话消息，不牵连其他')

      // ③ 在途保护：planning / run 运行中 → 拒绝删除
      const p3 = await mkProj('draft', '正在规划的会话')
      const s3 = await mkSession(p3, { status: 'planning' })
      const r3 = await del(s3)
      check(r3.status === 409 && (r3.body.error as Record<string, unknown>)?.code === 'session_busy', '规划中会话拒绝删除（session_busy），不打断在途规划')
      const p4 = await mkProj('active', '正在制作的会话')
      const s4 = await mkSession(p4, { status: 'started', runId: await mkRun(p4, 'running') })
      const r4 = await del(s4)
      check(r4.status === 409 && (r4.body.error as Record<string, unknown>)?.code === 'run_active', 'run 仍在跑时拒绝删除（先取消再删）')
      check(!!await one(db.select({ id: creationSessions.id }).from(creationSessions).where(eq(creationSessions.id, s4))), '被拒的删除不留副作用（会话行仍在）')

      // ④ 防御分支：draft 影子上竟挂着 run → 不冒险删项目
      const p5 = await mkProj('draft', '异常：草稿项目已有 run')
      await mkRun(p5, 'completed')
      const s5 = await mkSession(p5, { status: 'ready' })
      const r5 = await del(s5)
      check(r5.status === 200 && r5.body.mode === 'session_only' && !await one(db.select({ id: creationSessions.id }).from(creationSessions).where(eq(creationSessions.id, s5))), '异常 draft+run 组合 → 降级为只删会话（项目保守保留）')
      check(!!await one(db.select({ id: projects.id }).from(projects).where(eq(projects.id, p5))), '降级路径下项目行仍在（宁可少删）')

      // ⑤ 不存在 / 非法 id
      const r6 = await del(9999999)
      check(r6.status === 404 && (r6.body.error as Record<string, unknown>)?.code === 'not_found', '删不存在的会话 → 404 not_found')
      const bad = await app.request('/api/v1/creation-sessions/abc', { method: 'DELETE' })
      check(bad.status === 400, '非法会话编号 → 400 bad_id')
    },
  }

  await runSections({ log, title: 'M40', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
