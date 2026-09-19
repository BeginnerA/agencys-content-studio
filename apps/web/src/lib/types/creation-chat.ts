// ===== [M30] 对话式「一句话成片」领域类型（与 routes/creation-chat.ts + services/creation-chat 响应对齐） =====

export interface CreationLine {
  id: string
  text: string
}

export interface CreationShot {
  id: string
  duration: number
  image_prompt: string
  motion_prompt: string
  lines: string[]
}

export type CreationGenre = 'science' | 'story' | 'product'
export type CreationAspect = '9:16' | '16:9' | '1:1'
export type CreationMode = 'dynamic' | 'slideshow'

// ===== [M31] 对话式参考输入：参考素材类型 / 用途 / 附件返回 =====
export type CreationRefKind = 'image' | 'video' | 'audio'
/** 参考用途：风格 / 首帧 / 主体一致性 / 视频内容解析 / 背景乐 */
export type CreationRefRole = 'style' | 'first_frame' | 'subject' | 'content' | 'bgm'

/** 已采纳并冻结进方案的参考素材（服务端 refSchema 投影；进 planHash → 确认即执行） */
export interface CreationRef {
  assetId: number
  kind: CreationRefKind
  role: CreationRefRole
  hash: string
  shotId?: string
}

/** POST /:id/attachments 返回体（不计费、不触发规划） */
export interface CreationAttachmentResult {
  assetId: number
  kind: CreationRefKind
  role: CreationRefRole
  hash: string
  name: string
  thumbUrl: string | null
}

/** 各用途中文标签（与服务端 refRoleSchema 对齐） */
export const REF_ROLE_LABELS: Record<CreationRefRole, string> = {
  style: '风格参考',
  first_frame: '首帧',
  subject: '主体 / 角色',
  content: '视频内容',
  bgm: '背景音乐',
}

/** 各类型可选用途（与服务端 VALID_ROLES 对齐；默认按 kind 推断） */
export const REF_VALID_ROLES: Record<CreationRefKind, CreationRefRole[]> = {
  image: ['style', 'first_frame', 'subject'],
  video: ['content'],
  audio: ['bgm'],
}

/** 各类型默认用途（与服务端 ROLE_BY_KIND 对齐） */
export const REF_DEFAULT_ROLE: Record<CreationRefKind, CreationRefRole> = {
  image: 'style',
  video: 'content',
  audio: 'bgm',
}

/** 前端预校验上限（与服务端 attachments.ts 常量一致；服务端仍权威拒绝） */
export const REF_MAX_PER_KIND: Record<CreationRefKind, number> = {
  image: 20 * 1024 * 1024,
  video: 512 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
}
export const REF_MAX_COUNT = 12

/** 按扩展名推断参考类型（与服务端 kindByExt 媒体子集对齐）；非媒体返回 null */
export function refKindByExt(name: string): CreationRefKind | null {
  const e = '.' + (name.split('.').pop() ?? '').toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(e)) return 'image'
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(e)) return 'video'
  if (['.mp3', '.wav', '.aac', '.m4a', '.flac'].includes(e)) return 'audio'
  return null
}

/** 已确认的结构化方案（服务端 creationPlanSchema 输出投影） */
export interface CreationPlan {
  title: string
  summary: string
  genre: CreationGenre
  duration: number
  aspectRatio: CreationAspect
  language: 'zh-CN'
  mode: CreationMode
  style: string
  script: string
  lines: CreationLine[]
  shots: CreationShot[]
  /** [M31] 已采纳参考素材（缺省空数组，旧方案向后兼容） */
  refs: CreationRef[]
}

/** 冻结的不含密钥供应商实例快照 */
export interface CreationEndpointSnapshot {
  configId: number
  configHash: string
  provider: string
  model: string
  unitPrice: number | null
}

