/**
 * 火山引擎 Seedance 2.0 视频生成适配器（M2 从 huobao-drama 搬运，对齐本仓 VideoAdapter 契约）。
 * 端点: POST /api/v3/contents/generations/tasks (注意 /api/v3 前缀)
 * 提交响应: { id: "task-xxx" } -> 轮询 GET /api/v3/contents/generations/tasks/{id}
 *
 * 仅支持 Doubao Seedance 2.x 系列模型（需在方舟控制台开通），生成模式只保留多模态参考:
 * - reference   多模态参考（≤9 reference_image + ≤3 reference_video + ≤3 reference_audio + 可选文本）
 *   有参考音频时至少包含 1 个参考图片或视频
 * - 首帧/尾帧（M6）：content role first_frame / last_frame（排在参考素材之前；role 依据实弹对表）
 */
import type { GeneratedVideo, VideoAdapter, VideoGenRequest } from './types'
import { clampDuration, mapResolution } from './video-capabilities'

/** 仅支持 Seedance 2.x 系列（前缀匹配：2-0/2-5 及未来 2.x 变体；1.x 已陆续下架） */
const SEEDANCE2_MODEL_PREFIX = 'doubao-seedance-2'
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
  /** 首帧注入能力：first_frame role（实弹对表若被拒则收敛 'as-reference' 并回写 spec §6-4 注记） */
  readonly firstFrame = 'base64'
  /** [M13] 参考图注入能力：reference_image role（经 extra.referenceImageUrls，≤9 张） */
  readonly referenceImages = 'base64'

  async generate(req: VideoGenRequest): Promise<GeneratedVideo> {
    const model = req.model || DEFAULT_MODEL
    if (!model.startsWith(SEEDANCE2_MODEL_PREFIX)) {
      throw new Error(`仅支持 Seedance 2.x 系列模型（${SEEDANCE2_MODEL_PREFIX}-*；1.x 已下架），当前: ${model}`)
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
    const hasFrames = !!req.firstFrameUrl || !!req.lastFrameUrl
    if (!prompt && !refImages.length && !refVideos.length && !refAudios.length && !hasFrames) {
      throw new Error('多模态参考模式需要至少一个参考素材或 prompt')
    }

    const content: Record<string, unknown>[] = []
    if (prompt) content.push({ type: 'text', text: prompt })
    // 首帧/尾帧（M6）：data URI 首帧排参考素材之前；实弹对表——若官方拒绝 first_frame 则改 reference_image 并更声明
    if (req.firstFrameUrl) content.push({ type: 'image_url', image_url: { url: req.firstFrameUrl }, role: 'first_frame' })
    if (req.lastFrameUrl) content.push({ type: 'image_url', image_url: { url: req.lastFrameUrl }, role: 'last_frame' })
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
      // [M32] 时长/分辨率归一委托单一真源表（与档位声明同源；Seedance 2.0 仅 480p/720p 两档）
      duration: clampDuration('volcengine_video', model, req.duration),
      resolution: mapResolution('volcengine_video', req.resolution),
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

/**
 * 零计费连通探针（连通测试用）：空请求体提交视频任务——缺少 model 必被服务端拒绝
 * （400 MissingParameter），仅验证「端点可达 + 鉴权有效」，不会创建计费任务。
 * 返回成功说明文案；端点/鉴权异常抛错（保留官方 code/message）。
 */
export async function probeVolcengineVideoEndpoint(ep: { baseUrl: string; apiKey: string }): Promise<string> {
  const url = joinApiUrl(ep.baseUrl, '/api/v3', '/contents/generations/tasks')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
      body: '{}',
      signal: controller.signal,
    })
    const data: any = await res.json().catch(() => null)
    const code = String(data?.error?.code ?? data?.code ?? '')
    const message = String(data?.error?.message ?? data?.message ?? '')
    if (res.status === 401 || res.status === 403 || code === 'AuthenticationError') {
      throw new Error(`[${code || res.status}] ${message || '鉴权失败，请检查 API Key'}`)
    }
    if (res.ok) {
      // 空体不应创建任务（缺 model）；出现 2xx 说明响应异常，保守报错避免误判连通
      throw new Error(`视频连通探针响应异常（HTTP ${res.status}，预期参数缺失 400）`)
    }
    if (res.status === 400 && (code === 'MissingParameter' || code.startsWith('InvalidParameter') || code.startsWith('BadRequest'))) {
      return '端点与鉴权连通（空请求探针零计费，未创建生成任务）；注意所选模型需已在方舟控制台开通'
    }
    throw new Error(`视频连通探针异常 HTTP ${res.status}${code ? ` [${code}]` : ''}${message ? `: ${message}` : ''}`)
  } finally {
    clearTimeout(timer)
  }
}
