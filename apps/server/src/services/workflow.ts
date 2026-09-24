/**
 * 自动编排链服务（真 orchestrator，spec §2）
 * - 数据层 CRUD（workflows 表）+ 链视图投影
 * - advanceWorkflow：run 落定 → 链推进（P0 为受守卫的骨架桩，P1 实装九步算法）
 * - 纯服务层新增：不碰 engine.ts / dag.ts / loader.ts / refs.ts（复用既有 onRunSettled 钩子 + createRunRow + engine.startRun）
 * 计费安全：autoAdvance 默认关；每跳前预算闸门；失败暂停不自动重试。
 */
import { and, asc, desc, eq, inArray, isNull, sum } from 'drizzle-orm'
import { db } from '../db'
import { assets, pipelineRuns, pipelineSteps, usageRecords, workflows, type Asset, type Workflow } from '../db/schema'
import { createLogger } from '../logger'
import { engine } from '../pipeline/engine'
import { loadTemplate } from '../pipeline/loader'
import type { Template } from '../pipeline/types'
import { checkBudget } from './budget'
import { emitStudioEvent } from './events'
import { createRunRow } from './run-create'
import { readTextAsset } from './storage'
import { assetInput, safeRecordExecSnapshot, type ExecInputSpec } from './provenance'

const log = createLogger('workflow')

/** 段定义：按序引用既有模板；inputSpec 为字段→取值语法映射（P1 resolveSegmentInput 消费） */
export interface WorkflowSegment {
  templateKey: string
  inputSpec?: Record<string, string>
}

export function parseSegments(raw: string): WorkflowSegment[] {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as WorkflowSegment[]) : []
  } catch {
    return []
  }
}

// ========== 查询 ==========

export async function listWorkflows(q: { projectId?: number; status?: string }): Promise<Workflow[]> {
  const conds = []
  if (q.projectId !== undefined) conds.push(eq(workflows.projectId, q.projectId))
  if (q.status) conds.push(eq(workflows.status, q.status))
  const base = db.select().from(workflows)
  const rows = conds.length ? await base.where(and(...conds)) : await base
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export async function getWorkflow(id: number): Promise<Workflow | null> {
  const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1)
  return rows[0] ?? null
}

// ========== 建 / 改 / 删 ==========

export async function createWorkflow(p: {
  projectId: number
  name: string
  segments: WorkflowSegment[]
  autoAdvance?: number
  budgetCap?: number | null
  note?: string | null
}): Promise<Workflow> {
  const t = Date.now()
  const row = await db
    .insert(workflows)
    .values({
      projectId: p.projectId,
      name: (p.name ?? '').trim() || '未命名编排链',
      status: 'draft',
      autoAdvance: p.autoAdvance === 1 ? 1 : 0,
      budgetCap: p.budgetCap ?? null,
      segments: JSON.stringify(p.segments ?? []),
      note: p.note ?? null,
      createdAt: t,
      updatedAt: t,
    })
    .returning()
  return row[0]!
}

/** 更新链定义；active 链改 segments 需先 draft|paused（由路由层守卫，服务层仅落库） */
export async function updateWorkflow(
  id: number,
  patch: Partial<Pick<Workflow, 'name' | 'autoAdvance' | 'budgetCap' | 'note'>> & { segments?: WorkflowSegment[] },
): Promise<Workflow | null> {
  const cur = await getWorkflow(id)
  if (!cur) return null
  const next: Partial<Workflow> = { updatedAt: Date.now() }
  if (patch.name !== undefined) next.name = patch.name
  if (patch.autoAdvance !== undefined) next.autoAdvance = patch.autoAdvance === 1 ? 1 : 0
  if (patch.budgetCap !== undefined) next.budgetCap = patch.budgetCap
  if (patch.note !== undefined) next.note = patch.note
  if (patch.segments !== undefined) next.segments = JSON.stringify(patch.segments)
  await db.update(workflows).set(next).where(eq(workflows.id, id))
  return getWorkflow(id)
}

/** 删除：仅 draft|done|cancelled（其余状态由路由层守卫） */
export async function deleteWorkflow(id: number): Promise<boolean> {
  const cur = await getWorkflow(id)
  if (!cur) return false
  await db.delete(workflows).where(eq(workflows.id, id))
  return true
}

