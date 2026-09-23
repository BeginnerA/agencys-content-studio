/**
 * M4 探针（批次/用量/导出/统计）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m4.ts [--section=migrate|usage|batch|export|stats]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3）。
 *
 * section（默认 all = 全部；本探针无模型/网络依赖，无 SKIP 路径）：
 *   migrate  空库 migrate 自动建 batches/usage_records/publications 三表 + 8 索引 + runs/assets 增列
 *   usage    定价四级匹配（provider:model → provider:* → provider → model）+ 快照语义 + 聚合口径
 *   batch    批次实弹：两阶段校验零落库 / 串行槽位 / gate 挂起不推进 / partial_failed / cancelBatch / recover 过滤
 *   export   buildRunExport 实弹：zip 解包自校验（manifest / role 目录 / 重名 -1 / 勾选 / 错误分支）
 *   stats    buildOverview 逐项与 SQL 直查核对（runs/cost/assets/activity/publications）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
import { sweepStaleProbeTempDirs, writeProbePidSentinel } from './probe-lib'

const TMP_PREFIX = 'acs-probe-m4-'
// 清理历史残留（跳过存活并行探针目录，避免并行 --jobs≥2 下嵌套回归子探针与顶层同名探针互删 SQLite 库）
sweepStaleProbeTempDirs(TMP_PREFIX)
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
writeProbePidSentinel(TMP)
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['migrate', 'usage', 'batch', 'export', 'stats'] as const

/** batch section 模板：manual_ingest 无 LLM/网络；gate=required 制造 waiting_input 挂起 */
const TPL_M4_GATE = `key: probe-m4-gate
version: 1
name: M4 批次闸门探针
genre: other
inputs:
  - key: brief
    label: 简报
    kind: text
    required: true
  - key: episode_number
    label: 集数
    kind: int
    required: false
steps:
  - key: ingest
    action: manual_ingest
    title: 素材入库
    inputs:
      brief: input.brief
    gate:
      mode: required
      message: 探针人工闸（等待 approve）
`

