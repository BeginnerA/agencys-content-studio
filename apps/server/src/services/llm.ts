import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asc, desc, eq, and } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs, apiProviders, vendorCredentials } from '../db/schema'
import { env, PROMPTS_DIR } from '../env'
import { createLogger } from '../logger'
import { resolveApiKey } from './secrets'

const log = createLogger('llm')

export interface LlmEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  /** [M4] 用量来源标识：api_configs 的 providerKey；env 兜底 'env' */
  providerKey: string
}

/** 供应商目录 defaultUrl 兜底：实例未填 base_url 时回退目录内置端点（base_url 语义为「覆盖 default_url」） */
export async function providerDefaultUrl(providerKey: string): Promise<string> {
  const rows = await db
    .select({ url: apiProviders.defaultUrl })
    .from(apiProviders)
    .where(eq(apiProviders.key, providerKey))
    .limit(1)
  return rows[0]?.url?.trim() ?? ''
}

/** 解析 llm 端点：api_configs（is_default 优先）→ env 兜底；密钥优先从 credential 解析 */
export async function resolveLlmEndpoint(): Promise<LlmEndpoint> {
  const rows = await db
    .select()
    .from(apiConfigs)
    .where(and(eq(apiConfigs.serviceType, 'llm'), eq(apiConfigs.isActive, 1)))
    .orderBy(desc(apiConfigs.isDefault), asc(apiConfigs.priority))
    .limit(1)
  const cfg = rows[0]
  if (cfg) {
    // 密钥解析：credential 优先，fallback 到实例级 apiKeyRef
    let apiKey = ''
    let credBaseUrl = ''
    if (cfg.credentialId != null) {
      const credRows = await db
        .select()
        .from(vendorCredentials)
        .where(eq(vendorCredentials.id, cfg.credentialId))
        .limit(1)
      const cred = credRows[0]
      if (cred) {
        apiKey = resolveApiKey(cred.apiKeyRef)
        credBaseUrl = cred.baseUrl?.trim() ?? ''
      }
    }
    if (!apiKey) apiKey = resolveApiKey(cfg.apiKeyRef)
    const baseUrl = (cfg.baseUrl?.trim() || credBaseUrl || (await providerDefaultUrl(cfg.providerKey))).replace(/\/+$/, '')
    return { baseUrl, apiKey, model: cfg.model ?? env.llm.model, providerKey: cfg.providerKey }
  }
  return {
    baseUrl: env.llm.baseUrl.replace(/\/+$/, ''),
    apiKey: env.llm.apiKey,
    model: env.llm.model,
    providerKey: 'env',
  }
}

/** [M13] 多模态内容分片（OpenAI 兼容：文本 / 图片 data URI；messages 直通请求体） */
export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  /** 纯文本或分片数组（视觉模型多图入参，M13） */
  content: string | ChatContentPart[]
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  /** 允许「仅推理无正文」视为成功（连通性测试用）：返回 reasoning 内容而不抛错 */
  allowReasoningOnly?: boolean
  /** 允许「choice 合法但无正文」视为成功（连通性测试用）：极短 max_tokens 下推理模型可能全部思考/被 length 截断 */
  allowEmptyContent?: boolean
}

/** [M4] 补全用量（OpenAI 兼容 usage 字段） */
export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** [M4] 补全结果（含用量与来源；用量记录用） */
export interface LlmResult {
  content: string
  usage: LlmUsage | null
  provider: string
  model: string
  /** OpenAI 兼容 finish_reason（'length' = 输出被 max_tokens 截断，推理模型 reasoning 占预算的信号） */
  finishReason?: string
}

export class LlmNotConfiguredError extends Error {
  constructor(detail?: string) {
    super(
      detail
        ? `LLM 未配置：${detail}`
        : 'LLM 未配置：请在 .env 设置 AGENT_LLM_BASE_URL/AGENT_LLM_API_KEY，或在 Settings 中配置 llm 类型 api_configs',
    )
    this.name = 'LlmNotConfiguredError'
  }
}

/** 非流式 chat 补全（详细版）：内容 + usage + 来源（用量记录用） */
export async function chatCompleteDetailed(
  messages: ChatMessage[],
  endpoint?: LlmEndpoint,
  opts: ChatOptions = {},
): Promise<LlmResult> {
  const ep = endpoint ?? (await resolveLlmEndpoint())
  if (!ep.baseUrl)
    throw new LlmNotConfiguredError('端点缺失：实例未填 base_url 且供应商目录无默认端点（或 .env 未设置 AGENT_LLM_BASE_URL）')
  if (!ep.apiKey) throw new LlmNotConfiguredError('API Key 缺失：请在 Settings → AI 配置检查实例密钥，或 .env 设置 AGENT_LLM_API_KEY')

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
        max_tokens: opts.maxTokens ?? 12000,
        stream: false,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`LLM 调用失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    const usage: LlmUsage | null = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : null
    const choice = data.choices?.[0]
    const content = data.choices?.[0]?.message?.content
    const finishReason = choice?.finish_reason
    if (!content) {
      if (choice?.message?.reasoning_content) {
        if (opts.allowReasoningOnly)
          return { content: choice.message.reasoning_content, usage, provider: ep.providerKey, model: ep.model, finishReason }
        throw new Error('LLM 响应为空：模型仅输出推理未产出正文（reasoning 模型请调大 max_tokens 预算）')
      }
      // 连通性测试放宽：choice 结构合法即视为链路可用（如 max_tokens 极小被 length 截断、未产出正文）
      if (opts.allowEmptyContent && choice) return { content: '', usage, provider: ep.providerKey, model: ep.model, finishReason }
      throw new Error('LLM 响应为空（choices/message/content 缺失）')
    }
    return { content, usage, provider: ep.providerKey, model: ep.model, finishReason }
  } finally {
    clearTimeout(timer)
  }
}

/** 非流式 chat 补全，返回完整文本（chatCompleteDetailed 薄封装；签名不变） */
export async function chatComplete(
  messages: ChatMessage[],
  endpoint?: LlmEndpoint,
  opts: ChatOptions = {},
): Promise<string> {
  return (await chatCompleteDetailed(messages, endpoint, opts)).content
}

/** 提示词模板目录读取（供 ai-text action 使用） */
export function loadPromptTemplate(path: string): string {
  return readFileSync(join(PROMPTS_DIR, path), 'utf8')
}