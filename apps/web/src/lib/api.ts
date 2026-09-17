import type {
  AnyNodeSpec,
  ApiConfig,
  ApiErrorBody,
  ApiProvider,
  AspectStrategy,
  AspectValue,
  Asset,
  Batch,
  BatchDetail,
  BrandConfig,
  BrandSlotKey,
  CanvasAdviceResult,
  CanvasArrangeMode,
  CanvasDoc,
  CanvasDocNode,
  CanvasEdgeRow,
  CanvasExportResult,
  CanvasGroup,
  CanvasListItem,
  CanvasNodeRow,
  CanvasOverview,
  CanvasRunBatchResult,
  CanvasSnapshotMeta,
  CanvasViewport,
  CleanupResult,
  ComposeConfig,
  ComposeSfxItem,
  CreationNodeSpec,
  DeriveAspectResult,
  EntityItem,
  EntityKind,
  EntityPolishResult,
  EntityRefGenIssueResult,
  EntityRefGenTask,
  Episode,
  ExportAssetLite,
  FetchModelsResult,
  GcResult,
  GenTask,
  MemoryItem,
  MemoryStatus,
  NovelBoardData,
  Overview,
  ParamChange,
  PreviewCanvasResult,
  Project,
  ProjectDetail,
  PromptItem,
  Publication,
  RerunResult,
  RevisionItem,
  Run,
  RunAssetLite,
  RunCanvas,
  RunDetail,
  SearchResult,
  SeriesInfo,
  ShotBoardData,
  ShotEditItem,
  ShotOp,
  ShotPick,
  SnapshotDiffResult,
  SnapshotRestoreResult,
  StyleExtractResult,
  StylePresetItem,
  TemplateCanvas,
  TemplateDetail,
  TemplateEdits,
  TemplateMeta,
  TemplateValidation,
  UsageSummary,
  VendorCredential,
  VoiceCloneItem,
  VoiceCloneProvider,
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
  /** 项目列表（?status=active|archived，默认 active） */
  list: (params = '') => api.get<Items<Project>>(`/api/v1/projects${params}`),
  create: (body: { name: string; genre: string; brief: string; template_key?: string; tags?: string[] }) =>
    api.post<Project>('/api/v1/projects', body),
  detail: (id: number) => api.get<{ project: ProjectDetail }>(`/api/v1/projects/${id}`),
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
  ) => api.patch<{ project: Record<string, unknown> }>(`/api/v1/projects/${id}`, body),
  /** 资产列表（?limit/offset/kind/purpose/tag；total 为过滤条件下总数） */
  assets: (id: number, params = '') => api.get<{ items: Asset[]; total: number }>(`/api/v1/projects/${id}/assets${params}`),
  runs: (id: number) => api.get<Items<Run>>(`/api/v1/runs?project_id=${id}`),
  /** 归档（逻辑删，可从「已归档」列表恢复） */
  archive: (id: number) => api.del<{ ok: boolean; mode: string }>(`/api/v1/projects/${id}`),
  /** 彻底删除（事务清库 + 删磁盘文件，不可恢复；有未完成运行时服务端 409 拦截） */
  purge: (id: number) =>
    api.del<{ ok: boolean; mode: string; purged: Record<string, number> }>(`/api/v1/projects/${id}?purge=1`),
  /** 恢复归档项目 */
  restore: (id: number) => api.patch<{ project: Record<string, unknown> }>(`/api/v1/projects/${id}`, { status: 'active' }),
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
  /** [M23] 设计态编辑草案：edits 白名单应用 → YAML 序列化（不落盘）→ { yaml, validation, editsApplied } */
  editDraft: (key: string, edits: TemplateEdits) =>
    api.post<{ yaml: string; validation: TemplateValidation; editsApplied: number }>(
      `/api/v1/templates/${encodeURIComponent(key)}/edit-draft`,
      { edits },
    ),
  /** [M23] 编辑落盘为新模板（原文件零触碰；newKey 缺省 <原key>-edit，冲突自动后缀）→ { templateKey, validation } */
  editSave: (key: string, edits: TemplateEdits, newKey?: string) =>
    api.post<{ templateKey: string; validation: TemplateValidation; editsApplied: number }>(
      `/api/v1/templates/${encodeURIComponent(key)}/edit-save`,
      { edits, newKey },
    ),
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
  /** 运行列表（?project_id=&status=；全局待审阅聚合用 status=waiting_input） */
  list: (params = '') => api.get<Items<Run>>(`/api/v1/runs${params}`),
  detail: (id: number) => api.get<RunDetail>(`/api/v1/runs/${id}`),
  log: (id: number, tail = 200) => api.get<{ log: string }>(`/api/v1/runs/${id}/log?tail=${tail}`),
  start: (projectId: number, body: { template_key: string; input: Record<string, unknown> }) =>
    api.post<{ run: Run }>(`/api/v1/projects/${projectId}/runs`, body),
  gate: (id: number, body: Record<string, unknown>) => api.post<RunDetail>(`/api/v1/runs/${id}/gate`, body),
  cancel: (id: number) => api.post<{ run: Run }>(`/api/v1/runs/${id}/cancel`),
  resume: (id: number) => api.post<{ run: Run }>(`/api/v1/runs/${id}/resume`),
  /** [M21] 步骤文本产物版本链（倒序；current = step.output.asset_ids[0]） */
  revisions: (id: number, stepKey: string) =>
    api.get<{ items: RevisionItem[] }>(`/api/v1/runs/${id}/steps/${encodeURIComponent(stepKey)}/revisions`),
  /** [M21] 集级参数热调（受限：queued/running/waiting_input；组内深合并 + 留痕） */
  updateParams: (id: number, params: Record<string, Record<string, unknown>>) =>
    api.patch<{ run: Run; applied: ParamChange[] }>(`/api/v1/runs/${id}/params`, { params }),
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

