import type { GeneratedImage, ImageAdapter, ImageGenRequest } from './types'

/**
 * OpenAI Images API 同步文生图适配器（兼容 gpt-image / dall-e 系列，
 * 亦兼容以 /images/generations 为端点的 OpenAI 兼容网关）。
 */
export class OpenAIImageAdapter implements ImageAdapter {
  readonly provider: string = 'openai_image'
  /** 参考图注入能力：不支持（siliconflow / pollinations 子类继承本声明） */
  readonly referenceImages = 'none'

  async generate(req: ImageGenRequest): Promise<GeneratedImage> {
    const body: Record<string, unknown> = {
      model: req.model ?? 'gpt-image-1',
      prompt: req.prompt,
      n: 1,
    }
    if (req.size) body.size = req.size
    if (req.extra?.quality) body.quality = req.extra.quality

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      const res = await fetch(`${req.baseUrl.replace(/\/+$/, '')}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`图片生成失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
      }
      const data = (await res.json()) as {
        data?: { b64_json?: string; url?: string; revised_prompt?: string }[]
        images?: { b64_json?: string; url?: string }[]
      }
      // OpenAI 兼容网关返回 data[]；SiliconFlow 等镜像响应为 images[]（url 直链）
      const item = data.data?.[0] ?? data.images?.[0]
      if (!item) throw new Error('图片生成响应为空（data[] 缺失）')
      if (item.b64_json) return { kind: 'base64', data: item.b64_json, mime: sniffImageMime(item.b64_json) }
      if (item.url) return { kind: 'url', url: item.url }
      throw new Error('图片生成响应缺少 url/b64_json')
    } finally {
      clearTimeout(timer)
    }
  }
}

/** base64 头部魔数嗅探图片 MIME（PNG/JPEG/WEBP/GIF），未知回退 image/png */
function sniffImageMime(b64: string): string {
  const head = Buffer.from(b64.slice(0, 32), 'base64')
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  return 'image/png'
}