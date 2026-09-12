/**
 * 阿里云百炼万相 Wan 3.0 视频生成适配器（M2 从 huobao-drama 搬运，对齐本仓 VideoAdapter 契约）。
 *
 * 官方协议：
 * - POST /api/v1/services/aigc/video-generation/video-synthesis（X-DashScope-Async: enable）
 * - GET  /api/v1/tasks/{task_id}
 * - 仅支持 wan3.0-video-prime / wan3.0-video
 * - 请求体为 { model, input: { prompt, media }, parameters }
 * - 异步响应为 { output: { task_id, task_status }, request_id }
 */
import type { GeneratedVideo, VideoAdapter, VideoGenRequest } from './types'

const SUPPORTED_MODELS = new Set(['wan3.0-video-prime', 'wan3.0-video'])
const DEFAULT_MODEL = 'wan3.0-video-prime'
const PROMPT_MAX_CHARS = 20_000
const MAX_SEED = 2_147_483_647
const REF_LIMITS = { images: 10, videos: 5, audios: 5, total: 20 } as const
const VALID_RATIOS = new Set(['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'])
const VALID_RESOLUTIONS = new Set(['480P', '720P', '1080P'])

type WanMediaType = 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video' | 'reference_audio'

interface WanMedia {
  type: WanMediaType
  url: string
}

function parseUrlArray(raw: unknown): string[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else if (raw) {
    try {
      const arr = JSON.parse(String(raw))
      if (Array.isArray(arr)) list = arr
    } catch {
      /* 非法 JSON 视为空 */
    }
  }
  return list
    .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    .map((u) => u.trim())
}

function cleanUrl(value?: string | null): string {
  return String(value || '').trim()
}

function validateMediaUrl(type: WanMediaType, url: string): void {
  const isWebUrl = /^https?:\/\//i.test(url)
  const isOssUrl = /^oss:\/\//i.test(url)
  const isImageData = /^data:image\/(?:jpeg|jpg|png|bmp|webp);base64,/i.test(url)
  if (type === 'first_frame' || type === 'last_frame' || type === 'reference_image') {
    if (isWebUrl || isOssUrl || isImageData) return
    throw new Error(`Wan 3.0 ${type} 需要 HTTP(S)/OSS 图片 URL 或官方支持的图片 Base64`)
  }
  if (isWebUrl || isOssUrl) return
  throw new Error(`Wan 3.0 ${type} 仅支持 HTTP(S) 或 OSS URL`)
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback
  return value !== false && value !== 0
}

function errorMessage(result: any, fallback: string): string {
  const output = result?.output && typeof result.output === 'object' ? result.output : {}
  const code = output.code || result?.code
  const message = output.message || result?.message || fallback
  const requestId = result?.request_id
  return `${code ? `[${code}] ` : ''}${message}${requestId ? ` (request_id: ${requestId})` : ''}`
}

/** baseUrl 兼容带/不带 /api/v1 路径段的网关 */
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

export class AliyunWanVideoAdapter implements VideoAdapter {
  readonly provider = 'aliyun_wan_video'
  /** 首帧注入能力：实现已就绪（接受 data URI 首帧），仅补声明 */
  readonly firstFrame = 'base64'
  /** [M13] 参考图注入能力：reference_image 类型（经 extra.referenceImageUrls，≤10 张）；与帧模式互斥由注入侧「首帧优先」决策规避 */
  readonly referenceImages = 'base64'

