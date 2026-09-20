/**
 * 阿里云百炼千问 TTS（qwen-tts）语音合成（DashScope 私有协议，非 OpenAI /audio/speech）。
 *
 * 官方协议（同步返回）：
 * - POST /api/v1/services/aigc/multimodal-generation/generation
 * - 请求体 { model, input: { text, voice } }；instruct 变体追加 input.instructions / optimize_instructions
 * - 响应 output.audio.url（临时下载地址）或 output.audio.data（base64）
 * - 音色为供应商枚举（Cherry / Serena / Ethan / Chelsie …）
 * - 情绪：qwen-tts 不支持 emotion/speed（下发会 400）；qwen3-tts-instruct-flash 原生吃自然语言 instructions，
 *   opts.emotion（resolveEmotionPayload 产物，完整六维 emotion_hint）→ 写入 input.instructions。
 *   按模型名防呆：仅 model 含 'instruct' 时才下发（普通 qwen-tts 收到 instructions 会 400），用户换模型无需手动开关 emotion_param 门禁
 *
 * 声线链兜底：action 层全链未命中时给 'alloy'（OpenAI 系占位音色，DashScope 不认）→ 回退官方默认 'Cherry'。
 */
import type { SynthSpeechOptions } from './tts'

const DEFAULT_MODEL = 'qwen-tts'
const DEFAULT_VOICE = 'Cherry'

export async function synthAliyunQwenSpeech(
  text: string,
  ep: { baseUrl: string; apiKey: string; model: string },
  opts: SynthSpeechOptions = {},
): Promise<Uint8Array> {
  const model = String(ep.model || '').trim() || DEFAULT_MODEL
  const voice = opts.voice && opts.voice !== 'alloy' ? opts.voice : DEFAULT_VOICE
  const timeoutMs = opts.timeoutMs ?? 120_000

  // 情绪/风格指令：仅 instruct 变体吃 instructions（普通 qwen-tts 收到会 400 → 按模型名防呆）
  const input: Record<string, unknown> = { text, voice }
  if (opts.emotion?.value && /instruct/i.test(model)) {
    input.instructions = opts.emotion.value
    input.optimize_instructions = true
  }

  const result = await postJson(
    joinApiUrl(ep.baseUrl, '/api/v1', '/services/aigc/multimodal-generation/generation'),
    ep.apiKey,
    { model, input },
    timeoutMs,
  )

  const audio = result?.output?.audio
  const url = typeof audio?.url === 'string' && audio.url ? audio.url : ''
  const b64 = typeof audio?.data === 'string' && audio.data ? audio.data : ''
  const buf = url
    ? await downloadBytes(url, timeoutMs)
    : b64
      ? new Uint8Array(Buffer.from(b64, 'base64'))
      : null
  if (!buf) throw new Error(errorMessage(result, '千问 TTS 响应中缺少 output.audio.url/data'))
  if (buf.byteLength === 0) throw new Error('语音合成响应为空（0 字节）')
  return buf
}

function errorMessage(result: any, fallback: string): string {
  const code = result?.code
  const message = result?.message || result?.output?.message || fallback
  const requestId = result?.request_id
  return `${code ? `[${code}] ` : ''}${message}${requestId ? ` (request_id: ${requestId})` : ''}`
}

/** HTTP 错误体细节：优先解析 DashScope {code,message}，否则原文截断 */
function httpDetail(raw: string): string {
  try {
    const obj = JSON.parse(raw) as { code?: string; message?: string }
    if (obj?.code || obj?.message) return `${obj.code ? `[${obj.code}] ` : ''}${obj.message ?? ''}`
  } catch {
    /* 非 JSON 原文截断 */
  }
  return raw.slice(0, 300)
}

/** baseUrl 兼容带/不带 /api/v1 路径段的网关（与万相适配器同源） */
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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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

async function downloadBytes(url: string, timeoutMs: number): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`语音文件下载失败 HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}
