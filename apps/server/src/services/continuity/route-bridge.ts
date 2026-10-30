/**
 * 创作会话（route 决策）→ 连续性目标解析桥（M70 Task 8）
 * - resolveRouteContinuityTarget：纯定位解析（unit/模板/输入），不建 run、不改会话、零副作用；
 *   TargetRequest 的 sessionId/decisionRevision/decisionHash 只是定位线索而非可信输入——一律从
 *   实际会话行重导出，与请求不符即 continuity_conflict 409，旧包/漂移包不得命中当前决策。
 *   目标材质取会话决策的第一执行体（template/synth = 该模板输入；chain = 首段输入，与
 *   startChain 的 toWorkflowToken + resolveSegmentInput 同源，不偷换为另一段）；
 *   集号一律取归一输入的 episode_number 真值，非法 400 / 无该集 404，绝不自动建剧猜号。
 * - assertRouteApprovalTarget：批准包目标必须恰指「当前会话决策位置」（kind=route +
 *   sessionId/decisionRevision/decisionHash 全匹配），否则 continuity_context_changed 409；
 *   这是旧包/异种包（manual/workflow 等）在公共确认入口被拒的统一语义。
 * 循环依赖说明：targets.ts ↔ 本模块 ↔ run-create.ts 互相引用，但全部经函数级调用
 * （导出一律提升的 function 声明，绝不用 const 箭头函数），ESM 下安全（与 workflow-bridge 同律）。
 */
import { and, eq } from 'drizzle-orm'
import { creationSessions, episodes } from '../../db/schema'
import { loadTemplate } from '../../pipeline/loader'
import type { Template } from '../../pipeline/types'
import { InvalidRunInputError, prepareRunInput } from '../run-create'
import { resolveSegmentInput } from '../workflow'
import { materializeRouteInputs } from '../creation-chat/route-inputs'
import { agentDecisionSchema } from '../creation-chat/agent/decision-schema'
import { toWorkflowToken } from '../creation-chat/agent/normalize'
import { ContinuityError, type ContextDoc, type Executor, type TargetRequest, type Unit } from './contract'
import { resolveUnit } from './scope'

const unsupported = (): never => { throw new ContinuityError('continuity_unsupported', 400) }
const invalid = (): never => { throw new ContinuityError('continuity_source_invalid', 400) }

/** 代码级目标材质：结构同 contract.TargetMaterial，但持真实 Template 类（避免 zod JSONType 推断摩擦）。 */
export interface RouteTargetMaterial {
  unit: Unit
  templateKey: string
  template: Template
  input: Record<string, unknown>
}

/** 桥内输入归一化失败按 continuity_source_invalid 呈现（400），不泄漏 InvalidRunInputError 类型。 */
function prepareRouteInput(template: Template, raw: Record<string, unknown>): Record<string, unknown> {
  try { return prepareRunInput(template, raw) } catch (error) {
    if (error instanceof InvalidRunInputError) throw new ContinuityError('continuity_source_invalid', 400)
    throw error
  }
}

/** 会话当前决策快照：行存在性/归属 + 归一决策（easy/解析失败均不支持承接）。定位漂移 → 409。
 * 返回类型不注解（由 parsed.data 推断）：显式 AgentDecision 注解会触发 zod 深实例化 TS2719 重复类型问题。 */
async function routeDecisionSnapshot(projectId: number, request: Extract<TargetRequest, { kind: 'route' }>,
    ex: Executor) {
  const [session] = await ex.select().from(creationSessions).where(eq(creationSessions.id, request.sessionId)).limit(1)
  if (!session || session.projectId !== projectId) throw new ContinuityError('continuity_source_invalid', 404)
  let rawDecision: unknown = null
  try { rawDecision = session.decision ? JSON.parse(session.decision) : null } catch { rawDecision = null }
  const parsed = agentDecisionSchema.safeParse(rawDecision)
  if (!parsed.success || parsed.data.mode === 'easy') {
    // 直接 throw（而非经 unsupported()）：保证 CFA 收窄 parsed.data，避免 TS18048 级联
    throw new ContinuityError('continuity_unsupported', 400)
  }
  if (request.decisionRevision !== session.planRevision || request.decisionHash !== session.decisionHash) {
    throw new ContinuityError('continuity_conflict', 409)
  }
  return { decision: parsed.data, planRevision: session.planRevision, decisionHash: session.decisionHash! }
}

