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
  }
  planningModel: { provider: string; model: string } | null
}

export type CreationSessionStatus = 'draft' | 'planning' | 'ready' | 'starting' | 'started'

export interface CreationChatMessagePayload {
  kind: string
  questions?: string[]
  revision?: number
  runId?: number
  verifiedFailedTaskIds?: number[]
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

