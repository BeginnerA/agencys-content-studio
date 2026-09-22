import { createHash } from 'node:crypto'
import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/)
const text = (max: number) => z.string().trim().min(1).max(max)

// [M43] 视频分辨率档位（与 @agencys/ai-provider-kit CapsResolution 六档同源，预检 videoCapabilitiesSchema 同引用）。
// 确认级可选但不入 planHash 的成立前提：价格注册表无 resolution 维度（视频按秒单价，档位不改变预估）；
// 若未来注册表加分档定价，此字段必须改随方案入 hash（改档位即改价格，旧确认必须作废）。
export const CREATION_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p', '480P', '768P', '2K'] as const
export type CreationVideoResolution = (typeof CREATION_VIDEO_RESOLUTIONS)[number]

// [M31] 对话式参考输入：受方案约束的参考素材（上传后编译进 refs → 进 planHash，确认即执行）。
// role 语义：style 风格参考 / first_frame 首帧 / subject 主体一致性 / content 视频内容解析 / bgm 背景乐。
export const refRoleSchema = z.enum(['style', 'first_frame', 'subject', 'content', 'bgm'])
export type CreationRefRole = z.infer<typeof refRoleSchema>
export const refSchema = z.object({
  assetId: z.number().int().positive(),
  kind: z.enum(['image', 'video', 'audio']),
  role: refRoleSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  shotId: id.optional(),
}).strict()
export type CreationRef = z.infer<typeof refSchema>

export const creationPlanSchema = z.object({
  title: text(100),
  summary: text(1200),
  genre: z.enum(['science', 'story', 'product']),
  duration: z.number().int().min(30).max(60).default(30),
  aspectRatio: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
  language: z.literal('zh-CN').default('zh-CN'),
  mode: z.enum(['dynamic', 'slideshow']).default('dynamic'),
  style: text(300),
  script: text(6000),
  // emotion_hint 可选：`基调词——六维细节`，供 audio 实例声明 emotion_param 时透传（缺省 → 不带情绪，旧方案不受影响）
  lines: z.array(z.object({ id, text: text(300), emotion_hint: z.string().trim().min(1).max(200).optional() }).strict()).min(1).max(36),
  shots: z.array(z.object({
    id,
    duration: z.number().min(1).max(15),
    image_prompt: text(1600),
    motion_prompt: text(1200),
    lines: z.array(id).max(12),
  }).strict()).min(2).max(12),
  // [M31] 已采纳参考素材（服务端在规划时编译写入；LLM 不产出，缺省空数组向后兼容）
  refs: z.array(refSchema).max(12).default([]),
}).strict().superRefine((plan, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
  if (new Set(plan.shots.map((s) => s.id)).size !== plan.shots.length) issue('镜头 ID 必须唯一')
  if (new Set(plan.lines.map((l) => l.id)).size !== plan.lines.length) issue('台词 ID 必须唯一')
  const mapped = plan.shots.flatMap((s) => s.lines)
  const ids = new Set(plan.lines.map((l) => l.id))
  if (mapped.length !== ids.size || new Set(mapped).size !== mapped.length || mapped.some((l) => !ids.has(l))) {
    issue('每句台词必须且只能关联一个镜头，不允许遗漏或幽灵台词')
  }
  if (mapped.join('|') !== plan.lines.map((l) => l.id).join('|')) issue('台词顺序必须与镜头播放顺序一致')
  if (Math.abs(plan.shots.reduce((n, s) => n + s.duration, 0) - plan.duration) > 0.01) issue('镜头时长总和必须等于成片时长')
})
export type CreationPlan = z.infer<typeof creationPlanSchema>

// ===== [M40] 立项信息（名称 / 载体 / 模板 / 标签 / 简介）=====
// 项目行在「发送一句话」时即以 draft 影子态存在（规划记账与参考素材需归属），
// 但项目列表 / 统计 / 搜索一律不可见；点「开始制作」确认时才智能填写并转正。
// 载体字典与 web/src/lib/scene PROJECT_GENRES 同源（新增取值两端同改）。
export const PROJECT_GENRE_VALUES = ['drama_short', 'note', 'article', 'talking_head', 'other'] as const
export type ProjectGenre = (typeof PROJECT_GENRE_VALUES)[number]
export const PROJECT_NAME_MAX = 60
export const PROJECT_BRIEF_MAX = 500
export const PROJECT_TAG_MAX = 20
export const PROJECT_TAG_COUNT_MAX = 6

