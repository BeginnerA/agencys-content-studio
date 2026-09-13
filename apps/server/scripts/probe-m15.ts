/**
 * M15 探针（流水线画布工作台：依赖共享语义 / 运行画布读模型 / 模板画布 / 回归）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m15.ts [--section=dag|canvas-run|canvas-template|regression]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录（独立 studio.db +
 * workspace），不触碰开发库（同 probe-m2a~m14）。LLM 假端点 + globalThis.fetch stub 兜底（零网络、零计费）。
 * 本探针不真跑流水线：run/steps/tasks 全部手工落库构造（确定性状态矩阵），画布纯读不触发引擎。
 * 模板文件从仓库 workspace/templates 复制进隔离目录（loadTemplate 读隔离 TEMPLATES_DIR）。
 *
 * section（默认 all）：
 *   dag             stepDeps / stepDepEdges 矩阵：真模板不变式与逐点对拍（write_script 缺省前一步 /
 *                   sync_characters after 多值 / compose_video after 5 值 / 首步）+ 来源标注（default/after）+
 *                   自造矩阵（after 去重·排除自身·空数显式无依赖 / when·when_any·gate.when 隐含 /
 *                   坏表达式吞错 / after+when 同键首见优先 / 缺省前一步与 when 混合顺序）
 *   canvas-run      GET /runs/:id/canvas HTTP 全链：404 / 节点序与字段映射（状态·耗时·attempts·assetIds·
 *                   gateTrace·skippedReason·gate 内插）/ 边集合与单源真值对拍（含 sched+data 混合边与
 *                   origin）/ 操作可用性真值矩阵（rerun 门禁·recompose 限定 ffmpeg_merge·gate 三决策·
 *                   taskRetry 计数与 run 状态约束·runActions）/ 与 checkRepairable 双源对拍 /
 *                   宽容降级（模板不可得 → 仅按行渲染；孤儿行追加；坏快照回退文件）
 *   canvas-template GET /templates/:key/canvas：404 / 节点 def 静态字段对拍（gate/when/after/batch/output）+
 *                   gate 摘要（skipLabel/when）/ inputsRefs 四形态扫描 / 边集合对拍 / 无运行字段
 *   regression      probe:m2a / m4 / m14 子进程全绿（m14 内含 m7-m13：引擎调度语义与全链零漂移）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PipelineRun, PipelineStep } from '../src/db/schema'
import type { Template, TemplateStepDef } from '../src/pipeline/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留（Windows libsql 文件句柄不释放 → 本进程退出时 db 文件必留；下次运行自动清理）
const TMP_PREFIX = 'acs-probe-m15-'
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith(TMP_PREFIX)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
    } catch {
      /* 占用中（并行探针）→ 跳过 */
    }
  }
}
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
// LLM 假端点（fetch stub 拦截，不外发）；env.ts 在模块加载时读取 → 必须先行设置
process.env.AGENT_LLM_BASE_URL = 'http://probe-m15.local/v1'
process.env.AGENT_LLM_API_KEY = 'probe-key'
process.env.AGENT_LLM_MODEL = 'probe-model-m15'
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['dag', 'canvas-run', 'canvas-template', 'regression'] as const

