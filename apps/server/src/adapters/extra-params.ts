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
 *
 * [M39] 逐模型能力下沉（对齐 Toonflow voices[] / durationResolutionMap 声明范式）：音色/尺寸支持度
 * 实为「模型级」事实（qwen-tts 4 音色 vs qwen3-tts-flash 36 音色；CosyVoice2 官方 8 预置音色；
 * qwen-image-max/plus 仅官方 5 档固定尺寸），故新增逐模型 profile 表：resolveExtraSchema /
 * defaultVoice / defaultImageSize 接受可选 model，命中 profile → 模型级候选/默认；未命中/未传 →
 * 回落 provider 级条目（行为不劣于 M38，兼容旧调用与在线目录外模型）。逐条事实来源见行内注释
 * （官方文档页面 / 适配器核实注释 / 本仓实测约束）；profile 标 text 的（如 elevenlabs voice id 集
 * 未核实）不猜枚举、无默认，预检仍显式要求配置。视频时长/分辨率已由 M32 resolveVideoCaps
 * 逐模型背书，不在本文件重复登记。
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
  aliyun_bailian_tts: { options: ['Cherry', 'Serena', 'Ethan', 'Chelsie'], default: 'Cherry' },
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
 * [M39] 逐模型音色 profile：match 命中已选模型 id 时生效（优先于 provider 级条目）。
 * - enum：官方核实音色集；voices.value 为最终存库串模板（可选 {model} 占位，如 SiliconFlow「模型:音色」）；
 * - text：供应商真实支持但枚举未核实（如 elevenlabs voice id）→ 显式配置，不预置默认；
 * - default：平台预填默认（必为 voices 命中的核实值；enum 无核实默认时缺省→不兜底）。
 */
interface AudioVoiceProfile {
  match: RegExp
  kind: 'enum' | 'text'
  voices?: { value: string; label: string }[]
  default?: string
  help?: string
}

/** 拼接 {model} 占位（SiliconFlow 音色需「所选模型:音色」完整串存库，编辑器零新语义） */
function composeVoice(value: string, model: string): string {
  return value.replace('{model}', model)
}

