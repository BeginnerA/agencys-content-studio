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
export type CreationRefRole =
  'style' | 'first_frame' | 'subject' | 'content' | 'bgm'

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
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(e))
    return 'image'
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
  /** [M43] 画质候选（仅 dynamic 且视频档位可背书时非 null）；pf 顶层字段，不入 planHash */
  resolutionOptions: { choices: string[]; default: string } | null
}

export type CreationSessionStatus =
  'draft' | 'planning' | 'ready' | 'starting' | 'started'

// ===== [M40] 立项信息：确认方案后才转正建项目，此前以 draft 影子态隐藏于项目列表 =====
/** 将创建项目的 5 项信息（与服务端 project-meta 真源对齐；用户可逐项覆盖） */
export interface CreationProjectMeta {
  name: string
  genre: string
  templateKey: string
  tags: string[]
  brief: string
}
/** 会话详情透出的立项预览（服务端 creationDetail.session.project） */
export type CreationProjectPreview = CreationProjectMeta & {
  id: number
  status: string
  isDraft: boolean
}

/** 会话状态 → 中文标签（列表与详情共用，避免两处映射漂移） */
export const CREATION_STATUS_LABELS: Record<CreationSessionStatus, string> = {
  draft: '草稿',
  planning: '规划中',
  ready: '待确认',
  starting: '启动中',
  started: '制作中',
}
/** [M31+] 「待确认」仅当预检通过才成立；有方案但预检未过（confirmable=false）→ 明确为「待完善配置」 */
export function creationStatusLabel(
  status: CreationSessionStatus,
  confirmable = true,
  runStatus?: string | null,
): string {
  if (status === 'ready' && !confirmable) return '待完善配置'
  // [修复] 会话 status 是控制态（started 后不回写）：制作启动后按 run 真实状态派生，避免已完成仍显「制作中」
  if ((status === 'started' || status === 'starting') && runStatus) {
    if (runStatus === 'completed') return '已完成'
    if (runStatus === 'failed') return '制作失败'
    if (runStatus === 'cancelled') return '已取消'
    // [M42] 闸门挂起：对普通用户说「等待审阅」（专业工作台沿用 format.ts 的「待审阅」）
    if (runStatus === 'waiting_input') return '等待审阅'
    return '制作中'
  }
  return CREATION_STATUS_LABELS[status]
}
/** 列表/详情共用：状态 → 徽标与强调条色调（全局 .badge 语义色同名类） */
export function creationStatusTone(
  status: CreationSessionStatus,
  runStatus?: string | null,
): string {
  if (status === 'started' || status === 'starting') {
    if (runStatus === 'completed') return 'completed'
    if (runStatus === 'failed') return 'failed'
    if (runStatus === 'cancelled') return 'cancelled'
    // [M42] 等待审阅复用全局 .badge.waiting_input（与专业工作台同色语义，非仅色编码：另有文字标签）
    if (runStatus === 'waiting_input') return 'waiting_input'
    return 'running'
  }
  return status === 'planning'
    ? 'running'
    : status === 'ready'
      ? 'pending'
      : 'cancelled'
}

export interface CreationChatMessagePayload {
  kind: string
  questions?: string[]
  revision?: number
  runId?: number
  verifiedFailedTaskIds?: number[]
  fingerprint?: string
  attachments?: number[]
  /** [M31] 附件消息：assetId + 冻结的 ref 指纹 */
  assetId?: number
  ref?: CreationRef
  /** [M42] 审阅决策消息（kind='gate'）：步骤、决策与驳回意见 */
  stepKey?: string
  decision?: CreationGateDecision
  note?: string | null
}

/** system 角色（[M42] 审阅决策留痕）：进对话流展示，但不进后续规划的 LLM 上下文 */
export type CreationChatRole = 'user' | 'assistant' | 'system'

export const CREATION_ROLE_LABELS: Record<CreationChatRole, string> = {
  user: '我',
  assistant: '策划助手',
  system: '审阅记录',
}

/** [M42] system 留痕按类型给来源标签（审阅 / 返修 / 合成），不与策划助手的话混同 */
export function creationSystemLabel(kind?: string | null): string {
  if (kind === 'rework' || kind === 'rework_plan') return '返修记录'
  if (kind === 'recompose') return '合成记录'
  return '审阅记录'
}

export interface CreationChatMessage {
  id: number
  role: CreationChatRole
  content: string
  payload: CreationChatMessagePayload | null
  requestKey: string | null
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
  initialDraft: { content: string; requestKey: string } | null
  /** [M40] 立项预览：未确认时为 draft 影子项目（不进项目列表），确认后转正 */
  project: CreationProjectPreview | null
}

/** [M42] 中途审阅：run 挂在闸门上的那一步（服务端从模板快照 gate.message 透出，非引擎状态） */
export interface CreationReview {
  stepKey: string
  title: string
  message: string
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
  provider: string | null
  hasExternalId: boolean
  label: string
}

/** 制作状态从真实 run/step/task 投影（不另建生产状态机） */
export interface CreationProgress {
  runId: number
  status: string
  currentStep: string | null
  error: string | null
  /** [M42] 等待审阅时为待审步骤，否则 null（前端据此置顶审阅面板） */
  review: CreationReview | null
  needsVerification: boolean
  uncertainTasks: CreationUncertainTask[]
  completedShots: number
  steps: CreationProgressStep[]
  stages: Array<{ key: string; title: string; applicable: boolean | null; status: string; completed: number | null; total: number | null }>
  recovery: { resumable: boolean; requiredTaskIds: number[]; queryTaskCount: number; unpriced: string[] }
  issue: { summary: string; details: Array<{ message: string; scopes: string[] }> } | null
}

