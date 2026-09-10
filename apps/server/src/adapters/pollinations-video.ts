import type { GeneratedVideo, VideoAdapter, VideoGenRequest } from './types'

/**
 * Pollinations 视频适配器（gen.pollinations.ai，M2.1 接入）。
 * 协议：GET {baseUrl}/video/{prompt}?model=&duration=&aspectRatio=&resolution=&image=&audio=&seed=
 *   → Authorization: Bearer sk_…，同步长请求直接返回 video/mp4 字节（生成耗时分钟级，无 submit/poll 两段式）。
 * 因产物直链需鉴权（401）且生成耗时远超通用下载超时（120s），本适配器在 generate 内
 *  以长超时收取完整字节，返回 {kind:'base64'} 交由管线直存（不走二次下载）。
 * 注意：baseUrl 须为根地址 https://gen.pollinations.ai（非 /v1）。
 */
const DEFAULT_MODEL = 'google/veo-3.1-fast'
const REQUEST_TIMEOUT_MS = 10 * 60_000

export class PollinationsVideoAdapter implements VideoAdapter {
  readonly provider = 'pollinations_video'

  async generate(req: VideoGenRequest): Promise<GeneratedVideo> {
    const params = new URLSearchParams()
    params.set('model', req.model ?? DEFAULT_MODEL)
    if (typeof req.duration === 'number' && req.duration > 0) params.set('duration', String(Math.round(req.duration)))
    if (req.aspectRatio) params.set('aspectRatio', req.aspectRatio)
    if (req.resolution) params.set('resolution', req.resolution)
    if (req.imageUrl) params.set('image', req.imageUrl)
    if (req.extra?.['audio'] === true) params.set('audio', 'true')
    if (typeof req.extra?.['seed'] === 'number') params.set('seed', String(req.extra['seed']))

    const url = `${req.baseUrl.replace(/\/+$/, '')}/video/${encodeURIComponent(req.prompt)}?${params.toString()}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${req.apiKey}` },
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`视频生成失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
      }
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength === 0) throw new Error('视频生成响应为空（0 字节）')
      return { kind: 'base64', data: Buffer.from(buf).toString('base64'), mime: 'video/mp4' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 同步协议无轮询查询；保留接口实现防误用 */
  async query(_taskId: string, _req: { baseUrl: string; apiKey: string }): Promise<never> {
    throw new Error('pollinations_video 为同步长请求协议，不支持轮询查询')
  }
}
