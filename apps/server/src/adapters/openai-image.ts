import type { GeneratedImage, ImageAdapter, ImageGenRequest } from './types'

/**
 * OpenAI Images API 同步文生图适配器（兼容 gpt-image / dall-e 系列，
 * 亦兼容以 /images/generations 为端点的 OpenAI 兼容网关）。
 */
export class OpenAIImageAdapter implements ImageAdapter {
  readonly provider = 'openai_image'

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
      }
      const item = data.data?.[0]
      if (!item) throw new Error('图片生成响应为空（data[] 缺失）')
      if (item.b64_json) return { kind: 'base64', data: item.b64_json, mime: 'image/png' }
      if (item.url) return { kind: 'url', url: item.url }
      throw new Error('图片生成响应缺少 url/b64_json')
    } finally {
      clearTimeout(timer)
    }
  }
}
