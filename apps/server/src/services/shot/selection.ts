import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { assets, genTasks, pipelineRuns, pipelineSteps, type GenTask, type PipelineRun } from '../../db/schema'
import { WORKBENCH_ACTIONS, WorkbenchError, parseOutputJson, shotIdOfAsset, requeuePatch } from './helpers'
import { isCreationTemplate, recipeOf } from '../creation-chat/recipe'
import { checkBudget } from '../budget'
import { resolveUnitPrice } from '../usage'
import { assertRepairable, resolveStoryboardSource } from './inspect'

export interface ShotPick {
  shot_id: string
  asset_id: number
}

// ---------- 单镜重生成 ----------

/**
 * 单镜重生成：校验 + 重置（task 保留 resultAssetId 作历史 / step pending / run queued）。
 * 路由层随后 engine.startRun——action 幂等段「succeeded 任务跳过」只重跑目标镜。
 *
 * 审阅闸门暂停（gatePause）：run 与本步同时 waiting_input 时，允许对挂闸生成步做同提示词单镜重出
 * （首帧审阅时挑出不满意的一镜重投）；不改分镜/不动批准链，仅补一次服务端预算门禁。
 */
export async function resetShotForRegenerate(
  runId: number,
  stepKey: string,
  shotId: string,
): Promise<{ runId: number; taskId: number }> {
  if (typeof shotId !== 'string' || !shotId) throw new WorkbenchError('bad_shot', 'shot_id 非法')
  const { run, step, gatePause } = await assertRepairable(runId, stepKey, WORKBENCH_ACTIONS, { allowGatePause: true })
  // 轻松创作批准链：常规（已完成/失败）额外生成仍须回会话费用确认通道；
  // 但审阅闸门暂停下的「同提示词单镜重出」不改分镜、不越批准链（ai_image 参数变化守卫不触发），
  // 属审阅环节内正当操作，放行——仅补一次服务端预算门禁（与断点续跑/会话返修同源 checkBudget）。
  if (isCreationTemplate(run.templateKey) && !gatePause) {
    throw new WorkbenchError('creation_confirmation_required', '额外镜头生成需复制需求并确认新方案；失败恢复请回轻松创作', 409)
  }

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

  // 闸门重出前服务端预算门禁：按单张图计费，超限即拦（未知价 → 不拦，客户端确认已提示重新计费）
  if (gatePause) {
    const cost = await estimateGateRerollCost(run, target)
    if (cost !== null) {
      const budget = await checkBudget({ projectId: run.projectId, estimatedCost: cost })
      if (budget) throw new WorkbenchError(budget.code, budget.message, 409)
    }
  }

  const now = Date.now()
  // 单镜重生成（用户点“重出该镜”）→ regen=true 清外部 task_id，令引擎重新提交而非续轮询旧成片（requeuePatch 单一真源，
  // 与 resetStepForRerun / resetChainForRerun / [F03] 同规则）；失败重试/续跑保留 task_id 的语义在本入口不适用。
  await db
    .update(genTasks)
    .set(requeuePatch(true, now))
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

/**
 * 审阅闸门单镜重出的费用估算（一张图）：轻松创作取批准实例单价，否则按任务供应商/型号解析当前单价；
 * 未知（无快照价且解析不出）→ null，调用方据此跳过预算拦截（不臆造成费用）。
 */
async function estimateGateRerollCost(run: PipelineRun, task: GenTask): Promise<number | null> {
  try {
    const recipe = recipeOf(run)
    if (recipe) return recipe.endpoints.image?.unitPrice ?? null
    return await resolveUnitPrice({ kind: 'image', unit: 'image', provider: task.provider, model: task.model })
  } catch {
    return null
  }
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
  // 续跑继承产物：succeeded 任务的 resultAssetId 可指向旧 run 资产（其行 task_id 仍属旧任务）。
  // board 版本组已按引用并入这类资产（展示可选）→ 校验同口径放行，否则合并全量 picks 时
  // 未被动过的复用镜会把整单改选拦死在「不属于该步骤生成任务」（仅限本步任务的当前产物，不放宽到任意跨 run 资产）。
  const carriedResultIds = new Set(
    tasks.filter((t) => t.status === 'succeeded' && t.resultAssetId != null).map((t) => t.resultAssetId as number),
  )
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
        if (!taskIds.has(a.taskId) && !carriedResultIds.has(r.assetId)) throw new WorkbenchError('bad_asset', `资产 #${r.assetId} 不属于该步骤生成任务`)
      } else if (a.stepId !== step.id || a.runId !== run.id) {
        // 上传资产（taskId=null）：须为本步骤本 run 的入库行
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
