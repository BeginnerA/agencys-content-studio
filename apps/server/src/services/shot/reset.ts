import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../../db'
import { genTasks, pipelineRuns, pipelineSteps, type PipelineStep } from '../../db/schema'
import { cleanupVersions, type CleanupResult } from '../version-cleanup'
import { WORKBENCH_ACTIONS, WorkbenchError, parseOutputJson, selectedMapOf, sameIds, toIdArray, requeuePatch, type ShotSpec } from './helpers'
import { isCreationTemplate } from '../creation-chat/recipe'
import { assertRepairable, assertChainRepairable } from './inspect'

/** [M42] 返修可重置的步骤形态（生成步按镜重置 + 合成步整步重置） */
const REWORK_ACTIONS = ['ai_image', 'ai_video', 'ffmpeg_merge']

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

/**
 * [M44] 对白本地重合成零模型重置：同时失效逐镜转写步与合成步（从选中镜头的已校验缓存重建全片字幕、
 * 旧最终审阅作废），但绝不归零或删除 ASR 任务——保留 succeeded 任务以复用原声转写缓存，保证零付费。
 * 若只重置合成会残留陈旧字幕，违反「重新合成不暗改字幕/不暗中付费 ASR」红线，故对白走本专用通道。
 */
export async function resetDialogueForRecompose(runId: number): Promise<{ runId: number }> {
  const { run, step: compose } = await assertRepairable(runId, 'compose', ['ffmpeg_merge'])
  const rows = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId))
  const captions = rows.find((r) => r.actionKey === 'dialogue_subtitle')
  if (!captions) throw new WorkbenchError('bad_plan', '对白重合成缺少严格原声转写步骤，不能仅重置合成')
  const now = Date.now()
  await db.update(pipelineSteps).set({ status: 'pending', error: null, output: null, completedAt: null, updatedAt: now }).where(inArray(pipelineSteps.id, [captions.id, compose.id]))
  await db.update(pipelineRuns).set({ status: 'queued', error: null, completedAt: null, currentStepKey: null, updatedAt: now }).where(eq(pipelineRuns.id, run.id))
  return { runId: run.id }
}

/** 返修重置的单镜条目：prompt = 重新批准后的提示词（同步进任务快照，见下注释） */
export interface ReworkShotReset {
  shotId: string
  prompt: string
}

/** 返修重置的单个步骤；shots 为空 = 无子任务步骤（合成步）整步重置 */
export interface ReworkStepReset {
  stepKey: string
  shots: ReworkShotReset[]
  /**
   * [M44] 对白局部返修专用通道：该步为严格逐镜转写（dialogue_subtitle），按镜删除已存 ASR 任务，
   * 令其随重做后的新原声重新转写；清空本步产出使全片字幕重建。未列入的镜头任务原样保留（复用零重付费）。
   * 这是对白独有的依赖失效，不改 REWORK_ACTIONS 白名单语义、不把 ASR 塞进通用重置遗漏任务状态。
   */
  asrInvalid?: boolean
}

function shotIdOfTask(t: { params: string | null }): string | null {
  try {
    const p = JSON.parse(String(t.params)) as { shotId?: unknown }
    return typeof p.shotId === 'string' ? p.shotId : null
  } catch {
    return null
  }
}

/**
 * [M42] 局部返修的批量状态重置（与批准链改写同事务，由 creation 层 rework 传入 allowCreation）：
 * - 门禁与 assertRepairable 同语义，但 failed 判定按「本次全部目标步」整体做（逐单步复用会把兄弟目标步误判成 other_failed）；
 * - 只重置目标镜任务（attempts 归零、resultAssetId 保留作历史候选），同镜其他任务仍 succeeded → 被引擎跳过；
 * - 一并把任务 prompt 同步为重新批准后的提示词：ai_image/ai_video 的「已批准任务参数发生变化」守卫比对的是任务快照，
 *   不同步会让返修一执行即失败；提示词由用户在确认闸上显式批准且已写入 approvedPlan/recipe，不是静默漂移；
 * - 步骤保留 output（历史候选与 gate 决策痕迹继续可见），run 回 queued，startRun 由调用方在服务返回后执行。
 */
