/**
 * [M38] 实例扩展参数（api_configs.extra）单一真源注册表（Tier A 基建）。
 *
 * 背景：AI 配置实例表单的「扩展参数」此前是一个对所有供应商一视同仁的裸 JSON textarea，
 * 用户无从得知能填哪些 key、什么类型、合法值、是否必填、默认是什么。而服务端真正读取的
 * extra key 其实是**有限且已知**的一小撮（逐条见下方引用），绝大多数有安全默认值——本质属
 * Tier A（系统真源已知），却被错放进「用户手填 JSON」。本模块把这份「事实」收敛为唯一真源：
 *   - resolveExtraSchema：前端表单据此按供应商动态渲染结构化字段（下拉 / 开关 / 数字 / 文本 / URL 列表 / JSON）；
 *   - defaultVoice：收敛散在 tts-aliyun / tts / tts-volcengine 的音色兜底，供预检与表单默认共用。
 * 纪律（承接 M32–M37 纲领红线）：仅登记经供应商文档 / 适配器实现核实的事实，未按模型名猜测；
 * 无安全通用默认的（如 SiliconFlow「模型:音色」）返回空，交由用户显式配置，绝不注入占位音色。
 */

export type ExtraFieldType = 'text' | 'select' | 'boolean' | 'number' | 'url-list' | 'json'

export interface ExtraFieldOption {
  value: string
  label: string
}

export interface ExtraField {
  /** 存于 extra 的键名（服务端适配器读取的字段，逐条有代码真源） */
  key: string
  /** 中文标签（表单展示） */
  label: string
  type: ExtraFieldType
  /** select 候选项（供应商已核实枚举） */
  options?: ExtraFieldOption[]
  /** 表单预填默认（Tier A：系统真源已知，用户可覆盖） */
  default?: string | number | boolean | string[] | Record<string, unknown>
  /** 必填（无安全默认且适配器强依赖，如火山 appid） */
  required?: boolean
  placeholder?: string
  help?: string
}

/** 已核实音色枚举的语音供应商（枚举集有限、有安全默认） */
const AUDIO_VOICE_ENUMS: Record<string, { options: string[]; default: string }> = {
  // DashScope qwen-tts 音色枚举（tts-aliyun.ts DEFAULT_VOICE='Cherry'）
  aliyun_qwen_tts: { options: ['Cherry', 'Serena', 'Ethan', 'Chelsie'], default: 'Cherry' },
  // OpenAI /audio/speech 标准音色集（tts.ts 兜底 'alloy'）
  openai_audio: { options: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], default: 'alloy' },
  // Pollinations 网关：OpenAI 系音色 + Qwen 原生中文音色 Cherry（跨供应商格式不兼容，见实测约束）
  pollinations_audio: { options: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'Cherry'], default: 'alloy' },
}

/** 音色为「模型:音色」/大枚举、无安全通用默认的语音供应商（须用户显式配置，不猜） */
const AUDIO_VOICE_TEXT: Record<string, { placeholder: string; help: string; default?: string }> = {
  siliconflow_audio: {
    placeholder: '如 FunAudioLLM/CosyVoice2-0.5B:alex',
    help: '硅基流动音色为「模型:音色」格式，无通用默认，请显式填写（轻松创作不使用克隆声音）',
  },
  volcengine_audio: {
    placeholder: '如 BV700_streaming / zh_*_mars_bigtts',
    help: '火山音色枚举（标准版 BV700_* / 大模型 zh_*_mars_bigtts）',
    default: 'BV700_streaming', // 对齐 tts-volcengine.ts DEFAULT_VOICE
  },
}

/**
 * 语音供应商的安全默认音色（收敛适配器兜底为唯一真源）。
 * 无安全通用默认（SiliconFlow「模型:音色」/ 未知供应商）→ 返回空字符串，交由用户显式配置，
 * 预检据此判定是否仍需 missing_voice（不猜测、不注入占位音色致运行时 400）。
 */
export function defaultVoice(providerKey: string): string {
  const e = AUDIO_VOICE_ENUMS[providerKey]
  if (e) return e.default
  const t = AUDIO_VOICE_TEXT[providerKey]
  if (t?.default) return t.default
  return ''
}

