/**
 * Agent 决策契约（轻松创作 Agent 化：新一级契约，与现有 plan 并存）。
 * - mode=easy：LLM 回复仍走现 kind:'plan'（creationPlanSchema 逐字不变），AgentDecision 由服务端
 *   派生仅作展示层旁注（角色署名 / sideCards）；plan 列 / planHash / 确认链原样 → 零回归。
 * - mode=template/chain/synth：LLM 回复走新形 kind:'route'，服务端归一校验后落 decision 列，
 *   decisionHash 承担确认闸（语义同 planHash：改动即作废旧确认）。
 * 物化输入约束（写进路由提示词，由服务端权威复核）：files 类只允许引用会话已编译 refs /
 * 本轮上传附件 / 上游段产物 '$prev.text:'，禁止编造 asset id。
 */
import { z } from 'zod'
import { creationPlanSchema } from '../contract'

export const agentModeSchema = z.enum(['easy', 'template', 'chain', 'synth'])
export type AgentMode = z.infer<typeof agentModeSchema>

const roleKey = z.string().trim().min(1).max(40)
const templateKey = z.string().trim().min(1).max(60)
const rationale = z.string().trim().min(1).max(2000)

/** 输入物化描述：LLM 声明每个模板输入从哪来，确认前由服务端物化核验（不编造） */
export const inputSpecItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), value: z.string().max(8000) }).strict(),
  z.object({ kind: z.literal('number'), value: z.number() }).strict(),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ kind: z.literal('asset'), assetId: z.number().int().positive(), source: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('assets'), assetIds: z.array(z.number().int().positive()).min(1).max(12), source: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('default') }).strict(),
  // 链上游段产物引用（沿用 workflow inputSpec 的 $prev.text: 语法真源）
  z.object({ kind: z.literal('prev'), ref: z.string().trim().min(1).max(200) }).strict(),
])
export type InputSpecItem = z.infer<typeof inputSpecItemSchema>

export const decisionTeamEntrySchema = z.object({
  roleKey,
  stage: z.string().trim().min(1).max(100),
}).strict()
export type DecisionTeamEntry = z.infer<typeof decisionTeamEntrySchema>

/** 目录快照：决策时所见模板版本，确认前重验（版本漂移 → 旧确认作废） */
export const catalogSnapshotSchema = z.object({ key: templateKey, version: z.number().int().positive() }).strict()

export const templateRunDecisionSchema = z.object({
  templateKey,
  catalogSnapshot: catalogSnapshotSchema,
  inputSpec: z.record(z.string(), inputSpecItemSchema).default({}),
}).strict()

export const chainSegmentDecisionSchema = z.object({
  templateKey,
  catalogSnapshot: catalogSnapshotSchema,
  title: z.string().trim().min(1).max(100),
  inputSpec: z.record(z.string(), inputSpecItemSchema).default({}),
}).strict()

// synth 高危 action 黑名单：临时模板不许碰删除/覆写用户资产类动作（创建/生成/合成类放行，
// 最终仍以 validateTemplateText 的 KNOWN_ACTIONS 白名单为硬闸，这里只是前置的额外防线）
export const SYNTH_FORBIDDEN_ACTIONS = ['asset_delete', 'template_save', 'template_delete'] as const
export const SYNTH_STEPS_MAX = 12

export const synthDecisionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  templateKey: templateKey,
  yaml: z.string().trim().min(1).max(20000),
  stepCount: z.number().int().min(1).max(SYNTH_STEPS_MAX),
  /** hashJson(yaml)：确认前落库核验 + decisionHash 参与，改动即作废旧确认 */
  yamlHash: z.string().regex(/^[a-f0-9]{64}$/),
  inputSpec: z.record(z.string(), inputSpecItemSchema).default({}),
}).strict()

/** 服务端归一后的权威决策（落 creation_sessions.decision 的形态；LLM 原始回复经 normalizeAgentDecision 产出） */
export const agentDecisionSchema = z.object({
  mode: agentModeSchema,
  /** 本条发言角色（注册表 key，归一后恒已注册） */
  roleKey,
  /** 编队：后续环节由谁规划（可空 = 单角色即可） */
  team: z.array(decisionTeamEntrySchema).max(6).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  /** 用户可见的规划说明（"我打算这样做，因为…"） */
  rationale,
  /** easy 模式内嵌完整批准方案（展示 + 确认链仍读 plan 列，这里仅旁注） */
  plan: creationPlanSchema.optional(),
  templateRun: templateRunDecisionSchema.optional(),
  chain: z.array(chainSegmentDecisionSchema).min(2).max(6).optional(),
  synth: synthDecisionSchema.optional(),
  /** 能力边界外的升级建议（沿用 routeHint 语义：目标模板/理由，非阻断提示） */
  escalateTo: z.object({ templateKey, reason: z.string().trim().min(1).max(300) }).strict().optional(),
  /** 角色 capability 越界被服务端拉回时记录原委（可见不静默） */
  capabilityNotes: z.array(z.string().max(300)).default([]),
}).strict()
export type AgentDecision = z.infer<typeof agentDecisionSchema>

/** route 形态的 LLM 原始回复（project 建议值同 easy 先例：不入 decisionHash，由服务端归一） */
export const agentRouteReplySchema = z.object({
  kind: z.literal('route'),
  roleKey: roleKey.optional(),
  team: z.array(decisionTeamEntrySchema).max(6).optional(),
  mode: agentModeSchema,
  confidence: z.number().min(0).max(1).optional(),
  message: z.string().trim().min(1).max(1200),
  rationale,
  templateRun: templateRunDecisionSchema.partial().optional(),
  chain: z.array(chainSegmentDecisionSchema.partial()).min(2).max(6).optional(),
  synth: z.object({ name: z.unknown().optional(), yaml: z.unknown().optional(), inputSpec: z.unknown().optional() }).catchall(z.unknown()).optional(),
  escalateTo: z.object({ templateKey: z.unknown(), reason: z.unknown() }).catchall(z.unknown()).optional(),
  project: z.unknown().optional(),
}).strict()
export type AgentRouteReplyInput = z.infer<typeof agentRouteReplySchema>
