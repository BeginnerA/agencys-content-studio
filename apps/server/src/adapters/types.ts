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
  /**
   * 参考图注入能力：'base64' = 支持 data URI 参考图；'none' = 不支持。
   * 缺省（未声明）视为 'none'；声明必须与实现一致（能力的唯一事实源）。
   */
  readonly referenceImages?: 'none' | 'base64'
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
  /**
   * 首帧注入能力：'base64' = 支持 data URI 首帧；'as-reference' = 无首帧 role 时按参考图语义注入；
   * 'none' = 不支持。缺省（未声明）视为 'none'。
   */
  readonly firstFrame?: 'none' | 'base64' | 'as-reference'
  /**
   * [M13] 参考图（场景/道具）注入能力：'base64' = 接受 data URI（经 extra.referenceImageUrls 下发 reference_image）；
   * 'none'/缺省 = 不支持。声明必须与实现一致（能力的唯一事实源）。
   */
  readonly referenceImages?: 'none' | 'base64'
  generate(req: VideoGenRequest): Promise<GeneratedVideo>
  query(taskId: string, req: { baseUrl: string; apiKey: string }): Promise<{ status: 'pending' | 'processing' | 'completed' | 'failed'; url?: string; error?: string }>
}
