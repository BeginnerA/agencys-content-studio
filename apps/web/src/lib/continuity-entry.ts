/**
 * 各入口「承接批准」adapter（纯函数，探针可直接以 fake api 调用；组件只转发）。
 * 语义（–12.4）：
 *   - 未批准 / 未对确切 unknownUseId 再次费用同意 → 返回 {sent:false} 且绝不发请求；
 *   - 批准后恰 1 条请求，body 顶层携 continuityApproval / continuity_approval 与 approvalHash；
 *   - 目标变化后旧包失效由调用方（useCreationContinuity 的 target 签名）保证，adapter 只读传入值；
 *   - chain 段间推进的 requestKey 纳入 approvalHash：换包绝不沿用旧幂等键。
 * 请求体键名以服务端 strict Zod 为准（creation-chat: camelCase continuityApproval；
 * run/workflow: snake_case continuity_approval / unknown_use_id / accept_possible_duplicate_cost）。
 */
import type { Approval, TargetRequest } from './types/continuity'
import type { RunStartBody, runApi } from './api/runs'
import type { creationChatApi } from './api/creation-chat'
import type { workflowApi } from './api/workflows'
import type {
  CreationChainAdvanceBody,
  CreationProjectMeta,
  CreationRouteConfirmBody,
} from './types/creation-chat'

/** 分组入口 api 形状：组内方法保持真实签名（渐进收窄，假桩只实现被调方法）。 */
export interface RunEntryApi {
  start: typeof runApi.start
  resume: typeof runApi.resume
}
export interface ChatEntryApi {
  confirm: typeof creationChatApi.confirm
  advanceChain: typeof creationChatApi.advanceChain
}
export interface WorkflowEntryApi {
  create: typeof workflowApi.create
  start: typeof workflowApi.start
  resume: typeof workflowApi.resume
}
export interface ContinuityEntryApis {
  run: RunEntryApi
  chat: ChatEntryApi
  workflow: WorkflowEntryApi
}

export type EntryBlockReason = 'approval_required' | 'unknown_consent_required'

export interface EntryBlocked {
  sent: false
  reason: EntryBlockReason
  message: string
}

export type EntryOutcome<T = unknown> = { sent: true; result: T } | EntryBlocked

const APPROVAL_REQUIRED =
  '启用跨集剧情连续性后，需先在承接预览中确认并冻结承接包'
const UNKNOWN_REQUIRED =
  '存在未知费用遗留：需针对该笔消费精确接受可能的重复计费'

function missingApproval(): EntryBlocked {
  return {
    sent: false,
    reason: 'approval_required',
    message: APPROVAL_REQUIRED,
  }
}

// ===== 目标构建（与 briefing / 服务端 TargetRequest 逐字段一致） =====

/** 手动启动目标：input 与最终 run input 同源（预览/冻结/建 run 的 inputHash 才能对上）。 */
export function manualTarget(input: {
  episodeId: number
  templateKey: string
  fields: Record<string, unknown>
  withContinuity: boolean
}): TargetRequest {
  return {
    kind: 'manual',
    episodeId: input.episodeId,
    templateKey: input.templateKey,
    input: input.withContinuity
      ? { ...input.fields, with_continuity: true }
      : { ...input.fields },
  }
}

/** route 目标：定位字段来自会话当前决策（revision/hash），不含任何执行体细节。 */
export function routeTarget(input: {
  sessionId: number
  decisionRevision: number
  decisionHash: string
}): TargetRequest {
  return {
    kind: 'route',
    sessionId: input.sessionId,
    decisionRevision: input.decisionRevision,
    decisionHash: input.decisionHash,
  }
}

/** workflow 目标：当前推进位置（首段=0/null；后续段=lastSeq+1/lastRunId）。 */
export function workflowTarget(
  workflowId: number,
  nextSeq: number,
  previousRunId: number | null,
): Extract<TargetRequest, { kind: 'workflow' }> {
  return { kind: 'workflow', workflowId, nextSeq, previousRunId }
}

/** resume 目标：普通断点续跑（目标步需重跑时冻结到此 run）。 */
export function resumeTarget(runId: number): TargetRequest {
  return { kind: 'resume', runId }
}

// ===== 手动启动（RunFormModal） =====

export interface ManualRunRequest {
  projectId: number
  templateKey: string
  /** 用户表单字段（brief / episode_number / files / _params…），不含保留槽位 */
  input: Record<string, unknown>
  withContinuity: boolean
  approval: Approval | null
}

/** run 请求体：input 两键（with_continuity + continuity_context 槽位）与顶层批准句柄。 */
export function manualRunBody(req: ManualRunRequest): RunStartBody {
  const approval = req.approval
  const input: Record<string, unknown> = { ...req.input }
  if (req.withContinuity && approval) {
    input['with_continuity'] = true
    input['continuity_context'] = [approval.document.assetId]
  }
  return {
    template_key: req.templateKey,
    input,
    ...(req.withContinuity && approval
      ? { continuity_approval: approval }
      : {}),
  }
}

