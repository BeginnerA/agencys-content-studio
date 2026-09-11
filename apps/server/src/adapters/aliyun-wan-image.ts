/**
 * 阿里云百炼万相 Wan 3.0 文生图适配器（对齐本仓 ImageAdapter 同步契约）。
 *
 * 官方协议（DashScope 异步任务制）：
 * - POST /api/v1/services/aigc/text2image/image-synthesis（X-DashScope-Async: enable）
 * - GET  /api/v1/tasks/{task_id}
 * - 请求体为 { model, input: { prompt }, parameters: { size, n, prompt_extend, watermark } }
 * - 异步响应为 { output: { task_id, task_status }, request_id }
 * - 任务成功取 output.results[].url
 *
 * 本仓 ImageAdapter.generate() 为同步契约：适配器内部完成「提交 + 轮询」，
 * 3s 间隔、总预算 180s（文生图通常在秒级~1 分钟内完成，远小于视频）。
 */
import type { GeneratedImage, ImageAdapter, ImageGenRequest } from './types'

const DEFAULT_MODEL = 'wan3.0-image-prime'
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 180_000

export class AliyunWanImageAdapter implements ImageAdapter {
  readonly provider = 'aliyun_wan_image'

  async generate(req: ImageGenRequest): Promise<GeneratedImage> {
    const model = String(req.model || '').trim() || DEFAULT_MODEL
    const prompt = String(req.prompt || '').trim()
    if (!prompt) throw new Error('万相文生图 prompt 为空')

    const extra = req.extra ?? {}
    const parameters: Record<string, unknown> = {
      n: 1,
      prompt_extend: booleanValue(extra.promptExtend, true),
      watermark: booleanValue(extra.watermark, false),
    }
    const size = normalizeSize(req.size)
    if (size) parameters.size = size

    const submit = await postJson(
      joinApiUrl(req.baseUrl, '/api/v1', '/services/aigc/text2image/image-synthesis'),
      req.apiKey,
      { model, input: { prompt }, parameters },
    )
    const taskId = submit?.output?.task_id
    if (!taskId) throw new Error(errorMessage(submit, '万相文生图响应中缺少 output.task_id'))

    const deadline = Date.now() + POLL_TIMEOUT_MS
    for (;;) {
      const task = await getJson(
        joinApiUrl(req.baseUrl, '/api/v1', `/tasks/${encodeURIComponent(String(taskId))}`),
        req.apiKey,
      )
      const output = task?.output && typeof task.output === 'object' ? task.output : {}
      switch (output.task_status) {
        case 'PENDING':
        case 'RUNNING':
          break
        case 'SUCCEEDED': {
          const url = firstResultUrl(output.results)
          if (url) return { kind: 'url', url }
          throw new Error(errorMessage(task, '万相文生图任务成功但响应中缺少 output.results[].url'))
        }
        case 'FAILED':
          throw new Error(errorMessage(task, '万相文生图失败'))
        case 'CANCELED':
          throw new Error(errorMessage(task, '万相文生图任务已取消'))
        case 'UNKNOWN':
          throw new Error(errorMessage(task, '万相文生图任务不存在或已超过 24 小时查询有效期'))
        default:
          // 未知状态且带错误字段 → 视为失败；否则继续等待
          if (task?.code || task?.message || output.code || output.message) {
            throw new Error(errorMessage(task, '万相文生图任务查询失败'))
          }
      }
      if (Date.now() > deadline) {
        throw new Error(`万相文生图轮询超时（>${POLL_TIMEOUT_MS / 60_000} 分钟，task_id=${taskId}）`)
      }
      await sleep(POLL_INTERVAL_MS)
    }
  }
}

/** 尺寸归一化：本仓统一 '1024x1024' 形态 → DashScope 的 '1024*1024'；缺省不传（用官方默认） */
function normalizeSize(size?: string): string | undefined {
  const value = String(size || '').trim()
  return value ? value.replace(/[xX×]/g, '*') : undefined
}

function firstResultUrl(results: unknown): string | null {
  if (!Array.isArray(results)) return null
  for (const item of results) {
    const url = item && typeof item === 'object' ? (item as Record<string, unknown>)['url'] : null
    if (typeof url === 'string' && url) return url
  }
  return null
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback
  return value !== false && value !== 0
}

function errorMessage(result: any, fallback: string): string {
  const output = result?.output && typeof result.output === 'object' ? result.output : {}
  const item = Array.isArray(output.results) ? output.results[0] : undefined
  const code = output.code || item?.code || result?.code
  const message = output.message || item?.message || result?.message || fallback
  const requestId = result?.request_id
  return `${code ? `[${code}] ` : ''}${message}${requestId ? ` (request_id: ${requestId})` : ''}`
}

/** baseUrl 兼容带/不带 /api/v1 路径段的网关（与视频适配器同源） */
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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`万相文生图提交失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
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
      throw new Error(`万相文生图任务查询失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
