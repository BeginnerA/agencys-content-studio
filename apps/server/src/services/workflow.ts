/**
 * 自动编排链服务（真 orchestrator，spec §2）
 * - 数据层 CRUD（workflows 表）+ 链视图投影
 * - advanceWorkflow：run 落定 → 链推进（P0 为受守卫的骨架桩，P1 实装九步算法）
 * - 纯服务层新增：不碰 engine.ts / dag.ts / loader.ts / refs.ts（复用既有 onRunSettled 钩子 + createRunRow + engine.startRun）
 * 计费安全：autoAdvance 默认关；每跳前预算闸门；失败暂停不自动重试。
 */
import { and, asc, desc, eq, inArray, isNull, notInArray, sum } from 'drizzle-orm'
import { db } from '../db'
import { assets, pipelineRuns, pipelineSteps, usageRecords, workflows, type Asset, type PipelineRun, type Workflow } from '../db/schema'
import { createLogger } from '../logger'
import { engine } from '../pipeline/engine'
import { loadTemplate } from '../pipeline/loader'
import type { Template } from '../pipeline/types'
import { checkBudget } from './budget'
import { readContext } from './continuity/context'
import { assertWorkflowApprovalTarget, workflowContinuityEnabled } from './continuity/workflow-bridge'
import { ContinuityError, type Approval } from './continuity/contract'
import { RESERVED_PURPOSES } from './continuity/reserved'
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

/**
 * 写库句柄：既接受模块级 db（独立调用），也接受调用方的事务对象（route 确认要把
 * 「建链 + 置 active + 建首段 run + 绑会话」压进同一事务，任一环节失败整体回滚）。
 * 形状按 db 侧取 Pick——事务对象缺 batch 等旁支方法，用 typeof db 会拒收 tx。
 */
export type WorkflowWriter = Pick<typeof db, 'insert' | 'update' | 'select'>

