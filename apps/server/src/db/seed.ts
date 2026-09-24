import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from './index'
import { apiConfigs, apiProviders, vendorCredentials, voiceClones, stylePresets } from './schema'
import { deleteSecret, resolveApiKey, writeSecret } from '../services/secrets'

interface ProviderSeed {
  key: string
  name: string
  serviceType: string
  vendor: string // 厂商分组标识
  description: string
  defaultUrl?: string
  presetModels?: string
  /** true = 该行 presetModels 由代码目录维护，存在时也覆盖（用于模型名纠错/官方目录更新）；默认仅在空时回填 */
  overwritePresetModels?: boolean
  /** true = defaultUrl 由代码目录维护，存在时也覆盖（用于端点形态纠错）；默认仅在空时回填 */
  overwriteDefaultUrl?: boolean
}

/** 厂商凭证预置目录（显示名 + 厂商标识） */
interface VendorSeed {
  vendor: string
  name: string
}

/** 优先展示厂商（AI 配置页供应商列表 / 厂商凭证靠前显示），按数组顺序排前 */
export const VENDOR_PRIORITY: string[] = ['volcengine', 'aliyun', 'minimax', 'kling']

/** 厂商展示优先级：名单内按序取 0/1/…，名单外统一取末尾值（配合稳定排序保持原有相对顺序） */
export function vendorPriorityRank(vendor: string | null | undefined): number {
  const i = VENDOR_PRIORITY.indexOf(vendor ?? '')
  return i === -1 ? VENDOR_PRIORITY.length : i
}

export const VENDOR_SEEDS: VendorSeed[] = [
  { vendor: 'aliyun', name: '阿里百炼' },
  { vendor: 'deepseek', name: 'DeepSeek' },
  { vendor: 'openai', name: 'OpenAI' },
  { vendor: 'siliconflow', name: 'SiliconFlow' },
  { vendor: 'google', name: 'Google' },
  { vendor: 'volcengine', name: '火山方舟' },
  { vendor: 'minimax', name: 'MiniMax' },
  { vendor: 'kling', name: '可灵' },
  { vendor: 'pollinations', name: 'Pollinations' },
  { vendor: 'ollama', name: 'Ollama（本地）' },
]

/**
 * 预置供应商目录（种子）。
 * 命名原则（M2.2 统一）：一行 = 厂商 × 能力；协议实现（OpenAI 兼容 / 私有协议）
 * 只在 description 里说明，不进入行名。同一厂商的每类能力各占一行
 * （如 siliconflow_* / pollinations_* / aliyun_* / volcengine_* 四类）。openai_* 行 = OpenAI 官方，
 * 亦承接任意 OpenAI 兼容的自定义网关；video 各家协议互不相通，天然一家一行。
 * 阿里 aliyun_* 行共享阿里百炼平台凭证（DashScope），不再按模型家族（千问/万相）拆行：
 * 一行 = 一类能力，家族差异下沉到模型选择（图像行适配器按 model 前缀派发两族协议）。
 * vendor 字段将多行归组到同一厂商凭证（用户只配一次 Key）。
 */
