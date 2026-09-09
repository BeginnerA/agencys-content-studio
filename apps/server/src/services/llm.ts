import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asc, desc, eq, and } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs } from '../db/schema'
import { env, PROMPTS_DIR } from '../env'
import { createLogger } from '../logger'
import { resolveApiKey } from './secrets'

const log = createLogger('llm')

export interface LlmEndpoint {
  baseUrl: string
  apiKey: string
  model: string
}

/** 解析 llm 端点：api_configs（is_default 优先）→ env 兜底 */
export async function resolveLlmEndpoint(): Promise<LlmEndpoint> {
  const rows = await db
    .select()
    .from(apiConfigs)
    .where(and(eq(apiConfigs.serviceType, 'llm'), eq(apiConfigs.isActive, 1)))
    .orderBy(desc(apiConfigs.isDefault), asc(apiConfigs.priority))
    .limit(1)
  const cfg = rows[0]
  if (cfg) {
    const apiKey = resolveApiKey(cfg.apiKeyRef)
    return { baseUrl: (cfg.baseUrl ?? '').replace(/\/+$/, ''), apiKey, model: cfg.model ?? env.llm.model }
  }
  return {
    baseUrl: env.llm.baseUrl.replace(/\/+$/, ''),
    apiKey: env.llm.apiKey,
    model: env.llm.model,
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('LLM 未配置：请在 .env 设置 AGENT_LLM_BASE_URL/AGENT_LLM_API_KEY，或在 Settings 中配置 llm 类型 api_configs')
    this.name = 'LlmNotConfiguredError'
  }
}

/** 非流式 chat 补全，返回完整文本 */
export async function chatComplete(
  messages: ChatMessage[],
  endpoint?: LlmEndpoint,
  opts: ChatOptions = {},
): Promise<string> {
  const ep = endpoint ?? (await resolveLlmEndpoint())
  if (!ep.baseUrl || !ep.apiKey) throw new LlmNotConfiguredError()

  const timeoutMs = opts.timeoutMs ?? 120_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({
        model: ep.model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 6000,
        stream: false,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`LLM 调用失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('LLM 响应为空（choices/message/content 缺失）')
    return content
  } finally {
    clearTimeout(timer)
  }
}

/** 提示词模板目录读取（供 ai-text action 使用） */
export function loadPromptTemplate(path: string): string {
  return readFileSync(join(PROMPTS_DIR, path), 'utf8')
}
