/**
 * 阿里百炼图像统一适配器（一行 = 厂商 × 能力；千问/万相目录行合并后的派发入口）。
 *
 * 按模型前缀派发到既有协议实现（协议逻辑零改动，仅收敛入口）：
 * - qwen-* → AliyunQwenImageAdapter（DashScope multimodal-generation 同步直返协议）
 * - 其余（wan 系 / wanx 系或空）→ AliyunWanImageAdapter（万相多代协议：2.7 同步 / ≤2.6 异步轮询）
 * 编辑通道（局部重绘/消除/扩图）为万相 wanx2.1-imageedit 协议独有：qwen-* 模型显式拒绝，
 * 模型为空时由万相适配器落默认 wanx2.1-imageedit。
 */
import { AliyunQwenImageAdapter } from './aliyun-qwen-image'
import { AliyunWanImageAdapter } from './aliyun-wan-image'
import type { GeneratedImage, ImageAdapter, ImageEditRequest, ImageGenRequest } from './types'

/** qwen 系模型前缀（qwen-image-3.0-pro / qwen-image / qwen-mt-image 等） */
const QWEN_MODEL_PATTERN = /^qwen[-_.]/i

export class AliyunBailianImageAdapter implements ImageAdapter {
  readonly provider = 'aliyun_bailian_image'
  /** 参考图注入：两族协议均支持 data URI（wan 仅 2.7 同步分支注入，异步分支忽略） */
  readonly referenceImages = 'base64'
  /** 编辑能力由万相通道提供（qwen 系模型派发时在 edit 内显式拒绝） */
  readonly editing = { inpaint: true, outpaint: true }

  private readonly wan = new AliyunWanImageAdapter()
  private readonly qwen = new AliyunQwenImageAdapter()

  private pick(model: string | undefined): AliyunQwenImageAdapter | AliyunWanImageAdapter {
    return QWEN_MODEL_PATTERN.test(String(model || '').trim()) ? this.qwen : this.wan
  }

  async generate(req: ImageGenRequest): Promise<GeneratedImage> {
    return this.pick(req.model).generate(req)
  }

  async edit(req: ImageEditRequest): Promise<GeneratedImage> {
    if (QWEN_MODEL_PATTERN.test(String(req.model || '').trim())) {
      throw new Error('百炼图像编辑通道（局部重绘/消除/扩图）仅支持万相（wan/wanx）模型，请切换实例模型或将该节点指向万相实例')
    }
    return this.wan.edit!(req)
  }
}
