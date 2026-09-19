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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers:
        body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
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
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
}

export interface Items<T> {
  items: T[]
}
