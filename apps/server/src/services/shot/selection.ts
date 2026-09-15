import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { assets, genTasks, pipelineRuns, pipelineSteps, type GenTask } from '../../db/schema'
import { WORKBENCH_ACTIONS, WorkbenchError, parseOutputJson, shotIdOfAsset } from './helpers'
import { assertRepairable, resolveStoryboardSource } from './inspect'

export interface ShotPick {
  shot_id: string
  asset_id: number
}

// ---------- 单镜重生成 ----------

/**
 * 单镜重生成：校验 + 重置（task 保留 resultAssetId 作历史 / step pending / run queued）。
 * 路由层随后 engine.startRun——action 幂等段「succeeded 任务跳过」只重跑目标镜。
 */
export async function resetShotForRegenerate(
  runId: number,
  stepKey: string,
  shotId: string,
): Promise<{ runId: number; taskId: number }> {
  if (typeof shotId !== 'string' || !shotId) throw new WorkbenchError('bad_shot', 'shot_id 非法')
  const { run, step } = await assertRepairable(runId, stepKey, WORKBENCH_ACTIONS)

  const tasks = await db
    .select()
    .from(genTasks)
    .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, step.id)))
  let target: GenTask | null = null
  for (const t of tasks) {
    try {
      const p = JSON.parse(t.params) as { shotId?: string }
      if (p.shotId === shotId) {
        target = t
        break
      }
    } catch {
      // 参数损坏行跳过
    }
  }
  if (!target) throw new WorkbenchError('no_task', `镜头 ${shotId} 无对应生成任务`)

  const now = Date.now()
  await db
    .update(genTasks)
    .set({ status: 'pending', attempts: 0, errorMsg: null, completedAt: null, updatedAt: now })
    .where(eq(genTasks.id, target.id))
  await db
    .update(pipelineSteps)
    .set({ status: 'pending', error: null, completedAt: null, updatedAt: now })
    .where(eq(pipelineSteps.id, step.id))
  await db
    .update(pipelineRuns)
    .set({ status: 'queued', error: null, completedAt: null, currentStepKey: null, updatedAt: now })
    .where(eq(pipelineRuns.id, run.id))
  return { runId: run.id, taskId: target.id }
}

// ---------- 多版本选片 / 选镜 ----------

/**
 * 选片/选镜：picks 校验 + 改写 output.asset_ids（分镜序保序；子集语义 = 未列入的镜头剔除）。
 * reset=true → 恢复全量最新（分镜序 × 每镜 task.resultAssetId）。不触发执行。
 */
export async function applyShotSelection(
  runId: number,
  stepKey: string,
  opts: { picks?: ShotPick[]; reset?: boolean },
): Promise<{ assetIds: number[] }> {
  const { run, step } = await assertRepairable(runId, stepKey, WORKBENCH_ACTIONS)
  const src = await resolveStoryboardSource(run, step)

  const tasks = await db
    .select()
    .from(genTasks)
    .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, step.id)))
  const taskIds = new Set(tasks.map((t) => t.id))
  const shotOrder = new Map(src.shots.map((s, i) => [s.id, i]))
  const kindNeed = step.actionKey === 'ai_video' ? 'video' : 'image'

  let nextIds: number[]
  if (opts.reset) {
    // 恢复全量最新：分镜序 × 每镜 task.resultAssetId（无产物镜跳过）
    const taskByShotId = new Map<string, GenTask>()
    for (const t of tasks) {
      try {
        const p = JSON.parse(t.params) as { shotId?: string }
        if (p.shotId && !taskByShotId.has(p.shotId)) taskByShotId.set(p.shotId, t)
      } catch {
        // 跳过
      }
    }
    nextIds = []
    for (const s of src.shots) {
      const t = taskByShotId.get(s.id)
      if (t?.resultAssetId) nextIds.push(t.resultAssetId)
    }
  } else {
    const picks = opts.picks
    if (!Array.isArray(picks) || picks.length === 0) {
      throw new WorkbenchError('bad_picks', 'picks 需为非空数组（或 reset=true）')
    }
    const seen = new Set<string>()
    const rows: Array<{ shotId: string; assetId: number }> = []
    for (const p of picks) {
      if (!p || typeof p.shot_id !== 'string' || !p.shot_id) throw new WorkbenchError('bad_picks', 'shot_id 非法')
      if (!Number.isInteger(p.asset_id) || p.asset_id <= 0) throw new WorkbenchError('bad_picks', `镜头 ${p.shot_id} asset_id 非法`)
      if (seen.has(p.shot_id)) throw new WorkbenchError('bad_picks', `镜头 ${p.shot_id} 重复提交`)
      seen.add(p.shot_id)
      if (!shotOrder.has(p.shot_id)) throw new WorkbenchError('unknown_shot', `镜头 ${p.shot_id} 不在分镜中`)
      rows.push({ shotId: p.shot_id, assetId: p.asset_id })
    }
    // 资产级校验矩阵（一次查询）
    const assetRows = await db.select().from(assets).where(inArray(assets.id, rows.map((r) => r.assetId)))
    const byId = new Map(assetRows.map((a) => [a.id, a]))
    for (const r of rows) {
      const a = byId.get(r.assetId)
      if (!a) throw new WorkbenchError('bad_asset', `资产 #${r.assetId} 不存在`)
      if (a.projectId !== run.projectId) throw new WorkbenchError('bad_asset', `资产 #${r.assetId} 不属于本项目`)
      if (a.deletedAt) throw new WorkbenchError('bad_asset', `资产 #${r.assetId} 已删除`)
      if (a.kind !== kindNeed) throw new WorkbenchError('bad_asset', `资产 #${r.assetId} 类型不符（需 ${kindNeed}）`)
      if (shotIdOfAsset(a) !== r.shotId) throw new WorkbenchError('bad_asset', `资产 #${r.assetId} 与镜头 ${r.shotId} 不匹配`)
      if (a.taskId != null) {
        if (!taskIds.has(a.taskId)) throw new WorkbenchError('bad_asset', `资产 #${r.assetId} 不属于该步骤生成任务`)
      } else if (a.stepId !== step.id || a.runId !== run.id) {
        // [M10] 上传资产（taskId=null）：须为本步骤本 run 的入库行
        throw new WorkbenchError('bad_asset', `资产 #${r.assetId} 不属于该步骤上传资产`)
      }
    }
    // 分镜序保序（picks 提交序忽略）
    rows.sort((x, y) => shotOrder.get(x.shotId)! - shotOrder.get(y.shotId)!)
    nextIds = rows.map((r) => r.assetId)
  }

  const out = parseOutputJson(step.output)
  await db
    .update(pipelineSteps)
    .set({ output: JSON.stringify({ ...out, asset_ids: nextIds }), updatedAt: Date.now() })
    .where(eq(pipelineSteps.id, step.id))
  return { assetIds: nextIds }
}
