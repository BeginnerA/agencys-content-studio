/**
 * [M7] 镜头级轻工作台服务层（spec §3.1）
 * - 纯 DB 层：只做「校验 + 数据库状态变更」，不调用 engine（startRun 由路由层在服务返回后同步调用）
 * - 错误类型与 HttpError 解耦：路由层转 HTTP（对齐 run-create.ts 惯例）
 * - 三个核心语义：① 分镜 JSON 是唯一事实源 ② 产物即选择（改写 output.asset_ids）③ 状态重置 + 引擎复用
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import {
  assets,
  genTasks,
  pipelineRuns,
  pipelineSteps,
  type Asset,
  type GenTask,
  type PipelineRun,
  type PipelineStep,
} from '../db/schema'
import { readTextAsset, writeTextAsset } from './storage'

/** 工作台领域错误（路由层转 HTTP；status 默认 400，run/step 不存在用 404） */
export class WorkbenchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message)
    this.name = 'WorkbenchError'
  }
}

/** 工作台类步骤（分镜编辑 / 单镜重生成 / 选片） */
export const WORKBENCH_ACTIONS = ['ai_image', 'ai_video']

/** 分镜镜头（宽松形态：兼容裸数组与 {shots:[]}，与 ai-image 解析口径一致） */
export interface ShotSpec {
  id: string
  image_prompt?: string
  motion_prompt?: string
  duration?: number
  /** LLM 分镜实际口径（storyboard-ep 提示词 schema 用 duration_sec；编辑写入 duration 时同步） */
  duration_sec?: number
  [k: string]: unknown
}

/** 分镜时长双口径读取：duration 优先，回退 duration_sec（LLM 原始分镜字段）；非法值 → null */
export function shotDurationSec(shot: object): number | null {
  const o = shot as { duration?: unknown; duration_sec?: unknown }
  for (const key of ['duration', 'duration_sec'] as const) {
    const v = o[key]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return null
}

export interface BoardVersion {
  id: number
  name: string
  createdAt: number
  width: number | null
  height: number | null
  duration: number | null
  prompt: string | null
  urls: { file: string; thumb: string | null }
}

export interface BoardTask {
  id: number
  status: string
  attempts: number
  errorMsg: string | null
  prompt: string | null
}

export interface BoardShot {
  shotId: string
  order: number
  imagePrompt: string
  motionPrompt: string
  duration: number | null
  task: BoardTask | null
  selectedAssetId: number | null
  versions: BoardVersion[]
}

export interface ShotBoard {
  step: { id: number; key: string; title: string | null; action: string; status: string }
  shots: BoardShot[]
  compose: { stepKey: string; composedAt: number | null; stale: boolean | null } | null
  repairable: { ok: boolean; reason: string | null }
}

export interface ShotEditItem {
  shot_id: string
  image_prompt?: string
  motion_prompt?: string
  duration?: number
}

export interface ShotPick {
  shot_id: string
  asset_id: number
}

interface StoryboardSource {
  asset: Asset
  shots: ShotSpec[]
  /** 原始 JSON（保形态回写：裸数组 / {shots:[]}） */
  parsed: unknown
}

// ---------- 公共校验 ----------

/**
 * 返修通用校验（spec §3.6 决策表）：
 * run ∈ {completed, failed}（活跃 400 / cancelled 提示续跑）；目标步骤 ∈ {succeeded, failed}；
 * 该 run 内除目标步骤外无 failed（失败收敛先于执行，否则重跑必失败）。
 */
export async function assertRepairable(
  runId: number,
  stepKey: string,
  allowActions?: string[],
): Promise<{ run: PipelineRun; step: PipelineStep }> {
  const run = await getRunOrThrow(runId)
  if (run.status === 'running' || run.status === 'queued' || run.status === 'waiting_input') {
    throw new WorkbenchError('run_active', `run 正在执行/排队（${run.status}），请等待收敛后再操作`)
  }
  if (run.status === 'cancelled') {
    throw new WorkbenchError('run_cancelled', 'run 已取消，请走「断点续跑」创建续跑 run')
  }
  if (run.status !== 'completed' && run.status !== 'failed') {
    throw new WorkbenchError('bad_status', `run 状态 ${run.status} 不支持返修`)
  }
  const step = await getStepOrThrow(runId, stepKey)
  if (step.status !== 'succeeded' && step.status !== 'failed') {
    throw new WorkbenchError('bad_step_status', `步骤「${step.title ?? stepKey}」状态为 ${step.status}，仅 succeeded/failed 可返修`)
  }
  if (allowActions && !allowActions.includes(step.actionKey)) {
    throw new WorkbenchError('bad_action', `步骤 action=${step.actionKey} 不支持此操作`)
  }
  const rows = await db
    .select({ id: pipelineSteps.id, status: pipelineSteps.status, stepKey: pipelineSteps.stepKey })
    .from(pipelineSteps)
    .where(eq(pipelineSteps.runId, runId))
  const others = rows.filter((r) => r.status === 'failed' && r.id !== step.id)
  if (others.length > 0) {
    throw new WorkbenchError('other_failed', `存在其他失败步骤（${others.map((r) => r.stepKey).join('、')}），请先修复后再操作`)
  }
  return { run, step }
}

/** 只读判定版（shot-board 用）：不抛错 → { ok, reason } */
export async function checkRepairable(
  runId: number,
  stepKey: string,
  allowActions?: string[],
): Promise<{ ok: boolean; reason: string | null }> {
  try {
    await assertRepairable(runId, stepKey, allowActions)
    return { ok: true, reason: null }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : '校验失败' }
  }
}

