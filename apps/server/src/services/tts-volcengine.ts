/**
 * 火山引擎语音合成（TTS V1 HTTP 协议，非 OpenAI /audio/speech）。
 *
 * 官方协议（openspeech.bytedance.com）：
 * - POST /api/v1/tts（Authorization: Bearer;{token}，注意分号）
 * - 请求体 { app: { appid, token, cluster }, user: { uid },
 *           audio: { voice_type, encoding, speed_ratio? },
 *           request: { reqid, text, operation: 'query' } }
 * - 响应 { code: 3000, data: '<base64 音频>', message }（code !== 3000 为失败）
 * - appid 无官方默认值：从实例扩展参数 extra.appid 读取（Settings 实例 JSON 扩展参数）；
 *   cluster 默认 volcano_tts，可 extra.cluster 覆盖
 * - 音色为供应商枚举（标准版 BV700_streaming …、大模型音色 zh_*_mars_bigtts 等）；
 *   声线链兜底 'alloy'（OpenAI 系占位音色，火山不认）→ 回退官方默认
 * - 情绪：opts.emotion（resolveEmotionPayload 产物）→ 写入 audio.emotion（官方 V1 “音色情感”字段）。
 *   火山只认枚举值（如 happy/sad/angry…，且部分大模型音色才有），需实例配 emotion_map 将基调词→枚举；
 *   未配 map 直发自然语言六维 hint 会被上游忽略（非报错）
 */
import { randomUUID } from 'node:crypto'
import type { AudioEndpoint, SynthSpeechOptions } from './tts'

const DEFAULT_VOICE = 'BV700_streaming'
const DEFAULT_CLUSTER = 'volcano_tts'
const SUCCESS_CODE = 3000

export async function synthVolcengineSpeech(
  text: string,
  ep: AudioEndpoint,
  opts: SynthSpeechOptions = {},
): Promise<Uint8Array> {
  const appid = typeof ep.extra['appid'] === 'string' ? ep.extra['appid'].trim() : ''
  if (!appid) {
    throw new Error('火山 TTS 缺少 appid：请在实例扩展参数中提供 {"appid":"..."}（火山控制台应用 ID）')
  }
  const cluster =
    typeof ep.extra['cluster'] === 'string' && ep.extra['cluster'] ? ep.extra['cluster'] : DEFAULT_CLUSTER
  const voice = opts.voice && opts.voice !== 'alloy' ? opts.voice : DEFAULT_VOICE

  const audio: Record<string, unknown> = { voice_type: voice, encoding: 'mp3' }
  if (typeof opts.speed === 'number' && opts.speed > 0) {
    // V1 语速范围 0.2 - 3.0
    audio.speed_ratio = Math.min(3, Math.max(0.2, opts.speed))
  }
  // 情绪（官方 V1 audio.emotion 音色情感）：只认枚举值，需实例配 emotion_map 将基调词→枚举（同 tts.ts 模式，门禁由 emotion_param 控制）
  if (opts.emotion?.value) {
    audio.emotion = opts.emotion.value
  }

  const timeoutMs = opts.timeoutMs ?? 120_000
  const result = await postJson(
    joinApiUrl(ep.baseUrl, '/api/v1', '/tts'),
    ep.apiKey,
    {
      app: { appid, token: ep.apiKey, cluster },
      user: { uid: 'agencys-content-studio' },
      audio,
      request: { reqid: randomUUID(), text, operation: 'query' },
    },
    timeoutMs,
  )

  if (result?.code !== SUCCESS_CODE) throw new Error(errorMessage(result))
  const b64 = typeof result?.data === 'string' ? result.data : ''
  if (!b64) throw new Error(`火山 TTS 响应缺少 data（code=${result?.code}）`)
  const buf = new Uint8Array(Buffer.from(b64, 'base64'))
  if (buf.byteLength === 0) throw new Error('语音合成响应为空（0 字节）')
  return buf
}

function errorMessage(result: any): string {
  const code = result?.code
  const message = result?.message || '火山 TTS 合成失败'
  return `[${code ?? 'unknown'}] ${message}`
}

/** HTTP 错误体细节：优先解析 {code,message}，否则原文截断 */
function httpDetail(raw: string): string {
  try {
    const obj = JSON.parse(raw) as { code?: number | string; message?: string }
    if (obj?.code !== undefined || obj?.message) return `[${obj.code ?? 'unknown'}] ${obj.message ?? ''}`
  } catch {
    /* 非 JSON 原文截断 */
  }
  return raw.slice(0, 300)
}

/** baseUrl 兼容带/不带 /api/v1 路径段的网关（与万相/千问 TTS 同源） */
function joinApiUrl(baseUrl: string, prefix: string, path: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '')
  if (!base) return `${prefix}${path}`
  try {
    const url = new URL(base)
    const current = url.pathname.replace(/\/+$/, '')
    const merged = current.endsWith(prefix) ? current : `${current}${prefix}`
    url.pathname = `${merged}${path}`.replace(/\/{2,}/g, '/')
    return url.toString()
  } catch {
    const basePath = base.endsWith(prefix) ? base : `${base}${prefix}`
    return `${basePath}${path}`
  }
}

async function postJson(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer;${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      throw new Error(`语音合成失败 HTTP ${res.status}: ${httpDetail(raw)}`)
    }
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}
