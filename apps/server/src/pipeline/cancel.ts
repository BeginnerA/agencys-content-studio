/**
 * 流水线取消协作单一真源（阶段二 F02 收口）
 * - 引擎 cancelRun 只置 run.status='cancelled'；运行中的 action 不可被强杀（engine.ts 注释语义），
 *   只能由付费动作在「提交下一笔第三方请求前」主动轮询此信号 cooperative 退出。
 * - ai_text / ai_image / ai_video / tts 四个逐子项付费动作共用本函数（此前逐字重复三份，现收敛为单一真源）。
 */
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { pipelineRuns } from '../db/schema'

/** run 是否已取消（cancelled 终态）；供 action 在每次提交第三方计费请求前检查 */
export async function runCancelled(runId: number): Promise<boolean> {
  const rows = await db
    .select({ status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1)
  return rows[0]?.status === 'cancelled'
}
