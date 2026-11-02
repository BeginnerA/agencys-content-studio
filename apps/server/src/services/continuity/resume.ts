/**
 * 普通断点续跑的连续性决策与绑定（M70 Task9）：
 *   - prepareContinuityResume：源 run 事务内重读 → 决策 off / inherit / rerun（只读，不落库）
 *   - bindContinuityResume：派生 run 复制完成后的同事务绑定（rerun CAS 认领 / inherit 证据权威回写）
 *
 * 语义红线（设计 §9.1–9.2）：
 *   - 启用与否只认源 run 的模板快照，绝不加载最新模板；快照缺失/非法 → 阻断 400，不许静默降级为普通续跑；
 *   - inherit 只认持久消费证据（completed 消费行 / continuity_inherit 元数据链），验证输出版本可读且产物
 *     归属实际产生的原 run/step；绝不把旧 context 绑定挪给新 run，绝不重新执行目标步；
 *   - 「输出已持久但步骤状态尚未更新」优先复用持久产物——不把「数据库未写 succeeded」当供应商失败；
 *   - rerun 必须携带冻结于本源 run 的 resume 批准，目标逐项（种类/归属/快照哈希/步骤/输入哈希）比对，
 *     过期源一律 409；目标步需重跑而无包 → 409 continuity_gaps_unaccepted；
 *   - 未知费用闸：run 级 undecided（unknown/dispatching）消费遗留必须精确同意——
 *     accept_possible_duplicate_cost=true + exact unknown_use_id + 包内 duplicateCostAcceptance 三者齐备，
 *     bool=true 不得一次性放行全部未知；
 *   - 携带的批准绝不静默忽略（Task7 Minor⑤）：off/inherit 决策遇批准 → 409 continuity_conflict。
 *
 * llm 双链分工不在本模块（调用链在 ai_text/invocation：目标步 llmOptions 0/24000，非目标步 ctx.settings.llm
 * 0.8/12000）；本模块只决定派生 run 的输入槽位与台账绑定，rerun 后的目标步执行仍走既有连续性调用链。
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { assets, contentContinuityRecords as records, pipelineRuns, pipelineSteps,
  type PipelineRun } from '../../db/schema'
import type { Template } from '../../pipeline/types'
import { ContinuityError, UseDocSchema, type Approval, type Executor, type UseDoc } from './contract'
import { canonicalHash } from './fold'
import { readContext } from './context'
import { continuityIO } from './runtime'
import { assertRawContinuityIntent, claimContext } from './run-binding'
import { readContinuityVersion } from './sources'
import { effectiveInput, resumeSnapshotTemplate, snapshotHashOf, targetStep } from './targets'

export type ResumeDecision =
  | { kind: 'off' }
  | { kind: 'inherit'; originalRunId: number; originalStepId: number; useId: number }
  | { kind: 'rerun'; approval: Approval; unknownUseId: number | null }

/** 只读预检面（GET /runs/:id）：前端据此决定是否先冻 resume 包，绝不自行推断决策。 */
export type ResumePreflight =
  | { kind: 'off' }
  | { kind: 'inherit'; originalRunId: number; originalStepId: number; useId: number }
  | { kind: 'rerun'; unknownUseId: number | null }

export interface ResumeContinuityRequest {
  /** 已冻结承接包批准句柄（仅 rerun 决策消费；off/inherit 携带即显式冲突）。 */
  continuityApproval?: Approval
  /** 未知费用同意指向的精确消费行 id（必须与遗留行 id 和包内 consent 三方一致）。 */
  unknownUseId?: number
  /** 显式接受可能的重复计费；仅 true 生效，绝不作为「放行全部未知」的开关。 */
  acceptPossibleDuplicateCost?: boolean
}

type InheritEvidence = { originalRunId: number; originalStepId: number; useId: number }

type ResumeCore =
  | { kind: 'off' }
  | { kind: 'inherit'; originalRunId: number; originalStepId: number; useId: number }
  /** rerun 需要冻结于本源 run 的批准；材质在决策时一并解析，避免重复读模板。 */
  | { kind: 'rerun'; template: Template; raw: Record<string, unknown>; stepKey: string }

/**
 * 续跑决策内核（只读，无批准闸）：prepare 与 GET 预检共用同一判定，防止前端与端点各写一套。
 * 语义同 prepareContinuityResume 注释；异常（快照缺失/不支持/来源非法）由调用方映射。
 */
