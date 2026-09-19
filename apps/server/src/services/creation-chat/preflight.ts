import { z } from 'zod'
import { getImageAdapter, resolveEndpoint, type ResolvedEndpoint } from '../../adapters/provider'
import { getVideoAdapter } from '../../adapters/video'
import { loadTemplate } from '../../pipeline/loader'
import { resolveFfmpeg, resolveFfprobe } from '../ffmpeg'
import { checkBudget } from '../budget'
import { resolveUnitPrice, type UsageKind, type UsageUnit } from '../usage'
import { CreationError, hashJson, type CreationPlan, type CreationRef } from './contract'
import type { CreationRecipe, EndpointSnapshot } from './recipe'

/** 声明绑定精确模型；仅记录经供应商文档/实测核实的能力，不按名称推测。 */
export const videoCapabilitiesSchema = z.object({
  model: z.string().min(1), verified: z.literal(true),
  modes: z.array(z.enum(['i2v', 't2v'])).min(1),
  durations: z.array(z.number().int().min(1).max(30)).min(1).max(30),
  aspectRatios: z.array(z.enum(['9:16', '16:9', '1:1'])).min(1),
  resolution: z.enum(['480p', '720p', '1080p', '768P', '2K']),
}).strict()
export type PreparedRecipe = Omit<CreationRecipe, 'sessionId' | 'sources'>
export interface CreationPreflight {
  ready: boolean
  issues: Array<{ code: string; message: string }>
  execution: PreparedRecipe | null
  estimate: { knownCost: number; unpriced: string[]; imageCount: number; videoSeconds: number; voiceChars: number; refCount: number; videoAnalysisCount: number }
  planningModel: { provider: string; model: string } | null
}

export async function requiredEndpoint(service: 'image' | 'video' | 'audio' | 'llm'): Promise<ResolvedEndpoint> {
  try {
    const ep = await resolveEndpoint(service)
    if (!ep.model?.trim()) throw new Error('model')
    return ep
  } catch {
    throw new CreationError('missing_' + service, `请在 AI 配置中启用 ${service} 实例，并填写模型、端点和密钥`, 422)
  }
}

async function snapshot(ep: ResolvedEndpoint, kind: UsageKind, unit: UsageUnit): Promise<EndpointSnapshot> {
  const unitPrice = await resolveUnitPrice({ configId: ep.configId, provider: ep.providerKey, model: ep.model, kind, unit })
  return { configId: ep.configId, configHash: ep.configHash, provider: ep.providerKey, model: ep.model!, unitPrice: unitPrice !== null && unitPrice >= 0 ? unitPrice : null }
}

/** 模型声明不能覆盖适配器自身的参数限制（否则预估秒数与真实请求不同）。 */
function assertAdapterDurations(ep: ResolvedEndpoint, durations: number[]): void {
  if (['minimax_video', 'volcengine_video'].includes(ep.providerKey) && durations.some((n) => n < 4 || n > 15)) {
    throw new CreationError('duration_unsupported', '当前适配器只透传 4–15 秒整数时长，请校正能力声明', 422)
  }
  if (ep.providerKey === 'aliyun_wan_video' && durations.some((n) => n < 2)) throw new CreationError('duration_unsupported', '当前万相适配器要求至少 2 秒', 422)
  if (ep.providerKey === 'pollinations_video' && /minimax/i.test(ep.model!) && durations.some((n) => ![5, 10, 15].includes(n))) {
    throw new CreationError('duration_unsupported', '当前网关适配器会归一化时长，能力声明须使用 5/10/15 秒档位', 422)
  }
  if (ep.providerKey === 'siliconflow_video' && durations.length !== 1) throw new CreationError('duration_unsupported', '当前硅基流动适配器不下发 duration，仅允许声明一个经核实的固定产出时长', 422)
}

