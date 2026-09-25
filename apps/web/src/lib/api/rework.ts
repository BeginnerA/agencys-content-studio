// 精确返修 API：字幕读模型 / 结构化预览 / 请求回放 / 原子确认。
// 与 apps/server routes/rework.ts 逐端点对齐；preview/apply 错误体额外携带
// errors[]（cueId 供 UI 行定位），core.ts 通用解析会丢失该字段，故本文件自带请求封装。
import { ApiError } from './core'
import type {
  ApplyResponseView,
  PreviewResponseView,
  ReworkErrorView,
  ReworkRequestView,
  SubtitleChangeView,
  SubtitleReadModelView,
} from '../types/rework'

const V = '/api/v1'

/** 带领域错误明细的 API 错误（errors 缺失时为空数组，UI 回退顶部提示） */
export class ReworkApiError extends ApiError {
  errors: ReworkErrorView[]
  requestId: string | null
  constructor(
    status: number,
    code: string,
    message: string,
    errors: ReworkErrorView[] = [],
    requestId: string | null = null,
  ) {
    super(status, code, message)
    this.errors = errors
    this.requestId = requestId
  }
}

interface ReworkErrorBody {
  error?: { code?: string; message?: string }
  errors?: ReworkErrorView[]
  request_id?: string
}

async function reworkRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ReworkApiError(0, 'network', '无法连接服务（127.0.0.1:3001）')
  }
  if (!res.ok) {
    let code = 'http_' + res.status
    let message = `HTTP ${res.status}`
    let errors: ReworkErrorView[] = []
    let requestId: string | null = null
    try {
      const data = (await res.json()) as ReworkErrorBody
      if (data?.error?.message) {
        code = data.error.code || code
        message = data.error.message
      }
      if (Array.isArray(data?.errors)) errors = data.errors
      if (typeof data?.request_id === 'string') requestId = data.request_id
    } catch {
      // 非 JSON 错误体，保留默认
    }
    throw new ReworkApiError(res.status, code, message, errors, requestId)
  }
  return (await res.json()) as T
}

export const subtitleReworkApi = {
  /** 字幕返修读模型（能力门禁 + 基线 cue + 当前修订 + 版本历史 + 复核 + 输出状态） */
  subtitles: (runId: number, stepKey = 'compose') =>
    reworkRequest<SubtitleReadModelView>(
      'GET',
      `${V}/runs/${runId}/subtitles?stepKey=${encodeURIComponent(stepKey)}`,
    ),

  /** 结构化预览：同 requestKey 同签名幂等回放；blocked 抛 ReworkApiError（含 errors[]） */
  preview: (runId: number, requestKey: string, changes: SubtitleChangeView[], stepKey?: string) =>
    reworkRequest<PreviewResponseView>('POST', `${V}/runs/${runId}/rework/preview`, {
      request_key: requestKey,
      ...(stepKey ? { step_key: stepKey } : {}),
      changes,
    }),

  /** 请求回放视图（刷新/响应丢失后恢复现场） */
  getRequest: (runId: number, requestId: string) =>
    reworkRequest<ReworkRequestView>('GET', `${V}/runs/${runId}/rework/${requestId}`),

  /** 原子确认：逐字回传 previewHash；冲突抛 ReworkApiError（409 族） */
  apply: (runId: number, requestId: string, previewHash: string) =>
    reworkRequest<ApplyResponseView>('POST', `${V}/runs/${runId}/rework/${requestId}/apply`, {
      preview_hash: previewHash,
    }),
}
