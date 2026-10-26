import type { ApiErrorBody } from '../types'

/** 统一请求封装：错误解析为 {code,message}，抛 ApiError */
export class ApiError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * 请求超时上限：不设上限等于「页面卡到用户整页刷新」——连接被半开挂起时 fetch 的 Promise 永不落定，
 * 调用方的 busy 锁与轮询会一直停在原地。默认 2 分钟覆盖本地小任务；已知同步重活显式改用 LONG。
 */
export const DEFAULT_TIMEOUT_MS = 120_000
/** 同步长任务（打包导出 / 本地合成 / 供应商连通测试与模型拉取）：服务端真在算，给 15 分钟 */
export const LONG_TIMEOUT_MS = 900_000

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string })?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers:
        body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    // 超时只说明「本次等待到头」：服务端不受影响、仍在执行，文案不能暗示操作失败
    if (isTimeout(err)) {
      throw new ApiError(
        0,
        'timeout',
        `请求超时（${Math.round(timeoutMs / 1000)} 秒）：服务可能仍在处理，请稍后刷新查看结果`,
      )
    }
    throw new ApiError(0, 'network', '无法连接服务（127.0.0.1:3001）')
  }
  if (!res.ok) {
    let code = 'http_' + res.status
    let message = `HTTP ${res.status}`
    try {
      const data = (await res.json()) as ApiErrorBody
      if (data?.error?.message) {
        code = data.error.code
        message = data.error.message
      }
    } catch {
      // 非 JSON 错误体，保留默认
    }
    throw new ApiError(res.status, code, message)
  }
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string, timeoutMs?: number) =>
    request<T>('GET', path, undefined, timeoutMs),
  post: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>('POST', path, body, timeoutMs),
  patch: <T>(path: string, body: unknown, timeoutMs?: number) =>
    request<T>('PATCH', path, body, timeoutMs),
  put: <T>(path: string, body: unknown, timeoutMs?: number) =>
    request<T>('PUT', path, body, timeoutMs),
  del: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>('DELETE', path, body, timeoutMs),
}

export interface Items<T> {
  items: T[]
}
