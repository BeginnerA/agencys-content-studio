/**
 * AIGC合规标识探针（创作画布：执行快照冻结 + 预算硬闸）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m66-canvas-snap.ts [--section=snapshot|legacy|budget]
 *
 * 对应审查发现（契约一致性）：
 *   ① 画布执行未使用入队快照：startCanvasNodeRun 只在任务行冻结 prompt/params，真正执行时
 *      runCanvasTask 重读「当前节点 spec」、executeOnce 重读「当前连线」→ 排队期间改配置或
 *      改连线，计费执行的竟是另一份输入（并发槽位 ≤2，排队窗口可达分钟级）；
 *   ② 画布预算规则不一致：其余付费入口（run / 编排链 / 返修 / 重出）都过 checkBudget 硬闸，
 *      画布节点执行（单节点 + 批量）完全不过闸，run-preview 也只算价不拦。
 *
 * 修复后的安全属性（本探针逐条断言）：
 *   snapshot：入队 → 冻结 {spec, edges, plan} 快照落 gen_tasks.exec_snapshot；排队期间改 spec /
 *             换 prompt 端口连线 / 改上游文本节点内容，执行仍用入队那一刻的输入；
 *   legacy  ：存量任务行（exec_snapshot 为 NULL）回落实时读取，行为零突变；
 *   budget  ：已计价节点按「单价 × variants + 已花费」过 checkBudget，超限 → preflight problem +
 *             run 400 + 批量 skipped；未计价节点按 knownCost 口径放行（与创作会话同源）。
 *
 * 隔离：CSTUDIO_* 指向一次性临时目录（独立 studio.db + workspace）；fetch 全替换为可控延迟 stub
 * （零真实网络、零计费）。用「两个占槽任务」制造确定性的 pending 编辑窗口，再断言执行输入。
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { tmp: TMP, cleanup: envCleanup } = isolatedEnv('m66')

const SECTIONS = ['snapshot', 'legacy', 'budget'] as const

/** 占槽任务时长（ms）：足够长以保证目标任务在整个编辑窗口内保持 pending */
const SLOW_MS = 1_500

