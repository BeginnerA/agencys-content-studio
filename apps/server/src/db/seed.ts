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
 * M2：video 行补 defaultUrl/presetModels；audio 增 openai_audio（OpenAI 兼容 TTS 目录，
 * 任意兼容网关可指，模型经 config.model 指定如 CosyVoice2-0.5B）。
 */
export const PROVIDER_SEEDS: ProviderSeed[] = [
  { key: 'deepseek_llm', name: 'DeepSeek（LLM）', serviceType: 'llm', description: 'OpenAI 兼容网关，env 默认 AGENT_LLM_*' },
  { key: 'openai_llm', name: 'OpenAI（LLM）', serviceType: 'llm', description: 'OpenAI Chat Completions 兼容' },
  { key: 'volcengine_image', name: '火山方舟文生图', serviceType: 'image', description: '豆包/Seedream 系列文生图' },
  { key: 'openai_image', name: 'OpenAI 文生图', serviceType: 'image', description: 'DALL·E / gpt-image 系列' },
  { key: 'gemini_image', name: 'Gemini 文生图', serviceType: 'image', description: 'Gemini Imagen 系列' },
  { key: 'volcengine_video', name: '火山方舟视频', serviceType: 'video', description: '豆包 Seedance 2.0 系列视频生成', defaultUrl: 'https://ark.cn-beijing.volces.com', presetModels: JSON.stringify(['doubao-seedance-2-0-mini-260615']) },
  { key: 'minimax_video', name: 'MiniMax 视频', serviceType: 'video', description: 'MiniMax H3 系列视频生成', defaultUrl: 'https://api.minimax.chat', presetModels: JSON.stringify(['MiniMax-H3']) },
  { key: 'aliyun_wan_video', name: '阿里云万相视频', serviceType: 'video', description: '万相 Wan3.0 视频生成（百炼 DashScope）', defaultUrl: 'https://dashscope.aliyuncs.com', presetModels: JSON.stringify(['wan3.0-video-prime', 'wan3.0-video']) },
  { key: 'openai_audio', name: 'OpenAI 兼容 TTS', serviceType: 'audio', description: 'OpenAI /audio/speech 兼容语音合成（任意兼容网关可指，模型在实例中配置）', defaultUrl: 'https://api.openai.com/v1' },
]

/**
 * 幂等补种（M2 起为「缺失补插 + 目录信息回填」，老库增量生效）：
 * - key 不存在 → 插入；
 * - 存在但 defaultUrl/presetModels 为空且种子提供 → 回填（不动用户已填内容）。
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
    if (Object.keys(patch).length > 0) {
      await db.update(apiProviders).set({ ...patch, updatedAt: now }).where(eq(apiProviders.key, p.key))
    }
  }
}