/** 语音通道：音色 + 火山 appid/cluster + 情绪透传声明（emotion_param/emotion_map） */
function audioSchema(providerKey: string): ExtraField[] {
  const fields: ExtraField[] = []
  const e = AUDIO_VOICE_ENUMS[providerKey]
  const t = AUDIO_VOICE_TEXT[providerKey]
  if (e) {
    fields.push({
      key: 'voice',
      label: '音色',
      type: 'select',
      options: e.options.map((v) => ({ value: v, label: v })),
      default: e.default,
      help: '轻松创作用现成音色；如需克隆声音请到「音色库」管理（克隆音色不用于轻松创作）',
    })
  } else if (t) {
    fields.push({
      key: 'voice',
      label: '音色',
      type: 'text',
      placeholder: t.placeholder,
      help: t.help,
      default: t.default,
    })
  }
  if (providerKey === 'volcengine_audio') {
    fields.push({
      key: 'appid',
      label: '应用 ID（appid）',
      type: 'text',
      required: true,
      placeholder: '火山控制台应用 ID',
      help: '火山 TTS 无默认 appid，必填（否则合成直接报错）',
    })
    fields.push({
      key: 'cluster',
      label: '集群（cluster）',
      type: 'text',
      default: 'volcano_tts',
      help: '默认 volcano_tts，一般无需修改',
    })
  }
  fields.push({
    key: 'emotion_param',
    label: '情绪参数名（可选）',
    type: 'text',
    placeholder: '如 instructions',
    help: '声明后透传情绪/风格指令到该请求体字段（如阿里千问 instruct 变体 instructions）；留空不透传',
  })
  fields.push({
    key: 'emotion_map',
    label: '情绪映射（可选，JSON）',
    type: 'json',
    placeholder: '{"开心":"happy","难过":"sad"}',
    help: '基调词 → 供应商枚举值映射（供只认枚举值的网关，如火山）；未配则透传完整情绪描述',
  })
  return fields
}

/** 图像通道：出图尺寸（preflight 读 image.extra.size，默认 1024x1024） */
function imageSchema(): ExtraField[] {
  return [
    {
      key: 'size',
      label: '出图尺寸',
      type: 'text',
      default: '1024x1024',
      placeholder: '如 1024x1024',
      help: '文生图分辨率；留空按 1024x1024（部分供应商仅支持固定档位）',
    },
  ]
}

/** 视频通道：参考素材 / 音频 / 水印 / 种子（creationCapabilities 由 VideoCapsEditor 专管，不在此） */
function videoSchema(providerKey: string): ExtraField[] {
  const fields: ExtraField[] = []
  if (providerKey === 'volcengine_video' || providerKey === 'minimax_video') {
    fields.push({
      key: 'referenceImageUrls',
      label: '参考图 URL 列表',
      type: 'url-list',
      help: '每行一个图片 URL（≤9 张）；作为主体/风格参考注入',
    })
    fields.push({
      key: 'referenceVideoUrls',
      label: '参考视频 URL 列表',
      type: 'url-list',
      help: '每行一个视频 URL；作为运动/镜头参考',
    })
    fields.push({
      key: 'referenceAudioUrls',
      label: '参考音频 URL 列表',
      type: 'url-list',
      help: '每行一个音频 URL；作为节奏/配音参考',
    })
  }
  if (providerKey === 'volcengine_video') {
    fields.push({ key: 'generateAudio', label: '生成音频', type: 'boolean', help: '是否让模型自带音轨（默认关）' })
    fields.push({ key: 'watermark', label: '添加水印', type: 'boolean', help: '是否在产出加供应商水印（默认关）' })
  }
  if (providerKey === 'pollinations_video') {
    fields.push({ key: 'seed', label: '随机种子', type: 'number', placeholder: '如 42', help: '固定种子可复现（留空随机）' })
    fields.push({ key: 'audio', label: '带音频', type: 'boolean', help: 'Pollinations 网关是否请求音轨（默认关）' })
  }
  return fields
}

/** 文本通道：视觉理解声明（planning.ts 读 ep.extra.vision，参考视频/图片解析需 true） */
function llmSchema(): ExtraField[] {
  return [
    {
      key: 'vision',
      label: '支持视觉理解',
      type: 'boolean',
      help: '勾选表示该模型可读图/视频帧；轻松创作上传参考视频/图片做内容解析时需置为 true（否则相关功能拒绝并提示换模型）',
    },
  ]
}

/**
 * 依 providerKey + serviceType 给出该实例可结构化配置的扩展参数清单。
 * 未知 serviceType → 空数组（表单回退裸 JSON 透传，不猜）。
 */
export function resolveExtraSchema(providerKey: string, serviceType: string): ExtraField[] {
  switch (serviceType) {
    case 'audio':
      return audioSchema(providerKey)
    case 'image':
      return imageSchema()
    case 'video':
      return videoSchema(providerKey)
    case 'llm':
      return llmSchema()
    default:
      return []
  }
}
