/**
 * 编排链 → 连续性目标解析桥（M70 Task 7）
 * - resolveWorkflowContinuityTarget：纯定位解析（unit/模板/输入），不建 run、不改链状态、零副作用；
 *   TargetRequest 的 workflowId/nextSeq/previousRunId 只是定位线索而非可信输入——一律从实际链状态
 *   （最近落定 run + 段定义）重导出，与请求不符即 continuity_conflict，旧包/漂移包不得命中当前段。
 * - assertWorkflowApprovalTarget：批准包目标必须恰指「当前推进位置」（kind=workflow + 四元组全匹配），
 *   否则 continuity_context_changed 409；这是旧包/异种包（manual 等）在公共入口被拒的统一语义。
 * - readWorkflowContinuityBlock：只读 blocked 投影（code + target 签名），全部由当前段输入 + 冻结包状态
 *   可重算，不新增任何表列；供路由/链详情在段间暂停时展示「需要哪个段的批准」。
 * 循环依赖说明：workflow.ts ↔ 本模块 ↔ targets.ts 互相引用，但全部经函数级调用
 * （导出一律提升的 function 声明，绝不用 const 箭头函数），ESM 下安全。
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { episodes, pipelineRuns, workflows, type PipelineRun, type Workflow } from '../../db/schema'
import { loadTemplate } from '../../pipeline/loader'
import type { Template } from '../../pipeline/types'
import { InvalidRunInputError, prepareRunInput } from '../run-create'
import { parseSegments, resolveSegmentInput, type WorkflowSegment } from '../workflow'
import { ContinuityError, type ContextDoc, type Executor, type TargetRequest, type Unit } from './contract'
import { resolveUnit } from './scope'

const invalid = (): never => { throw new ContinuityError('continuity_source_invalid', 400) }

/** 原始布尔口径：与 run-binding.ts 的 rawEnabled 逐字一致（run-binding 不在本任务可改清单，镜像并注释对齐）。 */
export function workflowContinuityEnabled(raw: Record<string, unknown>): boolean {
  const v = raw['with_continuity']
  return v === true || v === 1 || v === '1' || v === 'true'
}

/** 当前推进位置快照：最近落定 run → nextSeq/previousRunId → 段定义 → 模板 → 原始段输入。 */
interface WorkflowTransition {
  workflow: Workflow
  settled: PipelineRun | null
  nextSeq: number
  previousRunId: number | null
  segment: WorkflowSegment | null
  template: Template | null
  rawInputs: Record<string, unknown> | null
}

async function workflowTransition(projectId: number, workflowId: number, ex: Executor): Promise<WorkflowTransition> {
  const [wf] = await ex.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1)
  if (!wf || wf.projectId !== projectId) throw new ContinuityError('continuity_source_invalid', 404)
  const [settled] = await ex.select().from(pipelineRuns)
    .where(and(eq(pipelineRuns.workflowId, workflowId), inArray(pipelineRuns.status, ['completed', 'failed', 'cancelled'])))
    .orderBy(desc(pipelineRuns.workflowSeq), desc(pipelineRuns.id)).limit(1)
  const nextSeq = settled ? (settled.workflowSeq ?? 0) + 1 : 0
  const previousRunId = settled ? settled.id : null
  const segment = parseSegments(wf.segments)[nextSeq] ?? null
  let template: Template | null = null
  if (segment) {
    try { template = loadTemplate(segment.templateKey) } catch { template = null }
  }
  let rawInputs: Record<string, unknown> | null = null
  if (segment && template) {
    rawInputs = (await resolveSegmentInput({ template, prevRunId: previousRunId, inputSpec: segment.inputSpec })).inputs
  }
  return { workflow: wf, settled: settled ?? null, nextSeq, previousRunId, segment, template, rawInputs }
}

/** 桥内输入归一化失败按 continuity_source_invalid 呈现（400），不泄漏 InvalidRunInputError 类型。 */
function prepareWorkflowInput(template: Template, raw: Record<string, unknown>): Record<string, unknown> {
  try { return prepareRunInput(template, raw) } catch (error) {
    if (error instanceof InvalidRunInputError) throw new ContinuityError('continuity_source_invalid', 400)
    throw error
  }
}

