/**
 * M1 生成适配器契约（精简同步版）。
 * 说明：huobao 采用「请求构造/响应解析」分离接口以支持异步轮询；
 * M1 先统一为直接调用（同步返回 URL 或 base64），M2 搬运轮询型厂商时再扩展 submit/poll 形态。
 */

export interface ImageGenRequest {
  prompt: string
  size?: string
  model?: string
  referenceImages?: string[]
  baseUrl: string
  apiKey: string
  extra?: Record<string, unknown>
}

export type GeneratedImage =
  | { kind: 'url'; url: string; width?: number; height?: number }
  | { kind: 'base64'; data: string; mime: string; width?: number; height?: number }

export interface ImageAdapter {
  /** provider key（与 api_providers.key 对应） */
  provider: string
  generate(req: ImageGenRequest): Promise<GeneratedImage>
}

export interface VideoGenRequest {
  prompt: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  duration?: number
  aspectRatio?: string
  resolution?: string
  model?: string
  baseUrl: string
  apiKey: string
  extra?: Record<string, unknown>
}

export type GeneratedVideo =
  | { kind: 'url'; url: string }
  | { kind: 'poll'; taskId: string }
  | { kind: 'base64'; data: string; mime: string }

export interface VideoAdapter {
  provider: string
  generate(req: VideoGenRequest): Promise<GeneratedVideo>
  query(taskId: string, req: { baseUrl: string; apiKey: string }): Promise<{ status: 'pending' | 'processing' | 'completed' | 'failed'; url?: string; error?: string }>
}
