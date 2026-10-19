/**
 * M64 探针（智能创作 Agent 收口遗留：G2 confirmRoute 三形态运行链 + G3 synth 生命周期与 GC）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m64.ts [--section=confirm-template|confirm-synth|confirm-chain|guards|synth-gc]
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

const SECTIONS = ['confirm-template', 'confirm-synth', 'confirm-chain', 'guards', 'synth-gc'] as const

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
  const { creationMessages, creationSessions, pipelineRuns, projects, workflows } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { TEMPLATES_DIR } = await import('../src/env')
  const { app } = await import('../src/app')
  const { buildTemplateCatalog } = await import('../src/services/creation-chat/agent/template-catalog')
  const { normalizeAgentReply, decisionHashOf } = await import('../src/services/creation-chat/agent/normalize')
  const { confirmRoute } = await import('../src/services/creation-chat/route-execution')
  const { saveTemplate } = await import('../src/pipeline/loader')

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
  }

  try {
    await runSections({ log, title: 'M64', checker, sections: SECTIONS, runners })
  } finally {
    engine.engine.startRun = origStart as typeof engine.engine.startRun
    envCleanup()
  }
}

void main()