export const vendorApi = {
  list: () => api.get<Items<VendorCredential>>('/api/v1/vendor-credentials'),
  create: (body: Record<string, unknown>) => api.post<{ credential: VendorCredential }>('/api/v1/vendor-credentials', body),
  update: (id: number, body: Record<string, unknown>) => api.put<{ credential: VendorCredential }>(`/api/v1/vendor-credentials/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/vendor-credentials/${id}`),
}

export const assetApi = {
  /** 后端返回包裹体 { asset }（与 PATCH 同契约） */
  detail: (id: number) => api.get<{ asset: Asset }>(`/api/v1/assets/${id}`),
  /** 软删除（导出包清理用：列表隐藏，文件保留） */
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/assets/${id}`),
  /** [M12] 收藏切换（PATCH 白名单 is_favorite；版本清理保留豁免） */
  favorite: (id: number, fav: boolean) =>
    api.patch<{ asset: Asset }>(`/api/v1/assets/${id}`, { is_favorite: fav ? 1 : 0 }),
  /** [M21] 标签编辑（PATCH 白名单 tags；覆盖式写入字符串数组） */
  updateTags: (id: number, tags: string[]) =>
    api.patch<{ asset: Asset }>(`/api/v1/assets/${id}`, { tags }),
  /** [M25] G2 文本内容覆写（白名单 purpose 的文本资产；原子覆盖 + params.content_edits 留痕） */
  updateContent: (id: number, content: string) =>
    api.patch<{ asset: Asset }>(`/api/v1/assets/${id}/content`, { content }),
  /** [M25] G8 URL 抓正文 → source 资产（服务端抓取 + SSRF 守卫/限额；错误面：400 守卫拒/过短，502 抓取失败） */
  fetchSource: (projectId: number, url: string) =>
    api.post<{ asset: Asset }>(`/api/v1/projects/${projectId}/fetch-source`, { url }),
  /** [M12] 图像有效性检测（同步；仅图片；结果写 params.quality） */
  check: (id: number) => api.post<{ asset: Asset }>(`/api/v1/assets/${id}/check`),
  /** [M12] 项目级版本组批量清理（保留最新/收藏/在用；软删可回溯） */
  cleanupVersions: (projectId: number) =>
    api.post<CleanupResult>(`/api/v1/projects/${projectId}/assets/cleanup-versions`),
  /** [M12] 回收空间（物理删除已清理资产文件；不可逆；行保留） */
  gc: (projectId: number) => api.post<GcResult>(`/api/v1/projects/${projectId}/assets/gc`),
}

/** [M21] 全局搜索（关键词九域 + 语义文本域；模型不可用自动降级不抛错） */
export const searchApi = {
  /** limit 默认 5、上限 20（后端 clamp）；q 空/超 100 字符 → 400 */
  search: (q: string, limit?: number) =>
    api.get<SearchResult>(`/api/v1/search?q=${encodeURIComponent(q)}${limit !== undefined ? `&limit=${limit}` : ''}`),
  /** 文本资产向量全量重建（模型不可用 → 后端 503 model_unavailable） */
  reindex: () =>
    api.post<{ total: number; indexed: number; skipped: number; failed: number }>('/api/v1/search/reindex'),
}

// ===== [M3/M8] 记忆 / 实体素材 =====

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

/** [M8] 实体素材（角色/场景/道具）：/entities 统一路径 + kind 参数 */
export const entityApi = {
  list: (kind: EntityKind, params = '') => api.get<Items<EntityItem>>(`/api/v1/entities?kind=${kind}${params}`),
  /** 新建/具名 upsert（name/别名命中同域同名时更新）；后端返回包裹体 { entity, created } */
  create: (body: Record<string, unknown>) =>
    api.post<{ entity: EntityItem; created: boolean }>('/api/v1/entities', body),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ entity: EntityItem }>(`/api/v1/entities/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/entities/${id}`),
  /** [M13] 批量润色 appearance（ids 1..10 去重；逐项串行，失败项进 failed 不改动） */
  polish: (ids: number[]) => api.post<EntityPolishResult>('/api/v1/entities/polish', { ids }),
  /** [M19 P6] 批量发起参考图生成（≤10 实体 × 1-4 变体；202 入队即返，完成后服务端自动挂接 ref_asset_ids） */
  refGen: (projectId: number, entityIds: number[], variants = 1) =>
    api.post<EntityRefGenIssueResult>('/api/v1/entities/ref-gen', { projectId, entityIds, variants }),
  /** [M19 P6] 本项任务列表（全部在途置顶 + 近 20 条终态） */
  refGenTasks: (projectId: number) =>
    api.get<{ items: EntityRefGenTask[]; counts: Record<string, number> }>(`/api/v1/entities/ref-gen/tasks?project_id=${projectId}`),
  /** [M19 P6] 取消单任务（仅 pending/processing；已发出的出图请求完成后弃存） */
  cancelRefGenTask: (taskId: number) => api.post<{ ok: boolean; note?: string }>(`/api/v1/entities/ref-gen/tasks/${taskId}/cancel`, {}),
}

/** [M13] 上传参考图并挂接实体（multipart：file；服务端 10MB/图片类型校验；全局实体 400） */
export async function uploadEntityRefImage(entityId: number, file: File): Promise<{ entity: EntityItem; asset: Asset }> {
  const form = new FormData()
  form.append('file', file, file.name)
  let res: Response
  try {
    res = await fetch(`/api/v1/entities/${entityId}/ref-images`, { method: 'POST', body: form })
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
  return (await res.json()) as { entity: EntityItem; asset: Asset }
}

/** [M8] 风格预设库（?active=1 仅启用；[M13] 项目绑定经 PATCH /projects settings.style_preset_ids） */
export const stylePresetApi = {
  list: (params = '') => api.get<Items<StylePresetItem>>(`/api/v1/style-presets${params}`),
  /** [M13] 从项目参考图提取画风词（1..4 张；不落库，前端预填表单） */
  extract: (projectId: number, assetIds: number[]) =>
    api.post<StyleExtractResult>('/api/v1/style-presets/extract', { project_id: projectId, asset_ids: assetIds }),
  create: (body: Record<string, unknown>) => api.post<{ preset: StylePresetItem }>('/api/v1/style-presets', body),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ preset: StylePresetItem }>(`/api/v1/style-presets/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/style-presets/${id}`),
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
  const parsed = JSON.parse(data) as { items?: Asset[] }
  return parsed.items ?? []
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
  costBreakdown: (params = '') => api.get<import('./types').CostBreakdown>(`/api/v1/stats/cost-breakdown${params}`),
  // [M20] B7 CSV 导出 URL（直接下载）
  csvRuns: (params = '') => `/api/v1/stats/csv/runs${params}`,
  csvPublications: (params = '') => `/api/v1/stats/csv/publications${params}`,
  csvUsage: (params = '') => `/api/v1/stats/csv/usage${params}`,
  // [M20] B7 趋势对比
  compare: (params = '') => api.get<import('./types').CompareResult>(`/api/v1/stats/compare${params}`),
}

export const exportApi = {
  create: (runId: number, body: Record<string, unknown>) =>
    api.post<{ asset: ExportAssetLite }>(`/api/v1/runs/${runId}/exports`, body),
  list: (params = '') => api.get<Items<ExportAssetLite>>(`/api/v1/exports${params}`),
  runAssets: (runId: number) => api.get<Items<RunAssetLite>>(`/api/v1/runs/${runId}/assets`),
  /** 下载导出包（复用资产文件端点；download=1 触发浏览器下载） */
  fileUrl: (assetId: number, download = false) => `/api/v1/assets/${assetId}/file${download ? '?download=1' : ''}`,
  // [M20] B8 平台预设
  presets: () => api.get<{ items: import('./types').ExportPreset[]; defaults: string[] }>('/api/v1/exports/presets'),
  savePresets: (items: import('./types').ExportPreset[]) =>
    api.put<{ items: import('./types').ExportPreset[] }>('/api/v1/exports/presets', { items }),
}

export const publicationApi = {
  list: (params = '') =>
    api.get<{ items: Publication[]; summary: { views: number; interactions: number } }>(`/api/v1/publications${params}`),
  create: (body: Record<string, unknown>) => api.post<{ publication: Publication }>('/api/v1/publications', body),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ publication: Publication }>(`/api/v1/publications/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/publications/${id}`),
  // [M20] 批量导入 / 趋势 / A/B 分组
  batch: (items: Array<Record<string, unknown>>) =>
    api.post<{ count: number; items: Publication[] }>('/api/v1/publications/batch', { items }),
  trend: (params = '') =>
    api.get<{ items: import('./types').PublicationTrendItem[]; days: number }>(`/api/v1/publications/trend${params}`),
  abGroups: (params = '') =>
    api.get<{ items: import('./types').AbGroupItem[] }>(`/api/v1/publications/ab-groups${params}`),
}

export const settingsApi = {
  list: () => api.get<{ items: Array<{ key: string; value: unknown; updatedAt: number }> }>('/api/v1/settings'),
  /** value 即 PUT body（JSON） */
  put: (key: string, value: unknown) =>
    api.put<{ ok: boolean; key: string; updatedAt: number }>(`/api/v1/settings/${encodeURIComponent(key)}`, value),
}

/**
 * [M19] 平台品牌资产（Settings 品牌 tab；水印/片头/片尾）。
 * 槽参数（position/opacity/enabled 等）走 settingsApi.put('brand', ...) 整体写；本 API 只管文件键通道。
 */
export const brandAssetApi = {
  /** multipart 上传（watermark 须图片 / intro|outro 须视频；≤200MB）→ 更新后 brand 全量 */
  upload: async (slot: BrandSlotKey, file: File): Promise<{ brand: BrandConfig }> => {
    const form = new FormData()
    form.append('file', file, file.name)
    let res: Response
    try {
      res = await fetch(`/api/v1/settings/brand/assets/${slot}`, { method: 'POST', body: form })
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
    return (await res.json()) as { brand: BrandConfig }
  },
  /** 预览 URL（ts 传值防缓存；无引用/文件缺失 → 404） */
  fileUrl: (slot: BrandSlotKey, ts?: number) => `/api/v1/settings/brand/assets/${slot}${ts ? `?t=${ts}` : ''}`,
  /** 清除引用（仅删 file 键；磁盘文件保留）→ 更新后 brand 全量 */
  clear: (slot: BrandSlotKey) =>
    api.del<{ ok: boolean; brand: BrandConfig; note: string }>(`/api/v1/settings/brand/assets/${slot}`),
}

/**
 * [M19 P8] 平台音色库（Settings 音色库 tab；声音克隆）。
 * 密钥不落本表：服务端经 Settings → 语音合成实例（api_configs）解析端点与 Key。
 */
async function voiceCloneSend(path: string, body: FormData | Record<string, unknown>): Promise<Response> {
  const isForm = body instanceof FormData
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
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
  return res
}

export const voiceCloneApi = {
  /** 音色列表 + 能力位矩阵（available=false 的供应商不可选） */
  list: () => api.get<{ items: VoiceCloneItem[]; providers: VoiceCloneProvider[] }>('/api/v1/voice-clones'),
  /** multipart 克隆创建（样本 wav/mp3 ≤10MB；失败不落行：400 校验 / 502 供应商详情） */
  create: async (p: {
    name: string
    provider: string
    file?: File | null
    targetModel?: string
    sampleUrl?: string
  }): Promise<{ ok: boolean; clone: VoiceCloneItem; warnings: string[] }> => {
    const form = new FormData()
    form.append('name', p.name)
    form.append('provider', p.provider)
    if (p.targetModel) form.append('target_model', p.targetModel)
    if (p.sampleUrl) form.append('sample_url', p.sampleUrl)
    if (p.file) form.append('file', p.file, p.file.name)
    const res = await voiceCloneSend('/api/v1/voice-clones', form)
    return (await res.json()) as { ok: boolean; clone: VoiceCloneItem; warnings: string[] }
  },
  /** 移除本地登记（供应商侧音色未删；引用该音色的声线配置自动降级） */
  remove: (id: number) => api.del<{ ok: boolean; name: string; note: string }>(`/api/v1/voice-clones/${id}`),
  /** 试听（≤200 字）→ mp3 Blob（不落资产、不记账） */
  test: async (id: number, text: string): Promise<Blob> => {
    const res = await voiceCloneSend(`/api/v1/voice-clones/${id}/test`, { text })
    return await res.blob()
  },
}

// ===== [M7] 镜头工作台 =====

export const shotApi = {
  /** 工作台聚合读（镜头 × 任务 × 版本 × 选中 × 合成新鲜度） */
  board: (runId: number, stepKey: string) =>
    api.get<ShotBoardData>(`/api/v1/runs/${runId}/shot-board?step_key=${encodeURIComponent(stepKey)}`),
  /** 分镜字段级编辑（时长/提示词；写新分镜版本，重新合成后生效） */
  edit: (runId: number, stepKey: string, shots: ShotEditItem[]) =>
    api.post<{ ok: boolean; asset_id: number; asset_ids: number[]; edited: number }>(
      `/api/v1/runs/${runId}/shots/edit`,
      { step_key: stepKey, shots },
    ),
  /** 单镜重生成（可选携带编辑字段：先写分镜再重置入队，仅目标镜重跑） */
  regenerate: (runId: number, stepKey: string, item: ShotEditItem) =>
    api.post<{ ok: boolean; edited: boolean; run_id: number; task_id: number; note: string }>(
      `/api/v1/runs/${runId}/shots/regenerate`,
      { step_key: stepKey, ...item },
    ),
  /** 多版本选片 / 选镜（picks 为子集；reset=true 恢复全量最新；不触发执行） */
  select: (runId: number, stepKey: string, opts: { picks?: ShotPick[]; reset?: boolean }) =>
    api.post<{ ok: boolean; asset_ids: number[] }>(
      `/api/v1/runs/${runId}/shots/select`,
      { step_key: stepKey, ...opts },
    ),
  /** [M10] 结构性编辑（reorder/add/remove/patch；写新分镜版本，不触发执行） */
  mutate: (runId: number, stepKey: string, ops: ShotOp[]) =>
    api.post<{ ok: boolean; asset_id: number; asset_ids: number[]; shots: number; note: string }>(
      `/api/v1/runs/${runId}/shots/mutate`,
      { step_key: stepKey, ops },
    ),
  /** [M10] 上传替换镜头（multipart：file + step_key + shot_id；入库 + 绑定选中） */
  uploadShot: async (runId: number, stepKey: string, shotId: string, file: File) => {
    const form = new FormData()
    form.append('step_key', stepKey)
    form.append('shot_id', shotId)
    form.append('file', file, file.name)
    let res: Response
    try {
      res = await fetch(`/api/v1/runs/${runId}/shots/upload`, { method: 'POST', body: form })
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
    return (await res.json()) as { ok: boolean; asset: Asset; asset_ids: number[]; note: string }
  },
  /** 重新合成（重置 ffmpeg_merge；succeeded 镜头步骤全跳过） */
  recompose: (runId: number, stepKey: string) =>
    api.post<{ ok: boolean; run_id: number; note: string }>(
      `/api/v1/runs/${runId}/recompose`,
      { step_key: stepKey },
    ),
  /** [M12] 版本组批量清理（保留最新/收藏/在用；软删可回溯；不触发执行） */
  cleanup: (runId: number, stepKey: string) =>
    api.post<CleanupResult & { run_id: number; step_key: string }>(
      `/api/v1/runs/${runId}/shots/cleanup`,
      { step_key: stepKey },
    ),
}

// ===== [M9] 小说改编链 =====

export const novelApi = {
  /** 小说改编看板聚合读（章节切分 × 事件图谱 × 分集规划 × 改编剧本） */
  board: (runId: number) => api.get<NovelBoardData>(`/api/v1/runs/${runId}/novel-board`),
}

// ===== [M11] 单步重跑 / 合成设置（BGM·转场） =====

export const stepApi = {
  /** 引擎级单步重跑（复用成功子任务；reset_tasks=true 全量重跑；succeeded 下游步骤照常跳过） */
  rerun: (runId: number, stepKey: string, opts: { reset_tasks?: boolean } = {}) =>
    api.post<RerunResult>(`/api/v1/runs/${runId}/steps/${encodeURIComponent(stepKey)}/rerun`, opts),
}

export const composeApi = {
  /** 合成配置回显（config 空对象 = 未设置，前端用默认值展示） */
  getConfig: (runId: number) => api.get<{ config: ComposeConfig }>(`/api/v1/runs/${runId}/compose/config`),
  /** 更新（transition/duration/bgm_volume/bgm_fade；白名单+枚举+clamp） */
  updateConfig: (runId: number, patch: ComposeConfig) =>
    api.put<{ ok: boolean; config: ComposeConfig; note: string }>(`/api/v1/runs/${runId}/compose/config`, patch),
  /** 当前 BGM（null = 未绑定） */
  getBgm: (runId: number) => api.get<{ bgm: Asset | null }>(`/api/v1/runs/${runId}/compose/bgm`),
  /** 绑定项目音频资产（复制行；不污染源资产） */
  bindBgm: (runId: number, assetId: number) =>
    api.post<{ ok: boolean; bgm: Asset; note: string }>(`/api/v1/runs/${runId}/compose/bgm`, { asset_id: assetId }),
  /** 上传音频绑定（multipart：file） */
  uploadBgm: async (runId: number, file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    let res: Response
    try {
      res = await fetch(`/api/v1/runs/${runId}/compose/bgm`, { method: 'POST', body: form })
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
    return (await res.json()) as { ok: boolean; bgm: Asset; note: string }
  },
  /** 移除 BGM（软删本 run 有效行） */
  removeBgm: (runId: number) => api.del<{ ok: boolean; note: string }>(`/api/v1/runs/${runId}/compose/bgm`),
  /** [M19] SFX 列表（shotId → 资产；每镜 ≤1 条有效） */
  listSfx: (runId: number) => api.get<{ items: ComposeSfxItem[] }>(`/api/v1/runs/${runId}/compose/sfx`),
  /** [M19] 绑定项目音频资产到指定镜头（复制行；不污染源资产） */
  bindSfx: (runId: number, shotId: string, assetId: number) =>
    api.post<{ ok: boolean; item: ComposeSfxItem; note: string }>(`/api/v1/runs/${runId}/compose/sfx`, {
      shot_id: shotId,
      asset_id: assetId,
    }),
  /** [M19] 上传音频绑定到指定镜头（multipart：shot_id + file） */
  uploadSfx: async (runId: number, shotId: string, file: File) => {
    const form = new FormData()
    form.append('shot_id', shotId)
    form.append('file', file, file.name)
    let res: Response
    try {
      res = await fetch(`/api/v1/runs/${runId}/compose/sfx`, { method: 'POST', body: form })
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
    return (await res.json()) as { ok: boolean; item: ComposeSfxItem; note: string }
  },
  /** [M19] 移除某镜音效（软删该镜全部有效行） */
  removeSfx: (runId: number, shotId: string) =>
    api.del<{ ok: boolean; note: string }>(`/api/v1/runs/${runId}/compose/sfx/${encodeURIComponent(shotId)}`),
  /**
   * [M19] 成片多画幅派生（A 路径；源 = 该 run 最新 final_video）。
   * 单路重编码同步完成（本地单机工具，长成片耗时相应增长）；同参已派生 → reused。
   */
  deriveAspect: (runId: number, aspect: AspectValue, strategy?: AspectStrategy) =>
    api.post<DeriveAspectResult>(`/api/v1/runs/${runId}/derive-aspect`, {
      aspect,
      ...(strategy ? { strategy } : {}),
    }),
}

// ===== [M14] 剧集实体（series → episodes 两级，一项目一剧） =====

export const seriesApi = {
  /** 项目剧 + 集列表（无剧 → { series: null, episodes: [] }） */
  get: (projectId: number) =>
    api.get<{ series: SeriesInfo | null; episodes: Episode[] }>(`/api/v1/projects/${projectId}/series`),
  /** 建剧（生成 1..N 集行；已有剧 → 409 series_exists） */
  create: (projectId: number, body: { name: string; total_episodes: number; content_asset_id?: number | null }) =>
    api.post<{ series: SeriesInfo; episodes: Episode[] }>(`/api/v1/projects/${projectId}/series`, body),
  /** 集数调整（扩容追集 / 缩容删尾部空集；被删集有 run / 资产 → 409 episode_in_use） */
  updateTotal: (seriesId: number, totalEpisodes: number) =>
    api.patch<{ series: SeriesInfo; episodes: Episode[] }>(`/api/v1/series/${seriesId}`, { total_episodes: totalEpisodes }),
  /** 删剧（任集关联 run / 资产 → 409 series_in_use） */
  remove: (seriesId: number) => api.del<{ ok: boolean }>(`/api/v1/series/${seriesId}`),
  /** 单集更新（title / status locked|planning|done / content_asset_id） */
  updateEpisode: (episodeId: number, body: { title?: string | null; status?: string; content_asset_id?: number | null }) =>
    api.patch<{ episode: Episode }>(`/api/v1/episodes/${episodeId}`, body),
  /** 删集（保留 run 与资产，仅删集行） */
  removeEpisode: (episodeId: number) => api.del<{ ok: boolean }>(`/api/v1/episodes/${episodeId}`),
}

// ===== [M15] 流水线画布（纯读读模型；操作全部复用既有端点） =====

export const canvasApi = {
  /** 运行画布：节点（状态/闸门/任务计数/产物/操作可用性）+ 边（调度依赖 + 数据引用） */
  run: (id: number) => api.get<RunCanvas>(`/api/v1/runs/${id}/canvas`),
  /** 模板画布：设计态编排预览（gate/when 摘要 + 两类边；无运行字段） */
  template: (key: string) => api.get<TemplateCanvas>(`/api/v1/templates/${encodeURIComponent(key)}/canvas`),
  /** [M23] 全景聚合：项目内跨批次（组内 batchSeq 升序）+ 独立 runs + stats */
  overview: (projectId: number) => api.get<CanvasOverview>(`/api/v1/canvas/overview?project_id=${projectId}`),
}

// ===== [M16/M17] 创作画布（写模型：自由摆放 / 引用连线 / 就地生成与编辑 / 批量运维 / 导出） =====

/** 建节点请求（[M17] 5 型；restoreFromNodeId：快照重建时认领已删节点的任务历史——仅 gen 节点由撤销流程传入） */
type RestoreClaim = { restoreFromNodeId?: number }
export type AddNodeBody = RestoreClaim &
  (
    | { kind: 'asset'; assetId: number; x: number; y: number; title?: string }
    | { kind: 'gen'; spec: CreationNodeSpec; x: number; y: number; title?: string }
    | { kind: 'text'; spec: { text: string }; x: number; y: number; title?: string }
    | { kind: 'entity'; entityId: number; x: number; y: number; title?: string }
    | { kind: 'run'; runId: number; x: number; y: number; title?: string }
  )

/** 节点部分更新（单节点 PATCH 与 batch updates[] 同构；spec 按 kind 解析） */
export interface CanvasNodePatch {
  x?: number
  y?: number
  title?: string | null
  spec?: AnyNodeSpec
  seq?: number | null
  adoptedTaskId?: number | null
}

export const creationApi = {
  /** 项目画布列表（含节点数/更新时间；[M18] trash=true 回收站视图） */
  list: (projectId: number, opts?: { trash?: boolean }) =>
    api.get<Items<CanvasListItem>>(`/api/v1/projects/${projectId}/canvases${opts?.trash ? '?trash=1' : ''}`),
  /** 新建画布（空名 → 默认「未命名画布」） */
  create: (projectId: number, name?: string) =>
    api.post<{ canvas: { id: number; name: string; viewport: CanvasViewport } }>(`/api/v1/projects/${projectId}/canvases`, { name }),
  /** 画布全量读模型（节点状态/readiness/editCapability 派生） */
  doc: (id: number) => api.get<CanvasDoc>(`/api/v1/canvases/${id}`),
  /** 改名 / 存视口 */
  update: (id: number, body: { name?: string; viewport?: CanvasViewport }) =>
    api.patch<{ canvas: { id: number; name: string } }>(`/api/v1/canvases/${id}`, body),
  /** [M18] 删除画布 → 移入回收站（在途任务自动取消；可恢复或彻底删除） */
  remove: (id: number) =>
    api.del<{ ok: boolean; mode: 'trashed'; deletedAt: number; cancelled: number }>(`/api/v1/canvases/${id}`),
  /** [M18] 回收站恢复（未在回收站 → 400 bad_state） */
  restore: (id: number) => api.post<{ canvas: { id: number; name: string } }>(`/api/v1/canvases/${id}/restore`),
  /** [M18] 彻底删除（要求先软删；级联清子行；gen_tasks 留痕） */
  purge: (id: number) => api.post<{ ok: boolean }>(`/api/v1/canvases/${id}/purge`),
  /** [M18] 快照列表（元信息新→旧；不含文档全文） */
  snapshots: (id: number) => api.get<Items<CanvasSnapshotMeta>>(`/api/v1/canvases/${id}/snapshots`),
  /** [M18] 创建快照（缺省 label「快照 N」；上限 20 满额 → 400） */
  createSnapshot: (id: number, label?: string) =>
    api.post<{ snapshot: { id: number; label: string; createdAt: number } }>(`/api/v1/canvases/${id}/snapshots`, { label }),
  /** [M18] 保留 id 重放恢复（先自动备份；行 id 被他画布占用 → 409 conflict） */
  restoreSnapshot: (id: number, sid: number) =>
    api.post<SnapshotRestoreResult>(`/api/v1/canvases/${id}/snapshots/${sid}/restore`),
  /** [M18] 删除快照（画布域限定；不存在/不属本画布 → 404） */
  deleteSnapshot: (id: number, sid: number) => api.del<{ ok: boolean }>(`/api/v1/canvases/${id}/snapshots/${sid}`),
  /** [M22] 快照对比：快照 ↔ live/另一快照 字段级差异（against 缺省 live；快照缺失 → 404） */
  snapshotDiff: (id: number, sid: number, against?: string) =>
    api.get<SnapshotDiffResult>(`/api/v1/canvases/${id}/snapshots/${sid}/diff?against=${encodeURIComponent(against ?? 'live')}`),
  /** [M22] 从快照分支为新画布（新 id 重放；name 缺省「{源名} 分支」）→ 新画布 */
  branchSnapshot: (id: number, sid: number, name?: string) =>
    api.post<{ canvas: { id: number; name: string } }>(`/api/v1/canvases/${id}/snapshots/${sid}/branch`, { name }),
  /** 建节点（asset：项目域资产校验；gen/text：spec 合法校验；entity/run：归属校验）→ DB 行
   *  （restoreFromNodeId：撤销重建认领已删节点任务历史时响应附 claimed 计数） */
  addNode: (canvasId: number, body: AddNodeBody) =>
    api.post<{ node: CanvasNodeRow; claimed?: number }>(`/api/v1/canvases/${canvasId}/nodes`, body),
  /** 更新节点（拖拽落点 / 标题 / spec / 序号 / 采纳）→ DB 行 */
  updateNode: (id: number, patch: CanvasNodePatch) =>
    api.patch<{ node: CanvasNodeRow }>(`/api/v1/nodes/${id}`, patch),
  removeNode: (id: number) => api.del<{ ok: boolean }>(`/api/v1/nodes/${id}`),
  /** [M17] 批量部分更新（预校验全量合法才写；spec 校验失败零写入） */
  batchNodes: (canvasId: number, updates: Array<CanvasNodePatch & { id: number }>) =>
    api.post<{ ok: boolean; updated: number }>(`/api/v1/canvases/${canvasId}/nodes/batch`, { updates }),
  /** [M17] 批量删除（级联其全部连线）→ 删除计数 */
  deleteNodes: (canvasId: number, ids: number[]) =>
    api.post<{ deleted: number; edges: number }>(`/api/v1/canvases/${canvasId}/nodes/delete`, { ids }),
  /** [M17] 批量复制（深拷；集合内部边重映射）→ 新 DB 行 */
  copyNodes: (canvasId: number, ids: number[], offset?: { x?: number; y?: number }) =>
    api.post<{ nodes: CanvasNodeRow[]; edges: CanvasEdgeRow[] }>(`/api/v1/canvases/${canvasId}/nodes/copy`, { ids, offset }),
  /** [M22] 跨画布复制（同项目直接引用 / 跨项目资产级联拷贝）→ 新建行 + 跳过/警告报告 */
  copyTo: (canvasId: number, body: { targetCanvasId: number; ids: number[]; offset?: { x?: number; y?: number } }) =>
    api.post<{
      nodes: CanvasNodeRow[]
      edges: CanvasEdgeRow[]
      skipped: Array<{ nodeId: number; reason: string }>
      assetsCopied: number
      warnings: string[]
    }>(`/api/v1/canvases/${canvasId}/nodes/copy-to`, body),
  /** [M17] 规则式串联（按给定顺序相邻连接；端口按产物类型决策，失败项入 skipped） */
  chainNodes: (canvasId: number, ids: number[]) =>
    api.post<{ created: CanvasEdgeRow[]; skipped: Array<{ from: number; to: number; reason: string }> }>(
      `/api/v1/canvases/${canvasId}/nodes/chain`,
      { ids },
    ),
  /** [M17] 整理/对齐/分布（sortBy:'seq' 时 seq 优先；落库并返回新落点） */
  arrange: (canvasId: number, body: { mode: CanvasArrangeMode; nodeIds?: number[]; sortBy?: 'seq' }) =>
    api.post<{ updated: number; positions: Array<{ id: number; x: number; y: number }> }>(
      `/api/v1/canvases/${canvasId}/arrange`,
      body,
    ),
  /** 建边（端口矩阵 + 环检测；非法 → 400 附原因） */
  addEdge: (canvasId: number, body: { from: number; to: number; port: string }) =>
    api.post<{ edge: { id: number } }>(`/api/v1/canvases/${canvasId}/edges`, body),
  removeEdge: (id: number) => api.del<{ ok: boolean }>(`/api/v1/edges/${id}`),
  /** 执行 gen 节点（readiness 不过 → 400 附 problems；[M17] variants 1-4，缺省 ×1） */
  run: (nodeId: number, variants?: number) =>
    api.post<{ ok: boolean; taskId: number; taskIds: number[] }>(
      `/api/v1/nodes/${nodeId}/run`,
      variants === undefined ? undefined : { variants },
    ),
  /** [M17] 批量执行（缺省全画布；只入队就绪节点，不级联等待） */
  runBatch: (canvasId: number, body?: { nodeIds?: number[]; variants?: number }) =>
    api.post<CanvasRunBatchResult>(`/api/v1/canvases/${canvasId}/run`, body),
  /** [M18] 执行成本预估（零副作用；nodeIds 缺省 = 全部 gen 节点） */
  runPreview: (canvasId: number, nodeIds?: number[]) =>
    api.post<PreviewCanvasResult>(`/api/v1/canvases/${canvasId}/run-preview`, { nodeIds }),
  /** [M18] 一键停止全部（画的 pending/processing 任务 → cancelled） */
  cancelTasks: (canvasId: number) =>
    api.post<{ cancelled: number }>(`/api/v1/canvases/${canvasId}/tasks/cancel`),
  /** [M17] 提取文本节点（gen: spec.prompt；asset: 文本资产全文；缺省位置 = 源节点右侧偏移） */
  extractText: (nodeId: number, body?: { x?: number; y?: number }) =>
    api.post<{ node: CanvasNodeRow }>(`/api/v1/nodes/${nodeId}/extract`, body),
  /** [M18/M22·⑨] 视频抽帧（gen(video) 显示产物 / asset 视频资产 → 新建 asset 节点；缺省位置 = 源节点右下偏移）
   *  [M22] mode='uniform' + count 2–9：均匀多帧 → 响应追加 nodes/assets（node/asset = 首帧兼容） */
  extractFrame: (
    nodeId: number,
    body?: { mode?: 'first' | 'last' | 'custom' | 'uniform'; time?: number; count?: number; x?: number; y?: number },
  ) =>
    api.post<{ node: CanvasNodeRow; asset: Asset; nodes?: CanvasNodeRow[]; assets?: Asset[] }>(
      `/api/v1/nodes/${nodeId}/extract-frame`,
      body,
    ),
  /** [M17] AI 扩写（内容源 = text.text / gen.prompt；不落库；未配置 LLM → 400 引导 Settings） */
  promptExpand: (nodeId: number, instruction?: string) =>
    api.post<{ prompt: string; provider: string; model: string }>(`/api/v1/nodes/${nodeId}/prompt-expand`, { instruction }),
  /** [M17] 打包导出 zip（→ archive 资产；下载复用 GET /assets/:id/file?download=1） */
  exportZip: (canvasId: number, nodeIds?: number[]) =>
    api.post<CanvasExportResult>(`/api/v1/canvases/${canvasId}/export`, { nodeIds }),
  /** [M22] 布局图导出（SVG 落资产库；svg 文本供前端光栅化 PNG） */
  exportImage: (canvasId: number, format: 'svg' = 'svg') =>
    api.post<{ assetId: number; svg: string }>(`/api/v1/canvases/${canvasId}/export-image`, { format }),
  /** 复制画布（节点 id 映射重建边） */
  duplicate: (id: number, name?: string) =>
    api.post<{ canvas: { id: number; name: string } }>(`/api/v1/canvases/${id}/duplicate`, { name }),
  /** [M18] 模板草案 v2：yaml + validation + lossy 清单 */
  templateDraft: (id: number, key?: string) =>
    api.post<{ yaml: string; validation: TemplateValidation; lossy: string[] }>(`/api/v1/canvases/${id}/template-draft`, { key }),
  /** [M18] 模板一键试跑：建 queued run（子图闭包 + inputs 预填 + key 冲突自动后缀） */
  templateTry: (id: number, body?: { nodeIds?: number[]; key?: string }) =>
    api.post<{ templateKey: string; runId: number; lossy: string[]; input: Record<string, unknown> }>(
      `/api/v1/canvases/${id}/template-try`,
      body ?? {},
    ),
  /** [M23] LLM 建议式编排（显式单次触发；未配置 → 400 llm_unavailable；仅建议不执行） */
  advice: (id: number) => api.post<CanvasAdviceResult>(`/api/v1/canvases/${id}/advice`),
  /** 联动：画布产物并集挂接实体参考图 */
  attachRefAssets: (entityId: number, assetIds: number[]) =>
    api.post<{ ok: boolean; added: number }>(`/api/v1/entities/${entityId}/ref-assets`, { asset_ids: assetIds }),
  /** [M18/M22] 成组（nodeIds/groupIds 至少一非空；groupIds 须顶层组；parentId 装入新组；违规 400）*/
  createGroup: (
    canvasId: number,
    body: { nodeIds?: number[]; groupIds?: number[]; parentId?: number | null; title?: string; color?: string | null },
  ) =>
    api.post<{ group: CanvasGroup }>(`/api/v1/canvases/${canvasId}/groups`, body),
  /** [M18/M22] 改组（title/color/collapsed/x/y/parentId 局部；parentId=null 提升顶层）*/
  updateGroup: (
    canvasId: number,
    gid: number,
    patch: { title?: string; color?: string | null; collapsed?: boolean; x?: number; y?: number; parentId?: number | null },
  ) => api.patch<{ group: CanvasGroup }>(`/api/v1/canvases/${canvasId}/groups/${gid}`, patch),
  /** [M18] 解组（成员归属清空 + 组行删除）*/
  deleteGroup: (canvasId: number, gid: number) =>
    api.del<{ ok: boolean }>(`/api/v1/canvases/${canvasId}/groups/${gid}`),
}

/** [M16] 蒙版资产视图（EditBrushModal 上传回填） */
export type { CanvasDocNode }

// ===== [M20] 排产计划 + 预算 =====

export const scheduleApi = {
  list: (params = '') =>
    api.get<{ items: import('./types').Schedule[] }>(`/api/v1/schedules${params}`),
  calendar: (params = '') =>
    api.get<{ items: import('./types').ScheduleCalendarItem[] }>(`/api/v1/schedules/calendar${params}`),
  detail: (id: number) =>
    api.get<{ schedule: import('./types').Schedule }>(`/api/v1/schedules/${id}`),
  create: (projectId: number, body: Record<string, unknown>) =>
    api.post<{ schedule: import('./types').Schedule }>(`/api/v1/projects/${projectId}/schedules`, body),
  cancel: (id: number) =>
    api.post<{ schedule: import('./types').Schedule }>(`/api/v1/schedules/${id}/cancel`, {}),
  reset: (id: number) =>
    api.post<{ schedule: import('./types').Schedule }>(`/api/v1/schedules/${id}/reset`, {}),
  remove: (id: number) =>
    api.del<{ ok: boolean }>(`/api/v1/schedules/${id}`),
}

export const budgetApi = {
  overview: () =>
    api.get<import('./types').BudgetOverviewResult>('/api/v1/budget'),
  save: (cfg: import('./types').BudgetConfig) =>
    api.put<{ budget: import('./types').BudgetConfig }>('/api/v1/budget', cfg),
  alerts: (params = '') =>
    api.get<{ items: import('./types').BudgetAlert[] }>(`/api/v1/budget/alerts${params}`),
  check: (projectId: number, estimatedCost = 0) =>
    api.post<{ allowed: boolean; reason: { code: string; message: string } | null }>('/api/v1/budget/check', {
      project_id: projectId,
      estimated_cost: estimatedCost,
    }),
}
