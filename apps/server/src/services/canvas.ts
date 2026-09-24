import { asc, eq } from 'drizzle-orm'
import { db } from '../db'
import { genTasks, pipelineRuns, pipelineSteps } from '../db/schema'
import { stepDepEdges } from '../pipeline/dag'
import { loadTemplate, templateForRun } from '../pipeline/loader'
import { interpolate } from '../pipeline/refs'
import { isAmbiguousSubmitted, isCreationTemplate } from './creation-chat/recipe'
import type { Template, TemplateStepDef } from '../pipeline/types'

/**
 * [M15] 流水线画布读模型（纯读零写）：
 * - buildRunCanvas：run 为单位——节点 = 步骤（状态/闸门/任务计数/产物/操作可用性），
 *   边 = 调度依赖边（pipeline/dag 与引擎同源）+ 数据引用边（def.inputs 的 steps.x.asset(s)）；
 * - buildTemplateCanvas：模板设计态——节点 = def 静态信息，边同二类（无运行字段）。
 * 操作可用性仅作 UI 展示判定（reason 文案对齐 assertRepairable）；写门禁仍在各既有端点服务层。
 * 宽容降级：快照损坏回退文件加载（templateForRun 自带）；模板彻底不可得 → 仅按行渲染、边为空。
 */

// ---------- 类型 ----------

export interface CanvasEdge {
  from: string
  to: string
  type: 'sched' | 'data'
  /** 仅 sched：after=显式 / default=缺省前一步 / when=条件表达式隐含 */
  origin?: 'after' | 'default' | 'when'
}

export interface RefEntry {
  field: string
  kind: 'input' | 'step' | 'assets-purpose'
  ref: string
}

export interface CanvasGateInfo {
  mode: string
  message: string
  skipLabel?: string
  when?: string | string[]
}

export interface RunCanvasNode {
  key: string
  /** steps 行 id（抽屉任务过滤 / 重跑弹窗计数用；孤儿行无行 → null） */
  stepId: number | null
  seq: number
  action: string
  title: string
  status: string
  attempts: number
  error: string | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  gate: CanvasGateInfo | null
  gateTrace: { decision: 'approve' | 'reject'; note?: string; at: number } | null
  skippedReason: string | null
  tasks: { total: number; pending: number; processing: number; succeeded: number; failed: number; cancelled: number }
  assetIds: number[]
  /** step.input 快照（解析失败原样；行缺失 → null） */
  input: unknown
  inputsRefs: RefEntry[]
  actions: {
    gate: { approve: boolean; reject: boolean; skip: boolean } | null
    rerun: { allowed: boolean; reason: string | null } | null
    recompose: { allowed: boolean; reason: string | null } | null
    taskRetry: { count: number } | null
  }
}

export interface RunCanvas {
  run: {
    id: number
    projectId: number
    templateKey: string
    templateVersion: number | null
    batchId: number | null
    batchSeq: number | null
    status: string
    currentStepKey: string | null
    error: string | null
    input: unknown
    startedAt: number | null
    completedAt: number | null
    createdAt: number
    updatedAt: number
  }
  template: { key: string; name: string; version: number } | null
  nodes: RunCanvasNode[]
  edges: CanvasEdge[]
  runActions: { canCancel: boolean; canResume: boolean; isCreation: boolean; resumeNeedsVerification: boolean }
}

/** [M23] 模板画布编辑模式：inputs 顶层字段视图（string 原值可编辑；其余 JSON 预览只读） */
export interface InputFieldView {
  key: string
  value: string
  editable: boolean
}

export interface TemplateCanvasNode {
  key: string
  seq: number
  action: string
  title: string
  gate: CanvasGateInfo | null
  when?: string | string[]
  whenAny?: string[]
  after?: string[]
  batch: { field: string; maxConcurrent?: number; retry?: number } | null
  output: { purpose: string } | null
  inputsRefs: RefEntry[]
  /** [M23] inputs 顶层字段视图（编辑模式数据源；spec §2.5） */
  inputFields: InputFieldView[]
}

export interface TemplateCanvas {
  template: { key: string; name: string; version: number; description?: string; genre: string }
  nodes: TemplateCanvasNode[]
  edges: CanvasEdge[]
}

// ---------- run 画布 ----------

