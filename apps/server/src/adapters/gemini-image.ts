/**
 * Gemini（Nano Banana / Gemini Image 系列）文生图适配器（M3 从 huobao-drama 搬运，对齐本仓同步契约）。
 *
 * 官方协议（Google Generative Language API，v1beta）：
 * - 主路径 POST /v1beta/models/{model}:generateContent：
 *   contents[].parts[]（可选 inline_data 参考图 + text）+ generationConfig.responseModalities=['IMAGE','TEXT']
 *   + imageConfig{aspectRatio,imageSize}；响应图片为 candidates[].content.parts[].inlineData（base64，无 URL）
 * - 增强路径 POST /v1beta/interactions（仅官方 host + gemini-3*image 模型）：
 *   response_format.type=image 直出 output_image，或返回交互 id → 轮询 GET /v1beta/interactions/{id}
 * - 认证：x-goog-api-key header 与 ?key= query 双写（兼容官方与只认其中一种的中转网关）
 * - 尺寸：本仓 '1024x1024' 形态 → aspectRatio（gcd 化简）+ imageSize（1K/2K/4K 档）
 *
 * 本仓 ImageAdapter.generate() 为同步契约：interactions 异步任务在适配器内部完成轮询
 * （3s 间隔、总预算 180s，与万相/方舟适配器同源）。
 */
import type { GeneratedImage, ImageAdapter, ImageGenRequest } from './types'

const DEFAULT_MODEL = 'gemini-3.1-flash-image'
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 180_000

export class GeminiImageAdapter implements ImageAdapter {
  readonly provider = 'gemini_image'

  async generate(req: ImageGenRequest): Promise<GeneratedImage> {
    const model = String(req.model || '').trim() || DEFAULT_MODEL
    const prompt = String(req.prompt || '').trim()
    if (!prompt) throw new Error('Gemini 文生图 prompt 为空')

    // 官方 host 的 gemini-3 图片模型优先走 interactions（支持 aspect_ratio/image_size 直参）；
    // 仅 HTTP 层失败（端点未启用/权限等）时回退 generateContent——已成功返回但缺图的不回退，
    // 避免静默二次生成（潜在双计费）。中转站普遍未配置 interactions，天然走 generateContent。
    if (isGemini3Image(model) && isOfficialHost(req.baseUrl)) {
      try {
        return await generateViaInteractions(req, model, prompt)
      } catch (err) {
        if (!(err instanceof HttpError)) throw err
      }
    }
    return await generateViaGenerateContent(req, model, prompt)
  }
}

/** 主路径：generateContent（官方与各类中转站通用） */
async function generateViaGenerateContent(
  req: ImageGenRequest,
  model: string,
  prompt: string,
): Promise<GeneratedImage> {
  const parts: Record<string, unknown>[] = []
  for (const ref of parseReferenceImages(req.referenceImages)) {
    parts.push({ inline_data: { mime_type: ref.mime, data: ref.data } })
  }
  parts.push({ text: prompt })

  const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE', 'TEXT'] }
  const size = parseSize(req.size)
  if (size) {
    generationConfig.imageConfig = { aspectRatio: aspectRatio(size), imageSize: imageSize(size) }
  }

  const modelPath = model.startsWith('models/') ? model : `models/${model}`
  const result = await postJson(joinApiUrl(req.baseUrl, '/v1beta', `/${modelPath}:generateContent`), req.apiKey, {
    contents: [{ parts }],
    generationConfig,
  })

  const candidate = result?.candidates?.[0]
  const finishReason = String(candidate?.finishReason ?? candidate?.finish_reason ?? '')
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    throw new Error(candidate?.finishMessage || `Gemini 文生图被中断：finishReason=${finishReason}`)
  }
  const image = extractImage(result)
  if (image) return image
  throw new Error(errorMessage(result, 'Gemini 文生图响应缺少图片数据'))
}

/** 增强路径：interactions（官方 host + gemini-3 图片模型；同步直出或轮询交互 id） */
async function generateViaInteractions(req: ImageGenRequest, model: string, prompt: string): Promise<GeneratedImage> {
  const responseFormat: Record<string, unknown> = { type: 'image' }
  const size = parseSize(req.size)
  if (size) {
    responseFormat.aspect_ratio = aspectRatio(size)
    responseFormat.image_size = imageSize(size)
  }

  const result = await postJson(joinApiUrl(req.baseUrl, '/v1beta', '/interactions'), req.apiKey, {
    model: model.replace(/^models\//, ''),
    input: prompt,
    response_format: responseFormat,
  })
  const direct = extractImage(result)
  if (direct) return direct

  const id = result?.id || result?.interaction_id || result?.task_id
  if (!id) throw new Error(errorMessage(result, 'Gemini interactions 响应缺少图片数据或交互 id'))

  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    await sleep(POLL_INTERVAL_MS)
    let task: any
    try {
      task = await getJson(joinApiUrl(req.baseUrl, '/v1beta', `/interactions/${encodeURIComponent(String(id))}`), req.apiKey)
    } catch {
      // POST 已受理，单次查询失败（网络抖动等）容忍重试；POST 阶段失败才回退 generateContent
      if (Date.now() > deadline) throw new Error(`Gemini interactions 轮询超时（>${POLL_TIMEOUT_MS / 60_000} 分钟，id=${id}）`)
      continue
    }
    const status = String(task?.status ?? task?.state ?? '')
    if (/fail|error|cancel/i.test(status)) {
      throw new Error(errorMessage(task, `Gemini interactions 任务失败（${status || '未知状态'}）`))
    }
    const image = extractImage(task)
    if (image) return image
    if (/complete|succeed|success|done/i.test(status)) {
      throw new Error(errorMessage(task, 'Gemini interactions 任务完成但响应中缺少图片'))
    }
    if (Date.now() > deadline) {
      throw new Error(`Gemini interactions 轮询超时（>${POLL_TIMEOUT_MS / 60_000} 分钟，id=${id}）`)
    }
  }
}

