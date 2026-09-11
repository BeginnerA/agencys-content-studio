import { eq } from 'drizzle-orm'
import { db } from './index'
import { apiProviders } from './schema'

interface ProviderSeed {
  key: string
  name: string
  serviceType: string
  description: string
  defaultUrl?: string
  presetModels?: string
}

/**
 * 预置供应商目录（种子）。
 * 命名原则（M2.2 统一）：一行 = 厂商 × 能力；协议实现（OpenAI 兼容 / 私有协议）
 * 只在 description 里说明，不进入行名。同一厂商的每类能力各占一行
 * （如 siliconflow_* / pollinations_* / aliyun_* / volcengine_* 四类）。openai_* 行 = OpenAI 官方，
 * 亦承接任意 OpenAI 兼容的自定义网关；video 各家协议互不相通，天然一家一行。
 */
export const PROVIDER_SEEDS: ProviderSeed[] = [
  { key: 'deepseek_llm', name: 'DeepSeek（LLM）', serviceType: 'llm', description: 'OpenAI 兼容（官方端点内置，模型可在线获取）', defaultUrl: 'https://api.deepseek.com/v1', presetModels: JSON.stringify(['deepseek-chat', 'deepseek-reasoner']) },
  { key: 'openai_llm', name: 'OpenAI（LLM）', serviceType: 'llm', description: 'OpenAI 官方 / 任意 Chat Completions 兼容网关（模型在实例中配置）', defaultUrl: 'https://api.openai.com/v1' },
  { key: 'siliconflow_llm', name: 'SiliconFlow（LLM）', serviceType: 'llm', description: 'OpenAI Chat Completions 兼容（硅基流动，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['deepseek-ai/DeepSeek-V4-Flash']) },
  { key: 'pollinations_llm', name: 'Pollinations（LLM）', serviceType: 'llm', description: 'gen.pollinations.ai/v1 OpenAI 兼容（模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['openai/gpt-5.4-nano', 'openai/gpt-5.4-mini', 'qwen/qwen3.8-flash']) },
  { key: 'google_llm', name: 'Google（LLM）', serviceType: 'llm', description: 'Gemini 官方 OpenAI 兼容（v1beta/openai，模型可在线获取）', defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', presetModels: JSON.stringify(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']) },
  { key: 'aliyun_qwen_llm', name: '阿里云千问（LLM）', serviceType: 'llm', description: '千问官方 OpenAI 兼容（百炼 compatible-mode，模型可在线获取）', defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', presetModels: JSON.stringify(['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash']) },
  { key: 'volcengine_llm', name: '火山方舟（LLM）', serviceType: 'llm', description: '豆包 Seed 系列（Ark OpenAI 兼容 /api/v3，模型 ID 以方舟控制台开通的接入点为准）', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', presetModels: JSON.stringify(['doubao-seed-2-1-pro', 'doubao-seed-2-1-lite']) },
  { key: 'volcengine_image', name: '火山方舟文生图', serviceType: 'image', description: '豆包 Seedream 系列文生图（Ark，同步直返或任务轮询）', defaultUrl: 'https://ark.cn-beijing.volces.com', presetModels: JSON.stringify(['doubao-seedream-5-0-260128']) },
  { key: 'openai_image', name: 'OpenAI 文生图', serviceType: 'image', description: 'DALL·E / gpt-image 官方；/images/generations 兼容网关亦可指向' },
  { key: 'siliconflow_image', name: 'SiliconFlow 文生图', serviceType: 'image', description: 'OpenAI Images 兼容（含 images[] 镜像响应，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['Tongyi-MAI/Z-Image-Turbo']) },
  { key: 'gemini_image', name: 'Gemini 文生图', serviceType: 'image', description: 'Nano Banana（Gemini Image）系列文生图/改图（v1beta generateContent）', defaultUrl: 'https://generativelanguage.googleapis.com', presetModels: JSON.stringify(['gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image']) },
  { key: 'pollinations_image', name: 'Pollinations 文生图', serviceType: 'image', description: 'OpenAI Images 兼容（默认 b64_json，模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['tongyi-mai/z-image-turbo', 'black-forest-labs/flux.1-schnell', 'google/gemini-3.1-flash-image']) },
  { key: 'aliyun_wan_image', name: '阿里云万相文生图', serviceType: 'image', description: '万相 Wan3.0 文生图（百炼 DashScope 异步任务）', defaultUrl: 'https://dashscope.aliyuncs.com', presetModels: JSON.stringify(['wan3.0-image-prime', 'wan3.0-image']) },
  { key: 'volcengine_video', name: '火山方舟视频', serviceType: 'video', description: '豆包 Seedance 2.0 系列视频生成', defaultUrl: 'https://ark.cn-beijing.volces.com', presetModels: JSON.stringify(['doubao-seedance-2-0-mini-260615']) },
  { key: 'minimax_video', name: 'MiniMax 视频', serviceType: 'video', description: 'MiniMax H3 系列视频生成', defaultUrl: 'https://api.minimax.chat', presetModels: JSON.stringify(['MiniMax-H3']) },
  { key: 'aliyun_wan_video', name: '阿里云万相视频', serviceType: 'video', description: '万相 Wan3.0 视频生成（百炼 DashScope）', defaultUrl: 'https://dashscope.aliyuncs.com', presetModels: JSON.stringify(['wan3.0-video-prime', 'wan3.0-video']) },
  { key: 'siliconflow_video', name: 'SiliconFlow 视频', serviceType: 'video', description: 'Wan2.2 系列视频生成（submit/status 轮询，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['Wan-AI/Wan2.2-T2V-A14B', 'Wan-AI/Wan2.2-I2V-A14B']) },
  { key: 'pollinations_video', name: 'Pollinations 视频', serviceType: 'video', description: 'veo/seedance/wan 系列（GET 同步长请求，无轮询，模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai', presetModels: JSON.stringify(['google/veo-3.1-fast', 'bytedance/seedance-2.0-fast', 'alibaba/wan-2.2-fast']) },
  { key: 'openai_audio', name: 'OpenAI 语音', serviceType: 'audio', description: 'OpenAI 官方 / 任意 /audio/speech 兼容网关（模型在实例中配置）', defaultUrl: 'https://api.openai.com/v1' },
  { key: 'siliconflow_audio', name: 'SiliconFlow 语音', serviceType: 'audio', description: 'OpenAI /audio/speech 兼容 TTS（硅基流动，模型在实例中配置）', defaultUrl: 'https://api.siliconflow.cn/v1', presetModels: JSON.stringify(['FunAudioLLM/CosyVoice2-0.5B']) },
  { key: 'pollinations_audio', name: 'Pollinations 语音', serviceType: 'audio', description: 'OpenAI /audio/speech 兼容 TTS（ElevenLabs/Qwen 等，模型在实例中配置）', defaultUrl: 'https://gen.pollinations.ai/v1', presetModels: JSON.stringify(['elevenlabs/eleven-flash-v2.5', 'qwen/qwen3-tts-flash', 'hexgrad/kokoro-82m']) },
  { key: 'aliyun_qwen_tts', name: '阿里云千问语音', serviceType: 'audio', description: '千问 qwen-tts 语音合成（百炼 DashScope，音色如 Cherry / Serena / Ethan）', defaultUrl: 'https://dashscope.aliyuncs.com', presetModels: JSON.stringify(['qwen-tts']) },
  { key: 'volcengine_audio', name: '火山方舟语音', serviceType: 'audio', description: '火山语音合成 TTS V1（音色如 BV700_streaming；需在实例扩展参数配置 appid）', defaultUrl: 'https://openspeech.bytedance.com' },
]

/**
 * 幂等补种（M2 起为「缺失补插 + 目录信息回填」，老库增量生效）：
 * - key 不存在 → 插入；
 * - 存在但 defaultUrl/presetModels 为空且种子提供 → 回填（不动用户已填内容）；
 * - description 与种子不一致 → 更新（目录文案随代码演进；目录行无用户编辑入口）。
 */
export async function seedProviders(): Promise<void> {
  const now = Date.now()
  const rows = await db.select().from(apiProviders)
  const byKey = new Map(rows.map((r) => [r.key, r]))
  for (const p of PROVIDER_SEEDS) {
    const exist = byKey.get(p.key)
    if (!exist) {
      await db.insert(apiProviders).values({ ...p, createdAt: now, updatedAt: now })
      continue
    }
    const patch: Record<string, unknown> = {}
    if (!exist.defaultUrl && p.defaultUrl) patch['defaultUrl'] = p.defaultUrl
    if (!exist.presetModels && p.presetModels) patch['presetModels'] = p.presetModels
    if (exist.description !== p.description) patch['description'] = p.description
    if (Object.keys(patch).length > 0) {
      await db.update(apiProviders).set({ ...patch, updatedAt: now }).where(eq(apiProviders.key, p.key))
    }
  }
}