export async function createWorkflow(p: {
  projectId: number
  name: string
  segments: WorkflowSegment[]
  autoAdvance?: number
  budgetCap?: number | null
  note?: string | null
}, executor: WorkflowWriter = db): Promise<Workflow> {
  const t = Date.now()
  const row = await executor
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

/** 事务内激活链（route 确认专用）：与建链、建首段 run、绑会话同批提交。 */
export async function activateWorkflowIn(tx: WorkflowWriter, id: number): Promise<void> {
  await tx.update(workflows).set({ status: 'active', updatedAt: Date.now() }).where(eq(workflows.id, id))
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
  // M70 保留素材（continuity_*）不参与普通段间自动选材：$prev.assets/$prev.asset/$prev.text 同过滤
  return db
    .select()
    .from(assets)
    .where(and(
      inArray(assets.id, ids), eq(assets.purpose, purpose), isNull(assets.deletedAt),
      notInArray(assets.purpose, [...RESERVED_PURPOSES]),
    ))
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

/** 编排链启动/续跑选项（M70）：已冻结承接包批准句柄；缺省 = 未携包（启用段将 409 阻塞）。 */
export interface WorkflowStartOptions {
  continuityApproval?: Approval
}

/** 批准仅在服务端追加到当前段输入：槽位恒为批准包资产，绝不由调用方注入。无批准且段声明启用 → 显式 409。 */
function withWorkflowApproval(inputs: Record<string, unknown>, approval: Approval | undefined): Record<string, unknown> {
  if (!approval) {
    if (workflowContinuityEnabled(inputs)) throw new ContinuityError('continuity_gaps_unaccepted', 409)
    return inputs
  }
  return { ...inputs, with_continuity: true, continuity_context: [approval.document.assetId] }
}

/**
 * 首段启动闸（纯校验 + 输入解析；不写库、不起 run、零计费）：
 * 链有段 → 段模板可载 → 必填输入可满足 → 预算未熔断。
 * startWorkflow（专业链显式启动）与对话 route 确认（同事务建链建段）同源复用，
 * 杜绝「两条路径各判一次、口径漂移」；调用方据此在同一事务里落首段 run。
 * 入参只取 projectId + segments（序列化后的段定义）：route 确认在链尚未落库时也要能预跑同一套闸。
 * M70：批准经服务端追加进首段输入（预算闸门保持既有优先级，置于批准闸之后）。
 */
export async function prepareFirstSegment(wf: Pick<Workflow, 'projectId' | 'segments'>,
    options: WorkflowStartOptions = {}): Promise<{ templateKey: string; inputs: Record<string, unknown> }> {
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
  return { templateKey: first.templateKey, inputs: withWorkflowApproval(inputs, options.continuityApproval) }
}

/** 显式启动链首段（仅 draft|paused 且链内无既有 run）；首段 autoAdvance 决定后续是否级联 */
export async function startWorkflow(id: number, options: WorkflowStartOptions = {}): Promise<{ workflow: Workflow; runId: number }> {
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
    const first = await prepareFirstSegment(wf, options)
    // M70：批准包必须恰指首段推进位置（旧包/漂移包/异种包 → 409 continuity_context_changed）
    if (options.continuityApproval) await assertApprovalMatchesTransition(wf.projectId, options.continuityApproval, id, 0, null)
    const run = await createRunRow({
      projectId: wf.projectId,
      templateKey: first.templateKey,
      input: first.inputs,
      workflowId: wf.id,
      workflowSeq: 0,
      continuityApproval: options.continuityApproval,
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
 * M70：携带批准时先校验批准恰指「下一推进位置」，再激活并携同一批准驱动推进。
 */
export async function resumeWorkflow(id: number, options: WorkflowStartOptions = {}): Promise<Workflow> {
  const wf = await getWorkflow(id)
  if (!wf) throw new WorkflowError('not_found', `编排链 ${id} 不存在`)
  if (wf.status !== 'paused') throw new WorkflowError('bad_resume', `status=${wf.status} 不可续跑（仅 paused）`)
  // 取链内最大 seq 的已落定 run 重新驱动（先定位后激活，批准校验失败不留下半激活态）
  const lastSettled = await db
    .select({ id: pipelineRuns.id, workflowSeq: pipelineRuns.workflowSeq, status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workflowId, id), inArray(pipelineRuns.status, ['completed', 'failed', 'cancelled'])))
    .orderBy(desc(pipelineRuns.workflowSeq), desc(pipelineRuns.id))
    .limit(1)
  const last = lastSettled[0]
  if (options.continuityApproval && last) {
    await assertApprovalMatchesTransition(wf.projectId, options.continuityApproval, id, (last.workflowSeq ?? 0) + 1, last.id)
  }
  const fresh = await setWorkflowStatus(id, 'active')
  if (!fresh) throw new WorkflowError('not_found', `编排链 ${id} 不存在`)
  if (last) await advanceWorkflow(last.id, options)
  return (await getWorkflow(id)) ?? fresh
}

// ========== 链推进（orchestrator 核心；九步算法 spec §2.2）==========

/** 同链推进互斥（对齐 batch pumps 批内互斥，防并发 settle 重入） */
const advancing = new Set<number>()

/** engine 钩子入口（index.ts 注册 onRunSettled(advanceWorkflow)）：非编排 run 直返 + 同链互斥。
 *  M70：显式续跑入口（resumeWorkflow）可携带批准透传给段推进；engine 自动级联路径不带批准。 */
export async function advanceWorkflow(runId: number, options: WorkflowStartOptions = {}): Promise<void> {
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
    await advanceWorkflowCore(runId, workflowId, options)
  } finally {
    advancing.delete(workflowId)
  }
}

async function advanceWorkflowCore(runId: number, workflowId: number, options: WorkflowStartOptions = {}): Promise<void> {
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
  // ⑤ autoAdvance 关 → 段间暂停：仅提示段完成 + 保持 active（不回写 paused），由对话/链详情侧显式批准续跑（requestNextSegment）
  if (wf.autoAdvance !== 1) {
    emitStudioEvent({ type: 'workflow.segment_done', workflowId, projectId: wf.projectId, runId, seq })
    return
  }
  // ⑥-⑨ 段推进尾逻辑（与对话批准续跑同源复用；行为逐字不变）
  await advanceToNextSegmentGuarded(workflowId, run, wf, parseSegments(wf.segments), options)
}

/** 单段推进结果（对话批准续跑据此回写留痕；autoAdvance 级联路径忽略返回值） */
export type AdvanceOutcome =
  | { kind: 'advanced'; runId: number }
  | { kind: 'done' }
  | { kind: 'blocked'; reason: 'budget' | 'input' | 'state' }
  | { kind: 'inflight' }

/**
 * 输入类阻塞统一收口（M70 提取）：置 paused + 事件 + 日志。
 * runId=null：被阻塞的段尚未建 run（budget/failed 阻塞保持原语义不走此处，web 侧不消费 runId 之外的差异）。
 */
async function pauseForInput(workflowId: number, code: string): Promise<void> {
  const wf = await getWorkflow(workflowId)
  if (!wf) return
  await setWorkflowStatus(workflowId, 'paused')
  emitStudioEvent({ type: 'workflow.blocked', workflowId, projectId: wf.projectId, runId: null, reason: 'input' })
  log.warn(`workflow ${workflowId} 输入阻塞（${code}）：等待当前段预览与批准`)
}

/** 仅连续性输入/批准类 409 映射原 paused/input；budget/state 自身分类与非连续性 bug 一律不吞（原样上抛）。 */
async function advanceToNextSegmentGuarded(workflowId: number, run: PipelineRun, wf: Workflow, segments: WorkflowSegment[],
    options: WorkflowStartOptions = {}): Promise<AdvanceOutcome> {
  try {
    return await advanceToNextSegment(run, wf, workflowId, segments, options)
  } catch (error) {
    if (!(error instanceof ContinuityError) || error.status !== 409) throw error
    await pauseForInput(workflowId, error.code)
    return { kind: 'blocked', reason: 'input' }
  }
}

/** M70：批准包必须恰指「当前推进位置」（旧包/漂移包/异种包 → 409 continuity_context_changed）。 */
async function assertApprovalMatchesTransition(projectId: number, approval: Approval, workflowId: number,
    nextSeq: number, previousRunId: number | null): Promise<void> {
  const doc = await readContext(projectId, approval, db)
  assertWorkflowApprovalTarget(doc, workflowId, nextSeq, previousRunId)
}

/**
 * 段推进尾逻辑（原 advanceWorkflowCore ⑥-⑨ 逐字迁出）：无下一段→done；预算/输入闸门；
 * 状态复核（防 pause TOCTOU）+ 下游存在性幂等守卫（防并发双建同 seq）；建 run 起 run + 跨段溯源。
 * 供 autoAdvance 自动级联与对话「批准续跑」同源复用——不新增编排算法，计费安全同源。
 * M70：批准仅在服务端追加进当前段输入（with_continuity=true + 槽位=批准包资产）；
 * 启用而无批准 → ContinuityError 409（由 guarded 包装映射 paused/input）。
 */
async function advanceToNextSegment(run: PipelineRun, wf: Workflow, workflowId: number, segments: WorkflowSegment[],
    options: WorkflowStartOptions = {}): Promise<AdvanceOutcome> {
  const runId = run.id
  const seq = run.workflowSeq ?? 0
  const next = segments[seq + 1]
  // ⑥ 无下一段 → 链完成
  if (!next) {
    await setWorkflowStatus(workflowId, 'done')
    emitStudioEvent({ type: 'workflow.completed', workflowId, projectId: wf.projectId })
    return { kind: 'done' }
  }

  // ⑦ 预算闸门：project 预算 + 链级 budgetCap
  const budgetHit = await checkBudget({ projectId: wf.projectId })
  if (budgetHit) {
    await setWorkflowStatus(workflowId, 'paused')
    emitStudioEvent({ type: 'workflow.blocked', workflowId, projectId: wf.projectId, runId, reason: 'budget' })
    log.warn(`workflow ${workflowId} 预算拦截（project）：${budgetHit.message}`)
    return { kind: 'blocked', reason: 'budget' }
  }
  if (wf.budgetCap != null) {
    const chainCost = await chainAccumulatedCost(workflowId)
    if (chainCost >= wf.budgetCap) {
      await setWorkflowStatus(workflowId, 'paused')
      emitStudioEvent({ type: 'workflow.blocked', workflowId, projectId: wf.projectId, runId, reason: 'budget' })
      log.warn(`workflow ${workflowId} 链级预算上限命中（${chainCost} >= ${wf.budgetCap}）`)
      return { kind: 'blocked', reason: 'budget' }
    }
  }

  // ⑧ 输入解析：required 未满足 → input 阻塞（不触发）
  let template: Template
  try {
    template = loadTemplate(next.templateKey)
  } catch {
    await pauseForInput(workflowId, 'bad_template')
    return { kind: 'blocked', reason: 'input' }
  }
  const { inputs, missingRequired, prevSources } = await resolveSegmentInput({ template, prevRunId: runId, inputSpec: next.inputSpec })
  if (missingRequired.length) {
    await pauseForInput(workflowId, `missing_required:${missingRequired.join(',')}`)
    return { kind: 'blocked', reason: 'input' }
  }
  // ⑧b M70 连续性闸门：批准仅在服务端追加；声明启用而无批准 → 显式 409（budget 闸门保持既有优先级）
  const approval = options.continuityApproval
  let runInputs = inputs
  if (approval) {
    runInputs = { ...inputs, with_continuity: true, continuity_context: [approval.document.assetId] }
  } else if (workflowContinuityEnabled(inputs)) {
    throw new ContinuityError('continuity_gaps_unaccepted', 409)
  }

  // ⑨ 创建并启动下一段 run
  // 9a 状态复核（防 pause TOCTOU）：预算/输入解析为异步，期间用户可能已暂停 → 重读确认仍 active 才落库
  const freshWf = await getWorkflow(workflowId)
  if (!freshWf || freshWf.status !== 'active') return { kind: 'blocked', reason: 'state' }
  // 9b 下游存在性幂等守卫（防 settle 重放/并发双建同 seq 下游 run → 重复计费）
  const dup = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workflowId, workflowId), eq(pipelineRuns.workflowSeq, seq + 1)))
    .limit(1)
  if (dup.length) return { kind: 'inflight' }
  const newRun = await createRunRow({
    projectId: freshWf.projectId,
    templateKey: next.templateKey,
    input: runInputs,
    workflowId,
    workflowSeq: seq + 1,
    continuityApproval: approval,
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
  return { kind: 'advanced', runId: newRun.id }
}

/**
 * 对话内「批准续跑」显式单段推进（M64 G1）：供创作会话在段间暂停（autoAdvance=0）时按用户批准启动下一段。
 * 复用段推进尾逻辑（预算/输入/幂等/状态复核与自动级联同源），只是绕过 autoAdvance 闸门、每次仅进一步。
 * 同链互斥复用 advancing 集合（与 advanceWorkflow/startWorkflow 共享）；失败/取消段落不批准续跑（依不自动重试语义）。
 * M70：可携带已冻结承接包批准——先校验批准恰指「下一推进位置」（旧包/漂移包/异种包 409），
 * 再携批准推进；未携批准且当前段声明启用 → 409 映射 paused/input（简报逐字口径 blocked/input）。
 */
export async function requestNextSegment(workflowId: number, options: WorkflowStartOptions = {}): Promise<AdvanceOutcome> {
  if (advancing.has(workflowId)) throw new WorkflowError('busy', `编排链 ${workflowId} 正在推进中，请稍后再试`)
  advancing.add(workflowId)
  try {
    const wf = await getWorkflow(workflowId)
    if (!wf) throw new WorkflowError('not_found', `编排链 ${workflowId} 不存在`)
    if (wf.status === 'done' || wf.status === 'cancelled') throw new WorkflowError('bad_state', `status=${wf.status} 的链不可续跑`)
    // 取链内最大 seq 的已落定 run（须 completed 才批准续跑；failed/cancelled 依不自动重试语义拒绝）
    const lastSettled = await db
      .select()
      .from(pipelineRuns)
      .where(and(eq(pipelineRuns.workflowId, workflowId), inArray(pipelineRuns.status, ['completed', 'failed', 'cancelled'])))
      .orderBy(desc(pipelineRuns.workflowSeq), desc(pipelineRuns.id))
      .limit(1)
    const last = lastSettled[0]
    if (!last) throw new WorkflowError('nothing_to_advance', '链上尚无已落定段落，无法续跑')
    if (last.status !== 'completed') return { kind: 'blocked', reason: 'state' }
    // M70：批准定位校验在激活前（失败不留半激活态）
    if (options.continuityApproval) {
      await assertApprovalMatchesTransition(wf.projectId, options.continuityApproval, workflowId, (last.workflowSeq ?? 0) + 1, last.id)
    }
    // 段落被预算/输入阻塞过 → paused：用户批准视作显式继续，归一 active 后过尾逻辑 9a 复核
    if (wf.status === 'paused') await setWorkflowStatus(workflowId, 'active')
    return await advanceToNextSegmentGuarded(workflowId, last, wf, parseSegments(wf.segments), options)
  } finally {
    advancing.delete(workflowId)
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
