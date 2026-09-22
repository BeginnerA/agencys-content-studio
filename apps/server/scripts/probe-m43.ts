/**
 * M43 探针（轻松创作第三批：画质选择 / 逐镜参考绑定 / 跨轮参考合并）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m43.ts [--section=quality|binding|carry]
 *
 * 隔离策略：isolatedEnv('m43') 一次性临时目录（独立 studio.db + workspace），必须在任何 src import 前调用。
 * 模板目录只读拷贝进隔离区（preflight 的 templateHash 需要 easy-video 模板），prompts 走 junction 桥接。
 * 零网络、零付费：fetch 全阻断，只放行 seedEndpoints 的假 LLM 端点（/chat/completions）；
 * 媒体调用计数断言 =0（画质选择与绑定都不得起任何生成）。engine.startRun 全程 stub。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, REPO_ROOT, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup, tmp } = isolatedEnv('m43', { bridge: ['prompts'] })
cpSync(join(REPO_ROOT, 'workspace', 'templates'), join(tmp, 'workspace', 'templates'), { recursive: true })
process.env.PROBE_M43_KEY = 'probe-offline-secret-key-43c7'

const SECTIONS = ['quality', 'binding', 'carry'] as const

/** 3 镜 × 10 秒 = 30 秒（与 M30/M42 同夹具，最小化漂移） */
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
/** siliconflow 无自动背书：显式 creationCapabilities（单档 720p），测「声明即固定档」 */
const SILICON = {
  providerKey: 'siliconflow_video', model: 'Wan2.2-I2V-A14B',
  extra: { creationCapabilities: { model: 'Wan2.2-I2V-A14B', verified: true, modes: ['i2v', 't2v'], durations: [10], aspectRatios: ['9:16', '16:9', '1:1'], resolution: '720p' } },
}

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m43')
  const checker: Checker = makeChecker(log)
  const check = checker.check
  const originalFetch = globalThis.fetch

  let llmCalls = 0
  let mediaCalls = 0
  let llmReply = '{}'
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('http://localhost:0/offline')) { mediaCalls += 1; throw new Error('探针禁止外部网络') }
    if (!url.includes('/chat/completions')) { mediaCalls += 1; throw new Error('M43 写路径不得直接调媒体生成') }
    llmCalls += 1
    void init
    return Response.json({ choices: [{ message: { content: llmReply }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } })
  }
  // engine.startRun 全程 stub：confirm 只落 run 行不真执行管线（M43 断言零引擎语义改动；文件头承诺）
  const { engine } = await import('../src/pipeline/engine')
  engine.startRun = ((runId: number) => { void runId; return 'started' }) as typeof engine.startRun
  const errOf = async (fn: () => Promise<unknown>): Promise<Error | null> => {
    try { await fn(); return null } catch (err) { return err instanceof Error ? err : new Error(String(err)) }
  }
  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    const e = await errOf(fn)
    return e && typeof (e as { code?: unknown }).code === 'string' ? (e as unknown as { code: string }).code : e ? 'other' : 'none'
  }

  const mkProject = async (name: string): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    return (await db.insert(projects).values({ name, genre: 'talking_head', templateKey: 'easy-video', status: 'draft', settings: '{}', tags: '[]', createdAt: t, updatedAt: t }).returning())[0]!.id
  }

  type VideoSeed = { providerKey: string; model: string; extra?: Record<string, unknown> }
  const seedEndpoints = async (video: VideoSeed = ALIYUN): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    await initDb()
    const { apiConfigs } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    for (const kind of ['llm', 'audio', 'image', 'video'] as const) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, kind))
    const t = Date.now()
    const insert = (v: Record<string, unknown>): Promise<unknown> => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M43_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: String(v.pricing ?? '{}'), isActive: 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
    await insert({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
    await insert({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', extra: { voice: 'alloy' }, pricing: '{"char":0.1}' })
    await insert({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: '{"image":0.1}' })
    await insert({ name: 'video', serviceType: 'video', pricing: '{"second":0.1}', ...video })
  }

  /** 旁路 LLM 直建「待确认」会话（与 M42 同口径） */
  const makeReadySession = async (mode: 'dynamic' | 'slideshow') => {
    const { db } = await import('../src/db')
    const { creationSessions } = await import('../src/db/schema')
    const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
    const { preflightPlan } = await import('../src/services/creation-chat/preflight')
    const projectId = await mkProject(`probe-m43-${mode}-${Date.now()}`)
    const plan = creationPlanSchema.parse(makePlan(mode))
    const pf = await preflightPlan(projectId, plan)
    const t = Date.now()
    const [s] = await db.insert(creationSessions).values({
      projectId, requestKey: `m43ready${mode}${t}`, status: pf.ready ? 'ready' : 'draft', plan: JSON.stringify(plan),
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
  /** 独立 png 内容 → 独立 sha256（importFiles 按哈希去重，探针要的是彼此不同的资产） */
  const pngData = (n: number): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n & 0xff, (n * 7) & 0xff, (n * 13) & 0xff, n & 0xff])
  /** creationDetail.session.plan 的服务端类型被 parseJson fallback 收窄，探针按方案视图重声明 */
  type RefView = { assetId: number; role: string; shotId?: string }
  const refsOf = (d: { session: { plan: unknown } }): RefView[] => (d.session.plan as { refs?: RefView[] } | null)?.refs ?? []

  const runners: Record<string, () => Promise<void>> = {
    // ============ quality：档位投影 / 确认覆写 / 越界拒绝 / 哈希闸优先 ============
    quality: async () => {
      const { db } = await import('../src/db')
      const { pipelineRuns } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')
      const { recipeOf } = await import('../src/services/creation-chat/recipe')
      await seedEndpoints(ALIYUN)
      const dyn = await makeReadySession('dynamic')
      check(!!dyn.pf.ready && dyn.pf.resolutionOptions?.choices.join(',') === '480p,720p,1080p' && dyn.pf.resolutionOptions?.default === '720p', '真源表自动背书 → 全档透出且 default=归一后的实际下发值')
      const slide = await makeReadySession('slideshow')
      check(slide.pf.resolutionOptions === null, 'slideshow 无视频步 → 无画质候选（不虚构档位）')

      // —— 不传 resolution：行为与 M42 逐字一致（默认档 + 哈希/版本不动）——
      const before = await sessRow(dyn.sessionId)
      const r0 = await confirmCreation(dyn.sessionId, { planRevision: before.planRevision, planHash: before.planHash, idempotencyKey: 'm43q-def001', acceptUnpriced: false })
      const run0 = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, r0.runId)))[0]!
      check(recipeOf(run0)!.resolution === '720p', '不选档 → 沿用模型默认档下发（旧会话零回归）')

      // —— 选 1080p：覆写进 recipe 且不作废方案 ——
      const d2 = await makeReadySession('dynamic')
      const s2 = await sessRow(d2.sessionId)
      const r2 = await confirmCreation(d2.sessionId, { planRevision: s2.planRevision, planHash: s2.planHash, idempotencyKey: 'm43q-1080-1', acceptUnpriced: false, resolution: '1080p' })
      const run2 = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, r2.runId)))[0]!
      const s2After = await sessRow(d2.sessionId)
      check(recipeOf(run2)!.resolution === '1080p', '选 1080p → 经 mapResolution 归一后随 recipe 冻结执行')
      check(s2After.planHash === s2.planHash && s2After.planRevision === s2.planRevision, '画质选择不入 planHash：确认不抬版本、不作废方案（价格注册表无档位维度的前提成立）')

      // —— 越界与门序（ALIYUN 种子下一律完成，会话哈希自洽）——
      const d3 = await makeReadySession('dynamic')
      const s3 = await sessRow(d3.sessionId)
      check(await codeOf(() => confirmCreation(d3.sessionId, { planRevision: s3.planRevision, planHash: s3.planHash, idempotencyKey: 'm43q-bad-1', acceptUnpriced: false, resolution: '2K' })) === 'resolution_unsupported', '枚举合法但不在本模型已背书档 → 422（不静默回落默认档）')
      const s3b = await sessRow(d3.sessionId)
      check(s3b.status === 'ready' && s3b.runId === null, '被拒的画质确认零启动、零状态改写')
      const slideS = await sessRow(slide.sessionId)
      check(await codeOf(() => confirmCreation(slide.sessionId, { planRevision: slideS.planRevision, planHash: slideS.planHash, idempotencyKey: 'm43q-bad-3', acceptUnpriced: false, resolution: '720p' })) === 'resolution_unsupported', 'slideshow 携带画质 → 拒绝（无视频步即无档位，不吃巧合命中的字符串）')
      // 哈希防篡改先于画质覆写：伪造 planHash 时即使带合法档也被拦
      check(await codeOf(() => confirmCreation(d2.sessionId, { planRevision: 1, planHash: 'f'.repeat(64), idempotencyKey: 'm43q-tamper', acceptUnpriced: false, resolution: '1080p' })) === 'stale_plan', '旧哈希 + 合法画质档 → stale_plan 先拦（选档不豁免防篡改校验）')
      // 覆写只影响本次 recipe：会话 pf 顶层投影（前端展示默认档）不被回写
      check((JSON.parse(String((await sessRow(d2.sessionId)).preflight)).resolutionOptions?.default) === '720p', '确认覆写只进 recipe，不回写会话预检投影')
      const strictRes = await app.request(`/api/v1/creation-sessions/${d3.sessionId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planRevision: s3b.planRevision, planHash: s3b.planHash, idempotencyKey: 'm43q-strict', acceptUnpriced: false, hacker: 1 }) })
      check(strictRes.status === 422 && String((await strictRes.json() as { error?: { code?: string } }).error?.code) === 'invalid_request', '确认请求 .strict() 拒未知键（路由级 422，两端契约对齐）')

      // —— 声明式单档：换 SILICON 种子后新建会话（重播种改了 audio/image 行，旧会话必现 configuration_changed，故哈希链须自洽）——
      await seedEndpoints(SILICON)
      const fixed = await makeReadySession('dynamic')
      check(JSON.stringify(fixed.pf.resolutionOptions?.choices) === '["720p"]', '实例显式声明即固定档位：只透出声明档（不放开真源全档）')
      const fixedS = await sessRow(fixed.sessionId)
      check(await codeOf(() => confirmCreation(fixed.sessionId, { planRevision: fixedS.planRevision, planHash: fixedS.planHash, idempotencyKey: 'm43q-bad-2', acceptUnpriced: false, resolution: '1080p' })) === 'resolution_unsupported', '声明式单档实例携其他档 → 拒绝（choices 取服务端重算的预检，不信前端展示值）')
    },

    // ============ binding：PATCH 双写 / revision bump / 守卫矩阵 / 再规划保留 / 读链矩阵 ============
    binding: async () => {
      const { db } = await import('../src/db')
      const { creationMessages, creationSessions, pipelineRuns } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { addAttachment, resolveAttachmentRefs } = await import('../src/services/creation-chat/attachments')
      const { bindCreationRef } = await import('../src/services/creation-chat/ref-bind')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')
      const { recipeOf } = await import('../src/services/creation-chat/recipe')
      const { recipeFirstFrameId, recipeRefImageIds } = await import('../src/services/creation-chat/recipe')
      const { sendCreationMessage } = await import('../src/services/creation-chat/planning')
      await seedEndpoints(ALIYUN)

      const s = await makeReadySession('dynamic')
      const att = await addAttachment(s.sessionId, { name: `m43-ref-${Date.now()}.png`, data: pngData(1) })
      check(att.kind === 'image' && att.role === 'style', '图片参考默认用途 style（登记零计费）')
      // 登记只写 payload；进 plan.refs 须经规划编译链（真实写链口径，bind 的 patch 分支以方案已含该资产为前提）
      llmReply = JSON.stringify({ kind: 'plan', message: '采纳参考', plan: makePlan('dynamic') })
      const adopted = await sendCreationMessage(s.sessionId, { content: '用这张参考图', requestKey: `m43b-adopt-${Date.now()}`, attachments: [att.assetId] })
      check(refsOf(adopted).length === 1 && adopted.session.planRevision === 2, '附件经规划编译链采纳进 plan.refs（基线 revision=2，LLM 不产出 refs）')
      const hashBefore = (await sessRow(s.sessionId)).planHash

      const llmBefore = llmCalls
      const detail = await bindCreationRef(s.sessionId, att.assetId, { shotId: 's2' })
      const row = await sessRow(s.sessionId)
      const boundPlan = JSON.parse(String(row.plan)) as { refs: Array<{ assetId: number; shotId?: string }> }
      const attMsg = (await db.select().from(creationMessages).where(eq(creationMessages.sessionId, s.sessionId))).find((m) => JSON.parse(String(m.payload)).kind === 'attachment')
      check(detail.session.planRevision === 3 && row.planRevision === 3 && row.planHash !== hashBefore, '绑定 → plan.refs 变化重算哈希并抬 revision（旧确认自然失效）')
      check(boundPlan.refs[0]?.shotId === 's2', '变更后方案 refs 带镜号（plan 真源已 patch）')
      check(JSON.parse(String(attMsg!.payload)).ref.shotId === 's2', 'payload 同步写（再规划编译的权威源与方案不分叉）')
      check(llmCalls === llmBefore, '绑定全程零 LLM（只重算预检与哈希）')

      // 编译链保留 shotId（写链断点修复）
      const compiled = await resolveAttachmentRefs(s.sessionId, s.projectId, [att.assetId])
      check(compiled[0]?.shotId === 's2', 'resolveAttachmentRefs 编译保留 shotId（此前丢弃导致绑定进不了方案）')

      // 旧确认作废 → 新哈希确认可放行且绑定随 recipe 冻结
      check(await codeOf(() => confirmCreation(s.sessionId, { planRevision: 2, planHash: hashBefore as string, idempotencyKey: 'm43b-stale', acceptUnpriced: false })) === 'stale_plan', '绑定后旧哈希确认 → stale_plan（用户必须重新确认）')
      const { runId } = await confirmCreation(s.sessionId, { planRevision: row.planRevision, planHash: String(row.planHash), idempotencyKey: 'm43b-ok001', acceptUnpriced: false })
      const run = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0]!
      check(recipeOf(run)!.refs[0]?.shotId === 's2', '新哈希确认后绑定随 recipe 冻结进批准方案（确认即执行）')
      check(await codeOf(() => bindCreationRef(s.sessionId, att.assetId, { shotId: 's1' })) === 'ref_locked', 'run 已启动 → 409 ref_locked（参考随方案冻结，改绑定须重新创作）')

      // —— 守卫矩阵（各用未启动的新会话）——
      const g1 = await makeReadySession('dynamic')
      const a1 = await addAttachment(g1.sessionId, { name: `m43-ghost-${Date.now()}.png`, data: pngData(2) })
      check(await codeOf(() => bindCreationRef(g1.sessionId, a1.assetId, { shotId: 'ghost' })) === 'shot_not_found', '绑不存在镜头 → 422（ready 态按当前方案真源校验）')
      const g2 = await makeReadySession('dynamic')
      const [draftRow] = await db.insert(creationSessions).values({ projectId: g2.projectId, requestKey: `m43b-draft${Date.now()}`, status: 'draft', planRevision: 0, runHistory: '[]', createdAt: Date.now(), updatedAt: Date.now() }).returning()
      const a2 = await addAttachment(draftRow!.id, { name: `m43-noplan-${Date.now()}.png`, data: pngData(3) })
      check(await codeOf(() => bindCreationRef(draftRow!.id, a2.assetId, { shotId: 's1' })) === 'no_plan_to_bind', '方案未生成即绑镜 → 409（规划前只有「整片」）')
      const g3 = await makeReadySession('dynamic')
      const a3 = await addAttachment(g3.sessionId, { name: `m43-aud-${Date.now()}.mp3`, data: pngData(4) })
      check(await codeOf(() => bindCreationRef(g3.sessionId, a3.assetId, { shotId: 's1' })) === 'shot_bind_unsupported', '音频带镜号 → 422（读链只消费 image 的 shotId，不受理无意义绑定）')
      check(await codeOf(() => bindCreationRef(g3.sessionId, a3.assetId, { role: 'style' })) === 'bad_role', '音频改 style → 422（role ∈ VALID_ROLES[kind] 服务端权威）')
      check(await codeOf(() => bindCreationRef(g3.sessionId, a3.assetId, { shotId: null })) === 'none', '音频回整片级（null 删键）是合法幂等操作')
      const g4 = await makeReadySession('dynamic')
      const a4 = await addAttachment(g4.sessionId, { name: `m43-role-${Date.now()}.png`, data: pngData(5) })
      await sendCreationMessage(g4.sessionId, { content: '采纳这张图', requestKey: `m43b-g4-${Date.now()}`, attachments: [a4.assetId] })
      await bindCreationRef(g4.sessionId, a4.assetId, { shotId: 's2' })
      const noChange = await bindCreationRef(g4.sessionId, a4.assetId, { role: 'style' })
      check(noChange.session.planRevision === 3, '重复提交同值绑定 → 哈希与 revision 不再变化（同值写不空转抬版本）')
      const undone = await bindCreationRef(g4.sessionId, a4.assetId, { shotId: null })
      check(!('shotId' in (refsOf(undone)[0] ?? {})), 'shotId null → 回整片级（refSchema .strict() 拒 null 值，服务端删键）')
      const g5 = await makeReadySession('dynamic')
      await db.update(creationSessions).set({ status: 'planning' }).where(eq(creationSessions.id, g5.sessionId))
      const a5 = await addAttachment(g5.sessionId, { name: `m43-busy-${Date.now()}.png`, data: pngData(6) })
      check(await codeOf(() => bindCreationRef(g5.sessionId, a5.assetId, { role: 'subject' })) === 'busy', '规划中 → 409 busy（与 attachmentsLocked 同源状态门）')

      // —— 路由接线（PATCH 端点 + Zod 422 通道）——
      const patch = (sid: number, aid: number, data: unknown) => app.request(`/api/v1/creation-sessions/${sid}/attachments/${aid}/ref`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      const g6 = await makeReadySession('dynamic')
      const a6 = await addAttachment(g6.sessionId, { name: `m43-api-${Date.now()}.png`, data: pngData(7) })
      await sendCreationMessage(g6.sessionId, { content: '采纳接口图', requestKey: `m43b-g6-${Date.now()}`, attachments: [a6.assetId] })
      const apiOk = await patch(g6.sessionId, a6.assetId, { role: 'first_frame', shotId: 's3' })
      const apiBody = await apiOk.json() as { session: { plan: { refs: Array<{ role: string; shotId?: string }> } } }
      check(apiOk.status === 200 && apiBody.session.plan.refs[0]?.role === 'first_frame' && apiBody.session.plan.refs[0]?.shotId === 's3', 'PATCH 端点接线：role+shotId 一次提交双写生效')
      check((await patch(g6.sessionId, a6.assetId, { hacker: 1 })).status === 422, '未知字段 → 422（.strict() 两端对齐）')
      check((await patch(g6.sessionId, a6.assetId, {})).status === 422, '空 PATCH 被拒（不提供变更即不动哈希）')
      check((await patch(g6.sessionId, 999999, { shotId: null })).status === 404, '未在本会话登记的资产 → 404（不瞎写）')
      check((await app.request(`/api/v1/creation-sessions/${g6.sessionId}/attachments/abc/ref`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"shotId":null}' })).status === 400, 'assetId 非法 → 400 bad_id 类拒绝（不吞进行锁内查询）')

      // —— 再规划（新消息+新附件）后绑定不丢：payload 权威源 + 编译保留双保险 ——
      llmReply = JSON.stringify({ kind: 'plan', message: '第二轮：加入第二张参考图', plan: makePlan('dynamic') })
      const a7 = await addAttachment(g6.sessionId, { name: `m43-two-${Date.now()}.png`, data: pngData(8) })
      const re = await sendCreationMessage(g6.sessionId, { content: '再加一张氛围图', requestKey: `m43b-replan-${Date.now()}`, attachments: [a7.assetId] })
      const reRefs = refsOf(re)
      check(reRefs.length === 2 && reRefs[0]?.assetId === a6.assetId && reRefs[0]?.shotId === 's3' && reRefs[0]?.role === 'first_frame', '带新附件再规划：旧图镜号绑定与用途经 payload 编译保留（写链断点已修）')
      check(reRefs[1]?.assetId === a7.assetId && reRefs[1]?.shotId === undefined, '新附图默认整片级（不虚构绑定）')

      // —— 读链矩阵（recipe 消费：shot 级 > 整片级 > null）——
      const H = 'a'.repeat(64)
      const recipe = { refs: [
        { assetId: 1, kind: 'image', role: 'first_frame', hash: H, shotId: 's1' },
        { assetId: 2, kind: 'image', role: 'first_frame', hash: H },
        { assetId: 3, kind: 'image', role: 'style', hash: H },
        { assetId: 4, kind: 'image', role: 'style', hash: H, shotId: 's2' },
      ] } as never
      check(recipeFirstFrameId(recipe, 's1') === 1 && recipeFirstFrameId(recipe, 's2') === 2, '首帧参考：shot 级优先，未命中回落整片级')
      const noGlobal = { refs: [{ assetId: 1, kind: 'image', role: 'first_frame', hash: H, shotId: 's1' }] } as never
      check(recipeFirstFrameId(noGlobal, 's2') === null, '既无本镜级也无整片级 → null（不拿别的镜的首帧凑数）')
      check(recipeRefImageIds(recipe, 's2', ['style', 'subject']).join(',') === '3,4', '图片参考注入：整片级 + 本镜级并集，他镜绑定项排除')
      check(mediaCalls === 0, '绑定节全程零媒体调用（PATCH 双写与预检重算都不起生成）')
    },

    // ============ carry：跨轮合并（同资产覆盖保位 / 新资产追加 / 超限权威拒绝） ============
    carry: async () => {
      const { sendCreationMessage } = await import('../src/services/creation-chat/planning')
      const { addAttachment } = await import('../src/services/creation-chat/attachments')
      const { bindCreationRef } = await import('../src/services/creation-chat/ref-bind')
      await seedEndpoints(ALIYUN)
      llmReply = JSON.stringify({ kind: 'plan', message: '分轮采纳参考', plan: makePlan('dynamic') })
      const s = await makeReadySession('dynamic')
      const a1 = await addAttachment(s.sessionId, { name: `m43-c1-${Date.now()}.png`, data: pngData(11) })
      await sendCreationMessage(s.sessionId, { content: '第一轮：用这张图', requestKey: `m43c-r1-${Date.now()}`, attachments: [a1.assetId] })
      const c1Row = await sessRow(s.sessionId)
      check(!!c1Row.plan && (JSON.parse(String(c1Row.plan)).refs as unknown[]).length === 1, '第一轮 refs=[A]（基线）')
      await bindCreationRef(s.sessionId, a1.assetId, { shotId: 's2' })
      const a2 = await addAttachment(s.sessionId, { name: `m43-c2-${Date.now()}.png`, data: pngData(12) })
      const r2 = await sendCreationMessage(s.sessionId, { content: '第二轮：再补一张', requestKey: `m43c-r2-${Date.now()}`, attachments: [a2.assetId] })
      const refs2 = refsOf(r2)
      check(refs2.length === 2 && refs2[0]?.assetId === a1.assetId && refs2[0]?.shotId === 's2', '带新附件的轮次不再整体替换：旧参考保位保留、绑定不丢（缺陷实锤修复）')
      check(refs2[1]?.assetId === a2.assetId, '新资产追加末尾')
      const r3 = await sendCreationMessage(s.sessionId, { content: '第三轮：重传第一张换用途', requestKey: `m43c-r3-${Date.now()}`, attachments: [a1.assetId] })
      const refs3 = refsOf(r3)
      check(refs3.length === 2 && refs3[0]?.assetId === a1.assetId, '重传同资产：本轮覆盖占原位，不误追加重复项')
      const r4 = await sendCreationMessage(s.sessionId, { content: '第四轮：只改文案', requestKey: `m43c-r4-${Date.now()}` })
      check(refsOf(r4).length === 2, '无新附件沿用全部已采纳参考（既有 refinement 行为零回归）')

      // —— 合并超上限：服务端权威拒绝且不花 LLM 钱 ——
      const big = await makeReadySession('dynamic')
      const ids: number[] = []
      for (let i = 0; i < 12; i++) ids.push((await addAttachment(big.sessionId, { name: `m43-full-${i}-${Date.now()}.png`, data: pngData(20 + i) })).assetId)
      await sendCreationMessage(big.sessionId, { content: '一次收满 12 张', requestKey: `m43c-full-${Date.now()}`, attachments: ids })
      const fullRow = await sessRow(big.sessionId)
      check(!!fullRow.plan && (JSON.parse(String(fullRow.plan)).refs as unknown[]).length === 12, '12 张整收编进方案（上限内正常）')
      const extra = await addAttachment(big.sessionId, { name: `m43-extra-${Date.now()}.png`, data: pngData(99) })
      const callsBefore = llmCalls
      const rejected = await sendCreationMessage(big.sessionId, { content: '再加第 13 张', requestKey: `m43c-13-${Date.now()}`, attachments: [extra.assetId] })
      check(llmCalls === callsBefore, '合并超限在调用 LLM 前拒绝（注定无效的轮次不先花钱）')
      check(rejected.session.status === 'draft' && String(rejected.session.error).includes('最多 12'), '第 13 张 → too_many_refs 明告（不静默截断丢参考）')
      check((JSON.parse(String((await sessRow(big.sessionId)).plan)).refs as unknown[]).length === 12, '被拒轮次旧方案与 refs 原样（零部分写入）')
      check(mediaCalls === 0, '跨轮合并节零媒体调用')
    },
  }

  await runSections({ log, title: 'M43', checker, sections: SECTIONS, runners, cleanup: () => { globalThis.fetch = originalFetch; envCleanup() } })
}
void main()