async function decideResumeCore(ex: Executor, src: PipelineRun): Promise<ResumeCore> {
  const raw = parseObject(src.input)
  if (raw === null) return { kind: 'off' }
  if (!rawEnabled(raw)) return { kind: 'off' }
  // 启用与否只认源 run 快照（设计 §9.2）：缺失/非法/key 不符 → 阻断，绝不静默换最新模板。
  const template = resumeSnapshotTemplate(src)
  // 与建 run 创建闸同口径：先判不支持（目标步形态/必备声明/开关与槽位声明），不许静默降级。
  assertRawContinuityIntent(template, raw)
  const step = targetStep(template)
  const [srcStep] = await ex.select().from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, src.id), eq(pipelineSteps.stepKey, step.key)))
    .orderBy(asc(pipelineSteps.seq)).limit(1)
  if (srcStep?.status === 'skipped') return { kind: 'off' }
  const evidence = srcStep ? await inheritEvidence(ex, src, srcStep) : null
  if (evidence) return { kind: 'inherit', originalRunId: evidence.originalRunId,
    originalStepId: evidence.originalStepId, useId: evidence.useId }
  if (srcStep?.status === 'succeeded') return { kind: 'off' }
  return { kind: 'rerun', template, raw, stepKey: step.key }
}

/** GET /runs/:id 预检：与 POST resume 同源判定 + 未知费用遗留 id（不消费、不闸、不落库）。 */
export async function previewContinuityResume(ex: Executor, src: PipelineRun): Promise<ResumePreflight> {
  const core = await decideResumeCore(ex, src)
  if (core.kind !== 'rerun') return core
  const [pending] = await ex.select({ id: records.id }).from(records)
    .where(and(eq(records.projectId, src.projectId), eq(records.rowType, 'consumption'),
      eq(records.runId, src.id), inArray(records.status, ['unknown', 'dispatching'])))
    .orderBy(desc(records.id)).limit(1)
  return { kind: 'rerun', unknownUseId: pending?.id ?? null }
}

/** 与 run-binding rawEnabled 同口径镜像（布尔兼容 true/1/'1'/'true'）；两处必须同步演进。 */
const rawEnabled = (raw: Record<string, unknown>): boolean =>
  raw['with_continuity'] === true || raw['with_continuity'] === 1 || raw['with_continuity'] === '1' || raw['with_continuity'] === 'true'

/** rerun 新输入：剥旧槽位 → 仍启用则换挂本次冻结批准的包资产（与 createRunRow 的槽位契约一致）。 */
export function continuityRerunInput(raw: Record<string, unknown>, approval: Approval): Record<string, unknown> {
  const input = { ...raw }
  delete input['continuity_context']
  if (rawEnabled(input)) input['with_continuity'] = true
  input['continuity_context'] = [approval.document.assetId]
  return input
}

const parseObject = (json: string | null): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(json ?? 'null')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* 非法存储输入按遗留数据处理 */ }
  return null
}

function readInheritMeta(stepOutputJson: string | null): InheritEvidence | null {
  const output = parseObject(stepOutputJson)
  if (!output) return null
  const meta = output['continuity_inherit']
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const { originalRunId, originalStepId, useId } = meta as Record<string, unknown>
  const safeId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
  return safeId(originalRunId) && safeId(originalStepId) && safeId(useId)
    ? { originalRunId, originalStepId, useId } : null
}

/** gate 人工拒绝的持久决策（output.gate.decision==='reject'）：被否定旧稿的 completed 消费不得继承。 */
function gateRejected(stepOutputJson: string | null): boolean {
  const output = parseObject(stepOutputJson)
  if (!output) return false
  const gate = output['gate']
  return !!gate && typeof gate === 'object' && !Array.isArray(gate)
    && (gate as Record<string, unknown>)['decision'] === 'reject'
}

async function completedUseDoc(ex: Executor, projectId: number, useRow: typeof records.$inferSelect): Promise<UseDoc | null> {
  if (useRow.documentAssetId === null || useRow.documentVersionId === null || useRow.documentHash === null) return null
  try {
    const text = await readContinuityVersion(ex, projectId,
      { assetId: useRow.documentAssetId, versionId: useRow.documentVersionId, hash: useRow.documentHash })
    return UseDocSchema.parse(JSON.parse(text))
  } catch { return null }
}

