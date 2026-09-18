/**
 * 视频适配器注册表与请求组装（M2 启用，对齐 provider.ts 的 image 模式）。
 * 搬运源：huobao-drama/backend/src/services/adapters/{minimax,volcengine,aliyun-wan}-video.ts
 * 扩展：siliconflow_video（submit/status 轮询协议）、pollinations_video（GET 同步长请求）。
 */
import { AliyunWanVideoAdapter } from './aliyun-wan-video'
import { MiniMaxVideoAdapter } from './minimax-video'
import { PollinationsVideoAdapter } from './pollinations-video'
import { SiliconFlowVideoAdapter } from './siliconflow-video'
import { VolcEngineVideoAdapter } from './volcengine-video'
import type { VideoAdapter, VideoGenRequest } from './types'
import { resolveEndpoint, type EndpointPin } from './provider'

const videoAdapters: Record<string, VideoAdapter> = {
  volcengine_video: new VolcEngineVideoAdapter(),
  minimax_video: new MiniMaxVideoAdapter(),
  aliyun_wan_video: new AliyunWanVideoAdapter(),
  siliconflow_video: new SiliconFlowVideoAdapter(),
  pollinations_video: new PollinationsVideoAdapter(),
}

export class VideoProviderNotReadyError extends Error {
  constructor(providerKey: string) {
    super(`视频供应商「${providerKey}」适配器未注册（可选：volcengine_video/minimax_video/aliyun_wan_video/siliconflow_video/pollinations_video）`)
    this.name = 'VideoProviderNotReadyError'
  }
}

export function getVideoAdapter(providerKey: string): VideoAdapter {
  const adapter = videoAdapters[providerKey]
  if (!adapter) throw new VideoProviderNotReadyError(providerKey)
  return adapter
}

export function listVideoAdapterKeys(): string[] {
  return Object.keys(videoAdapters)
}

/** 组装视频生成请求（ai_video action 用）：endpoint 解析失败/未配实例时报错含配置指引 */
export async function buildVideoRequest(params: {
  prompt: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  duration?: number
  aspectRatio?: string
  resolution?: string
  provider?: string
  model?: string
  extra?: Record<string, unknown>
  pin?: EndpointPin
}): Promise<{ adapter: VideoAdapter; request: VideoGenRequest }> {
  const endpoint = await resolveEndpoint('video', params.provider, params.pin)
  const adapter = getVideoAdapter(endpoint.providerKey)
  return {
    adapter,
    request: {
      prompt: params.prompt,
      imageUrl: params.imageUrl,
      firstFrameUrl: params.firstFrameUrl,
      lastFrameUrl: params.lastFrameUrl,
      duration: params.duration,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
      model: params.model ?? endpoint.model,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      extra: { ...endpoint.extra, ...params.extra },
    },
  }
}
