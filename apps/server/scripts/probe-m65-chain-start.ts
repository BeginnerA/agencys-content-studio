/**
 * M65 附加探针（编排链启动事务与恢复边界，CodeReview P1#8）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m65-chain-start.ts [--section=gate-fail|launch-fault|reconcile-adopt|reconcile-release|reconcile-planning]
 *
 * 背景：旧 startChain 全程非事务（会话先 starting → 建链 → 起首段 → 最后回写关联），
 * createWorkflow 又位于恢复用 try 之外 → 建链异常会遗留 starting；起段成功后崩溃会出现
 * 「链与 run 已在库、会话仍未绑定」的孤儿运行，用户再确认即二次建链二次计费。
 *
 * 本探针用 isolatedEnv('m65-chain') 起独立临时库（桥接只读模板/提示词目录），打桩 engine.startRun
 * 阻断真实媒体执行（零网络/零计费），断言三条安全性质：
 *   ① 任一环节失败 → 事务原子回滚：无孤儿链、无孤儿 run、会话不滞留 starting、零启动；
 *   ② 提交后启动失败（模拟进程崩溃）→ 已持久化的立项结果不被推翻，会话已绑 workflowId+runId，
 *      首段 run 以 queued 留在库里交由既有 queued 恢复/全局泵兜底，重复确认命中同 runId（不二次计费）；
 *   ③ 启动对账 reconcileCreationSessions 依据持久关联核对 starting 会话：有 run → 认领（不新建、不起跑）；
 *      无 run → 释放（作废未启动的草稿链，会话回 ready 让用户显式再确认），全程零计费零启动。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m65-chain', { bridge: ['templates', 'prompts'] })

const SECTIONS = ['gate-fail', 'launch-fault', 'reconcile-adopt', 'reconcile-release', 'reconcile-planning'] as const

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m65-chain')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const { db, initDb } = await import('../src/db')
  const { creationMessages, creationSessions, pipelineRuns, projects, workflows } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { engine, recoverInterruptedState } = await import('../src/pipeline/engine')
  const { buildTemplateCatalog } = await import('../src/services/creation-chat/agent/template-catalog')
  const { normalizeAgentReply, decisionHashOf } = await import('../src/services/creation-chat/agent/normalize')
  const { confirmRoute } = await import('../src/services/creation-chat/route-execution')
  const { reconcileCreationSessions } = await import('../src/services/creation-chat/store')

  await initDb()
  const catalog = buildTemplateCatalog()
  const MONTAGE = 'photo-montage' // 必填输入 0 项 → 空输入即可起首段
  const NOTE = 'note-clip' // 必填 topic → 未物化即段输入阻塞
  const QUICK = 'quick-video' // 必填 idea
  check([MONTAGE, NOTE, QUICK].every((k) => catalog.some((t) => t.key === k)), `模板目录桥接到位（${catalog.length} 项，含 ${MONTAGE}/${NOTE}/${QUICK}）`)
  const montageRequired = (catalog.find((t) => t.key === MONTAGE)?.inputs ?? []).filter((i) => i.required).length
  check(montageRequired === 0, `链首段基准 ${MONTAGE} 必填输入 ${montageRequired} 项（空输入可起段）`)

  // 打桩 engine.startRun：只记录不执行（零网络/零计费）；throwNextStart 模拟「提交后启动瞬间崩溃」
  const startedIds: number[] = []
  let throwNextStart = false
  engine.startRun = ((runId: number): 'started' => {
    if (throwNextStart) {
      throwNextStart = false
      throw new Error('模拟启动瞬间进程异常')
    }
    startedIds.push(runId)
    return 'started'
  }) as typeof engine.startRun

  const seedProject = async (name: string): Promise<number> => {
    const t = Date.now()
    const [p] = await db.insert(projects).values({ name, genre: 'other', templateKey: QUICK, status: 'draft', brief: name, tags: JSON.stringify(['智能创作']), createdAt: t, updatedAt: t }).returning()
    return p!.id
  }
  /** 直插 agent 待确认会话（decision = normalizeAgentReply 权威归一产物），返回确认闸所需三元组 */
  const seedRouteSession = async (projectId: number, reply: Record<string, unknown>): Promise<{ sessionId: number; decisionHash: string }> => {
    const t = Date.now()
    const key = `m65cs${t}${Math.random().toString(36).slice(2, 7)}`
    await db.insert(creationSessions).values({ projectId, requestKey: key, status: 'draft', planRevision: 0, runHistory: '[]', createdAt: t, updatedAt: t })
    const [s] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
    const sid = s!.id
    const decision = normalizeAgentReply(reply as never, catalog, { sessionId: sid, allowedAssetIds: new Set<number>() })!
    const hash = decisionHashOf(decision)
    await db.update(creationSessions).set({ status: 'ready', agentMode: 1, decision: JSON.stringify(decision), decisionHash: hash, planRevision: 1, updatedAt: Date.now() }).where(eq(creationSessions.id, sid))
    return { sessionId: sid, decisionHash: hash }
  }
  /** 直插任意控制态会话（对账分节复刻崩溃残留，不走确认链） */
  const seedRawSession = async (projectId: number, status: string, over: Record<string, unknown> = {}): Promise<number> => {
    const t = Date.now()
    const [s] = await db.insert(creationSessions).values({ projectId, requestKey: `m65raw${t}${Math.random().toString(36).slice(2, 7)}`, status, planRevision: 1, runHistory: '[]', agentMode: 1, decision: null, createdAt: t, updatedAt: t, ...over }).returning()
    return s!.id
  }
  const confirmReq = (decisionHash: string, ikey: string) => ({ decisionRevision: 1, decisionHash, idempotencyKey: ikey, acceptUnpriced: false })
  const sessionOf = async (id: number) => (await db.select().from(creationSessions).where(eq(creationSessions.id, id)))[0]!
  const chainOf = async (id: number) => (await db.select().from(workflows).where(eq(workflows.id, id)))[0] ?? null
  const rowCount = async (pid: number) => (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, pid))).length
  const wfCount = async (pid: number) => (await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.projectId, pid))).length
  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); return 'none' } catch (err) { return err && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'other' }
  }

  const runners: Record<string, () => Promise<void>> = {
    // ================= gate-fail：段输入闸失败 → 事务原子回滚，不留孤儿链 =================
    'gate-fail': async () => {
      const proj = await seedProject('链首段必填缺失')
      const { sessionId, decisionHash } = await seedRouteSession(proj, {
        kind: 'route', mode: 'chain', message: '先做笔记再混剪', rationale: '多步任务', roleKey: 'planner',
        chain: [{ templateKey: NOTE }, { templateKey: MONTAGE }], // 首段 note-clip 必填 topic 未物化
      })
      const before = startedIds.length
      const code = await codeOf(() => confirmRoute(sessionId, confirmReq(decisionHash, 'm65gatefail00001')))
      const s = await sessionOf(sessionId)
      check(code === 'bad_input', `链首段必填未满足 → 可见拒绝 bad_input（实得：${code}）`)
      check(s.status !== 'starting', `失败后会话不滞留 starting（实得：${s.status}）`)
      check(s.status === 'ready', '失败后会话回 ready，可原决策重新确认')
      check((await wfCount(proj)) === 0 && (await rowCount(proj)) === 0 && startedIds.length === before, '失败后无孤儿链、无孤儿 run、零启动（同事务原子回滚）')
      check(s.workflowId == null && s.runId == null, '失败后会话不残留半截关联（workflowId/runId 皆空）')
    },

    // ================= launch-fault：提交后启动崩溃 → 立项不被推翻 + 关联已持久 + 幂等不二次计费 =================
    'launch-fault': async () => {
      const proj = await seedProject('首段启动瞬间崩溃')
      const { sessionId, decisionHash } = await seedRouteSession(proj, {
        kind: 'route', mode: 'chain', message: '先混剪再成稿', rationale: '多步任务', roleKey: 'planner',
        chain: [{ templateKey: MONTAGE }, { templateKey: NOTE, inputSpec: { topic: { kind: 'text', value: '崩溃后恢复' } } }],
      })
      const before = startedIds.length
      throwNextStart = true // 模拟「记录已落库、拉起执行瞬间进程异常」
      let res: { runId: number; workflowId?: number } | null = null
      let fail = ''
      try {
        res = await confirmRoute(sessionId, confirmReq(decisionHash, 'm65launchfault001'))
      } catch (err) {
        fail = err instanceof Error ? err.message : String(err)
      }
      const s = await sessionOf(sessionId)
      check(res !== null, `提交后启动失败不推翻已持久化立项（确认应返回 runId；实得：${fail || 'ok'}）`)
      check(s.status === 'started' && s.runId != null && s.workflowId != null, `会话与链/run 同事务绑定（status=${s.status} workflowId=${s.workflowId} runId=${s.runId}）`)
      const wf = s.workflowId == null ? null : await chainOf(s.workflowId)
      check(!!wf && wf.status === 'active', `链状态随事务置 active，崩溃窗口不留 draft（实得：${wf?.status ?? '链不存在'}）`)
      const segRuns = await db.select({ id: pipelineRuns.id, seq: pipelineRuns.workflowSeq, status: pipelineRuns.status, wfId: pipelineRuns.workflowId }).from(pipelineRuns).where(eq(pipelineRuns.projectId, proj))
      check(segRuns.length === 1 && segRuns[0]!.seq === 0 && segRuns[0]!.status === 'queued' && segRuns[0]!.wfId === wf?.id, `首段 run 以 queued 落库并带链关联（${segRuns.length} 段：${segRuns.map((r) => `${r.seq}/${r.status}`).join(',')}）`)
      check(startedIds.length === before && (await wfCount(proj)) === 1, '本次仅建一条链、零成功启动（崩溃未被掩盖成已启动）')
      // 幂等：同 key 再确认必须命中既有 runId，绝不二次建链二次计费
      const again = await confirmRoute(sessionId, confirmReq(decisionHash, 'm65launchfault001'))
      const s2 = await sessionOf(sessionId)
      check(again.runId === s.runId && (await wfCount(proj)) === 1 && (await rowCount(proj)) === 1, `重复确认命中既有 run（runId=${again.runId}），不二次建链/建 run`)
      check(s2.status === 'started' && startedIds.length === before, '重复确认不再拉起执行')
      // 兜底：queued 恢复路径能把这条已提交的 run 重新入队（不新建、不改链关联）
      const { requeued } = await recoverInterruptedState()
      check(s.runId != null && requeued.includes(s.runId), `queued 恢复路径覆盖该 run（requeued ${requeued.length} 条），崩溃后由泵兜底而非重跑立项`)
    },

    // ================= reconcile-adopt：starting + 关联已有 run → 认领，绝不新建/起跑 =================
    'reconcile-adopt': async () => {
      const proj = await seedProject('崩溃残留·链已起段')
      const t = Date.now()
      const { sessionId: sid } = await seedRouteSession(proj, {
        kind: 'route', mode: 'chain', message: 'm', rationale: 'r', roleKey: 'planner',
        chain: [{ templateKey: MONTAGE }, { templateKey: NOTE, inputSpec: { topic: { kind: 'text', value: '认领复核' } } }],
      })
      const [wf] = await db.insert(workflows).values({ projectId: proj, name: '崩溃残留链', status: 'active', autoAdvance: 0, segments: JSON.stringify([{ templateKey: MONTAGE }, { templateKey: NOTE }]), createdAt: t, updatedAt: t }).returning()
      const [run] = await db.insert(pipelineRuns).values({ projectId: proj, templateKey: MONTAGE, status: 'queued', input: '{}', workflowId: wf!.id, workflowSeq: 0, createdAt: t, updatedAt: t }).returning()
      await db.update(creationSessions).set({ status: 'starting', workflowId: wf!.id, startKey: 'm65reconcileadopt' }).where(eq(creationSessions.id, sid))
      const before = startedIds.length
      await reconcileCreationSessions()
      const s = await sessionOf(sid)
      check(s.status === 'started' && s.runId === run!.id && s.workflowId === wf!.id, `starting 按持久关联认领既有首段 run（status=${s.status} runId=${s.runId}）`)
      check((await rowCount(proj)) === 1 && (await wfCount(proj)) === 1 && startedIds.length === before, '对账不建 run、不建链、不拉起执行（零计费零网络）')
      const [wf2] = await db.select().from(workflows).where(eq(workflows.id, wf!.id))
      check(wf2!.status === 'active', '认领不改链状态（后续段推进仍由既有 orchestrator 负责）')
      const msgs = await db.select({ content: creationMessages.content }).from(creationMessages).where(eq(creationMessages.sessionId, sid))
      check(msgs.some((m) => /重启|恢复|认领/.test(m.content)), '对账结果向对话写回可见留痕（不静默改态）')
      // 认领后再确认走 runId 早退：命中同 run，不再建第二条链
      const again = await confirmRoute(sid, confirmReq('a'.repeat(64), 'm65adoptreconfirm1'))
      check(again.runId === run!.id && (await wfCount(proj)) === 1 && (await rowCount(proj)) === 1, '认领后再确认命中既有 run（不二次建链/建 run）')
    },

    // ================= reconcile-release：starting + 关联无 run → 释放确认闸，作废未启动草稿链 =================
    'reconcile-release': async () => {
      const proj = await seedProject('崩溃残留·链未起段')
      const t = Date.now()
      const { sessionId: sid } = await seedRouteSession(proj, {
        kind: 'route', mode: 'chain', message: 'm', rationale: 'r', roleKey: 'planner',
        chain: [{ templateKey: MONTAGE }, { templateKey: NOTE, inputSpec: { topic: { kind: 'text', value: '释放复核' } } }],
      })
      const [wf] = await db.insert(workflows).values({ projectId: proj, name: '未启动草稿链', status: 'draft', autoAdvance: 0, segments: JSON.stringify([{ templateKey: MONTAGE }, { templateKey: NOTE }]), createdAt: t, updatedAt: t }).returning()
      await db.update(creationSessions).set({ status: 'starting', workflowId: wf!.id, startKey: 'm65reconcilerelease' }).where(eq(creationSessions.id, sid))
      const before = startedIds.length
      await reconcileCreationSessions()
      const s = await sessionOf(sid)
      check(s.status !== 'starting', `无 run 可认领的 starting 必须释放（实得：${s.status}）`)
      check(s.status === 'ready', '释回到 ready：原决策仍在，由用户显式再确认（对账不替用户点确认）')
      const [wf2] = await db.select().from(workflows).where(eq(workflows.id, wf!.id))
      check(wf2!.status === 'cancelled', '未启动的草稿链作废，避免与再确认新建的链并存双计')
      check((await rowCount(proj)) === 0 && startedIds.length === before, '释放路径零建 run、零启动')
      const msgs = await db.select({ content: creationMessages.content }).from(creationMessages).where(eq(creationMessages.sessionId, sid))
      check(msgs.some((m) => /重启|恢复|确认/.test(m.content)), '释放同样留痕（用户能看到为什么）')
      // 无关联可核的 starting（旧版崩溃残留）：不得永久锁死会话
      const proj2 = await seedProject('崩溃残留·无关联')
      const sid2 = await seedRawSession(proj2, 'starting', { decision: JSON.stringify({ mode: 'chain' }), startKey: 'm65reconcilenull' })
      await reconcileCreationSessions()
      const s3 = await sessionOf(sid2)
      check(s3.status !== 'starting', `无任何持久关联的 starting 也须解锁（实得：${s3.status}）`)
      check(/核验|核对/.test(s3.error ?? ''), '无关联时在 error 里明示「可能已计费，请核验」，不静默放行')
    },

    // ================= reconcile-planning：既有 planning→draft 语义零回归 =================
    'reconcile-planning': async () => {
      const proj = await seedProject('规划中被重启打断')
      const sid = await seedRawSession(proj, 'planning', { planRevision: 3 })
      const before = startedIds.length
      await reconcileCreationSessions()
      const s = await sessionOf(sid)
      check(s.status === 'draft' && /重启中断/.test(s.error ?? '') && s.preflight == null, 'planning → draft + 中断留痕（原语义逐字不变）')
      check(startedIds.length === before, '规划对账同样零启动')
    },
  }

  await runSections({ log, title: 'M65 编排链启动事务', checker, sections: SECTIONS, runners, cleanup })
}

void main()
