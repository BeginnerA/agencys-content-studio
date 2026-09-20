export interface ProviderConfigLite {
  id: number
  name: string
  serviceType: string
  model: string
  credentialId?: number | null
  isDefault: boolean
  isActive: boolean
  /** 编辑回显：自定义端点（GET /api-configs 提供；未设置为 null/undefined） */
  baseUrl?: string | null
  /** 编辑回显：Key 脱敏尾 4 位（未配置密钥为 null/undefined） */
  apiKeyMasked?: string | null
  /** 编辑回显：实例扩展参数（供适配器透传，如火山 TTS 的 appid；后端默认 {}） */
  extra?: Record<string, unknown> | null
  /** 实例级定价 JSON */
  pricing?: Record<string, number> | null
}

/**
 * [M31+] 视频实例「轻松创作能力声明」（存于 extra.creationCapabilities）。
 * 与服务端 preflight 的 videoCapabilitiesSchema 严格对齐：verified 恒为 true（勾选即声明已核实），
 * 字段缺一不可，且 model 必须与实例所选模型一字不差，否则预检拒绝执行（不猜测、不静默降级）。
 */
export interface VideoCreationCapabilities {
  model: string
  verified: true
  modes: Array<'i2v' | 't2v'>
  durations: number[]
  aspectRatios: Array<'9:16' | '16:9' | '1:1'>
  resolution: '480p' | '720p' | '1080p' | '768P' | '2K'
}

/**
 * [M32] 视频模型能力单一真源表只读查询结果（GET /api-configs/video-caps）。
 * supported=true 时 caps 为平台背书档位（Tier A）——前端据此自动预填、免用户手填核实；
 * supported=false（如 siliconflow / 未知供应商）时前端回退到手填声明表单。
 */
export interface VideoModelCaps {
  modes: Array<'i2v' | 't2v'>
  durations: number[]
  aspectRatios: Array<'9:16' | '16:9' | '1:1'>
  resolutions: Array<'480p' | '720p' | '1080p' | '768P' | '2K'>
  defaultDuration: number
  defaultResolution: '480p' | '720p' | '1080p' | '768P' | '2K'
}

export interface VideoCapsResult {
  supported: boolean
  providerKey: string
  model: string
  caps?: VideoModelCaps
}

/**
 * [M33] 模型参考定价（Tier A，服务端定价真源表解析结果）。
 * prices 按计价单位索引（元/百万 token、元/张、元/秒、元/千字符），与实例 apiConfigs.pricing 同口径；
 * source 为供应商公开定价页锚点 + 口径说明，供前端「为何是这个值」提示。
 */
export interface ModelPricing {
  prices: Partial<Record<'tokens_in' | 'tokens_out' | 'image' | 'second' | 'char', number>>
  source: string
}

/**
 * [M33] GET /api-configs/model-suggest 响应：跨通道「选中即生成」Tier A 建议。
 * supported=是否有任一可自动带出的信息（参考定价 / 视频能力 / 默认通道建议）；
 * pricing 命中即预填（全通道），caps 仅视频命中（复用 M32），suggestDefault=该类型当前无实例。
 */
export interface ModelSuggestResult {
  supported: boolean
  serviceType: string
  providerKey: string
  model: string
  pricing?: ModelPricing
  caps?: VideoModelCaps
  suggestDefault?: boolean
}

export interface ApiProvider {
  key: string
  name: string
  serviceType: 'llm' | 'image' | 'video' | 'audio'
  vendor: string | null
  description: string
  defaultUrl: string | null
  presetModels: string[]
  isActive: boolean
  /** 是否支持「测试连接」：llm/image/audio 恒 true；video 仅具备连通探针的供应商为 true（其余需真实 run 验证） */
  testable: boolean
  configs: ProviderConfigLite[]
}

export interface ApiConfig {
  id: number
  providerKey: string
  serviceType: string
  credentialId: number | null
  credentialVendor: string | null
  credentialName: string | null
  name: string
  baseUrl: string | null
  apiKeyRef: string | null
  apiKeyMasked: string | null
  model: string | null
  extra: Record<string, unknown>
  pricing: Record<string, number>
  priority: number
  isDefault: boolean
  isActive: boolean
  createdAt: number
  updatedAt: number
}

/** 供应商凭证（厂商级，API Key 只配一次） */
export interface VendorCredential {
  id: number
  vendor: string
  name: string
  baseUrl: string | null
  apiKeyMasked: string
  hasKey: boolean
  extra: Record<string, unknown>
  isActive: boolean
  configCount: number
  createdAt: number
  updatedAt: number
}

/** POST /api-configs/fetch-models 响应：在线目录 / 预置回退 */
export interface FetchModelsResult {
  models: string[]
  source: 'live' | 'preset'
  note?: string
}

// ===== [M19 P8] 音色库（声音克隆） =====

/** [M19] 克隆音色行（voice_clones；meta 为供应商留痕 JSON 字符串） */
export interface VoiceCloneItem {
  id: number
  /** 音色名（唯一；引用令牌 clone:{id} 按 id 定位） */
  name: string
  providerKey: string
  /** 克隆目标模型（合成必须同模型，服务端 cloneEndpoint 自动覆盖） */
  model: string
  /** 供应商返回的音色标识 */
  voiceId: string
  status: string
  meta: string
  createdAt: number
  updatedAt: number
}

/** [M19] 克隆能力位（audio 供应商目录全量；available=false → UI 置灰） */
export interface VoiceCloneProvider {
  key: string
  name: string
  available: boolean
}

// ===== [M34] 运行入参预填（G6 历史 run/brief + G8 视频合法档位） =====

/** 自动值来源（可追溯：前端据此标注「为何是这个值」） */
export type PrefillSource = 'template_default' | 'last_run' | 'brief'

/** 单个输入候选值 + 来源 */
export interface PrefillInputValue {
  value: string | number | boolean
  source: PrefillSource
}

/** G8 视频覆盖候选（域对齐：可选项 = caps ∩ 输入白名单，防 400） */
export interface VideoOverride {
  providerKey: string
  model: string
  durations: number[]
  defaultDuration: number
  /** caps 输出档位（仅展示提示） */
  resolutions: string[]
  /** 覆盖下拉实际可选项（交集空则回落全量） */
  selectableResolutions: string[]
  /** 推荐默认（仅 ∈ 可选域时非空） */
  defaultResolution: string | null
  source: 'caps_suggest'
}

/** GET /templates/:key/prefill 响应 */
export interface PrefillResult {
  projectId: number
  templateKey: string
  inputs: Record<string, PrefillInputValue>
  lastRunId: number | null
  overrides: { video: VideoOverride | null }
}
