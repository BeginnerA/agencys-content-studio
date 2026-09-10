import type {
  ApiConfig,
  ApiErrorBody,
  ApiProvider,
  Asset,
  Batch,
  BatchDetail,
  CharacterItem,
  ExportAssetLite,
  FetchModelsResult,
  GenTask,
  MemoryItem,
  MemoryStatus,
  Overview,
  Project,
  ProjectDetail,
  PromptItem,
  Publication,
  Run,
  RunAssetLite,
  RunDetail,
  TemplateDetail,
  TemplateMeta,
  TemplateValidation,
  UsageSummary,
} from './types'

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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
  del: <T>(path: string) => request<T>('DELETE', path),
}

// ===== 端点封装 =====

interface Items<T> {
  items: T[]
}

export const projectApi = {
  list: () => api.get<Items<Project>>('/api/v1/projects'),
  create: (body: { name: string; genre: string; brief: string; template_key?: string }) =>
    api.post<Project>('/api/v1/projects', body),
  detail: (id: number) => api.get<ProjectDetail>(`/api/v1/projects/${id}`),
  assets: (id: number, params = '') => api.get<Items<Asset>>(`/api/v1/projects/${id}/assets${params}`),
  runs: (id: number) => api.get<Items<Run>>(`/api/v1/runs?project_id=${id}`),
}

export const templateApi = {
  list: () => api.get<Items<TemplateMeta>>('/api/v1/templates'),
  detail: (key: string) =>
    api.get<{ template: TemplateDetail; yaml: string }>(`/api/v1/templates/${encodeURIComponent(key)}`),
  /** 纯校验不落盘（编辑器防抖调用） */
  validate: (yaml: string, key?: string) =>
    api.post<TemplateValidation>('/api/v1/templates/validate', { yaml, key }),
  create: (key: string, yaml: string) =>
    api.post<{ ok: boolean; template: TemplateDetail; warnings: string[] }>('/api/v1/templates', { key, yaml }),
  update: (key: string, yaml: string) =>
    api.put<{ ok: boolean; template: TemplateDetail; warnings: string[] }>(
      `/api/v1/templates/${encodeURIComponent(key)}`,
      { yaml },
    ),
  remove: (key: string) => api.del<{ ok: boolean }>(`/api/v1/templates/${encodeURIComponent(key)}`),
}

/** 提示词文件（workspace/prompts 内相对路径，子目录用 / 分隔） */
export const promptApi = {
  list: () => api.get<Items<PromptItem>>('/api/v1/prompts'),
  get: (name: string) =>
    api.get<{ name: string; content: string }>(`/api/v1/prompts/${encodePromptPath(name)}`),
  put: (name: string, content: string) =>
    api.put<{ ok: boolean; name: string; size: number }>(`/api/v1/prompts/${encodePromptPath(name)}`, { content }),
  remove: (name: string) => api.del<{ ok: boolean }>(`/api/v1/prompts/${encodePromptPath(name)}`),
}

