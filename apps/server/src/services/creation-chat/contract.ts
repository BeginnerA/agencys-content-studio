import { createHash } from 'node:crypto'
import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/)
const text = (max: number) => z.string().trim().min(1).max(max)

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
  lines: z.array(z.object({ id, text: text(300) }).strict()).min(1).max(36),
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

export const planningReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clarify'), message: text(1200), questions: z.array(text(300)).min(1).max(2) }).strict(),
  z.object({ kind: z.literal('plan'), message: text(1200), plan: creationPlanSchema }).strict(),
])
export type PlanningReply = z.infer<typeof planningReplySchema>
export const requestKeySchema = z.string().min(8).max(120).regex(/^[a-zA-Z0-9_-]+$/)
export const confirmationSchema = z.object({
  planRevision: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: requestKeySchema,
  acceptUnpriced: z.boolean().default(false),
}).strict()
export type Confirmation = z.infer<typeof confirmationSchema>

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
