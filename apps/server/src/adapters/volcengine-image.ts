/**
 * 火山方舟 Seedream 文生图适配器（M3 从 huobao-drama 搬运，对齐本仓 ImageAdapter 同步契约）。
 *
 * 官方协议（Ark /api/v3 前缀）：
 * - POST /api/v3/images/generations
 * - 同步返回 { data: [{ url }] }；异步返回 { id } → 轮询 GET /api/v3/images/generations/{id}
 * - 轮询 status: succeeded（data[].url）/ failed（error 可为字符串或 { code, message }）
 * - 尺寸按 width / height 整数下发（本仓 '1024x1024' 形态解析；缺省不传，用官方默认）
 *
 * 本仓 ImageAdapter.generate() 为同步契约：异步任务在适配器内部完成「提交 + 轮询」，
 * 3s 间隔、总预算 180s（与万相适配器同源）。
 */
import type { GeneratedImage, ImageAdapter, ImageGenRequest } from './types'

const DEFAULT_MODEL = 'doubao-seedream-5-0-260128'
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 180_000

export class VolcengineImageAdapter implements ImageAdapter {
  readonly provider = 'volcengine_image'
  /** 参考图注入能力：Seedream 图像输入（data URI 数组） */
  readonly referenceImages = 'base64'

  async generate(req: ImageGenRequest): Promise<GeneratedImage> {
    const model = String(req.model || '').trim() || DEFAULT_MODEL
    const prompt = String(req.prompt || '').trim()
    if (!prompt) throw new Error('火山方舟文生图 prompt 为空')

    const extra = req.extra ?? {}
    const body: Record<string, unknown> = { model, prompt }
    const size = parseSize(req.size)
    if (size) {
      body.width = size.width
      body.height = size.height
    }
    if (extra.watermark !== undefined) body.watermark = extra.watermark === true
    // 参考图注入：Seedream 4.0+ 图像输入字段（实弹对表——若官方为单图形态则收敛为首图并注释依据）
    const refs = refsOf(req.referenceImages)
    if (refs.length > 0) body.image = refs

    const submit = await postJson(joinApiUrl(req.baseUrl, '/api/v3', '/images/generations'), req.apiKey, body)
    const taskId = submit?.id || submit?.task_id
    if (!taskId) {
      const url = firstImageUrl(submit)
      if (url) return { kind: 'url', url }
      throw new Error(errorMessage(submit, '火山方舟文生图响应缺少 data[].url 或 task id'))
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS
    for (;;) {
      const task = await getJson(
        joinApiUrl(req.baseUrl, '/api/v3', `/images/generations/${encodeURIComponent(String(taskId))}`),
        req.apiKey,
      )
      const status = String(task?.status ?? '')
      if (status === 'succeeded') {
        const url = firstImageUrl(task)
        if (url) return { kind: 'url', url }
        throw new Error(errorMessage(task, '火山方舟文生图任务成功但响应中缺少图片 URL'))
      }
      if (status === 'failed') throw new Error(errorMessage(task, '火山方舟文生图失败'))
      if (Date.now() > deadline) {
        throw new Error(`火山方舟文生图轮询超时（>${POLL_TIMEOUT_MS / 60_000} 分钟，task_id=${taskId}）`)
      }
      await sleep(POLL_INTERVAL_MS)
    }
  }
}

/** 尺寸解析：'1024x1024'（[xX×] 皆可）→ { width, height }；非法/缺省 → null（不传，用官方默认） */
function parseSize(size?: string): { width: number; height: number } | null {
  const match = String(size || '').trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

/** 图片 URL 提取：data[0].url（同步/轮询共用）→ image_url / url 兜底 */
function firstImageUrl(result: any): string | null {
  const item = Array.isArray(result?.data) ? result.data[0] : undefined
  const url = item?.url || result?.image_url || result?.url
  return typeof url === 'string' && url ? url : null
}

/** 错误信息聚合：error（字符串或 { code, message }）→ code / message */
function errorMessage(result: any, fallback: string): string {
  const err = result?.error
  const code = (err && typeof err === 'object' && err.code) || result?.code
  const message =
    (typeof err === 'string' && err) ||
    (err && typeof err === 'object' && err.message) ||
    result?.message ||
    fallback
  return `${code ? `[${code}] ` : ''}${message}`
}

/** baseUrl 兼容带/不带 /api/v3 路径段的网关（与视频/万相适配器同源） */
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
      throw new Error(`火山方舟文生图提交失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
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
      throw new Error(`火山方舟文生图任务查询失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 参考图过滤：仅保留非空且以 data:image 开头的字符串 */
function refsOf(raw?: string[]): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((u) => typeof u === 'string' && !!u.trim() && u.startsWith('data:image'))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
