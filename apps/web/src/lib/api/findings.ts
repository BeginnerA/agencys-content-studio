// M69 审片问题单 API（与 apps/server routes/review.ts 对齐）。
// 全部动作返回服务端投影；前端不做状态推断。
import { api } from './core'
import type {
  FindingsList,
  FindingView,
  FindingScopeInput,
  ReviewSeverity,
} from '../types/findings'

const V = '/api/v1'

export interface CreateFindingBody {
  client_key?: string
  step_key?: string
  category: FindingView['category']
  severity: ReviewSeverity
  note: string
  scope: FindingScopeInput
}

const one = (runId: number, fid: number, action: string, body?: unknown) =>
  api.post<{ finding: FindingView }>(
    `${V}/runs/${runId}/findings/${fid}/${action}`,
    body ?? {},
  )

export const findingsApi = {
  list: (runId: number, stepKey = 'compose') =>
    api.get<FindingsList>(
      `${V}/runs/${runId}/findings?stepKey=${encodeURIComponent(stepKey)}`,
    ),
  create: (runId: number, body: CreateFindingBody) =>
    api.post<{ finding: FindingView; replayed: boolean }>(
      `${V}/runs/${runId}/findings`,
      body,
    ),
  patch: (
    runId: number,
    fid: number,
    body: { note?: string; severity?: ReviewSeverity },
  ) =>
    api.patch<{ finding: FindingView }>(
      `${V}/runs/${runId}/findings/${fid}`,
      body,
    ),
  link: (runId: number, fid: number, requestId: string) =>
    one(runId, fid, 'link', { request_id: requestId }),
  markRework: (runId: number, fid: number, note?: string) =>
    one(runId, fid, 'mark-rework', { note }),
  recheck: (runId: number, fid: number) => one(runId, fid, 'recheck'),
  verify: (
    runId: number,
    fid: number,
    body: {
      result: 'verified' | 'reopened'
      final_asset_id: number
      note?: string
    },
  ) => one(runId, fid, 'verify', body),
  dismiss: (runId: number, fid: number, note?: string) =>
    one(runId, fid, 'dismiss', { note }),
  reopen: (runId: number, fid: number, note?: string) =>
    one(runId, fid, 'reopen', { note }),
}
