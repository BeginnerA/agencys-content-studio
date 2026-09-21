import { and, asc, eq, ne } from 'drizzle-orm'
import { db } from '../../db'
import { genTasks, pipelineRuns, pipelineSteps, type PipelineStep } from '../../db/schema'
import { cleanupVersions, type CleanupResult } from '../version-cleanup'
import { WORKBENCH_ACTIONS, WorkbenchError, parseOutputJson, selectedMapOf, sameIds, toIdArray, type ShotSpec } from './helpers'
import { assertRepairable, assertChainRepairable } from './inspect'

// ---------- 重新合成 ----------

/** 重新合成：校验 + 重置 ffmpeg_merge 步骤 / run。路由层随后 engine.startRun（succeeded 镜头步骤全跳过）。 */
export async function resetStepForRecompose(runId: number, stepKey: string): Promise<{ runId: number }> {
  const { run, step } = await assertRepairable(runId, stepKey, ['ffmpeg_merge'])
  const now = Date.now()
  await db
    .update(pipelineSteps)
    .set({ status: 'pending', error: null, completedAt: null, updatedAt: now })
    .where(eq(pipelineSteps.id, step.id))
  await db
    .update(pipelineRuns)
    .set({ status: 'queued', error: null, completedAt: null, currentStepKey: null, updatedAt: now })
    .where(eq(pipelineRuns.id, run.id))
  return { runId: run.id }
}

// ---------- [M12] 版本清理 ----------

/**
 * [M12] 工作台版本清理：校验工作台步骤 → 委托 version-cleanup。
 * 保留规则：组内最新 / isFavorite / 被引用（在用）；其余软删（可回溯）。不触发执行。
 */
export async function cleanupShotVersions(
  runId: number,
  stepKey: string,
): Promise<CleanupResult & { runId: number; stepKey: string }> {
  const { run, step } = await assertRepairable(runId, stepKey, WORKBENCH_ACTIONS)
  const result = await cleanupVersions({ projectId: run.projectId, runId: run.id, stepId: step.id })
  return { ...result, runId: run.id, stepKey: step.stepKey }
}

// ---------- [M11] 引擎级单步重跑 ----------

/**
 * [M11] 单步重跑（引擎级——不限 action）：assertRepairable → 可选子任务归零 →
 * step pending / run queued；路由层随后 engine.startRun（succeeded 步骤全跳过，仅执行目标步）。
 * - resetTasks=false（默认）：不动 gen_tasks——action 幂等段「succeeded 跳过 / failed 归零」自动生效；
 * - resetTasks=true：该步全部任务置 pending（resultAssetId 保留作历史）→ 全量重新执行（计费）；
 * - 无任务型步骤（ai_text 单跑 / tts / ffmpeg_merge → hasTasks=false 选项忽略）。
 */
export async function resetStepForRerun(
  runId: number,
  stepKey: string,
  opts: { resetTasks?: boolean },
): Promise<{
  runId: number
  stepKey: string
  hasTasks: boolean
  tasksTotal: number
  tasksSucceeded: number
  tasksReset: number
}> {
  const { run, step } = await assertRepairable(runId, stepKey)
  if (run.templateKey === 'easy-video') throw new WorkbenchError('creation_confirmation_required', '已批准制作链请在轻松创作中恢复；额外生成需新方案确认', 409)
  const tasks = await db
    .select({ id: genTasks.id, status: genTasks.status })
    .from(genTasks)
    .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, step.id)))
  const succeeded = tasks.filter((t) => t.status === 'succeeded').length
  const resetTasks = opts.resetTasks === true
  const now = Date.now()
  if (resetTasks && tasks.length > 0) {
    await db
      .update(genTasks)
      .set({ status: 'pending', attempts: 0, errorMsg: null, completedAt: null, updatedAt: now })
      .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, step.id)))
  }
  await db
    .update(pipelineSteps)
    .set({ status: 'pending', error: null, completedAt: null, updatedAt: now })
    .where(eq(pipelineSteps.id, step.id))
  await db
    .update(pipelineRuns)
    .set({ status: 'queued', error: null, completedAt: null, currentStepKey: null, updatedAt: now })
    .where(eq(pipelineRuns.id, run.id))
  return {
    runId: run.id,
    stepKey: step.stepKey,
    hasTasks: tasks.length > 0,
    tasksTotal: tasks.length,
    tasksSucceeded: succeeded,
    tasksReset: resetTasks ? tasks.length : tasks.length - succeeded,
  }
}

