import { OpenAIImageAdapter } from './openai-image'

/**
 * Pollinations 文生图适配器（gen.pollinations.ai，M2.1 接入）。
 * 协议与 OpenAI Images 完全一致（POST /v1/images/generations，默认 b64_json），
 * 直接复用 OpenAIImageAdapter，仅保持独立 provider 标识用于注册表与溯源。
 */
export class PollinationsImageAdapter extends OpenAIImageAdapter {
  override readonly provider = 'pollinations_image'
}