// ---- fetch stub：兜底安全网（本探针无真实外发请求）----
const stubFetch = (async (): Promise<Response> => {
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

async function main(): Promise<void> {
  const origFetch = globalThis.fetch
  globalThis.fetch = stubFetch

  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { genTasks, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { loadTemplate } = await import('../src/pipeline/loader')
  const { stepDepEdges, stepDeps } = await import('../src/pipeline/dag')
  const { app } = await import('../src/app')

  // 模板文件就位（隔离 workspace；loadTemplate 读隔离 TEMPLATES_DIR）
  const TPL_SRC = join(REPO_ROOT, 'workspace', 'templates')
  const TPL_DST = join(process.env.CSTUDIO_WORKSPACE!, 'templates')
  mkdirSync(TPL_DST, { recursive: true })
  for (const f of readdirSync(TPL_SRC)) {
    if (/\.ya?ml$/.test(f)) cpSync(join(TPL_SRC, f), join(TPL_DST, f))
  }
  const tpl = loadTemplate('mengbao-episode')
  const TPL_JSON = JSON.stringify(tpl)

  const log = createLogger('probe-m15')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }

  // ---- setup：隔离库 + 种子工厂 ----
  await initDb()
  const T0 = 1_700_000_000_000

  const mkProject = async (name: string): Promise<number> =>
    (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id

  const PID = await mkProject('M15 画布探针')

  const mkRun = async (
    opts: { status?: string; templateKey?: string; snapshot?: string | null; input?: Record<string, unknown> } = {},
  ): Promise<PipelineRun> =>
    (
      await db
        .insert(pipelineRuns)
        .values({
          projectId: PID,
          templateKey: opts.templateKey ?? 'mengbao-episode',
          status: opts.status ?? 'queued',
          input: JSON.stringify(opts.input ?? { brief: 'M15 画布探针', episode_number: 1 }),
          templateSnapshot: opts.snapshot === undefined ? TPL_JSON : opts.snapshot,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!

  /** 按真模板全量落 steps 行（固定初始状态） */
  const mkSteps = async (runId: number, status = 'pending'): Promise<Map<string, PipelineStep>> => {
    const map = new Map<string, PipelineStep>()
    for (let i = 0; i < tpl.steps.length; i++) {
      const d = tpl.steps[i]!
      const row = (
        await db
          .insert(pipelineSteps)
          .values({
            runId,
            seq: i,
            stepKey: d.key,
            actionKey: d.action,
            title: d.title,
            status,
            attempts: 0,
            createdAt: T0,
            updatedAt: T0,
          })
          .returning()
      )[0]!
      map.set(d.key, row)
    }
    return map
  }

  const updStep = async (id: number, patch: Record<string, unknown>): Promise<void> => {
    await db
      .update(pipelineSteps)
      .set({ ...(patch as object), updatedAt: T0 } as never)
      .where(eq(pipelineSteps.id, id))
  }
  const updRun = async (id: number, patch: Record<string, unknown>): Promise<void> => {
    await db
      .update(pipelineRuns)
      .set({ ...(patch as object), updatedAt: T0 } as never)
      .where(eq(pipelineRuns.id, id))
  }
  const mkTask = async (runId: number, stepId: number, status: string): Promise<void> => {
    await db.insert(genTasks).values({ projectId: PID, runId, stepId, kind: 'image', params: '{}', status, createdAt: T0, updatedAt: T0 })
  }

  /** app.request 内存 HTTP（零网络）：返回状态码 + JSON body */
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
      /* 非 JSON 响应 */
    }
    return { status: res.status, body: json }
  }

  // ---- 画布断言小工具 ----
  const nodeOf = (body: any, key: string): any => (Array.isArray(body?.nodes) ? body.nodes : []).find((n: any) => n.key === key)
  const edgeOf = (body: any, from: string, to: string, type: string): any =>
    (Array.isArray(body?.edges) ? body.edges : []).find((e: any) => e.from === from && e.to === to && e.type === type)
  const canvasEdgeSet = (body: any): Set<string> =>
    new Set((Array.isArray(body?.edges) ? body.edges : []).map((e: any) => `${e.from}|${e.to}|${e.type}`))

  /** 本地独立扫描 def.inputs 的 steps.x.asset(s) 整串引用（对拍画布 data 边） */
  const localStepRefs = (inputs: Record<string, unknown>): string[] => {
    const out: string[] = []
    const scan = (v: unknown): void => {
      if (typeof v === 'string') {
        const m = /^steps\.([\w-]+)\.(asset|assets)$/.exec(v)
        if (m) out.push(m[1]!)
        return
      }
      if (Array.isArray(v)) {
        for (const item of v) scan(item)
        return
      }
      if (v && typeof v === 'object') {
        for (const val of Object.values(v as Record<string, unknown>)) scan(val)
      }
    }
    for (const v of Object.values(inputs)) scan(v)
    return out
  }

  /** 期望边集合（sched 走共享 stepDepEdges + data 本地扫描 → 与 HTTP 返回对拍） */
  const expectedEdges = (template: Template): Set<string> => {
    const orderByKey = new Map(template.steps.map((d, i) => [d.key, i]))
    const out = new Set<string>()
    for (const d of template.steps) {
      for (const e of stepDepEdges(d, template, orderByKey)) out.add(`${e.from}|${d.key}|sched`)
      for (const from of localStepRefs(d.inputs)) {
        if (from !== d.key) out.add(`${from}|${d.key}|data`)
      }
    }
    return out
  }
  const setEquals = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x))

  // ================= sections =================

  /** ① dag：依赖语义共享模块矩阵（引擎与画布单一真源） */
  const sectionDag = async (): Promise<void> => {
    // ---- 真模板：不变式 + 逐点对拍 ----
    const obk = new Map(tpl.steps.map((d, i) => [d.key, i]))
    const keys = new Set(tpl.steps.map((d) => d.key))
    let invariantOk = true
    for (const d of tpl.steps) {
      for (const k of stepDeps(d, tpl, obk)) {
        if (k === d.key || !keys.has(k)) invariantOk = false
      }
    }
    check(invariantOk, '真模板不变式：依赖均在模板内且不含自身')
    const byKey = new Map(tpl.steps.map((d) => [d.key, d]))
    check(
      JSON.stringify(stepDeps(byKey.get('write_script')!, tpl, obk)) === JSON.stringify(['ingest_docs']),
      '真模板：write_script 缺省前一步 → [ingest_docs]',
    )
    check(
      JSON.stringify(stepDeps(byKey.get('sync_characters')!, tpl, obk)) === JSON.stringify(['char_profile', 'gen_refs']),
      '真模板：sync_characters 显式 after 多值顺序保持',
    )
    check(
      JSON.stringify(stepDeps(byKey.get('compose_video')!, tpl, obk)) ===
        JSON.stringify(['make_storyboard', 'gen_images', 'gen_motion', 'voice', 'subtitle']),
      '真模板：compose_video after 5 值顺序保持',
    )
    check(stepDeps(tpl.steps[0]!, tpl, obk).length === 0, '真模板：首步无依赖')
    const eWs = stepDepEdges(byKey.get('write_script')!, tpl, obk)
    check(eWs.length === 1 && eWs[0]!.from === 'ingest_docs' && eWs[0]!.origin === 'default', '真模板：缺省前一步边 origin=default')
    const eSc = stepDepEdges(byKey.get('sync_characters')!, tpl, obk)
    check(eSc.length === 2 && eSc.every((e) => e.origin === 'after'), '真模板：after 多值边 origin=after')

    // ---- 自造矩阵 ----
    const mkTpl = (steps: TemplateStepDef[]): Template =>
      ({ key: 'probe-dag', version: 1, name: 'probe', genre: 'other', inputs: [], steps }) as unknown as Template
    const obkOf = (t: Template): Map<string, number> => new Map(t.steps.map((d, i) => [d.key, i]))
    const st = (key: string, extra: Record<string, unknown> = {}): TemplateStepDef =>
      ({ key, action: 'manual_ingest', title: key, inputs: {}, ...extra }) as unknown as TemplateStepDef

    const t1 = mkTpl([st('a'), st('b')])
    check(JSON.stringify(stepDeps(t1.steps[1]!, t1, obkOf(t1))) === '["a"]', '矩阵：缺省前一步')

    const t2 = mkTpl([st('a'), st('b'), st('c', { after: ['a', 'b'] })])
    check(JSON.stringify(stepDeps(t2.steps[2]!, t2, obkOf(t2))) === '["a","b"]', '矩阵：显式 after 多值')

    const t3 = mkTpl([st('a'), st('c', { after: ['c', 'a', 'a'] })])
    check(JSON.stringify(stepDeps(t3.steps[1]!, t3, obkOf(t3))) === '["a"]', '矩阵：after 排除自身 + 键去重')

    const t4 = mkTpl([st('a'), st('c', { after: [] })])
    check(stepDeps(t4.steps[1]!, t4, obkOf(t4)).length === 0, '矩阵：after=[] 显式无依赖')

    const t5 = mkTpl([st('a'), st('b'), st('c', { after: [], when: 'steps.a.count>=1' })])
    const e5 = stepDepEdges(t5.steps[2]!, t5, obkOf(t5))
    check(e5.length === 1 && e5[0]!.from === 'a' && e5[0]!.origin === 'when', '矩阵：when step_count 隐含依赖（origin=when）')

    const t6 = mkTpl([st('a'), st('b'), st('c'), st('d', { after: [], when_any: ['steps.a.count>=1', 'steps.c.count>=1'] })])
    check(JSON.stringify(stepDeps(t6.steps[3]!, t6, obkOf(t6))) === '["a","c"]', '矩阵：when_any OR 组引用')

    const t7 = mkTpl([st('a'), st('b'), st('e', { after: [], gate: { mode: 'required', message: 'm', when: 'steps.b.count>=1' } })])
    check(JSON.stringify(stepDeps(t7.steps[2]!, t7, obkOf(t7))) === '["b"]', '矩阵：gate.when 隐含依赖')

    const t8 = mkTpl([st('a'), st('f', { after: [], when: 'bad expr !!!' })])
    let threw = false
    try {
      stepDeps(t8.steps[1]!, t8, obkOf(t8))
    } catch {
      threw = true
    }
    check(!threw && stepDeps(t8.steps[1]!, t8, obkOf(t8)).length === 0, '矩阵：坏表达式吞错（不抛 → 空依赖）')

    const t9 = mkTpl([st('a'), st('g', { after: ['a'], when: 'steps.a.count>=1' })])
    const e9 = stepDepEdges(t9.steps[1]!, t9, obkOf(t9))
    check(e9.length === 1 && e9[0]!.origin === 'after', '矩阵：after+when 同键去重（首见 after 优先）')

    const t10 = mkTpl([st('a'), st('b'), st('c', { when: 'steps.a.count>=1' })])
    const e10 = stepDepEdges(t10.steps[2]!, t10, obkOf(t10))
    check(
      JSON.stringify(e10.map((e) => e.from)) === '["b","a"]' && e10[1]!.origin === 'when',
      '矩阵：缺省前一步与 when 隐含混合（顺序 b,a；来源 default,when）',
    )

    const t11 = mkTpl([st('a'), st('h', { when: ['steps.a.count>=1', 'steps.a.count<=9'] })])
    check(stepDeps(t11.steps[1]!, t11, obkOf(t11)).length === 1, '矩阵：when 数组同键去重')
  }

  /** ② canvas-run：运行画布 HTTP 全链（状态矩阵 + 边对拍 + 操作可用性） */
  const sectionCanvasRun = async (): Promise<void> => {
    const { checkRepairable } = await import('../src/services/shot-workbench')

    // 404
    const miss = await jreq('GET', '/api/v1/runs/999999/canvas')
    check(miss.status === 404 && miss.body?.error?.code === 'not_found', 'GET 不存在 run → 404 not_found')

    // ---- Run A：completed + 全 succeeded 基线 ----
    const runA = await mkRun({ status: 'completed' })
    const stepsA = await mkSteps(runA.id, 'succeeded')
    const ca = await jreq('GET', `/api/v1/runs/${runA.id}/canvas`)
    check(ca.status === 200, 'GET run 画布 → 200')
    check(ca.body?.nodes?.length === tpl.steps.length, `节点数 = 模板步数（${tpl.steps.length}）`)
    const seqOk = tpl.steps.every((d, i) => ca.body.nodes[i]?.key === d.key && ca.body.nodes[i]?.seq === i)
    check(seqOk, '节点顺序与 seq = 模板步序')
    check(nodeOf(ca.body, 'write_script')?.stepId === stepsA.get('write_script')!.id, 'stepId 透传（抽屉任务过滤 / 重跑弹窗计数）')
    check(ca.body?.template?.key === 'mengbao-episode' && ca.body?.template?.version === tpl.version, '模板摘要取快照版本')
    check(ca.body?.run?.status === 'completed' && ca.body?.run?.input?.episode_number === 1, 'run 摘要含状态与 input')
    check(ca.body?.runActions?.canCancel === false && ca.body?.runActions?.canResume === false, 'runActions：completed → 不可取消不可续跑')

    // 边集合对拍 + 混合边 + origin
    check(setEquals(canvasEdgeSet(ca.body), expectedEdges(tpl)), '边集合与真值对拍（sched 共享语义 + data 扫描）')
    check(Boolean(edgeOf(ca.body, 'ingest_docs', 'write_script', 'sched')) && Boolean(edgeOf(ca.body, 'ingest_docs', 'write_script', 'data')), '同对节点 sched+data 混合双保留')
    check(edgeOf(ca.body, 'ingest_docs', 'write_script', 'sched')?.origin === 'default', '缺省前一步边 origin=default')
    check(edgeOf(ca.body, 'char_profile', 'sync_characters', 'sched')?.origin === 'after', '显式 after 边 origin=after')
    check(Boolean(edgeOf(ca.body, 'gen_refs', 'sync_characters', 'data')), 'data 边：ref_images ← gen_refs.assets')

    // 操作可用性：completed + succeeded + 无 failed 全线放行
    check(nodeOf(ca.body, 'compose_video')?.actions?.rerun?.allowed === true, 'rerun：基线放行（compose_video）')
    check(nodeOf(ca.body, 'compose_video')?.actions?.recompose?.allowed === true, 'recompose：ffmpeg_merge 步放行')
    check(nodeOf(ca.body, 'gen_images')?.actions?.recompose === null, 'recompose：非 ffmpeg_merge 步 → null')

    // ---- failed 目标 + 其他失败 → 门禁文案 ----
    await updStep(stepsA.get('cast_lines')!.id, { status: 'failed', error: 'probe 故障' })
    const cb = await jreq('GET', `/api/v1/runs/${runA.id}/canvas`)
    check(nodeOf(cb.body, 'cast_lines')?.actions?.rerun?.allowed === true, 'rerun：failed 目标自身放行（others 不计自身）')
    const cvNode = nodeOf(cb.body, 'compose_video')
    check(
      cvNode?.actions?.rerun?.allowed === false && String(cvNode?.actions?.rerun?.reason).includes('存在其他失败步骤'),
      'rerun：存在其他失败步骤 → 拒绝 + 文案',
    )
    check(nodeOf(cb.body, 'cast_lines')?.error === 'probe 故障', 'failed 步骤 error 透传')

    // checkRepairable 双源对拍
    const cr1 = await checkRepairable(runA.id, 'cast_lines')
    const cr2 = await checkRepairable(runA.id, 'compose_video')
    check(
      cr1.ok === true && cr2.ok === false && cvNode?.actions?.rerun?.allowed === cr2.ok,
      '画布 rerun 判定与 checkRepairable 双源一致',
    )

    // ---- run 级状态链：failed → taskRetry 计数 ----
    await updRun(runA.id, { status: 'failed', error: 'probe run 故障' })
    await mkTask(runA.id, stepsA.get('gen_images')!.id, 'succeeded')
    await mkTask(runA.id, stepsA.get('gen_images')!.id, 'failed')
    await mkTask(runA.id, stepsA.get('gen_images')!.id, 'cancelled')
    const cc = await jreq('GET', `/api/v1/runs/${runA.id}/canvas`)
    const gi = nodeOf(cc.body, 'gen_images')
    check(
      gi?.tasks?.total === 3 && gi?.tasks?.succeeded === 1 && gi?.tasks?.failed === 1 && gi?.tasks?.cancelled === 1,
      '任务聚合：total/succeeded/failed/cancelled 计数',
    )
    check(gi?.actions?.taskRetry?.count === 2, 'taskRetry：failed+cancelled=2（run failed 允许）')
    check(cc.body?.runActions?.canResume === true, 'runActions：failed → 可续跑')

    await updRun(runA.id, { status: 'waiting_input' })
    const cd = await jreq('GET', `/api/v1/runs/${runA.id}/canvas`)
    check(nodeOf(cd.body, 'gen_images')?.actions?.taskRetry === null, 'taskRetry：run waiting_input → null')
    check(
      String(nodeOf(cd.body, 'compose_video')?.actions?.rerun?.reason).includes('正在执行/排队'),
      'rerun：run waiting_input → 活跃拒绝文案',
    )

    await updRun(runA.id, { status: 'cancelled' })
    const ce = await jreq('GET', `/api/v1/runs/${runA.id}/canvas`)
    check(ce.body?.runActions?.canResume === true && ce.body?.runActions?.canCancel === false, 'runActions：cancelled → 可续跑')
    check(String(nodeOf(ce.body, 'compose_video')?.actions?.rerun?.reason).includes('断点续跑'), 'rerun：cancelled → 续跑引导文案')

    // ---- 闸门：waiting_input + 内插 + skip_label ----
    await updRun(runA.id, { status: 'completed' })
    await updStep(stepsA.get('write_script')!.id, { status: 'waiting_input' })
    await updStep(stepsA.get('make_storyboard')!.id, { status: 'waiting_input' })
    const cf = await jreq('GET', `/api/v1/runs/${runA.id}/canvas`)
    const wsNode = nodeOf(cf.body, 'write_script')
    check(
      wsNode?.actions?.gate?.approve === true && wsNode?.actions?.gate?.reject === true && wsNode?.actions?.gate?.skip === false,
      'gate 三决策：waiting_input 无 skip_label → skip=false',
    )
    check(String(wsNode?.gate?.message).includes('第 1 集'), 'gate 文案内插 episode_number → 第 1 集')
    check(nodeOf(cf.body, 'make_storyboard')?.actions?.gate?.skip === true, 'gate：声明 skip_label → skip=true')

    // ---- skipped 痕迹 / gateTrace / assetIds ----
    await updStep(stepsA.get('script_review')!.id, {
      status: 'skipped',
      output: JSON.stringify({ asset_ids: [], skipped: { reason: 'when_condition', at: T0 } }),
    })
    await updStep(stepsA.get('cast_lines')!.id, {
      output: JSON.stringify({ asset_ids: [7, 8], gate: { decision: 'approve', note: 'ok', at: T0 } }),
    })
    const cg = await jreq('GET', `/api/v1/runs/${runA.id}/canvas`)
    check(nodeOf(cg.body, 'script_review')?.skippedReason === 'when_condition', 'skippedReason 透传（when_condition）')
    check(nodeOf(cg.body, 'script_review')?.actions?.rerun === null, '非候选步骤（skipped）→ rerun=null')
    const clNode = nodeOf(cg.body, 'cast_lines')
    check(JSON.stringify(clNode?.assetIds) === '[7,8]', 'assetIds 透传 output.asset_ids')
    check(clNode?.gateTrace?.decision === 'approve' && clNode?.gateTrace?.note === 'ok', 'gateTrace 透传决策痕迹')

    // ---- 耗时与尝试 ----
    await updStep(stepsA.get('voice')!.id, {
      startedAt: T0,
      completedAt: T0 + 5000,
      attempts: 2,
      input: JSON.stringify({ text: '你好', speed: 1.1 }),
    })
    const ch = await jreq('GET', `/api/v1/runs/${runA.id}/canvas`)
    check(nodeOf(ch.body, 'voice')?.durationMs === 5000 && nodeOf(ch.body, 'voice')?.attempts === 2, 'durationMs 派生 + attempts 透传')
    check(nodeOf(ch.body, 'voice')?.input?.text === '你好' && nodeOf(ch.body, 'voice')?.input?.speed === 1.1, 'step.input 快照透传（抽屉输入区）')

    // ---- Run B：running 状态 ----
    const runB = await mkRun({ status: 'running' })
    await mkSteps(runB.id, 'pending')
    const ci = await jreq('GET', `/api/v1/runs/${runB.id}/canvas`)
    check(ci.body?.runActions?.canCancel === true, 'runActions：running → 可取消')
    check(nodeOf(ci.body, 'write_script')?.actions?.rerun === null, 'pending 步骤 → rerun=null')

    // ---- Run C：模板不可得 + 孤儿行（宽容降级） ----
    const runC = await mkRun({ status: 'queued', templateKey: 'nonexistent-tpl', snapshot: '{bad json' })
    await db
      .insert(pipelineSteps)
      .values({ runId: runC.id, seq: 0, stepKey: 'ghost_step', actionKey: 'manual_ingest', title: '幽灵步', status: 'pending', attempts: 0, createdAt: T0, updatedAt: T0 })
    const cj = await jreq('GET', `/api/v1/runs/${runC.id}/canvas`)
    check(cj.status === 200 && cj.body?.template === null, '模板不可得 → template=null（200 不炸）')
    check(cj.body?.nodes?.length === 1 && cj.body?.nodes?.[0]?.key === 'ghost_step', '孤儿行按行渲染（宽容）')
    check(Array.isArray(cj.body?.edges) && cj.body.edges.length === 0, '模板不可得 → 边为空')
    check(nodeOf(cj.body, 'ghost_step')?.actions?.rerun === null, '孤儿行操作全空')

    // ---- Run D：坏快照回退文件加载 ----
    const runD = await mkRun({ status: 'queued', snapshot: '{bad json' })
    const ck = await jreq('GET', `/api/v1/runs/${runD.id}/canvas`)
    check(ck.body?.template?.key === 'mengbao-episode' && ck.body?.nodes?.length === tpl.steps.length, '坏快照 → 回退文件加载（全节点）')
  }

  /** ③ canvas-template：模板设计态画布 */
  const sectionCanvasTemplate = async (): Promise<void> => {
    const miss = await jreq('GET', '/api/v1/templates/definitely-missing/canvas')
    check(miss.status === 404 && miss.body?.error?.code === 'template_not_found', 'GET 不存在模板 → 404 template_not_found')

    const res = await jreq('GET', '/api/v1/templates/mengbao-episode/canvas')
    check(res.status === 200, 'GET 模板画布 → 200')
    const body = res.body
    check(body?.template?.key === 'mengbao-episode' && body?.template?.version === tpl.version && body?.template?.name === tpl.name, '模板摘要对拍')
    check(body?.nodes?.length === tpl.steps.length, `节点数 = 步数（${tpl.steps.length}）`)
    const defOk = tpl.steps.every((d, i) => {
      const n = body.nodes[i]
      return n?.key === d.key && n?.seq === i && n?.action === d.action && n?.title === d.title
    })
    check(defOk, '节点 def 静态字段逐点对拍（key/seq/action/title）')
    check(setEquals(canvasEdgeSet(body), expectedEdges(tpl)), '模板画布边集合与真值对拍')

    const ws = nodeOf(body, 'write_script')
    check(ws?.gate?.message === tpl.steps.find((d) => d.key === 'write_script')!.gate!.message, 'gate 文案透传（不内插）')
    check(!('skipLabel' in (ws?.gate ?? {})), 'gate 无 skip_label → 字段省略')
    const ms = nodeOf(body, 'make_storyboard')
    check(ms?.gate?.skipLabel === '免审直接出图' && ms?.gate?.when === 'input.with_storyboard_review == true', 'gate 摘要：skipLabel + when')
    const sr = nodeOf(body, 'script_review')
    check(sr?.when === 'input.with_deep_review == true' && JSON.stringify(sr?.after) === '["write_script"]', 'when/after 透传')
    const gi = nodeOf(body, 'gen_images')
    check(
      gi?.batch?.field === 'shots' && gi?.batch?.maxConcurrent === 2 && gi?.batch?.retry === 1,
      'batch 摘要（max_concurrent → maxConcurrent）',
    )
    const wsRefs = Array.isArray(ws?.inputsRefs) ? ws.inputsRefs : []
    check(
      wsRefs.some((r: any) => r.field === 'setting' && r.kind === 'step' && r.ref === 'steps.ingest_docs.assets') &&
        wsRefs.some((r: any) => r.field === 'brief' && r.kind === 'input' && r.ref === 'input.brief'),
      'inputsRefs：step 引用 + input 引用',
    )
    const cvRefs = Array.isArray(nodeOf(body, 'compose_video')?.inputsRefs) ? nodeOf(body, 'compose_video').inputsRefs : []
    check(cvRefs.filter((r: any) => r.kind === 'step').length === 5, 'inputsRefs：compose_video 5 条 step 引用')
    check(!('status' in (body?.nodes?.[0] ?? {})), '模板画布节点无运行字段（status 省略）')
  }

  /** ④ regression：前序探针子进程全绿（m2a 锁引擎调度语义；m14 内含 m7-m13） */
  const sectionRegression = async (): Promise<void> => {
    const { spawnSync } = await import('node:child_process')
    const probes = ['probe:m2a', 'probe:m4', 'probe:m14']
    const childEnv = { ...process.env }
    delete childEnv.CSTUDIO_ROOT
    delete childEnv.CSTUDIO_DATA
    delete childEnv.CSTUDIO_WORKSPACE
    delete childEnv.AGENT_LLM_BASE_URL
    delete childEnv.AGENT_LLM_API_KEY
    delete childEnv.AGENT_LLM_MODEL
    for (const p of probes) {
      const r = spawnSync('npm', ['run', p], {
        cwd: join(REPO_ROOT, 'apps', 'server'),
        env: childEnv,
        shell: true,
        encoding: 'utf8',
        timeout: 15 * 60_000,
      })
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
      const tail = out
        .split('\n')
        .filter((l) => l.includes('探针结果') || l.includes('FAIL'))
        .slice(-3)
        .join(' | ')
      check(r.status === 0, `${p} 全绿（exit=${String(r.status)}${r.status === 0 ? '' : `；${tail || out.slice(-300).trim()}`}）`)
    }
  }

  // ================= 分发 =================
  const runners: Record<string, () => Promise<void>> = {
    dag: sectionDag,
    'canvas-run': sectionCanvasRun,
    'canvas-template': sectionCanvasTemplate,
    regression: sectionRegression,
  }
  const arg = process.argv.find((a) => a.startsWith('--section='))
  const wanted = arg ? arg.slice('--section='.length) : 'all'
  if (wanted !== 'all' && !(SECTIONS as readonly string[]).includes(wanted)) {
    log.error(`未知 section：${wanted}（已实现：${SECTIONS.join(' / ')}；all = 全部）`)
    process.exitCode = 1
    return
  }

  try {
    for (const name of (wanted === 'all' ? SECTIONS : [wanted]) as readonly string[]) {
      console.log(`\n──── section: ${name} ────`)
      await runners[name]!()
    }
  } catch (err) {
    failed += 1
    console.error(`\n探针异常终止: ${(err as Error).stack ?? err}`)
  } finally {
    console.log(`\n==== M15 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    globalThis.fetch = origFetch // 还原网络栈
    try {
      sqlite.close() // 释放 db 连接（Windows 下句柄可能仍被 libsql 持有 → 失败不阻断）
    } catch {
      /* 已关闭或未初始化 */
    }
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : 0
  }
}

void main()
