import { api, ApiError, type Items } from './core'
import type {
  CreationAttachmentResult,
  CreationCandidateStep,
  CreationConfirmBody,
  CreationDeleteResult,
  CreationDetail,
  CreationGateBody,
  CreationRefRole,
  CreationRetryBody,
  CreationReworkApplyBody,
  CreationReworkPlanResult,
  CreationSelectionBody,
  CreationSessionListItem,
  ShotBoardData,
} from '../types'
import type { ApiErrorBody } from '../types'

// ===== [M30] 对话式「一句话成片」REST（统一挂 /api/v1/creation-sessions） =====

const BASE = '/api/v1/creation-sessions'

/** 生成 8–120 位 [a-zA-Z0-9_-] 请求/幂等键（服务端 requestKeySchema 约束）；浏览器 crypto 随机 */
export function newRequestKey(prefix = 'req'): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  const rand = Array.from(bytes, (b) =>
    b.toString(36).padStart(2, '0').slice(-2),
  ).join('')
  return `${prefix.replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now().toString(36)}${rand}`.slice(
    0,
    120,
  )
}

export const creationChatApi = {
  list: () => api.get<Items<CreationSessionListItem>>(BASE),
  create: (content: string, requestKey: string, deferPlanning = false) =>
    api.post<CreationDetail>(BASE, { content, requestKey, ...(deferPlanning ? { deferPlanning: true } : {}) }),
  detail: (id: number) => api.get<CreationDetail>(`${BASE}/${id}`),
  send: (
    id: number,
    content: string,
    requestKey: string,
    attachments?: number[],
  ) =>
    api.post<CreationDetail>(`${BASE}/${id}/messages`, {
      content,
      requestKey,
      ...(attachments && attachments.length ? { attachments } : {}),
    }),
  preflight: (id: number) =>
    api.post<CreationDetail>(`${BASE}/${id}/preflight`),
  confirm: (id: number, body: CreationConfirmBody) =>
    api.post<{ runId: number }>(`${BASE}/${id}/confirm`, body),
  cancel: (id: number) => api.post<CreationDetail>(`${BASE}/${id}/cancel`),
  /** [M40+] 删除会话：未立项时一并回收影子项目；已立项只删记录（项目原样保留） */
  remove: (id: number) => api.del<CreationDeleteResult>(`${BASE}/${id}`),
  retry: (id: number, body: CreationRetryBody) =>
    api.post<{ runId: number }>(`${BASE}/${id}/retry`, body),
  /** [M42] 中途审阅决策（仅 approve/reject）：幂等由 idempotencyKey 保证，重复提交不重复决策 */
  gate: (id: number, body: CreationGateBody) =>
    api.post<CreationDetail>(`${BASE}/${id}/gate`, body),
  /** [M42] 候选看板（只读）：直返专业工作台同一份版本聚合，不另建投影 */
  board: (id: number, step: CreationCandidateStep) =>
    api.get<ShotBoardData>(`${BASE}/${id}/board?step=${step}`),
  /** [M42] 选定在用版本：只报改动镜头，服务端补全为全量；不触发执行、零计费 */
  selectShots: (id: number, body: CreationSelectionBody) =>
    api.post<CreationDetail>(`${BASE}/${id}/selection`, body),
  /** [M42] 本地重新合成：仅重置合成步（不调用付费模型），回 202 + 最新快照 */
  recompose: (id: number, body: { idempotencyKey: string }) =>
    api.post<CreationDetail>(`${BASE}/${id}/recompose`, body),
  /** [M42] 返修第一步 · 解析指令：只调用一次文本模型（小额费用），零媒体计费，不启动任何生成 */
  reworkPlan: (id: number, body: { instruction: string; requestKey: string }) =>
    api.post<CreationReworkPlanResult>(`${BASE}/${id}/rework/plan`, body),
  /** [M42] 返修第二步 · 确认执行：重置目标镜并续跑（会重新生成、可能计费），回 202 + 快照 */
  reworkApply: (id: number, body: CreationReworkApplyBody) =>
    api.post<CreationDetail>(`${BASE}/${id}/rework`, body),
  /** [M31] 上传参考素材（multipart file+role）：落会话项目、不计费、不触发规划 */
  uploadAttachment: async (
    id: number,
    file: File,
    role?: CreationRefRole,
  ): Promise<CreationAttachmentResult> => {
    const form = new FormData()
    form.append('file', file, file.name)
    if (role) form.append('role', role)
    let res: Response
    try {
      res = await fetch(`${BASE}/${id}/attachments`, {
        method: 'POST',
        body: form,
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
    return (await res.json()) as CreationAttachmentResult
  },
  /** [M31+] 从素材选取：存量资产登记为参考（跨项目由服务端自动复制进会话项目）；与上传同规则、不计费 */
  attachAsset: (id: number, assetId: number, role?: CreationRefRole) =>
    api.post<CreationAttachmentResult>(
      `${BASE}/${id}/attachments/from-asset`,
      { assetId, ...(role ? { role } : {}) },
    ),
}
