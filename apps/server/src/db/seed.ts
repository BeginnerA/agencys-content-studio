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
 * 命名原则（统一）：一行 = 厂商 × 能力；协议实现（OpenAI 兼容 / 私有协议）
 * 只在 description 里说明，不进入行名。openai_* 行 = OpenAI 协议族统一入口，
 * 官方与任意 OpenAI 兼容网关（SiliconFlow / Pollinations / OpenRouter 等）一律经
 * openai_* 行接入（网关只是实例 baseUrl 取不同值，不是供应商）；因此网关的
 * OpenAI 兼容能力不设独立目录行，仅**私有协议能力**保留网关行（siliconflow_video /
 * pollinations_video / pollinations_music——各家视频/音乐接口互不相通，无法共用适配器）。
 * video 各家协议互不相通，天然一家一行。
 * 阿里 aliyun_* 行共享阿里百炼平台凭证（DashScope），不再按模型家族（千问/万相）拆行：
 * 一行 = 一类能力，家族差异下沉到模型选择（图像行适配器按 model 前缀派发两族协议）。
 * vendor 字段将多行归组到同一厂商凭证（用户只配一次 Key）。
 */
export const PROVIDER_SEEDS: ProviderSeed[] = [
  { key: 'deepseek_llm', name: 'DeepSeek（LLM）', serviceType: 'llm', vendor: 'deepseek', description: 'OpenAI 兼容（官方端点内置，模型可在线获取）', defaultUrl: 'https://api.deepseek.com/v1', presetModels: JSON.stringify(['deepseek-flash', 'deepseek-v4-pro']), overwritePresetModels: true },
  { key: 'openai_llm', name: 'OpenAI（LLM）', serviceType: 'llm', vendor: 'openai', description: 'OpenAI 官方 / 任意 Chat Completions 兼容网关（如 SiliconFlow https://api.siliconflow.cn/v1 、Pollinations https://gen.pollinations.ai/v1 、OpenRouter https://openrouter.ai/api/v1；实例填网关地址即可，模型在实例中配置）', defaultUrl: 'https://api.openai.com/v1' },
  { key: 'google_llm', name: 'Google（LLM）', serviceType: 'llm', vendor: 'google', description: 'Gemini 官方 OpenAI 兼容（v1beta/openai，模型可在线获取）', defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', presetModels: JSON.stringify(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']) },
  { key: 'aliyun_bailian_llm', name: '阿里百炼（LLM）', serviceType: 'llm', vendor: 'aliyun', description: '阿里百炼文本模型（Qwen 等），支持在线拉取模型。公共域 2026-09-30 起不再更新，建议改用业务空间专属域', defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', presetModels: JSON.stringify(['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash']) },
  { key: 'volcengine_llm', name: '火山方舟（LLM）', serviceType: 'llm', vendor: 'volcengine', description: '豆包 Seed 系列文本模型。模型 ID 需带版本号，并先在方舟控制台开通', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', presetModels: JSON.stringify(['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628']), overwritePresetModels: true },
  { key: 'minimax_llm', name: 'MiniMax（LLM）', serviceType: 'llm', vendor: 'minimax', description: 'MiniMax M 系列文本模型（OpenAI 兼容 https://api.minimax.cn/v1；支持在线列模型 List Models）', defaultUrl: 'https://api.minimax.cn/v1', presetModels: JSON.stringify(['MiniMax-M3', 'MiniMax-M2.5']), overwritePresetModels: true },
  { key: 'ollama_llm', name: 'Ollama（LLM）', serviceType: 'llm', vendor: 'ollama', description: '本地 Ollama 服务，支持在线拉取模型。无需 API Key（密钥留空或随便填即可）', defaultUrl: 'http://localhost:11434/v1', presetModels: JSON.stringify(['qwen2.5', 'llama3.1']) },
  { key: 'volcengine_image', name: '火山方舟图像', serviceType: 'image', vendor: 'volcengine', description: '豆包 Seedream 系列文生图', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', presetModels: JSON.stringify(['doubao-seedream-5-0-260128']) },
  { key: 'minimax_image', name: 'MiniMax 图像', serviceType: 'image', vendor: 'minimax', description: 'MiniMax image-01 文生图 / 图生图。参考图需公网可访问 URL；尺寸 512–2048 且为 8 的倍数', defaultUrl: 'https://api.minimax.cn', presetModels: JSON.stringify(['image-01', 'image-01-live']), overwritePresetModels: true },
    { key: 'kling_image', name: '可灵图像', serviceType: 'image', vendor: 'kling', description: '可灵（快手）文生图 / 图生图。API Key 直接填控制台「新建 API Key」复制的密钥（也兼容旧的 AccessKey:SecretKey）', defaultUrl: 'https://api-beijing.klingai.com', presetModels: JSON.stringify(['kling-v3', 'kling-v2-1']), overwritePresetModels: true },
  { key: 'openai_image', name: 'OpenAI 图像', serviceType: 'image', vendor: 'openai', description: 'OpenAI 官方 gpt-image-1 文生图 + 图生图/编辑（参考图与 mask 局部重绘，不支持扩图）；亦承接任意 OpenAI Images 兼容网关（如 SiliconFlow / Pollinations，实例地址为准）', defaultUrl: 'https://api.openai.com/v1', presetModels: JSON.stringify(['gpt-image-1', 'gpt-image-1-mini']), overwritePresetModels: true },
  { key: 'gemini_image', name: 'Gemini 图像', serviceType: 'image', vendor: 'google', description: 'Nano Banana（Gemini 图像）文生图 / 改图。base_url 填根域名（或中转站原生镜像地址）', defaultUrl: 'https://generativelanguage.googleapis.com', presetModels: JSON.stringify(['gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image']), overwriteDefaultUrl: true },
  { key: 'aliyun_bailian_image', name: '阿里百炼图像', serviceType: 'image', vendor: 'aliyun', description: '百炼文生图与图像编辑。涂抹重绘 / 扩图需用 wan 系列模型；可灵/Vidu 等第三方托管模型须用业务空间专属域 Base URL', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['wan2.7-image', 'wan2.7-image-pro', 'wan2.6-t2i', 'wan2.5-t2i-preview', 'wan2.2-t2i-flash', 'wan2.2-t2i-plus', 'qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-2.0-pro', 'qwen-image-max', 'qwen-image-plus']), overwritePresetModels: true },
  { key: 'volcengine_video', name: '火山方舟视频', serviceType: 'video', vendor: 'volcengine', description: '豆包 Seedance 2.x 系列视频生成（模型需在方舟控制台开通）', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', presetModels: JSON.stringify(['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128']), overwritePresetModels: true },
  { key: 'minimax_video', name: 'MiniMax 视频', serviceType: 'video', vendor: 'minimax', description: 'MiniMax H3 系列视频生成（H3：768P/2K、4–15s；H3-Max：480P/768P、5–15s）', defaultUrl: 'https://api.minimax.cn', presetModels: JSON.stringify(['MiniMax-H3', 'MiniMax-H3-Max']), overwritePresetModels: true },
    { key: 'kling_video', name: '可灵视频', serviceType: 'video', vendor: 'kling', description: '可灵（快手）视频生成。API Key 直接填控制台「新建 API Key」复制的密钥（也兼容旧的 AccessKey:SecretKey）；国际站把 baseUrl 改为 https://api-singapore.klingai.com', defaultUrl: 'https://api-beijing.klingai.com', presetModels: JSON.stringify(['kling-3.0-turbo', 'kling-3.0', 'kling-3.0-omni', 'kling-2.6', 'kling-2.5-turbo', 'kling-o1']), overwritePresetModels: true },
  { key: 'aliyun_bailian_video', name: '阿里百炼视频', serviceType: 'video', vendor: 'aliyun', description: '百炼视频生成（wan / 可灵 / Vidu 等）。第三方托管模型须用业务空间专属域 Base URL', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['wan3.0-video-prime', 'wan3.0-video']) },
  { key: 'siliconflow_video', name: 'SiliconFlow 视频', serviceType: 'video', vendor: 'siliconflow', description: 'Wan2.2 系列视频生成（模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['Wan-AI/Wan2.2-T2V-A14B', 'Wan-AI/Wan2.2-I2V-A14B']) },
  { key: 'pollinations_video', name: 'Pollinations 视频', serviceType: 'video', vendor: 'pollinations', description: 'veo / seedance / wan 系列视频生成（模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['google/veo-3.1-fast', 'bytedance/seedance-2.0-fast', 'alibaba/wan-2.2-fast']) },
  { key: 'openai_video', name: 'OpenAI 视频', serviceType: 'video', vendor: 'openai', description: '⚠ Sora 视频生成：官方 API 已于 2026-09-24 下线且无替代，此路径会一直失败，建议停用该实例', defaultUrl: 'https://api.openai.com/v1', presetModels: JSON.stringify(['sora-2', 'sora-2-pro']), overwritePresetModels: true },
  { key: 'google_video', name: 'Google 视频', serviceType: 'video', vendor: 'google', description: 'Veo 视频生成（文生视频 / 图生视频）', defaultUrl: 'https://generativelanguage.googleapis.com', presetModels: JSON.stringify(['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview']), overwritePresetModels: true },
  { key: 'openai_audio', name: 'OpenAI 语音', serviceType: 'audio', vendor: 'openai', description: 'OpenAI 官方 / 任意 /audio/speech 兼容网关（如 SiliconFlow https://api.siliconflow.cn/v1 、Pollinations https://gen.pollinations.ai/v1；模型在实例中配置）', defaultUrl: 'https://api.openai.com/v1' },
  { key: 'aliyun_bailian_tts', name: '阿里百炼语音', serviceType: 'audio', vendor: 'aliyun', description: '百炼 qwen-tts 语音合成（DashScope，音色如 Cherry / Serena / Ethan；公共域 2026-09-30 起维护，建议改用业务空间专属域）', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['qwen-tts']) },
  { key: 'volcengine_audio', name: '火山方舟语音', serviceType: 'audio', vendor: 'volcengine', description: '豆包语音合成。Key 要用豆包「语音控制台」的专用 Key（不是方舟模型 Key）。默认 seed-audio-1.0 填文本即可出音；要精确音色选 seed-tts（需另开通）', defaultUrl: 'https://openspeech.bytedance.com', presetModels: JSON.stringify(['seed-audio-1.0', 'seed-tts']), overwritePresetModels: true },
  { key: 'minimax_audio', name: 'MiniMax 语音', serviceType: 'audio', vendor: 'minimax', description: 'MiniMax 语音合成 T2A。音色在实例扩展参数里选择', defaultUrl: 'https://api.minimax.cn', presetModels: JSON.stringify(['speech-2.8-hd', 'speech-2.8-turbo']), overwritePresetModels: true },
  { key: 'google_audio', name: 'Google 语音', serviceType: 'audio', vendor: 'google', description: 'Gemini 原生语音合成（TTS）。音色在实例扩展参数里选择', defaultUrl: 'https://generativelanguage.googleapis.com', presetModels: JSON.stringify(['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts', 'gemini-3.1-flash-tts-preview']), overwritePresetModels: true },
  { key: 'minimax_music', name: 'MiniMax 音乐', serviceType: 'music', vendor: 'minimax', description: 'MiniMax 音乐生成（BGM/纯音乐）。⚠️ 2026-08-20 起付费音乐接口不再面向新用户；未配置时混剪模板自动降级库内选曲', defaultUrl: 'https://api.minimax.cn', presetModels: JSON.stringify(['music-3.0', 'music-2.6']), overwritePresetModels: true },
  { key: 'aliyun_bailian_music', name: '阿里百炼音乐', serviceType: 'music', vendor: 'aliyun', description: '百炼 Fun-Music 音乐生成（纯音乐/歌曲，48kHz）。⚠️ 邀测模型需先在模型广场申请开通，仅华北2（北京）地域；复用百炼 API Key；未配置时降级库内选曲', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['fun-music-v1', 'fun-music-preview']), overwritePresetModels: true },
  { key: 'volcengine_music', name: '火山音乐', serviceType: 'music', vendor: 'volcengine', description: '火山引擎音视频理解·音乐生成（纯音乐 GenBGM/人声歌曲，v5.0）。⚠️ 密钥填火山账号「AK/SK」拼接串（不是方舟 Key），需先开通该产品；未配置时降级库内选曲', defaultUrl: 'https://open.volcengineapi.com', presetModels: JSON.stringify(['v5.0', 'v4.3', 'v4.0']), overwritePresetModels: true },
  { key: 'pollinations_music', name: 'Pollinations 音乐', serviceType: 'music', vendor: 'pollinations', description: 'ElevenLabs Music / Lyria / Stable Audio 音乐生成（网关直返 mp3）。⚠️ 全部 Pollen 计费（无免费款）；时长控制：elevenlabs/music-* 支持 3-300 秒，stable-audio 支持 1-380 秒，lyria 时长写进提示词；未配置时降级库内选曲', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['elevenlabs/music-v2.5', 'elevenlabs/music-v2', 'stability-ai/stable-audio-3-medium', 'stability-ai/stable-audio-3', 'google/lyria-3.5', 'google/lyria-3-clip-preview']), overwritePresetModels: true },
]

