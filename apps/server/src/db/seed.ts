import { count } from 'drizzle-orm'
import { db } from './index'
import { apiProviders } from './schema'

/**
 * 预置供应商目录（种子）。
 * 注意：defaultUrl/presetModels 待 M1 适配器搬运轮按 huobao 实际端点补齐，
 * 当前仅登记目录与类型，保证 Settings 页骨架可用。
 */
export const PROVIDER_SEEDS = [
  { key: 'deepseek_llm', name: 'DeepSeek（LLM）', serviceType: 'llm', description: 'OpenAI 兼容网关，env 默认 AGENT_LLM_*' },
  { key: 'openai_llm', name: 'OpenAI（LLM）', serviceType: 'llm', description: 'OpenAI Chat Completions 兼容' },
  { key: 'volcengine_image', name: '火山方舟文生图', serviceType: 'image', description: '豆包/Seedream 系列文生图' },
  { key: 'openai_image', name: 'OpenAI 文生图', serviceType: 'image', description: 'DALL·E / gpt-image 系列' },
  { key: 'gemini_image', name: 'Gemini 文生图', serviceType: 'image', description: 'Gemini Imagen 系列' },
  { key: 'volcengine_video', name: '火山方舟视频', serviceType: 'video', description: '豆包视频生成（M2 启用）' },
  { key: 'minimax_video', name: 'MiniMax 视频', serviceType: 'video', description: 'MiniMax 视频生成（M2 启用）' },
  { key: 'aliyun_wan_video', name: '阿里云万相视频', serviceType: 'video', description: '万相 2.1 视频生成（M2 启用）' },
] as const

/** 幂等写入：目录为空时播种 */
export async function seedProviders(): Promise<void> {
  const rows = await db.select({ n: count() }).from(apiProviders)
  if ((rows[0]?.n ?? 0) > 0) return
  const now = Date.now()
  for (const p of PROVIDER_SEEDS) {
    await db.insert(apiProviders).values({ ...p, createdAt: now, updatedAt: now })
  }
}
