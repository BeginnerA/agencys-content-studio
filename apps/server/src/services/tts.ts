import { eq } from 'drizzle-orm'
import { resolveEndpoint, type EndpointPin } from '../adapters/provider'
import { db } from '../db'
import { apiProviders } from '../db/schema'
import { synthAliyunQwenSpeech, synthVolcengineSpeech } from '@agencys/ai-provider-kit'

/**
 * TTS 语音合成服务（默认 OpenAI 兼容 /audio/speech，spec §5.2）。
 * 端点取 service_type=audio 的 api_configs（Settings → 语音合成 tab）；
 * 模型默认取供应商目录预设首项（如 aliyun_bailian_tts → qwen-tts），无目录时 OpenAI 系回退 tts-1；
 * aliyun_bailian_tts 为 DashScope 私有协议（kit protocols/speech/aliyun）；
 * volcengine_audio 为火山 TTS V1 私有协议（kit protocols/speech/volcengine，需 extra.appid）。
 */

export interface AudioEndpoint {
  providerKey: string
  baseUrl: string
  apiKey: string
  model: string
  /** 实例级默认音色（config.extra.voice；如 SiliconFlow 需 "模型:音色" 格式） */
  voice?: string
  /** 实例级情绪透传声明（config.extra.emotion_param / emotion_map，E4） */
  emotion?: { param: string; map?: Record<string, string> }
  /** 实例原始扩展参数（api_configs.extra 解析产物；私有协议供应商自取，如火山 TTS 的 appid/cluster） */
  extra: Record<string, unknown>
}

/** 模型兜底：实例未配置时取供应商目录预设首项（如 aliyun_bailian_tts → qwen-tts）；无目录则 OpenAI 系 'tts-1' */
export async function defaultTtsModel(providerKey: string): Promise<string> {
  const rows = await db
    .select({ preset: apiProviders.presetModels })
    .from(apiProviders)
    .where(eq(apiProviders.key, providerKey))
    .limit(1)
  try {
    const presets = rows[0]?.preset ? (JSON.parse(rows[0].preset) as unknown[]) : []
    const first = presets.find((m): m is string => typeof m === 'string' && !!m)
    if (first) return first
  } catch {
    /* 预置目录损坏时走默认 */
  }
  return 'tts-1'
}

/** 解析 audio 端点：未配置实例时报错并附 Settings 指引 */
export async function resolveAudioEndpoint(providerKey?: string, pin?: EndpointPin): Promise<AudioEndpoint> {
  const endpoint = await resolveEndpoint('audio', providerKey, pin)
  return {
    providerKey: endpoint.providerKey,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model ?? (await defaultTtsModel(endpoint.providerKey)),
    voice: typeof endpoint.extra['voice'] === 'string' && endpoint.extra['voice'] ? endpoint.extra['voice'] : undefined,
    emotion: parseEmotionDecl(endpoint.extra),
    extra: endpoint.extra,
  }
}

/** 实例 extra 的情绪声明：emotion_param 为请求体参数名；emotion_map 为 基调词 → 网关枚举值 映射（可选） */
function parseEmotionDecl(extra: Record<string, unknown>): { param: string; map?: Record<string, string> } | undefined {
  const param = extra['emotion_param']
  if (typeof param !== 'string' || !param) return undefined
  const mapRaw = extra['emotion_map']
  if (mapRaw && typeof mapRaw === 'object' && !Array.isArray(mapRaw)) {
    const map: Record<string, string> = {}
    for (const [k, v] of Object.entries(mapRaw as Record<string, unknown>)) {
      if (typeof v === 'string') map[k] = v
    }
    if (Object.keys(map).length > 0) return { param, map }
  }
  return { param }
}

/**
 * 情绪透传载荷（E4）：实例 extra 声明 emotion_param 才透传（未声明 → null，兼容任意网关）。
 * 入参为**完整 emotion_hint**（形如 `基调词——六维细节`）：
 * - 「——」前的基调词命中 emotion_map → 下发映射后的网关枚举值（供只认枚举值的网关）；
 * - 无 map / 未命中 → 透传完整 emotion_hint（含六维细节，供吃自然语言情绪/风格描述的模型，不再截断）。
 */
export function resolveEmotionPayload(
  hint: string,
  emotion?: { param: string; map?: Record<string, string> },
): { param: string; value: string } | null {
  const trimmed = hint.trim()
  if (!trimmed || !emotion) return null
  const idx = trimmed.indexOf('——')
  const key = idx >= 0 ? trimmed.slice(0, idx).trim() : trimmed
  const value = emotion.map?.[key] ?? trimmed
  return { param: emotion.param, value }
}

export interface SynthSpeechOptions {
  voice?: string
  speed?: number
  timeoutMs?: number
  /** 情绪透传（E4）：resolveEmotionPayload 产物；实例未声明时不下发（兼容任意网关） */
  emotion?: { param: string; value: string }
}

/** 文本 → mp3 音频 Buffer；非 2xx 抛错含 HTTP 细节 */
export async function synthSpeech(
  text: string,
  ep: AudioEndpoint,
  opts: SynthSpeechOptions = {},
): Promise<Uint8Array> {
  if (!text.trim()) throw new Error('TTS 输入文本为空')
  // 阿里云百炼/火山为私有协议（各自派发）；其余统一 OpenAI 兼容 /audio/speech
  if (ep.providerKey === 'aliyun_bailian_tts') return synthAliyunQwenSpeech(text, ep, opts)
  if (ep.providerKey === 'volcengine_audio') return synthVolcengineSpeech(text, ep, opts)
  const body: Record<string, unknown> = {
    model: ep.model,
    input: text,
    response_format: 'mp3',
  }
  body.voice = opts.voice ?? 'alloy'
  if (opts.emotion) body[opts.emotion.param] = opts.emotion.value
  if (typeof opts.speed === 'number' && opts.speed > 0) body.speed = opts.speed

  const timeoutMs = opts.timeoutMs ?? 120_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${ep.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const textDetail = await res.text().catch(() => '')
      throw new Error(`语音合成失败 HTTP ${res.status}: ${textDetail.slice(0, 300)}`)
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength === 0) throw new Error('语音合成响应为空（0 字节）')
    return buf
  } finally {
    clearTimeout(timer)
  }
}
