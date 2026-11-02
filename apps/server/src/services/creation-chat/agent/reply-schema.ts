/**
 * Agent 三形回复契约。单独成文件是为打断 contract.ts ↔ decision-schema.ts 的循环依赖
 * （decision-schema 需要 contract 的 creationPlanSchema，若 contract 反向引用 decision-schema，
 *  ESM 顶层 zod schema 求值会命中 TDZ）。故三形联合放在这一层：它同时依赖两者，处于依赖图末端。
 * - 老契约 planningReplySchema 逐字不动（存量探针依赖）。
 * - clarify/plan 形与老契约同 schema 结构（复用子 schema 实例引用，防两处漂移）；
 *   plan 形新增可选 roleKey/team（不进 planHash=hashJson({plan,execution})）。
 * - route 形承载 template/chain/synth 执行决策。
 */
import { z } from 'zod'
import { createLogger } from '../../../logger'
import { CreationError, creationPlanSchema, projectMetaInputSchema, type PlanningReply } from '../contract'
import { agentRouteReplySchema } from './decision-schema'

const log = createLogger('creation-agent')

const text = (max: number) => z.string().trim().min(1).max(max)

// clarify 与老契约完全一致（直接复用 planningReplySchema 首个分支结构，避免语义漂移）
export const agentClarifyReplySchema = z.object({ kind: z.literal('clarify'), message: text(1200), questions: z.array(text(300)).min(1).max(2) }).strict()

export const agentPlanReplySchema = z.object({
  kind: z.literal('plan'),
  message: text(1200),
  plan: creationPlanSchema,
  project: projectMetaInputSchema.optional(),
  roleKey: z.string().trim().min(1).max(40).optional(),
  team: z.array(z.object({ roleKey: z.string().trim().min(1).max(40), stage: z.string().trim().min(1).max(100) }).strict()).max(6).optional(),
}).strict()

export const agentReplySchema = z.discriminatedUnion('kind', [agentClarifyReplySchema, agentPlanReplySchema, agentRouteReplySchema])
export type AgentReply = z.infer<typeof agentReplySchema>
/** clarify/plan 两形即老 PlanningReply 的超集（route 为新增第三形） */
export type AgentPlanReply = z.infer<typeof agentPlanReplySchema>

/** 失败原因诊断（仅供服务端日志，绝不进用户可见文案）：ZodError 展平前 8 条 issue，JSON 语法错单列，其余回落 error.message。 */
function describeParseFailure(err: unknown): string {
  if (err instanceof z.ZodError) {
    const issues = err.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('；')
    return `schema 不匹配 [${issues}]`
  }
  if (err instanceof SyntaxError) return `JSON 解析失败（${err.message}）：输出可能非纯 JSON`
  return err instanceof Error ? err.message : String(err)
}

/**
 * Agent 会话专用解析：与 parsePlanningReply 同律（截断/超长/非法契约 → invalid_plan，不静默猜测）。
 * 结构契约失败时把真实原因（ZodError 展平 / JSON 语法错 + 有界输出前缀）落服务端日志，用户侧仍只见通用文案——
 * 「可见不静默」指对开发者可见，不把模型原始输出 / 内部细节吐给终端用户（apiKey 泄漏已在本调用前的上游拦截）。
 */
export function parseAgentReply(content: string, finishReason?: string | null): AgentReply {
  if (finishReason === 'length') throw new CreationError('invalid_plan', '规划输出被截断，请缩短要求后重新发送', 422)
  if (content.length > 65000) throw new CreationError('invalid_plan', '规划输出超过长度上限', 422)
  try {
    return agentReplySchema.parse(JSON.parse(content))
  } catch (err) {
    log.warn('agent 决策回复未过结构契约', {
      finishReason: finishReason ?? null,
      contentLen: content.length,
      reason: describeParseFailure(err),
      head: content.slice(0, 400).replace(/\s+/g, ' '),
    })
    throw new CreationError('invalid_plan', '规划结果不符合结构契约，请修改要求后重新发送；尚未启动媒体生成', 422)
  }
}

export type { PlanningReply }
