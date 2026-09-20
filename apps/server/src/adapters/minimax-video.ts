/**
 * MiniMax H3 视频生成适配器（M2 从 huobao-drama 搬运，对齐本仓 VideoAdapter 契约）。
 * 端点: POST /v2/video_generation -> { task_id }
 * 轮询: GET  /v2/query/video_generation/{task_id} -> { task: { status, content.url, error } }
 *
 * 仅支持 MiniMax-H3 系列模型。content[] 多模态结构:
 * - text           提示词（必填，≤7000 字符）
 * - image_url      role: first_frame / last_frame / reference_image（参考图 ≤9）
 * - video_url      role: reference_video（≤3）
 * - audio_url      参考音频（≤3），混合总数 ≤12
 *
 * 注意:
 * - 文生视频 ratio 必填且不能为 adaptive；有首帧图（图生视频）时恒为 adaptive，省略 ratio
 * - H3 原生音画同步生成，官方文档无独立 generate_audio 开关，该字段忽略
 */
import type { GeneratedVideo, VideoAdapter, VideoGenRequest } from './types'
import { clampDuration, mapResolution } from './video-capabilities'

/** 仅支持 MiniMax-H3 系列（前缀匹配，兼容未来 H3.x 变体） */
const H3_MODEL_PREFIX = 'minimax-h3'
const DEFAULT_MODEL = 'MiniMax-H3'

/** 多模态参考素材上限：图片 9、视频 3、音频 3，混合总数 12 */
const REF_LIMITS = { images: 9, videos: 3, audios: 3, total: 12 } as const

const PROMPT_MAX_CHARS = 7000

/** MiniMax 支持的宽高比 */
const VALID_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])

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

/** baseUrl 兼容带/不带前缀的网关（/v2 段若已被 baseUrl 路径含盖则不重复拼接） */
function joinApiUrl(baseUrl: string, path: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '')
  if (!base) return path
  try {
    const url = new URL(base)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
    return url.toString()
  } catch {
    return `${base}${path.startsWith('/') ? path : `/${path}`}`
  }
}

export class MiniMaxVideoAdapter implements VideoAdapter {
  readonly provider = 'minimax_video'
  /** 首帧注入能力：实现已就绪（first_frame role），仅补声明 */
  readonly firstFrame = 'base64'
  /** [M13] 参考图注入能力：reference_image role（经 extra.referenceImageUrls，≤9 张；混合总数 ≤12） */
  readonly referenceImages = 'base64'

  async generate(req: VideoGenRequest): Promise<GeneratedVideo> {
    const model = req.model || DEFAULT_MODEL
    if (!model.toLowerCase().startsWith(H3_MODEL_PREFIX)) {
      throw new Error(`仅支持 MiniMax H3 系列模型（MiniMax-H3*），当前: ${model}`)
    }

    const prompt = (req.prompt || '').trim()
    const extra = req.extra ?? {}
    const refImages = parseUrlArray(extra.referenceImageUrls)
    const refVideos = parseUrlArray(extra.referenceVideoUrls)
    const refAudios = parseUrlArray(extra.referenceAudioUrls)
    const firstFrame = (req.firstFrameUrl || req.imageUrl || '').trim()
    const lastFrame = (req.lastFrameUrl || '').trim()

    if (!prompt) throw new Error('MiniMax H3 要求必须提供提示词（text content）')
    if (prompt.length > PROMPT_MAX_CHARS) {
      throw new Error(`提示词超长：MiniMax H3 上限 ${PROMPT_MAX_CHARS} 字符，当前 ${prompt.length}`)
    }

    const totalRefs =
      refImages.length + refVideos.length + refAudios.length + (firstFrame ? 1 : 0) + (lastFrame ? 1 : 0)
    if (
      refImages.length > REF_LIMITS.images ||
      refVideos.length > REF_LIMITS.videos ||
      refAudios.length > REF_LIMITS.audios ||
      totalRefs > REF_LIMITS.total
    ) {
      throw new Error(
        `参考素材超限：图片≤${REF_LIMITS.images}、视频≤${REF_LIMITS.videos}、音频≤${REF_LIMITS.audios}、总数≤${REF_LIMITS.total}`,
      )
    }

    const content: Record<string, unknown>[] = [{ type: 'text', text: prompt }]
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
    if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' })
    for (const url of refImages) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of refVideos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of refAudios) {
      content.push({ type: 'audio_url', audio_url: { url } })
    }

    const body: Record<string, unknown> = {
      model,
      content,
      // [M32] 时长/分辨率归一委托单一真源表（消除本地魔法数，与档位声明同源）
      duration: clampDuration('minimax_video', model, req.duration),
      resolution: mapResolution('minimax_video', req.resolution),
    }

    // 图生视频（有首帧）ratio 恒为 adaptive，省略；文生视频 ratio 必填
    if (!firstFrame) {
      const ratio = (req.aspectRatio || '').trim()
      body.ratio = VALID_RATIOS.has(ratio) ? ratio : '16:9'
    }

    const data = await postJson(joinApiUrl(req.baseUrl, '/v2/video_generation'), req.apiKey, body)
    if (data.task_id) return { kind: 'poll', taskId: String(data.task_id) }
    const videoUrl = data.task?.content?.url || data.content?.url || data.video_url
    if (videoUrl) return { kind: 'url', url: videoUrl }
    throw new Error('MiniMax 响应缺少 task_id 或视频 URL')
  }

  async query(
    taskId: string,
    req: { baseUrl: string; apiKey: string },
  ): Promise<{ status: 'pending' | 'processing' | 'completed' | 'failed'; url?: string; error?: string }> {
    const data = await getJson(joinApiUrl(req.baseUrl, `/v2/query/video_generation/${encodeURIComponent(taskId)}`), req.apiKey)
    // 官方响应为 { task: { status, content: { url }, error } }，兼容顶层平铺
    const task = data.task && typeof data.task === 'object' ? data.task : data
    const status: string = task.status ?? ''
    if (status === 'succeeded') {
      return { status: 'completed', url: task.content?.url || task.video_url }
    }
    if (status === 'failed' || status === 'cancelled') {
      const err = task.error
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