/** 克隆（I2 编排层引用复用）：复制 name/segments/budgetCap → 新 draft 链 */
export async function cloneWorkflow(id: number): Promise<Workflow | null> {
  const cur = await getWorkflow(id)
  if (!cur) return null
  return createWorkflow({
    projectId: cur.projectId,
    name: `${cur.name}（副本）`,
    segments: parseSegments(cur.segments),
    autoAdvance: 0, // 克隆默认关自动级联（计费安全）
    budgetCap: cur.budgetCap,
    note: cur.note,
  })
}

// ========== 状态转移（start/pause/resume）==========

export async function setWorkflowStatus(id: number, status: Workflow['status']): Promise<Workflow | null> {
  const cur = await getWorkflow(id)
  if (!cur) return null
  await db.update(workflows).set({ status, updatedAt: Date.now() }).where(eq(workflows.id, id))
  const fresh = await getWorkflow(id)
  if (fresh) log.info(`workflow ${id} status: ${cur.status} → ${status}`)
  return fresh
}

// ========== 链有效性校验（纯函数；spec §2.1）==========

export interface ChainValidation {
  ok: boolean
  errors: string[]
  /** 软提示（不阻断）：段序列与上游 template.next 不一致 */
  warnings: string[]
}

/**
 * 校验链定义：segments 非空、每段 templateKey ∈ 已注册模板；
 * `next` 一致性仅软校验（不强制等于 template.next，给 warning）。
 */
export function validateWorkflowChainDoc(segments: WorkflowSegment[]): ChainValidation {
  const errors: string[] = []
  const warnings: string[] = []
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, errors: ['segments 需为非空数组'], warnings }
  }
  let prevTemplate: Template | null = null
  segments.forEach((s, i) => {
    if (!s || typeof s.templateKey !== 'string' || !s.templateKey.trim()) {
      errors.push(`第 ${i + 1} 段缺 templateKey`)
      prevTemplate = null
      return
    }
    let t: Template | undefined
    try {
      t = loadTemplate(s.templateKey)
    } catch {
      errors.push(`第 ${i + 1} 段模板不存在：${s.templateKey}`)
    }
    if (t) {
      if (prevTemplate && Array.isArray(prevTemplate.next) && prevTemplate.next.length && !prevTemplate.next.includes(t.key)) {
        warnings.push(`第 ${i + 1} 段 ${t.key} 不在上一段 ${prevTemplate.key} 推荐 next 中（软提示）`)
      }
      prevTemplate = t
    }
  })
  return { ok: errors.length === 0, errors, warnings }
}

// ========== 段输入映射（spec §2.1 resolveSegmentInput）==========

export interface SegmentInputResult {
  inputs: Record<string, unknown>
  /** 模板 required 且未提供且无 default 的输入键（非空 → input 阻塞） */
  missingRequired: string[]
  /** 本次经 $prev.* 令牌命中的上游产物资产 id（含 $prev.text 字符串来料），供跨段版本溯源 */
  prevSources: number[]
}

/** 取上一段 run 指定 purpose 的产物资产行（升序；无 run → []）
 *  双链路口径（与 novel-board.orderedAssetRows 对齐）：step.output.asset_ids ∪ assets.runId，
 *  兼容 manual_ingest（仅落 step.output）与 writeTextAsset(runId) 两类产物登记。*/
async function prevAssetsByPurpose(prevRunId: number | null, purpose: string): Promise<Asset[]> {
  if (prevRunId == null) return []
  const idSet = new Set<number>()
  const stepRows = await db.select({ output: pipelineSteps.output }).from(pipelineSteps).where(eq(pipelineSteps.runId, prevRunId))
  for (const s of stepRows) {
    try {
      const doc = JSON.parse(s.output ?? '{}') as { asset_ids?: unknown }
      if (Array.isArray(doc.asset_ids)) for (const n of doc.asset_ids) if (typeof n === 'number') idSet.add(n)
    } catch {
      /* 脏 output 忽略 */
    }
  }
  const runLinked = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.runId, prevRunId), isNull(assets.deletedAt)))
  for (const r of runLinked) idSet.add(r.id)
  const ids = [...idSet]
  if (!ids.length) return []
  return db
    .select()
    .from(assets)
    .where(and(inArray(assets.id, ids), eq(assets.purpose, purpose), isNull(assets.deletedAt)))
    .orderBy(asc(assets.id))
}

