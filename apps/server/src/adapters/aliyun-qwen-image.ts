/**
 * 阿里云百炼千问图像（Qwen-Image 系列）文生图适配器（同步直返）。
 *
 * 官方协议（2026-09 实测）：
 * - POST {base}/api/v1/services/aigc/multimodal-generation/generation（同步，无 X-DashScope-Async）
 *   请求体 { model, input: { messages: [{ role:'user', content: [{ text }] }] }, parameters }
 *   成功取 output.choices[].message.content[].image（URL 24 小时有效）
 * - 覆盖 qwen-image-3.0-pro / qwen-image-3.0 / qwen-image-2.0-pro / qwen-image-max / qwen-image-plus；
 *   万相 wan2.7 系列同端点同形态（由万相适配器的同步分支复用该协议）。
 * - size 为「宽*高」格式：3.0/2.0 系列支持 512²~2048² 任意尺寸；max/plus 仅支持官方固定枚举
 *   （1664*928 / 1328*1328 等）→ 缺省不传即用官方默认，勿硬塞 1024*1024。
 * - 注意：DashScope 公共域（dashscope.aliyuncs.com）的 OpenAI 兼容端点
 *   compatible-mode/v1/images/generations 不存在（404，仅 {WorkspaceId}.maas.aliyuncs.com 域提供），
 *   必须走上述原生端点。
 * - 官方建议图像生成客户端超时 ≥600s（大 n/并发场景）；本仓固定 n=1，适配器取 300s（实测 ~7s 出图）。
 */
import type { GeneratedImage, ImageAdapter, ImageGenRequest } from './types'

const DEFAULT_MODEL = 'qwen-image-3.0'
const REQUEST_TIMEOUT_MS = 300_000

export class AliyunQwenImageAdapter implements ImageAdapter {
  /** 百炼统一目录 key；本类仅作千问同步直返协议实现由 AliyunBailianImageAdapter 委托调用 */
  readonly provider = 'aliyun_bailian_image'
  /** 参考图注入能力：multimodal content 图片项（data URI） */
  readonly referenceImages = 'base64'

  async generate(req: ImageGenRequest): Promise<GeneratedImage> {
    const model = String(req.model || '').trim() || DEFAULT_MODEL
    const prompt = String(req.prompt || '').trim()
    if (!prompt) throw new Error('千问图像 prompt 为空')

    // 参考图注入：图片项在前、文本项在后（无参考图时保持纯文本形态）
    const refs = refsOf(req.referenceImages)
    const content = refs.length > 0 ? [...refs.map((u) => ({ image: u })), { text: prompt }] : [{ text: prompt }]

    const extra = req.extra ?? {}
    const parameters: Record<string, unknown> = {
      prompt_extend: booleanValue(extra.promptExtend, true),
      watermark: booleanValue(extra.watermark, false),
    }
    const size = normalizeSize(req.size)
    if (size) parameters.size = size

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(
        joinApiUrl(req.baseUrl, '/api/v1', '/services/aigc/multimodal-generation/generation'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
          body: JSON.stringify({
            model,
            input: { messages: [{ role: 'user', content }] },
            parameters,
          }),
          signal: controller.signal,
        },
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`千问图像生成失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
      }
      const data = (await res.json()) as { output?: { choices?: unknown } }
      const url = firstChoiceImage(data?.output?.choices)
      if (url) return { kind: 'url', url }
      throw new Error('千问图像响应中缺少 output.choices[].message.content[].image')
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 尺寸归一化：本仓统一 '1024x1024' 形态 → DashScope 的 '1024*1024'；缺省不传（用官方默认） */
function normalizeSize(size?: string): string | undefined {
  const value = String(size || '').trim()
  return value ? value.replace(/[xX×]/g, '*') : undefined
}

/** 同步协议：output.choices[].message.content[].image */
function firstChoiceImage(choices: unknown): string | null {
  if (!Array.isArray(choices)) return null
  for (const choice of choices) {
    const content =
      choice && typeof choice === 'object'
        ? (choice as { message?: { content?: unknown } }).message?.content
        : null
    if (!Array.isArray(content)) continue
    for (const item of content) {
      const image = item && typeof item === 'object' ? (item as Record<string, unknown>)['image'] : null
      if (typeof image === 'string' && image) return image
    }
  }
  return null
}

/** 参考图过滤：仅保留非空且以 data:image 开头的字符串 */
function refsOf(raw?: string[]): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((u) => typeof u === 'string' && !!u.trim() && u.startsWith('data:image'))
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback
  return value !== false && value !== 0
}

/** baseUrl 兼容带/不带 /api/v1 路径段的网关（与万相/视频适配器同源） */
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