// ---------- [级联重跑] 从指定步骤起重跑到末尾 ----------

/** 级联单步信息（预览与执行共用；title 兜底 stepKey）。 */
export interface ChainStepInfo {
  stepKey: string
  title: string
  actionKey: string
  isTarget: boolean
  tasksTotal: number
  tasksToRun: number
  charged: boolean
}

/** 级联重跑聚合视图（前端预览/确认用）。 */
export interface ChainRerunView {
  runId: number
  stepKey: string
  chain: ChainStepInfo[]
  totalTasksToRun: number
  chargedSteps: number
}

/** 归集级联集合内各步的重跑预算（不写库；resetTasks 仅作用于目标步，下游一律全量重置）。 */
async function buildChainInfo(
  runId: number,
  chainKeys: string[],
  targetKey: string,
  resetTasks: boolean,
): Promise<ChainStepInfo[]> {
  const chain = new Set(chainKeys)
  const rows = await db
    .select()
    .from(pipelineSteps)
    .where(eq(pipelineSteps.runId, runId))
    .orderBy(asc(pipelineSteps.seq))
  const out: ChainStepInfo[] = []
  for (const r of rows) {
    if (!chain.has(r.stepKey)) continue
    const tasks = await db
      .select({ status: genTasks.status })
      .from(genTasks)
      .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, r.id)))
    const succeeded = tasks.filter((t) => t.status === 'succeeded').length
    const isTarget = r.stepKey === targetKey
    const fullReset = isTarget ? resetTasks : true
    const hasTasks = tasks.length > 0
    const tasksToRun = hasTasks ? (fullReset ? tasks.length : tasks.length - succeeded) : 1
    out.push({
      stepKey: r.stepKey,
      title: r.title ?? r.stepKey,
      actionKey: r.actionKey,
      isTarget,
      tasksTotal: tasks.length,
      tasksToRun,
      charged: hasTasks && tasksToRun > 0,
    })
  }
  return out
}

function toChainView(runId: number, stepKey: string, chain: ChainStepInfo[]): ChainRerunView {
  return {
    runId,
    stepKey,
    chain,
    totalTasksToRun: chain.reduce((n, c) => n + c.tasksToRun, 0),
    chargedSteps: chain.filter((c) => c.charged).length,
  }
}

/** 级联重跑预览（只读）：过 assertChainRepairable 门禁 → 返回级联步骤清单与预估计费子任务数，不触发执行。 */
export async function describeChainRerun(runId: number, stepKey: string, opts: { resetTasks?: boolean }): Promise<ChainRerunView> {
  const { chainKeys } = await assertChainRepairable(runId, stepKey)
  const chain = await buildChainInfo(runId, chainKeys, stepKey, opts.resetTasks === true)
  return toChainView(runId, stepKey, chain)
}

/**
 * 级联重跑执行：逐目标步尊重 resetTasks、下游步一律全量重置 → step pending + 清 output + 非 succeeded 任务归零 →
 * run queued；路由层随后 engine.startRun 依赖引擎逐层重做（下游 executeStep 实时 loadStepOutputs 消费新产物）。
 * 原地同 runId/stepId（不新建 run）——gen_task 归属不变，天然规避续跑迁移类幂等坑。
 */