export async function preflightPlan(projectId: number, plan: CreationPlan): Promise<CreationPreflight> {
  const result: CreationPreflight = {
    ready: false, issues: [], execution: null, planningModel: null,
    estimate: { knownCost: 0, unpriced: [], imageCount: 0, videoSeconds: 0, voiceChars: plan.lines.reduce((n, l) => n + l.text.length, 0), refCount: plan.refs.length, videoAnalysisCount: plan.refs.filter((r) => r.role === 'content').length },
  }
  try {
    const llm = await requiredEndpoint('llm')
    result.planningModel = { provider: llm.providerKey, model: llm.model! }
    if (!resolveFfmpeg() || !resolveFfprobe()) throw new CreationError('missing_ffmpeg', '请安装可用的 ffmpeg 和 ffprobe 后重新预检', 422)
    const audio = await requiredEndpoint('audio')
    const voice = typeof audio.extra.voice === 'string' ? audio.extra.voice.trim() : ''
    if (!voice || voice.startsWith('clone:')) throw new CreationError('missing_voice', '请在语音实例扩展参数 voice 中设置现成音色；轻松创作不使用克隆声音', 422)
    const execution: PreparedRecipe = {
      plan, endpoints: { audio: await snapshot(audio, 'tts', 'char') },
      videoMode: 'none', requestDurations: {}, voice, imageSize: '1024x1024', resolution: '720p',
      templateHash: hashJson(loadTemplate('easy-video')),
      // [M31] 参考素材随方案进入执行快照（进 planHash → 确认即执行）；缺失项不编造，仅按现有能力核验
      refs: plan.refs as CreationRef[],
    }
    if (plan.mode === 'dynamic') {
      const video = await requiredEndpoint('video')
      const caps = videoCapabilitiesSchema.safeParse(video.extra.creationCapabilities)
      if (!caps.success || caps.data.model !== video.model) throw new CreationError('capabilities_unverified', '视频模型能力待核实：请在实例 creationCapabilities 中声明精确 model、verified、modes、durations、aspectRatios 和 resolution', 422)
      const c = caps.data
      assertAdapterDurations(video, c.durations)
      if (!c.aspectRatios.includes(plan.aspectRatio)) throw new CreationError('aspect_unsupported', '已核实的视频模型不支持本方案画幅，请修改方案', 422)
      const adapter = getVideoAdapter(video.providerKey)
      execution.videoMode = c.modes.includes('i2v') && adapter.firstFrame === 'base64' ? 'i2v' : c.modes.includes('t2v') ? 't2v' : 'none'
      if (execution.videoMode === 'none') throw new CreationError('first_frame_unsupported', '当前适配器无法严格传递首帧，且模型未声明文生视频能力', 422)
      if (video.providerKey === 'siliconflow_video' && execution.videoMode === 'i2v' && !/i2v/i.test(video.model!)) throw new CreationError('first_frame_unsupported', '当前硅基流动适配器要求明确的 I2V 模型', 422)
      // [M31] 首帧参考不可用即停机：能力不支持图生视频首帧时，绝不静默降级为文生
      if (execution.videoMode !== 'i2v' && plan.refs.some((r) => r.role === 'first_frame')) throw new CreationError('first_frame_unsupported', '方案含首帧参考但当前能力不支持图生视频首帧，请改用图文模式或更换支持 i2v 的实例', 422)
      execution.resolution = video.providerKey === 'minimax_video' ? (['2K', '1080p'].includes(c.resolution) ? '2K' : '768P') : video.providerKey === 'volcengine_video' ? (c.resolution === '480p' ? '480p' : '720p') : c.resolution
      const durations = [...c.durations].sort((a, b) => a - b)
      for (const shot of plan.shots) {
        const duration = durations.find((n) => n >= shot.duration)
        if (!duration) throw new CreationError('duration_unsupported', `镜头 ${shot.id} 超过已核实时长，请修改分镜`, 422)
        execution.requestDurations[shot.id] = duration
        result.estimate.videoSeconds += duration
      }
      execution.endpoints.video = await snapshot(video, 'video', 'second')
    }
    if (plan.mode === 'slideshow' || execution.videoMode === 'i2v') {
      const image = await requiredEndpoint('image')
      getImageAdapter(image.providerKey)
      execution.endpoints.image = await snapshot(image, 'image', 'image')
      execution.imageSize = typeof image.extra.size === 'string' && /^\d{2,4}[x*]\d{2,4}$/.test(image.extra.size) ? image.extra.size : '1024x1024'
      result.estimate.imageCount = plan.shots.length
    }
    // [M31] 图片主体/风格参考需图像端点消费（无图像端点时无法注入参考图 → 停机，不静默忽略）
    if (!execution.endpoints.image && plan.refs.some((r) => r.kind === 'image' && r.role !== 'first_frame')) {
      throw new CreationError('ref_image_unsupported', '方案含图片参考（主体/风格）但未解析到可用图像实例，请检查 AI 配置', 422)
    }
    for (const [key, qty] of [['audio', result.estimate.voiceChars], ['image', result.estimate.imageCount], ['video', result.estimate.videoSeconds]] as const) {
      const ep = execution.endpoints[key]
      if (!ep) continue
      if (ep.unitPrice === null) result.estimate.unpriced.push(`${ep.provider} / ${ep.model}（${key}）`)
      else result.estimate.knownCost += qty * ep.unitPrice
    }
    result.estimate.knownCost = Math.round(result.estimate.knownCost * 1e6) / 1e6
    // [M31] 视频内容解析 = 多模态 token + ASR，离线不可定价 → 显式列入未计价（不按零元），确认时须接受
    if (result.estimate.videoAnalysisCount > 0) result.estimate.unpriced.push(`参考视频解析 × ${result.estimate.videoAnalysisCount}（多模态 + 语音转写，价格依供应商）`)
    result.execution = execution
    const budget = await checkBudget({ projectId, estimatedCost: result.estimate.knownCost })
    if (budget) result.issues.push(budget)
    result.ready = result.issues.length === 0
  } catch (error) {
    result.issues.push(error instanceof CreationError ? { code: error.code, message: error.message } : { code: 'preflight_failed', message: '模板或供应商参数不可用，请检查 AI 配置后重新预检' })
  }
  return result
}