/** 归一输入 → 剧集定位 → 连续性单元（episode_number 取输入真值，不猜号）。 */
async function unitOf(projectId: number, norm: Record<string, unknown>, ex: Executor): Promise<Unit> {
  const rawEpisode = norm['episode_number']
  const episodeNumber = typeof rawEpisode === 'number' && Number.isInteger(rawEpisode) ? rawEpisode : invalid()
  const [episode] = await ex.select({ id: episodes.id }).from(episodes)
    .where(and(eq(episodes.projectId, projectId), eq(episodes.number, episodeNumber))).limit(1)
  if (!episode) throw new ContinuityError('continuity_source_invalid', 404)
  return resolveUnit(projectId, episode.id, ex)
}

function loadTargetTemplate(templateKey: string): Template {
  try { return loadTemplate(templateKey) } catch { return unsupported() }
}

/**
 * 纯定位解析：route 目标 → 会话决策第一执行体的目标材质。
 * 会话不存在/跨项目 → continuity_source_invalid 404；决策不可解析/easy → continuity_unsupported 400；
 * 请求定位与会话现值不符 → continuity_conflict 409；模板不可载 → continuity_unsupported 400；
 * 输入归一化失败 → continuity_source_invalid 400；集号非法/不存在 → continuity_source_invalid 400/404。
 * with_continuity 统一覆盖为 true（route 冻结包即连续性包）；槽位 continuity_context 在此处绝不注入
 * （由确认服务在批准落地时追加，预览输入不含资产 id）。模板级支持性（单非 batch 目标步 / 必备声明）
 * 仍由 targets.materializeTarget 的 targetStep/requireTargetInputs 把守，本桥不重复裁决。
 */
export async function resolveRouteContinuityTarget(projectId: number, request: Extract<TargetRequest, { kind: 'route' }>,
    ex: Executor): Promise<RouteTargetMaterial> {
  const snapshot = await routeDecisionSnapshot(projectId, request, ex)
  const decision = snapshot.decision
  if (decision.mode === 'chain' && decision.chain) {
    const seg = decision.chain[0]!
    const template = loadTargetTemplate(seg.templateKey)
    // 与 startChain 同源：InputSpecItem → token 字符串 → resolveSegmentInput（不另判一套）
    const spec: Record<string, string> = {}
    for (const [k, v] of Object.entries(seg.inputSpec)) { const t = toWorkflowToken(v); if (t !== undefined) spec[k] = t }
    const { inputs } = await resolveSegmentInput({ template, prevRunId: null, inputSpec: spec })
    const norm = prepareRouteInput(template, { ...inputs, with_continuity: true })
    return { unit: await unitOf(projectId, norm, ex), templateKey: seg.templateKey, template, input: norm }
  }
  const payload = decision.mode === 'template' ? decision.templateRun : decision.synth
  if (!payload) throw new ContinuityError('continuity_unsupported', 400)
  const template = loadTargetTemplate(payload.templateKey)
  const norm = prepareRouteInput(template, { ...materializeRouteInputs(payload.inputSpec), with_continuity: true })
  return { unit: await unitOf(projectId, norm, ex), templateKey: payload.templateKey, template, input: norm }
}

/** 批准包目标必须恰指当前会话决策位置（kind=route + sessionId/decisionRevision/decisionHash 全匹配），否则 409。 */
export function assertRouteApprovalTarget(doc: ContextDoc, sessionId: number, decisionRevision: number,
    decisionHash: string | null): void {
  const req = doc.target.request
  if (req.kind !== 'route' || req.sessionId !== sessionId || req.decisionRevision !== decisionRevision
    || req.decisionHash !== decisionHash) {
    throw new ContinuityError('continuity_context_changed', 409)
  }
}