  async generate(req: VideoGenRequest): Promise<GeneratedVideo> {
    const model = cleanUrl(req.model) || DEFAULT_MODEL
    if (!SUPPORTED_MODELS.has(model)) {
      throw new Error(`Wan 3.0 仅支持 wan3.0-video-prime 或 wan3.0-video，当前: ${model}`)
    }

    // 官方对超过 20000 字符的部分自动截断；同时将项目内部 @图片N 标记转为官方的 图N 引用。
    const prompt = cleanUrl(req.prompt).replace(/@图片(\d+)/g, '图$1').slice(0, PROMPT_MAX_CHARS)

    const extra = req.extra ?? {}
    const refImages = parseUrlArray(extra.referenceImageUrls)
    const refVideos = parseUrlArray(extra.referenceVideoUrls)
    const refAudios = parseUrlArray(extra.referenceAudioUrls)
    const firstFrame = cleanUrl(req.firstFrameUrl || req.imageUrl)
    const lastFrame = cleanUrl(req.lastFrameUrl)

    this.validateMedia({ refImages, refVideos, refAudios, firstFrame, lastFrame })

    const media: WanMedia[] = []
    if (firstFrame) media.push({ type: 'first_frame', url: firstFrame })
    if (lastFrame) media.push({ type: 'last_frame', url: lastFrame })
    for (const url of refImages) media.push({ type: 'reference_image', url })
    for (const url of refVideos) media.push({ type: 'reference_video', url })
    for (const url of refAudios) media.push({ type: 'reference_audio', url })
    for (const item of media) validateMediaUrl(item.type, item.url)

    if (!prompt && media.length === 0) {
      throw new Error('Wan 3.0 的 input.prompt 和 input.media 至少需要提供一项')
    }

    const input: { prompt?: string; media?: WanMedia[] } = {}
    if (prompt) input.prompt = prompt
    if (media.length) input.media = media

    const parameters: Record<string, string | number | boolean> = {
      resolution: this.normalizeResolution(req.resolution),
      ratio: normalizeRatio(req.aspectRatio),
      duration: this.normalizeDuration(req.duration),
      audio: booleanValue(extra.generateAudio, true),
      prompt_extend: booleanValue(extra.promptExtend, true),
      watermark: booleanValue(extra.watermark, false),
    }

    if (extra.seed !== null && extra.seed !== undefined) {
      const seed = Number(extra.seed)
      if (!Number.isInteger(seed) || (seed !== -1 && (seed < 0 || seed > MAX_SEED))) {
        throw new Error(`Wan 3.0 seed 必须为 -1 或 0~${MAX_SEED} 的整数`)
      }
      parameters.seed = seed
    }

    const data = await postJson(
      joinApiUrl(req.baseUrl, '/api/v1', '/services/aigc/video-generation/video-synthesis'),
      req.apiKey,
      { model, input, parameters },
    )
    const taskId = data?.output?.task_id
    if (taskId) return { kind: 'poll', taskId: String(taskId) }
    throw new Error(errorMessage(data, 'Wan 3.0 响应中缺少 output.task_id'))
  }

  async query(
    taskId: string,
    req: { baseUrl: string; apiKey: string },
  ): Promise<{ status: 'pending' | 'processing' | 'completed' | 'failed'; url?: string; error?: string }> {
    const data = await getJson(
      joinApiUrl(req.baseUrl, '/api/v1', `/tasks/${encodeURIComponent(taskId)}`),
      req.apiKey,
    )
    const output = data?.output && typeof data.output === 'object' ? data.output : {}
    switch (output.task_status) {
      case 'PENDING':
        return { status: 'pending' }
      case 'RUNNING':
        return { status: 'processing' }
      case 'SUCCEEDED':
        if (!output.video_url) {
          return { status: 'failed', error: errorMessage(data, 'Wan 3.0 任务成功但响应中缺少 output.video_url') }
        }
        return { status: 'completed', url: output.video_url }
      case 'FAILED':
        return { status: 'failed', error: errorMessage(data, 'Wan 3.0 视频生成失败') }
      case 'CANCELED':
        return { status: 'failed', error: errorMessage(data, 'Wan 3.0 任务已取消') }
      case 'UNKNOWN':
        return { status: 'failed', error: errorMessage(data, 'Wan 3.0 任务不存在或已超过 24 小时查询有效期') }
      default:
        if (data?.code || data?.message || output.code || output.message) {
          return { status: 'failed', error: errorMessage(data, 'Wan 3.0 任务查询失败') }
        }
        return { status: 'processing' }
    }
  }