/**
 * 幂等补种（自本特性起为「缺失补插 + 目录信息回填」，老库增量生效）：
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

/**
 * 网关旧目录 key → OpenAI 协议统一 key（网关不是供应商：OpenAI 兼容能力一律经 openai_* 行接入；
 * 其视频/音乐为私有协议，保留网关行不动）。
 */
const GATEWAY_OPENAI_KEY_MAP: Record<string, string> = {
  siliconflow_llm: 'openai_llm',
  pollinations_llm: 'openai_llm',
  siliconflow_image: 'openai_image',
  pollinations_image: 'openai_image',
  siliconflow_audio: 'openai_audio',
  pollinations_audio: 'openai_audio',
}

/** 旧网关 key 的目录默认地址（迁移时实例 baseUrl 为空必须补上：openai_* 行默认地址是官方端点，不能承接） */
function gatewayOldDefaultUrl(providerKey: string): string {
  return providerKey.startsWith('siliconflow') ? 'https://api.siliconflow.cn/v1' : 'https://gen.pollinations.ai/v1'
}

/**
 * 幂等迁移：网关 OpenAI 兼容目录行收编进 openai_* 协议行（需在 seedProviders 之前执行）。
 * 1) api_configs.provider_key 按映射改写；实例级密钥 ref 随改名，secrets.json 键同步搬迁并删旧键；
 * 2) baseUrl 为空的实例补写网关地址（原目录行 defaultUrl 语义随迁）；
 * 3) 未接凭证的实例显式挂回原网关厂商凭证（防后续归集误入 openai 官方凭证；
 *    siliconflow/pollinations 凭证因视频/音乐行仍在目录，继续共享同一把网关 Key 语义正确）；
 * 4) voice_clones.provider_key 同步改写；旧目录行删除（openai_* 行由种子体系维护）。
 */