/** 图片提取（多形态兜底）：candidates inlineData（generateContent）→ output_image（interactions）→ data[0]/url（网关镜像） */
function extractImage(result: any): GeneratedImage | null {
  const parts = result?.candidates?.[0]?.content?.parts
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data
      if (inline?.data) {
        return { kind: 'base64', data: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' }
      }
    }
  }
  const out = result?.output_image
  if (out?.data) return { kind: 'base64', data: out.data, mime: out.mime_type || out.mimeType || 'image/png' }
  if (typeof out?.url === 'string' && out.url) return { kind: 'url', url: out.url }
  const item = Array.isArray(result?.data) ? result.data[0] : undefined
  if (item?.b64_json) return { kind: 'base64', data: item.b64_json, mime: 'image/png' }
  const url = item?.url || result?.image_url || result?.url
  if (typeof url === 'string' && url) return { kind: 'url', url }
  return null
}

/** 尺寸解析：'1024x1024'（[xX×] 皆可）→ { width, height }；非法/缺省 → null（不传尺寸，用官方默认） */
function parseSize(size?: string): { width: number; height: number } | null {
  const match = String(size || '').trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

/** 宽高比：gcd 化简 → '16:9' 形态 */
function aspectRatio(size: { width: number; height: number }): string {
  const g = gcd(size.width, size.height)
  return `${size.width / g}:${size.height / g}`
}

/** 分辨率档：覆盖请求宽度（>2048 → '4K'、>1024 → '2K'，其余 → '1K'；官方 1K=1024/2K=2048/4K=4096） */
function imageSize(size: { width: number; height: number }): string {
  if (size.width > 2048) return '4K'
  if (size.width > 1024) return '2K'
  return '1K'
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/** 参考图解析：data URL（'data:image/png;base64,...'）→ inline_data；非 data URL 形态跳过 */
function parseReferenceImages(refs?: string[]): { mime: string; data: string }[] {
  const out: { mime: string; data: string }[] = []
  for (const ref of refs ?? []) {
    const match = String(ref || '').trim().match(/^data:(image\/[\w.+-]+);base64,(.+)$/)
    if (match && match[1] && match[2]) out.push({ mime: match[1], data: match[2] })
  }
  return out
}

/** gemini-3 系列图片模型（如 gemini-3-pro-image-preview / gemini-3.1-flash-image） */
function isGemini3Image(model: string): boolean {
  return /gemini-3.*image/i.test(model)
}

/** 官方 host（interactions 端点仅官方支持；中转站镜像域名不在此列） */
function isOfficialHost(baseUrl: string): boolean {
  return /generativelanguage\.googleapis\.com/i.test(baseUrl || '')
}

/** 错误信息聚合：Google 形态 { error: { code, message, status } } → [status] message */
function errorMessage(result: any, fallback: string): string {
  const err = result?.error
  const status = (err && typeof err === 'object' && (err.status || err.code)) || result?.status
  const message =
    (typeof err === 'string' && err) ||
    (err && typeof err === 'object' && err.message) ||
    result?.message ||
    fallback
  return `${status ? `[${status}] ` : ''}${message}`
}

/** baseUrl 兼容带/不带 /v1beta 路径段的网关（与视频/万相/方舟适配器同源） */
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

/** key 双写：x-goog-api-key header 之外再附 ?key=（兼容只认其中一种的中转网关） */
function withApiKey(url: string, apiKey: string): string {
  try {
    const u = new URL(url)
    if (!u.searchParams.has('key')) u.searchParams.set('key', apiKey)
    return u.toString()
  } catch {
    return url
  }
}

/** HTTP 层失败（端点未启用/网络等）：interactions 失败时可安全回退 generateContent */
class HttpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(withApiKey(url, apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new HttpError(`Gemini 文生图请求失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(url: string, apiKey: string): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(withApiKey(url, apiKey), {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new HttpError(`Gemini interactions 查询失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
