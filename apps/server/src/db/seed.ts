import { eq, isNull } from 'drizzle-orm'
import { db } from './index'
import { apiConfigs, apiProviders, vendorCredentials } from './schema'
import { resolveApiKey, writeSecret } from '../services/secrets'

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

export const VENDOR_SEEDS: VendorSeed[] = [
  { vendor: 'aliyun', name: '阿里千问' },
  { vendor: 'deepseek', name: 'DeepSeek' },
  { vendor: 'openai', name: 'OpenAI' },
  { vendor: 'siliconflow', name: 'SiliconFlow' },
  { vendor: 'google', name: 'Google' },
  { vendor: 'volcengine', name: '火山方舟' },
  { vendor: 'minimax', name: 'MiniMax' },
  { vendor: 'pollinations', name: 'Pollinations' },
]

/**
 * 预置供应商目录（种子）。
 * 命名原则（M2.2 统一）：一行 = 厂商 × 能力；协议实现（OpenAI 兼容 / 私有协议）
 * 只在 description 里说明，不进入行名。同一厂商的每类能力各占一行
 * （如 siliconflow_* / pollinations_* / aliyun_* / volcengine_* 四类）。openai_* 行 = OpenAI 官方，
 * 亦承接任意 OpenAI 兼容的自定义网关；video 各家协议互不相通，天然一家一行。
 * vendor 字段将多行归组到同一厂商凭证（用户只配一次 Key）。
 */
