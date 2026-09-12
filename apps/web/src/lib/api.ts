import type {
  ApiConfig,
  ApiErrorBody,
  ApiProvider,
  Asset,
  Batch,
  BatchDetail,
  CleanupResult,
  ComposeConfig,
  EntityItem,
  EntityKind,
  EntityPolishResult,
  ExportAssetLite,
  FetchModelsResult,
  GcResult,
  GenTask,
  MemoryItem,
  MemoryStatus,
  NovelBoardData,
  Overview,
  Project,
  ProjectDetail,
  PromptItem,
  Publication,
  RerunResult,
  Run,
  RunAssetLite,
  RunDetail,
  ShotBoardData,
  ShotEditItem,
  ShotOp,
  ShotPick,
  StyleExtractResult,
  StylePresetItem,
  TemplateDetail,
  TemplateMeta,
  TemplateValidation,
  UsageSummary,
  VendorCredential,
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
  create: (body: { name: string; genre: string; brief: string; template_key?: string }) =>
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
  /** [M12] 图像有效性检测（同步；仅图片；结果写 params.quality） */
  check: (id: number) => api.post<{ asset: Asset }>(`/api/v1/assets/${id}/check`),
  /** [M12] 项目级版本组批量清理（保留最新/收藏/在用；软删可回溯） */
  cleanupVersions: (projectId: number) =>
    api.post<CleanupResult>(`/api/v1/projects/${projectId}/assets/cleanup-versions`),
  /** [M12] 回收空间（物理删除已清理资产文件；不可逆；行保留） */
  gc: (projectId: number) => api.post<GcResult>(`/api/v1/projects/${projectId}/assets/gc`),
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
}