/** batch section 模板：无 gate（reconcile 场景直达完成） */
const TPL_M4_PLAIN = `key: probe-m4-plain
version: 1
name: M4 批次直通探针
genre: other
inputs:
  - key: brief
    label: 简报
    kind: text
    required: true
  - key: episode_number
    label: 集数
    kind: int
    required: false
steps:
  - key: ingest
    action: manual_ingest
    title: 素材入库
    inputs:
      brief: input.brief
`

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { eq } = await import('drizzle-orm')

  const log = createLogger('probe-m4')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  /** 轮询等待（异步收敛断言用）；超时返回 false */
  const waitFor = async (pred: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<boolean> => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await pred()) return true
      await sleep(intervalMs)
    }
    return false
  }
  /** 近似比较（cost 浮点） */
  const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps

  // ================= sections =================

  const sectionMigrate = async (): Promise<void> => {
    await initDb()
    const r = await sqlite.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('batches','usage_records','publications') ORDER BY name",
    )
    const names = (r.rows as unknown as Array<{ name: string }>).map((x) => x.name)
    check(names.join(',') === 'batches,publications,usage_records', `三表存在（${names.join(',')}）`)
    const ri = await sqlite.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_batches_project','idx_batches_status'," +
        "'idx_usage_project','idx_usage_run','idx_usage_kind','idx_publications_project','idx_publications_asset','idx_runs_batch')",
    )
    check(ri.rows.length === 8, `8 个新索引存在（实际 ${ri.rows.length}）`)
    const cols = async (table: string): Promise<string[]> => {
      const t = await sqlite.execute(`SELECT name FROM pragma_table_info('${table}')`)
      return (t.rows as unknown as Array<{ name: string }>).map((x) => x.name)
    }
    const runCols = await cols('pipeline_runs')
    check(runCols.includes('batch_id') && runCols.includes('batch_seq'), 'pipeline_runs 增列 batch_id/batch_seq')
    check((await cols('assets')).includes('run_id'), 'assets 增列 run_id')
  }

  const sectionUsage = async (): Promise<void> => {
    await initDb()
    const { db } = await import('../src/db')
    const { projects, settings, usageRecords } = await import('../src/db/schema')
    const { priceOf, recordLlmUsage, recordUsage, unitBase, usageSummary } = await import('../src/services/usage')

    // —— 定价四级匹配（含 §C 示例键 model-only 兜底）——
    const pricing = {
      llm: { 'deepseek-chat': { tokens_in: 1, tokens_out: 2 } },
      image: { 'volcengine_image:doubao-seedream': { image: 0.2 }, probe_provider: { image: 0.3 } },
      video: { 'aliyun_wan:*': { second: 0.6 } },
      tts: { 'siliconflow_audio:*': { char: 0.05 } },
    }
    check(unitBase('tokens_in') === 1_000_000 && unitBase('char') === 1_000 && unitBase('image') === 1, 'unitBase 基数（tokens=1e6 / char=1e3 / image=1）')
    check(priceOf(pricing, 'image', 'volcengine_image', 'doubao-seedream', 'image') === 0.2, '一级 {provider}:{model} 命中（0.2）')
    check(priceOf(pricing, 'video', 'aliyun_wan', 'wan2.6-t2v', 'second') === 0.6, '二级 {provider}:* 命中（0.6）')
    check(priceOf(pricing, 'image', 'probe_provider', 'any-model', 'image') === 0.3, '三级 {provider} 命中（0.3）')
    check(priceOf(pricing, 'llm', 'deepseek', 'deepseek-chat', 'tokens_in') === 1 / 1e6, '四级 {model} 兜底命中（§C 示例键 deepseek-chat）')
    check(priceOf(pricing, 'image', 'nobody', 'nothing', 'image') === null, '全未命中 → null')
    check(priceOf(pricing, 'llm', 'deepseek', 'deepseek-chat', 'image') === null, 'unit 不在配置 → null')

    // —— 落 pricing（settings KV）→ recordUsage 快照语义 ——
    const t = Date.now()
    await db.delete(settings).where(eq(settings.key, 'pricing'))
    await db.insert(settings).values({ key: 'pricing', value: JSON.stringify(pricing), updatedAt: t })
    const pid = (
      await db
        .insert(projects)
        .values({ name: 'M4 用量探针', genre: 'other', templateKey: 'probe-m4-plain', settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!.id
    const rows = async () =>
      (await db.select().from(usageRecords).where(eq(usageRecords.projectId, pid))).sort((a, b) => a.id - b.id)

    await recordUsage({ projectId: pid, kind: 'llm', provider: 'deepseek', model: 'deepseek-chat', quantity: 1000, unit: 'tokens_in' })
    let list = await rows()
    check(
      list.length === 1 && near(list[0]!.unitPrice ?? -1, 1 / 1e6) && near(list[0]!.cost ?? -1, 0.001),
      `recordUsage 首条（unitPrice=${list[0]?.unitPrice} cost=${list[0]?.cost}）`,
    )

    // 改价（tokens_in 1 → 2 元/百万）：只影响新记录
    const pricing2 = { ...pricing, llm: { 'deepseek-chat': { tokens_in: 2, tokens_out: 2 } } }
    await db.update(settings).set({ value: JSON.stringify(pricing2), updatedAt: Date.now() }).where(eq(settings.key, 'pricing'))
    await recordUsage({ projectId: pid, kind: 'llm', provider: 'deepseek', model: 'deepseek-chat', quantity: 1000, unit: 'tokens_in' })
    list = await rows()
    check(list.length === 2 && near(list[0]!.cost ?? -1, 0.001) && near(list[1]!.cost ?? -1, 0.002), '改价不影响历史行（旧 0.001 保持 / 新 0.002）')

    // recordLlmUsage：null / total=0 不写；正常写 tokens_in/out 两行
    await recordLlmUsage({ projectId: pid, provider: 'deepseek', model: 'deepseek-chat', usage: null })
    await recordLlmUsage({ projectId: pid, provider: 'deepseek', model: 'deepseek-chat', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })
    check((await rows()).length === 2, 'usage 空 / total=0 → 不写')
    await recordLlmUsage({ projectId: pid, provider: 'deepseek', model: 'deepseek-chat', usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 } })
    list = await rows()
    check(
      list.length === 4 && near(list[2]!.cost ?? -1, 0.002) && near(list[3]!.cost ?? -1, 0.001),
      `recordLlmUsage 写 tokens_in/out 两行（${list[2]?.cost} / ${list[3]?.cost}）`,
    )

    // 未定价：cost/unitPrice NULL 且计入 unpriced
    await recordUsage({ projectId: pid, kind: 'image', provider: 'nobody', model: 'nothing', quantity: 1, unit: 'image' })
    list = await rows()
    check(list.length === 5 && list[4]!.cost === null && list[4]!.unitPrice === null, '未命中定价 → cost/unitPrice NULL')

    // —— usageSummary 聚合与明细一致 ——
    const sumKind = await usageSummary({ projectId: pid, groupBy: 'kind' })
    const qSum = sumKind.items.reduce((s, x) => s + x.quantity, 0)
    const cSum = sumKind.items.reduce((s, x) => s + x.cost, 0)
    check(
      sumKind.items.some((x) => x.key === 'llm') && near(sumKind.totals.quantity, qSum) && near(sumKind.totals.cost, cSum),
      `group_by=kind 合计=明细求和（qty=${sumKind.totals.quantity} cost=${sumKind.totals.cost}）`,
    )
    check(sumKind.totals.unpriced === 1, `未计价行计数（unpriced=${sumKind.totals.unpriced}）`)
    const sumPm = await usageSummary({ projectId: pid, groupBy: 'provider_model' })
    check(sumPm.items.some((x) => x.key === 'deepseek:deepseek-chat'), 'group_by=provider_model key=deepseek:deepseek-chat')
    const today = (() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    const sumDay = await usageSummary({ projectId: pid, groupBy: 'day' })
    check(sumDay.items.some((x) => x.key === today), `group_by=day 含今日（${today}）`)
    const sqlCost = (await sqlite.execute(`SELECT COALESCE(SUM(cost),0) AS c FROM usage_records WHERE project_id = ${pid}`)).rows[0] as unknown as { c: number }
    check(near(Number(sqlCost.c), sumKind.totals.cost), `SQL 直查成本与聚合一致（${sqlCost.c}）`)
  }

  const sectionBatch = async (): Promise<void> => {
    await initDb()
    const { db } = await import('../src/db')
    const { batches, pipelineRuns, projects } = await import('../src/db/schema')
    const { loadTemplate } = await import('../src/pipeline/loader')
    const { engine, onRunSettled, recoverInterruptedState } = await import('../src/pipeline/engine')
    const { cancelBatch, createBatch, notifyRunSettled, reconcileBatches, summarizeBatch } = await import('../src/services/batch')
    const { createRunRow, InvalidRunInputError } = await import('../src/services/run-create')

    // engine 钩子接线（等价 index.ts：settle → 批推进；探针手动注册）
    onRunSettled((runId) => {
      void notifyRunSettled(runId)
    })

    // 内联模板写临时 templates 目录（loadTemplate 走隔离 workspace）
    mkdirSync(join(process.env.CSTUDIO_WORKSPACE!, 'templates'), { recursive: true })
    writeFileSync(join(process.env.CSTUDIO_WORKSPACE!, 'templates', 'probe-m4-gate.yaml'), TPL_M4_GATE, 'utf8')
    writeFileSync(join(process.env.CSTUDIO_WORKSPACE!, 'templates', 'probe-m4-plain.yaml'), TPL_M4_PLAIN, 'utf8')
    check(loadTemplate('probe-m4-gate').steps.length === 1 && loadTemplate('probe-m4-plain').steps.length === 1, '两个内联模板加载（steps=1）')

    const t = Date.now()
    const pid = (
      await db
        .insert(projects)
        .values({ name: 'M4 批次探针', genre: 'other', templateKey: 'probe-m4-gate', settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!.id

    const runStatus = async (id: number): Promise<string> =>
      (await db.select({ status: pipelineRuns.status }).from(pipelineRuns).where(eq(pipelineRuns.id, id)).limit(1))[0]?.status ?? 'missing'
    const batchStatus = async (id: number): Promise<string> =>
      (await db.select({ status: batches.status }).from(batches).where(eq(batches.id, id)).limit(1))[0]?.status ?? 'missing'
    const activeCount = async (ids: number[]): Promise<number> => {
      const st = await Promise.all(ids.map(runStatus))
      return st.filter((s) => s === 'running' || s === 'waiting_input').length
    }

    // —— b1 两阶段校验：第 2 组非法 → 带组号报错 + 零落库 ——
    const n0 = { batches: (await db.select().from(batches)).length, runs: (await db.select().from(pipelineRuns)).length }
    let err1: unknown = null
    try {
      await createBatch({ projectId: pid, templateKey: 'probe-m4-plain', inputs: [{ brief: 'a' }, { brief: 'b', episode_number: 'x' }, { brief: 'c' }] })
    } catch (err) {
      err1 = err
    }
    check(
      err1 instanceof InvalidRunInputError && /第 2 组输入/.test((err1 as Error).message),
      `非法第 2 组 → InvalidRunInputError 带组号（${err1 instanceof Error ? err1.message : '未抛出'}）`,
    )
    let err2: unknown = null
    try {
      await createBatch({ projectId: pid, templateKey: 'probe-m4-plain', inputs: [] })
    } catch (err) {
      err2 = err
    }
    check(err2 instanceof InvalidRunInputError, 'inputs 空数组 → InvalidRunInputError')
    check(
      (await db.select().from(batches)).length === n0.batches && (await db.select().from(pipelineRuns)).length === n0.runs,
      '阶段 A 失败零落库（batches/runs 计数不变）',
    )

    // —— b2 串行 + gate 挂起 + 槽位推进 + 全完成（3 组 max_concurrent=1）——
    const b2 = await createBatch({
      projectId: pid,
      templateKey: 'probe-m4-gate',
      name: '串行闸门批',
      schedule: { max_concurrent: 1 },
      inputs: [
        { brief: '第1集', episode_number: 1 },
        { brief: '第2集', episode_number: 2 },
        { brief: '第3集', episode_number: 3 },
      ],
    })
    check(b2.runIds.length === 3, `createBatch 返回 3 个 runId（${b2.runIds.join(',')}）`)
    const b2runs = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.batchId, b2.batch.id))).sort(
      (a, b) => (a.batchSeq ?? 0) - (b.batchSeq ?? 0),
    )
    check(
      b2runs.length === 3 && b2runs.every((r, i) => r.batchSeq === i + 1),
      `batchSeq 从 1 递增（${b2runs.map((r) => r.batchSeq).join(',')}）`,
    )
    check(await waitFor(async () => (await runStatus(b2.runIds[0]!)) === 'waiting_input'), 'run1 执行后挂在人工闸（waiting_input）')
    check(
      (await runStatus(b2.runIds[1]!)) === 'queued' && (await runStatus(b2.runIds[2]!)) === 'queued',
      'gate 挂起占槽：run2/run3 保持 queued（串行不超发）',
    )
    check((await activeCount(b2.runIds)) === 1, `活跃数 = 1（实际 ${await activeCount(b2.runIds)}）`)
    await engine.approveGate(b2.runIds[0]!, 'ingest')
    check(await waitFor(async () => (await runStatus(b2.runIds[1]!)) === 'waiting_input'), 'approve run1 → 槽位推进 run2 启动')
    check((await runStatus(b2.runIds[2]!)) === 'queued', 'run3 仍 queued（继续串行）')
    await engine.approveGate(b2.runIds[1]!, 'ingest')
    check(await waitFor(async () => (await runStatus(b2.runIds[2]!)) === 'waiting_input'), 'approve run2 → run3 启动')
    await engine.approveGate(b2.runIds[2]!, 'ingest')
    check(await waitFor(async () => (await batchStatus(b2.batch.id)) === 'completed'), '批次收敛 completed')
    const b2sum = await summarizeBatch(b2.batch.id)
    check(
      b2sum !== null && b2sum.batch.succeeded === 3 && b2sum.batch.finished === 3 && b2sum.runs.every((r) => r.status === 'completed' && r.cost === null),
      `计数正确（succeeded=${b2sum?.batch.succeeded} finished=${b2sum?.batch.finished}）且 cost 列 null（无 usage）`,
    )

    // —— b3 partial_failed：run1 挂闸后强制失败 → 槽位推进 run2 → 收敛 partial_failed ——
    const b3 = await createBatch({
      projectId: pid,
      templateKey: 'probe-m4-gate',
      name: '部分失败批',
      schedule: { max_concurrent: 1 },
      inputs: [{ brief: '会失败的集' }, { brief: '正常的集' }],
    })
    check(await waitFor(async () => (await runStatus(b3.runIds[0]!)) === 'waiting_input'), 'b3 run1 挂闸')
    const t3 = Date.now()
    await db
      .update(pipelineRuns)
      .set({ status: 'failed', error: 'probe 强制失败', completedAt: t3, updatedAt: t3 })
      .where(eq(pipelineRuns.id, b3.runIds[0]!))
    await notifyRunSettled(b3.runIds[0]!)
    check(await waitFor(async () => (await runStatus(b3.runIds[1]!)) === 'waiting_input'), '失败 run settle → 槽位推进 run2')
    await engine.approveGate(b3.runIds[1]!, 'ingest')
    check(await waitFor(async () => (await batchStatus(b3.batch.id)) === 'partial_failed'), '批次收敛 partial_failed')
    const b3sum = await summarizeBatch(b3.batch.id)
    check(
      b3sum !== null && b3sum.batch.succeeded === 1 && b3sum.batch.failed === 1 && b3sum.batch.finished === 2,
      `partial_failed 计数（s=${b3sum?.batch.succeeded} f=${b3sum?.batch.failed} fin=${b3sum?.batch.finished}）`,
    )

    // —— b4 cancelBatch：queued 直置 + 挂起 run 走 engine.cancelRun ——
    const b4 = await createBatch({
      projectId: pid,
      templateKey: 'probe-m4-gate',
      name: '取消批',
      schedule: { max_concurrent: 1 },
      inputs: [{ brief: '待取消1' }, { brief: '待取消2' }],
    })
    check(await waitFor(async () => (await runStatus(b4.runIds[0]!)) === 'waiting_input'), 'b4 run1 挂闸（run2 queued）')
    await cancelBatch(b4.batch.id)
    check((await batchStatus(b4.batch.id)) === 'cancelled', '批次置 cancelled')
    check(
      (await runStatus(b4.runIds[0]!)) === 'cancelled' && (await runStatus(b4.runIds[1]!)) === 'cancelled',
      'run1（挂起→cancelRun）/ run2（queued 直置）均 cancelled',
    )
    const b4sum = await summarizeBatch(b4.batch.id)
    check(b4sum !== null && b4sum.batch.finished === 2, `取消后计数回写（finished=${b4sum?.batch.finished}）`)

    // —— b5 recover 过滤批内 queued + reconcile 按槽位推进 ——
    const t5 = Date.now()
    const batch5 = (
      await db
        .insert(batches)
        .values({
          projectId: pid,
          templateKey: 'probe-m4-plain',
          name: '恢复对齐批',
          status: 'running',
          schedule: JSON.stringify({ max_concurrent: 1 }),
          total: 2,
          finished: 1,
          succeeded: 1,
          failed: 0,
          createdAt: t5,
          updatedAt: t5,
        })
        .returning()
    )[0]!
    const r5a = await createRunRow({ projectId: pid, templateKey: 'probe-m4-plain', input: { brief: '已完成' }, batchId: batch5.id, batchSeq: 1 })
    await db.update(pipelineRuns).set({ status: 'completed', completedAt: t5, updatedAt: t5 }).where(eq(pipelineRuns.id, r5a.id))
    const r5b = await createRunRow({ projectId: pid, templateKey: 'probe-m4-plain', input: { brief: '恢复执行' }, batchId: batch5.id, batchSeq: 2 })
    const free = await createRunRow({ projectId: pid, templateKey: 'probe-m4-plain', input: { brief: '游离 run' } })
    const { requeued } = await recoverInterruptedState()
    check(requeued.includes(free.id), '游离 queued run 进入 requeue（recover 正常面）')
    check(!requeued.includes(r5b.id), '批内 queued run 被 recover 过滤（batch_id IS NULL 生效）')
    await reconcileBatches()
    check(await waitFor(async () => (await batchStatus(batch5.id)) === 'completed'), 'reconcile 启动批内 queued run 并按槽位收敛（completed）')
    check((await runStatus(r5b.id)) === 'completed' && !engine.isRunning(r5b.id), 'run 完成且执行链已释放')
  }

  const sectionExport = async (): Promise<void> => {
    await initDb()
    const { db } = await import('../src/db')
    const { pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
    const { ExportError, buildRunExport, collectRunAssets, listExports, roleOfAsset } = await import('../src/services/export')
    const { absPathOf, ensureProjectDirs, registerAsset, relPathOf, sha256Hex, writeTextAsset } = await import('../src/services/storage')

    // role 映射纯函数（按序首配）
    check(roleOfAsset({ kind: 'video', purpose: 'final_video' }).role === 'main_video', 'role: final_video → main_video/video')
    check(roleOfAsset({ kind: 'image', purpose: 'thumbnail' }).dir === 'cover', 'role: thumbnail → cover/cover')
    check(roleOfAsset({ kind: 'text', purpose: 'script' }).role === 'copy', 'role: kind=text → copy/text')
    check(roleOfAsset({ kind: 'video', purpose: 'shot_video' }).role === 'other', 'role: 其余 video → other/video')
    check(roleOfAsset({ kind: 'audio', purpose: 'voice' }).dir === 'other', 'role: 其余 → other/other')

    const t = Date.now()
    const pid = (
      await db
        .insert(projects)
        .values({ name: 'M4 导出探针', genre: 'other', templateKey: 'probe-m4-plain', settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!.id
    const run = (
      await db
        .insert(pipelineRuns)
        .values({ projectId: pid, templateKey: 'probe-m4-plain', status: 'completed', input: JSON.stringify({ brief: '导出探针' }), createdAt: t, updatedAt: t })
        .returning()
    )[0]!
    ensureProjectDirs(pid)
    const step = (
      await db
        .insert(pipelineSteps)
        .values({
          runId: run.id,
          seq: 1,
          stepKey: 'ingest',
          actionKey: 'manual_ingest',
          title: '素材入库',
          status: 'succeeded',
          output: '{"asset_ids":[]}',
          createdAt: t,
          updatedAt: t,
        })
        .returning()
    )[0]!

    // 造真实文件：text（writeTextAsset）/ video（final_video）/ 两张同名 image（thumbnail 重名）
    const textAsset = await writeTextAsset(pid, { name: 'script.md', content: '# 剧本\nM4 导出探针', purpose: 'script', stepId: step.id })
    const videoData = new TextEncoder().encode('fake-mp4-bytes')
    const videoRel = relPathOf(pid, 'final_video', '成片.mp4')
    writeFileSync(absPathOf(videoRel), videoData)
    const videoAsset = await registerAsset(pid, {
      stepId: step.id,
      kind: 'video',
      purpose: 'final_video',
      name: '成片.mp4',
      relPath: videoRel,
      mime: 'video/mp4',
      ext: 'mp4',
      fileSize: videoData.byteLength,
      sha256: sha256Hex(videoData),
    })
    const coverData = new TextEncoder().encode('fake-png-bytes')
    const coverRel = relPathOf(pid, 'thumbnail', 'cover.png')
    writeFileSync(absPathOf(coverRel), coverData)
    const cover1 = await registerAsset(pid, {
      stepId: step.id,
      kind: 'image',
      purpose: 'thumbnail',
      name: 'cover.png',
      relPath: coverRel,
      mime: 'image/png',
      ext: 'png',
      fileSize: coverData.byteLength,
    })
    const coverRel2 = relPathOf(pid, 'thumbnail', 'cover-b.png')
    writeFileSync(absPathOf(coverRel2), coverData)
    const cover2 = await registerAsset(pid, {
      stepId: step.id,
      kind: 'image',
      purpose: 'thumbnail',
      name: 'cover.png',
      relPath: coverRel2,
      mime: 'image/png',
      ext: 'png',
      fileSize: coverData.byteLength,
    })
    await db
      .update(pipelineSteps)
      .set({ output: JSON.stringify({ asset_ids: [textAsset.id, videoAsset.id, cover1.id, cover2.id] }), updatedAt: Date.now() })
      .where(eq(pipelineSteps.id, step.id))

    const collected = await collectRunAssets(run.id)
    check(collected.length === 4, `collectRunAssets 聚合去重（${collected.length}）`)

    const pkg = await buildRunExport({ runId: run.id, name: '探针发布包' })
    check(pkg.kind === 'archive' && pkg.purpose === 'export' && pkg.runId === run.id, `导出资产登记（kind=${pkg.kind} purpose=${pkg.purpose} runId=${pkg.runId}）`)
    const zip = unzipSync(readFileSync(absPathOf(pkg.relPath!)))
    const names = Object.keys(zip)
    check(names[0] === 'manifest.json', 'manifest 为首个条目')
    const set = new Set(names)
    check(
      names.length === 5 && ['video/成片.mp4', 'cover/cover.png', 'cover/cover-1.png', 'text/script.md'].every((p) => set.has(p)),
      `包内 role 目录与重名 -1（${names.join(' ')}）`,
    )
    const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json'])) as {
      run: { id: number }
      files: Array<{ path: string; role: string; assetId: number }>
    }
    check(manifest.run.id === run.id && manifest.files.length === 4, `manifest.run.id / files=4（实际 ${manifest.files.length}）`)
    const mPaths = manifest.files.map((f) => f.path).sort().join('|')
    const zPaths = names.filter((n) => n !== 'manifest.json').sort().join('|')
    check(mPaths === zPaths, 'manifest.files 与包内文件逐一对应')
    check(manifest.files.some((f) => f.path === 'video/成片.mp4' && f.role === 'main_video'), 'manifest role 标注（成片 main_video）')

    // 勾选导出 + 错误分支
    const pkg2 = await buildRunExport({ runId: run.id, name: '勾选包', assetIds: [videoAsset.id] })
    const zip2 = unzipSync(readFileSync(absPathOf(pkg2.relPath!)))
    check(Object.keys(zip2).filter((n) => n !== 'manifest.json').length === 1 && Object.keys(zip2).includes('video/成片.mp4'), 'assetIds 勾选导出仅含选中文件')
    const errOf = async (fn: () => Promise<unknown>): Promise<unknown> => {
      try {
        await fn()
        return null
      } catch (err) {
        return err
      }
    }
    const e1 = await errOf(() => buildRunExport({ runId: run.id, assetIds: [] }))
    check(e1 instanceof ExportError && e1.code === 'no_assets', '空数组 → ExportError no_assets')
    const e2 = await errOf(() => buildRunExport({ runId: run.id, assetIds: [999999] }))
    check(e2 instanceof ExportError && e2.code === 'asset_not_in_run', '非本 run 资产 → ExportError asset_not_in_run')
    const e3 = await errOf(() => buildRunExport({ runId: 999999 }))
    check(e3 instanceof ExportError && e3.code === 'no_run', '不存在 run → ExportError no_run')
    rmSync(absPathOf(videoRel))
    const e4 = await errOf(() => buildRunExport({ runId: run.id }))
    check(e4 instanceof ExportError && e4.code === 'asset_file_missing', '文件缺失 → ExportError asset_file_missing（不带半成品包）')

    const exports = await listExports({ runId: run.id })
    check(exports.length === 2 && exports.some((x) => x.id === pkg.id), `listExports 命中（${exports.length}）`)
  }

  const sectionStats = async (): Promise<void> => {
    await initDb()
    const { db } = await import('../src/db')
    const { assets, pipelineRuns, projects, publications, usageRecords } = await import('../src/db/schema')
    const { buildOverview, publicationTotals } = await import('../src/services/stats')

    // publications 纯函数口径：损坏 metrics → 计 0
    const pt = publicationTotals([
      { metrics: JSON.stringify({ views: 100, likes: 10, comments: 5, favorites: 3, shares: 2 }) },
      { metrics: '{损坏' },
    ])
    check(pt.views === 100 && pt.interactions === 20, `publicationTotals（views=${pt.views} interactions=${pt.interactions}）`)

    const t = Date.now()
    const pid = (
      await db
        .insert(projects)
        .values({ name: 'M4 统计探针', genre: 'other', templateKey: 'probe-m4-plain', settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!.id
    await db
      .insert(projects)
      .values({ name: '已删除项目', genre: 'other', templateKey: 'probe-m4-plain', settings: '{}', tags: '[]', createdAt: t, updatedAt: t, deletedAt: t })

    const mkRun = async (status: string): Promise<void> => {
      await db.insert(pipelineRuns).values({
        projectId: pid,
        templateKey: 'probe-m4-plain',
        status,
        input: '{}',
        createdAt: t,
        updatedAt: t,
        completedAt: status === 'queued' || status === 'running' ? null : t,
      })
    }
    await mkRun('completed')
    await mkRun('failed')
    await mkRun('cancelled')
    await mkRun('queued')

    await db.insert(usageRecords).values([
      { projectId: pid, kind: 'llm', quantity: 1, unit: 'tokens_in', unitPrice: 0.5, cost: 0.5, currency: 'CNY', meta: '{}', createdAt: t },
      { projectId: pid, kind: 'image', quantity: 1, unit: 'image', unitPrice: 0.25, cost: 0.25, currency: 'CNY', meta: '{}', createdAt: t },
    ])
    await db.insert(assets).values([
      { projectId: pid, kind: 'video', name: 'a.mp4', tags: '[]', createdAt: t, updatedAt: t },
      { projectId: pid, kind: 'image', name: 'b.png', tags: '[]', createdAt: t, updatedAt: t },
      { projectId: pid, kind: 'text', name: 'c.md', tags: '[]', createdAt: t, updatedAt: t, deletedAt: t },
    ])
    await db.insert(publications).values([
      { projectId: pid, platform: 'douyin', metrics: JSON.stringify({ views: 100, likes: 10, comments: 5, favorites: 3, shares: 2 }), createdAt: t, updatedAt: t },
      { projectId: pid, platform: 'bilibili', metrics: JSON.stringify({ views: 50, likes: 1 }), createdAt: t, updatedAt: t },
    ])

    const ov = await buildOverview({ projectId: pid, days: 7 })
    check(ov.projects === 1, `projects=1（已删除项目排除；实际 ${ov.projects}）`)
    check(
      ov.runs.total === 4 &&
        ov.runs.byStatus['completed'] === 1 &&
        ov.runs.byStatus['failed'] === 1 &&
        ov.runs.byStatus['cancelled'] === 1 &&
        ov.runs.byStatus['queued'] === 1,
      `runs byStatus（${JSON.stringify(ov.runs.byStatus)}）`,
    )
    check(Math.abs(ov.runs.successRate - 1 / 3) < 1e-4, `successRate=completed/终态（${ov.runs.successRate}）`)
    check(near(ov.cost.total, 0.75) && near(ov.cost.last30d, 0.75), `cost total/last30d（${ov.cost.total} / ${ov.cost.last30d}）`)
    check(
      ov.assets.total === 2 && ov.assets.byKind['video'] === 1 && ov.assets.byKind['image'] === 1,
      `assets byKind（${JSON.stringify(ov.assets.byKind)}；已删除排除）`,
    )
    check(
      ov.activity.length === 7 && ov.activity[6]!.runs === 4 && near(ov.activity[6]!.cost, 0.75),
      `activity 逐日补零 7 天 / 今日 runs=4 cost=0.75（实际 ${ov.activity.length} 天 / runs=${ov.activity[6]!.runs}）`,
    )
    check(ov.activeDays === 1, `activeDays=1（实际 ${ov.activeDays}）`)
    check(
      ov.publications.total === 2 && ov.publications.views === 150 && ov.publications.interactions === 21,
      `publications 汇总（total=${ov.publications.total} v=${ov.publications.views} i=${ov.publications.interactions}）`,
    )

    // SQL 直查核对
    const qRuns = (await sqlite.execute(`SELECT COUNT(*) AS n FROM pipeline_runs WHERE project_id = ${pid}`)).rows[0] as unknown as { n: number }
    const qCost = (await sqlite.execute(`SELECT COALESCE(SUM(cost),0) AS c FROM usage_records WHERE project_id = ${pid}`)).rows[0] as unknown as { c: number }
    check(Number(qRuns.n) === ov.runs.total && near(Number(qCost.c), ov.cost.total), `SQL 直查核对（runs=${qRuns.n} cost=${qCost.c}）`)
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    migrate: sectionMigrate,
    usage: sectionUsage,
    batch: sectionBatch,
    export: sectionExport,
    stats: sectionStats,
  }
  const arg = process.argv.find((a) => a.startsWith('--section='))
  const wanted = arg ? arg.slice('--section='.length) : 'all'
  if (wanted !== 'all' && !(SECTIONS as readonly string[]).includes(wanted)) {
    log.error(`未知 section：${wanted}（已实现：${SECTIONS.join(' / ')}；all = 全部）`)
    process.exitCode = 1
    return
  }

  try {
    for (const name of wanted === 'all' ? SECTIONS : [wanted]) {
      console.log(`\n──── section: ${name} ────`)
      await runners[name]!()
    }
  } catch (err) {
    failed += 1
    console.error(`\n探针异常终止: ${(err as Error).stack ?? err}`)
  } finally {
    console.log(`\n==== M4 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    try {
      sqlite.close() // 释放 db 连接（Windows 下句柄可能仍被 libsql 持有 → 失败不阻断）
    } catch { /* 已关闭或未初始化 */ }
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : 0
  }
}

void main()
