import { z } from 'zod'
import { getImageAdapter, resolveEndpoint, type ResolvedEndpoint } from '../../adapters/provider'
import { getVideoAdapter } from '../../adapters/video'
import { mapResolution, resolveVideoCaps } from '../../adapters/video-capabilities'
import { loadTemplate } from '../../pipeline/loader'
import { resolveFfmpeg, resolveFfprobe } from '../ffmpeg'
import { defaultVoice, defaultImageSize } from '../../adapters/extra-params'
import { defaultTtsModel } from '../tts'
import { checkBudget } from '../budget'
import { resolveBrandConfig } from '../brand-config'
import { resolveUnitPrice, type UsageKind, type UsageUnit } from '../usage'
import { CREATION_VIDEO_RESOLUTIONS, CreationError, hashJson, type CreationPlan, type CreationRef } from './contract'
import type { CreationRecipe, EndpointSnapshot } from './recipe'
import { snapshotStrictAsr } from '../strict-asr'
import { resolveDialogueAsrPolicy } from '../dialogue-asr-policy'
import { assertDialogueCapacity, dialogueAudioOptions } from './dialogue'

/** 声明绑定精确模型；仅记录经供应商文档/实测核实的能力，不按名称推测。 */
export const videoCapabilitiesSchema = z.object({
  model: z.string().min(1), verified: z.literal(true),
  modes: z.array(z.enum(['i2v', 't2v'])).min(1),
  durations: z.array(z.number().int().min(1).max(30)).min(1).max(30),
  aspectRatios: z.array(z.enum(['9:16', '16:9', '1:1'])).min(1),
  resolution: z.enum(CREATION_VIDEO_RESOLUTIONS),
}).strict()
type DeclaredCaps = z.infer<typeof videoCapabilitiesSchema>
export type PreparedRecipe = Omit<CreationRecipe, 'sessionId' | 'sources'>
export interface CreationPreflight {
  ready: boolean
  issues: Array<{ code: string; message: string }>
  execution: PreparedRecipe | null
  estimate: { knownCost: number; unpriced: string[]; imageCount: number; videoSeconds: number; voiceChars: number; refCount: number; videoAnalysisCount: number; asrSeconds?: number }
  planningModel: { provider: string; model: string } | null
  /** [M43] 确认卡画质候选：仅 dynamic 且视频档位可背书时非 null。
   *  只在 pf 顶层透出（planHash = hashJson({plan, execution}) 仅含 execution）：顶层加法不改任何现存会话哈希。
   *  档位越界不猜：无真源表且无显式声明 → null（无可选，维持现状）。 */
  resolutionOptions: { choices: string[]; default: string } | null
  /** [M45] 品牌叠加摘要（仅确认卡信息透出）：available = 平台/项目已配任一叠加（水印/片头/片尾/字幕）。
   *  与 resolutionOptions 同一先例：只在 pf 顶层透出，不进 execution → 不改 planHash；未配品牌 available=false。 */
  brandSummary: { available: boolean; watermark: boolean; intro: boolean; outro: boolean; subtitle: boolean } | null
  /** [M47] 对白执行路线（仅信息透出，仿 resolutionOptions 顶层加法先例：不进 execution → 不改 planHash）：
   *  strict = 严格 ASR 路线（执行链仍冻结）；estimated = 免核验原生出声 + 估算字幕；null = 非对白。 */
  dialogueMode: 'strict' | 'estimated' | null
}

