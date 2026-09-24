/**
 * 批次与运行删除（记录级清理，不可恢复）——runs DELETE /routes 与 batches DELETE 两个入口共用：
 * - 仅终态 run 可删（queued/running/waiting_input 或引擎在途由路由层 409 拦截，先取消再删，与项目 purge 同口径）；
 * - 删除面：pipeline_steps + 该 run 的 gen_tasks + run 行；外键式引用解绑——
 *   创作会话.run_id 优先回落到该项目最近一次存活 run（删派生 run 不打断会话续跑，无存活 run 才置 NULL）；
 *   回落同时将存活 run 的 input.recipe 对齐到会话批准锚点（仅端点漂移差时），否则锚点已随被删派生 run 前进会与旧 run 失配、下次续跑被拒；
 *   剧集.latest_run_id 直接置 NULL（为 null 时列表回退行状态优雅降级，且跨项目无法可靠定位「上一集 run」，宁可解绑不指错）；
 * - 保留面：assets 与 usage_records 不动——续跑链会复用源 run 已成功产物（删源 run 连坐素材会打断派生 run），
 *   成本流水是会计事实不应随记录消失；磁盘文件因此不删（素材清理走资产删除入口）；
 * - run 日志文件随记录一并删除（纯排障产物，无外部引用；事务提交后执行，失败仅告警）。
 */
import { desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { creationSessions, episodes, genTasks, pipelineRuns, pipelineSteps } from '../db/schema'
import { createLogger } from '../logger'
import { RUN_LOGS_DIR } from '../env'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const log = createLogger('run-delete')

/** 终态口径（与 batch.ts TERMINAL 一致）：仅终态可删 */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled']

type Executor = Pick<typeof db, 'delete' | 'update' | 'select'>

/** 批量删 run 记录（单事务）：steps → tasks → run 行 → 解绑外部引用；返回各面删除计数 */
export async function purgeRunRecords(runIds: number[]): Promise<{ runs: number; steps: number; tasks: number }> {
  if (!runIds.length) return { runs: 0, steps: 0, tasks: 0 }
  return db.transaction(async (tx) => {
    const cnt = async (rows: Promise<{ id: number }[]>) => (await rows).length
    const steps = await cnt(tx.delete(pipelineSteps).where(inArray(pipelineSteps.runId, runIds)).returning({ id: pipelineSteps.id }))
    const tasks = await cnt(tx.delete(genTasks).where(inArray(genTasks.runId, runIds)).returning({ id: genTasks.id }))
    const runs = await cnt(tx.delete(pipelineRuns).where(inArray(pipelineRuns.id, runIds)).returning({ id: pipelineRuns.id }))
    await unbindRunRefs(tx, runIds)
    return { runs, steps, tasks }
  })
}

/** 解绑指向已删 run 的引用（会话当前 run 回落存活 run / 剧集最近 run 置空）；必须在同一事务内（run 行已先删，此处 select 见删后态） */
export async function unbindRunRefs(executor: Executor, runIds: number[]): Promise<void> {
  const t = Date.now()
  // 会话：删的是会话当前 run（常见于续跑链末端派生 run）→ 回落到同项目最近一次存活 run，
  // 保住制作进度展示与续跑入口；项目内已无存活 run 才置 NULL（会话退纯规划态）。
  const orphans = await executor
    .select({ id: creationSessions.id, projectId: creationSessions.projectId, approvedPlan: creationSessions.approvedPlan })
    .from(creationSessions)
    .where(inArray(creationSessions.runId, runIds))
  for (const s of orphans) {
    const survivor = (await executor
      .select({ id: pipelineRuns.id, input: pipelineRuns.input })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.projectId, s.projectId))
      .orderBy(desc(pipelineRuns.id))
      .limit(1))[0]
    await executor.update(creationSessions).set({ runId: survivor?.id ?? null, updatedAt: t }).where(eq(creationSessions.id, s.id))
    // 回落目标可能是漂移前的旧 run：批准锚点已随被删的派生 run 前进（配置漂移重钉）→ 二者 recipe 失配，
    // 下次续跑 assertRecipeSources 抛裸错被路由吞成 503「创作请求未完成」。把存活 run 的 input.recipe
    // 前向对齐到批准锚点（等价一次不落库的 re-pin），恢复可续跑。
    if (survivor && s.approvedPlan) await alignRunRecipeToApproval(executor, survivor.id, survivor.input, s.approvedPlan, t)
  }
  await executor.update(episodes).set({ latestRunId: null, updatedAt: t }).where(inArray(episodes.latestRunId, runIds))
}

/** 将存活 run 的 input.recipe 对齐到会话批准锚点（仅「端点漂移差」可安全整段对齐，否则会与 run.input 其余键不自洽）。 */
async function alignRunRecipeToApproval(
  executor: Executor,
  runId: number,
  inputRaw: string | null,
  approvedPlan: string,
  t: number,
): Promise<void> {
  let input: Record<string, unknown>
  try { input = JSON.parse(inputRaw ?? '') as Record<string, unknown> } catch { return }
  // 非创作 run（无 recipe 键）或已一致 → 不写
  if (typeof input.recipe !== 'string' || input.recipe === approvedPlan) return
  let a: Record<string, unknown>
  let o: Record<string, unknown>
  try {
    a = JSON.parse(approvedPlan) as Record<string, unknown>
    o = JSON.parse(input.recipe) as Record<string, unknown>
  } catch { return }
  // 仅 plan/sources/templateHash 全一致（即仅端点差）才对齐；否则保留原样（宁可留给用户核验，不盲改历史快照）
  if (JSON.stringify(a.plan) !== JSON.stringify(o.plan)
    || JSON.stringify(a.sources) !== JSON.stringify(o.sources)
    || a.templateHash !== o.templateHash) return
  await executor.update(pipelineRuns).set({ input: JSON.stringify({ ...input, recipe: approvedPlan }), updatedAt: t }).where(eq(pipelineRuns.id, runId))
}

/** run 终态守卫（路由层共用）：非终态或引擎在途 → 不可删 */
export function isRunDeletable(status: string, running: boolean): boolean {
  return TERMINAL_RUN_STATUSES.includes(status) && !running
}

/** 事后清理 run 日志文件（事务提交后调用；失败仅告警，不影响数据一致性） */
export function removeRunLogFiles(runIds: number[]): void {
  for (const id of runIds) {
    try {
      rmSync(join(RUN_LOGS_DIR, `${id}.log`), { force: true })
    } catch (err) {
      log.warn(`run ${id} 日志文件清理失败：${(err as Error).message}`)
    }
  }
}