export async function resetShotsForRework(
  runId: number,
  steps: ReworkStepReset[],
  opts: { allowCreation: boolean },
  executor: Pick<typeof db, 'select' | 'update' | 'delete'> = db,
): Promise<{ runId: number; resetTaskIds: number[]; resetStepKeys: string[] }> {
  if (steps.length === 0) throw new WorkbenchError('bad_plan', '返修未指定任何步骤')
  const [run] = await executor.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  if (!run) throw new WorkbenchError('not_found', `run ${runId} 不存在`, 404)
  if (run.status === 'cancelled') throw new WorkbenchError('run_cancelled', 'run 已取消，请走「断点续跑」创建续跑 run', 409)
  if (run.status !== 'completed' && run.status !== 'failed') {
    throw new WorkbenchError('run_active', `run 正在执行/排队（${run.status}），请等待收敛后再返修`)
  }
  if (isCreationTemplate(run.templateKey) && !opts.allowCreation) {
    throw new WorkbenchError('creation_confirmation_required', '轻松创作批准链的镜头返修须经会话内费用确认通道，不能从工作台直接重置', 409)
  }
  const rows = await executor.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId))
  const byKey = new Map(rows.map((r) => [r.stepKey, r] as const))
  for (const target of steps) {
    const row = byKey.get(target.stepKey)
    if (!row) throw new WorkbenchError('not_found', `步骤 ${target.stepKey} 不存在`, 404)
    // [M44] 对白转写失效只认 dialogue_subtitle 步，且必须显式登记 asrInvalid；不借道通用白名单
    if (target.asrInvalid && row.actionKey !== 'dialogue_subtitle') {
      throw new WorkbenchError('bad_action', `步骤「${row.title ?? target.stepKey}」不是严格转写步，不能按对白失效处理`)
    }
    if (!REWORK_ACTIONS.includes(row.actionKey) && !(target.asrInvalid && row.actionKey === 'dialogue_subtitle')) {
      throw new WorkbenchError('bad_action', `步骤「${row.title ?? target.stepKey}」不支持返修重置（action=${row.actionKey}）`)
    }
    if (row.status !== 'succeeded' && row.status !== 'failed') {
      throw new WorkbenchError('bad_step_status', `步骤「${row.title ?? target.stepKey}」状态为 ${row.status}，仅 succeeded/failed 可返修`)
    }
    if (target.shots.length === 0 && row.actionKey !== 'ffmpeg_merge') {
      throw new WorkbenchError('bad_plan', `步骤「${row.title ?? target.stepKey}」需指明返修镜头`)
    }
  }
  const wanted = new Set(steps.map((s) => s.stepKey))
  const outsideFailed = rows.filter((r) => r.status === 'failed' && !wanted.has(r.stepKey)).map((r) => r.stepKey)
  if (outsideFailed.length > 0) {
    throw new WorkbenchError('other_failed', `存在返修范围外的失败步骤（${outsideFailed.join('、')}），请先修复后再返修`)
  }
  // 校验全部先于写入：镜头无任务时不产生半途重置（整批要么全部可执行，要么不动）
  const plan: Array<{ step: PipelineStep; tasks: Array<{ id: number; prompt: string }>; asrInvalid: boolean }> = []
  for (const target of steps) {
    const step = byKey.get(target.stepKey)!
    const tasks: Array<{ id: number; prompt: string }> = []
    if (target.shots.length > 0) {
      const rowsOfStep = await executor.select().from(genTasks).where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, step.id)))
      for (const shot of target.shots) {
        const task = rowsOfStep.find((t) => shotIdOfTask(t) === shot.shotId)
        if (!task) throw new WorkbenchError('no_task', `镜头 ${shot.shotId} 无对应「${step.title ?? target.stepKey}」生成任务`)
        tasks.push({ id: task.id, prompt: shot.prompt })
      }
    }
    plan.push({ step, tasks, asrInvalid: target.asrInvalid === true })
  }
  const now = Date.now()
  const resetTaskIds: number[] = []
  for (const { step, tasks, asrInvalid } of plan) {
    for (const t of tasks) {
      if (asrInvalid) {
        // 删除该镜旧转写任务：视频将重做 → 新原声需重新转写（合法新计费），旧转写诊断资产保留可回溯
        await executor.delete(genTasks).where(eq(genTasks.id, t.id))
      } else {
        // 归零重排队：提示词已变 → regen=true 清空外部任务号，令引擎重新提交（requeuePatch 单一真源，
        // 与 resetShotForRegenerate / resetStepForRerun / [F03] 同规则），绝不轮询旧第三方任务返回旧成片；
        // prompt 同步为重新批准后的提示词（ai_image/ai_video「已批准任务参数变化」守卫比对任务快照，不同步则返修一执行即失败）
        await executor.update(genTasks).set({ ...requeuePatch(true, now), prompt: t.prompt }).where(eq(genTasks.id, t.id))
      }
      resetTaskIds.push(t.id)
    }
    await executor
      .update(pipelineSteps)
      .set({ status: 'pending', error: null, completedAt: null, ...(asrInvalid ? { output: null } : {}), updatedAt: now })
      .where(eq(pipelineSteps.id, step.id))
  }
  await executor
    .update(pipelineRuns)
    .set({ status: 'queued', error: null, completedAt: null, currentStepKey: null, updatedAt: now })
    .where(eq(pipelineRuns.id, runId))
  return { runId, resetTaskIds, resetStepKeys: steps.map((s) => s.stepKey) }
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
  if (isCreationTemplate(run.templateKey)) throw new WorkbenchError('creation_confirmation_required', '已批准制作链请在轻松创作中恢复；额外生成需新方案确认', 409)
  const tasks = await db
    .select({ id: genTasks.id, status: genTasks.status })
    .from(genTasks)
    .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, step.id)))
  const succeeded = tasks.filter((t) => t.status === 'succeeded').length
  const resetTasks = opts.resetTasks === true
  const now = Date.now()
  if (resetTasks && tasks.length > 0) {
    // 全量重做（重生成）→ regen=true 清外部 task_id，令引擎重新提交而非续轮询旧成片（requeuePatch 单一真源）
    await db
      .update(genTasks)
      .set(requeuePatch(true, now))
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
      // fullReset=true（强制重做）→ regen 清 task_id 重新提交；fullReset=false（目标复用仅重试非 succeeded）→ 保留 task_id 续轮询避免重复计费（requeuePatch 单一真源）
      await db
        .update(genTasks)
        .set(requeuePatch(fullReset, now))
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
