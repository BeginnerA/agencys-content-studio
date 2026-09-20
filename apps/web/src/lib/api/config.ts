import { ApiError, api, type Items } from './core'
import type {
  ApiConfig,
  ApiErrorBody,
  ApiProvider,
  BrandConfig,
  BrandSlotKey,
  FetchModelsResult,
  VendorCredential,
  VideoCapsResult,
  ModelSuggestResult,
  VoiceCloneItem,
  VoiceCloneProvider,
} from '../types'

export const configApi = {
  providers: () => api.get<Items<ApiProvider>>('/api/v1/api-providers'),
  list: () => api.get<Items<ApiConfig>>('/api/v1/api-configs'),
  create: (body: Record<string, unknown>) =>
    api.post<ApiConfig>('/api/v1/api-configs', body),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<ApiConfig>(`/api/v1/api-configs/${id}`, body),
  remove: (id: number) => api.del<{ ok: boolean }>(`/api/v1/api-configs/${id}`),
  test: (id: number) =>
    api.post<Record<string, unknown>>(`/api/v1/api-configs/${id}/test`),
  /** 在线拉取供应商可用模型目录（[M33.1] 阿里千问 LLM 走 DashScope 原生带价口，其余 OpenAI 兼容仅 id，失败回退预置） */
  fetchModels: (body: Record<string, unknown>) =>
    api.post<FetchModelsResult>('/api/v1/api-configs/fetch-models', body),
  /** [M32] 查询视频模型能力单一真源表（命中→平台自动背书档位；未命中→回退手填声明） */
  videoCaps: (providerKey: string, model: string) =>
    api.get<VideoCapsResult>(
      `/api/v1/api-configs/video-caps?provider_key=${encodeURIComponent(providerKey)}&model=${encodeURIComponent(model)}`,
    ),
  /** [M33] 跨通道「选中即生成」Tier A 建议：参考定价 + 视频能力 + 默认通道建议 */
  modelSuggest: (providerKey: string, serviceType: string, model: string) =>
    api.get<ModelSuggestResult>(
      `/api/v1/api-configs/model-suggest?provider_key=${encodeURIComponent(providerKey)}&service_type=${encodeURIComponent(serviceType)}&model=${encodeURIComponent(model)}`,
    ),
}

export const vendorApi = {
  list: () => api.get<Items<VendorCredential>>('/api/v1/vendor-credentials'),
  create: (body: Record<string, unknown>) =>
    api.post<{ credential: VendorCredential }>(
      '/api/v1/vendor-credentials',
      body,
    ),
  update: (id: number, body: Record<string, unknown>) =>
    api.put<{ credential: VendorCredential }>(
      `/api/v1/vendor-credentials/${id}`,
      body,
    ),
  remove: (id: number) =>
    api.del<{ ok: boolean }>(`/api/v1/vendor-credentials/${id}`),
}

/**
 * [M19] 平台品牌资产（Settings 品牌 tab；水印/片头/片尾）。
 * 槽参数（position/opacity/enabled 等）走 settingsApi.put('brand', ...) 整体写；本 API 只管文件键通道。
 */
export const brandAssetApi = {
  /** multipart 上传（watermark 须图片 / intro|outro 须视频；≤200MB）→ 更新后 brand 全量 */
  upload: async (
    slot: BrandSlotKey,
    file: File,
  ): Promise<{ brand: BrandConfig }> => {
    const form = new FormData()
    form.append('file', file, file.name)
    let res: Response
    try {
      res = await fetch(`/api/v1/settings/brand/assets/${slot}`, {
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
    return (await res.json()) as { brand: BrandConfig }
  },
  /** 预览 URL（ts 传值防缓存；无引用/文件缺失 → 404） */
  fileUrl: (slot: BrandSlotKey, ts?: number) =>
    `/api/v1/settings/brand/assets/${slot}${ts ? `?t=${ts}` : ''}`,
  /** 清除引用（仅删 file 键；磁盘文件保留）→ 更新后 brand 全量 */
  clear: (slot: BrandSlotKey) =>
    api.del<{ ok: boolean; brand: BrandConfig; note: string }>(
      `/api/v1/settings/brand/assets/${slot}`,
    ),
}

/**
 * [M19 P8] 平台音色库（Settings 音色库 tab；声音克隆）。
 * 密钥不落本表：服务端经 Settings → 语音合成实例（api_configs）解析端点与 Key。
 */
async function voiceCloneSend(
  path: string,
  body: FormData | Record<string, unknown>,
): Promise<Response> {
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
  list: () =>
    api.get<{ items: VoiceCloneItem[]; providers: VoiceCloneProvider[] }>(
      '/api/v1/voice-clones',
    ),
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
    return (await res.json()) as {
      ok: boolean
      clone: VoiceCloneItem
      warnings: string[]
    }
  },
  /** 移除本地登记（供应商侧音色未删；引用该音色的声线配置自动降级） */
  remove: (id: number) =>
    api.del<{ ok: boolean; name: string; note: string }>(
      `/api/v1/voice-clones/${id}`,
    ),
  /** 试听（≤200 字）→ mp3 Blob（不落资产、不记账） */
  test: async (id: number, text: string): Promise<Blob> => {
    const res = await voiceCloneSend(`/api/v1/voice-clones/${id}/test`, {
      text,
    })
    return await res.blob()
  },
}
