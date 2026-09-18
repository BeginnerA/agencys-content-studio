import { api, type Items } from './core'
import type {
  CreationConfirmBody,
  CreationDetail,
  CreationRetryBody,
  CreationSessionListItem,
} from '../types'

// ===== [M30] 对话式「一句话成片」REST（统一挂 /api/v1/creation-sessions） =====

const BASE = '/api/v1/creation-sessions'

/** 生成 8–120 位 [a-zA-Z0-9_-] 请求/幂等键（服务端 requestKeySchema 约束）；浏览器 crypto 随机 */
export function newRequestKey(prefix = 'req'): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  const rand = Array.from(bytes, (b) => b.toString(36).padStart(2, '0').slice(-2)).join('')
  return `${prefix.replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now().toString(36)}${rand}`.slice(0, 120)
}

export const creationChatApi = {
  list: () => api.get<Items<CreationSessionListItem>>(BASE),
  create: (content: string, requestKey: string) => api.post<CreationDetail>(BASE, { content, requestKey }),
  detail: (id: number) => api.get<CreationDetail>(`${BASE}/${id}`),
  send: (id: number, content: string, requestKey: string) =>
    api.post<CreationDetail>(`${BASE}/${id}/messages`, { content, requestKey }),
  preflight: (id: number) => api.post<CreationDetail>(`${BASE}/${id}/preflight`),
  confirm: (id: number, body: CreationConfirmBody) => api.post<{ runId: number }>(`${BASE}/${id}/confirm`, body),
  cancel: (id: number) => api.post<CreationDetail>(`${BASE}/${id}/cancel`),
  retry: (id: number, body: CreationRetryBody) => api.post<{ runId: number }>(`${BASE}/${id}/retry`, body),
}
