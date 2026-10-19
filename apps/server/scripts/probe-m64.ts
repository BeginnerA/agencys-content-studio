/**
 * M64 探针（智能创作 Agent 收口遗留：G2 confirmRoute 三形态运行链 + G3 synth 生命周期与 GC）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m64.ts [--section=confirm-template|confirm-synth|confirm-chain|chain-await|guards|synth-gc|reverse-fallback]
 *
 * 与 probe-m63（纯函数契约）互补：本探针用 isolatedEnv('m64') 起真库（独立 studio.db），
 * 直插 project + ready 态 agent 会话（decision=normalizeAgentReply 权威归一产物），
 * 打桩 engine.startRun 阻断真实媒体执行（零网络/零计费），直接调 confirmRoute 走真实分派链，
 * 断言状态机与副作用（项目转正 / run 行 / 会话 started / workflowId 回写 / 幂等 / 结构闸 / 临时模板落盘与回收）。
 *
 * ⚠ 模板目录用「拷贝」而非 junction 桥接：synth 路径 saveTemplate 会向 TEMPLATES_DIR 写文件，
 *   junction 会污染真仓 workspace/templates；拷贝进临时 workspace 后写删皆隔离。prompts 只读桥接即可。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, runSections, REPO_ROOT, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m64', { bridge: ['prompts'] })
// 拷贝真实模板目录进临时 workspace（catalog 非空 + synth 写删隔离）
const WS_TPL = join(process.env.CSTUDIO_WORKSPACE as string, 'templates')
cpSync(join(REPO_ROOT, 'workspace', 'templates'), WS_TPL, { recursive: true })

const SECTIONS = ['confirm-template', 'confirm-synth', 'confirm-chain', 'chain-await', 'guards', 'synth-gc', 'reverse-fallback', 'parse-fallback', 'generic-gate'] as const

/** synth 正例 YAML：单 literal 步、模板级无 inputs（空输入即过 createRunRow）。key 归一为 agent-s{sid}-flow */
const SYNTH_OK_YAML = 'name: 智能临时流程\nsteps:\n  - key: say\n    action: literal\n    inputs:\n      text: hello\n'
/** synth 负例：声明必填文本输入 must 但不物化 → 起 run 事务内 createRunRow 失败（验证临时件不残留） */
const SYNTH_NEEDS_INPUT_YAML = 'name: 需输入临时流程\ninputs:\n  - key: must\n    label: 必填\n    kind: text\n    required: true\nsteps:\n  - key: say\n    action: literal\n    inputs:\n      text: hi\n'

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m64')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const { db, initDb } = await import('../src/db')
  const { creationMessages, creationSessions, pipelineRuns, pipelineSteps, projects, workflows } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { TEMPLATES_DIR } = await import('../src/env')
  const { app } = await import('../src/app')
  const { buildTemplateCatalog } = await import('../src/services/creation-chat/agent/template-catalog')
  const { normalizeAgentReply, decisionHashOf } = await import('../src/services/creation-chat/agent/normalize')
  const { confirmRoute } = await import('../src/services/creation-chat/route-execution')
  const { notifyCreationSettled, creationDetail } = await import('../src/services/creation-chat/store')
  const { advanceChainSegment } = await import('../src/services/creation-chat/chain-advance')
  const { saveTemplate, loadTemplate } = await import('../src/pipeline/loader')
  const { loadCreationProjection } = await import('../src/services/creation-chat/projection')
  const { decideCreationGate } = await import('../src/services/creation-chat/gate')

  await initDb()
  const catalog = buildTemplateCatalog()
  const byKey = (k: string) => catalog.find((t) => t.key === k)!
  const QUICK = 'quick-video' // 必填 idea（text）
  const NOTE = 'note-clip' // 必填 topic（text）
  check(catalog.length > 0 && !!byKey(QUICK) && !!byKey(NOTE) && !catalog.some((t) => t.key.startsWith('easy-')), `专业目录拷贝到位（${catalog.length} 项，含 ${QUICK}/${NOTE}、排除 easy-*）`)

  // 打桩 engine.startRun：只计数不执行（零网络/零计费）
  const engine = await import('../src/pipeline/engine')
  const origStart = engine.engine.startRun.bind(engine.engine)
  let started = 0
  engine.engine.startRun = ((runId: number): 'started' => { started += 1; void runId; return 'started' }) as typeof engine.engine.startRun

  /** 直插 draft 影子项目 */
  const seedProject = async (name: string): Promise<number> => {
    const t = Date.now()
    const [p] = await db.insert(projects).values({ name, genre: 'other', templateKey: QUICK, status: 'draft', brief: name, tags: JSON.stringify(['智能创作']), createdAt: t, updatedAt: t }).returning()
    return p!.id
  }
  /** 直插 agent 待确认会话：先建 draft 拿 id（synth key 命名依赖 sessionId），再归一决策、回填 ready 态 */
  const seedRouteSession = async (projectId: number, reply: Record<string, unknown>): Promise<{ sessionId: number; decisionHash: string; decision: string }> => {
    const t = Date.now()
    const key = `m64s${t}${Math.random().toString(36).slice(2, 7)}`
    await db.insert(creationSessions).values({ projectId, requestKey: key, status: 'draft', planRevision: 0, runHistory: '[]', createdAt: t, updatedAt: t })
    const [s] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
    const sid = s!.id
    const decision = normalizeAgentReply(reply as never, catalog, { sessionId: sid, allowedAssetIds: new Set<number>() })!
    const hash = decisionHashOf(decision)
    await db.update(creationSessions).set({ status: 'ready', agentMode: 1, decision: JSON.stringify(decision), decisionHash: hash, planRevision: 1, updatedAt: Date.now() }).where(eq(creationSessions.id, sid))
    return { sessionId: sid, decisionHash: hash, decision: JSON.stringify(decision) }
  }
  const confirmReq = (sessionId: number, decisionHash: string, ikey: string) => ({ decisionRevision: 1, decisionHash, idempotencyKey: ikey, acceptUnpriced: false })
  const synthKeyOf = (sessionId: number) => `agent-s${sessionId}-flow`
  const synthFileOf = (key: string) => join(TEMPLATES_DIR, `${key}.yaml`)
  const runCount = async (pid: number) => (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, pid))).length
  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); return 'none' } catch (err) { return err && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'other' }
  }

  const runners: Record<string, () => Promise<void>> = {
    // ================= confirm-template：直调起 run + 状态机 + 幂等 =================
    'confirm-template': async () => {
      const proj = await seedProject('一句话出条快视频')
      const { sessionId, decisionHash } = await seedRouteSession(proj, { kind: 'route', mode: 'template', message: '走快视频', rationale: '单条创意直出', roleKey: 'planner', templateRun: { templateKey: QUICK, inputSpec: { idea: { kind: 'text', value: '一句话创意探针' } } } })
      const before = started
      const res = await confirmRoute(sessionId, confirmReq(sessionId, decisionHash, 'm64tplrun0001'))
      const [s] = await db.select().from(creationSessions).where(eq(creationSessions.id, sessionId))
      const [p] = await db.select().from(projects).where(eq(projects.id, proj))
      const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, res.runId))
      check(res.runId > 0 && s!.status === 'started' && s!.runId === res.runId, 'template 确认 → 起 run + 会话 started + runId 回写')
      check(p!.status === 'active', 'template 确认 → 影子项目转正 active')
      check(run!.templateKey === QUICK && run!.status === 'queued' && started === before + 1, 'template → 落 queued run 行（快照模板）且只启动一次')
      check((await db.select({ id: creationMessages.id }).from(creationMessages).where(eq(creationMessages.sessionId, sessionId))).length >= 1, 'template 起 run 后写回对话留痕')
      // 幂等：已起 run 再确认 → 直接返回既有 runId，不再起
      const again = await confirmRoute(sessionId, confirmReq(sessionId, decisionHash, 'm64tplrun0001'))
      check(again.runId === res.runId && started === before + 1 && (await runCount(proj)) === 1, 'template 幂等：二次确认命中既有 runId，不重复起 run')
    },

    // ================= confirm-synth：临时模板落盘 + 起 run + visibility 过滤 =================
    'confirm-synth': async () => {
      const proj = await seedProject('没有现成模板的临时流程')
      const { sessionId, decisionHash } = await seedRouteSession(proj, { kind: 'route', mode: 'synth', message: '临时编排', rationale: '未命中既有模板', roleKey: 'planner', synth: { yaml: SYNTH_OK_YAML } })
      const key = synthKeyOf(sessionId)
      check(!existsSync(synthFileOf(key)), 'synth 确认前临时件不在位（尚未落盘）')
      const res = await confirmRoute(sessionId, confirmReq(sessionId, decisionHash, 'm64synthrun0001'))
      const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, res.runId))
      check(res.runId > 0 && existsSync(synthFileOf(key)), 'synth 确认 → saveTemplate 落临时件 + 起 run')
      check(run!.templateKey === key, 'synth run 指向仿制 key（agent-s{sid}-*）')
      const raw = readFileSync(synthFileOf(key), 'utf8')
      check(/visibility:\s*conversation/.test(raw) && /builtin:\s*false/.test(raw), 'synth 临时件强制 visibility:conversation + builtin:false（仿制非内置）')
      check(!buildTemplateCatalog().some((t) => t.key === key), 'synth 临时件不进专业可调度目录（visibility:conversation 被排除）')
    },

    // ================= confirm-chain：建链 + 首段 run + workflowId 回写（autoAdvance=0） =================
    'confirm-chain': async () => {
      const proj = await seedProject('两步编排链')
      const { sessionId, decisionHash } = await seedRouteSession(proj, {
        kind: 'route', mode: 'chain', message: '先选题后成稿', rationale: '多步任务', roleKey: 'planner',
        chain: [{ templateKey: QUICK, inputSpec: { idea: { kind: 'text', value: '链首段创意' } } }, { templateKey: NOTE, inputSpec: { topic: { kind: 'text', value: '链次段图文' } } }],
      })
      const before = started
      const res = await confirmRoute(sessionId, confirmReq(sessionId, decisionHash, 'm64chainrun01'))
      const [s] = await db.select().from(creationSessions).where(eq(creationSessions.id, sessionId))
      const [wf] = await db.select().from(workflows).where(eq(workflows.id, res.workflowId!))
      const segRuns = await db.select({ id: pipelineRuns.id, seq: pipelineRuns.workflowSeq, key: pipelineRuns.templateKey }).from(pipelineRuns).where(eq(pipelineRuns.workflowId, res.workflowId!))
      check(res.runId > 0 && res.workflowId! > 0, 'chain 确认 → 建编排链 + 起首段 run')
      check(!!wf && wf.autoAdvance === 0, 'chain 编排链 autoAdvance=0（段间暂停安全默认）')
      check(s!.workflowId === res.workflowId && s!.status === 'started', 'chain → 会话 workflowId 回写 + started')
      check(segRuns.length === 1 && segRuns[0]!.seq === 0 && segRuns[0]!.key === QUICK && started === before + 1, 'chain 仅起首段（seq0·quick-video），未级联后续段')
    },

    // ================= chain-await：段间「对话内批准续跑」闭环（M64 G1） =================
    'chain-await': async () => {
      // 建链起首段（同 confirm-chain）
      const proj = await seedProject('对话内批准续跑链')
      const { sessionId, decisionHash } = await seedRouteSession(proj, {
        kind: 'route', mode: 'chain', message: '先选题后成稿', rationale: '多步任务', roleKey: 'planner',
        chain: [{ templateKey: QUICK, inputSpec: { idea: { kind: 'text', value: '链首段创意' } } }, { templateKey: NOTE, inputSpec: { topic: { kind: 'text', value: '链次段图文' } } }],
      })
      const first = await confirmRoute(sessionId, confirmReq(sessionId, decisionHash, 'm64await0000001'))
      const [wf0] = await db.select().from(workflows).where(eq(workflows.id, first.workflowId!))
      // 模拟首段落定：run completed → 走真实 settle 钩子 notifyCreationSettled（index.ts 注册同源函数）
      await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, first.runId))
      await notifyCreationSettled(first.runId)
      const msgs1 = await db.select({ payload: creationMessages.payload }).from(creationMessages).where(eq(creationMessages.sessionId, sessionId))
      const awaitMsg = msgs1.some((m) => { const p = m.payload ? JSON.parse(m.payload) as Record<string, unknown> : {}; return p['kind'] === 'chain-await' && p['workflowId'] === wf0!.id && p['seq'] === 0 })
      check(!!wf0 && wf0.autoAdvance === 0 && awaitMsg, 'chain 首段落定(settled 钩子) → 会话回写「第1段已完成待批准」留痕')
      // 投影：creationDetail sideCards 出现 chainAwaiting 卡（纯读派生，链仍 active 未 paused）
      const d1 = await creationDetail(sessionId)
      const [wfAfter] = await db.select().from(workflows).where(eq(workflows.id, first.workflowId!))
      check((d1.sideCards as { key: string }[]).some((c) => c.key === 'chainAwaiting') && wfAfter!.status === 'active', 'chainAwaiting 批准卡投影出现（链保持 active·非 paused：修正设计稿 paused 假设）')
      // 非链会话批准 → not_chain（守卫先行）
      const pTpl = await seedProject('单模板会话')
      const tpl = await seedRouteSession(pTpl, { kind: 'route', mode: 'template', message: 'm', rationale: 'r', roleKey: 'planner', templateRun: { templateKey: QUICK, inputSpec: { idea: { kind: 'text', value: 'x' } } } })
      check(await codeOf(() => advanceChainSegment(tpl.sessionId, { idempotencyKey: 'm64awaitnotchain' })) === 'not_chain', '非链会话调 advance-chain → not_chain（守卫拒绝）')
      // 批准续跑：起第 2 段 run + session.runId 追随 + chain-advance 留痕 + chainAwaiting 卡回落
      const before2 = started
      const adv = await advanceChainSegment(sessionId, { idempotencyKey: 'm64awaitadvance01' })
      const segRuns2 = await db.select({ id: pipelineRuns.id, seq: pipelineRuns.workflowSeq, key: pipelineRuns.templateKey }).from(pipelineRuns).where(eq(pipelineRuns.workflowId, first.workflowId!))
      const [s2] = await db.select().from(creationSessions).where(eq(creationSessions.id, sessionId))
      const msgs2 = await db.select({ payload: creationMessages.payload }).from(creationMessages).where(eq(creationMessages.sessionId, sessionId))
      const advMsg = msgs2.some((m) => { const p = m.payload ? JSON.parse(m.payload) as Record<string, unknown> : {}; return p['kind'] === 'chain-advance' && p['runId'] === adv.runId })
      const d2 = await creationDetail(sessionId)
      check(adv.outcome === 'advanced' && !!adv.runId && segRuns2.length === 2 && segRuns2.some((r) => r.seq === 1 && r.key === NOTE) && started === before2 + 1, '批准续跑 → requestNextSegment 起第2段 run（note-clip·seq1）+ 仅启动一次')
      check(s2!.runId === adv.runId && advMsg, '批准续跑 → 会话 runId 追随当前段 + chain-advance 留痕')
      check(!(d2.sideCards as { key: string }[]).some((c) => c.key === 'chainAwaiting'), '第2段在途后 chainAwaiting 卡回落（下一段未起判据失效）')
      // 幂等：再次批准（第2段仍 queued 未落定）→ inflight，不重复建段/计费
      const before3 = started
      const adv2 = await advanceChainSegment(sessionId, { idempotencyKey: 'm64awaitadvance02' })
      const segRuns3 = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.workflowId, first.workflowId!))
      check(adv2.outcome === 'inflight' && segRuns3.length === 2 && started === before3, '连点批准（下一段在途）→ inflight 幂等命中，不重复建段/计费')
    },

    // ================= guards：结构闸 + 确认闸拒绝路径（可见不静默） =================
    guards: async () => {
      // not_ready：agentMode≠1（legacy 会话）→ routeDecisionOf null
      const p0 = await seedProject('旧路径会话')
      const { sessionId: s0, decisionHash: h0 } = await seedRouteSession(p0, { kind: 'route', mode: 'template', message: 'm', rationale: 'r', roleKey: 'planner', templateRun: { templateKey: QUICK, inputSpec: { idea: { kind: 'text', value: 'x' } } } })
      await db.update(creationSessions).set({ agentMode: 0 }).where(eq(creationSessions.id, s0))
      check(await codeOf(() => confirmRoute(s0, confirmReq(s0, h0, 'm64guardnotready'))) === 'not_ready', 'agentMode=0 会话 route 确认 → not_ready（分派回旧路，不误走 route）')

      // stale_plan：decisionHash 不符 → 拒绝
      const p1 = await seedProject('哈希漂移会话')
      const { sessionId: s1, decisionHash: h1 } = await seedRouteSession(p1, { kind: 'route', mode: 'template', message: 'm', rationale: 'r', roleKey: 'planner', templateRun: { templateKey: QUICK, inputSpec: { idea: { kind: 'text', value: 'x' } } } })
      const wrongHash = 'f'.repeat(64)
      check(await codeOf(() => confirmRoute(s1, { decisionRevision: 1, decisionHash: wrongHash, idempotencyKey: 'm64guardstale', acceptUnpriced: false })) === 'stale_plan' && h1.length === 64, 'decisionHash 不符 → stale_plan（确认闸作废，防 TOCTOU）')

      // template_drift：catalogSnapshot 版本被改 → 结构闸拒绝
      const p2 = await seedProject('模板漂移会话')
      const seed = await seedRouteSession(p2, { kind: 'route', mode: 'template', message: 'm', rationale: 'r', roleKey: 'planner', templateRun: { templateKey: QUICK, inputSpec: { idea: { kind: 'text', value: 'x' } } } })
      const drifted = JSON.parse(seed.decision) as { templateRun: { catalogSnapshot: { version: number } } }
      drifted.templateRun.catalogSnapshot.version += 999
      const driftedJson = JSON.stringify(drifted)
      const { hashJson } = await import('../src/services/creation-chat/contract')
      await db.update(creationSessions).set({ decision: driftedJson, decisionHash: hashJson(drifted) }).where(eq(creationSessions.id, seed.sessionId))
      const driftHash = hashJson(drifted)
      check(await codeOf(() => confirmRoute(seed.sessionId, confirmReq(seed.sessionId, driftHash, 'm64guarddrift'))) === 'template_drift', '模板版本漂移 → 结构闸 template_drift 拒绝（决策后资产变更作废旧确认）')

      // synth 起 run 失败 → 临时件不残留（要么 preflight 拦截、要么事务回滚删除）
      const p3 = await seedProject('synth 起 run 必失败会话')
      const { sessionId: s3, decisionHash: h3 } = await seedRouteSession(p3, { kind: 'route', mode: 'synth', message: 'm', rationale: 'r', roleKey: 'planner', synth: { yaml: SYNTH_NEEDS_INPUT_YAML } })
      const threw = await codeOf(() => confirmRoute(s3, confirmReq(s3, h3, 'm64guardsynthfail')))
      const orphan = existsSync(synthFileOf(synthKeyOf(s3)))
      check(threw !== 'none' && !orphan, `synth 必填输入未满足 → 确认抛错(${threw}) 且临时件不残留（无孤儿件污染模板目录）`)
    },

    // ================= synth-gc：会话删除回收仿制临时件 =================
    'synth-gc': async () => {
      // 造一个已起 run 的 synth 会话（临时件在位）→ DELETE → 仿制件随会话回收
      const proj = await seedProject('待删除的 synth 会话')
      const { sessionId, decisionHash } = await seedRouteSession(proj, { kind: 'route', mode: 'synth', message: '临时', rationale: 'r', roleKey: 'planner', synth: { yaml: SYNTH_OK_YAML } })
      const key = synthKeyOf(sessionId)
      const res = await confirmRoute(sessionId, confirmReq(sessionId, decisionHash, 'm64gcrun0000001'))
      check(existsSync(synthFileOf(key)), 'synth-gc 前置：仿制临时件已落盘在位')
      await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, res.runId))
      const del = await app.request(`/api/v1/creation-sessions/${sessionId}`, { method: 'DELETE' })
      check(del.status === 200, 'synth 会话删除 → 200（run 已完成可删）')
      check(!existsSync(synthFileOf(key)), '会话删除回收仿制临时件（agent-s* 不污染模板目录）')
      // 已存在会话删除不影响他处：再落一件手工仿制件确认存在性判据可靠
      saveTemplate('agent-s-manual-probe', SYNTH_OK_YAML)
      check(existsSync(synthFileOf('agent-s-manual-probe')), '手工落仿制件在位（隔离目录写判据可靠）')
      rmSync(synthFileOf('agent-s-manual-probe'), { force: true })
      check(!existsSync(synthFileOf('agent-s-manual-probe')), '手工仿制件可被删除（清理机制可用）')
    },

    // ================= reverse-fallback：纯图片反推意图遇决策解析失败不判死（M63 契约缺口收口） =================
    'reverse-fallback': async () => {
      const { shouldDeliverReverseFallback, persistReverseFallback } = await import('../src/services/creation-chat/planning')
      const { parseAgentReply } = await import('../src/services/creation-chat/agent/reply-schema')
      const { CreationError } = await import('../src/services/creation-chat/contract')
      // 1) 判定真值表（零副作用纯函数）
      const ipErr = new CreationError('invalid_plan', 'x', 422)
      check(shouldDeliverReverseFallback({ reverseIntent: true, imageAnalysisCount: 1, error: ipErr }) === true, 'fallback 判定：反推+有产物+invalid_plan → 接管')
      check(shouldDeliverReverseFallback({ reverseIntent: false, imageAnalysisCount: 1, error: ipErr }) === false, 'fallback 判定：非反推意图 → 不接管（普通成片维持可见拒绝）')
      check(shouldDeliverReverseFallback({ reverseIntent: true, imageAnalysisCount: 0, error: ipErr }) === false, 'fallback 判定：无反推产物 → 不接管')
      check(shouldDeliverReverseFallback({ reverseIntent: true, imageAnalysisCount: 1, error: new CreationError('conflict', 'x', 409) }) === false, 'fallback 判定：非 invalid_plan 错误 → 不接管')
      check(shouldDeliverReverseFallback({ reverseIntent: true, imageAnalysisCount: 1, error: new Error('boom') }) === false, 'fallback 判定：非 CreationError → 不接管')
      // 2) 触发条件真实来源：三形皆不合的模型输出确会抛 invalid_plan（即喂入判定的 error）
      const parseCode = (c: string): string => { try { parseAgentReply(c); return 'none' } catch (e) { return e && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'other' } }
      check(parseCode('这张图的提示词大概是：一个女孩在雨中') === 'invalid_plan', '散文非 JSON → invalid_plan（反推诉求模型直答文本的典型失败形）')
      check(parseCode(JSON.stringify({ kind: 'clarify', message: '这属于图片反推，我可以帮你…' })) === 'invalid_plan', 'clarify 缺 questions → invalid_plan（边界说明形撞 min(1)）')
      check(parseCode(JSON.stringify({ kind: 'route', mode: 'synth', message: '临时' })) === 'invalid_plan', 'route 缺 rationale → invalid_plan')
      // 3) 真实落库：seed planning 态会话 → persistReverseFallback → draft + revision+1 + 带 imageAnalysis 的 clarify 消息
      const proj = await seedProject('反推图片提示词收口')
      const t = Date.now()
      const rkey = `m64rf${t}${Math.random().toString(36).slice(2, 7)}`
      await db.insert(creationSessions).values({ projectId: proj, requestKey: rkey, status: 'planning', agentMode: 1, planRevision: 3, runHistory: '[]', createdAt: t, updatedAt: t })
      const [claimed] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, rkey))
      const imgEntries = [{ assetId: 123, name: '微信图片_风格参考', subject: '雨中的女孩', style: '吉卜力风', imagePrompt: 'a girl in the rain, ghibli style, cinematic lighting', negativePrompt: 'low quality', palette: ['#1a2b3c'] }]
      await persistReverseFallback(claimed!.id, claimed!, imgEntries)
      const [after] = await db.select().from(creationSessions).where(eq(creationSessions.id, claimed!.id))
      check(after!.status === 'draft' && after!.planRevision === 4 && after!.plan === null && after!.error === null, 'persistReverseFallback → 会话回 draft + planRevision+1 + 清 plan/error（非判死）')
      const msgs = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, claimed!.id))
      const fb = msgs.find((m) => m.role === 'assistant')
      const payload = fb?.payload ? JSON.parse(fb.payload) as Record<string, unknown> : {}
      check(!!fb && payload.kind === 'clarify' && Array.isArray(payload.questions) && (payload.questions as unknown[]).length === 2, 'fallback 写 clarify 助手消息 + 两条追问（前端渲染 chips）')
      check(Array.isArray(payload.imageAnalysis) && (payload.imageAnalysis as { imagePrompt: string }[])[0]!.imagePrompt.includes('ghibli'), 'fallback 消息 payload 携带反推交付物（前端 payload.imageAnalysis 渲染反推卡）')
      // 乐观锁：会话已回 draft 再落 → conflict（幂等防重复写）
      check(await codeOf(() => persistReverseFallback(claimed!.id, claimed!, imgEntries)) === 'conflict', 'fallback 乐观锁：会话已回 draft 再落 → conflict')
    },

    // ================= parse-fallback：agent 决策解析失败通用兜底 + 混剪路由指令 + 右侧下一步卡（用户实弹「把图剪成视频」暴露的缺口收口） =================
    'parse-fallback': async () => {
      const { shouldDeliverParseFallback, persistParseFallback, buildMontageRouteNudge } = await import('../src/services/creation-chat/planning')
      const { computeSideCards } = await import('../src/services/creation-chat/side-cards')
      const { wantsPhotoMontage } = await import('../src/services/creation-chat/route-hint')
      const { CreationError } = await import('../src/services/creation-chat/contract')
      // 1) 混剪谓词：用户原句「将这些图片剪辑成一个视频」旧表漏判，现须命中；无图参考 / 无图类词仍不命中（双前置防线零回归）
      check(wantsPhotoMontage('将这些图片剪辑成一个视频', true) === true, '「将这些图片剪辑成一个视频」（有图片参考）→ wantsPhotoMontage 命中（用户实弹原句）')
      check(wantsPhotoMontage('将这些图片剪辑成一个视频', false) === false, '同句但无图片参考 → 不命中（弱词双前置）')
      check(wantsPhotoMontage('把这段文案做成视频', false) === false, '无图类词/无参考的「做成视频」→ 不命中（回归锁）')
      // 2) 混剪路由指令：命中措辞 + 有图片 id → 一条含 photo-montage 与原图 id 的 system 指令；否则空
      const nudge = buildMontageRouteNudge('把这些照片拼成一个视频', [101, 102, 103])
      check(nudge.length === 1 && nudge[0]!.role === 'system' && typeof nudge[0]!.content === 'string' && (nudge[0]!.content as string).includes('photo-montage') && (nudge[0]!.content as string).includes('101, 102, 103'), '混剪意图 + 图片 id → 注入 route photo-montage 指令（含原图 id）')
      check(buildMontageRouteNudge('做一条科普短视频', [101]).length === 0, '非混剪措辞 → 不注入路由指令（不干扰其它意图）')
      check(buildMontageRouteNudge('把这些照片拼成视频', []).length === 0, '混剪措辞但无可用图片 id → 不注入（无米下锅）')
      // 3) 通用兜底判定真值表：invalid_plan（含截断）→ 接管；非 invalid_plan / 非 CreationError → 不接管
      check(shouldDeliverParseFallback(new CreationError('invalid_plan', 'x', 422)) === true, '兜底判定：invalid_plan → 接管')
      check(shouldDeliverParseFallback(new CreationError('conflict', 'x', 409)) === false, '兜底判定：非 invalid_plan → 不接管')
      check(shouldDeliverParseFallback(new Error('boom')) === false, '兜底判定：非 CreationError → 不接管')
      // 4) 真实落库：seed planning 态会话 → persistParseFallback(montage) → draft + revision+1 + 带追问的 clarify 消息
      const t = Date.now()
      const mkPlanning = async (tag: string) => {
        const proj = await seedProject(tag)
        const key = `m64pf${t}${tag}${Math.random().toString(36).slice(2, 7)}`
        await db.insert(creationSessions).values({ projectId: proj, requestKey: key, status: 'planning', agentMode: 1, planRevision: 5, runHistory: '[]', createdAt: t, updatedAt: t })
        const [row] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
        return row!
      }
      const claimedM = await mkPlanning('混剪兜底')
      await persistParseFallback(claimedM.id, claimedM, { montage: true })
      const [afterM] = await db.select().from(creationSessions).where(eq(creationSessions.id, claimedM.id))
      check(afterM!.status === 'draft' && afterM!.planRevision === 6 && afterM!.plan === null && afterM!.error === null, 'persistParseFallback(montage) → 回 draft + revision+1 + 清 plan/error（非死胡同红字）')
      const msgsM = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, claimedM.id))
      const fbM = msgsM.find((m) => m.role === 'assistant')
      const payM = fbM?.payload ? JSON.parse(fbM.payload) as Record<string, unknown> : {}
      check(!!fbM && payM.kind === 'clarify' && Array.isArray(payM.questions) && (payM.questions as unknown[]).length === 3 && (fbM.content as string).includes('素材混剪'), 'montage 兜底 → 写 clarify 助手消息（含「素材混剪」话术 + 3 条追问）')
      // 通用（非混剪）兜底 → 2 条追问，话术不含混剪
      const claimedG = await mkPlanning('通用兜底')
      await persistParseFallback(claimedG.id, claimedG, { montage: false })
      const msgsG = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, claimedG.id))
      const fbG = msgsG.find((m) => m.role === 'assistant')
      const payG = fbG?.payload ? JSON.parse(fbG.payload) as Record<string, unknown> : {}
      check(Array.isArray(payG.questions) && (payG.questions as unknown[]).length === 2 && !(fbG!.content as string).includes('素材混剪'), '通用兜底 → clarify 2 条追问（换种说法 / 按常见设置出一条）')
      // 乐观锁：会话已回 draft 再落 → conflict
      check(await codeOf(() => persistParseFallback(claimedG.id, claimedG, { montage: false })) === 'conflict', '兜底乐观锁：会话已回 draft 再落 → conflict（幂等防重复写）')
      // 5) 右侧面板上下文：draft·无方案·无 run + awaitingClarify → clarify 卡（取代固定 guide）；反推产物优先；皆无 → guide
      const base = { status: 'draft', agentMode: true, decisionMode: null, hasPlan: false, confirmable: false, workflowId: null, chainAwaiting: false, hasRun: false, runStatus: null, hasReview: false, hasResult: false, hasArtifacts: false, hasReverseDeliverable: false, awaitingClarify: false } as const
      check((computeSideCards({ ...base, awaitingClarify: true }) as { key: string }[]).some((c) => c.key === 'clarify'), 'clarify 待补充态 → 右侧出 clarify 下一步卡（体现对话上下文，非固定 guide）')
      check((computeSideCards(base) as { key: string }[]).every((c) => c.key === 'guide'), 'draft 无 clarify/无反推 → 回落 guide（零回归）')
      check((computeSideCards({ ...base, awaitingClarify: true, hasReverseDeliverable: true }) as { key: string }[]).some((c) => c.key === 'reverseAnalysis') === true && (computeSideCards({ ...base, awaitingClarify: true, hasReverseDeliverable: true }) as { key: string }[]).length === 1, '反推产物优先于 clarify（同处 draft 只出反推成果卡）')
    },

    // ================= generic-gate：route/专业模板 run 的中途审阅收口（对话页可内联批准） =================
    // 用户实弹「把这些图片做成一个视频」命中 photo-montage，run 挂在模板自带 gate（reject:stop）上，
    // 但通用投影曾把 review 写死 null → 对话页无审阅面板、无法审批。此段锁死新契约：通用投影透出 review + 卡进 sideCards + 端点可批准。
    'generic-gate': async () => {
      const proj = await seedProject('素材混剪待审阅')
      const t = Date.now()
      const key = `m64g${t}${Math.random().toString(36).slice(2, 7)}`
      await db.insert(creationSessions).values({ projectId: proj, requestKey: key, status: 'started', planRevision: 0, runHistory: '[]', agentMode: 1, createdAt: t, updatedAt: t })
      const [sess] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
      const snapshot = loadTemplate('photo-montage')
      const [run] = await db.insert(pipelineRuns).values({ projectId: proj, templateKey: 'photo-montage', templateSnapshot: JSON.stringify(snapshot), status: 'waiting_input', currentStepKey: 'compose', input: '{}', createdAt: t, updatedAt: t }).returning()
      await db.insert(pipelineSteps).values({ runId: run!.id, seq: 0, stepKey: 'compose', actionKey: 'ffmpeg_merge', title: '素材混剪合成成片', status: 'waiting_input', createdAt: t, updatedAt: t })
      await db.update(creationSessions).set({ runId: run!.id }).where(eq(creationSessions.id, sess!.id))
      const [runRow] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run!.id))
      const stepRows = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, run!.id))
      const projected = await loadCreationProjection(sess!, runRow!, stepRows, [])
      const rv = projected.progress.review as { stepKey?: string; message?: string; rejectStops?: boolean } | null
      check(!!rv && rv.stepKey === 'compose' && (rv.message || '').includes('审阅成片') && rv.rejectStops === true, '通用投影在 waiting_input 透出 review（compose 闸·模板 gate 文案·reject:stop 标注）')
      // 端到端：creationDetail sideCards 出现 review 卡（对话页据此渲染审阅面板，消除 route 无法审批）
      const detail = await creationDetail(sess!.id)
      check((detail.sideCards as { key: string }[]).some((c) => c.key === 'review'), 'route run 审阅卡进 sideCards（对话页权威区可批）')
      // 端点通用安全：approve 委派 engine.approveGate（recipe 为 null 跳过对白交付校验），不抛 not_waiting
      const origApprove = engine.engine.approveGate.bind(engine.engine)
      const approved: Array<[number, string]> = []
      engine.engine.approveGate = (async (runId: number, stepKey: string): Promise<void> => { approved.push([runId, stepKey]) }) as typeof engine.engine.approveGate
      try {
        await decideCreationGate(sess!.id, { stepKey: 'compose', decision: 'approve', idempotencyKey: 'm64generic-gate-approve-1' })
        check(approved.length === 1 && approved[0]![0] === run!.id && approved[0]![1] === 'compose', '通用 run 闸门 approve 委派 engine.approveGate（端点本就按 stepKey 通用处理）')
      } finally { engine.engine.approveGate = origApprove }
    },
  }

  try {
    await runSections({ log, title: 'M64', checker, sections: SECTIONS, runners })
  } finally {
    engine.engine.startRun = origStart as typeof engine.engine.startRun
    envCleanup()
  }
}

void main()