/** 代码级目标材质：结构同 contract.TargetMaterial，但持真实 Template 类（避免 zod JSONType 推断摩擦）。 */
export interface WorkflowTargetMaterial {
  unit: Unit
  templateKey: string
  template: Template
  input: Record<string, unknown>
}

/**
 * 纯定位解析：workflow 目标 → 当前推进段的目标材质。
 * 段/模板不可解析 → continuity_unsupported 400；请求定位与实际不符 → continuity_conflict 409；
 * 上段非 completed（failed/cancelled 依不自动重试语义不得批准续跑）→ continuity_conflict 409；
 * 集号非法/不存在 → continuity_source_invalid 400/404。with_continuity 统一覆盖为 true；
 * 槽位 continuity_context 在此处绝不注入（由 workflow 服务在批准落地时追加，预览输入不含资产 id）。
 */
export async function resolveWorkflowContinuityTarget(projectId: number, request: Extract<TargetRequest, { kind: 'workflow' }>,
    ex: Executor): Promise<WorkflowTargetMaterial> {
  const t = await workflowTransition(projectId, request.workflowId, ex)
  if (!t.segment || !t.template || !t.rawInputs) throw new ContinuityError('continuity_unsupported', 400)
  if (request.nextSeq !== t.nextSeq || request.previousRunId !== t.previousRunId) {
    throw new ContinuityError('continuity_conflict', 409)
  }
  if (t.settled && t.settled.status !== 'completed') throw new ContinuityError('continuity_conflict', 409)
  const norm = prepareWorkflowInput(t.template, { ...t.rawInputs, with_continuity: true })
  const rawEpisode = norm['episode_number']
  const episodeNumber = typeof rawEpisode === 'number' && Number.isInteger(rawEpisode) ? rawEpisode : invalid()
  const [episode] = await ex.select({ id: episodes.id }).from(episodes)
    .where(and(eq(episodes.projectId, projectId), eq(episodes.number, episodeNumber))).limit(1)
  if (!episode) throw new ContinuityError('continuity_source_invalid', 404)
  const unit = await resolveUnit(projectId, episode.id, ex)
  return { unit, templateKey: t.segment.templateKey, template: t.template, input: norm }
}

/** 批准包目标必须恰指当前推进位置（kind=workflow + workflowId/nextSeq/previousRunId 全匹配），否则 409。 */
export function assertWorkflowApprovalTarget(doc: ContextDoc, workflowId: number, nextSeq: number, previousRunId: number | null): void {
  const req = doc.target.request
  if (req.kind !== 'workflow' || req.workflowId !== workflowId || req.nextSeq !== nextSeq || req.previousRunId !== previousRunId) {
    throw new ContinuityError('continuity_context_changed', 409)
  }
}

/**
 * 只读 blocked 投影：链在当前推进位置因连续性缺批准被阻塞时返回 { code, target }；否则 null。
 * code 优先取解析出的真实分类（旧包 conflict / 集漂移 source_invalid 等），解析成功则统一为
 * continuity_gaps_unaccepted（启用且可解析，仅缺批准）。已存在 nextSeq 的 run（推进中/已推进）→ null。
 */
export async function readWorkflowContinuityBlock(projectId: number, workflowId: number,
    ex: Executor): Promise<{ code: string; target: Extract<TargetRequest, { kind: 'workflow' }> } | null> {
  const t = await workflowTransition(projectId, workflowId, ex)
  if (!t.segment || !t.template || !t.rawInputs) return null
  if (!workflowContinuityEnabled(t.rawInputs)) return null
  const [existing] = await ex.select({ id: pipelineRuns.id }).from(pipelineRuns)
    .where(and(eq(pipelineRuns.workflowId, workflowId), eq(pipelineRuns.workflowSeq, t.nextSeq))).limit(1)
  if (existing) return null
  const target: Extract<TargetRequest, { kind: 'workflow' }> =
    { kind: 'workflow', workflowId, nextSeq: t.nextSeq, previousRunId: t.previousRunId }
  try {
    await resolveWorkflowContinuityTarget(projectId, target, ex)
  } catch (error) {
    if (error instanceof ContinuityError) return { code: error.code, target }
    throw error
  }
  return { code: 'continuity_gaps_unaccepted', target }
}
