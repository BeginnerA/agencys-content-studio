/**
 * 宿主 glue：@agencys/ai-provider-kit 的 Ports & Adapters 接线层。
 *
 * 协议实现与端点解析逻辑已抽包（注册表 + 策略 + createProvider 工厂，见 kit README）；
 * 本文件只负责两件事：
 * 1) 用 libsql/Drizzle 与 secrets.json 实现 kit 的两个端口（ConfigSource / SecretStore）；
 * 2) 保持既有导出面（resolveEndpoint / buildImageRequest / LEGACY_PROVIDER_KEY_ALIASES …）
 *    令全部下游调用点零感知迁移（错误文案与端点指纹哈希同源零漂移）。
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import {
  createProvider,
  type ConfigSource,
  type ProviderCatalogRow,
  type ProviderConfigRow,
  type SecretStore,
} from '@agencys/ai-provider-kit'
import { db } from '../db'
import { apiConfigs, apiProviders, vendorCredentials } from '../db/schema'
import { deleteSecret, resolveApiKey, writeSecret } from '../services/secrets'

/**
 * 旧目录 key 兼容映射（千问/万相家族行已收敛为百炼统一行；网关 OpenAI 兼容行已收编进 openai_* 协议行——
 * 网关不是供应商，其 LLM/图像/语音只是同一 OpenAI 协议的不同 baseUrl；视频/音乐为私有协议保留网关 key 不归入）。
 * 历史模板 / 硬编码 provider 串传入时在端点解析入口归一，避免旧 key 查不到实例。
 */
export const LEGACY_PROVIDER_KEY_ALIASES: Record<string, string> = {
  aliyun_qwen_llm: 'aliyun_bailian_llm',
  aliyun_wan_image: 'aliyun_bailian_image',
  aliyun_qwen_image: 'aliyun_bailian_image',
  aliyun_wan_video: 'aliyun_bailian_video',
  aliyun_qwen_tts: 'aliyun_bailian_tts',
  siliconflow_llm: 'openai_llm',
  pollinations_llm: 'openai_llm',
  siliconflow_image: 'openai_image',
  pollinations_image: 'openai_image',
  siliconflow_audio: 'openai_audio',
  pollinations_audio: 'openai_audio',
}

export function normalizeProviderKey(providerKey: string): string {
  return LEGACY_PROVIDER_KEY_ALIASES[providerKey] ?? providerKey
}

/** 目录行整形：api_providers → kit 的 ProviderCatalogRow（vendor 非空约束兜底空串） */
function toCatalogRow(p: typeof apiProviders.$inferSelect): ProviderCatalogRow {
  return {
    key: p.key,
    name: p.name,
    serviceType: p.serviceType,
    vendor: p.vendor ?? '',
    description: p.description,
    defaultUrl: p.defaultUrl,
    presetModels: p.presetModels,
  }
}

/** Drizzle 实现 kit 的 ConfigSource 端口：行数据整形为纯数据形态交给 kit 解析 */
const source: ConfigSource = {
  async listProviders() {
    const rows = await db.select().from(apiProviders)
    return rows.map(toCatalogRow)
  },
  async listConfigs(serviceType, providerKey) {
    // kit 端点语义用 'chat'；宿主 DB service_type 历史约定存 'llm'——仅此一名不对齐，在此边界回映
    const dbServiceType = serviceType === 'chat' ? 'llm' : serviceType
    const conds = [eq(apiConfigs.serviceType, dbServiceType), eq(apiConfigs.isActive, 1)]
    if (providerKey) conds.push(eq(apiConfigs.providerKey, providerKey))
    // 返回全量活跃实例（isDefault 降序 → priority 升序）；configId 锁定由 kit 内部按 pin 过滤
    const rows = await db
      .select()
      .from(apiConfigs)
      .where(and(...conds))
      .orderBy(desc(apiConfigs.isDefault), asc(apiConfigs.priority))
    return rows.map((cfg): ProviderConfigRow => ({
      id: cfg.id,
      name: cfg.name,
      providerKey: cfg.providerKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKeyRef: cfg.apiKeyRef,
      credentialId: cfg.credentialId,
      extra: cfg.extra,
      pricing: cfg.pricing,
      isDefault: cfg.isDefault,
      priority: cfg.priority,
    }))
  },
  async getCredential(id) {
    const rows = await db
      .select()
      .from(vendorCredentials)
      .where(eq(vendorCredentials.id, id))
      .limit(1)
    const cred = rows[0]
    return cred ? { apiKeyRef: cred.apiKeyRef, baseUrl: cred.baseUrl } : null
  },
  async getProviderByKey(providerKey) {
    const rows = await db
      .select()
      .from(apiProviders)
      .where(eq(apiProviders.key, providerKey))
      .limit(1)
    const row = rows[0]
    return row ? toCatalogRow(row) : null
  },
}

/** 实现 kit 的 SecretStore 端口（CRUD）：底层为 data/secrets.json + env 引用解析 */
const secrets: SecretStore = {
  get: (ref) => resolveApiKey(ref) || null,
  set: (ref, value) => writeSecret(ref, value),
  delete: (ref) => deleteSecret(ref),
}

/**
 * 无鉴权本地轨 providerKey：LocalAI/ComfyUI 自持服务无真实 Key（对齐 ollama 现状）。
 * 这些行走 kit resolveEndpoint（image/video/music 通道），空 Key 若不旁路会被 noApiKey 拦截。
 * LLM/TTS/ASR 走 openai_* 行 + 宿主自有 resolveLlmEndpoint/synthSpeech（已容空 Key），不在此列。
 */
export const NO_AUTH_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  'localai_image',
  'localai_video',
  'localai_music',
  'comfyui_image',
  'comfyui_video',
])

/** 包级单例：全部导出经由同一实例（与旧模块级 imageAdapters 常量语义一致） */
const provider = createProvider({
  source,
  secrets,
  legacyAliases: LEGACY_PROVIDER_KEY_ALIASES,
  noAuthProviders: NO_AUTH_PROVIDER_KEYS,
  // 错误文案保持宿主既有口径（含 Settings 指引）零漂移
  messages: {
    noConfig: (k) => `未配置 ${k ?? ''} 类型 api_configs（Settings → AI 配置）`,
  },
})

export const resolveEndpoint = provider.resolveEndpoint
export const buildImageRequest = provider.buildImageRequest
export const buildVideoRequest = provider.buildVideoRequest
export const defaultTtsModel = provider.defaultTtsModel

// 注册表与适配器契约从包直接透传（宿主调用点保持 adapters/ 入口不变）
export { getImageAdapter, ProviderNotReadyError } from '@agencys/ai-provider-kit'
export type {
  EndpointPin,
  ImageAdapter,
  ImageGenRequest,
  ResolvedEndpoint,
} from '@agencys/ai-provider-kit'