/** 取上一段 run 指定 purpose 的产物资产 id（升序） */
async function prevAssetIdsByPurpose(prevRunId: number | null, purpose: string): Promise<number[]> {
  return (await prevAssetsByPurpose(prevRunId, purpose)).map((a) => a.id)
}

/** 解析单个 inputSpec token（$prev.* 取上游产物；否则字面量）；不可解析 → undefined。
 * sink 收集本次命中的上游资产 id（含 $prev.text 字符串来料），不改返回值语义。 */
async function resolveToken(token: string, prevRunId: number | null, sink: number[]): Promise<unknown> {
  if (typeof token !== 'string') return token
  if (token.startsWith('$prev.assets:')) {
    const ids = await prevAssetIdsByPurpose(prevRunId, token.slice('$prev.assets:'.length))
    if (ids.length) sink.push(...ids)
    return ids.length ? ids : undefined
  }
  if (token.startsWith('$prev.asset:')) {
    const ids = await prevAssetIdsByPurpose(prevRunId, token.slice('$prev.asset:'.length))
    const one = ids[0]
    if (one !== undefined) sink.push(one)
    return one
  }
  if (token.startsWith('$prev.text:')) {
    const purpose = token.slice('$prev.text:'.length)
    const ids = await prevAssetIdsByPurpose(prevRunId, purpose)
    if (!ids.length) return undefined
    sink.push(ids[0]!)
    try {
      return await readTextAsset(ids[0]!)
    } catch {
      return undefined
    }
  }
  return token // 字面量（int/bool 由 normalizeInput 转型）
}

/**
 * 解析段输入（spec §2.1）：按 next 段 inputSpec 逐字段取值（$prev 产物 / 常量）；
 * 无 spec 的字段交由下游 prepareRunInput 应用模板 default；
 * required 且既无 spec 命中又无 default → 记入 missingRequired（触发 input 阻塞）。
 */
export async function resolveSegmentInput(p: {
  template: Template
  prevRunId: number | null
  inputSpec?: Record<string, string>
}): Promise<SegmentInputResult> {
  const spec = p.inputSpec ?? {}
  const inputs: Record<string, unknown> = {}
  const missingRequired: string[] = []
  const prevSources: number[] = []
  for (const def of p.template.inputs) {
    const token = spec[def.key]
    if (token !== undefined) {
      const val = await resolveToken(token, p.prevRunId, prevSources)
      if (val !== undefined && val !== null) inputs[def.key] = val
    }
    if (def.required && inputs[def.key] === undefined && def.default === undefined) {
      missingRequired.push(def.key)
    }
  }
  return { inputs, missingRequired, prevSources }
}

// ========== 链累计成本（budgetCap 核算用）==========

async function chainAccumulatedCost(workflowId: number): Promise<number> {
  const runs = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.workflowId, workflowId))
  const ids = runs.map((r) => r.id)
  if (!ids.length) return 0
  const rows = await db
    .select({ cost: sum(usageRecords.cost) })
    .from(usageRecords)
    .where(inArray(usageRecords.runId, ids))
  const c = rows[0]?.cost
  return c == null ? 0 : Number(c)
}

// ========== 链首段启动 / 恢复（spec §2.3 start/pause/resume）==========

export class WorkflowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