/** 预检产出的可执行配方（不含 sessionId/sources） */
export interface CreationPreparedRecipe {
  plan: CreationPlan
  endpoints: {
    audio: CreationEndpointSnapshot
    image?: CreationEndpointSnapshot
    video?: CreationEndpointSnapshot
  }
  videoMode: 'i2v' | 't2v' | 'none'
  requestDurations: Record<string, number>
  voice: string
  imageSize: string
  resolution: string
  templateHash: string
  /** [M31] 执行快照携带参考素材（随 hashJson({plan,execution}) 进 planHash） */
  refs: CreationRef[]
}

export interface CreationPreflight {
  ready: boolean
  issues: Array<{ code: string; message: string }>
  execution: CreationPreparedRecipe | null
  estimate: {
    knownCost: number
    unpriced: string[]
    imageCount: number
    videoSeconds: number
    voiceChars: number
    /** [M31] 已采纳参考数量与需解析视频数 */
    refCount: number
    videoAnalysisCount: number
  }
  planningModel: { provider: string; model: string } | null
}

export type CreationSessionStatus = 'draft' | 'planning' | 'ready' | 'starting' | 'started'

/** 会话状态 → 中文标签（列表与详情共用，避免两处映射漂移） */
export const CREATION_STATUS_LABELS: Record<CreationSessionStatus, string> = {
  draft: '草稿', planning: '规划中', ready: '待确认', starting: '启动中', started: '制作中',
}
/** [M31+] 「待确认」仅当预检通过才成立；有方案但预检未过（confirmable=false）→ 明确为「待完善配置」 */
export function creationStatusLabel(status: CreationSessionStatus, confirmable = true): string {
  if (status === 'ready' && !confirmable) return '待完善配置'
  return CREATION_STATUS_LABELS[status]
}

export interface CreationChatMessagePayload {
  kind: string
  questions?: string[]
  revision?: number
  runId?: number
  verifiedFailedTaskIds?: number[]
  /** [M31] 附件消息：assetId + 冻结的 ref 指纹 */
  assetId?: number
  ref?: CreationRef
}

export interface CreationChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  payload: CreationChatMessagePayload | null
  createdAt: number
}

export interface CreationSessionView {
  id: number
  projectId: number
  status: CreationSessionStatus
  plan: CreationPlan | null
  planRevision: number
  planHash: string | null
  preflight: CreationPreflight | null
  runId: number | null
  runHistory: unknown[]
  error: string | null
  createdAt: number
  updatedAt: number
  projectDeleted: boolean
}

export interface CreationProgressStep {
  key: string
  title: string
  status: string
  error: string | null
}

export interface CreationUncertainTask {
  id: number
  kind: string
  provider: string
  hasExternalId: boolean
}

/** 制作状态从真实 run/step/task 投影（不另建生产状态机） */
export interface CreationProgress {
  runId: number
  status: string
  currentStep: string | null
  error: string | null
  needsVerification: boolean
  uncertainTasks: CreationUncertainTask[]
  completedShots: number
  steps: CreationProgressStep[]
}

export interface CreationResult {
  videoId: number
  coverId: number | null
  duration: number | null
}

/** 会话详情：create/send/preflight/cancel 统一返回体 */
export interface CreationDetail {
  session: CreationSessionView
  messages: CreationChatMessage[]
  planningUsage: { cost: number; unpriced: number }
  progress: CreationProgress | null
  result: CreationResult | null
}

export interface CreationSessionListItem {
  id: number
  projectId: number
  name: string
  status: CreationSessionStatus
  runId: number | null
  updatedAt: number
  /** [M31+] status=ready 且预检通过（真的可点确认）才为 true；否则列表显示「待完善配置」 */
  confirmable: boolean
}

/** 确认请求：planHash 为 64 位十六进制（仅在 ready 且哈希存在时发起） */
export interface CreationConfirmBody {
  planRevision: number
  planHash: string
  idempotencyKey: string
  acceptUnpriced: boolean
}

export interface CreationRetryBody extends CreationConfirmBody {
  runId: number
  verifiedFailedTaskIds?: number[]
}