export async function submitManualRun(
  api: { run: Pick<RunEntryApi, 'start'> },
  req: ManualRunRequest,
): Promise<EntryOutcome<{ run: { id: number } }>> {
  if (req.withContinuity && !req.approval) return missingApproval()
  const result = await api.run.start(req.projectId, manualRunBody(req))
  return { sent: true, result: result as { run: { id: number } } }
}

// ===== route 确认（AgentDecisionCard → confirmRoute） =====

export interface RouteConfirmRequest {
  sessionId: number
  decisionRevision: number
  decisionHash: string
  /** 既有幂等键纪律（confirmKey）由调用方维护 */
  idempotencyKey: string
  acceptUnpriced: boolean
  project?: Partial<CreationProjectMeta>
  withContinuity: boolean
  approval: Approval | null
}

export function routeConfirmBody(
  req: RouteConfirmRequest,
): CreationRouteConfirmBody {
  return {
    decisionRevision: req.decisionRevision,
    decisionHash: req.decisionHash,
    idempotencyKey: req.idempotencyKey,
    acceptUnpriced: req.acceptUnpriced,
    ...(req.project ? { project: req.project } : {}),
    ...(req.withContinuity && req.approval
      ? { continuityApproval: req.approval }
      : {}),
  }
}

export async function confirmRoute(
  api: { chat: Pick<ChatEntryApi, 'confirm'> },
  req: RouteConfirmRequest,
): Promise<EntryOutcome<{ runId: number }>> {
  if (req.withContinuity && !req.approval) return missingApproval()
  const result = await api.chat.confirm(req.sessionId, routeConfirmBody(req))
  return { sent: true, result: result as { runId: number } }
}

// ===== 链段间推进（use-creation-chain / ChainAwaitingCard） =====

/**
 * 段间推进幂等键：原签名（会话/链/在制 run）继续由调用方维护；
 * 再叠加 approvalHash 前 16 位——同一推进位置换包即换键，绝不沿用旧 request key。
 */
export function chainAdvanceKey(
  baseKey: string,
  approvalHash: string | null,
): string {
  return approvalHash ? `${baseKey}-${approvalHash.slice(0, 16)}` : baseKey
}

export interface ChainAdvanceRequest {
  sessionId: number
  /** 既有 ticket.key（调用方按 workflowId+runId 签名维护） */
  keyBase: string
  approval: Approval | null
  requiresApproval: boolean
}

export function chainAdvanceBody(
  req: ChainAdvanceRequest,
): CreationChainAdvanceBody {
  return {
    idempotencyKey: chainAdvanceKey(
      req.keyBase,
      req.approval?.approvalHash ?? null,
    ),
    ...(req.approval ? { continuityApproval: req.approval } : {}),
  }
}

export async function advanceChain(
  api: { chat: Pick<ChatEntryApi, 'advanceChain'> },
  req: ChainAdvanceRequest,
): Promise<EntryOutcome> {
  if (req.requiresApproval && !req.approval) return missingApproval()
  const result = await api.chat.advanceChain(
    req.sessionId,
    chainAdvanceBody(req),
  )
  return { sent: true, result }
}

// ===== 编排链 start / resume（workflows-section） =====

/**
 * 段是否声明跨集承接：服务端 resolveSegmentInput 只按 inputSpec 键建链段输入，
 * 再以 workflowContinuityEnabled（true/1/'1'/'true'）判定——前端按同一真值口径预判，
 * 不做「有键即启用」的宽判（'0'/'false' 不应打开批准面）。
 */
export function segmentUsesContinuity(
  segment:
    | {
        inputSpec?: Record<string, unknown>
      }
    | null
    | undefined,
): boolean {
  const token = segment?.inputSpec?.['with_continuity']
  return token === true || token === 1 || token === '1' || token === 'true'
}

export interface WorkflowEntryRequest {
  workflowId: number
  nextSeq: number
  previousRunId: number | null
  approval: Approval | null
  /** 当前推进段是否声明了承接（由预览/服务端 continuityBlock 判定） */
  requiresApproval: boolean
}

export function workflowEntryBody(
  req: WorkflowEntryRequest,
): Record<string, unknown> | undefined {
  return req.approval ? { continuity_approval: req.approval } : undefined
}

export async function startWorkflow(
  api: { workflow: Pick<WorkflowEntryApi, 'start'> },
  req: WorkflowEntryRequest,
): Promise<EntryOutcome> {
  if (req.requiresApproval && !req.approval) return missingApproval()
  const result = await api.workflow.start(
    req.workflowId,
    workflowEntryBody(req),
  )
  return { sent: true, result }
}

