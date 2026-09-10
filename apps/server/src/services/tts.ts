import { resolveEndpoint } from '../adapters/provider'

/**
 * TTS 语音合成服务（OpenAI 兼容 /audio/speech，spec §5.2）。
 * 端点取 service_type=audio 的 api_configs（Settings → 语音合成 tab）；
 * 模型默认 tts-1（OpenAI 官方），用户配置 OpenAI 兼容网关实例时以 config.model 覆盖
 * （如 SiliconFlow 网关的 CosyVoice2-0.5B）。
 */

export interface AudioEndpoint {
  providerKey: string
  baseUrl: string
  apiKey: string
  model: string
  /** 实例级默认音色（config.extra.voice；如 SiliconFlow 需 "模型:音色" 格式） */
  voice?: string
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
  }
}

export interface SynthSpeechOptions {
  voice?: string
  speed?: number
  timeoutMs?: number
}

/** 文本 → mp3 音频 Buffer；非 2xx 抛错含 HTTP 细节 */
export async function synthSpeech(
  text: string,
  ep: AudioEndpoint,
  opts: SynthSpeechOptions = {},
): Promise<Uint8Array> {
  if (!text.trim()) throw new Error('TTS 输入文本为空')
  const body: Record<string, unknown> = {
    model: ep.model,
    input: text,
    response_format: 'mp3',
  }
  body.voice = opts.voice ?? 'alloy'
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
