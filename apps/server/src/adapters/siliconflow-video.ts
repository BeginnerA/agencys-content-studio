/**
 * SiliconFlow 视频生成适配器（M2 视频通道扩展：用户唯一可用网关为 SiliconFlow）。
 * 端点: POST /video/submit  -> { requestId }（提交，结果 URL 有效期 10 分钟）
 * 轮询: POST /video/status  { requestId } -> { status, reason, results: { videos: [{ url }] } }
 *
 * 状态映射: Succeed→completed / InQueue→pending / InProgress→processing / Failed→failed。
 * 模型默认 Wan-AI/Wan2.2-T2V-A14B（文生视频，对齐 ai_video v1 纯 prompt 驱动）；
 * 若请求带首帧图（imageUrl/firstFrameUrl，需公网可访 URL 或 data: base64）→ 用 Wan2.2-I2V 图生视频。
 * image_size 仅支持 1280x720 / 720x1280 / 960x960 三档，由 aspectRatio 映射。
 */
import type { GeneratedVideo, VideoAdapter, VideoGenRequest } from './types'

const DEFAULT_MODEL_T2V = 'Wan-AI/Wan2.2-T2V-A14B'
const DEFAULT_MODEL_I2V = 'Wan-AI/Wan2.2-I2V-A14B'

/** image_size 三档（官方枚举） */
const SIZE_LANDSCAPE = '1280x720'
const SIZE_PORTRAIT = '720x1280'
const SIZE_SQUARE = '960x960'

/** baseUrl 兼容带/不带路径段的网关（默认配置为 https://api.siliconflow.cn/v1） */
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

/** aspectRatio/resolution → image_size（三档枚举；无法识别时按横屏 1280x720） */
function normalizeImageSize(aspectRatio?: string, resolution?: string): string {
  const ratio = (aspectRatio || '').trim()
  if (ratio === '9:16' || ratio === '3:4' || ratio === '2:3') return SIZE_PORTRAIT
  if (ratio === '1:1') return SIZE_SQUARE
  if (ratio === '16:9' || ratio === '4:3' || ratio === '3:2' || ratio === '21:9') return SIZE_LANDSCAPE
  // 未给宽高比时按 resolution 兜底：纵向档位（如 720x1280）走竖屏
  const res = (resolution || '').trim().toLowerCase()
  if (/^\d+x\d+$/.test(res)) {
    const [w, h] = res.split('x').map((n) => Number(n))
    if (w && h) return h > w ? SIZE_PORTRAIT : w === h ? SIZE_SQUARE : SIZE_LANDSCAPE
  }
  return SIZE_LANDSCAPE
}

export class SiliconFlowVideoAdapter implements VideoAdapter {
  readonly provider = 'siliconflow_video'

  async generate(req: VideoGenRequest): Promise<GeneratedVideo> {
    const prompt = (req.prompt || '').trim()
    if (!prompt) throw new Error('SiliconFlow 视频生成要求提供提示词')

    const firstFrame = (req.firstFrameUrl || req.imageUrl || '').trim()
    const model = req.model?.trim() || (firstFrame ? DEFAULT_MODEL_I2V : DEFAULT_MODEL_T2V)
    if (firstFrame && !/i2v/i.test(model)) {
      throw new Error(`带首帧图的视频生成需使用 I2V 模型（如 ${DEFAULT_MODEL_I2V}），当前: ${model}`)
    }

    const body: Record<string, unknown> = {
      model,
      prompt,
      image_size: normalizeImageSize(req.aspectRatio, req.resolution),
    }
    if (firstFrame) body.image = firstFrame
    const negativePrompt = req.extra?.negative_prompt
    if (typeof negativePrompt === 'string' && negativePrompt.trim()) body.negative_prompt = negativePrompt.trim()

    const data = await postJson(joinApiUrl(req.baseUrl, '/video/submit'), req.apiKey, body)
    if (data.requestId) return { kind: 'poll', taskId: String(data.requestId) }
    const videoUrl = data.videos?.[0]?.url || data.results?.videos?.[0]?.url || data.video_url
    if (videoUrl) return { kind: 'url', url: videoUrl }
    throw new Error('SiliconFlow 响应缺少 requestId 或视频 URL')
  }

  async query(
    taskId: string,
    req: { baseUrl: string; apiKey: string },
  ): Promise<{ status: 'pending' | 'processing' | 'completed' | 'failed'; url?: string; error?: string }> {
    const data = await postJson(joinApiUrl(req.baseUrl, '/video/status'), req.apiKey, { requestId: taskId })
    const status: string = data.status ?? ''
    if (status === 'Succeed') {
      const url = data.results?.videos?.[0]?.url || data.videos?.[0]?.url
      if (!url) return { status: 'failed', error: 'SiliconFlow 任务成功但缺少视频 URL' }
      return { status: 'completed', url }
    }
    if (status === 'Failed') {
      return { status: 'failed', error: typeof data.reason === 'string' && data.reason ? data.reason : '视频生成失败' }
    }
    if (status === 'InQueue') return { status: 'pending' }
    return { status: 'processing' }
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
      throw new Error(`视频生成请求失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}