/** run 缺失 → null（路由层转 404）；其余宽容降级不抛 */
export async function buildRunCanvas(runId: number): Promise<RunCanvas | null> {
  const runRows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = runRows[0]
  if (!run) return null

  let template: Template | null = null
  try {
    template = templateForRun(run)
  } catch {
    template = null // 快照损坏且文件缺失 → 仅按行渲染（宽容降级）
  }

  const stepRows = await db
    .select()
    .from(pipelineSteps)
    .where(eq(pipelineSteps.runId, runId))
    .orderBy(asc(pipelineSteps.seq))
  const rowsByKey = new Map(stepRows.map((s) => [s.stepKey, s]))
  const failedKeys = stepRows.filter((s) => s.status === 'failed').map((s) => s.stepKey)

  const taskRows = await db
    .select({
      stepId: genTasks.stepId,
      status: genTasks.status,
      attempts: genTasks.attempts,
      taskId: genTasks.taskId,
      resultAssetId: genTasks.resultAssetId,
    })
    .from(genTasks)
    .where(eq(genTasks.runId, runId))
  // [方案C] run 级「受理状态不明」任务数（含孤儿行）：>0 时轻松创作 run 无法就地续跑/重试，须回会话核验
  const runAmbiguous = taskRows.filter(isAmbiguousSubmitted).length
  const tasksByStep = new Map<number, TaskAgg>()
  for (const t of taskRows) {
    if (t.stepId == null) continue
    const agg = tasksByStep.get(t.stepId) ?? emptyTaskAgg()
    agg.total += 1
    if (t.status === 'pending') agg.pending += 1
    else if (t.status === 'processing') agg.processing += 1
    else if (t.status === 'succeeded') agg.succeeded += 1
    else if (t.status === 'failed') agg.failed += 1
    else if (t.status === 'cancelled') agg.cancelled += 1
    if (isAmbiguousSubmitted(t)) agg.ambiguous += 1
    tasksByStep.set(t.stepId, agg)
  }

  const runInput = asRecord(safeParse(run.input))
  const defs = template?.steps ?? []
  const orderByKey = new Map(defs.map((d, i) => [d.key, i]))
  const nodes: RunCanvasNode[] = []
  const usedKeys = new Set<string>()
  for (const def of defs) {
    const row = rowsByKey.get(def.key) ?? null
    usedKeys.add(def.key)
    nodes.push(
      buildRunNode({
        def,
        row,
        run,
        runInput,
        failedKeys,
        tasks: row ? (tasksByStep.get(row.id) ?? emptyTaskAgg()) : emptyTaskAgg(),
        orderByKey,
      }),
    )
  }
  // 孤儿行（def 缺失——快照异常防务）：追加渲染，无 gate/边信息
  for (const row of stepRows) {
    if (usedKeys.has(row.stepKey)) continue
    nodes.push(
      buildRunNode({ def: null, row, run, runInput, failedKeys, tasks: tasksByStep.get(row.id) ?? emptyTaskAgg(), orderByKey }),
    )
  }

  const edges: CanvasEdge[] = []
  const seenEdge = new Set<string>()
  for (const def of defs) {
    pushSchedEdges(def, template!, orderByKey, edges, seenEdge)
    pushDataEdges(def, edges, seenEdge)
  }

  const tplVersion = template?.version ?? snapshotVersion(run.templateSnapshot)
  return {
    run: {
      id: run.id,
      projectId: run.projectId,
      templateKey: run.templateKey,
      templateVersion: tplVersion,
      batchId: run.batchId,
      batchSeq: run.batchSeq,
      status: run.status,
      currentStepKey: run.currentStepKey,
      error: run.error,
      input: runInput,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    template: template ? { key: template.key, name: template.name, version: template.version } : null,
    nodes,
    edges,
    runActions: {
      canCancel: ['queued', 'running', 'waiting_input'].includes(run.status),
      // [方案C] 轻松创作 run：无「受理状态不明」任务时可就地续跑（专业端 resume 委派 retryCreation）；
      // 有则 canResume=false 且 resumeNeedsVerification=true → 顶栏改呈现直达会话核验链接（防重复计费）
      canResume:
        ['failed', 'cancelled'].includes(run.status) &&
        (!isCreationTemplate(run.templateKey) || runAmbiguous === 0),
      isCreation: isCreationTemplate(run.templateKey),
      resumeNeedsVerification: isCreationTemplate(run.templateKey) && runAmbiguous > 0,
    },
  }
}

interface TaskAgg {
  total: number
  pending: number
  processing: number
  succeeded: number
  failed: number
  cancelled: number
  ambiguous: number
}

function emptyTaskAgg(): TaskAgg {
  return { total: 0, pending: 0, processing: 0, succeeded: 0, failed: 0, cancelled: 0, ambiguous: 0 }
}

interface StepOutputLite {
  asset_ids?: unknown
  gate?: { decision?: unknown; note?: unknown; at?: unknown }
  skipped?: { reason?: unknown }
}

function buildRunNode(ctx: {
  def: TemplateStepDef | null
  row: typeof pipelineSteps.$inferSelect | null
  run: typeof pipelineRuns.$inferSelect
  runInput: Record<string, unknown>
  failedKeys: string[]
  tasks: TaskAgg
  orderByKey: Map<string, number>
}): RunCanvasNode {
  const { def, row, run, runInput, failedKeys, tasks, orderByKey } = ctx
  const key = row?.stepKey ?? def!.key
  const status = row?.status ?? 'pending'
  const output = asRecord(safeParse(row?.output ?? null)) as StepOutputLite
  const assetIds = Array.isArray(output.asset_ids)
    ? output.asset_ids.filter((v): v is number => typeof v === 'number')
    : []
  const gateTrace = parseGateTrace(output.gate)
  const skippedReason = typeof output.skipped?.reason === 'string' ? output.skipped.reason : null

  const candidate = status === 'succeeded' || status === 'failed'
  const rerun = candidate ? computeRerun(run.status, status, key, failedKeys) : null
  const actionKey = row?.actionKey ?? def?.action ?? ''
  const gateDef = def?.gate ?? null
  const gateInfo: CanvasGateInfo | null = gateDef
    ? { mode: gateDef.mode, message: gateMessage(gateDef.message, runInput), skipLabel: gateDef.skip_label, when: gateDef.when }
    : null
  const retryables = tasks.failed + tasks.cancelled
  // [方案C] 批准链 run：无「受理状态不明」任务的节点允许就地重试（与 POST /tasks/:id/retry 逐任务守卫同源）；
  // 含状态不明任务的节点不呈现重试（服务端必 409），引导回会话核验
  const runAllowsRetry =
    !['completed', 'waiting_input', 'running'].includes(run.status) &&
    (!isCreationTemplate(run.templateKey) || tasks.ambiguous === 0)

  return {
    key,
    stepId: row?.id ?? null,
    seq: row?.seq ?? orderByKey.get(key) ?? 0,
    action: actionKey,
    title: row?.title ?? def?.title ?? key,
    status,
    attempts: row?.attempts ?? 0,
    error: row?.error ?? null,
    startedAt: row?.startedAt ?? null,
    completedAt: row?.completedAt ?? null,
    durationMs: row?.startedAt && row.completedAt ? row.completedAt - row.startedAt : null,
    gate: gateInfo,
    gateTrace,
    skippedReason,
    tasks,
    assetIds,
    input: row ? safeParse(row.input) : null,
    inputsRefs: def ? collectRefs(def.inputs) : [],
    actions: {
      gate:
        status === 'waiting_input' && gateDef
          ? { approve: true, reject: true, skip: Boolean(gateDef.skip_label) }
          : null,
      rerun,
      recompose: actionKey === 'ffmpeg_merge' && candidate ? { ...rerun! } : null,
      taskRetry: retryables > 0 && runAllowsRetry ? { count: retryables } : null,
    },
  }
}

/**
 * 返修门禁只读判定（UI 提示用）：与 shot-workbench assertRepairable 同条件同文案；
 * 本判定不等价写门禁（写端点仍二次校验）。
 */
function computeRerun(
  runStatus: string,
  stepStatus: string,
  stepKey: string,
  failedKeys: string[],
): { allowed: boolean; reason: string | null } {
  if (runStatus === 'running' || runStatus === 'queued' || runStatus === 'waiting_input') {
    return { allowed: false, reason: `run 正在执行/排队（${runStatus}），请等待收敛后再操作` }
  }
  if (runStatus === 'cancelled') {
    return { allowed: false, reason: 'run 已取消，请走「断点续跑」创建续跑 run' }
  }
  if (runStatus !== 'completed' && runStatus !== 'failed') {
    return { allowed: false, reason: `run 状态 ${runStatus} 不支持返修` }
  }
  if (stepStatus !== 'succeeded' && stepStatus !== 'failed') {
    return { allowed: false, reason: `步骤状态为 ${stepStatus}，仅 succeeded/failed 可返修` }
  }
  const others = failedKeys.filter((k) => k !== stepKey)
  if (others.length > 0) {
    return { allowed: false, reason: `存在其他失败步骤（${others.join('、')}），请先修复后再操作` }
  }
  return { allowed: true, reason: null }
}

/** gate 文案内插（缺值 → 原文兜底，不炸） */
function gateMessage(message: string, runInput: Record<string, unknown>): string {
  try {
    return interpolate(message, runInput)
  } catch {
    return message
  }
}

function parseGateTrace(raw: StepOutputLite['gate']): RunCanvasNode['gateTrace'] {
  if (!raw) return null
  const decision = raw.decision
  if (decision !== 'approve' && decision !== 'reject') return null
  const note = typeof raw.note === 'string' ? raw.note : undefined
  const at = typeof raw.at === 'number' ? raw.at : 0
  return { decision, note, at }
}

// ---------- 模板画布 ----------

/** 模板不存在 → loadTemplate 抛错（路由层转 404） */
export async function buildTemplateCanvas(key: string): Promise<TemplateCanvas> {
  const template = loadTemplate(key)
  const orderByKey = new Map(template.steps.map((d, i) => [d.key, i]))
  const nodes: TemplateCanvasNode[] = template.steps.map((def, i) => ({
    key: def.key,
    seq: i,
    action: def.action,
    title: def.title,
    gate: def.gate
      ? { mode: def.gate.mode, message: def.gate.message, skipLabel: def.gate.skip_label, when: def.gate.when }
      : null,
    when: def.when,
    whenAny: def.when_any,
    after: def.after,
    batch: def.batch ? { field: def.batch.field, maxConcurrent: def.batch.maxConcurrent, retry: def.batch.retry } : null,
    output: def.output ?? null,
    inputsRefs: collectRefs(def.inputs),
    inputFields: inputFieldsOf(def.inputs),
  }))
  const edges: CanvasEdge[] = []
  const seenEdge = new Set<string>()
  for (const def of template.steps) {
    pushSchedEdges(def, template, orderByKey, edges, seenEdge)
    pushDataEdges(def, edges, seenEdge)
  }
  return {
    template: {
      key: template.key,
      name: template.name,
      version: template.version,
      description: template.description,
      genre: template.genre,
    },
    nodes,
    edges,
  }
}

// ---------- 边与引用扫描 ----------

function pushSchedEdges(
  def: TemplateStepDef,
  template: Template,
  orderByKey: Map<string, number>,
  edges: CanvasEdge[],
  seenEdge: Set<string>,
): void {
  for (const e of stepDepEdges(def, template, orderByKey)) {
    const k = `${e.from}|${def.key}|sched`
    if (seenEdge.has(k)) continue
    seenEdge.add(k)
    edges.push({ from: e.from, to: def.key, type: 'sched', origin: e.origin })
  }
}

/** 数据引用边：def.inputs 中 steps.x.asset(s) 整串引用（对齐 refs.ts FULL_REF 的 steps 形态） */
function pushDataEdges(def: TemplateStepDef, edges: CanvasEdge[], seenEdge: Set<string>): void {
  for (const entry of collectRefs(def.inputs)) {
    if (entry.kind !== 'step') continue
    const m = /^steps\.([\w-]+)\.(asset|assets)$/.exec(entry.ref)
    const from = m?.[1]
    if (!from || from === def.key) continue
    const k = `${from}|${def.key}|data`
    if (seenEdge.has(k)) continue
    seenEdge.add(k)
    edges.push({ from, to: def.key, type: 'data' })
  }
}

const STEP_REF = /^steps\.([\w-]+)\.(asset|assets)$/
const INPUT_REF = /^input\.([\w-]+)$/
const PURPOSE_REF = /^assets purpose=([\w-]+)$/
const INTERP_REF = /\{((?:input\.)?[\w-]+)(?::(0\d+)d)?\}/g

/** 扫描 inputs 全量引用（整串四形态 + 串内插 input）→ 去重清单 */
function collectRefs(inputs: Record<string, unknown>): RefEntry[] {
  const out: RefEntry[] = []
  const seen = new Set<string>()
  const push = (field: string, kind: RefEntry['kind'], ref: string): void => {
    const k = `${field}|${kind}|${ref}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ field, kind, ref })
  }
  const scan = (v: unknown, field: string): void => {
    if (typeof v === 'string') {
      if (STEP_REF.test(v)) {
        push(field, 'step', v)
        return
      }
      if (INPUT_REF.test(v)) {
        push(field, 'input', v)
        return
      }
      if (PURPOSE_REF.test(v)) {
        push(field, 'assets-purpose', v)
        return
      }
      for (const m of v.matchAll(INTERP_REF)) {
        push(field, 'input', `input.${m[1]!.replace(/^input\./, '')}`)
      }
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) scan(item, field)
      return
    }
    if (v && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) scan(val, field)
    }
  }
  for (const [field, v] of Object.entries(inputs)) scan(v, field)
  return out
}

/** [M23] inputs 顶层字段视图：string → 可编辑原值；其余 → JSON 预览（截断 400，只读） */
const INPUT_PREVIEW_CAP = 400

function inputFieldsOf(inputs: Record<string, unknown>): InputFieldView[] {
  return Object.entries(inputs).map(([key, v]) => {
    if (typeof v === 'string') return { key, value: v, editable: true }
    let json: string
    try {
      json = JSON.stringify(v) ?? String(v)
    } catch {
      json = String(v)
    }
    return {
      key,
      value: json.length > INPUT_PREVIEW_CAP ? `${json.slice(0, INPUT_PREVIEW_CAP)}…` : json,
      editable: false,
    }
  })
}

// ---------- 小工具 ----------

function safeParse(s: string | null): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function snapshotVersion(snapshot: string | null): number | null {
  if (!snapshot) return null
  try {
    const v = (JSON.parse(snapshot) as { version?: unknown }).version
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}