export async function resumeWorkflow(
  api: { workflow: Pick<WorkflowEntryApi, 'resume'> },
  req: WorkflowEntryRequest,
): Promise<EntryOutcome> {
  if (req.requiresApproval && !req.approval) return missingApproval()
  const result = await api.workflow.resume(
    req.workflowId,
    workflowEntryBody(req),
  )
  return { sent: true, result }
}

// ===== chain-builder「创建并启动」 =====
export interface ChainCreateStartRequest {
  projectId: number
  name: string
  segments: Array<{ templateKey: string }>
  autoAdvance: 0 | 1
  budgetCap: number | null
  approval: Approval | null
  requiresApproval: boolean
  /** 用户点「创建并启动」= true；取消只建草稿链 = false */
  startAfter: boolean
}

export interface ChainCreateStartResult {
  workflowId: number
  started: boolean
  reason?: EntryBlockReason
  message?: string
  /** 建链软提示（next 一致性等），与旧 save() 一样透出 */
  warnings?: string[]
}

/**
 * 先建链（草稿）再启动首段：启动必须携批准，绝不绕过共享预览面。
 * 未批准/取消 → 只保存草稿链、不启动（草稿可在链详情继续）。
 */
export async function createAndStartChain(
  api: { workflow: Pick<WorkflowEntryApi, 'create' | 'start'> },
  req: ChainCreateStartRequest,
): Promise<ChainCreateStartResult> {
  const created = (await api.workflow.create(req.projectId, {
    name: req.name,
    segments: req.segments,
    autoAdvance: req.autoAdvance,
    budgetCap: req.budgetCap,
  })) as { workflow: { id: number }; warnings: string[] }
  const workflowId = created.workflow.id
  const warnings = created.warnings ?? []
  if (!req.startAfter) return { workflowId, started: false, warnings }
  if (req.requiresApproval && !req.approval) {
    return {
      workflowId,
      started: false,
      reason: 'approval_required',
      message: APPROVAL_REQUIRED,
      warnings,
    }
  }
  await api.workflow.start(
    workflowId,
    req.approval ? { continuity_approval: req.approval } : undefined,
  )
  return { workflowId, started: true, warnings }
}

// ===== 普通 run resume（confirm.ts） =====

export type ResumeKind = 'off' | 'inherit' | 'rerun'

/**
 * 续跑判定只认服务端预检（GET /runs/:id → continuityResume）：服务端按源 run 快照与持久
 * 消费证据裁决，前端若自行从步骤元数据推断，会在「目标步已成功但需免费继承」时误判为 rerun
 * 并携带批准，被端点以 continuity_conflict 拒绝。缺失/阻断面显式转为 blocked。
 */
export function resumePlanOf(detail: {
  continuityResume?: { kind: string; code?: string }
}): { kind: ResumeKind } | { kind: 'blocked'; reason: string } {
  const pre = detail.continuityResume
  if (!pre)
    return { kind: 'blocked', reason: '服务端未提供续跑预检，请刷新后重试' }
  if (pre.kind === 'off' || pre.kind === 'inherit' || pre.kind === 'rerun')
    return { kind: pre.kind }
  return {
    kind: 'blocked',
    reason: `续跑预检未通过（${pre.code ?? pre.kind}），请先处理源运行或模板问题`,
  }
}

export interface ResumeRunRequest {
  runId: number
  kind: ResumeKind
  approval: Approval | null
  /** 预览给出的未知费用遗留行 id（Preview.unknownUseId） */
  unknownUseId: number | null
  acceptedDuplicateCost: boolean
  /** 用户本次点选同意的确切 useId（必须与 unknownUseId 一致才发请求） */
  acceptedUnknownUseId?: number | null
  /** 既有非连续性续跑字段（confirm_ambiguous / accept_config_drift） */
  extra?: Record<string, unknown>
}

export function resumeRunBody(req: ResumeRunRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(req.extra ?? {}) }
  if (req.kind !== 'rerun') return body
  if (req.approval) body['continuity_approval'] = req.approval
  if (req.unknownUseId !== null) {
    body['unknown_use_id'] = req.unknownUseId
    body['accept_possible_duplicate_cost'] = true
  }
  return body
}

export async function resumeRun(
  api: { run: Pick<RunEntryApi, 'resume'> },
  req: ResumeRunRequest,
): Promise<EntryOutcome> {
  if (req.kind === 'rerun') {
    if (!req.approval) return missingApproval()
    if (req.unknownUseId !== null) {
      const consented =
        req.acceptedDuplicateCost === true &&
        req.acceptedUnknownUseId === req.unknownUseId
      if (!consented)
        return {
          sent: false,
          reason: 'unknown_consent_required',
          message: UNKNOWN_REQUIRED,
        }
    }
  }
  const result = await api.run.resume(req.runId, resumeRunBody(req))
  return { sent: true, result }
}
