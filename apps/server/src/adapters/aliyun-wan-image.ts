/**
 * 阿里云百炼万相文生图适配器（对齐本仓 ImageAdapter 同步契约）。
 *
 * 官方协议按模型分三代（2026-09 实测）：
 * - wan2.7（同步直返，wan2.7-image / wan2.7-image-pro）：
 *     POST /api/v1/services/aigc/multimodal-generation/generation（无 X-DashScope-Async / 无轮询）
 *     请求体 { model, input: { messages: [{ role:'user', content: [{ text }] }] }, parameters }
 *     成功取 output.choices[].message.content[].image（实测 ~7s 直返）
 * - wan2.6（新版异步协议，当前仅 wan2.6-t2i）：
 *     POST /api/v1/services/aigc/image-generation/generation（X-DashScope-Async: enable）
 *     请求体 { model, input: { messages: [{ role:'user', content: [{ text }] }] }, parameters }
 *     任务成功取 output.choices[].message.content[].image
 * - wan2.5 及以下（旧版协议，wan2.5-t2i-preview / wan2.2-t2i-* / wanx2.1-* 等）：
 *     POST /api/v1/services/aigc/text2image/image-synthesis（X-DashScope-Async: enable）
 *     请求体 { model, input: { prompt }, parameters }
 *     任务成功取 output.results[].url
 *
 * 共性：GET /api/v1/tasks/{task_id} 轮询；本仓 ImageAdapter.generate() 为同步契约，
 * 适配器内部完成「提交 + 轮询」（3s 间隔、总预算 180s；实测 wan2.6 约 10s 出图）。
 *
 * size 为服务端校验：wan2.6/wan2.5 总像素须在 [589824, 2073600]；wan2.2 宽高须在 [512, 1440]
 * （过小尺寸会在任务调度时 FAILED，错误经轮询返回）。
 */
import type { GeneratedImage, ImageAdapter, ImageGenRequest } from './types'

const DEFAULT_MODEL = 'wan2.6-t2i'
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 180_000

/** wan2.7 走同步 multimodal 直返；wan2.6 走新版异步 image-generation；wan2.5 及以下走 text2image 旧版异步 */
const SYNC_PROTOCOL_PATTERN = /^wan2\.7/
const NEW_PROTOCOL_PATTERN = /^wan2\.6/

export class AliyunWanImageAdapter implements ImageAdapter {
  readonly provider = 'aliyun_wan_image'
  /** 参考图注入能力：仅 wan2.7 同步分支（异步分支忽略 refs，不注入不报错） */
  readonly referenceImages = 'base64'

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

    // 能力边界：参考图仅 wan2.7 同步分支支持；wan2.6 及以下异步协议忽略 refs，不注入不报错
    const refs = refsOf(req.referenceImages)
    if (SYNC_PROTOCOL_PATTERN.test(model)) return generateSynchronous(req, model, prompt, parameters, refs)

    const isNewProtocol = NEW_PROTOCOL_PATTERN.test(model)
    const submit = await postJson(
      joinApiUrl(
        req.baseUrl,
        '/api/v1',
        isNewProtocol
          ? '/services/aigc/image-generation/generation'
          : '/services/aigc/text2image/image-synthesis',
      ),
      req.apiKey,
      isNewProtocol
        ? { model, input: { messages: [{ role: 'user', content: [{ text: prompt }] }] }, parameters }
        : { model, input: { prompt }, parameters },
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
          const url = isNewProtocol ? firstChoiceImage(output.choices) : firstResultUrl(output.results)
          if (url) return { kind: 'url', url }
          throw new Error(errorMessage(task, '万相文生图任务成功但响应中缺少图片 URL'))
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

/**
 * wan2.7 同步协议：提交即直返（无任务轮询），成功取 output.choices[].message.content[].image；
 * 与「千问图像」适配器同端点同形态（multimodal-generation/generation）。
 */
async function generateSynchronous(
  req: ImageGenRequest,
  model: string,
  prompt: string,
  parameters: Record<string, unknown>,
  refs: string[],
): Promise<GeneratedImage> {
  const content = refs.length > 0 ? [...refs.map((u) => ({ image: u })), { text: prompt }] : [{ text: prompt }]
  const result = await postJson(
    joinApiUrl(req.baseUrl, '/api/v1', '/services/aigc/multimodal-generation/generation'),
    req.apiKey,
    { model, input: { messages: [{ role: 'user', content }] }, parameters },
    false,
  )
  const url = firstChoiceImage(result?.output?.choices)
  if (url) return { kind: 'url', url }
  throw new Error(errorMessage(result, '万相文生图（同步）响应中缺少图片 URL'))
}

/** 尺寸归一化：本仓统一 '1024x1024' 形态 → DashScope 的 '1024*1024'；缺省不传（用官方默认） */
function normalizeSize(size?: string): string | undefined {
  const value = String(size || '').trim()
  return value ? value.replace(/[xX×]/g, '*') : undefined
}

/** 旧版协议：output.results[].url */
function firstResultUrl(results: unknown): string | null {
  if (!Array.isArray(results)) return null
  for (const item of results) {
    const url = item && typeof item === 'object' ? (item as Record<string, unknown>)['url'] : null
    if (typeof url === 'string' && url) return url
  }
  return null
}

/** 新版协议：output.choices[].message.content[].image */
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

async function postJson(url: string, apiKey: string, body: unknown, asyncMode = true): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), asyncMode ? 120_000 : 300_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(asyncMode ? { 'X-DashScope-Async': 'enable' } : {}),
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
