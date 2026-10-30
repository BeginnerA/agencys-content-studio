/**
 * 统一建 run 的连续性闸门（M70 Task6）：
 *   - assertRawContinuityIntent：normalize 之前的原始两键闸（先判不支持，不许静默丢键当「关闭」）
 *   - verifyClaimTarget / findBoundRun / claimContext：批准句柄校验 → 幂等复用 → CAS 认领
 *   - bindTargetStep / loadTargetPack：两阶段绑定的第二步（run 级在 claim，步骤级在执行前）
 *
 * 错误口径：本模块只抛 ContinuityError（services 不依赖路由层）；建 run 入口把
 * 原始闸拒绝映射为 InvalidRunInputError('bad_input')，认领/绑定冲突按既定码透传
 * （claimed 409 / changed 409 / source_invalid 404·400 / unsupported 400）。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import {
  contentContinuityRecords as records,
  pipelineRuns,
  type ContentContinuityRecord,
  type PipelineRun,
} from '../../db/schema'
import type { StepContext } from '../../pipeline/context'
import { loadTemplate } from '../../pipeline/loader'
import type { Template, TemplateStepDef } from '../../pipeline/types'
import { ContinuityError, type Approval, type ContextDoc, type Executor, type Target } from './contract'
import { canonicalHash } from './fold'
import { documentRef } from './entries'
import { readContext } from './context'
import { effectiveInput, requireTargetInputs } from './targets'

/** 唯一可承接承接包的步骤形态：显式声明 continuity_role=episode_script 的非 batch ai_text 步。 */
export function isContinuityTargetStep(step: TemplateStepDef): boolean {
  return step.action === 'ai_text' && !step.batch
    && (step.params as Record<string, unknown> | undefined)?.['continuity_role'] === 'episode_script'
}

const rawEnabled = (raw: Record<string, unknown>): boolean =>
  raw['with_continuity'] === true || raw['with_continuity'] === 1 || raw['with_continuity'] === '1' || raw['with_continuity'] === 'true'

const rawSlotPresent = (raw: Record<string, unknown>): boolean =>
  raw['continuity_context'] !== undefined && raw['continuity_context'] !== null && raw['continuity_context'] !== ''

const unsupported = (): never => { throw new ContinuityError('continuity_unsupported', 400) }

/**
 * 原始两键闸（normalize 前调用；布尔表示兼容 true/1/'1'/'true'）。
 * 不支持一律 continuity_unsupported(400)，由建 run 入口映射 bad_input——绝不「先丢键再当关闭」放行：
 *   - 携 continuity_context 但未启用（含关闭显式 false）
 *   - 原始启用但无唯一目标步 / 缺 brief+episode_number 声明 / 缺 with_continuity·continuity_context 声明
 * 未启用且未携包 → 直接返回（既有非连续性行为零变更）。
 */
export function assertRawContinuityIntent(template: Template, raw: Record<string, unknown>): void {
  if (rawSlotPresent(raw) && !rawEnabled(raw)) unsupported()
  if (!rawEnabled(raw)) return
  const targets = template.steps.filter(isContinuityTargetStep)
  if (targets.length !== 1) unsupported()
  requireTargetInputs(template)
  const switchDeclared = template.inputs.some(i => i.key === 'with_continuity' && i.kind === 'bool')
  const slotDeclared = template.inputs.some(i => i.key === 'continuity_context' && i.kind === 'files')
  if (!switchDeclared || !slotDeclared) unsupported()
}

/**
 * 批准句柄全字段校验 + 目标重建比对（建 run 认领前的第一道闸）：
 * 归属/状态/哈希由 readContext 把关；目标按「已校验包的 Target 重建」逐项比对——
 * 模板 key、effectiveInput(模板, 冻结单元, 归一化输入) 的 inputHash；集号不符走
 * continuity_source_invalid(400)，输入/模板漂移走 continuity_context_changed(409)。
 * 冻结侧必须以 prepareRunInput 归一化输入冻结（UI 契约）：漂移即 409 fail-closed。
 */
export async function verifyClaimTarget(ex: Executor, projectId: number, templateKey: string,
    approval: Approval, norm: Record<string, unknown>): Promise<ContextDoc> {
  const doc = await readContext(projectId, approval, ex)
  if (doc.target.unit.projectId !== projectId) throw new ContinuityError('continuity_source_invalid', 404)
  const template = loadTemplate(templateKey)
  requireTargetInputs(template)
  if (doc.target.templateKey !== templateKey) throw new ContinuityError('continuity_context_changed', 409)
  // 集号不符在 effectiveInput 内抛 continuity_source_invalid(400)
  const effective = effectiveInput(template, doc.target.unit, norm)
  if (canonicalHash(effective) !== doc.target.inputHash) throw new ContinuityError('continuity_context_changed', 409)
  return doc
}

