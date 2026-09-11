import { and, asc, desc, eq } from 'drizzle-orm'
import { AliyunWanImageAdapter } from './aliyun-wan-image'
import { GeminiImageAdapter } from './gemini-image'
import { OpenAIImageAdapter } from './openai-image'
import { PollinationsImageAdapter } from './pollinations-image'
import { SiliconFlowImageAdapter } from './siliconflow-image'
import { VolcengineImageAdapter } from './volcengine-image'
import type { ImageAdapter, ImageGenRequest } from './types'
import { db } from '../db'
import { apiConfigs, apiProviders } from '../db/schema'
import { resolveApiKey } from '../services/secrets'

/**
 * 已注册图像适配器（openai_image 通用；pollinations_image / siliconflow_image 为其别名子类；
 * gemini_image 为 Google v1beta generateContent/interactions 协议；aliyun_wan_image 为 DashScope 异步任务协议、
 * volcengine_image 为方舟异步/同步双形态的自包含实现）。
 */
const imageAdapters: Record<string, ImageAdapter> = {
  openai_image: new OpenAIImageAdapter(),
  pollinations_image: new PollinationsImageAdapter(),
  siliconflow_image: new SiliconFlowImageAdapter(),
  gemini_image: new GeminiImageAdapter(),
  aliyun_wan_image: new AliyunWanImageAdapter(),
  volcengine_image: new VolcengineImageAdapter(),
}

export class ProviderNotReadyError extends Error {
  constructor(providerKey: string) {
    super(
      `供应商「${providerKey}」适配器未就绪（已注册：openai_image、pollinations_image、siliconflow_image、gemini_image、aliyun_wan_image、volcengine_image）。`,
    )
    this.name = 'ProviderNotReadyError'
  }
}

export function getImageAdapter(providerKey: string): ImageAdapter {
  const adapter = imageAdapters[providerKey]
  if (!adapter) throw new ProviderNotReadyError(providerKey)
  return adapter
}

export interface ResolvedEndpoint {
  providerKey: string
  serviceType: string
  baseUrl: string
  apiKey: string
  model?: string
  extra: Record<string, unknown>
}

/**
 * 选择图像/视频/语音端点：service_type + providerKey（可选）；否则 is_default 优先。
 * 端点配置缺失或 key 未填时抛错并附配置指引。
 */
export async function resolveEndpoint(
  serviceType: 'image' | 'video' | 'audio',
  providerKey?: string,
): Promise<ResolvedEndpoint> {
  const conds = [eq(apiConfigs.serviceType, serviceType), eq(apiConfigs.isActive, 1)]
  if (providerKey) conds.push(eq(apiConfigs.providerKey, providerKey))
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
  const apiKey = resolveApiKey(cfg.apiKeyRef)
  if (!apiKey) {
    throw new Error(`api_configs「${cfg.name}」的 API Key 未解析（apiKeyRef=${cfg.apiKeyRef}）`)
  }
  const providerRow = await db
    .select()
    .from(apiProviders)
    .where(eq(apiProviders.key, cfg.providerKey))
    .limit(1)
  const baseUrl = cfg.baseUrl?.trim() || providerRow[0]?.defaultUrl?.trim() || ''
  if (!baseUrl) {
    throw new Error(`api_configs「${cfg.name}」缺少 baseUrl，且供应商无 defaultUrl`)
  }
  let extra: Record<string, unknown> = {}
  try {
    extra = cfg.extra ? (JSON.parse(cfg.extra) as Record<string, unknown>) : {}
  } catch {
    extra = {}
  }
  return {
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
}): Promise<{ adapter: ImageAdapter; request: ImageGenRequest }> {
  const endpoint = await resolveEndpoint('image', params.provider)
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