// ---------- 聚合读 ----------

/** 工作台聚合读：shots × tasks × 版本组 × 当前选中 × 合成新鲜度 五合一 */
export async function buildShotBoard(runId: number, stepKey: string): Promise<ShotBoard> {
  const run = await getRunOrThrow(runId)
  const step = await getStepOrThrow(runId, stepKey)
  const repairable = await checkRepairable(runId, stepKey, WORKBENCH_ACTIONS)

  // 分镜源（解析失败 → shots=[] + repairable.reason 说明）
  let shots: ShotSpec[] = []
  let parseError: string | null = null
  try {
    shots = (await resolveStoryboardSource(run, step)).shots
  } catch (err) {
    parseError = err instanceof Error ? err.message : '分镜解析失败'
  }

  // 该步骤全部任务 → 每镜任务（参数损坏行跳过，与 action 一致）
  const tasks = await db
    .select()
    .from(genTasks)
    .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, step.id)))
  const taskByShotId = new Map<string, GenTask>()
  for (const t of tasks) {
    try {
      const p = JSON.parse(t.params) as { shotId?: string }
      if (p.shotId && !taskByShotId.has(p.shotId)) taskByShotId.set(p.shotId, t)
    } catch {
      // 参数损坏任务：不参与
    }
  }

  // 版本组：该步骤任务的全部产物（assets.task_id = gen_tasks.id；created_at 升序 = 版本序列）
  const taskIds = tasks.map((t) => t.id)
  const versionRows = taskIds.length
    ? await db
        .select()
        .from(assets)
        .where(and(inArray(assets.taskId, taskIds), isNull(assets.deletedAt)))
        .orderBy(asc(assets.createdAt))
    : []
  const versionsByTaskId = new Map<number, Asset[]>()
  for (const a of versionRows) {
    if (a.taskId == null) continue
    const list = versionsByTaskId.get(a.taskId) ?? []
    list.push(a)
    versionsByTaskId.set(a.taskId, list)
  }

  // 当前选中：output 保序，同镜取首个命中
  const outIds = outputIdsOf(step)
  const outById = new Map<number, Asset>()
  if (outIds.length > 0) {
    const rows = await db.select().from(assets).where(inArray(assets.id, outIds))
    for (const a of rows) outById.set(a.id, a)
  }
  const selectedByShotId = new Map<string, number>()
  for (const id of outIds) {
    const a = outById.get(id)
    if (!a) continue
    const sid = shotIdOfAsset(a)
    if (sid && !selectedByShotId.has(sid)) selectedByShotId.set(sid, id)
  }

  const boardShots: BoardShot[] = shots.map((s, order) => {
    const task = taskByShotId.get(s.id) ?? null
    return {
      shotId: s.id,
      order,
      imagePrompt: typeof s.image_prompt === 'string' ? s.image_prompt : '',
      motionPrompt: typeof s.motion_prompt === 'string' ? s.motion_prompt : '',
      duration: shotDurationSec(s),
      task: task
        ? { id: task.id, status: task.status, attempts: task.attempts, errorMsg: task.errorMsg, prompt: task.prompt }
        : null,
      selectedAssetId: selectedByShotId.get(s.id) ?? null,
      versions: (task ? (versionsByTaskId.get(task.id) ?? []) : []).map(toVersionView),
    }
  })

  const compose = await buildComposeInfo(run)
  const finalRepairable =
    repairable.ok && parseError ? { ok: false, reason: `分镜解析失败：${parseError}` } : repairable

  return {
    step: { id: step.id, key: step.stepKey, title: step.title, action: step.actionKey, status: step.status },
    shots: boardShots,
    compose,
    repairable: finalRepairable,
  }
}