/** 显式启动链首段（仅 draft|paused 且链内无既有 run）；首段 autoAdvance 决定后续是否级联 */
export async function startWorkflow(id: number): Promise<{ workflow: Workflow; runId: number }> {
  const wf = await getWorkflow(id)
  if (!wf) throw new WorkflowError('not_found', `编排链 ${id} 不存在`)
  if (wf.status !== 'draft' && wf.status !== 'paused') {
    throw new WorkflowError('bad_start', `status=${wf.status} 不可启动（仅 draft|paused）`)
  }
  // 同链互斥（与 advanceWorkflow 共享 advancing）：防并发双启动重复创建首段 run（计费安全）
  if (advancing.has(id)) throw new WorkflowError('busy', `编排链 ${id} 正在推进中，请稍后再试`)
  advancing.add(id)
  try {
    const existing = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.workflowId, id)).limit(1)
    if (existing.length) throw new WorkflowError('already_started', '链已启动（续跑请用 resume，或克隆为新链）')
    const segments = parseSegments(wf.segments)
    const first = segments[0]
    if (!first) throw new WorkflowError('empty_chain', '链无段可启动')
    let template: Template
    try {
      template = loadTemplate(first.templateKey)
    } catch {
      throw new WorkflowError('bad_template', `首段模板不存在：${first.templateKey}`)
    }
    const { inputs, missingRequired } = await resolveSegmentInput({ template, prevRunId: null, inputSpec: first.inputSpec })
    if (missingRequired.length) {
      throw new WorkflowError('bad_input', `首段必填输入未满足：${missingRequired.join(', ')}`)
    }
    // [F06] 预算闸门：首段启动与 advanceWorkflowCore ⑦ 同源拦截（此前首段绕过熔断，仅后续段受检）
    const budgetHit = await checkBudget({ projectId: wf.projectId })
    if (budgetHit) throw new WorkflowError('budget_exceeded', budgetHit.message)
    const run = await createRunRow({
      projectId: wf.projectId,
      templateKey: first.templateKey,
      input: inputs,
      workflowId: wf.id,
      workflowSeq: 0,
    })
    const fresh = (await setWorkflowStatus(id, 'active'))!
    engine.startRun(run.id)
    return { workflow: fresh, runId: run.id }
  } finally {
    advancing.delete(id)
  }
}

/**
 * 恢复链（paused→active）并重新驱动（spec §2.3 断点恢复）。
 * 修复 CodeReview #1 resume 死锁：仅置 active 不会重发 settle 事件，预算/输入阻塞解除后或
 * 事后开启 autoAdvance 时链会永久卡住。此处取链内最大 seq 的已落定 run 重新走 advanceWorkflow
 * （同链互斥 + 步骤9b 下游存在性守卫保幂等）：completed → 重试推进；failed/cancelled → 依不自动重试语义重新暂停。
 */
export async function resumeWorkflow(id: number): Promise<Workflow> {
  const wf = await getWorkflow(id)
  if (!wf) throw new WorkflowError('not_found', `编排链 ${id} 不存在`)
  if (wf.status !== 'paused') throw new WorkflowError('bad_resume', `status=${wf.status} 不可续跑（仅 paused）`)
  const fresh = await setWorkflowStatus(id, 'active')
  if (!fresh) throw new WorkflowError('not_found', `编排链 ${id} 不存在`)
  // 取链内最大 seq 的已落定 run 重新驱动
  const lastSettled = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workflowId, id), inArray(pipelineRuns.status, ['completed', 'failed', 'cancelled'])))
    .orderBy(desc(pipelineRuns.workflowSeq), desc(pipelineRuns.id))
    .limit(1)
  const last = lastSettled[0]
  if (last) await advanceWorkflow(last.id)
  return (await getWorkflow(id)) ?? fresh
}

// ========== 链推进（orchestrator 核心；九步算法 spec §2.2）==========

/** 同链推进互斥（对齐 batch pumps 批内互斥，防并发 settle 重入） */
const advancing = new Set<number>()

