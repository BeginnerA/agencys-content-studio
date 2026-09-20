import type { GeneratedVideo, VideoAdapter, VideoGenRequest } from './types'
import { snapPollinationsDuration } from './video-capabilities'

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
  /** 首帧注入能力：不支持 */
  readonly firstFrame = 'none'

  async generate(req: VideoGenRequest): Promise<GeneratedVideo> {
    const params = new URLSearchParams()
    const model = req.model ?? DEFAULT_MODEL
    params.set('model', model)
    if (typeof req.duration === 'number' && req.duration > 0) {
      // [M32] 时长取档委托单一真源表（minimax 系就近 5/10/15，其余四舍五入透传）
      params.set('duration', String(snapPollinationsDuration(model, req.duration)))
    }
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

/** 取根域名（balance 端点在根域；baseUrl 常带 /v1 尾缀） */
function rootUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return (baseUrl || '').replace(/\/+$/, '')
  }
}

/**
 * 零计费连通探针（连通测试用）：GET /account/balance——鉴权有效返回 200（含余额），
 * 无效 key 返回 401；不消耗任何额度（视频同步生成成本高，不宜用真实 run 探测）。
 * 返回成功说明文案；鉴权/端点异常抛错。
 */
export async function probePollinationsVideoEndpoint(ep: { baseUrl: string; apiKey: string }): Promise<string> {
  const url = `${rootUrl(ep.baseUrl)}/account/balance`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ep.apiKey}` },
      signal: controller.signal,
    })
    const text = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(`鉴权失败（HTTP ${res.status}）：请检查 API Key`)
    }
    if (res.ok) {
      const data: any = (() => {
        try { return JSON.parse(text) } catch { return null }
      })()
      const balance = typeof data?.balance === 'number' ? `（账户余额 ${data.balance} pollen）` : ''
      return `端点与鉴权连通${balance}（余额接口零计费探针，未创建生成任务）`
    }
    throw new Error(`视频连通探针异常 HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  } finally {
    clearTimeout(timer)
  }
}