/** 合成新鲜度信息（run 无 ffmpeg_merge 步骤 → null） */
async function buildComposeInfo(run: PipelineRun): Promise<ShotBoard['compose']> {
  const steps = await db
    .select()
    .from(pipelineSteps)
    .where(eq(pipelineSteps.runId, run.id))
    .orderBy(asc(pipelineSteps.seq))
  const composeStep = steps.find((s) => s.actionKey === 'ffmpeg_merge')
  if (!composeStep) return null
  const outIds = outputIdsOf(composeStep)
  if (outIds.length === 0) return { stepKey: composeStep.stepKey, composedAt: null, stale: null }
  const rows = await db.select().from(assets).where(inArray(assets.id, outIds)).orderBy(asc(assets.createdAt))
  const finalAsset = rows[0] ?? null
  if (!finalAsset) return { stepKey: composeStep.stepKey, composedAt: null, stale: null }
  const stale = await computeStale(finalAsset, steps)
  return { stepKey: composeStep.stepKey, composedAt: finalAsset.createdAt, stale }
}

/**
 * stale 判定：成片产物 params.inputs 快照 vs 当前上游真实输出（任一不等 → true）。
 * - images / motion_clips：快照 id 数组 vs 「其产出步骤」当前 output.asset_ids（同口径全序对比）；
 * - shots_source：快照分镜资产是否仍在产出步骤当前 output 中（分镜被工作台编辑替换 → 不在 → stale）；
 * - 旧产物无 inputs 快照 / 全部对比项不可用 → null（无法判定，前端降级为常态提示）。
 */