export interface CreationArtifact {
  assetId: number
  kind: string
  name: string
  available: boolean
  sourceRunId: number | null
  reused: boolean
}

/**
 * [M42] 某镜某模态的多版本视图（服务端投影）：selected = 正在用的那一个（可能为 null = 尚未生成），
 * candidates = 全部候选（含文件已丢 / 已删除的不可选占位），序为在用优先 → 最新在前。
 */
export interface CreationArtifactChoice {
  selected: CreationArtifact | null
  candidates: CreationArtifact[]
}
export interface CreationArtifacts {
  shots: Array<{ shotId: string; index: number; duration: number; text: string; image: CreationArtifactChoice; video: CreationArtifactChoice; voices: CreationArtifact[] }>
  documents: Array<CreationArtifact & { label: string }>
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
  artifacts: CreationArtifacts
  result: CreationResult | null
}

/** [M40+] 删除会话结果：未立项时连影子项目一并回收；已立项只删记录（项目保留，reason 说明原因） */
export interface CreationDeleteResult {
  ok: true
  mode: 'draft_purged' | 'session_only'
  projectId: number | null
  reason: string
  purged: Record<string, number>
}

export interface CreationSessionListItem {
  id: number
  projectId: number
  name: string
  status: CreationSessionStatus
  runId: number | null
  updatedAt: number
  /** [修复] 关联制作任务的真实状态（queued|running|completed|failed|cancelled…）；控制态 started 不回写，列表据此派生显示 */
  runStatus: string | null
  /** [M31+] status=ready 且预检通过（真的可点确认）才为 true；否则列表显示「待完善配置」 */
  confirmable: boolean
}

/** 确认请求：planHash 为 64 位十六进制（仅在 ready 且哈希存在时发起） */
export interface CreationConfirmBody {
  planRevision: number
  planHash: string
  idempotencyKey: string
  acceptUnpriced: boolean
  /** [M40] 立项覆盖值：只带用户改过的字段，缺项沿用平台智能填写（不入 planHash） */
  project?: Partial<CreationProjectMeta>
  /** [M42] 勾选「首帧后暂停审阅」：本次改用带闸门的同构变体模板（同样不入 planHash） */
  reviewGate?: boolean
  /** [M43] 画质选择：仅在 ∈ preflight.resolutionOptions.choices 时可确认；不选不传键（缺省 = 模型默认档，请求体与旧版逐字一致） */
  resolution?: string
}

/** [M43] 参考绑定变更（PATCH /:id/attachments/:assetId/ref）：role 缺省不改；shotId null = 回整片级、缺省不改；至少一项 */
export interface CreationRefBindBody {
  role?: CreationRefRole
  shotId?: string | null
}

/** [M42] 审阅决策：approve=继续制作；reject=该阶段整体重做（会再次调用生成，可能计费） */
export type CreationGateDecision = 'approve' | 'reject'

export interface CreationGateBody {
  stepKey: string
  decision: CreationGateDecision
  note?: string
  idempotencyKey: string
}

/** [M42] 候选版本步（与服务端 CREATION_CANDIDATE_STEPS 同源） */
export type CreationCandidateStep = 'images' | 'frames' | 'motion'

export interface CreationSelectionBody {
  stepKey: CreationCandidateStep
  picks: Array<{ shot_id: string; asset_id: number }>
  idempotencyKey: string
}

/** [M42] 候选看板不另建形：服务端直返专业工作台同一份聚合，契约复用 ShotBoardData（见 ./shot.ts） */

export interface CreationRetryBody extends CreationConfirmBody {
  runId: number
  verifiedFailedTaskIds?: number[]
}

// ===== [M42] 自然语言局部返修（第一步解析预览 → 第二步显式确认执行） =====

/**
 * 单个返修镜头（服务端 rework.ts ReworkTarget 逐字段对齐）：本模式可落地的一侧给新提示词与费用，
 * 另一侧为 null（表示该侧不改动，不是「改成空」）。费用 null = 该生成项单价未知（同步进 estimate.unpriced）。
 */
export interface CreationReworkTarget {
  shotId: string
  index: number
  imageFrom: string | null
  imagePrompt: string | null
  motionFrom: string | null
  motionPrompt: string | null
  imageCost: number | null
  motionCost: number | null
}

/** 解析预览：unclear 非空表示本入口做不到（不猜、不给可确认的计费出口） */
export interface CreationReworkPreview {
  instruction: string
  unclear: string | null
  targets: CreationReworkTarget[]
  /** 解析期提示（越界字段被忽略等）：不静默丢弃用户的任何诉求 */
  notes: string[]
  estimate: { knownCost: number; unpriced: string[] }
  planRevision: number
  planHash: string
}

/** 确认载荷单项 = 解析预览的 targets 原样回传（金额与版本由服务端按当前方案重算） */
export interface CreationReworkOp {
  shot_id: string
  image_prompt?: string
  motion_prompt?: string
}

export interface CreationReworkApplyBody {
  planRevision: number
  planHash: string
  idempotencyKey: string
  acceptUnpriced: boolean
  ops: CreationReworkOp[]
}

/** POST /:id/rework/plan 返回体：会话快照 + 本次解析预览 */
export type CreationReworkPlanResult = CreationDetail & {
  reworkPreview?: CreationReworkPreview
}