export const PROVIDER_SEEDS: ProviderSeed[] = [
  { key: 'deepseek_llm', name: 'DeepSeek（LLM）', serviceType: 'llm', vendor: 'deepseek', description: 'OpenAI 兼容（官方端点内置，模型可在线获取）', defaultUrl: 'https://api.deepseek.com/v1', presetModels: JSON.stringify(['deepseek-flash', 'deepseek-v4-pro']), overwritePresetModels: true },
  { key: 'openai_llm', name: 'OpenAI（LLM）', serviceType: 'llm', vendor: 'openai', description: 'OpenAI 官方 / 任意 Chat Completions 兼容网关（模型在实例中配置）', defaultUrl: 'https://api.openai.com/v1' },
  { key: 'siliconflow_llm', name: 'SiliconFlow（LLM）', serviceType: 'llm', vendor: 'siliconflow', description: 'OpenAI Chat Completions 兼容（硅基流动，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['deepseek-ai/DeepSeek-V4-Flash']) },
  { key: 'pollinations_llm', name: 'Pollinations（LLM）', serviceType: 'llm', vendor: 'pollinations', description: 'gen.pollinations.ai/v1 OpenAI 兼容（模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['openai/gpt-5.4-nano', 'openai/gpt-5.4-mini', 'qwen/qwen3.8-flash']) },
  { key: 'google_llm', name: 'Google（LLM）', serviceType: 'llm', vendor: 'google', description: 'Gemini 官方 OpenAI 兼容（v1beta/openai，模型可在线获取）', defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', presetModels: JSON.stringify(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']) },
  { key: 'aliyun_qwen_llm', name: '阿里千问（LLM）', serviceType: 'llm', vendor: 'aliyun', description: '千问官方 OpenAI 兼容（compatible-mode，模型可在线获取）', defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', presetModels: JSON.stringify(['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash']) },
  { key: 'volcengine_llm', name: '火山方舟（LLM）', serviceType: 'llm', vendor: 'volcengine', description: '豆包 Seed 系列（Ark OpenAI 兼容 /api/v3；模型 ID 需带版本号并在方舟控制台开通）', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', presetModels: JSON.stringify(['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628']), overwritePresetModels: true },
  { key: 'volcengine_image', name: '火山方舟文生图', serviceType: 'image', vendor: 'volcengine', description: '豆包 Seedream 系列文生图（Ark，同步直返或任务轮询）', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', presetModels: JSON.stringify(['doubao-seedream-5-0-260128']) },
  { key: 'openai_image', name: 'OpenAI 文生图', serviceType: 'image', vendor: 'openai', description: 'DALL·E / gpt-image 官方；/images/generations 兼容网关亦可指向' },
  { key: 'siliconflow_image', name: 'SiliconFlow 文生图', serviceType: 'image', vendor: 'siliconflow', description: 'OpenAI Images 兼容（含 images[] 镜像响应，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['Tongyi-MAI/Z-Image-Turbo']) },
  { key: 'gemini_image', name: 'Gemini 文生图', serviceType: 'image', vendor: 'google', description: 'Nano Banana（Gemini Image）系列文生图/改图（原生 v1beta generateContent 协议；base_url 填根域名或中转站原生镜像）', defaultUrl: 'https://generativelanguage.googleapis.com', presetModels: JSON.stringify(['gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image']), overwriteDefaultUrl: true },
  { key: 'pollinations_image', name: 'Pollinations 文生图', serviceType: 'image', vendor: 'pollinations', description: 'OpenAI Images 兼容（默认 b64_json，模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['tongyi-mai/z-image-turbo', 'black-forest-labs/flux.1-schnell', 'google/gemini-3.1-flash-image']) },
  { key: 'aliyun_wan_image', name: '阿里千问万相文生图', serviceType: 'image', vendor: 'aliyun', description: '万相文生图（DashScope；wan2.7 同步直返，2.6 及以下异步任务轮询）', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['wan2.7-image', 'wan2.7-image-pro', 'wan2.6-t2i', 'wan2.5-t2i-preview', 'wan2.2-t2i-flash', 'wan2.2-t2i-plus']), overwritePresetModels: true },
  { key: 'aliyun_qwen_image', name: '阿里千问图像', serviceType: 'image', vendor: 'aliyun', description: '千问图像 Qwen-Image（DashScope 同步直返；3.0/2.0 支持 512²~2048² 自定义尺寸，max/plus 用官方默认）', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-2.0-pro', 'qwen-image-max', 'qwen-image-plus']), overwritePresetModels: true },
  { key: 'volcengine_video', name: '火山方舟视频', serviceType: 'video', vendor: 'volcengine', description: '豆包 Seedance 2.x 系列视频生成（模型需在方舟控制台开通）', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', presetModels: JSON.stringify(['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128']), overwritePresetModels: true },
  { key: 'minimax_video', name: 'MiniMax 视频', serviceType: 'video', vendor: 'minimax', description: 'MiniMax H3 系列视频生成', defaultUrl: 'https://api.minimax.chat/v2', presetModels: JSON.stringify(['MiniMax-H3']) },
  { key: 'aliyun_wan_video', name: '阿里千问万相视频', serviceType: 'video', vendor: 'aliyun', description: '万相 Wan3.0 视频生成（DashScope）', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['wan3.0-video-prime', 'wan3.0-video']) },
  { key: 'siliconflow_video', name: 'SiliconFlow 视频', serviceType: 'video', vendor: 'siliconflow', description: 'Wan2.2 系列视频生成（submit/status 轮询，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['Wan-AI/Wan2.2-T2V-A14B', 'Wan-AI/Wan2.2-I2V-A14B']) },
  { key: 'pollinations_video', name: 'Pollinations 视频', serviceType: 'video', vendor: 'pollinations', description: 'veo/seedance/wan 系列（GET 同步长请求，无轮询，模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['google/veo-3.1-fast', 'bytedance/seedance-2.0-fast', 'alibaba/wan-2.2-fast']) },
  { key: 'openai_audio', name: 'OpenAI 语音', serviceType: 'audio', vendor: 'openai', description: 'OpenAI 官方 / 任意 /audio/speech 兼容网关（模型在实例中配置）', defaultUrl: 'https://api.openai.com/v1' },
  { key: 'siliconflow_audio', name: 'SiliconFlow 语音', serviceType: 'audio', vendor: 'siliconflow', description: 'OpenAI /audio/speech 兼容 TTS（硅基流动，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['FunAudioLLM/CosyVoice2-0.5B']) },
  { key: 'pollinations_audio', name: 'Pollinations 语音', serviceType: 'audio', vendor: 'pollinations', description: 'OpenAI /audio/speech 兼容 TTS（ElevenLabs/Qwen 等，模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['elevenlabs/eleven-flash-v2.5', 'qwen/qwen3-tts-flash', 'hexgrad/kokoro-82m']) },
  { key: 'aliyun_qwen_tts', name: '阿里千问语音', serviceType: 'audio', vendor: 'aliyun', description: '千问 qwen-tts 语音合成（DashScope，音色如 Cherry / Serena / Ethan）', defaultUrl: 'https://dashscope.aliyuncs.com/api/v1', presetModels: JSON.stringify(['qwen-tts']) },
  { key: 'volcengine_audio', name: '火山方舟语音', serviceType: 'audio', vendor: 'volcengine', description: '火山语音合成 TTS V1（音色如 BV700_streaming；需在实例扩展参数配置 appid）', defaultUrl: 'https://openspeech.bytedance.com/api/v3' },
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
      await db.update(apiConfigs).set({ credentialId: cred.id, updatedAt: now }).where(eq(apiConfigs.id, cfg.id))
    }
  }
}

/** 从 providerKey 提取 vendor 前缀（aliyun_qwen_llm → aliyun） */
function extractVendor(providerKey: string): string | null {
  // 匹配已知 vendor 前缀
  for (const v of VENDOR_SEEDS) {
    if (providerKey.startsWith(v.vendor + '_') || providerKey === v.vendor) return v.vendor
  }
  // gemini_image 归属 google
  if (providerKey.startsWith('gemini_')) return 'google'
  return null
}