  private validateMedia(input: {
    refImages: string[]
    refVideos: string[]
    refAudios: string[]
    firstFrame: string
    lastFrame: string
  }): void {
    const { refImages, refVideos, refAudios, firstFrame, lastFrame } = input
    if (
      refImages.length > REF_LIMITS.images ||
      refVideos.length > REF_LIMITS.videos ||
      refAudios.length > REF_LIMITS.audios
    ) {
      throw new Error(
        `Wan 3.0 参考素材超限：图片≤${REF_LIMITS.images}、视频≤${REF_LIMITS.videos}、音频≤${REF_LIMITS.audios}`,
      )
    }
    if (lastFrame && !firstFrame) throw new Error('Wan 3.0 尾帧必须与首帧同时传入')

    const hasFrameMode = Boolean(firstFrame || lastFrame)
    const hasReferenceMode = Boolean(refImages.length || refVideos.length || refAudios.length)
    if (hasFrameMode && hasReferenceMode) {
      throw new Error('Wan 3.0 的 first_frame/last_frame 不能与 reference_* 素材混用')
    }

    const total =
      refImages.length +
      refVideos.length +
      refAudios.length +
      (firstFrame ? 1 : 0) +
      (lastFrame ? 1 : 0)
    if (total > REF_LIMITS.total) throw new Error(`Wan 3.0 input.media 最多 ${REF_LIMITS.total} 项`)
  }

  private normalizeDuration(duration?: number): number {
    if (duration === null || duration === undefined) return 5
    const value = Number(duration)
    if (!Number.isInteger(value) || (value !== -1 && (value < 2 || value > 30))) {
      throw new Error('Wan 3.0 duration 必须为 -1 或 2~30 的整数')
    }
    return value
  }

  private normalizeResolution(resolution?: string): string {
    const value = cleanUrl(resolution).toUpperCase() || '1080P'
    if (!VALID_RESOLUTIONS.has(value)) {
      throw new Error('Wan 3.0 resolution 仅支持 480P、720P 或 1080P')
    }
    return value
  }
}

function normalizeRatio(ratio?: string): string {
  const value = cleanUrl(ratio) || 'adaptive'
  if (!VALID_RATIOS.has(value)) {
    throw new Error('Wan 3.0 ratio 仅支持 adaptive、16:9、4:3、1:1、3:4 或 9:16')
  }
  return value
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`视频生成提交失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
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
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`视频任务查询失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 零计费连通探针（连通测试用）：空请求体提交视频任务——缺少 model 必被服务端拒绝
 * （400 BadRequest.EmptyModel），仅验证「端点可达 + 鉴权有效」，不会创建计费任务。
 * 返回成功说明文案；端点/鉴权异常抛错（保留官方 code/message）。
 */
export async function probeAliyunWanVideoEndpoint(ep: { baseUrl: string; apiKey: string }): Promise<string> {
  const url = joinApiUrl(ep.baseUrl, '/api/v1', '/services/aigc/video-generation/video-synthesis')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ep.apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: '{}',
      signal: controller.signal,
    })
    const data: any = await res.json().catch(() => null)
    const code = String(data?.code ?? '')
    const message = String(data?.message ?? '')
    if (res.status === 401 || res.status === 403 || code === 'InvalidApiKey') {
      throw new Error(`[${code || res.status}] ${message || '鉴权失败，请检查 API Key'}`)
    }
    if (res.ok) {
      // 空体不应创建任务（缺 model）；出现 2xx 说明响应异常，保守报错避免误判连通
      throw new Error(`视频连通探针响应异常（HTTP ${res.status}，预期参数缺失 400）`)
    }
    if (res.status === 400 && (code.startsWith('BadRequest') || code.startsWith('InvalidParameter'))) {
      return '端点与鉴权连通（空请求探针零计费，未创建生成任务）；真实生成请用 run 验证'
    }
    throw new Error(`视频连通探针异常 HTTP ${res.status}${code ? ` [${code}]` : ''}${message ? `: ${message}` : ''}`)
  } finally {
    clearTimeout(timer)
  }
}
