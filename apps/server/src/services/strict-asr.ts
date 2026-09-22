import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs } from '../db/schema'
import { resolveEndpoint, type ResolvedEndpoint } from '../adapters/provider'
import { CreationError } from './creation-chat/contract'
import type { CreationRecipe } from './creation-chat/recipe'
import { resolveUnitPrice } from './usage'

export type StrictAsrSnapshot = NonNullable<CreationRecipe['asr']>

/** 独立于视频参考分析的宽容 ASR：只接受显式启用的已验证时间戳协议。 */
export async function resolveStrictAsrEndpoint(pin?: StrictAsrSnapshot): Promise<ResolvedEndpoint & { model: 'whisper-1' }> {
  const configs = await db.select().from(apiConfigs).where(and(
    eq(apiConfigs.serviceType, 'audio'), eq(apiConfigs.isActive, 1), ...(pin ? [eq(apiConfigs.id, pin.configId)] : []),
  )).orderBy(desc(apiConfigs.isDefault), asc(apiConfigs.priority))
  for (const config of configs) {
    let extra: Record<string, unknown>
    try { extra = JSON.parse(config.extra ?? '{}') } catch { continue }
    if (extra.asr_model !== 'whisper-1' || extra.asr_protocol !== 'openai_verbose_json') continue
    try {
      const endpoint = await resolveEndpoint('audio', pin?.provider, pin ?? { configId: config.id })
      const url = new URL(endpoint.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('url')
      if (pin && (pin.model !== extra.asr_model || pin.protocol !== extra.asr_protocol || pin.policy !== 'verbatim-segments-v1')) throw new Error('pin')
      return { ...endpoint, model: 'whisper-1' }
    } catch {
      // 已批准实例失效时禁止尝试其他配置，首次选择也不掩盖配置错误。
      throw new CreationError('asr_configuration_changed', '严格 ASR 实例不可用或配置已变化，请检查语音配置并重新确认', 422)
    }
  }
  throw new CreationError('missing_asr', '请在语音配置中显式启用 whisper-1 与 OpenAI 分段时间戳协议；人物对白不能无 ASR 执行', 422)
}

export async function snapshotStrictAsr(): Promise<StrictAsrSnapshot> {
  const ep = await resolveStrictAsrEndpoint()
  const unitPrice = await resolveUnitPrice({ configId: ep.configId, provider: ep.providerKey, model: ep.model, kind: 'asr', unit: 'second' })
  return { configId: ep.configId, configHash: ep.configHash, provider: ep.providerKey, model: ep.model,
    unitPrice, protocol: 'openai_verbose_json', policy: 'verbatim-segments-v1' }
}