async function computeStale(finalAsset: Asset, runSteps: PipelineStep[]): Promise<boolean | null> {
  let inputs: Record<string, unknown> | null = null
  if (finalAsset.params) {
    try {
      const p = JSON.parse(finalAsset.params) as { inputs?: unknown }
      if (p.inputs && typeof p.inputs === 'object') inputs = p.inputs as Record<string, unknown>
    } catch {
      inputs = null
    }
  }
  if (!inputs) return null

  const stepById = new Map(runSteps.map((s) => [s.id, s]))
  const producerCache = new Map<number, PipelineStep | null>()
  const producerOf = async (assetId: number): Promise<PipelineStep | null> => {
    const cached = producerCache.get(assetId)
    if (cached !== undefined) return cached
    const rows = await db.select({ stepId: assets.stepId }).from(assets).where(eq(assets.id, assetId)).limit(1)
    const sid = rows[0]?.stepId
    const step = sid != null ? (stepById.get(sid) ?? null) : null
    producerCache.set(assetId, step)
    return step
  }

  let compared = 0
  for (const key of ['images', 'motion_clips']) {
    const snap = inputs[key]
    if (!Array.isArray(snap) || snap.length === 0) continue
    const first = Number(snap[0])
    if (!Number.isInteger(first) || first <= 0) continue
    const producer = await producerOf(first)
    if (!producer) continue
    compared += 1
    if (!sameIds(snap.map(Number), outputIdsOf(producer))) return true
  }
  const src = inputs['shots_source']
  if (typeof src === 'number' && Number.isInteger(src) && src > 0) {
    const producer = await producerOf(src)
    if (producer) {
      compared += 1
      if (!outputIdsOf(producer).includes(src)) return true
    }
  }
  return compared > 0 ? false : null
}

// ---------- 分镜编辑 ----------

/**
 * 分镜编辑：时长/提示词字段级编辑 → 写分镜新版本资产 + 替换产出步骤 output 保位。
 * 不触发执行、不改 run 状态；生效路径：重生成 / 重新合成时经引用解析自然消费新分镜。
 */
export async function applyStoryboardEdits(
  runId: number,
  stepKey: string,
  items: ShotEditItem[],
): Promise<{ assetId: number; assetIds: number[]; edited: number }> {
  if (!Array.isArray(items) || items.length === 0) throw new WorkbenchError('bad_items', 'shots 需为非空数组')
  const { run, step } = await assertRepairable(runId, stepKey, WORKBENCH_ACTIONS)
  const src = await resolveStoryboardSource(run, step)

  // 产出步骤溯源（写新资产 stepId + 替换 output 保位皆依赖）
  const producer = await findProducerStep(src.asset, run)
  if (!producer) throw new WorkbenchError('no_producer', '分镜资产无产出步骤溯源，暂不支持编辑')

  // 全量校验后统一应用（防部分写入）
  const shotById = new Map(src.shots.map((s) => [s.id, s]))
  const normalized: Array<{
    shot: ShotSpec
    patch: { image_prompt?: string; motion_prompt?: string; duration?: number }
    changed: boolean
  }> = []
  for (const item of items) {
    if (!item || typeof item.shot_id !== 'string' || !item.shot_id) {
      throw new WorkbenchError('bad_items', 'shot_id 非法')
    }
    const shot = shotById.get(item.shot_id)
    if (!shot) throw new WorkbenchError('unknown_shot', `镜头 ${item.shot_id} 不在分镜中`)
    const patch: { image_prompt?: string; motion_prompt?: string; duration?: number } = {}
    let changed = false
    for (const field of ['image_prompt', 'motion_prompt'] as const) {
      const v = item[field]
      if (v === undefined) continue
      if (typeof v !== 'string' || !v.trim()) {
        throw new WorkbenchError('bad_prompt', `镜头 ${item.shot_id} ${field} 需为非空字符串`)
      }
      const text = v.trim()
      patch[field] = text
      const current = typeof shot[field] === 'string' ? (shot[field] as string).trim() : ''
      if (text !== current) changed = true
    }
    if (item.duration !== undefined) {
      if (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 60) {
        throw new WorkbenchError('bad_duration', `镜头 ${item.shot_id} duration 需在 (0, 60] 秒内`)
      }
      const v = Math.round(item.duration * 10) / 10
      patch.duration = v
      if (v !== shotDurationSec(shot)) changed = true
    }
    if (Object.keys(patch).length === 0) {
      throw new WorkbenchError('bad_items', `镜头 ${item.shot_id} 未提供任何可编辑字段`)
    }
    normalized.push({ shot, patch, changed })
  }
  const changedItems = normalized.filter((n) => n.changed)
  if (changedItems.length === 0) throw new WorkbenchError('no_change', '所有编辑项与当前分镜一致，无实际变化')

  // 写分镜新版本资产（对齐 approveGate 先例：新资产 + 替换 output 保位）
  const updated = applyPatches(src.parsed, changedItems)
  const baseName = src.asset.name.replace(/\.[^.]+$/, '').replace(/-工作台编辑$/, '')
  const editedAt = Date.now()
  const newAsset = await writeTextAsset(run.projectId, {
    name: `${baseName}-工作台编辑.json`,
    content: JSON.stringify(updated, null, 2),
    purpose: src.asset.purpose ?? 'storyboard',
    format: 'storyboard-json',
    stepId: producer.id,
    runId: run.id,
    params: { edited_shots: changedItems.map((n) => n.shot.id), source_asset_id: src.asset.id, editedAt },
    tags: ['workbench'],
  })

  // 替换产出步骤 output 中旧分镜 id 的位置（保位；gate/skipped 字段原样保留）
  const producerOut = parseOutputJson(producer.output)
  const ids = toIdArray(producerOut['asset_ids'])
  const idx = ids.indexOf(src.asset.id)
  if (idx < 0) throw new WorkbenchError('no_producer', '分镜资产未在产出步骤输出中，暂不支持编辑')
  ids[idx] = newAsset.id
  await db
    .update(pipelineSteps)
    .set({ output: JSON.stringify({ ...producerOut, asset_ids: ids }), updatedAt: editedAt })
    .where(eq(pipelineSteps.id, producer.id))

  return { assetId: newAsset.id, assetIds: ids, edited: changedItems.length }
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
      if (a.taskId == null || !taskIds.has(a.taskId)) {
        throw new WorkbenchError('bad_asset', `资产 #${r.assetId} 不属于该步骤生成任务`)
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

// ---------- 内部工具 ----------

async function getRunOrThrow(runId: number): Promise<PipelineRun> {
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = rows[0]
  if (!run) throw new WorkbenchError('not_found', `run ${runId} 不存在`, 404)
  return run
}

async function getStepOrThrow(runId: number, stepKey: string): Promise<PipelineStep> {
  const rows = await db
    .select()
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, stepKey)))
    .limit(1)
  const step = rows[0]
  if (!step) throw new WorkbenchError('not_found', `步骤 ${stepKey} 不存在`, 404)
  return step
}

