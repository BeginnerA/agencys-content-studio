import { OpenAIImageAdapter } from './openai-image'

/**
 * SiliconFlow 文生图适配器（厂商行，M2.2 目录归位）。
 * 协议与 OpenAI Images 一致（POST /images/generations，兼容 images[] 镜像响应），
 * 直接复用 OpenAIImageAdapter，仅保持独立 provider 标识用于注册表与溯源。
 */
export class SiliconFlowImageAdapter extends OpenAIImageAdapter {
  override readonly provider = 'siliconflow_image'
}