export async function resetChainForRerun(
  runId: number,
  stepKey: string,
  opts: { resetTasks?: boolean },
): Promise<ChainRerunView & { note: string }> {
  const { chainKeys } = await assertChainRepairable(runId, stepKey)
  const chain = await buildChainInfo(runId, chainKeys, stepKey, opts.resetTasks === true)
  const now = Date.now()
  for (const info of chain) {
    const stepRow = await assertStepRow(runId, info.stepKey)
    if (info.tasksTotal > 0) {
      // 目标步复用模式：仅重置非 succeeded 任务；其余（下游步/目标全量）：全部归零重做
      const fullReset = info.isTarget ? opts.resetTasks === true : true
      const taskCond = fullReset
        ? and(eq(genTasks.runId, runId), eq(genTasks.stepId, stepRow.id))
        : and(eq(genTasks.runId, runId), eq(genTasks.stepId, stepRow.id), ne(genTasks.status, 'succeeded'))
      await db
        .update(genTasks)
        .set({ status: 'pending', attempts: 0, errorMsg: null, completedAt: null, updatedAt: now })
        .where(taskCond)
    }
    await db
      .update(pipelineSteps)
      .set({ status: 'pending', error: null, output: null, completedAt: null, updatedAt: now })
      .where(eq(pipelineSteps.id, stepRow.id))
  }
  await db
    .update(pipelineRuns)
    .set({ status: 'queued', error: null, completedAt: null, currentStepKey: null, updatedAt: now })
    .where(eq(pipelineRuns.id, runId))
  const targetTitle = chain.find((c) => c.isTarget)?.title ?? stepKey
  const note = `已级联重跑：从「${targetTitle}」起重做 ${chain.length} 步（其中 ${chain.filter((c) => c.charged).length} 步含生成计费，预计 ${chain.reduce((n, c) => n + c.tasksToRun, 0)} 个子任务）；下游产物按新结果重做，历史版本保留`
  return { ...toChainView(runId, stepKey, chain), note }
}

/** 级联重置需按 stepKey 取回步骤行（已过门禁，行必存在） */
async function assertStepRow(runId: number, stepKey: string): Promise<PipelineStep> {
  const rows = await db
    .select()
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, stepKey)))
    .limit(1)
  const step = rows[0]
  if (!step) throw new WorkbenchError('not_found', `步骤 ${stepKey} 不存在`, 404)
  return step
}

/** [M10] producer output 保位替换（旧分镜 id → 新分镜 id；gate/skipped 字段原样保留） */
export async function replaceProducerOutputAsset(
  producer: PipelineStep,
  oldId: number,
  newId: number,
  updatedAt: number,
): Promise<number[]> {
  const producerOut = parseOutputJson(producer.output)
  const ids = toIdArray(producerOut['asset_ids'])
  const idx = ids.indexOf(oldId)
  if (idx < 0) throw new WorkbenchError('no_producer', '分镜资产未在产出步骤输出中，暂不支持编辑')
  ids[idx] = newId
  await db
    .update(pipelineSteps)
    .set({ output: JSON.stringify({ ...producerOut, asset_ids: ids }), updatedAt })
    .where(eq(pipelineSteps.id, producer.id))
  return ids
}

/**
 * [M10] 镜头步骤 output 重建：按「分镜序 × 各镜当前选中」重建 asset_ids。
 * 选中映射 = 旧 output 按 params.shotId 解析；override 用于上传绑定的该镜位替换/插入；
 * 未生成/无选中镜头跳过；已删除镜头的资产自然移除（重建式——历史资产仍可在版本组找回）。
 */
export async function rebuildShotOutput(
  step: PipelineStep,
  shots: ShotSpec[],
  override?: { shotId: string; assetId: number },
): Promise<number[]> {
  const { outIds, selected } = await selectedMapOf(step)
  if (override) selected.set(override.shotId, override.assetId)
  const nextIds: number[] = []
  for (const s of shots) {
    const id = selected.get(s.id)
    if (id != null) nextIds.push(id)
  }
  if (!sameIds(nextIds, outIds)) {
    const out = parseOutputJson(step.output)
    await db
      .update(pipelineSteps)
      .set({ output: JSON.stringify({ ...out, asset_ids: nextIds }), updatedAt: Date.now() })
      .where(eq(pipelineSteps.id, step.id))
  }
  return nextIds
}