export async function migrateGatewayRowsToOpenAI(): Promise<void> {
  const now = Date.now()
  const configs = await db.select().from(apiConfigs)
  const credRows = await db.select().from(vendorCredentials)
  const credByVendor = new Map(credRows.map((r) => [r.vendor, r]))
  for (const cfg of configs) {
    const target = GATEWAY_OPENAI_KEY_MAP[cfg.providerKey]
    if (!target) continue
    const patch: Record<string, unknown> = { providerKey: target, updatedAt: now }
    if (!cfg.baseUrl?.trim()) patch['baseUrl'] = gatewayOldDefaultUrl(cfg.providerKey)
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
    if (cfg.credentialId == null) {
      const gwVendor = extractVendor(cfg.providerKey)
      const gwCred = gwVendor ? credByVendor.get(gwVendor) : undefined
      if (gwCred) patch['credentialId'] = gwCred.id
    }
    await db.update(apiConfigs).set(patch).where(eq(apiConfigs.id, cfg.id))
  }
  await db
    .update(voiceClones)
    .set({ providerKey: 'openai_audio', updatedAt: now })
    .where(inArray(voiceClones.providerKey, ['siliconflow_audio', 'pollinations_audio']))
  await db.delete(apiProviders).where(inArray(apiProviders.key, Object.keys(GATEWAY_OPENAI_KEY_MAP)))
}

