import { api, type Items } from './core'
import type {
  Asset,
  Batch,
  BatchDetail,
  Episode,
  Project,
  ProjectDetail,
  PromptItem,
  PrefillResult,
  Run,
  SeriesInfo,
  TemplateDetail,
  TemplateEdits,
  TemplateMeta,
  TemplateValidation,
} from '../types'

export const projectApi = {
  /** 项目列表（?status=active|archived，默认 active） */
  list: (params = '') => api.get<Items<Project>>(`/api/v1/projects${params}`),
  create: (body: {
    name: string
    genre: string
    brief: string
    template_key?: string
    tags?: string[]
  }) => api.post<Project>('/api/v1/projects', body),
  detail: (id: number) =>
    api.get<{ project: ProjectDetail }>(`/api/v1/projects/${id}`),
  update: (
    id: number,
    body: {
      name?: string
      brief?: string
      genre?: string
      template_key?: string
      status?: 'active' | 'archived'
      /** [M8] 读-合并写：调用方先展开既有 settings 再覆盖目标键（如 style_preset_ids） */
      settings?: Record<string, unknown>
      /** [M21] 标签（覆盖式写入） */
      tags?: string[]
    },
  ) =>
    api.patch<{ project: Record<string, unknown> }>(
      `/api/v1/projects/${id}`,
      body,
    ),
  /** 资产列表（?limit/offset/kind/purpose/tag；total 为过滤条件下总数） */
  assets: (id: number, params = '') =>
    api.get<{ items: Asset[]; total: number }>(
      `/api/v1/projects/${id}/assets${params}`,
    ),
  runs: (id: number) => api.get<Items<Run>>(`/api/v1/runs?project_id=${id}`),
  /** 归档（逻辑删，可从「已归档」列表恢复） */
  archive: (id: number) =>
    api.del<{ ok: boolean; mode: string }>(`/api/v1/projects/${id}`),
  /** 彻底删除（事务清库 + 删磁盘文件，不可恢复；有未完成运行时服务端 409 拦截） */
  purge: (id: number) =>
    api.del<{ ok: boolean; mode: string; purged: Record<string, number> }>(
      `/api/v1/projects/${id}?purge=1`,
    ),
  /** 恢复归档项目 */
  restore: (id: number) =>
    api.patch<{ project: Record<string, unknown> }>(`/api/v1/projects/${id}`, {
      status: 'active',
    }),
}

export const templateApi = {
  list: () => api.get<Items<TemplateMeta>>('/api/v1/templates'),
  detail: (key: string) =>
    api.get<{ template: TemplateDetail; yaml: string }>(
      `/api/v1/templates/${encodeURIComponent(key)}`,
    ),
  /** [M34] 运行入参预填候选（G6 历史 run/brief + G8 视频合法档位；只读、零计费） */
  prefill: (projectId: number, key: string) =>
    api.get<PrefillResult>(
      `/api/v1/templates/${encodeURIComponent(key)}/prefill?project_id=${projectId}`,
    ),
  /** 纯校验不落盘（编辑器防抖调用） */
  validate: (yaml: string, key?: string) =>
    api.post<TemplateValidation>('/api/v1/templates/validate', { yaml, key }),
  create: (key: string, yaml: string) =>
    api.post<{ ok: boolean; template: TemplateDetail; warnings: string[] }>(
      '/api/v1/templates',
      { key, yaml },
    ),
  update: (key: string, yaml: string) =>
    api.put<{ ok: boolean; template: TemplateDetail; warnings: string[] }>(
      `/api/v1/templates/${encodeURIComponent(key)}`,
      { yaml },
    ),
  remove: (key: string) =>
    api.del<{ ok: boolean }>(`/api/v1/templates/${encodeURIComponent(key)}`),
  /** [M23] 设计态编辑草案：edits 白名单应用 → YAML 序列化（不落盘）→ { yaml, validation, editsApplied } */
  editDraft: (key: string, edits: TemplateEdits) =>
    api.post<{
      yaml: string
      validation: TemplateValidation
      editsApplied: number
    }>(`/api/v1/templates/${encodeURIComponent(key)}/edit-draft`, { edits }),
  /** [M23] 编辑落盘为新模板（原文件零触碰；newKey 缺省 <原key>-edit，冲突自动后缀）→ { templateKey, validation } */
  editSave: (key: string, edits: TemplateEdits, newKey?: string) =>
    api.post<{
      templateKey: string
      validation: TemplateValidation
      editsApplied: number
    }>(`/api/v1/templates/${encodeURIComponent(key)}/edit-save`, {
      edits,
      newKey,
    }),
}

