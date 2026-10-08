import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asc, desc, eq, and } from 'drizzle-orm'
import {
  chatCompleteDetailed as kitChatCompleteDetailed,
  type ChatContentPart,
  type ChatMessage,
  type ChatOptions,
  type ChatUsage,
} from '@agencys/ai-provider-kit'
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
  /** 用量来源标识：api_configs 的 providerKey；env 兜底 'env' */
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

/**
 * 多模态内容分片 / 对话消息 / 调用选项：以 kit 的 OpenAI 兼容 Chat 协议为单一真源，
 * 宿主侧仅 re-export 以保持既有 import 路径（services/llm）零改动。
 */
export type { ChatContentPart, ChatMessage, ChatOptions }
/** 补全用量（OpenAI 兼容 usage 字段） */
export type LlmUsage = ChatUsage

/** 补全结果（含用量与来源；用量记录用）。provider/model 为宿主侧补充，kit 不携带来源信息 */
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

/**
 * 非流式 chat 补全（详细版）：内容 + usage + 来源（用量记录用）。
 * 协议层 POST 委派给 kit（openai-compatible chat）；
 * 宿主保留 resolveLlmEndpoint 兑底与 LlmNotConfiguredError 文案，并将结果映射为携带 provider/model 的 LlmResult。
 */
export async function chatCompleteDetailed(
  messages: ChatMessage[],
  endpoint?: LlmEndpoint,
  opts: ChatOptions = {},
): Promise<LlmResult> {
  const ep = endpoint ?? (await resolveLlmEndpoint())
  if (!ep.baseUrl)
    throw new LlmNotConfiguredError('端点缺失：实例未填 base_url 且供应商目录无默认端点（或 .env 未设置 AGENT_LLM_BASE_URL）')
  if (!ep.apiKey) throw new LlmNotConfiguredError('API Key 缺失：请在 Settings → AI 配置检查实例密钥，或 .env 设置 AGENT_LLM_API_KEY')

  // 推理模型安全兜底：deepseek 系 reasoning_content 实测独占 18-19K token（kit 默认 12000 会在正文产出前耗尽，
  // 报「模型仅输出推理未产出正文」）；未显式传参的入口统一 24000 + 10 分钟超时，显式传参优先（分镜/方案的 64000 档不受影响）
  const r = await kitChatCompleteDetailed(
    messages,
    { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model },
    { maxTokens: 24_000, timeoutMs: 600_000, ...opts },
  )
  return { content: r.content, usage: r.usage, provider: ep.providerKey, model: ep.model, finishReason: r.finishReason }
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