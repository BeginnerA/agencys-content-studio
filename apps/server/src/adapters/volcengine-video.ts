/**
 * 火山引擎 Seedance 2.0 视频生成适配器（M2 从 huobao-drama 搬运，对齐本仓 VideoAdapter 契约）。
 * 端点: POST /api/v3/contents/generations/tasks (注意 /api/v3 前缀)
 * 提交响应: { id: "task-xxx" } -> 轮询 GET /api/v3/contents/generations/tasks/{id}
 *
 * 仅支持 Doubao Seedance 2.0+ 系列模型，生成模式只保留多模态参考:
 * - reference   多模态参考（≤9 reference_image + ≤3 reference_video + ≤3 reference_audio + 可选文本）
 *   有参考音频时至少包含 1 个参考图片或视频
 */
import type { GeneratedVideo, VideoAdapter, VideoGenRequest } from './types'

/** 仅支持 Seedance 2.0+ 系列（前缀匹配，兼容未来 2.0.x 变体） */
const SEEDANCE2_MODEL_PREFIX = 'doubao-seedance-2-0'
const DEFAULT_MODEL = 'doubao-seedance-2-0-mini-260615'

/** 多模态参考素材上限：图片 9、视频 3、音频 3 */
const REF_LIMITS = { images: 9, videos: 3, audios: 3 } as const

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
  return list.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
}

/** baseUrl 兼容带/不带 /api/v3 路径段的网关 */
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

export class VolcEngineVideoAdapter implements VideoAdapter {
  readonly provider = 'volcengine_video'

  async generate(req: VideoGenRequest): Promise<GeneratedVideo> {
    const model = req.model || DEFAULT_MODEL
    if (!model.startsWith(SEEDANCE2_MODEL_PREFIX)) {
      throw new Error(`仅支持 Seedance 2.0 系列模型（${SEEDANCE2_MODEL_PREFIX}-*），当前: ${model}`)
    }

    const prompt = (req.prompt || '').trim()
    const extra = req.extra ?? {}
    const refImages = parseUrlArray(extra.referenceImageUrls)
    const refVideos = parseUrlArray(extra.referenceVideoUrls)
    const refAudios = parseUrlArray(extra.referenceAudioUrls)

    if (
      refImages.length > REF_LIMITS.images ||
      refVideos.length > REF_LIMITS.videos ||
      refAudios.length > REF_LIMITS.audios
    ) {
      throw new Error(
        `参考素材超限：图片≤${REF_LIMITS.images}、视频≤${REF_LIMITS.videos}、音频≤${REF_LIMITS.audios}`,
      )
    }
    if (refAudios.length > 0 && refImages.length + refVideos.length === 0) {
      throw new Error('参考音频需要至少 1 个参考图片或视频')
    }
    if (!prompt && !refImages.length && !refVideos.length && !refAudios.length) {
      throw new Error('多模态参考模式需要至少一个参考素材或 prompt')
    }

    const content: Record<string, unknown>[] = []
    if (prompt) content.push({ type: 'text', text: prompt })
    for (const url of refImages) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of refVideos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of refAudios) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
    }

    const generateAudio = extra.generateAudio
    const body: Record<string, unknown> = {
      model,
      content,
      generate_audio: generateAudio !== 0 && generateAudio !== false,
      ratio: req.aspectRatio || 'adaptive',
      duration: normalizeDuration(req.duration),
      // Seedance 2.0 仅 480p/720p 两档，1080p 收敛到 720p
      resolution: req.resolution === '480p' ? '480p' : '720p',
      watermark: extra.watermark === true,
    }

    const data = await postJson(joinApiUrl(req.baseUrl, '/api/v3', '/contents/generations/tasks'), req.apiKey, body)
    if (data.id) return { kind: 'poll', taskId: String(data.id) }
    const videoUrl = data.video_url || data.content?.video_url || data.data?.video_url
    if (videoUrl) return { kind: 'url', url: videoUrl }
    throw new Error('火山引擎响应缺少 task id 或视频 URL')
  }

  async query(
    taskId: string,
    req: { baseUrl: string; apiKey: string },
  ): Promise<{ status: 'pending' | 'processing' | 'completed' | 'failed'; url?: string; error?: string }> {
    const data = await getJson(
      joinApiUrl(req.baseUrl, '/api/v3', `/contents/generations/tasks/${encodeURIComponent(taskId)}`),
      req.apiKey,
    )
    const status: string = data.status ?? ''
    if (status === 'succeeded') {
      const url = data.video_url || data.content?.video_url || data.data?.video_url
      return { status: 'completed', url }
    }
    if (status === 'failed') {
      // 上游 error 可能是对象 { code, message }（如 OutputVideoSensitiveContentDetected），规范成字符串
      const err = data.error
      const msg = typeof err === 'string' ? err : err?.message || JSON.stringify(err) || '视频生成失败'
      const code = err && typeof err === 'object' && err.code ? `[${err.code}] ` : ''
      return { status: 'failed', error: `${code}${msg}` }
    }
    return { status: (status as 'processing') || 'processing' }
  }
}

function normalizeDuration(duration?: number): number {
  const parsed = Math.round(Number(duration || 5))
  if (!Number.isFinite(parsed)) return 5
  // Seedance 2.0 支持 4-15 秒
  return Math.min(15, Math.max(4, parsed))
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
