import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, pipelineSteps, type Asset, type PipelineRun, type PipelineStep } from '../../db/schema'
import { stepDeps } from '../../pipeline/dag'
import { templateForRun } from '../../pipeline/loader'
import type { Template } from '../../pipeline/types'
import { readTextAsset } from '../storage'
import { isCreationTemplate } from '../creation-chat/recipe'
import { WorkbenchError, getRunOrThrow, getStepOrThrow, outputIdsOf, type ShotSpec } from './helpers'

export interface StoryboardSource {
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

/** 模板步骤图（run 快照优先，缺失/损坏 → null；与引擎执行图同源，避免快照漂移） */
function chainTemplate(run: PipelineRun): { template: Template; orderByKey: Map<string, number> } | null {
  try {
    const template = templateForRun(run)
    return { template, orderByKey: new Map(template.steps.map((s, i) => [s.key, i] as const)) }
  } catch {
    return null
  }
}

/**
 * 级联集合：目标步 ∪ 传递下游（对 stepDeps 建反向图后自 target 的可达闭包）。
 * 与 assertRepairable 单步重跑的关键差异：这里主动把下游 failed 步纳入待重置集合，
 * 从而消解引擎「失败收敛先于执行」约束（重置后 run 内不再有 failed，startRun 从 target 依次重做）。
 * target 不在模板内 / 快照损坏 → null。
 */
export function computeChainKeys(run: PipelineRun, targetKey: string): string[] | null {
  const g = chainTemplate(run)
  if (!g || !g.orderByKey.has(targetKey)) return null
  const { template, orderByKey } = g
  const children = new Map<string, string[]>()
  for (const def of template.steps) {
    for (const dep of stepDeps(def, template, orderByKey)) {
      const arr = children.get(dep) ?? []
      arr.push(def.key)
      children.set(dep, arr)
    }
  }
  const chain = new Set<string>([targetKey])
  const stack = [targetKey]
  while (stack.length) {
    const k = stack.pop()!
    for (const c of children.get(k) ?? []) if (!chain.has(c)) (chain.add(c), stack.push(c))
  }
  return [...chain]
}

/** 目标的传递上游闭包（不含 target 自身）：级联重跑要求这些步全部终态非 failed，否则 target 不会就绪 */
export function computeUpstreamKeys(run: PipelineRun, targetKey: string): string[] | null {
  const g = chainTemplate(run)
  if (!g || !g.orderByKey.has(targetKey)) return null
  const { template, orderByKey } = g
  const defByKey = new Map(template.steps.map((s) => [s.key, s] as const))
  const up = new Set<string>()
  const stack = [targetKey]
  while (stack.length) {
    const k = stack.pop()!
    const def = defByKey.get(k)
    if (!def) continue
    for (const dep of stepDeps(def, template, orderByKey)) if (!up.has(dep)) (up.add(dep), stack.push(dep))
  }
  up.delete(targetKey)
  return [...up]
}

/**
 * 级联重跑写门禁（新语义，不改 assertRepairable）：
 * run ∈ {completed, failed}；目标步 ∈ {succeeded, failed}；级联集合外无 failed；目标全部传递上游 ∈ {succeeded, skipped}。
 * 返回级联 stepKey 集合（含目标），供 reset 层逐重置。
 */
export async function assertChainRepairable(
  runId: number,
  stepKey: string,
): Promise<{ run: PipelineRun; step: PipelineStep; chainKeys: string[] }> {
  const run = await getRunOrThrow(runId)
  if (run.status === 'running' || run.status === 'queued' || run.status === 'waiting_input') {
    throw new WorkbenchError('run_active', `run 正在执行/排队（${run.status}），请等待收敛后再操作`)
  }
  if (run.status === 'cancelled') {
    throw new WorkbenchError('run_cancelled', 'run 已取消，请走「断点续跑」创建续跑 run')
  }
  if (run.status !== 'completed' && run.status !== 'failed') {
    throw new WorkbenchError('bad_status', `run 状态 ${run.status} 不支持级联重跑`)
  }
  if (isCreationTemplate(run.templateKey) && run.status === 'completed') {
    // 轻松创作已批准制作链「已完成」后再级联重跑=额外生成，须回轻松创作重新确认方案；
    // 但 run=failed 表示批准链路尚未跑完，级联救援只是完成既定方案（执行期 assertRecipeSources 仍独立守方案/素材一致性），故放行。
    throw new WorkbenchError('creation_confirmation_required', '已批准制作链已完成；额外生成请在轻松创作中重新确认方案', 409)
  }
  const step = await getStepOrThrow(runId, stepKey)
  if (step.status !== 'succeeded' && step.status !== 'failed') {
    throw new WorkbenchError('bad_step_status', `步骤「${step.title ?? stepKey}」状态为 ${step.status}，仅 succeeded/failed 可级联重跑`)
  }
  const chainKeys = computeChainKeys(run, stepKey)
  if (!chainKeys) throw new WorkbenchError('bad_chain', '无法解析模板依赖图（模板快照缺失或步骤不在模板内）')
  const chain = new Set(chainKeys)
  const rows = await db
    .select({ id: pipelineSteps.id, status: pipelineSteps.status, stepKey: pipelineSteps.stepKey })
    .from(pipelineSteps)
    .where(eq(pipelineSteps.runId, runId))
  const statusByKey = new Map(rows.map((r) => [r.stepKey, r.status] as const))
  const outsideFailed = rows.filter((r) => r.status === 'failed' && !chain.has(r.stepKey)).map((r) => r.stepKey)
  if (outsideFailed.length > 0) {
    throw new WorkbenchError(
      'other_failed',
      `存在级联范围外的失败步骤（${outsideFailed.join('、')}），请改从该步骤起级联或先修复后再操作`,
    )
  }
  const upstream = computeUpstreamKeys(run, stepKey) ?? []
  const badUpstream = upstream.filter((k) => {
    const st = statusByKey.get(k)
    return st !== 'succeeded' && st !== 'skipped'
  })
  if (badUpstream.length > 0) {
    throw new WorkbenchError(
      'upstream_not_ready',
      `上游步骤（${badUpstream.join('、')}）未成功，请改从更早步骤起级联`,
    )
  }
  return { run, step, chainKeys }
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

/** 分镜源定位：目标步骤 input.shots[0] → 分镜资产（产出侧最新优先）→ JSON 解析（裸数组 / {shots:[]}） */
export async function resolveStoryboardSource(run: PipelineRun, step: PipelineStep): Promise<StoryboardSource> {
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
export async function findProducerStep(asset: Asset, run: PipelineRun): Promise<PipelineStep | null> {
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