export async function requiredEndpoint(service: 'image' | 'video' | 'audio' | 'llm'): Promise<ResolvedEndpoint> {
  try {
    const ep = await resolveEndpoint(service === 'llm' ? 'chat' : service)
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

export async function preflightPlan(projectId: number, plan: CreationPlan): Promise<CreationPreflight> {
  const dialogue = plan.performance === 'dialogue'
  // [M47] 路 B 入口：仅当用户显式关闭「人物对白严格 ASR 核验」（全局/项目三层解析）时，对白改走
  // 免核验路线（原生出声 + 估算字幕，不取 ASR 快照、零 ASR 计费）；默认 ON 逐字维持现状 strict 路线。
  // 硬闸不放宽：下方 dialogueAudioOptions 仍要求命中原生对白背书型号，未命中照常 422 可行动拒绝。
  const estimatedDialogue = dialogue && (await resolveDialogueAsrPolicy(projectId)).strict === false
  const result: CreationPreflight = {
    ready: false, issues: [], execution: null, planningModel: null, resolutionOptions: null, brandSummary: null, dialogueMode: dialogue ? (estimatedDialogue ? 'estimated' : 'strict') : null,
    estimate: { knownCost: 0, unpriced: [], imageCount: 0, videoSeconds: 0, voiceChars: dialogue ? 0 : plan.lines.reduce((n, l) => n + l.text.length, 0), refCount: plan.refs.length, videoAnalysisCount: plan.refs.filter((r) => r.role === 'content').length, ...(dialogue && !estimatedDialogue ? { asrSeconds: 0 } : {}) },
  }
  try {
    if (dialogue) assertDialogueCapacity(plan)
    const llm = await requiredEndpoint('llm')
    result.planningModel = { provider: llm.providerKey, model: llm.model! }
    if (!resolveFfmpeg() || !resolveFfprobe()) throw new CreationError('missing_ffmpeg', '请安装可用的 ffmpeg 和 ffprobe 后重新预检', 422)
    const audio = dialogue ? null : await requiredEndpoint('audio')
    const asr = dialogue && !estimatedDialogue ? await snapshotStrictAsr() : undefined
    const configured = typeof audio?.extra.voice === 'string' ? audio.extra.voice.trim() : ''
    // [M38] 音色 Tier A 收敛：未配置时按供应商真源默认兜底（不再强制用户手填裸 JSON）；
    // [M39] 兜底升级为逐模型：命中 profile 用模型级默认（如 CosyVoice2→alex），未命中回落 provider 级；
    // 克隆音色（clone:）仍拒（轻松创作不用克隆声音，既定红线）；两层均无安全默认（如 elevenlabs 未核实集）仍须显式配置（不猜）。
    if (configured.startsWith('clone:')) throw new CreationError('missing_voice', '轻松创作不使用克隆声音；请在语音实例选择现成音色', 422)
    const voice = audio ? configured || defaultVoice(audio.providerKey, audio.model || (await defaultTtsModel(audio.providerKey))) : undefined
    if (!dialogue && !voice) throw new CreationError('missing_voice', '该语音供应商无通用默认音色（需「模型:音色」格式），请在语音实例的「音色」中显式填写', 422)
    const execution: PreparedRecipe = {
      plan, endpoints: audio ? { audio: await snapshot(audio, 'tts', 'char') } : {},
      videoMode: 'none', requestDurations: {}, ...(dialogue ? {} : { voice }), imageSize: '1024x1024', resolution: '720p',
      templateHash: hashJson(loadTemplate(dialogue ? 'easy-dialogue' : 'easy-video')),
      ...(asr ? { asr } : {}),
      ...(estimatedDialogue ? { estimatedDialogue: true as const } : {}),
      // [M31] 参考素材随方案进入执行快照（进 planHash → 确认即执行）；缺失项不编造，仅按现有能力核验
      refs: plan.refs as CreationRef[],
    }
    if (plan.mode === 'dynamic') {
      const video = await requiredEndpoint('video')
      if (dialogue) dialogueAudioOptions(video.providerKey, video.model!)
      // [M32] Tier A：优先采用实例显式声明的 creationCapabilities（后向兼容既有 run 与探针）；
      // 缺失/未背书时按单一真源表自动背书——系统负责核实，用户仅在预览卡确认。
      const declared = resolveVideoCaps(video.providerKey, video.model ?? '')
      const stored = videoCapabilitiesSchema.safeParse(video.extra.creationCapabilities)
      let c: DeclaredCaps
      if (stored.success && stored.data.model === video.model) {
        c = stored.data
        // 档位合法性 = 声明须落在真源表内（消除按供应商硬编码的时长分支；否则预估秒数与真实请求不同）。
        // 注：modes 不在此校验——图生/文生能力以 adapter.firstFrame 为唯一真源（见下方 videoMode 推导），
        // 越界的 i2v 声明会自然落到 first_frame_unsupported（比通用「未核实」更可行动）。
        if (declared) {
          if (c.durations.some((d) => !declared.durations.includes(d))) throw new CreationError('duration_unsupported', `声明时长超出「${video.providerKey} / ${video.model}」适配器支持档位（${declared.durations.join('/')} 秒），请校正能力声明`, 422)
          if (!declared.resolutions.includes(c.resolution)) throw new CreationError('capabilities_unverified', `声明分辨率超出适配器支持档位（${declared.resolutions.join('/')}），请校正`, 422)
        } else if (video.providerKey === 'siliconflow_video' && c.durations.length !== 1) {
          throw new CreationError('duration_unsupported', '当前硅基流动适配器不下发 duration，仅允许声明一个经核实的固定产出时长', 422)
        }
      } else if (declared) {
        c = { model: video.model!, verified: true, modes: declared.modes, durations: declared.durations, aspectRatios: declared.aspectRatios, resolution: declared.defaultResolution }
      } else {
        throw new CreationError('capabilities_unverified', '视频模型能力待核实：该模型暂无平台背书档位，请在实例扩展参数 creationCapabilities 中声明精确 model、verified、modes、durations、aspectRatios 和 resolution，或更换已支持模型', 422)
      }
      if (!c.aspectRatios.includes(plan.aspectRatio)) throw new CreationError('aspect_unsupported', '已核实的视频模型不支持本方案画幅，请修改方案', 422)
      const adapter = getVideoAdapter(video.providerKey)
      execution.videoMode = c.modes.includes('i2v') && adapter.firstFrame === 'base64' ? 'i2v' : c.modes.includes('t2v') ? 't2v' : 'none'
      if (execution.videoMode === 'none') throw new CreationError('first_frame_unsupported', '当前适配器无法严格传递首帧，且模型未声明文生视频能力', 422)
      if (video.providerKey === 'siliconflow_video' && execution.videoMode === 'i2v' && !/i2v/i.test(video.model!)) throw new CreationError('first_frame_unsupported', '当前硅基流动适配器要求明确的 I2V 模型', 422)
      // [M31] 首帧参考不可用即停机：能力不支持图生视频首帧时，绝不静默降级为文生
      if (execution.videoMode !== 'i2v' && plan.refs.some((r) => r.role === 'first_frame')) throw new CreationError('first_frame_unsupported', '方案含首帧参考但当前能力不支持图生视频首帧，请改用图文模式或更换支持 i2v 的实例', 422)
      // [M32] 实际下发分辨率由单一真源表归一（minimax 按 H3/H3-Max 分档、volcengine 收敛档位，其余透传）——与适配器 normalize 同源
      execution.resolution = mapResolution(video.providerKey, c.resolution, video.model) || c.resolution
      // [M43] 画质候选：自动背书时取真源表全档；实例显式声明（model 匹配命中上行分支）即固定档位（越界已在上方 422），仅本档可选。
      // default = 归一后的实际下发值（诚实展示）；各档经 mapResolution 仍落在 choices 内（表形态即归一形态）
      result.resolutionOptions = stored.success && stored.data.model === video.model
        ? { choices: [c.resolution], default: execution.resolution }
        : { choices: declared ? [...declared.resolutions] : [c.resolution], default: execution.resolution }
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
      const adapter = getImageAdapter(image.providerKey)
      if (dialogue && plan.shots.some((s) => {
        const count = plan.refs.filter((r) => r.kind === 'image' && ['style', 'subject', 'first_frame'].includes(r.role) && (!r.shotId || r.shotId === s.id)).length
        return count > 6 || (count > 0 && adapter.referenceImages !== 'base64')
      })) throw new CreationError('ref_image_unsupported', '批准参考图无法完整注入首帧，请减少每镜参考到 6 张以内或配置支持参考图的实例', 422)
      execution.endpoints.image = await snapshot(image, 'image', 'image')
      // [M39] 尺寸合法性扩展官方档位形态 [1-4]K（万相 2.7 系）；未配置/非法时兜底改逐模型默认（qwen-image-max/plus 仅固定 5 档，1024x1024 对其非法）
      const rawSize = typeof image.extra.size === 'string' ? image.extra.size.trim() : ''
      execution.imageSize = /^\d{2,4}[x*]\d{2,4}$/.test(rawSize) || /^[1-4]K$/i.test(rawSize)
        ? rawSize
        : defaultImageSize(image.providerKey, image.model)
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
    if (asr) {
      result.estimate.asrSeconds = result.estimate.videoSeconds
      if (asr.unitPrice === null) result.estimate.unpriced.push(`${asr.provider} / ${asr.model}（ASR）`)
      else result.estimate.knownCost += result.estimate.asrSeconds * asr.unitPrice
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
  // [M45] 品牌叠加摘要：仅取平台+项目两层合并真值（run 层传 null）；resolveBrandConfig 全链宽容降级（无配→{}）。
  // 信息性透出：解析异常不左摇预检结论（不 push issues），保持 brandSummary=null。
  try {
    const b = await resolveBrandConfig(projectId, null)
    result.brandSummary = {
      available: !!(b.watermark || b.intro || b.outro || b.subtitle),
      watermark: !!b.watermark, intro: !!b.intro, outro: !!b.outro, subtitle: !!b.subtitle,
    }
  } catch { /* brandSummary 仅信息透出，失败不影响预检 */ }
  return result
}
