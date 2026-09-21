import { and, asc, desc, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { AliyunBailianImageAdapter } from './aliyun-bailian-image'
import { GeminiImageAdapter } from './gemini-image'
import { OpenAIImageAdapter } from './openai-image'
import { PollinationsImageAdapter } from './pollinations-image'
import { SiliconFlowImageAdapter } from './siliconflow-image'
import { VolcengineImageAdapter } from './volcengine-image'
import type { ImageAdapter, ImageGenRequest } from './types'
import { db } from '../db'
import { apiConfigs, apiProviders, vendorCredentials } from '../db/schema'
import { resolveApiKey } from '../services/secrets'

/**
 * 已注册图像适配器（openai_image 通用；pollinations_image / siliconflow_image 为其别名子类；
 * gemini_image 为 Google v1beta generateContent/interactions 协议；aliyun_bailian_image 为百炼统一入口
 * （按 model 前缀派发万相多代 / 千问同步直返协议）；volcengine_image 为方舟异步/同步双形态的自包含实现）。
 */
const imageAdapters: Record<string, ImageAdapter> = {
  openai_image: new OpenAIImageAdapter(),
  pollinations_image: new PollinationsImageAdapter(),
  siliconflow_image: new SiliconFlowImageAdapter(),
  gemini_image: new GeminiImageAdapter(),
  aliyun_bailian_image: new AliyunBailianImageAdapter(),
  volcengine_image: new VolcengineImageAdapter(),
}

/**
 * 旧阿里目录 key 兼容映射（千问/万相家族行已收敛为百炼统一行）。
 * 历史模板 / 硬编码 provider 串传入时在端点解析入口归一，避免旧 key 查不到实例。
 */
export const LEGACY_PROVIDER_KEY_ALIASES: Record<string, string> = {
  aliyun_qwen_llm: 'aliyun_bailian_llm',
  aliyun_wan_image: 'aliyun_bailian_image',
  aliyun_qwen_image: 'aliyun_bailian_image',
  aliyun_wan_video: 'aliyun_bailian_video',
  aliyun_qwen_tts: 'aliyun_bailian_tts',
}

export function normalizeProviderKey(providerKey: string): string {
  return LEGACY_PROVIDER_KEY_ALIASES[providerKey] ?? providerKey
}

export class ProviderNotReadyError extends Error {
  constructor(providerKey: string) {
    super(
      `供应商「${providerKey}」适配器未就绪（已注册：openai_image、pollinations_image、siliconflow_image、gemini_image、aliyun_bailian_image、volcengine_image）。`,
    )
    this.name = 'ProviderNotReadyError'
  }
}

export function getImageAdapter(providerKey: string): ImageAdapter {
  const adapter = imageAdapters[providerKey]
  if (!adapter) throw new ProviderNotReadyError(providerKey)
  return adapter
}

export interface EndpointPin { configId: number; configHash?: string }

export interface ResolvedEndpoint {
  configId: number
  configHash: string
  providerKey: string
  serviceType: string
  baseUrl: string
  apiKey: string
  model?: string
  extra: Record<string, unknown>
}

/**
 * 选择图像/视频/语音端点：service_type + providerKey（可选）；否则 is_default 优先。
 * 密钥解析优先级：credential_id → vendor_credentials.apiKeyRef → api_configs.apiKeyRef（fallback）。
 * Base URL 优先级：实例 baseUrl → 凭证 baseUrl → 目录 defaultUrl。
 * 端点配置缺失或 key 未填时抛错并附配置指引。
 */
export async function resolveEndpoint(
  serviceType: 'image' | 'video' | 'audio' | 'llm',
  providerKey?: string,
  pin?: EndpointPin,
): Promise<ResolvedEndpoint> {
  // 旧 key（如历史模板硬编码的 aliyun_wan_image）先归一到合并后的百炼 key，再查实例
  if (providerKey) providerKey = normalizeProviderKey(providerKey)
  const conds = [eq(apiConfigs.serviceType, serviceType), eq(apiConfigs.isActive, 1)]
  if (providerKey) conds.push(eq(apiConfigs.providerKey, providerKey))
  if (pin) conds.push(eq(apiConfigs.id, pin.configId))
  const rows = await db
    .select()
    .from(apiConfigs)
    .where(and(...conds))
    .orderBy(desc(apiConfigs.isDefault), asc(apiConfigs.priority))
    .limit(1)
  const cfg = rows[0]
  if (!cfg) {
    throw new Error(
      `未配置 ${serviceType} 类型 api_configs（Settings → AI 配置，providerKey=${providerKey ?? 'default'}）`,
    )
  }

  // 密钥解析：credential 优先，fallback 到实例级 apiKeyRef
  let apiKey = ''
  let credBaseUrl = ''
  let credentialRef: string | null = null
  if (cfg.credentialId != null) {
    const credRows = await db
      .select()
      .from(vendorCredentials)
      .where(eq(vendorCredentials.id, cfg.credentialId))
      .limit(1)
    const cred = credRows[0]
    if (cred) {
      credentialRef = cred.apiKeyRef
      apiKey = resolveApiKey(cred.apiKeyRef)
      credBaseUrl = cred.baseUrl?.trim() ?? ''
    }
  }
  if (!apiKey) {
    apiKey = resolveApiKey(cfg.apiKeyRef)
  }
  if (!apiKey) {
    throw new Error(`api_configs「${cfg.name}」的 API Key 未解析（请配置供应商凭证或实例级 Key）`)
  }

  // Base URL 解析：实例 > 凭证 > 目录
  const providerRow = await db
    .select()
    .from(apiProviders)
    .where(eq(apiProviders.key, cfg.providerKey))
    .limit(1)
  const baseUrl = cfg.baseUrl?.trim() || credBaseUrl || providerRow[0]?.defaultUrl?.trim() || ''
  if (!baseUrl) {
    throw new Error(`api_configs「${cfg.name}」缺少 baseUrl，且供应商无 defaultUrl`)
  }

  let extra: Record<string, unknown> = {}
  try {
    extra = cfg.extra ? (JSON.parse(cfg.extra) as Record<string, unknown>) : {}
  } catch {
    extra = {}
  }
  // 只返回指纹，不持久化 URL、extra 或密钥；默认标记/优先级变化不影响已锁定实例。
  const configHash = createHash('sha256').update(JSON.stringify({
    id: cfg.id, provider: cfg.providerKey, serviceType, baseUrl, model: cfg.model,
    extra, pricing: cfg.pricing, credentialId: cfg.credentialId, credentialRef, keyRef: cfg.apiKeyRef,
  })).digest('hex')
  if (pin?.configHash && pin.configHash !== configHash) throw new Error('已确认的供应商实例配置发生变化，请重新规划并确认')
  return {
    configId: cfg.id,
    configHash,
    providerKey: cfg.providerKey,
    serviceType,
    baseUrl,
    apiKey,
    model: cfg.model ?? undefined,
    extra,
  }
}

/** 组装图像生成请求（image action 用） */
export async function buildImageRequest(params: {
  prompt: string
  provider?: string
  model?: string
  size?: string
  referenceImages?: string[]
  pin?: EndpointPin
}): Promise<{ adapter: ImageAdapter; request: ImageGenRequest }> {
  const endpoint = await resolveEndpoint('image', params.provider, params.pin)
  const adapter = getImageAdapter(endpoint.providerKey)
  return {
    adapter,
    request: {
      prompt: params.prompt,
      size: params.size,
      model: params.model ?? endpoint.model,
      referenceImages: params.referenceImages,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      extra: endpoint.extra,
    },
  }
}
