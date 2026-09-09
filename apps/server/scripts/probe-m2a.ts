/**
 * M2a 编排语义探针（spec §10 验收 1/2 引擎侧）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m2a.ts
 *
 * 隔离策略：CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录（独立 studio.db +
 * workspace），不触碰开发库；全部步骤用 manual_ingest（无 LLM/网络依赖，仅写文本资产）。
 *
 * 覆盖场景：
 *   run1 (fast=true)  ① when 互斥分支选路（s2 走 / s3 跳过 when_condition）
 *                     ② 含 skipped 依赖的汇合步正常执行（s4）
 *                     ③ 纯 skipped 链自动传播 upstream_skipped（s5）
 *                     ④ gate skip 免审放行：产物保留 + output.skipped user_skip（s6）
 *                     ⑤ gate.when 不满足 → 免审直过不挂起（s7）
 *                     ⑥ 挂起中在线改模板 → 本 run 步骤集与快照一致（s8_extra 不出现）
 *   run2 (fast=false) 反向分支选路 + 条件门挂起-批准 + steps.x.count 条件求值 +
 *                     新 run 反映修改后模板（s8_extra 出现且执行）
 *
 * 退出码：0 = 全部断言通过；1 = 有失败。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根（apps/server 的上上级）

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
const TMP = mkdtempSync(join(tmpdir(), 'acs-probe-m2a-'))
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
// db 模块顶层同步打开库文件：目录需先存在（其余子目录由 initDb 的 ensureDirs 建）
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

// ---- 探针模板（V1：7 步；V2 = V1 + s8_extra，模拟运行中在线改模板）----
const TPL_V1 = `key: probe-m2a
version: 1
name: M2a 编排语义探针
description: 引擎 DAG 编排语义回归（when/skip/gate/快照）
genre: other
inputs:
  - key: brief
    label: 简报
    kind: text
    required: true
  - key: fast
    label: 快速分支开关
    kind: bool
    required: true
steps:
  - key: s1_ingest
    action: manual_ingest
    title: 入库
    inputs:
      brief: input.brief
  - key: s2_fast_on
    action: manual_ingest
    title: 快速分支执行
    when: input.fast == true
    inputs:
      brief: input.brief
  - key: s3_fast_off
    action: manual_ingest
    title: 慢速分支执行
    after: [s1_ingest]
    when: input.fast == false
    inputs:
      brief: input.brief
  - key: s4_merge
    action: manual_ingest
    title: 分支汇合
    after: [s2_fast_on, s3_fast_off]
    inputs:
      brief: input.brief
  - key: s5_tail_off
    action: manual_ingest
    title: 慢分支下游
    after: [s3_fast_off]
    inputs:
      brief: input.brief
  - key: s6_gate_skip
    action: manual_ingest
    title: 闸门免审放行点
    after: [s4_merge]
    gate:
      mode: required
      message: 探针审阅点
      skip_label: 免审直接继续
      when: input.fast == true
    inputs:
      brief: input.brief
  - key: s7_gate_auto
    action: manual_ingest
    title: 条件门直过点
    after: [s6_gate_skip]
    gate:
      mode: required
      message: fast=true 时 gate.when 不满足应直过
      when: input.fast == false
    inputs:
      brief: input.brief
`

const EXTRA_STEP = `  - key: s8_extra
    action: manual_ingest
    title: 模板热改后新增步骤
    when: steps.s7_gate_auto.count >= 1
    inputs:
      brief: input.brief
`
const TPL_V2 = `${TPL_V1}${EXTRA_STEP}`

const TPL_FILE = join(TMP, 'workspace', 'templates', 'probe-m2a.yaml')

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { initDb, db } = await import('../src/db')
  const { projects, pipelineRuns, pipelineSteps } = await import('../src/db/schema')
  const { loadTemplate, templateForRun } = await import('../src/pipeline/loader')
  const { engine } = await import('../src/pipeline/engine')
  const { asc, eq } = await import('drizzle-orm')
  const { createLogger } = await import('../src/logger')

  const log = createLogger('probe')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const stepRowsOf = async (runId: number) =>
    db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId)).orderBy(asc(pipelineSteps.seq))

  const runOf = async (runId: number) => {
    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
    return rows[0]!
  }

  interface OutputDoc {
    asset_ids?: number[]
    skipped?: { reason?: string }
    gate?: { decision?: string }
  }

  const parseOut = (s: { output: string | null }): OutputDoc => {
    try {
      return JSON.parse(s.output ?? '{}') as OutputDoc
    } catch {
      return {}
    }
  }

  /** 轮询至谓词满足（探针无时间敏感性，10s 足够 manual_ingest 全链秒级完成） */
  const pollUntil = async <T>(label: string, fn: () => Promise<T | null | undefined>, timeoutMs = 10000): Promise<T> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > deadline) throw new Error(`超时等待: ${label}`)
      await sleep(150)
    }
  }

  /** 等 run 进入终态/挂起 且 引擎线程已让出（active 清空后再决策，避免 startRun 幂等吞决策） */
  const waitRunIdle = (runId: number, wantStatus: string): Promise<void> =>
    pollUntil(`run ${runId} → ${wantStatus}`, async () => {
      const run = await runOf(runId)
      return run.status === wantStatus && !engine.isRunning(runId) ? run : null
    }).then(() => undefined)

  try {
    // ---- 初始化隔离库 + 写入探针模板 V1 ----
    const journal = join(REPO_ROOT, 'apps', 'server', 'drizzle', 'meta', '_journal.json')
    if (!existsSync(journal)) throw new Error(`迁移目录未解析到正确仓库根（期望 ${journal}）`)
    await initDb()
    writeFileSync(TPL_FILE, TPL_V1, 'utf8')
    const tplV1 = loadTemplate('probe-m2a')
    check(tplV1.steps.length === 7, `模板 V1 加载通过（steps=${tplV1.steps.length}）`)
    log.info('隔离环境', { data: process.env.CSTUDIO_DATA, workspace: process.env.CSTUDIO_WORKSPACE })

    const t = Date.now()
    const proj = (
      await db
        .insert(projects)
        .values({ name: 'M2a 探针项目', genre: 'other', templateKey: 'probe-m2a', settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!
    log.info(`project #${proj.id} 已建`)

    const insertRun = async (fast: boolean) => {
      const tpl = loadTemplate('probe-m2a')
      const input = { brief: '探针简报：验证引擎编排语义', fast }
      const now = Date.now()
      const run = (
        await db
          .insert(pipelineRuns)
          .values({
            projectId: proj.id,
            templateKey: 'probe-m2a',
            status: 'queued',
            input: JSON.stringify(input),
            templateSnapshot: JSON.stringify(tpl),
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0]!
      return run.id
    }

    // ================= run1：编排语义（fast=true） =================
    log.info('── run1 (fast=true) 编排语义实弹 ──')
    const run1Id = await insertRun(true)
    const snap1 = await runOf(run1Id)
    const snapTpl = JSON.parse(snap1.templateSnapshot!) as { steps: Array<{ key: string; gate?: { skip_label?: string } }> }
    check(
      snapTpl.steps.find((s) => s.key === 's6_gate_skip')?.gate?.skip_label === '免审直接继续',
      '快照固化了 gate.skip_label 声明',
    )

    engine.startRun(run1Id)
    await waitRunIdle(run1Id, 'waiting_input')
    log.info('run1 已挂起 waiting_input（s6_gate_skip）')

    // 门控收敛观测：挂起期间后续步骤不得启动
    const hangSteps = await stepRowsOf(run1Id)
    const hangMap = new Map(hangSteps.map((s) => [s.stepKey, s]))
    check(hangMap.get('s6_gate_skip')?.status === 'waiting_input', '挂起步骤处于 waiting_input')
    check(hangMap.get('s7_gate_auto')?.status === 'pending', '并行收敛：挂起后后续步骤保持 pending')
    check((await runOf(run1Id)).currentStepKey === 's6_gate_skip', 'run.currentStepKey 指向等待步')

    // 在线改模板（模拟 Web 模板编辑保存：写文件 + 强制刷新缓存）→ 本 run 不受影响
    writeFileSync(TPL_FILE, TPL_V2, 'utf8')
    const tplV2 = loadTemplate('probe-m2a', true)
    check(tplV2.steps.length === 8, `模板热改为 V2（steps=${tplV2.steps.length}）`)
    log.info('模板文件已在线修改（V1→V2 追加 s8_extra）')

    await engine.skipGate(run1Id, 's6_gate_skip', { note: '探针：免审放行' })
    await pollUntil('run1 completed', async () => (await runOf(run1Id)).status === 'completed')
    const run1 = await runOf(run1Id)
    const run1Steps = await stepRowsOf(run1Id)
    const m1 = new Map(run1Steps.map((s) => [s.stepKey, s]))

    log.info('run1 断言：')
    check(run1.status === 'completed', 'run1 达到 completed')
    check(run1Steps.length === 7, `步骤集与快照一致（7 行，实际 ${run1Steps.length}）`)
    check(!m1.has('s8_extra'), '快照隔离：运行中新增步骤未进入本 run')
    check(m1.get('s1_ingest')?.status === 'succeeded', 's1 入库 succeeded')
    check(m1.get('s2_fast_on')?.status === 'succeeded', 's2 when 分支选中 → succeeded')
    const s3 = m1.get('s3_fast_off')!
    check(s3.status === 'skipped' && parseOut(s3).skipped?.reason === 'when_condition', 's3 when 互斥分支 → skipped(when_condition)')
    check(m1.get('s4_merge')?.status === 'succeeded', 's4 汇合（依赖含 skipped）正常执行')
    const s5 = m1.get('s5_tail_off')!
    check(s5.status === 'skipped' && parseOut(s5).skipped?.reason === 'upstream_skipped', 's5 纯 skipped 链自动传播 skipped(upstream_skipped)')
    const s6 = m1.get('s6_gate_skip')!
    const s6o = parseOut(s6)
    check(s6.status === 'succeeded' && s6o.skipped?.reason === 'user_skip', 's6 gate skip 免审放行 → succeeded(user_skip)')
    check(Array.isArray(s6o.asset_ids) && s6o.asset_ids.length === 1, 's6 免审放行产物保留（asset_ids=1）')
    check(m1.get('s7_gate_auto')?.status === 'succeeded', 's7 gate.when 不满足 → 免审直过 succeeded（未挂起）')

    // ================= run2：改后模板新 run（fast=false） =================
    log.info('── run2 (fast=false) 新 run 反映改后模板 ──')
    const run2Id = await insertRun(false)
    engine.startRun(run2Id)
    await waitRunIdle(run2Id, 'waiting_input')
    log.info('run2 已挂起 waiting_input（s7_gate_auto）')
    await engine.approveGate(run2Id, 's7_gate_auto', { note: '探针：批准' })
    await pollUntil('run2 completed', async () => (await runOf(run2Id)).status === 'completed')

    const run2 = await runOf(run2Id)
    const run2Steps = await stepRowsOf(run2Id)
    const m2 = new Map(run2Steps.map((s) => [s.stepKey, s]))
    log.info('run2 断言：')
    check(run2.status === 'completed', 'run2 达到 completed')
    check(run2Steps.length === 8, `新 run 反映改后模板（8 行，实际 ${run2Steps.length}）`)
    check(m2.get('s2_fast_on')?.status === 'skipped', '反向选路：s2 skipped')
    check(m2.get('s3_fast_off')?.status === 'succeeded', '反向选路：s3 succeeded')
    check(m2.get('s4_merge')?.status === 'succeeded', 's4 汇合 succeeded（s2 skipped + s3 succeeded）')
    check(m2.get('s5_tail_off')?.status === 'succeeded', 's5 尾随 succeeded 分支正常执行')
    check(m2.get('s6_gate_skip')?.status === 'succeeded', 's6 gate.when(fast==true) 不满足 → 直过 succeeded')
    check(m2.get('s7_gate_auto')?.status === 'succeeded', 's7 条件门挂起-批准后 succeeded')
    const s8 = m2.get('s8_extra')!
    const s8o = parseOut(s8)
    check(s8.status === 'succeeded' && s8o.skipped === undefined, 's8 steps.x.count>=1 条件满足 → 执行 succeeded')
    check(s8o.asset_ids?.length === 1, 's8 产物落库（asset_ids=1）')

    // 快照与当前文件一致性：run2 快照应含 s8_extra（创建时模板已热改）
    const snap2 = await runOf(run2Id)
    const snap2Tpl = JSON.parse(snap2.templateSnapshot!) as { steps: Array<{ key: string }> }
    check(snap2Tpl.steps.some((s) => s.key === 's8_extra'), 'run2 快照含热改后步骤')
  } catch (err) {
    failed += 1
    console.error(`\n探针异常终止: ${(err as Error).stack ?? err}`)
  } finally {
    const verdict = failed === 0 ? '全部通过' : `${failed} 项失败`
    console.log(`\n==== M2a 探针结果: ${verdict} ====`)
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未清理（可手动删除）: ${TMP}`)
    }
    process.exitCode = failed === 0 ? 0 : 1
  }
}

void main()
