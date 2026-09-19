import { api, type Items } from './core'
import type {
  ExportAssetLite,
  Overview,
  Publication,
  RunAssetLite,
  UsageSummary,
} from '../types'

export const statsApi = {
  overview: (params = '') =>
    api.get<Overview>(`/api/v1/stats/overview${params}`),
  usage: (params = '') => api.get<UsageSummary>(`/api/v1/stats/usage${params}`),
  costBreakdown: (params = '') =>
    api.get<import('../types').CostBreakdown>(
      `/api/v1/stats/cost-breakdown${params}`,
    ),
  // [M20] B7 CSV 导出 URL（直接下载）
  csvRuns: (params = '') => `/api/v1/stats/csv/runs${params}`,
  csvPublications: (params = '') => `/api/v1/stats/csv/publications${params}`,
  csvUsage: (params = '') => `/api/v1/stats/csv/usage${params}`,
  // [M20] B7 趋势对比
  compare: (params = '') =>
    api.get<import('../types').CompareResult>(`/api/v1/stats/compare${params}`),
}

export const exportApi = {
  create: (runId: number, body: Record<string, unknown>) =>
    api.post<{ asset: ExportAssetLite }>(`/api/v1/runs/${runId}/exports`, body),
  list: (params = '') =>
    api.get<Items<ExportAssetLite>>(`/api/v1/exports${params}`),
  runAssets: (runId: number) =>
    api.get<Items<RunAssetLite>>(`/api/v1/runs/${runId}/assets`),
  /** 下载导出包（复用资产文件端点；download=1 触发浏览器下载） */
  fileUrl: (assetId: number, download = false) =>
    `/api/v1/assets/${assetId}/file${download ? '?download=1' : ''}`,
  // [M20] B8 平台预设
  presets: () =>
    api.get<{ items: import('../types').ExportPreset[]; defaults: string[] }>(
      '/api/v1/exports/presets',
    ),
  savePresets: (items: import('../types').ExportPreset[]) =>
    api.put<{ items: import('../types').ExportPreset[] }>(
      '/api/v1/exports/presets',
      { items },
    ),
}

export const publicationApi = {
  list: (params = '') =>
    api.get<{
      items: Publication[]
      summary: { views: number; interactions: number }
    }>(`/api/v1/publications${params}`),
  create: (body: Record<string, unknown>) =>
    api.post<{ publication: Publication }>('/api/v1/publications', body),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ publication: Publication }>(`/api/v1/publications/${id}`, body),
  remove: (id: number) =>
    api.del<{ ok: boolean }>(`/api/v1/publications/${id}`),
  // [M20] 批量导入 / 趋势 / A/B 分组
  batch: (items: Array<Record<string, unknown>>) =>
    api.post<{ count: number; items: Publication[] }>(
      '/api/v1/publications/batch',
      { items },
    ),
  trend: (params = '') =>
    api.get<{ items: import('../types').PublicationTrendItem[]; days: number }>(
      `/api/v1/publications/trend${params}`,
    ),
  abGroups: (params = '') =>
    api.get<{ items: import('../types').AbGroupItem[] }>(
      `/api/v1/publications/ab-groups${params}`,
    ),
}

export const settingsApi = {
  list: () =>
    api.get<{
      items: Array<{ key: string; value: unknown; updatedAt: number }>
    }>('/api/v1/settings'),
  /** value 即 PUT body（JSON） */
  put: (key: string, value: unknown) =>
    api.put<{ ok: boolean; key: string; updatedAt: number }>(
      `/api/v1/settings/${encodeURIComponent(key)}`,
      value,
    ),
}

// ===== [M20] 排产计划 + 预算 =====

export const scheduleApi = {
  list: (params = '') =>
    api.get<{ items: import('../types').Schedule[] }>(
      `/api/v1/schedules${params}`,
    ),
  calendar: (params = '') =>
    api.get<{ items: import('../types').ScheduleCalendarItem[] }>(
      `/api/v1/schedules/calendar${params}`,
    ),
  detail: (id: number) =>
    api.get<{ schedule: import('../types').Schedule }>(
      `/api/v1/schedules/${id}`,
    ),
  create: (projectId: number, body: Record<string, unknown>) =>
    api.post<{ schedule: import('../types').Schedule }>(
      `/api/v1/projects/${projectId}/schedules`,
      body,
    ),
  cancel: (id: number) =>
    api.post<{ schedule: import('../types').Schedule }>(
      `/api/v1/schedules/${id}/cancel`,
      {},
    ),
  reset: (id: number) =>
    api.post<{ schedule: import('../types').Schedule }>(
      `/api/v1/schedules/${id}/reset`,
      {},
    ),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/schedules/${id}`),
}

export const budgetApi = {
  overview: () =>
    api.get<import('../types').BudgetOverviewResult>('/api/v1/budget'),
  save: (cfg: import('../types').BudgetConfig) =>
    api.put<{ budget: import('../types').BudgetConfig }>('/api/v1/budget', cfg),
  alerts: (params = '') =>
    api.get<{ items: import('../types').BudgetAlert[] }>(
      `/api/v1/budget/alerts${params}`,
    ),
  check: (projectId: number, estimatedCost = 0) =>
    api.post<{
      allowed: boolean
      reason: { code: string; message: string } | null
    }>('/api/v1/budget/check', {
      project_id: projectId,
      estimated_cost: estimatedCost,
    }),
}
