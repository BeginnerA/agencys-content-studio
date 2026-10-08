import { ApiError, api, type Items } from './core'
import type {
  ApiErrorBody,
  Asset,
  CleanupResult,
  EntityItem,
  EntityKind,
  EntityPolishResult,
  EntityRefGenIssueResult,
  EntityRefGenTask,
  GcResult,
  MemoryItem,
  MemoryStatus,
  SearchResult,
  StyleExtractResult,
  StylePresetItem,
} from '../types'

export const assetApi = {
  /** 后端返回包裹体 { asset }（与 PATCH 同契约） */
  detail: (id: number) => api.get<{ asset: Asset }>(`/api/v1/assets/${id}`),
  /** 软删除（进回收站，可还原；列表隐藏，文件保留） */
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/assets/${id}`),
  /** 回收站还原（清 deletedAt；文件已被清除 → 409 file_purged） */
  restore: (id: number) =>
    api.post<{ asset: Asset }>(`/api/v1/assets/${id}/restore`),
  /** 回收站彻底删除（物理删文件 + 硬删数据行，不可逆） */
  purge: (id: number) =>
    api.del<{ ok: boolean; files: number; freed_bytes: number }>(
      `/api/v1/assets/${id}/purge`,
    ),
  /** 收藏切换（PATCH 白名单 is_favorite；版本清理保留豁免） */
  favorite: (id: number, fav: boolean) =>
    api.patch<{ asset: Asset }>(`/api/v1/assets/${id}`, {
      is_favorite: fav ? 1 : 0,
    }),
  /** 标签编辑（PATCH 白名单 tags；覆盖式写入字符串数组） */
  updateTags: (id: number, tags: string[]) =>
    api.patch<{ asset: Asset }>(`/api/v1/assets/${id}`, { tags }),
  /** G2 文本内容覆写（白名单 purpose 的文本资产；原子覆盖 + params.content_edits 留痕） */
  updateContent: (id: number, content: string) =>
    api.patch<{ asset: Asset }>(`/api/v1/assets/${id}/content`, { content }),
  /** G8 URL 抓正文 → source 资产（服务端抓取 + SSRF 守卫/限额；错误面：400 守卫拒/过短，502 抓取失败） */
  fetchSource: (projectId: number, url: string) =>
    api.post<{ asset: Asset }>(`/api/v1/projects/${projectId}/fetch-source`, {
      url,
    }),
  /** 图像有效性检测（同步；仅图片；结果写 params.quality） */
  check: (id: number) =>
    api.post<{ asset: Asset }>(`/api/v1/assets/${id}/check`),
  /** 项目级版本组批量清理（保留最新/收藏/在用；其余移入回收站可还原） */
  cleanupVersions: (projectId: number) =>
    api.post<CleanupResult>(
      `/api/v1/projects/${projectId}/assets/cleanup-versions`,
    ),
  /** 清空回收站文件（物理删除回收站内资产文件；不可逆；记录保留可逐条彻底删除） */
  gc: (projectId: number) =>
    api.post<GcResult>(`/api/v1/projects/${projectId}/assets/gc`),
}

/** 全局搜索（关键词九域 + 语义文本域；模型不可用自动降级不抛错） */
export const searchApi = {
  /** limit 默认 5、上限 20（后端 clamp）；q 空/超 100 字符 → 400 */
  search: (q: string, limit?: number) =>
    api.get<SearchResult>(
      `/api/v1/search?q=${encodeURIComponent(q)}${limit !== undefined ? `&limit=${limit}` : ''}`,
    ),
  /** 文本资产向量全量重建（模型不可用 → 后端 503 model_unavailable） */
  reindex: () =>
    api.post<{
      total: number
      indexed: number
      skipped: number
      failed: number
    }>('/api/v1/search/reindex'),
}

// ===== 记忆 / 实体素材 =====

export const memoryApi = {
  list: (params = '') =>
    api.get<Items<MemoryItem>>(`/api/v1/memories${params}`),
  /** 创建/具名 upsert；后端返回包裹体 { memory, created } */
  create: (body: Record<string, unknown>) =>
    api.post<{ memory: MemoryItem; created: boolean }>(
      '/api/v1/memories',
      body,
    ),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ memory: MemoryItem }>(`/api/v1/memories/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/memories/${id}`),
  reindex: () =>
    api.post<{ total: number; rebuilt: number; skipped: number }>(
      '/api/v1/memories/reindex',
    ),
  status: () => api.get<MemoryStatus>('/api/v1/memories/status'),
}

/** 实体素材（角色/场景/道具）：/entities 统一路径 + kind 参数 */
export const entityApi = {
  list: (kind: EntityKind, params = '') =>
    api.get<Items<EntityItem>>(`/api/v1/entities?kind=${kind}${params}`),
  /** 新建/具名 upsert（name/别名命中同域同名时更新）；后端返回包裹体 { entity, created } */
  create: (body: Record<string, unknown>) =>
    api.post<{ entity: EntityItem; created: boolean }>(
      '/api/v1/entities',
      body,
    ),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ entity: EntityItem }>(`/api/v1/entities/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/entities/${id}`),
  /** 批量润色 appearance（ids 1..10 去重；逐项串行，失败项进 failed 不改动） */
  polish: (ids: number[]) =>
    api.post<EntityPolishResult>('/api/v1/entities/polish', { ids }),
  /** 批量发起参考图生成（≤10 实体 × 1-4 变体；202 入队即返，完成后服务端自动挂接 ref_asset_ids） */
  refGen: (projectId: number, entityIds: number[], variants = 1) =>
    api.post<EntityRefGenIssueResult>('/api/v1/entities/ref-gen', {
      projectId,
      entityIds,
      variants,
    }),
  /** 本项任务列表（全部在途置顶 + 近 20 条终态） */
  refGenTasks: (projectId: number) =>
    api.get<{ items: EntityRefGenTask[]; counts: Record<string, number> }>(
      `/api/v1/entities/ref-gen/tasks?project_id=${projectId}`,
    ),
  /** 取消单任务（仅 pending/processing；已发出的出图请求完成后弃存） */
  cancelRefGenTask: (taskId: number) =>
    api.post<{ ok: boolean; note?: string }>(
      `/api/v1/entities/ref-gen/tasks/${taskId}/cancel`,
      {},
    ),
}

/** 上传参考图并挂接实体（multipart：file；服务端 10MB/图片类型校验；全局实体放开：文件入全局素材池并挂接） */
export async function uploadEntityRefImage(
  entityId: number,
  file: File,
): Promise<{ entity: EntityItem; asset: Asset }> {
  const form = new FormData()
  form.append('file', file, file.name)
  let res: Response
  try {
    res = await fetch(`/api/v1/entities/${entityId}/ref-images`, {
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
  return (await res.json()) as { entity: EntityItem; asset: Asset }
}

/** 全局素材池（虚拟项目 #0）：全局实体（角色/场景/道具）的参考图域；
 * 挂接经 entityApi.create/update 的 ref_asset_ids（服务端仅接受池资产） */
export const globalAssetApi = {
  list: (params = '') => api.get<Items<Asset>>(`/api/v1/global/assets${params}`),
  /** 批量上传入池（multipart，字段 file 可多张；仅图片；sha256 去重） */
  upload: async (files: File[], purpose = 'source'): Promise<Asset[]> => {
    const form = new FormData()
    form.append('purpose', purpose)
    for (const f of files) form.append('file', f, f.name)
    let res: Response
    try {
      res = await fetch('/api/v1/global/assets', { method: 'POST', body: form })
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
    const r = (await res.json()) as Items<Asset>
    return r.items
  },
}

/** 风格预设库（?active=1 仅启用； 项目绑定经 PATCH /projects settings.style_preset_ids） */
export const stylePresetApi = {
  list: (params = '') =>
    api.get<Items<StylePresetItem>>(`/api/v1/style-presets${params}`),
  /** 从项目参考图提取画风词（1..4 张；不落库，前端预填表单） */
  extract: (projectId: number, assetIds: number[]) =>
    api.post<StyleExtractResult>('/api/v1/style-presets/extract', {
      project_id: projectId,
      asset_ids: assetIds,
    }),
  create: (body: Record<string, unknown>) =>
    api.post<{ preset: StylePresetItem }>('/api/v1/style-presets', body),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ preset: StylePresetItem }>(`/api/v1/style-presets/${id}`, body),
  remove: (id: number) =>
    api.del<{ ok: boolean }>(`/api/v1/style-presets/${id}`),
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
    xhr.onerror = () =>
      reject(new ApiError(0, 'network', '上传失败（网络错误）'))
    xhr.send(form)
  })
  const parsed = JSON.parse(data) as { items?: Asset[] }
  return parsed.items ?? []
}
