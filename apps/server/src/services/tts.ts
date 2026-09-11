import { resolveEndpoint } from '../adapters/provider'
import { synthAliyunQwenSpeech } from './tts-aliyun'
import { synthVolcengineSpeech } from './tts-volcengine'

/**
 * TTS 语音合成服务（默认 OpenAI 兼容 /audio/speech，spec §5.2）。
 * 端点取 service_type=audio 的 api_configs（Settings → 语音合成 tab）；
 * 模型默认 tts-1（OpenAI 官方），用户配置 OpenAI 兼容网关实例时以 config.model 覆盖
 * （如 SiliconFlow 网关的 CosyVoice2-0.5B）；
 * aliyun_qwen_tts 为 DashScope 私有协议（tts-aliyun.ts）；
 * volcengine_audio 为火山 TTS V1 私有协议（tts-volcengine.ts，需 extra.appid）。
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

/** 解析 audio 端点：未配置实例时报错并附 Settings 指引 */
export async function resolveAudioEndpoint(providerKey?: string): Promise<AudioEndpoint> {
  const endpoint = await resolveEndpoint('audio', providerKey)
  return {
    providerKey: endpoint.providerKey,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model ?? 'tts-1',
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

/** 情绪透传载荷（E4）：实例声明 emotion_param 才透传；map 命中 → 映射值，否则基调词原样；无 key/未声明 → null */
export function resolveEmotionPayload(
  key: string,
  emotion?: { param: string; map?: Record<string, string> },
): { param: string; value: string } | null {
  if (!key || !emotion) return null
  return { param: emotion.param, value: emotion.map?.[key] ?? key }
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
  // 阿里云千问/火山为私有协议（各自派发）；其余统一 OpenAI 兼容 /audio/speech
  if (ep.providerKey === 'aliyun_qwen_tts') return synthAliyunQwenSpeech(text, ep, opts)
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