const AUDIO_VOICE_PROFILES: Record<string, AudioVoiceProfile[]> = {
  // 阿里云百炼《Qwen-TTS音色列表》官方文档逐行核实（非实时口，即本仓 multimodal-generation 协议）
  aliyun_bailian_tts: [
    {
      // qwen3-tts-instruct-flash（含快照版）：官方列表中标注支持该模型的全部音色（26 个，不含方言/美语专区）
      match: /^qwen3-tts-instruct-flash/i,
      kind: 'enum',
      voices: ([
        ['Cherry', '芊悦'], ['Serena', '苏瑶'], ['Ethan', '晨煦'], ['Chelsie', '千雪'], ['Momo', '茉兔'],
        ['Vivian', '十三'], ['Moon', '月白'], ['Maia', '四月'], ['Kai', '凯'], ['Nofish', '不吃鱼'],
        ['Bella', '萌宝'], ['Eldric Sage', '沧明子'], ['Mia', '乖小妹'], ['Mochi', '沙小弥'], ['Bellona', '燕铮莺'],
        ['Vincent', '田叔'], ['Bunny', '萌小姬'], ['Neil', '阿闻'], ['Elias', '墨讲师'], ['Arthur', '徐大爷'],
        ['Nini', '邻家妹妹'], ['Seren', '小婉'], ['Pip', '顽屁小孩'], ['Stella', '少女阿月'],
      ] as [string, string][]).map(([v, cn]) => ({ value: v, label: `${v}（${cn}）` })),
      default: 'Cherry',
      help: 'instruct 变体另支持自然语言情绪指令（extra.emotion_param 配 instructions 即透传）',
    },
    {
      // qwen3-tts-flash（含快照版）：官方列表全部非实时音色（36 个，含美语/多国/方言音色）
      match: /^qwen3-tts-flash/i,
      kind: 'enum',
      voices: ([
        ['Cherry', '芊悦'], ['Serena', '苏瑶'], ['Ethan', '晨煦'], ['Chelsie', '千雪'], ['Momo', '茉兔'],
        ['Vivian', '十三'], ['Moon', '月白'], ['Maia', '四月'], ['Kai', '凯'], ['Nofish', '不吃鱼'],
        ['Bella', '萌宝'], ['Jennifer', '詹妮弗'], ['Ryan', '甜茶'], ['Katerina', '卡捷琳娜'], ['Aiden', '艾登'],
        ['Eldric Sage', '沧明子'], ['Mia', '乖小妹'], ['Mochi', '沙小弥'], ['Bellona', '燕铮莺'], ['Vincent', '田叔'],
        ['Bunny', '萌小姬'], ['Neil', '阿闻'], ['Elias', '墨讲师'], ['Arthur', '徐大爷'], ['Nini', '邻家妹妹'],
        ['Seren', '小婉'], ['Pip', '顽屁小孩'], ['Stella', '少女阿月'], ['Bodega', '博德加'], ['Sonrisa', '索尼莎'],
        ['Alek', '阿列克'], ['Dolce', '多尔切'], ['Sohee', '素熙'], ['Ono Anna', '小野杏'], ['Lenn', '莱恩'],
        ['Andre', '安德雷'], ['Radio Gol', '拉迪奥·戈尔'],
        ['Jada', '上海-阿珍'], ['Dylan', '北京-晓东'], ['Li', '南京-老李'], ['Marcus', '陕西-秦川'],
        ['Roy', '闽南-阿杰'], ['Peter', '天津-李彼得'], ['Sunny', '四川-晴儿'], ['Eric', '四川-程川'],
        ['Rocky', '粤语-阿强'], ['Kiki', '粤语-阿清'],
      ] as [string, string][]).map(([v, cn]) => ({ value: v, label: `${v}（${cn}）` })),
      default: 'Cherry',
    },
    // qwen-tts（老一代）：官方仅核实核心 4 音色与 provider 级条目一致，不另建 profile（回落 provider 级）
  ],
  // OpenAI 官方 Text-to-speech 指南：tts-1/tts-1-hd 支持 9 音色；gpt-4o-mini-tts 全量 11 音色（另含 ballad/verse）
  openai_audio: [
    {
      match: /gpt-4o.*tts/i,
      kind: 'enum',
      voices: [
        'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse',
      ].map((v) => ({ value: v, label: v })),
      default: 'alloy',
    },
    {
      match: /^tts-1/i,
      kind: 'enum',
      voices: ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'].map((v) => ({ value: v, label: v })),
      default: 'alloy',
    },
  ],
  // 硅基流动官方《语音合成》文档：CosyVoice2-0.5B 系统预置 8 音色，使用时需加模型名前缀（如 FunAudioLLM/CosyVoice2-0.5B:alex）
  siliconflow_audio: [
    {
      match: /^FunAudioLLM\/CosyVoice2-0\.5B/i,
      kind: 'enum',
      voices: ([
        ['alex', '沉稳男声'], ['benjamin', '低沉男声'], ['charles', '磁性男声'], ['david', '欢快男声'],
        ['anna', '沉稳女声'], ['bella', '激情女声'], ['claire', '温柔女声'], ['diana', '欢快女声'],
      ] as [string, string][]).map(([v, d]) => ({ value: '{model}:' + v, label: `${v}（${d}）`})),
      default: '{model}:alex',
      help: '官方系统预置 8 音色；选后自动拼为「模型:音色」存库（实名认证后亦可上传克隆音色，那类 uri 请在高级透传手填）',
    },
  ],
  // Pollinations 网关（本仓实测约束）：qwen 系吃 OpenAI 风 + Qwen 原生中文音色；elevenlabs/kokoro 音色集未核实→不猜枚举
  pollinations_audio: [
    {
      match: /^qwen\//i,
      kind: 'enum',
      voices: ['alloy', 'Cherry', 'echo', 'nova'].map((v) => ({ value: v, label: v })),
      default: 'alloy',
      help: '实测可用集；SiliconFlow 风「模型:音色」会被拒（400 Invalid voice）',
    },
    { match: /^elevenlabs\//i, kind: 'text', help: 'ElevenLabs 音色为独立 voice 体系（非 OpenAI 枚举），枚举未核实，请显式填写' },
    { match: /^hexgrad\//i, kind: 'text', help: 'Kokoro 音色集未核实，请显式填写（错误音色会在连通测试/预检暴露）' },
  ],
}

/** 依 provider+模型解析已核实的音色 profile；未传模型/未命中 → null（回落 provider 级条目） */
function resolveVoiceProfile(providerKey: string, model?: string): AudioVoiceProfile | null {
  const m = (model || '').trim()
  if (!m) return null
  const hit = (AUDIO_VOICE_PROFILES[providerKey] ?? []).find((p) => p.match.test(m))
  if (!hit) return null
  // enum 候选与默认拼上实选模型（{model} 占位）；text 原样
  return hit.voices
    ? { ...hit, voices: hit.voices.map((v) => ({ ...v, value: composeVoice(v.value, m) })), default: hit.default ? composeVoice(hit.default, m) : undefined }
    : hit
}

/**
 * 语音供应商的安全默认音色（收敛适配器兜底为唯一真源；[M39] 逐模型优先）。
 * 解析链：profile（传了 model 且命中，即以模型级事实为准，text 无默认→空不再回落 provider 级）→
 * provider 级条目 → 空字符串（交由用户显式配置，预检据此判定是否仍需 missing_voice：
 * 不猜测、不注入占位/跨模型假默认音色致运行时 400）。
 */
export function defaultVoice(providerKey: string, model?: string): string {
  const profile = resolveVoiceProfile(providerKey, model)
  // profile 命中即以模型级事实为准（text 无默认＝不继续回落 provider 级，防跨模型假默认，
  // 如 elevenlabs 实例不得注非 pollinations 的 alloy）；未命中才回落 provider 级条目
  if (profile) {
    return profile.default ?? ''
  }
  const e = AUDIO_VOICE_ENUMS[providerKey]
  if (e) return e.default
  const t = AUDIO_VOICE_TEXT[providerKey]
  if (t?.default) return t.default
  return ''
}

/** 语音通道：音色（[M39] 逐模型 profile 优先，未命中回落 provider 级）+ 火山 appid/cluster + 情绪透传声明 */
function audioSchema(providerKey: string, model?: string): ExtraField[] {
  const fields: ExtraField[] = []
  const profile = resolveVoiceProfile(providerKey, model)
  const e = AUDIO_VOICE_ENUMS[providerKey]
  const t = AUDIO_VOICE_TEXT[providerKey]
  const voiceHelp = '轻松创作用现成音色；如需克隆声音请到「音色库」管理（克隆音色不用于轻松创作）'
  if (profile?.kind === 'enum') {
    fields.push({
      key: 'voice',
      label: '音色',
      type: 'select',
      options: profile.voices!.map((v) => ({ value: v.value, label: v.label })),
      default: profile.default,
      help: profile.help ?? voiceHelp,
    })
  } else if (profile?.kind === 'text') {
    fields.push({ key: 'voice', label: '音色', type: 'text', placeholder: '音色名 / voice id', help: profile.help })
  } else if (e) {
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

/** 已核实档位（enum）或像素区间约束（text）的图像尺寸声明；命中模型后优先于通用 1024x1024 文本框 */
interface ImageSizeProfile {
  match: RegExp
  kind: 'enum' | 'text'
  /** select 候选（官方核实档位，存库统一 WxH / 1K 形态，适配器 normalizeSize 归一） */
  options?: { value: string; label: string }[]
  default?: string
  help?: string
}

/**
 * [M39] 逐模型尺寸 profile：仅登记官方文档核实过尺寸参数的模型族；未命中 → provider 级通用文本框。
 * 事实来源：阿里云《万相-文生图》《千问-文生图》API 文档（Step 0 WebFetch 核实）。
 */
const IMAGE_SIZE_PROFILES: Record<string, ImageSizeProfile[]> = {
  // 阿里百炼图像（万相多代 + 千问同步直返两族协议已收敛为一行，按 model 正则命中档位）
  aliyun_bailian_image: [
    {
      // wan2.7-image-pro：文生图（无图片输入）支持 1K/2K/4K，其余场景仅 1K/2K；默认 2K
      match: /^wan2\.7-image-pro$/i,
      kind: 'enum',
      options: ['1K', '2K', '4K'].map((v) => ({ value: v, label: `${v}（总像素 ${v} 档）` })),
      default: '2K',
      help: '官方档位：文生图支持 1K/2K/4K，图像输入/组图场景仅 1K/2K；默认 2K',
    },
    {
      // wan2.7-image：1K/2K 两档，不支持 4K；默认 2K
      match: /^wan2\.7-image$/i,
      kind: 'enum',
      options: ['1K', '2K'].map((v) => ({ value: v, label: `${v}（总像素 ${v} 档）` })),
      default: '2K',
      help: '官方档位 1K/2K（本模型不支持 4K）；默认 2K',
    },
    {
      // wan2.6-t2i / wan2.5-t2i-preview：官方约束为总像素范围（非固定档位），适配器 normalizeSize 收 WxH 形态
      match: /^wan2\.[56]/i,
      kind: 'text',
      default: '1024x1024',
      help: '官方约束：总像素 [768x768, 2048x2048]（即 [589824, 4194304]），宽高比 [1:8, 8:1]；填 WxH 如 1024x1024',
    },
    {
      // wan2.2-t2i-flash / wan2.2-t2i-plus：适配器注释核实约束为宽高各 [512, 1440]
      match: /^wan2\.2/i,
      kind: 'text',
      default: '1024x1024',
      help: '官方约束：宽、高均在 [512, 1440] 像素之间；填 WxH 如 1024x1024',
    },
    {
      // qwen-image-max / qwen-image-plus：官方仅 5 档固定尺寸（1024x1024 对其为非法值）
      match: /^qwen-image-(max|plus)$/i,
      kind: 'enum',
      options: ['1664x928', '1472x1104', '1328x1328', '1104x1472', '928x1664'].map((v) => ({ value: v, label: v })),
      default: '1664x928',
      help: '官方仅支持 5 档固定尺寸（默认 1664x928 即 16:9）；其余尺寸会被拒绝',
    },
    {
      // qwen-image-3.0 / 2.0 系：官方支持 512²~2048² 自定义像素（seed 预置描述核实）
      match: /^qwen-image-(3\.0|2\.0)/i,
      kind: 'text',
      default: '1024x1024',
      help: '官方范围：宽高均可在 [512, 2048] 像素间自定义；填 WxH 如 1024x1024',
    },
    // 无版本后缀的 qwen-image（一代）：尺寸事实未核实 → 不建 profile，回落 provider 级
  ],
}

/** 依 provider+模型解析已核实的尺寸 profile；未传模型/未命中 → null（回落通用文本框） */
function resolveSizeProfile(providerKey: string, model?: string): ImageSizeProfile | null {
  const m = (model || '').trim()
  if (!m) return null
  return (IMAGE_SIZE_PROFILES[providerKey] ?? []).find((p) => p.match.test(m)) ?? null
}

/**
 * 图像供应商的安全默认尺寸（[M39] 逐模型优先）。
 * 解析链：profile 默认 → '1024x1024'（preflight 未配置时的通用兜底走此出口；
 * 命中 max/plus 等固定档位模型的实例经 profile 默认避开非法值）。
 */
export function defaultImageSize(providerKey: string, model?: string): string {
  const profile = resolveSizeProfile(providerKey, model)
  if (profile?.default) return profile.default
  return '1024x1024'
}

/** 图像通道：出图尺寸（[M39] 逐模型 profile 优先；preflight 读 image.extra.size） */
function imageSchema(providerKey: string, model?: string): ExtraField[] {
  const profile = resolveSizeProfile(providerKey, model)
  if (profile?.kind === 'enum') {
    return [{ key: 'size', label: '出图尺寸', type: 'select', options: profile.options, default: profile.default, help: profile.help }]
  }
  if (profile?.kind === 'text') {
    return [{ key: 'size', label: '出图尺寸', type: 'text', default: profile.default, placeholder: '如 1024x1024', help: profile.help }]
  }
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
 * 依 providerKey + serviceType（可选 model，[M39] 逐模型 profile）给出该实例可结构化配置的扩展参数清单。
 * 未知 serviceType → 空数组（表单回退裸 JSON 透传，不猜）。
 */
export function resolveExtraSchema(providerKey: string, serviceType: string, model?: string): ExtraField[] {
  switch (serviceType) {
    case 'audio':
      return audioSchema(providerKey, model)
    case 'image':
      return imageSchema(providerKey, model)
    case 'video':
      return videoSchema(providerKey)
    case 'llm':
      return llmSchema()
    default:
      return []
  }
}