/** 已退役厂商标识（网关收编后不再作为凭证厂商存在；代码侧 VENDOR_SEEDS 已无对应行） */
const RETIRED_VENDORS: string[] = ['openrouter']

/**
 * 幂等清理：删除退役网关的残留厂商凭证（seedVendorCredentials 只插不删，旧库残留需启动期回收）。
 * 仅当该凭证无任何实例引用时才删（有引用 = 用户仍在用，不破坏执行链）；secrets.json 的
 * local:vendor:{vendor} 键同步搬迁删除。
 */
export async function cleanupRetiredVendorCredentials(): Promise<void> {
  const credRows = await db.select().from(vendorCredentials)
  const retired = credRows.filter((r) => RETIRED_VENDORS.includes(r.vendor))
  if (retired.length === 0) return
  for (const cred of retired) {
    const refs = await db
      .select({ id: apiConfigs.id })
      .from(apiConfigs)
      .where(eq(apiConfigs.credentialId, cred.id))
      .limit(1)
    if (refs.length > 0) continue
    await db.delete(vendorCredentials).where(eq(vendorCredentials.id, cred.id))
    if (cred.apiKeyRef === `local:vendor:${cred.vendor}`) deleteSecret(cred.apiKeyRef)
  }
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
 * 内置常用风格预设目录（风格库）。
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
