/**
 * 自动编排链 REST 客户端（spec §2.3）
 * 后端 toWorkflowView 返回 camelCase（autoAdvance/budgetCap/segments[]）；
 * 建/改请求体沿用后端读取的 snake_case 键（auto_advance/budget_cap）。
 */
import { api, type Items } from './core'
import type { Workflow, WorkflowSegment } from '../types'

export interface WorkflowCreateBody {
  name: string
  segments: WorkflowSegment[]
  autoAdvance?: 0 | 1
  budgetCap?: number | null
  note?: string | null
}

export interface WorkflowPatchBody {
  name?: string
  segments?: WorkflowSegment[]
  autoAdvance?: 0 | 1
  budgetCap?: number | null
  note?: string | null
}

/** camelCase → 后端 snake_case 请求体（仅出现在 wire 层，内部一律 camelCase） */
function toWire(
  b: WorkflowCreateBody | WorkflowPatchBody,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  if (b.name !== undefined) wire['name'] = b.name
  if (b.segments !== undefined) wire['segments'] = b.segments
  if (b.autoAdvance !== undefined) wire['auto_advance'] = b.autoAdvance
  if (b.budgetCap !== undefined) wire['budget_cap'] = b.budgetCap
  if (b.note !== undefined) wire['note'] = b.note
  return wire
}

export const workflowApi = {
  /** 列表（?project_id=&status=） */
  list: (params = '') => api.get<Items<Workflow>>(`/api/v1/workflows${params}`),
  detail: (id: number) =>
    api.get<{ workflow: Workflow }>(`/api/v1/workflows/${id}`),
  /** 建链（后端 validateWorkflowChainDoc 校验；warnings 为 next 一致性软提示） */
  create: (projectId: number, body: WorkflowCreateBody) =>
    api.post<{ workflow: Workflow; warnings: string[] }>(
      `/api/v1/projects/${projectId}/workflows`,
      toWire(body),
    ),
  update: (id: number, body: WorkflowPatchBody) =>
    api.patch<{ workflow: Workflow }>(`/api/v1/workflows/${id}`, toWire(body)),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/workflows/${id}`),
  /** 克隆为 draft（I2 编排层引用复用） */
  clone: (id: number) =>
    api.post<{ workflow: Workflow }>(`/api/v1/workflows/${id}/clone`),
  /** 显式启动首段 run（draft|paused→active；首段 autoAdvance 决定是否级联） */
  start: (id: number) =>
    api.post<{ workflow: Workflow; runId: number }>(
      `/api/v1/workflows/${id}/start`,
    ),
  pause: (id: number) =>
    api.post<{ workflow: Workflow }>(`/api/v1/workflows/${id}/pause`),
  resume: (id: number) =>
    api.post<{ workflow: Workflow }>(`/api/v1/workflows/${id}/resume`),
}
