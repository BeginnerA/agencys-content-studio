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
  // B7 CSV 导出 URL（直接下载）
  csvRuns: (params = '') => `/api/v1/stats/csv/runs${params}`,
  csvPublications: (params = '') => `/api/v1/stats/csv/publications${params}`,
  csvUsage: (params = '') => `/api/v1/stats/csv/usage${params}`,
  // B7 趋势对比
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
  // B8 平台预设
  presets: () =>
    api.get<{ items: import('../types').ExportPreset[]; defaults: string[] }>(
      '/api/v1/exports/presets',
    ),
  savePresets: (items: import('../types').ExportPreset[]) =>
    api.put<{ items: import('../types').ExportPreset[] }>(
      '/api/v1/exports/presets',
      { items },
    ),
  // 平台导出规格单一真源目录（供「从目录补全」）
  catalog: () =>
    api.get<{ items: import('../types').PlatformCatalogEntry[] }>(
      '/api/v1/exports/presets/catalog',
    ),
  // 从目录补全缺失平台预设（仅填缺失，不覆盖已配；platforms 缺省 = 全目录）
  seed: (platforms?: string[]) =>
    api.post<{ items: import('../types').ExportPreset[]; added: number }>(
      '/api/v1/exports/presets/seed',
      platforms?.length ? { platforms } : {},
    ),
}

// ===== 剪辑工程交换导出（FCPXML / EDL / OTIO）=====

export type EditExchangeFormat = 'fcpxml' | 'edl' | 'otio'

export interface EditExchangeFormatsResult {
  final_video: boolean
  timeline_source: 'stored' | 'recomputed' | null
  available: boolean
  formats: Array<{ format: EditExchangeFormat; enabled: boolean }>
  reason?: string
}

export const editExchangeApi = {
  /** 能力探测：成片存在=全开；无 timeline 且不可重算=置灰带提示 */
  formats: (runId: number) =>
    api.get<EditExchangeFormatsResult>(`/api/v1/runs/${runId}/edit-exchange/formats`),
  /** 生成剪辑工程交换包（→ archive 资产；下载复用 fileUrl） */
  create: (runId: number, format: EditExchangeFormat, includeMedia = true) =>
    api.post<{ asset: ExportAssetLite; timeline_source: 'stored' | 'recomputed'; format: EditExchangeFormat }>(
      `/api/v1/runs/${runId}/edit-exchange`,
      { format, include_media: includeMedia },
    ),
  /** 下载导出包（复用资产文件端点） */
  fileUrl: (assetId: number, download = true) =>
    `/api/v1/assets/${assetId}/file${download ? '?download=1' : ''}`,
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
  // 批量导入 / 趋势 / A/B 分组
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

// ===== 排产计划 + 预算 =====

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
  // 节奏展开预览（纯日期数学，不建库，先看日期再确认）
  cadencePreview: (body: {
    start_at: number
    count: number
    cadence: import('../types').Cadence
  }) =>
    api.post<import('../types').CadencePreviewResult>(
      '/api/v1/schedules/cadence-preview',
      body,
    ),
  // 批量建排产（逐条未来校验，名称带 #序）
  cadenceCreate: (
    projectId: number,
    body: {
      start_at: number
      count: number
      cadence: import('../types').Cadence
      input_template: Array<Record<string, unknown>>
      name_prefix?: string
      template_key?: string
      note?: string
    },
  ) =>
    api.post<{
      created: import('../types').Schedule[]
      skipped: number
    }>(`/api/v1/projects/${projectId}/schedules/cadence`, body),
}

// ===== G12.2/G12.3 合规词库视图 + 补充建议 =====

export const complianceApi = {
  // 词库只读视图（source='file' 在位 / 'builtin' 缺失兜底）
  rules: () => api.get<import('../types').ComplianceRulesView>('/api/v1/compliance/rules'),
  // 从既有复审结论聚合候选新词（Tier B 零新计费；projectId 缺省 = 全域）
  suggest: (projectId?: number) =>
    api.get<{ items: import('../types').SuggestedRule[] }>(
      `/api/v1/compliance/suggest${projectId ? `?project_id=${projectId}` : ''}`,
    ),
  // 采纳建议：将规则追加进词库（去重、追加不覆盖、自动建文件）
  appendRules: (rules: Array<{ category: string; word: string; level: string }>) =>
    api.post<{ added: number; total: number }>('/api/v1/compliance/rules', { rules }),
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
