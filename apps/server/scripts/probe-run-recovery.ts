/**
 * 运行终态收敛探针——手动执行：
 *   cd apps/server && npx tsx scripts/probe-run-recovery.ts
 *
 * 症状回归：服务重启把 running run 置 failed(interrupted) 后，该 run 的步骤仍停在 running，
 * 运行画布节点因此永久显示「执行中」（即便该 run 早被新 run 续跑）。
 * 钉死不变式：run 处于终态（failed/cancelled）时其步骤不得停留 pending/running/waiting_input：
 *   1) 重启恢复：running run → failed，残留 running 步同步收敛
 *   2) 历史脏数据自愈：已 failed 的 run 残留 running 步在下次恢复对账时收敛
 *   3) 批次直置 cancelled：残留 pending 步同步收敛
 *   4) 合法态不被误改：waiting_input 闸门 / completed 全终态照旧
 *   5) 全库不变式查询：终态 run 无任何非终态步骤
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { and, eq, inArray } from 'drizzle-orm'
import { isolatedEnv, makeChecker } from './probe-lib'

const ENV = isolatedEnv('run-recovery')

async function main(): Promise<void> {
  const { initDb } = await import('../src/db')
  const { db, sqlite } = await import('../src/db')
  const { pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
  const { createLogger } = await import('../src/logger')
  const { recoverInterruptedState } = await import('../src/pipeline/engine')

  const log = createLogger('probe-run-recovery')
  const checker = makeChecker(log)
  const { check } = checker

  await initDb()

  const now = Date.now()
  const pid = (
    await db
      .insert(projects)
      .values({ name: 'run 终态收敛探针', genre: 'other', templateKey: 'probe-run-recovery', settings: '{}', tags: '[]', createdAt: now, updatedAt: now })
      .returning()
  )[0]!.id

  const mkRun = async (status: string, error: string | null = null): Promise<number> =>
    (
      await db
        .insert(pipelineRuns)
        .values({ projectId: pid, templateKey: 'probe-run-recovery', status, error, input: '{}', createdAt: now, updatedAt: now })
        .returning()
    )[0]!.id

  const mkStep = async (runId: number, seq: number, status: string): Promise<number> =>
    (
      await db
        .insert(pipelineSteps)
        .values({ runId, seq, stepKey: `s${seq}`, actionKey: 'manual_ingest', title: `步 ${seq}`, status, attempts: 1, createdAt: now, updatedAt: now })
        .returning()
    )[0]!.id

  const runRow = async (id: number) =>
    (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).limit(1))[0]!
  const stepRow = async (id: number) =>
    (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, id)).limit(1))[0]!

  // ---- 场景 1：重启打断（run running + 末步 running）----
  const rRestart = await mkRun('running')
  const sDone = await mkStep(rRestart, 0, 'succeeded')
  const sCut = await mkStep(rRestart, 1, 'running')

  // ---- 场景 2：历史脏数据（run 早已 failed，步仍 running —— 现场 Run #141 形态）----
  const rLegacy = await mkRun('failed', 'interrupted：服务重启。可在运行详情页「从断点续跑」（已完成步骤将跳过）')
  const sLegacy = await mkStep(rLegacy, 0, 'running')

  // ---- 场景 3：批次直置 cancelled（步未被 cancelRun 触碰，仍 pending）----
  const rBatchCancel = await mkRun('cancelled')
  const sBatchCancel = await mkStep(rBatchCancel, 0, 'pending')

  // ---- 场景 4：合法态（人工闸挂起 / 已完成全终态）----
  const rGate = await mkRun('waiting_input')
  const sGate = await mkStep(rGate, 0, 'waiting_input')
  const rDone = await mkRun('completed')
  const sDone2 = await mkStep(rDone, 0, 'succeeded')
  const sSkipped = await mkStep(rDone, 1, 'skipped')

  const { requeued } = await recoverInterruptedState()

  const rRestartAfter = await runRow(rRestart)
  check(rRestartAfter.status === 'failed', `重启恢复：run 置 failed（${rRestartAfter.status}）`)
  check(
    (await stepRow(sCut)).status === 'failed',
    `重启恢复：被打断的步骤收敛为 failed（实际 ${(await stepRow(sCut)).status}；不得停留 running → 画布不显示「执行中」）`,
  )
  check((await stepRow(sDone)).status === 'succeeded', '重启恢复：已完成步骤保持 succeeded')
  check((await stepRow(sLegacy)).status === 'failed', `历史脏数据自愈：已 failed run 的残留 running 步收敛（实际 ${(await stepRow(sLegacy)).status}）`)
  check((await runRow(rLegacy)).status === 'failed', '历史脏数据自愈：run 状态保持 failed')
  check((await stepRow(sBatchCancel)).status === 'cancelled', `批次直置 cancelled：残留 pending 步收敛（实际 ${(await stepRow(sBatchCancel)).status}）`)
  check((await stepRow(sGate)).status === 'waiting_input', '合法态：人工闸 waiting_input 步不被误改')
  check((await runRow(rGate)).status === 'waiting_input', '合法态：waiting_input run 不被误改')
  check((await stepRow(sDone2)).status === 'succeeded' && (await stepRow(sSkipped)).status === 'skipped', '合法态：completed run 的终态步骤不被误改')
  check(!requeued.includes(rRestart), 'requeue 仅含 queued run（不含被收敛的 failed）')

  // ---- 场景 5：幂等 + 全库不变式 ----
  await recoverInterruptedState()
  check((await stepRow(sCut)).status === 'failed' && (await stepRow(sLegacy)).status === 'failed', '恢复对账幂等（二次执行状态不变）')
  const dangling = (
    await sqlite.execute(
      `SELECT COUNT(*) AS c FROM pipeline_steps s JOIN pipeline_runs r ON r.id = s.run_id
       WHERE r.status IN ('failed','cancelled') AND s.status IN ('pending','running','waiting_input')`,
    )
  ).rows[0] as unknown as { c: number }
  check(Number(dangling.c) === 0, `全库不变式：终态 run 无非终态步骤（残留 ${dangling.c}）`)

  // ---- 场景 6：该 run 的画布节点状态随步骤收敛（画布读取 step.status）----
  const legacyNodes = await db
    .select({ status: pipelineSteps.status })
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, rLegacy), inArray(pipelineSteps.status, ['running', 'pending', 'waiting_input'])))
  check(legacyNodes.length === 0, '画布面：该 run 不再有「执行中/等待」节点')

  console.log(`\n==== run 终态收敛探针结果: ${checker.failed > 0 ? `${checker.failed} 项失败` : '全部通过'} ====`)
  process.exitCode = checker.failed > 0 ? 1 : 0
}

try {
  await main()
} catch (err) {
  console.error(`探针异常终止: ${(err as Error).stack ?? String(err)}`)
  process.exitCode = 1
} finally {
  ENV.cleanup()
}