export const PROVIDER_SEEDS: ProviderSeed[] = [
  { key: 'deepseek_llm', name: 'DeepSeek（LLM）', serviceType: 'llm', vendor: 'deepseek', description: 'OpenAI 兼容（官方端点内置，模型可在线获取）', defaultUrl: 'https://api.deepseek.com/v1', presetModels: JSON.stringify(['deepseek-flash', 'deepseek-v4-pro']), overwritePresetModels: true },
  { key: 'openai_llm', name: 'OpenAI（LLM）', serviceType: 'llm', vendor: 'openai', description: 'OpenAI 官方 / 任意 Chat Completions 兼容网关（模型在实例中配置）', defaultUrl: 'https://api.openai.com/v1' },
  { key: 'siliconflow_llm', name: 'SiliconFlow（LLM）', serviceType: 'llm', vendor: 'siliconflow', description: 'OpenAI Chat Completions 兼容（硅基流动，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['deepseek-ai/DeepSeek-V4-Flash']) },
  { key: 'pollinations_llm', name: 'Pollinations（LLM）', serviceType: 'llm', vendor: 'pollinations', description: 'gen.pollinations.ai/v1 OpenAI 兼容（模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['openai/gpt-5.4-nano', 'openai/gpt-5.4-mini', 'qwen/qwen3.8-flash']) },
  { key: 'google_llm', name: 'Google（LLM）', serviceType: 'llm', vendor: 'google', description: 'Gemini 官方 OpenAI 兼容（v1beta/openai，模型可在线获取）', defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', presetModels: JSON.stringify(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']) },
  { key: 'aliyun_bailian_llm', name: '阿里百炼（LLM）', serviceType: 'llm', vendor: 'aliyun', description: '百炼官方 OpenAI 兼容（compatible-mode，模型可在线获取；公共域 2026-09-30 起维护不再迭代新特性，建议改用业务空间专属域 https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1）', defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', presetModels: JSON.stringify(['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash']) },
  { key: 'volcengine_llm', name: '火山方舟（LLM）', serviceType: 'llm', vendor: 'volcengine', description: '豆包 Seed 系列（Ark OpenAI 兼容 /api/v3；模型 ID 需带版本号并在方舟控制台开通）', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', presetModels: JSON.stringify(['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628']), overwritePresetModels: true },
  { key: 'minimax_llm', name: 'MiniMax（LLM）', serviceType: 'llm', vendor: 'minimax', description: 'MiniMax M 系列文本模型（OpenAI 兼容 https://api.minimax.cn/v1；支持在线列模型 List Models）', defaultUrl: 'https://api.minimax.cn/v1', presetModels: JSON.stringify(['MiniMax-M3', 'MiniMax-M2.5']), overwritePresetModels: true },
  { key: 'ollama_llm', name: 'Ollama（LLM）', serviceType: 'llm', vendor: 'ollama', description: '本地 Ollama 服务（OpenAI 兼容 /v1；模型在线拉取 /v1/models；无需 API Key，密钥留空或任意占位符即可）', defaultUrl: 'http://localhost:11434/v1', presetModels: JSON.stringify(['qwen2.5', 'llama3.1']) },
  { key: 'volcengine_image', name: '火山方舟图像', serviceType: 'image', vendor: 'volcengine', description: '豆包 Seedream 系列文生图（Ark，同步直返或任务轮询）', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', presetModels: JSON.stringify(['doubao-seedream-5-0-260128']) },
  { key: 'minimax_image', name: 'MiniMax 图像', serviceType: 'image', vendor: 'minimax', description: 'MiniMax image-01 系文生图 / 图生图（subject_reference 参考图，type 仅 character，接受公网 URL 或 data:image base64；同步直返 data.image_urls，私有协议不提供在线模型拉取；尺寸 WxH 需 [512,2048] 且 8 倍数；t2i+i2i 已实机验证）', defaultUrl: 'https://api.minimax.cn', presetModels: JSON.stringify(['image-01', 'image-01-live']), overwritePresetModels: true },
    { key: 'kling_image', name: '可灵图像', serviceType: 'image', vendor: 'kling', description: '可灵（快手）文生图/图生图（model_name 枚举 kling-v3/kling-v2-1；旧版设计标准 /v1/images/generations 异步任务，无在线模型拉取。API Key 直接填控制台「新建 API Key」复制的密钥（也兼容旧 AccessKey:SecretKey，适配器自动签发 JWT）；默认域名 api-beijing.klingai.com）', defaultUrl: 'https://api-beijing.klingai.com', presetModels: JSON.stringify(['kling-v3', 'kling-v2-1']), overwritePresetModels: true },
  { key: 'openai_image', name: 'OpenAI 图像', serviceType: 'image', vendor: 'openai', description: 'gpt-image-1 文生图 + 图生图/编辑（/images/generations 文生图、/images/edits multipart 参考图与 mask 局部重绘，恒返 b64_json；outpaint 不支持；必填字段 image/image[] 经端点差分实机确认，⚠ 账户当前无余额→完整出图待充值验证）', defaultUrl: 'https://api.openai.com/v1', presetModels: JSON.stringify(['gpt-image-1', 'gpt-image-1-mini']), overwritePresetModels: true },
  { key: 'siliconflow_image', name: 'SiliconFlow 图像', serviceType: 'image', vendor: 'siliconflow', description: 'OpenAI Images 兼容（含 images[] 镜像响应，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['Tongyi-MAI/Z-Image-Turbo']) },
  { key: 'gemini_image', name: 'Gemini 图像', serviceType: 'image', vendor: 'google', description: 'Nano Banana（Gemini Image）系列文生图/改图（原生 v1beta generateContent 协议；base_url 填根域名或中转站原生镜像）', defaultUrl: 'https://generativelanguage.googleapis.com', presetModels: JSON.stringify(['gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image']), overwriteDefaultUrl: true },
  { key: 'pollinations_image', name: 'Pollinations 图像', serviceType: 'image', vendor: 'pollinations', description: 'OpenAI Images 兼容（默认 b64_json，模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['tongyi-mai/z-image-turbo', 'black-forest-labs/flux.1-schnell', 'google/gemini-3.1-flash-image']) },
  { key: 'aliyun_bailian_image', name: '阿里百炼图像', serviceType: 'image', vendor: 'aliyun', description: '百炼文生图与图像编辑（DashScope；按模型→协议档案派发信封；画布涂抹重绘/扩图需 wan 系模型；可灵/Vidu/z-image 等第三方托管模型须用业务空间专属域 Base URL，公共域 2026-09-30 起维护）', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['wan2.7-image', 'wan2.7-image-pro', 'wan2.6-t2i', 'wan2.5-t2i-preview', 'wan2.2-t2i-flash', 'wan2.2-t2i-plus', 'qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-2.0-pro', 'qwen-image-max', 'qwen-image-plus']), overwritePresetModels: true },
  { key: 'volcengine_video', name: '火山方舟视频', serviceType: 'video', vendor: 'volcengine', description: '豆包 Seedance 2.x 系列视频生成（模型需在方舟控制台开通）', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', presetModels: JSON.stringify(['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128']), overwritePresetModels: true },
  { key: 'minimax_video', name: 'MiniMax 视频', serviceType: 'video', vendor: 'minimax', description: 'MiniMax H3 系列视频生成（H3：768P/2K、4–15s；H3-Max：480P/768P、5–15s；官方域名 api.minimax.cn，旧实例 baseUrl 含 /v2 尾缀已兼容不再双拼）', defaultUrl: 'https://api.minimax.cn', presetModels: JSON.stringify(['MiniMax-H3', 'MiniMax-H3-Max']), overwritePresetModels: true },
    { key: 'kling_video', name: '可灵视频', serviceType: 'video', vendor: 'kling', description: '可灵（快手）视频生成（新版路径式接口 /text-to-video・/image-to-video・/omni-video/{model}，统一 /tasks 查询；模型为路径 token：kling-3.0-turbo/3.0/3.0-omni/2.6/2.5-turbo，kling-o1 仅 omni。API Key 直接填控制台「新建 API Key」复制的密钥（也兼容旧 AccessKey:SecretKey）；默认域名 api-beijing.klingai.com，国际站可改 baseUrl 为 https://api-singapore.klingai.com）', defaultUrl: 'https://api-beijing.klingai.com', presetModels: JSON.stringify(['kling-3.0-turbo', 'kling-3.0', 'kling-3.0-omni', 'kling-2.6', 'kling-2.5-turbo', 'kling-o1']), overwritePresetModels: true },
  { key: 'aliyun_bailian_video', name: '阿里百炼视频', serviceType: 'video', vendor: 'aliyun', description: '百炼视频生成（DashScope；wan/可灵/Vidu 等按协议档案派发；第三方托管模型须用业务空间专属域 Base URL，公共域 2026-09-30 起维护）', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['wan3.0-video-prime', 'wan3.0-video']) },
  { key: 'siliconflow_video', name: 'SiliconFlow 视频', serviceType: 'video', vendor: 'siliconflow', description: 'Wan2.2 系列视频生成（submit/status 轮询，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['Wan-AI/Wan2.2-T2V-A14B', 'Wan-AI/Wan2.2-I2V-A14B']) },
  { key: 'pollinations_video', name: 'Pollinations 视频', serviceType: 'video', vendor: 'pollinations', description: 'veo/seedance/wan 系列（GET 同步长请求，无轮询，模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['google/veo-3.1-fast', 'bytedance/seedance-2.0-fast', 'alibaba/wan-2.2-fast']) },
  { key: 'openai_video', name: 'OpenAI 视频', serviceType: 'video', vendor: 'openai', description: '⚠ Sora 视频生成（官方 Videos API 已于 2026-09-24 下线且无替代模型，此路径将恒失败，建议停用实例）：历史为 /v1/videos 提交→轮询→/content 鉴权下载；不提供在线模型拉取', defaultUrl: 'https://api.openai.com/v1', presetModels: JSON.stringify(['sora-2', 'sora-2-pro']), overwritePresetModels: true },
  { key: 'google_video', name: 'Google 视频', serviceType: 'video', vendor: 'google', description: 'Veo 视频生成（Gemini API 原生 /v1beta predictLongRunning→LRO 轮询→鉴权下载，适配器内部收字节；文生/图生视频（首帧 data URI→bytesBase64Encoded）；不提供在线模型拉取）', defaultUrl: 'https://generativelanguage.googleapis.com', presetModels: JSON.stringify(['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview']), overwritePresetModels: true },
  { key: 'openai_audio', name: 'OpenAI 语音', serviceType: 'audio', vendor: 'openai', description: 'OpenAI 官方 / 任意 /audio/speech 兼容网关（模型在实例中配置）', defaultUrl: 'https://api.openai.com/v1' },
  { key: 'siliconflow_audio', name: 'SiliconFlow 语音', serviceType: 'audio', vendor: 'siliconflow', description: 'OpenAI /audio/speech 兼容 TTS（硅基流动，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['FunAudioLLM/CosyVoice2-0.5B']) },
  { key: 'pollinations_audio', name: 'Pollinations 语音', serviceType: 'audio', vendor: 'pollinations', description: 'OpenAI /audio/speech 兼容 TTS（ElevenLabs/Qwen 等，模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['elevenlabs/eleven-flash-v2.5', 'qwen/qwen3-tts-flash', 'hexgrad/kokoro-82m']) },
  { key: 'aliyun_bailian_tts', name: '阿里百炼语音', serviceType: 'audio', vendor: 'aliyun', description: '百炼 qwen-tts 语音合成（DashScope，音色如 Cherry / Serena / Ethan；公共域 2026-09-30 起维护，建议改用业务空间专属域）', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['qwen-tts']) },
  { key: 'volcengine_audio', name: '火山方舟语音', serviceType: 'audio', vendor: 'volcengine', description: '豆包语音（openspeech，非 OpenAI 兼容）——同一实例按「模型」字段派两个不同产品/开通项：seed-audio-1.0 走「豆包音频生成模型」/api/v3/tts/create（同步 {audio:base64}，text_prompt 自然语言描述）；seed-tts 走「语音合成大模型」/api/v3/tts/unidirectional（NDJSON 流式，按 speaker 枚举 + X-Api-Resource-Id 路由）。两者需分别在豆包语音控制台开通；未开通者→ 403 45000030 resource not granted。鉴权仅需 X-Api-Key（需豆包语音控制台专用 Key，与方舟 ark 模型 Key 不通用）；音色(speaker) 仅 seed-tts 路径在实例扩展参数配置。2026-09 实机：seed-audio-1.0 已验证可出音（MP3）', defaultUrl: 'https://openspeech.bytedance.com', presetModels: JSON.stringify(['seed-audio-1.0', 'seed-tts']), overwritePresetModels: true },
  { key: 'minimax_audio', name: 'MiniMax 语音', serviceType: 'audio', vendor: 'minimax', description: 'MiniMax 语音合成 T2A V2（speech-2.8-hd/turbo 同步，响应 data.audio 为 hex 编码；私有协议 voice_id 枚举，不提供在线模型拉取；音色在实例扩展参数配置）', defaultUrl: 'https://api.minimax.cn', presetModels: JSON.stringify(['speech-2.8-hd', 'speech-2.8-turbo']), overwritePresetModels: true },
  { key: 'google_audio', name: 'Google 语音', serviceType: 'audio', vendor: 'google', description: 'Gemini 原生 TTS（/v1beta generateContent responseModalities=AUDIO，返回裸 PCM 适配包 WAV 头；音色 voiceName 为 prebuilt 枚举，走原生协议不提供 OpenAI 兼容在线拉取；音色在实例扩展参数配置）', defaultUrl: 'https://generativelanguage.googleapis.com', presetModels: JSON.stringify(['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts', 'gemini-3.1-flash-tts-preview']), overwritePresetModels: true },
]

/**
 * 幂等补种（M2 起为「缺失补插 + 目录信息回填」，老库增量生效）：
 * - key 不存在 → 插入；
 * - 存在但 defaultUrl/presetModels 为空且种子提供 → 回填（不动用户已填内容）；
 * - 种子标记 overwritePresetModels 的行（模型名纠错场景）→ presetModels 由代码目录直接覆盖；
 * - 种子标记 overwriteDefaultUrl 的行（端点形态纠错场景）→ defaultUrl 由代码目录直接覆盖；
 * - description / name / vendor 与种子不一致 → 更新（目录文案随代码演进；目录行无用户编辑入口）。
 */
export async function seedProviders(): Promise<void> {
  const now = Date.now()
  const rows = await db.select().from(apiProviders)
  const byKey = new Map(rows.map((r) => [r.key, r]))
  for (const p of PROVIDER_SEEDS) {
    const exist = byKey.get(p.key)
    if (!exist) {
      await db.insert(apiProviders).values({
        key: p.key,
        name: p.name,
        serviceType: p.serviceType,
        vendor: p.vendor,
        description: p.description,
        defaultUrl: p.defaultUrl,
        presetModels: p.presetModels,
        createdAt: now,
        updatedAt: now,
      })
      continue
    }
    const patch: Record<string, unknown> = {}
    if (p.defaultUrl && (p.overwriteDefaultUrl || !exist.defaultUrl)) patch['defaultUrl'] = p.defaultUrl
    if (p.presetModels && (p.overwritePresetModels || !exist.presetModels)) patch['presetModels'] = p.presetModels
    if (exist.description !== p.description) patch['description'] = p.description
    if (exist.name !== p.name) patch['name'] = p.name
    if (p.vendor && exist.vendor !== p.vendor) patch['vendor'] = p.vendor
    if (Object.keys(patch).length > 0) {
      await db.update(apiProviders).set({ ...patch, updatedAt: now }).where(eq(apiProviders.key, p.key))
    }
  }
}

/**
 * 幂等补种厂商凭证目录（仅插入缺失的 vendor 行，不覆盖用户已填内容）。
 * 用户配置 Key 后，apiKeyRef 从 'local' 变为 'local:vendor:{vendor}'。
 */
export async function seedVendorCredentials(): Promise<void> {
  const now = Date.now()
  const rows = await db.select().from(vendorCredentials)
  const existing = new Set(rows.map((r) => r.vendor))
  for (const v of VENDOR_SEEDS) {
    if (existing.has(v.vendor)) continue
    await db.insert(vendorCredentials).values({
      vendor: v.vendor,
      name: v.name,
      apiKeyRef: 'local',
      isActive: 1,
      createdAt: now,
      updatedAt: now,
    })
  }
}

/**
 * 幂等迁移：将存量 api_configs 的密钥自动归集到 vendor_credentials。
 * 逻辑：
 * 1. 找到所有 credentialId 为 null 的实例
 * 2. 按 providerKey 前缀提取 vendor（aliyun_* → aliyun）
 * 3. 对每个 vendor，取第一个有实际 Key 的实例的 apiKeyRef → 复制到 local:vendor:{vendor}
 * 4. 将同 vendor 下所有实例的 credentialId 指向对应凭证
 * 原 apiKeyRef 保留不删（兼容 fallback）。
 */
export async function migrateCredentialsFromConfigs(): Promise<void> {
  const orphanConfigs = await db.select().from(apiConfigs).where(isNull(apiConfigs.credentialId))
  if (orphanConfigs.length === 0) return

  const credRows = await db.select().from(vendorCredentials)
  const credByVendor = new Map(credRows.map((r) => [r.vendor, r]))
  const now = Date.now()

  // 按 vendor 分组
  const byVendor = new Map<string, typeof orphanConfigs>()
  for (const cfg of orphanConfigs) {
    const vendor = extractVendor(cfg.providerKey)
    if (!vendor) continue
    const list = byVendor.get(vendor) ?? []
    list.push(cfg)
    byVendor.set(vendor, list)
  }

  for (const [vendor, cfgs] of byVendor) {
    const cred = credByVendor.get(vendor)
    if (!cred) continue

    // 如果凭证还没有 Key，从存量实例中找一个有 Key 的复制过来
    if (cred.apiKeyRef === 'local' || !resolveApiKey(cred.apiKeyRef)) {
      for (const cfg of cfgs) {
        const existingKey = resolveApiKey(cfg.apiKeyRef)
        if (existingKey) {
          const newRef = `local:vendor:${vendor}`
          writeSecret(newRef, existingKey)
          await db.update(vendorCredentials).set({ apiKeyRef: newRef, updatedAt: now }).where(eq(vendorCredentials.id, cred.id))
          break
        }
      }
    }

    // 将同 vendor 下所有孤立实例关联到凭证
    for (const cfg of cfgs) {
      // 例外：实例自带与厂商凭证不同的专用 Key（如火山语音 openspeech Key ≠ ark Key）→ 尊重其独立 Key，
      // 不并入共享厂商凭证（否则 credential 优先会静默覆盖实例 Key，导致 openspeech 收到 ark Key 报 401）。
      const credKey = resolveApiKey(cred.apiKeyRef)
      const ownKey = cfg.apiKeyRef && cfg.apiKeyRef !== cred.apiKeyRef ? resolveApiKey(cfg.apiKeyRef) : ''
      if (ownKey && credKey && ownKey !== credKey) continue
      await db.update(apiConfigs).set({ credentialId: cred.id, updatedAt: now }).where(eq(apiConfigs.id, cfg.id))
    }
  }
}

/** 旧阿里目录 key → 百炼统一 key（千问/万相家族行收敛；图像两行并一行） */
const ALIYUN_BAILIAN_KEY_MAP: Record<string, string> = {
  aliyun_qwen_llm: 'aliyun_bailian_llm',
  aliyun_wan_image: 'aliyun_bailian_image',
  aliyun_qwen_image: 'aliyun_bailian_image',
  aliyun_wan_video: 'aliyun_bailian_video',
  aliyun_qwen_tts: 'aliyun_bailian_tts',
}

/**
 * 幂等迁移：阿里千问/万相家族目录行收敛为阿里百炼统一行（需在 seedProviders 之前执行）。
 * 1) api_configs.provider_key 按映射改写；实例级密钥 ref（local:cfg:{service}:{providerKey}）
 *    随改名，secrets.json 键同步搬迁并删旧键；
 * 2) voice_clones.provider_key 同步改写；
 * 3) 删除 api_providers 旧行（新行由 seedProviders 补种）；
 * 4) 厂商凭证默认显示名「阿里千问」→「阿里百炼」（用户自改过的名字不动）。
 */
export async function migrateAliyunBailianRows(): Promise<void> {
  const now = Date.now()
  const configs = await db.select().from(apiConfigs)
  for (const cfg of configs) {
    const target = ALIYUN_BAILIAN_KEY_MAP[cfg.providerKey]
    if (!target) continue
    const patch: Record<string, unknown> = { providerKey: target, updatedAt: now }
    const oldRef = `local:cfg:${cfg.serviceType}:${cfg.providerKey}`
    if (cfg.apiKeyRef === oldRef) {
      const secret = resolveApiKey(oldRef)
      const newRef = `local:cfg:${cfg.serviceType}:${target}`
      if (secret) {
        writeSecret(newRef, secret)
        deleteSecret(oldRef)
        patch['apiKeyRef'] = newRef
      }
    }
    await db.update(apiConfigs).set(patch).where(eq(apiConfigs.id, cfg.id))
  }
  await db
    .update(voiceClones)
    .set({ providerKey: 'aliyun_bailian_tts', updatedAt: now })
    .where(eq(voiceClones.providerKey, 'aliyun_qwen_tts'))
  await db.delete(apiProviders).where(inArray(apiProviders.key, Object.keys(ALIYUN_BAILIAN_KEY_MAP)))
  await db
    .update(vendorCredentials)
    .set({ name: '阿里百炼', updatedAt: now })
    .where(and(eq(vendorCredentials.vendor, 'aliyun'), eq(vendorCredentials.name, '阿里千问')))
}

/** 从 providerKey 提取 vendor 前缀（aliyun_bailian_llm → aliyun） */
function extractVendor(providerKey: string): string | null {
  // 匹配已知 vendor 前缀
  for (const v of VENDOR_SEEDS) {
    if (providerKey.startsWith(v.vendor + '_') || providerKey === v.vendor) return v.vendor
  }
  // gemini_image 归属 google
  if (providerKey.startsWith('gemini_')) return 'google'
  return null
}

/**
 * 内置常用风格预设目录（M8 风格库）。
 * snippet 直接写**纯英文风格词块**（逗号分隔 tag）——这才是图像/视频生成模型的强触发词；
 * 不套「（画风：…）」展示壳（那是视觉提取产物的格式，对内置预设属冗余噪音），也不夹中文
 *（中文语义已由 name 与 description 承载）。description = 面向用户的中文适用场景说明。
 */
interface StylePresetSeed {
  name: string
  snippet: string
  description: string
}

export const STYLE_PRESET_SEEDS: StylePresetSeed[] = [
  { name: '写实摄影', snippet: 'cinematic photorealistic, 8k, ultra detailed, natural lighting, shallow depth of field, film grain, realistic skin texture', description: '电影感写实风格，适合真人质感口播、产品展示、纪实短视频' },
  { name: '日系动漫', snippet: 'japanese anime style, cel shading, clean lineart, vibrant colors, detailed background, studio quality', description: '赛璐璐二次元画风，适合剧情动画、二次元 IP、轻小说改编' },
  { name: '3D 卡通', snippet: 'pixar-style 3d animation, soft studio lighting, subsurface scattering, rounded characters, high detail octane render', description: '皮克斯风 3D 渲染，适合萌系 IP、儿童向、品牌吉祥物' },
  { name: '国风墨韵', snippet: 'traditional chinese ink painting, guofeng style, delicate brush strokes, misty mountains, elegant negative space, watercolor and ink', description: '水墨国风，适合古风剧情、诗词文化、传统题材' },
  { name: '吉卜力治愈', snippet: 'studio ghibli style, hand-drawn animation, warm pastel colors, soft lighting, peaceful whimsical mood, detailed lush nature', description: '吉卜力手绘风，适合治愈系故事、生活记录、自然题材' },
  { name: '赛博霓虹', snippet: 'cyberpunk style, neon lights, futuristic cityscape, high contrast, rain reflections, cinematic blue and magenta color grading', description: '赛博朋克霓虹，适合科技、潮流、未来感短片' },
  { name: '黏土定格', snippet: 'claymation stop-motion style, plasticine characters, soft studio lighting, handmade textures, tilt-shift, adorable', description: '黏土定格动画，适合趣味科普、萌宝 IP、手作质感' },
  { name: '水彩绘本', snippet: "children's picture book watercolor illustration, soft washes, gentle pastel palette, hand-painted texture, warm cozy", description: '水彩绘本插画，适合童话、亲子' },
]

/**
 * 幂等补种内置风格预设（仅按 name 补缺失行，不覆盖用户已改名/编辑的既有项）。
 * sortOrder 依目录顺序递增，保证内置项在列表靠前且稳定。
 */
export async function seedStylePresets(): Promise<void> {
  const now = Date.now()
  const rows = await db.select({ name: stylePresets.name }).from(stylePresets)
  const existing = new Set(rows.map((r) => r.name))
  let order = 1
  for (const p of STYLE_PRESET_SEEDS) {
    if (existing.has(p.name)) {
      order += 1
      continue
    }
    await db.insert(stylePresets).values({
      name: p.name,
      snippet: p.snippet,
      description: p.description,
      sortOrder: order,
      isActive: 1,
      createdAt: now,
      updatedAt: now,
    })
    order += 1
  }
}
