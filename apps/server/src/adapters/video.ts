/**
 * 视频适配器注册表与请求组装：实现已抽入 @agencys/ai-provider-kit；本文件为宿主壳。
 * buildVideoRequest 经 provider.ts 的 createProvider 单例暴露（保持全局单一端点解析实例）。
 */
export { getVideoAdapter, listVideoAdapterKeys, VideoProviderNotReadyError } from '@agencys/ai-provider-kit'
export { buildVideoRequest } from './provider'
export type { VideoAdapter, VideoGenRequest } from '@agencys/ai-provider-kit'