/** 证据可用性：completed UseDoc + 输出版本可读 + 产物资产归属该消费行声明的 run/step。 */
async function usableInherit(ex: Executor, projectId: number, useRow: typeof records.$inferSelect): Promise<boolean> {
  if (useRow.status !== 'completed' || useRow.runId === null || useRow.stepId === null) return false
  const doc = await completedUseDoc(ex, projectId, useRow)
  if (doc?.state !== 'completed' || !doc.output) return false
  const [asset] = await ex.select({ runId: assets.runId, stepId: assets.stepId }).from(assets)
    .where(eq(assets.id, doc.output.assetId)).limit(1)
  return !!asset && asset.runId === useRow.runId && asset.stepId === useRow.stepId
}

/**
 * inherit 证据定位（持久优先，设计 §6.1「输出已持久但步骤状态尚未更新时也优先复用」）：
 *   ① 源步本身是续跑继承产物 → continuity_inherit 元数据逐代传递（定位实际产生的原 run/step 的消费行）；
 *      元数据失效（行被删/归属漂移）→ 不继承：机制上安全保留（不认领不重跑不记账）。
 *   ② 常规证据：本 run/step 最新 completed 消费行，UseDoc completed + 输出可读 + 产物归属本 run/step。
 * gate reject / waiting_input（未审）一律 fail-closed 不继承 → 走 rerun。
 */
async function inheritEvidence(ex: Executor, src: PipelineRun, srcStep: typeof pipelineSteps.$inferSelect)
    : Promise<InheritEvidence | null> {
  if (srcStep.status === 'waiting_input' || gateRejected(srcStep.output)) return null
  const meta = readInheritMeta(srcStep.output)
  if (meta) {
    const [useRow] = await ex.select().from(records).where(and(eq(records.id, meta.useId),
      eq(records.rowType, 'consumption'), eq(records.runId, meta.originalRunId),
      eq(records.stepId, meta.originalStepId))).limit(1)
    if (useRow && await usableInherit(ex, src.projectId, useRow)) return meta
    return null
  }
  const [useRow] = await ex.select().from(records)
    .where(and(eq(records.projectId, src.projectId), eq(records.rowType, 'consumption'),
      eq(records.runId, src.id), eq(records.stepId, srcStep.id), eq(records.status, 'completed')))
    .orderBy(desc(records.id)).limit(1)
  if (useRow && await usableInherit(ex, src.projectId, useRow)) {
    return { originalRunId: useRow.runId!, originalStepId: useRow.stepId!, useId: useRow.id }
  }
  return null
}

/** rerun 裁决：未知费用精确同意闸 + 批准句柄全字段校验 + 目标逐项重建比对。 */
async function rerunDecision(ex: Executor, src: PipelineRun, template: Template, stepKey: string,
    raw: Record<string, unknown>, request: ResumeContinuityRequest)
    : Promise<Extract<ResumeDecision, { kind: 'rerun' }>> {
  // 未知费用闸先行：undecided 遗留是持久事实，优先于「缺批准」呈现（与冻结侧 unknown 闸同向）。
  const [pending] = await ex.select().from(records)
    .where(and(eq(records.projectId, src.projectId), eq(records.rowType, 'consumption'),
      eq(records.runId, src.id), inArray(records.status, ['unknown', 'dispatching'])))
    .orderBy(desc(records.id)).limit(1)
  const approval = request.continuityApproval
  const doc = approval ? await readContext(src.projectId, approval, ex) : null
  if (pending) {
    // 三要素缺一不可：显式旗标 + exact unknown_use_id + 包内 duplicateCostAcceptance 指向同一行
    // （bool=true 绝不作为「一次性放行全部未知」的开关）。
    const consented = request.acceptPossibleDuplicateCost === true
      && request.unknownUseId === pending.id
      && doc?.duplicateCostAcceptance?.useId === pending.id
    if (!consented) throw new ContinuityError('continuity_outcome_unknown', 409)
  }
  if (!doc || !approval) throw new ContinuityError('continuity_gaps_unaccepted', 409)
  // 批准目标必须是「冻结于本源 run」的 resume 包：种类与归属不符即 changed，绝不接受过期源。
  if (doc.target.request.kind !== 'resume' || doc.target.request.runId !== src.id) {
    throw new ContinuityError('continuity_context_changed', 409)
  }
  if (doc.target.unit.projectId !== src.projectId) throw new ContinuityError('continuity_source_invalid', 404)
  // 过期源快照/步骤漂移（同 key 不同内容、目标步变化）→ 409；快照缺失/非法在建闸已阻断。
  if (doc.target.templateKey !== template.key || doc.target.stepKey !== stepKey
    || doc.target.templateSnapshotHash !== snapshotHashOf(template)) {
    throw new ContinuityError('continuity_context_changed', 409)
  }
  // 集号不符在 effectiveInput 内抛 continuity_source_invalid(400)（与建 run claim 侧同口径）
  const effective = effectiveInput(template, doc.target.unit, raw)
  if (canonicalHash(effective) !== doc.target.inputHash) throw new ContinuityError('continuity_context_changed', 409)
  return { kind: 'rerun', approval, unknownUseId: pending?.id ?? null }
}