/** engine 钩子入口（index.ts 注册 onRunSettled(advanceWorkflow)）：非编排 run 直返 + 同链互斥 */
export async function advanceWorkflow(runId: number): Promise<void> {
  const rows = await db
    .select({ workflowId: pipelineRuns.workflowId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1)
  const workflowId = rows[0]?.workflowId
  if (workflowId == null) return // 非编排 run
  if (advancing.has(workflowId)) return // 同链互斥
  advancing.add(workflowId)
  try {
    await advanceWorkflowCore(runId, workflowId)
  } finally {
    advancing.delete(workflowId)
  }
}

async function advanceWorkflowCore(runId: number, workflowId: number): Promise<void> {
  const runRows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = runRows[0]
  if (!run) return
  const wf = await getWorkflow(workflowId)
  if (!wf || wf.status !== 'active') return // ②

  // ③ 失败/取消 → 暂停，不重试
  if (run.status === 'failed' || run.status === 'cancelled') {
    await setWorkflowStatus(workflowId, 'paused')
    emitStudioEvent({ type: 'workflow.blocked', workflowId, projectId: wf.projectId, runId, reason: 'failed' })
    return
  }
  // ④ 仅完成态推进
  if (run.status !== 'completed') return

  const seq = run.workflowSeq ?? 0
  // ⑤ autoAdvance 关 → 仅提示段完成，不自动触发
  if (wf.autoAdvance !== 1) {
    emitStudioEvent({ type: 'workflow.segment_done', workflowId, projectId: wf.projectId, runId, seq })
    return
  }
  const segments = parseSegments(wf.segments)
  const next = segments[seq + 1]
  // ⑥ 无下一段 → 链完成
  if (!next) {
    await setWorkflowStatus(workflowId, 'done')
    emitStudioEvent({ type: 'workflow.completed', workflowId, projectId: wf.projectId })
    return
  }

  // ⑦ 预算闸门：project 预算 + 链级 budgetCap
  const budgetHit = await checkBudget({ projectId: wf.projectId })
  if (budgetHit) {
    await setWorkflowStatus(workflowId, 'paused')
    emitStudioEvent({ type: 'workflow.blocked', workflowId, projectId: wf.projectId, runId, reason: 'budget' })
    log.warn(`workflow ${workflowId} 预算拦截（project）：${budgetHit.message}`)
    return
  }
  if (wf.budgetCap != null) {
    const chainCost = await chainAccumulatedCost(workflowId)
    if (chainCost >= wf.budgetCap) {
      await setWorkflowStatus(workflowId, 'paused')
      emitStudioEvent({ type: 'workflow.blocked', workflowId, projectId: wf.projectId, runId, reason: 'budget' })
      log.warn(`workflow ${workflowId} 链级预算上限命中（${chainCost} >= ${wf.budgetCap}）`)
      return
    }
  }

  // ⑧ 输入解析：required 未满足 → input 阻塞（不触发）
  let template: Template
  try {
    template = loadTemplate(next.templateKey)
  } catch {
    await setWorkflowStatus(workflowId, 'paused')
    emitStudioEvent({ type: 'workflow.blocked', workflowId, projectId: wf.projectId, runId, reason: 'input' })
    return
  }
  const { inputs, missingRequired, prevSources } = await resolveSegmentInput({ template, prevRunId: runId, inputSpec: next.inputSpec })
  if (missingRequired.length) {
    await setWorkflowStatus(workflowId, 'paused')
    emitStudioEvent({ type: 'workflow.blocked', workflowId, projectId: wf.projectId, runId, reason: 'input' })
    log.warn(`workflow ${workflowId} 输入阻塞：${missingRequired.join(', ')}`)
    return
  }

  // ⑨ 创建并启动下一段 run
  // 9a 状态复核（防 pause TOCTOU）：预算/输入解析为异步，期间用户可能已暂停 → 重读确认仍 active 才落库
  const freshWf = await getWorkflow(workflowId)
  if (!freshWf || freshWf.status !== 'active') return
  // 9b 下游存在性幂等守卫（防 settle 重放/并发双建同 seq 下游 run → 重复计费）
  const dup = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workflowId, workflowId), eq(pipelineRuns.workflowSeq, seq + 1)))
    .limit(1)
  if (dup.length) return
  const newRun = await createRunRow({
    projectId: freshWf.projectId,
    templateKey: next.templateKey,
    input: inputs,
    workflowId,
    workflowSeq: seq + 1,
  })
  engine.startRun(newRun.id)
  emitStudioEvent({ type: 'workflow.advanced', workflowId, projectId: wf.projectId, fromRunId: runId, toRunId: newRun.id, seq: seq + 1 })
  log.info(`workflow ${workflowId} 推进段 ${seq}→${seq + 1}（run ${runId}→${newRun.id}）`)
  // 跨段版本溯源：将本段经 $prev.*（尤其 $prev.text 字符串）命中的上游资产版本随新 run 带出（旁路，不改推进/预算/幂等语义）
  if (prevSources.length > 0) {
    const inputs: ExecInputSpec[] = []
    for (const aid of new Set(prevSources)) inputs.push(await assetInput('prev_text', aid))
    await safeRecordExecSnapshot({
      projectId: freshWf.projectId,
      execKind: 'pipeline_step',
      runId: newRun.id,
      templateKey: next.templateKey,
      inputs,
    })
  }
}

// ========== 视图投影 ==========

export function toWorkflowView(w: Workflow): Record<string, unknown> {
  return {
    id: w.id,
    projectId: w.projectId,
    name: w.name,
    status: w.status,
    autoAdvance: w.autoAdvance,
    budgetCap: w.budgetCap,
    segments: parseSegments(w.segments),
    note: w.note,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }
}