/** 立项信息严格形（入库前必过此 schema） */
export const projectMetaSchema = z.object({
  name: text(PROJECT_NAME_MAX),
  genre: z.enum(PROJECT_GENRE_VALUES),
  templateKey: z.string().trim().min(1).max(60),
  tags: z.array(z.string().trim().min(1).max(PROJECT_TAG_MAX)).min(1).max(PROJECT_TAG_COUNT_MAX),
  brief: z.string().trim().min(1).max(PROJECT_BRIEF_MAX),
}).strict()
export type ProjectMeta = z.infer<typeof projectMetaSchema>

/** LLM / 前端提交的立项信息为「建议值」：缺项与越界不致命（catchall 忽略多余键，
 *  避免一个标签超长就把已花钱的整份方案判为 invalid_plan），由 sanitizeProjectMeta 归一。 */
export const projectMetaInputSchema = z
  .object({ name: z.unknown().optional(), genre: z.unknown().optional(), templateKey: z.unknown().optional(), tags: z.unknown().optional(), brief: z.unknown().optional() })
  .catchall(z.unknown())
export type ProjectMetaInput = z.infer<typeof projectMetaInputSchema>

export const planningReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clarify'), message: text(1200), questions: z.array(text(300)).min(1).max(2) }).strict(),
  // [M40] project 与 plan 同级（LLM 建议值；不入 planHash → 改立项信息不会作废已确认的方案）
  z.object({ kind: z.literal('plan'), message: text(1200), plan: creationPlanSchema, project: projectMetaInputSchema.optional() }).strict(),
])
export type PlanningReply = z.infer<typeof planningReplySchema>
export const requestKeySchema = z.string().min(8).max(120).regex(/^[a-zA-Z0-9_-]+$/)
export const messageSchema = z.object({
  content: z.string().trim().min(1).max(6000),
  requestKey: requestKeySchema,
  attachments: z.array(z.number().int().positive()).max(12).optional(),
}).strict()
export const createSessionSchema = messageSchema.extend({ deferPlanning: z.boolean().optional() }).strict()
export const initialDraftSchema = z.object({
  kind: z.literal('initial_draft'),
  content: z.string().min(1).max(6000),
  requestKey: requestKeySchema,
  deferPlanning: z.boolean(),
  fingerprint: z.string(),
}).strict()
export function messageFingerprint(input: z.infer<typeof messageSchema>): string {
  return hashJson({ content: input.content.trim(), attachments: [...new Set(input.attachments ?? [])] })
}

export const confirmationSchema = z.object({
  planRevision: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: requestKeySchema,
  acceptUnpriced: z.boolean().default(false),
  // [M40] 确认即立项：前端「将创建的项目」可覆盖值（缺项沿用草稿行现值）
  project: projectMetaInputSchema.optional(),
  // [M42] 审阅闸：true 时本次 run 用 easy-video-review 变体模板（画面/首帧完成后挂起等审阅）；
  // 不入 planHash（与立项覆盖同理：是启动方式而非执行数据），恢复/重试沿用 run 自身模板键。
  reviewGate: z.boolean().default(false),
  // [M43] 画质选择：仅 ∈ 预检透出的已背书档位（resolutionOptions.choices）可确认；缺省 = 模型默认档，
  // 请求体与旧版逐字一致。与 reviewGate 的先例差异：画质是执行数据，但不作废方案的唯一理由是预估不随档变（见文件头注）。
  resolution: z.enum(CREATION_VIDEO_RESOLUTIONS).optional(),
}).strict()
export type Confirmation = z.infer<typeof confirmationSchema>

// [M42] 闸门决策（会话侧代理）：仅 approve/reject——skip 需模板声明 skip_label，审阅变体不提供免审。
export const gateDecisionSchema = z.object({
  stepKey: text(40),
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: requestKeySchema,
}).strict()
export type GateDecision = z.infer<typeof gateDecisionSchema>

