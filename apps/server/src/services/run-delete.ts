/**
 * 批次与运行删除（记录级清理，不可恢复）——runs DELETE /routes 与 batches DELETE 两个入口共用：
 * - 仅终态 run 可删（queued/running/waiting_input 或引擎在途由路由层 409 拦截，先取消再删，与项目 purge 同口径）；
 * - 删除面：pipeline_steps + 该 run 的 gen_tasks + run 行；外键式引用解绑
 *   （creation_sessions.run_id / episodes.latest_run_id 置 NULL，防会话/剧集卡片指向已删 run）；
 * - 保留面：assets 与 usage_records 不动——续跑链会复用源 run 已成功产物（删源 run 连坐素材会打断派生 run），
 *   成本流水是会计事实不应随记录消失；磁盘文件因此不删（素材清理走资产删除入口）；
 * - run 日志文件随记录一并删除（纯排障产物，无外部引用；事务提交后执行，失败仅告警）。
 */
import { inArray } from 'drizzle-orm'
import { db } from '../db'
import { creationSessions, episodes, genTasks, pipelineRuns, pipelineSteps } from '../db/schema'
import { createLogger } from '../logger'
import { RUN_LOGS_DIR } from '../env'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const log = createLogger('run-delete')

/** 终态口径（与 batch.ts TERMINAL 一致）：仅终态可删 */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled']

type Executor = Pick<typeof db, 'delete' | 'update'>

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

/** 解绑指向已删 run 的引用（会话当前 run / 剧集最近 run）；必须在同一事务内 */
export async function unbindRunRefs(executor: Executor, runIds: number[]): Promise<void> {
  const t = Date.now()
  await executor.update(creationSessions).set({ runId: null, updatedAt: t }).where(inArray(creationSessions.runId, runIds))
  await executor.update(episodes).set({ latestRunId: null, updatedAt: t }).where(inArray(episodes.latestRunId, runIds))
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
