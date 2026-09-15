import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { WorkbenchError } from '../services/shot'

/** 路径 :id 参数解析（非法/缺 → 400 或 404） */
export function idParam(c: Context, name = 'id'): number {
  const raw = c.req.param(name)
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad_id', `路径参数 ${name} 非法: ${raw}`)
  return id
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export function ok<T extends Record<string, unknown>>(c: Context, data: T, status: ContentfulStatusCode = 200): Response {
  return c.json(data, status)
}

export function fail(c: Context, err: unknown): Response {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode)
  }
  // 模板/引擎领域错误（引用解析、模板非法、缺配置等）统一 400 语义
  const msg = (err as Error).message
  return c.json({ error: { code: 'bad_request', message: msg } }, 400)
}

/** 404 资源（校验行存在性用） */
export function notFound(c: Context, what: string): Response {
  return c.json({ error: { code: 'not_found', message: `${what} 不存在` } }, 404)
}
/** 路由包装：领域错误 → fail() JSON；避免落入 onError 500 */
export function h(fn: (c: Context) => Promise<Response> | Response) {
  return async (c: Context): Promise<Response> => {
    try {
      return await fn(c)
    } catch (err) {
      return fail(c, err)
    }
  }
}

/** 工作台领域错误 → HttpError（状态码透传）；其余原样抛出走 fail() 兜底 */
export async function wb<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof WorkbenchError) throw new HttpError(err.status, err.code, err.message)
    throw err
  }
}