/** 提示词文件（workspace/prompts 内相对路径，子目录用 / 分隔） */
export const promptApi = {
  list: () => api.get<Items<PromptItem>>('/api/v1/prompts'),
  get: (name: string) =>
    api.get<{ name: string; content: string }>(
      `/api/v1/prompts/${encodePromptPath(name)}`,
    ),
  put: (name: string, content: string) =>
    api.put<{ ok: boolean; name: string; size: number }>(
      `/api/v1/prompts/${encodePromptPath(name)}`,
      { content },
    ),
  remove: (name: string) =>
    api.del<{ ok: boolean }>(`/api/v1/prompts/${encodePromptPath(name)}`),
}

/** 相对路径逐段编码（保留 / 分隔，中文名可用） */
function encodePromptPath(name: string): string {
  return name
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

export const batchApi = {
  create: (projectId: number, body: Record<string, unknown>) =>
    api.post<{ batch: Batch; runIds: number[] }>(
      `/api/v1/projects/${projectId}/batches`,
      body,
    ),
  list: (params = '') => api.get<Items<Batch>>(`/api/v1/batches${params}`),
  detail: (id: number) => api.get<BatchDetail>(`/api/v1/batches/${id}`),
  cancel: (id: number) =>
    api.post<{ batch: Batch }>(`/api/v1/batches/${id}/cancel`),
  /** 批量导出（有产物 run 逐个全量打包；无产物记 skipped） */
  exportAll: (id: number) =>
    api.post<{
      items: Array<{ runId: number; assetId: number; name: string }>
      skipped: Array<{ runId: number; reason: string }>
    }>(`/api/v1/batches/${id}/exports`),
}

// ===== [M14] 剧集实体（series → episodes 两级，一项目一剧） =====

export const seriesApi = {
  /** 项目剧 + 集列表（无剧 → { series: null, episodes: [] }） */
  get: (projectId: number) =>
    api.get<{ series: SeriesInfo | null; episodes: Episode[] }>(
      `/api/v1/projects/${projectId}/series`,
    ),
  /** 建剧（生成 1..N 集行；已有剧 → 409 series_exists） */
  create: (
    projectId: number,
    body: {
      name: string
      total_episodes: number
      content_asset_id?: number | null
    },
  ) =>
    api.post<{ series: SeriesInfo; episodes: Episode[] }>(
      `/api/v1/projects/${projectId}/series`,
      body,
    ),
  /** 集数调整（扩容追集 / 缩容删尾部空集；被删集有 run / 资产 → 409 episode_in_use） */
  updateTotal: (seriesId: number, totalEpisodes: number) =>
    api.patch<{ series: SeriesInfo; episodes: Episode[] }>(
      `/api/v1/series/${seriesId}`,
      { total_episodes: totalEpisodes },
    ),
  /** 删剧（任集关联 run / 资产 → 409 series_in_use） */
  remove: (seriesId: number) =>
    api.del<{ ok: boolean }>(`/api/v1/series/${seriesId}`),
  /** 单集更新（title / status locked|planning|done / content_asset_id） */
  updateEpisode: (
    episodeId: number,
    body: {
      title?: string | null
      status?: string
      content_asset_id?: number | null
    },
  ) => api.patch<{ episode: Episode }>(`/api/v1/episodes/${episodeId}`, body),
  /** 删集（保留 run 与资产，仅删集行） */
  removeEpisode: (episodeId: number) =>
    api.del<{ ok: boolean }>(`/api/v1/episodes/${episodeId}`),
}