/** 分镜源定位：目标步骤 input.shots[0] → 分镜资产（产出侧最新优先）→ JSON 解析（裸数组 / {shots:[]}） */
async function resolveStoryboardSource(run: PipelineRun, step: PipelineStep): Promise<StoryboardSource> {
  let input: Record<string, unknown> | null = null
  if (step.input) {
    try {
      input = JSON.parse(step.input) as Record<string, unknown>
    } catch {
      input = null
    }
  }
  const shotsRef = input?.['shots']
  const sbAssetId = Array.isArray(shotsRef) ? Number(shotsRef[0]) : NaN
  if (!Number.isInteger(sbAssetId) || sbAssetId <= 0) {
    throw new WorkbenchError('no_storyboard', '当前步骤无分镜输入（input.shots），无法定位分镜源')
  }
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, sbAssetId), isNull(assets.deletedAt)))
    .limit(1)
  const asset = rows[0]
  if (!asset) throw new WorkbenchError('no_storyboard', `分镜资产 #${sbAssetId} 不存在或已删除`)
  // 编辑后生效来源：产出步骤当前输出中的最新分镜（input.shots 快照滞后于工作台编辑）
  const srcAsset = await latestStoryboardOf(asset, run)
  let raw: string
  try {
    raw = await readTextAsset(srcAsset.id)
  } catch (err) {
    throw new WorkbenchError('bad_storyboard', `分镜资产读取失败：${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new WorkbenchError('bad_storyboard', `分镜 JSON 解析失败：${(err as Error).message}`)
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed as { shots?: unknown }).shots
  if (!Array.isArray(arr)) throw new WorkbenchError('bad_storyboard', '分镜内容缺 shots 数组')
  const shots: ShotSpec[] = []
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    if (typeof o['id'] !== 'string' || !o['id']) continue
    shots.push(o as ShotSpec)
  }
  if (shots.length === 0) throw new WorkbenchError('bad_storyboard', '分镜内容无有效镜头（缺 id）')
  return { asset: srcAsset, shots, parsed }
}

/** 产出步骤溯源：分镜资产 stepId → 步骤行（runId 一致性校验） */
async function findProducerStep(asset: Asset, run: PipelineRun): Promise<PipelineStep | null> {
  if (asset.stepId == null) return null
  const rows = await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, asset.stepId)).limit(1)
  const step = rows[0]
  if (!step || step.runId !== run.id) return null
  return step
}

/**
 * 最新分镜定位：产出步骤当前输出中的 storyboard 资产优先（工作台编辑保位替换后为最新）；
 * 无溯源（续跑复用）或输出中无可辨识分镜时回退输入引用资产。
 */
async function latestStoryboardOf(asset: Asset, run: PipelineRun): Promise<Asset> {
  const producer = await findProducerStep(asset, run)
  if (!producer) return asset
  for (const id of outputIdsOf(producer)) {
    if (id === asset.id) continue
    const rows = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), isNull(assets.deletedAt)))
      .limit(1)
    const cand = rows[0]
    if (cand && cand.kind === 'text' && cand.purpose === 'storyboard') return cand
  }
  return asset
}

/** 应用补丁（深拷贝原始 JSON，保持裸数组 / {shots:[]} 形态） */
function applyPatches(
  parsed: unknown,
  edits: Array<{ shot: ShotSpec; patch: { image_prompt?: string; motion_prompt?: string; duration?: number } }>,
): unknown {
  const deep = JSON.parse(JSON.stringify(parsed)) as unknown
  const arr = (Array.isArray(deep) ? deep : (deep as { shots?: ShotSpec[] }).shots) ?? []
  const byId = new Map<string, ShotSpec>()
  for (const s of arr) {
    if (s && typeof s.id === 'string') byId.set(s.id, s)
  }
  for (const e of edits) {
    const s = byId.get(e.shot.id)
    if (!s) continue
    if (e.patch.image_prompt !== undefined) s.image_prompt = e.patch.image_prompt
    if (e.patch.motion_prompt !== undefined) s.motion_prompt = e.patch.motion_prompt
    if (e.patch.duration !== undefined) {
      s.duration = e.patch.duration
      // 原分镜若用 duration_sec 口径（LLM 产出）则同步，防下游读取分歧
      if (Object.prototype.hasOwnProperty.call(s, 'duration_sec')) s.duration_sec = e.patch.duration
    }
  }
  return deep
}

function parseOutputJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as unknown
    if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>
  } catch {
    // 容错：按空对象处理
  }
  return {}
}

function outputIdsOf(step: PipelineStep): number[] {
  return toIdArray(parseOutputJson(step.output)['asset_ids'])
}

function toIdArray(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  return v.map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

function shotIdOfAsset(a: Asset): string | null {
  if (!a.params) return null
  try {
    const p = JSON.parse(a.params) as { shotId?: unknown }
    return typeof p.shotId === 'string' && p.shotId ? p.shotId : null
  } catch {
    return null
  }
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function toVersionView(a: Asset): BoardVersion {
  return {
    id: a.id,
    name: a.name,
    createdAt: a.createdAt,
    width: a.width,
    height: a.height,
    duration: a.duration,
    prompt: a.prompt,
    urls: {
      file: `/api/v1/assets/${a.id}/file`,
      // v=2：早期缩略图端点直接回原图（客户端可能缓存 24h），版本参数强制失效旧缓存
      thumb: a.kind === 'image' || a.kind === 'video' ? `/api/v1/assets/${a.id}/thumb?v=2` : null,
    },
  }
}