// [M42] 候选版本可视化只放开这三个生成步（配音/字幕/合成无多版本选片语义）。
export const CREATION_CANDIDATE_STEPS = ['images', 'frames', 'motion'] as const
export const candidateStepSchema = z.enum(CREATION_CANDIDATE_STEPS)

/**
 * [M42] 选片提交：前端只报「这一镜我要哪一个」，服务端把未提及镜头按当前在用补全为全量
 * （底层 applyShotSelection 是子集替换语义，漏提即剔除——不能交给前端裸拼）。
 */
export const shotSelectionSchema = z.object({
  stepKey: candidateStepSchema,
  picks: z.array(z.object({ shot_id: id, asset_id: z.number().int().positive() }).strict()).min(1).max(12),
  idempotencyKey: requestKeySchema,
}).strict()
export type ShotSelection = z.infer<typeof shotSelectionSchema>

/** [M42] 本地重新合成：仅重置 ffmpeg_merge 步，不调用任何付费模型 */
export const recomposeSchema = z.object({ idempotencyKey: requestKeySchema }).strict()

/**
 * [M43] 参考登记变更（用途 + 逐镜绑定共用一个写入口）：role 缺省不改；
 * shotId：null = 回到整片级，缺省不改，字符串 = 绑到该镜（仅 image 类可带）。
 * 至少给一个变更键，否则拒绝（空 PATCH 不刷哈希、不抬 revision）。
 */
export const refBindSchema = z.object({
  role: refRoleSchema.optional(),
  shotId: id.nullable().optional(),
}).strict().refine((v) => v.role !== undefined || v.shotId !== undefined, { message: 'role 与 shotId 至少提供一项' })
export type RefBind = z.infer<typeof refBindSchema>

/**
 * [M42] 局部返修——第一步：自然语言指令解析（只花文本模型小额费用，零媒体计费）。
 * 与消息输入框完全独立：默认发信「记录下一版建议」的语义不得被劫持成返修费用。
 */
export const reworkRequestSchema = z.object({
  instruction: z.string().trim().min(2).max(2000),
  requestKey: requestKeySchema,
}).strict()
export type ReworkRequest = z.infer<typeof reworkRequestSchema>

/** 返修单项（= 解析预览的 targets，前端确认时原样回传；服务端仍按当前方案重算） */
export const reworkOpSchema = z.object({
  shot_id: id,
  image_prompt: text(1600).optional(),
  motion_prompt: text(1200).optional(),
}).strict().refine((op) => op.image_prompt !== undefined || op.motion_prompt !== undefined, { message: '每个返修镜头至少需给出一个提示词改动' })
export type ReworkOp = z.infer<typeof reworkOpSchema>

/** 返修——第二步：确认执行（带 planRevision/planHash 复核与显式费用接受） */
export const reworkApplySchema = z.object({
  planRevision: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: requestKeySchema,
  acceptUnpriced: z.boolean().default(false),
  ops: z.array(reworkOpSchema).min(1).max(12),
}).strict()
export type ReworkApply = z.infer<typeof reworkApplySchema>

/**
 * [M42] LLM 返修解析回复 = 建议值（与 projectMetaInputSchema 同先例：多余键忽略、
 * 单字段坏不致整次已花钱解析作废），逐字段在 rework.ts 归一后再进客户端契约。
 */
export const reworkReplySchema = z.object({ targets: z.unknown().optional(), unclear: z.unknown().optional() }).catchall(z.unknown())
export type ReworkReplyInput = z.infer<typeof reworkReplySchema>

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function parsePlanningReply(content: string, finishReason?: string | null): PlanningReply {
  if (finishReason === 'length') throw new CreationError('invalid_plan', '方案输出被截断，请缩短要求后重新发送', 422)
  if (content.length > 65000) throw new CreationError('invalid_plan', '方案超过长度上限', 422)
  try {
    return planningReplySchema.parse(JSON.parse(content))
  } catch {
    throw new CreationError('invalid_plan', '方案不符合结构契约，请修改要求后重新发送；尚未启动媒体生成', 422)
  }
}

export class CreationError extends Error {
  constructor(public code: string, message: string, public status: 400 | 403 | 404 | 409 | 422 | 503 = 400) {
    super(message)
    this.name = 'CreationError'
  }
}