/**
 * 续跑决策（只读；调用方在单事务内先于派生复制执行，异常即整体回滚）：
 *   - off：源未启用连续性 / 目标步 skipped / 终态成功但无有效证据的遗留派生（机制上安全保留）
 *   - inherit：持久消费证据有效 → 保留目标步终态并回写证据元数据（零模型调用、零新记账）
 *   - rerun：目标步需重跑 → 必须携 resume 批准 + 未知费用精确同意
 */
export async function prepareContinuityResume(ex: Executor, sourceRunId: number,
    request: ResumeContinuityRequest): Promise<ResumeDecision> {
  const [src] = await ex.select().from(pipelineRuns).where(eq(pipelineRuns.id, sourceRunId)).limit(1)
  if (!src) throw new ContinuityError('continuity_source_invalid', 404)
  const core = await decideResumeCore(ex, src)
  const decision: ResumeDecision = core.kind === 'rerun'
    ? await rerunDecision(ex, src, core.template, core.stepKey, core.raw, request)
    : core
  // Task7 Minor⑤：携带的批准绝不静默忽略——off/inherit 决策与批准互斥，显式冲突 fail-closed。
  if (decision.kind !== 'rerun' && request.continuityApproval) {
    throw new ContinuityError('continuity_conflict', 409)
  }
  return decision
}

/**
 * 派生 run 绑定（派生复制之后的同事务第二步）：
 *   - rerun：认领前故障注入钩子（默认 no-op，探针 9.2 注入用）→ claimContext CAS 认领
 *     （输家 409 → 整个续跑事务回滚，新 run 不残留，与建 run 认领同款原语）；
 *   - inherit：持久消费证据权威回写新 run 目标步（status=succeeded + 产物 asset_ids + continuity_inherit
 *     元数据；绝不重新执行，绝不把旧 context 绑定挪给新 run）；
 *   - off：零动作。
 */
export async function bindContinuityResume(ex: Executor, newRun: PipelineRun, decision: ResumeDecision): Promise<void> {
  if (decision.kind === 'off') return
  if (decision.kind === 'rerun') {
    continuityIO().fault('before_publish')
    await claimContext(ex, decision.approval, newRun)
    return
  }
  // inherit：以持久消费证据权威重写目标步（源步状态可能是崩溃态，insert 复制尚未定稿）。
  const [useRow] = await ex.select().from(records).where(and(eq(records.id, decision.useId),
    eq(records.rowType, 'consumption'), eq(records.status, 'completed'),
    eq(records.runId, decision.originalRunId), eq(records.stepId, decision.originalStepId))).limit(1)
  if (!useRow) throw new ContinuityError('continuity_source_invalid', 404)
  const doc = await completedUseDoc(ex, newRun.projectId, useRow)
  if (doc?.state !== 'completed' || !doc.output) throw new ContinuityError('continuity_source_invalid', 404)
  const [srcStep] = await ex.select().from(pipelineSteps).where(eq(pipelineSteps.id, decision.originalStepId)).limit(1)
  if (!srcStep || srcStep.runId !== decision.originalRunId) throw new ContinuityError('continuity_source_invalid', 404)
  const [target] = await ex.select().from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, newRun.id), eq(pipelineSteps.stepKey, srcStep.stepKey)))
    .orderBy(asc(pipelineSteps.seq)).limit(1)
  if (!target) throw new ContinuityError('continuity_source_invalid', 404)
  const prior = parseObject(srcStep.output) ?? {}
  // 拒绝闸的旧 gate 不随行（prepare 已排除，belt-and-braces 删除）；批准 gate 与产物一起继承。
  const output: Record<string, unknown> = { ...prior, asset_ids: [doc.output.assetId],
    continuity_inherit: { originalRunId: decision.originalRunId, originalStepId: decision.originalStepId, useId: decision.useId } }
  const gate = prior['gate']
  if (gate && typeof gate === 'object' && !Array.isArray(gate)
    && (gate as Record<string, unknown>)['decision'] === 'reject') delete output['gate']
  const now = Date.now()
  await ex.update(pipelineSteps).set({ status: 'succeeded', input: srcStep.input, output: JSON.stringify(output),
    completedAt: now, updatedAt: now }).where(eq(pipelineSteps.id, target.id))
}