const stubFetch = (async (): Promise<Response> => {
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const origFetch = globalThis.fetch
  globalThis.fetch = stubFetch

  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { apiConfigs, canvases, genTasks, projects, settings, usageRecords } = await import('../src/db/schema')
  const { and, eq, inArray } = await import('drizzle-orm')
  const { app } = await import('../src/app')
  const { preflightNode, previewCanvasRun, startCanvasNodeRun, recoverCanvasTasks } = await import('../src/services/creation/gen')
  const { runCanvasNodes } = await import('../src/services/creation/ops')

  const log = createLogger('probe-m66')
  const checker: Checker = makeChecker(log)
  const check = checker.check
  const T0 = 1_700_000_000_000

  await initDb()

  // ---- 请求捕获（llm stub：延迟占槽 + 记录实际下发体） ----
  let captured: Array<{ url: string; body: unknown }> = []
  let delayMs = 0
  const installLlmStub = (): void => {
    globalThis.fetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (delayMs > 0) await sleep(delayMs)
      captured.push({ url: String(url), body })
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '【M66 stub】ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
  }

  // ---- 夹具工厂 ----
  const mkProject = async (name: string): Promise<number> =>
    (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id

  const jreq = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const res = await app.request(path, init)
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, body: json }
  }

  const statusOf = async (taskId: number): Promise<string> =>
    (await db.select({ status: genTasks.status }).from(genTasks).where(eq(genTasks.id, taskId)))[0]?.status ?? 'missing'

  const snapshotColOf = async (taskId: number): Promise<string | null> => {
    const rows = await db.select().from(genTasks).where(eq(genTasks.id, taskId))
    return (rows[0] as unknown as { execSnapshot?: string | null } | undefined)?.execSnapshot ?? null
  }

  const settleTasks = async (ids: number[]): Promise<Map<number, string>> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const rows = await db.select({ id: genTasks.id, status: genTasks.status }).from(genTasks).where(inArray(genTasks.id, ids))
      const m = new Map(rows.map((r) => [r.id, r.status]))
      if ([...m.values()].every((s) => s === 'succeeded' || s === 'failed' || s === 'cancelled')) return m
      if (Date.now() > deadline) return m
      await sleep(250)
    }
  }

  /** 探针 LLM 实例（stub 端点；llm 节点可执行且请求体可断言） */
  const addLlmInstance = async (): Promise<void> => {
    await db.insert(apiConfigs).values({
      providerKey: 'probe-m66-llm',
      serviceType: 'llm',
      name: 'M66 LLM',
      baseUrl: 'https://probe.invalid/v1',
      apiKeyRef: 'env:PROBE_M66_LLM_KEY',
      model: 'probe-model',
      priority: 0,
      isDefault: 1,
      isActive: 1,
      createdAt: T0,
      updatedAt: T0,
    })
    process.env.PROBE_M66_LLM_KEY = 'probe-key-m66'
  }

  /** 占满两个并发槽（后续入队任务被迫排队 → 制造编辑窗口） */
  const occupySlots = async (canvasId: number): Promise<number[]> => {
    const blocker = (await mkNode(canvasId, { genKind: 'llm', prompt: 'M66-BLOCKER' })).id
    const r = await startCanvasNodeRun(blocker, 2)
    await sleep(120) // 让两个 blocker 任务真正占槽
    return r.taskIds
  }

  const mkCanvasOf = async (projectId: number): Promise<number> =>
    (await jreq('POST', `/api/v1/projects/${projectId}/canvases`, { name: 'M66 画布' })).body.canvas.id

  const mkNode = async (canvasId: number, spec: Record<string, unknown>, kind = 'gen'): Promise<{ id: number }> => {
    const res = await jreq('POST', `/api/v1/canvases/${canvasId}/nodes`, { kind, spec, x: 0, y: 0 })
    if (!res.body?.node?.id) throw new Error(`建节点失败：${JSON.stringify(res.body)}`)
    return res.body.node
  }

  const mkTextNode = async (canvasId: number, text: string): Promise<{ id: number }> => mkNode(canvasId, { text }, 'text')

  const mkEdge = async (canvasId: number, from: number, to: number, port: string): Promise<number> =>
    (await jreq('POST', `/api/v1/canvases/${canvasId}/edges`, { from, to, port })).body.edge.id

  const has = (marker: string): boolean => captured.some((r) => JSON.stringify(r.body).includes(marker))

  // ================= snapshot：入队快照冻结 =================
  const runSnapshot = async (): Promise<void> => {
    captured = []
    delayMs = SLOW_MS
    installLlmStub()
    await addLlmInstance()
    const PID = await mkProject('M66 快照')
    const C = await mkCanvasOf(PID)

    // 三个目标：spec 文本 / prompt 端口连线 / 上游文本节点内容
    const T1 = await mkNode(C, { genKind: 'llm', prompt: 'SNAP-ORIG-PROMPT' })
    const T2 = await mkNode(C, { genKind: 'llm', prompt: 'SNAP-UNUSED' })
    const TA = await mkTextNode(C, '冻结前端口文本')
    const TB = await mkTextNode(C, '冻结后端口文本')
    const E1 = await mkEdge(C, TA.id, T2.id, 'prompt')
    const T3 = await mkNode(C, { genKind: 'llm', prompt: 'SNAP-UNUSED-3' })
    const TC = await mkTextNode(C, '编辑前文本')
    await mkEdge(C, TC.id, T3.id, 'prompt')

    const blockers = await occupySlots(C)
    const r1 = await startCanvasNodeRun(T1.id)
    const r2 = await startCanvasNodeRun(T2.id)
    const r3 = await startCanvasNodeRun(T3.id)
    const ids = [...r1.taskIds, ...r2.taskIds, ...r3.taskIds]

    // 编辑窗口：三个目标必须仍在排队（否则本节的时序前提不成立）
    const pending = (await Promise.all(ids.map(statusOf))).every((s) => s === 'pending')
    check(pending, '并发槽位被占满 → 目标任务保持 pending（编辑窗口成立）')

    // 入队即冻结：任务行落 exec_snapshot（spec/edges/plan 三段齐备）
    const snapRaw = await snapshotColOf(r1.taskIds[0]!)
    const snap = snapRaw ? (JSON.parse(snapRaw) as Record<string, unknown>) : null
    check(
      !!snap && JSON.stringify(snap['spec']).includes('SNAP-ORIG-PROMPT') && Array.isArray(snap['edges']) && !!snap['plan'],
      '入队冻结：exec_snapshot = {spec, edges, plan}',
    )

    // 排队期间三种「改主意」：改节点 spec / 换 prompt 端口连线 / 改上游文本内容
    const p1 = await jreq('PATCH', `/api/v1/nodes/${T1.id}`, { spec: { genKind: 'llm', prompt: 'SNAP-EDITED-PROMPT' } })
    await jreq('DELETE', `/api/v1/edges/${E1}`)
    await mkEdge(C, TB.id, T2.id, 'prompt')
    await jreq('PATCH', `/api/v1/nodes/${TC.id}`, { spec: { text: '编辑后文本' } })
    check(p1.status === 200, '排队期间节点/文本编辑落库（前提：编辑确实发生在执行之前）')
    check(
      (await Promise.all(ids.map(statusOf))).every((s) => s === 'pending'),
      '编辑完成时任务仍在排队（时序前提：三次编辑均先于执行）',
    )

    const st = await settleTasks(ids)
    const st2 = await settleTasks(blockers)
    check(
      st.get(r1.taskIds[0]!) === 'succeeded' && st.get(r2.taskIds[0]!) === 'succeeded' && st.get(r3.taskIds[0]!) === 'succeeded' && st2.size === 2,
      '排队任务在槽位释放后全部执行完成（stub 端点）',
    )
    check(has('SNAP-ORIG-PROMPT') && !has('SNAP-EDITED-PROMPT'), '快照冻结：改 spec.prompt 不影响已入队任务的真实输入')
    check(has('冻结前端口文本') && !has('冻结后端口文本'), '快照冻结：换 prompt 端口连线不影响已入队任务的真实输入')
    check(has('编辑前文本') && !has('编辑后文本'), '快照冻结：改上游文本节点内容不影响已入队任务的真实输入')

    // 快照消费后仍可正常出产物 + 用量（不因冻结而丢落库）
    const outs = await db.select().from(usageRecords).where(eq(usageRecords.projectId, PID))
    check(outs.length > 0, '快照执行仍记录用量（计费链未断）')

    // 并发执行互不串快照：阻塞节点自身用其原 spec
    check(has('M66-BLOCKER'), '占槽任务使用自身输入（快照互不污染）')

    await db.delete(apiConfigs).where(and(eq(apiConfigs.providerKey, 'probe-m66-llm'), eq(apiConfigs.serviceType, 'llm')))
    delete process.env.PROBE_M66_LLM_KEY
    delayMs = 0
    globalThis.fetch = stubFetch
  }

  // ================= legacy：无快照回落实时读取 =================
  const runLegacy = async (): Promise<void> => {
    captured = []
    delayMs = SLOW_MS
    installLlmStub()
    await addLlmInstance()
    const PID = await mkProject('M66 存量兼容')
    const C = await mkCanvasOf(PID)
    const T = await mkNode(C, { genKind: 'llm', prompt: 'LEGACY-ORIG' })
    const blockers = await occupySlots(C)
    const r = await startCanvasNodeRun(T.id)
    check((await statusOf(r.taskId)) === 'pending', '存量模拟前提：任务仍在排队')

    // 抹掉快照列 = 迁移前的历史任务行形态
    await db.update(genTasks).set({ execSnapshot: null }).where(eq(genTasks.id, r.taskId))
    check((await snapshotColOf(r.taskId)) === null, '任务行 exec_snapshot 已置空（存量形态）')

    await jreq('PATCH', `/api/v1/nodes/${T.id}`, { spec: { genKind: 'llm', prompt: 'LEGACY-LIVE-EDITED' } })
    const st = await settleTasks([r.taskId])
    await settleTasks(blockers)
    check(st.get(r.taskId) === 'succeeded', '存量任务（无快照）仍执行成功（未因缺列炸队列）')
    check(has('LEGACY-LIVE-EDITED') && !has('LEGACY-ORIG'), '存量回退：无快照 → 按当前节点配置实时读取（行为零突变）')

    await db.delete(apiConfigs).where(and(eq(apiConfigs.providerKey, 'probe-m66-llm'), eq(apiConfigs.serviceType, 'llm')))
    delete process.env.PROBE_M66_LLM_KEY
    delayMs = 0
    globalThis.fetch = stubFetch
  }

  // ================= budget：画布执行预算硬闸 =================
  const runBudget = async (): Promise<void> => {
    const PID = await mkProject('M66 预算')
    const C = await mkCanvasOf(PID)
    const N = await mkNode(C, { genKind: 'image', prompt: 'BUDGET-IMAGE', provider: 'probe-img', model: 'm1' })

    const setSetting = async (key: string, value: unknown): Promise<void> => {
      const exist = await db.select({ id: settings.id }).from(settings).where(eq(settings.key, key)).limit(1)
      if (exist[0]) await db.update(settings).set({ value: JSON.stringify(value), updatedAt: T0 }).where(eq(settings.id, exist[0].id))
      else await db.insert(settings).values({ key, value: JSON.stringify(value), updatedAt: T0 })
    }
    const canvasRow = (await db.select().from(canvases).where(eq(canvases.id, C)))[0]!
    const preview = async (): Promise<any> => (await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: [N.id] })).body
    const taskCount = async (): Promise<number> =>
      Number((await db.select({ id: genTasks.id }).from(genTasks).where(eq(genTasks.canvasNodeId, N.id))).length)

    // 单价：5 元/张（全局 pricing 兜底：{ image: { 'probe-img:m1': { image: 5 } } }）
    await setSetting('pricing', { image: { 'probe-img:m1': { image: 5 } } })
    const est = await previewCanvasRun(canvasRow, [N.id])
    check(est.nodes[0]!.units[0]!.unitPrice === 5 && est.nodes[0]!.total === 5, '预估单价：image 5 元/张（resolveUnitPrice 同源）')

    // 预算 3 元 → 单节点（5 元）超限：run 400 + preflight problem + 预估标记 blocked，且不建任务
    await setSetting('budgets', { projects: { [String(PID)]: { total: 3 } } })
    const pf = await preflightNode(N.id)
    check(pf.problems.some((p) => p.includes('预算')) === true, '预算超限：preflightNode problems 含预算拦截')
    const runRes = await jreq('POST', `/api/v1/nodes/${N.id}/run`, {})
    check(runRes.status === 400 && String(runRes.body?.error?.message ?? '').includes('预算'), '预算超限：单节点 run → 400 附预算文案')
    check((await taskCount()) === 0, '预算超限：零任务入队（未建任务即未计费）')
    const pv = await preview()
    check(pv.nodes[0].ready === false && pv.nodes[0].problems.some((p: string) => p.includes('预算')) === true, '预算超限：run-preview 标记未就绪 + 原因')
    check(pv.total.blocked >= 1 && pv.total.amount === 5, '预算超限：预估仍展示金额（blocked 计数含该节点）')

    // variants 放大：预算 12（单发 5 通过 / 3 连发 15 超限）
    await setSetting('budgets', { projects: { [String(PID)]: { total: 12 } } })
    check((await preflightNode(N.id)).problems.some((p) => p.includes('预算')) === false, '预算 12：单发（5 元）放行')
    check((await preflightNode(N.id, 2)).problems.some((p) => p.includes('预算')) === false, '预算 12：×2（10 元）放行')
    const pf4 = await preflightNode(N.id, 3)
    check(pf4.problems.some((p) => p.includes('预算')) === true, '预算 12：×3（15 元）拦截（按 variants 放大预计成本）')

    // 已花费计入：预算 20、已花 18 + 本次 5 → 拦截（与其余付费入口同源 spend 查询）
    await setSetting('budgets', { projects: { [String(PID)]: { total: 20 } } })
    check((await preflightNode(N.id)).problems.some((p) => p.includes('预算')) === false, '预算 20：已花 0 + 本次 5 放行')
    await db.insert(usageRecords).values({
      projectId: PID,
      runId: null,
      stepId: null,
      taskId: null,
      assetId: null,
      kind: 'image',
      provider: 'probe-img',
      model: 'm1',
      quantity: 1,
      unit: 'image',
      unitPrice: 18,
      cost: 18,
      currency: 'CNY',
      meta: '{}',
      createdAt: T0,
    })
    check((await preflightNode(N.id)).problems.some((p) => p.includes('预算')) === true, '预算 20：已花 18 + 本次 5 → 拦截（spend 感知）')
    const batch = await runCanvasNodes(canvasRow, { nodeIds: [N.id] })
    check(batch.started.length === 0 && batch.skipped.some((s) => s.problems.join('').includes('预算')), '预算超限：批量执行 skipped 附预算原因')

    // 未计价节点按 knownCost 口径放行（与创作会话一致：无法预估 ≠ 拒绝执行）
    await setSetting('budgets', { projects: { [String(PID)]: { total: 1 } } })
    const L = await mkNode(C, { genKind: 'llm', prompt: 'UNPRICED-LLM' })
    const pfL = await preflightNode(L.id)
    check(pfL.problems.some((p) => p.includes('预算')) === false, '未计价节点（llm tokens 不可预知）：预算闸按 knownCost 放行')

    await db.delete(settings).where(inArray(settings.key, ['pricing', 'budgets']))
    await db.delete(usageRecords).where(eq(usageRecords.projectId, PID))
  }

  const runners: Record<string, () => Promise<void>> = {
    snapshot: runSnapshot,
    legacy: runLegacy,
    budget: runBudget,
  }

  await runSections({
    log,
    title: 'M66 画布执行快照/预算闸',
    checker,
    sections: SECTIONS,
    runners,
    cleanup: async () => {
      globalThis.fetch = origFetch
      try {
        await recoverCanvasTasks()
      } catch {
        /* 收尾复位尽力而为 */
      }
      try {
        sqlite.close()
      } catch {
        /* 句柄已由 libsql 持有 */
      }
      try {
        envCleanup()
      } catch {
        console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
      }
    },
  })
}

void main()