/** 该批准包当前绑定到的 run（未绑定/行缺失/run 已删 → null）；复用裁决由建 run 入口逐项比较。 */
export async function findBoundRun(ex: Executor, approval: Approval, target: Target): Promise<PipelineRun | null> {
  const [row] = await ex.select().from(records).where(and(eq(records.id, approval.contextId),
    eq(records.projectId, target.unit.projectId), eq(records.rowType, 'context'))).limit(1)
  if (!row || row.status !== 'bound' || row.runId === null) return null
  const [run] = await ex.select().from(pipelineRuns).where(eq(pipelineRuns.id, row.runId)).limit(1)
  return run ?? null
}

/**
 * CAS 认领：frozen → bound 且写入 runId。输家（已被并发/他入口绑定）0 行更新 →
 * continuity_context_claimed(409)；调用方事务随之回滚新建 run，不留孤儿。
 */
export async function claimContext(ex: Executor, approval: Approval, run: PipelineRun): Promise<void> {
  const doc = await readContext(run.projectId, approval, ex)
  if (doc.target.unit.projectId !== run.projectId) throw new ContinuityError('continuity_source_invalid', 404)
  const bound = await ex.update(records).set({ status: 'bound', runId: run.id, stepId: null, updatedAt: Date.now() })
    .where(and(eq(records.id, approval.contextId), eq(records.projectId, run.projectId),
      eq(records.rowType, 'context'), eq(records.status, 'frozen')))
    .returning({ id: records.id })
  if (bound.length === 0) throw new ContinuityError('continuity_context_claimed', 409)
}

/** 步骤级 CAS 绑定（幂等）：同一步重入放行，他人步骤已绑 → claimed(409)。 */
async function bindStepRow(row: ContentContinuityRecord, stepId: number): Promise<void> {
  if (row.stepId === stepId) return
  if (row.stepId !== null) throw new ContinuityError('continuity_context_claimed', 409, row.id)
  const bound = await db.update(records).set({ stepId, updatedAt: Date.now() })
    .where(and(eq(records.id, row.id), isNull(records.stepId))).returning({ id: records.id })
  if (bound.length === 0) throw new ContinuityError('continuity_context_claimed', 409, row.id)
}

/** 公开绑定入口（引擎侧与探针共用）：run 无 bound 台账行时静默返回（执行期由调用证据状态机 404 fail-closed）。 */
export async function bindTargetStep(projectId: number, runId: number, stepId: number): Promise<void> {
  const [row] = await db.select().from(records).where(and(eq(records.projectId, projectId),
    eq(records.rowType, 'context'), eq(records.runId, runId), eq(records.status, 'bound')))
    .orderBy(desc(records.id)).limit(1)
  if (!row) return
  await bindStepRow(row, stepId)
}

export interface TargetPack { doc: ContextDoc; row: ContentContinuityRecord }

/**
 * 执行期装载承接包（ai_text 连续性路径专用）：
 * run 级 bound 行必须存在（缺失 → source_invalid 404，不派发模型），随后步骤级 CAS 绑定
 * （两阶段绑定第二步，先于 executeContinuityText 的归属校验），最后经批准句柄重读冻结文档。
 */
export async function loadTargetPack(ctx: StepContext): Promise<TargetPack> {
  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  if (runInput['with_continuity'] !== true) throw new ContinuityError('continuity_unsupported', 400)
  const [row] = await db.select().from(records).where(and(eq(records.projectId, ctx.run.projectId),
    eq(records.rowType, 'context'), eq(records.runId, ctx.run.id), eq(records.status, 'bound')))
    .orderBy(desc(records.id)).limit(1)
  if (!row) throw new ContinuityError('continuity_source_invalid', 404)
  await bindStepRow(row, ctx.step.id)
  const doc = await readContext(ctx.run.projectId,
    { contextId: row.id, document: documentRef(row), approvalHash: row.approvalHash! }, db)
  // fail-closed：当前步骤必须正是冻结包声明的目标步骤（模板快照 stepKey 比对）
  if (ctx.def.key !== doc.target.stepKey) unsupported()
  return { doc, row }
}