/** 相对路径逐段编码（保留 / 分隔，中文名可用） */
function encodePromptPath(name: string): string {
  return name
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

export const runApi = {
  detail: (id: number) => api.get<RunDetail>(`/api/v1/runs/${id}`),
  log: (id: number, tail = 200) => api.get<{ log: string }>(`/api/v1/runs/${id}/log?tail=${tail}`),
  start: (projectId: number, body: { template_key: string; input: Record<string, unknown> }) =>
    api.post<{ run: Run }>(`/api/v1/projects/${projectId}/runs`, body),
  gate: (id: number, body: Record<string, unknown>) => api.post<RunDetail>(`/api/v1/runs/${id}/gate`, body),
  cancel: (id: number) => api.post<{ run: Run }>(`/api/v1/runs/${id}/cancel`),
  resume: (id: number) => api.post<{ run: Run }>(`/api/v1/runs/${id}/resume`),
}

export const taskApi = {
  list: (params = '') => api.get<Items<GenTask>>(`/api/v1/tasks${params}`),
  retry: (id: number) => api.post<{ task: GenTask }>(`/api/v1/tasks/${id}/retry`),
  cancel: (id: number) => api.post<{ task: GenTask }>(`/api/v1/tasks/${id}/cancel`),
}

export const configApi = {
  providers: () => api.get<Items<ApiProvider>>('/api/v1/api-providers'),
  list: () => api.get<Items<ApiConfig>>('/api/v1/api-configs'),
  create: (body: Record<string, unknown>) => api.post<ApiConfig>('/api/v1/api-configs', body),
  update: (id: number, body: Record<string, unknown>) => api.put<ApiConfig>(`/api/v1/api-configs/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/api-configs/${id}`),
  test: (id: number) => api.post<Record<string, unknown>>(`/api/v1/api-configs/${id}/test`),
  /** 在线拉取供应商可用模型目录（OpenAI 兼容 GET /models，失败回退预置列表） */
  fetchModels: (body: Record<string, unknown>) =>
    api.post<FetchModelsResult>('/api/v1/api-configs/fetch-models', body),
}

export const assetApi = {
  /** 后端返回包裹体 { asset }（与 PATCH 同契约） */
  detail: (id: number) => api.get<{ asset: Asset }>(`/api/v1/assets/${id}`),
  /** 软删除（导出包清理用：列表隐藏，文件保留） */
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/assets/${id}`),
}

// ===== [M3] 记忆 / 角色 =====

export const memoryApi = {
  list: (params = '') => api.get<Items<MemoryItem>>(`/api/v1/memories${params}`),
  /** 创建/具名 upsert；后端返回包裹体 { memory, created } */
  create: (body: Record<string, unknown>) =>
    api.post<{ memory: MemoryItem; created: boolean }>('/api/v1/memories', body),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ memory: MemoryItem }>(`/api/v1/memories/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/memories/${id}`),
  reindex: () => api.post<{ total: number; rebuilt: number; skipped: number }>('/api/v1/memories/reindex'),
  status: () => api.get<MemoryStatus>('/api/v1/memories/status'),
}

export const characterApi = {
  list: (params = '') => api.get<Items<CharacterItem>>(`/api/v1/characters${params}`),
  /** 新建/具名 upsert（name/别名命中同域同名时更新）；后端返回包裹体 { character, created } */
  create: (body: Record<string, unknown>) =>
    api.post<{ character: CharacterItem; created: boolean }>('/api/v1/characters', body),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ character: CharacterItem }>(`/api/v1/characters/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/characters/${id}`),
}

/** 上传文件到项目（multipart：purpose + files） */
export async function uploadFiles(
  projectId: number,
  purpose: string,
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<Asset[]> {
  const form = new FormData()
  form.append('purpose', purpose)
  for (const f of files) form.append('files', f)
  const xhr = new XMLHttpRequest()
  const data = await new Promise<string>((resolve, reject) => {
    xhr.open('POST', `/api/v1/projects/${projectId}/imports`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText)
      else {
        let message = `HTTP ${xhr.status}`
        try {
          const d = JSON.parse(xhr.responseText) as ApiErrorBody
          if (d?.error?.message) message = d.error.message
        } catch {
          // ignore
        }
        reject(new ApiError(xhr.status, 'upload', message))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, 'network', '上传失败（网络错误）'))
    xhr.send(form)
  })
  const parsed = JSON.parse(data) as { assets?: Asset[] }
  return parsed.assets ?? []
}

// ===== [M4] 批次 / 统计 / 导出 / 发布 / 设置 =====

export const batchApi = {
  create: (projectId: number, body: Record<string, unknown>) =>
    api.post<{ batch: Batch; runIds: number[] }>(`/api/v1/projects/${projectId}/batches`, body),
  list: (params = '') => api.get<Items<Batch>>(`/api/v1/batches${params}`),
  detail: (id: number) => api.get<BatchDetail>(`/api/v1/batches/${id}`),
  cancel: (id: number) => api.post<{ batch: Batch }>(`/api/v1/batches/${id}/cancel`),
  /** 批量导出（有产物 run 逐个全量打包；无产物记 skipped） */
  exportAll: (id: number) =>
    api.post<{
      items: Array<{ runId: number; assetId: number; name: string }>
      skipped: Array<{ runId: number; reason: string }>
    }>(`/api/v1/batches/${id}/exports`),
}

export const statsApi = {
  overview: (params = '') => api.get<Overview>(`/api/v1/stats/overview${params}`),
  usage: (params = '') => api.get<UsageSummary>(`/api/v1/stats/usage${params}`),
}

export const exportApi = {
  create: (runId: number, body: Record<string, unknown>) =>
    api.post<{ asset: ExportAssetLite }>(`/api/v1/runs/${runId}/exports`, body),
  list: (params = '') => api.get<Items<ExportAssetLite>>(`/api/v1/exports${params}`),
  runAssets: (runId: number) => api.get<Items<RunAssetLite>>(`/api/v1/runs/${runId}/assets`),
  /** 下载导出包（复用资产文件端点；download=1 触发浏览器下载） */
  fileUrl: (assetId: number, download = false) => `/api/v1/assets/${assetId}/file${download ? '?download=1' : ''}`,
}

export const publicationApi = {
  list: (params = '') =>
    api.get<{ items: Publication[]; summary: { views: number; interactions: number } }>(`/api/v1/publications${params}`),
  create: (body: Record<string, unknown>) => api.post<{ publication: Publication }>('/api/v1/publications', body),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ publication: Publication }>(`/api/v1/publications/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/publications/${id}`),
}

export const settingsApi = {
  list: () => api.get<{ items: Array<{ key: string; value: unknown; updatedAt: number }> }>('/api/v1/settings'),
  /** value 即 PUT body（JSON） */
  put: (key: string, value: unknown) =>
    api.put<{ ok: boolean; key: string; updatedAt: number }>(`/api/v1/settings/${encodeURIComponent(key)}`, value),
}
