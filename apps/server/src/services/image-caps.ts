/**
 * 宿主侧图像模型参考图能力表。
 * supportsRefs 基础值来自 kit adapter.referenceImages（'none'|'base64'，kit 为外部依赖不可改）；
 * maxRefs/负向通道为宿主登记策略：登记表保守起步为空 → 全部走缺省 4，
 * 真实供应商上限按官方文档校准后逐条登记（探针只断言缺省与登记行为，不锁死供应商数值）。
 */
import { getImageAdapter, resolveEndpoint } from '../adapters/provider'
import { sanitizeErrorNote } from './error-note'

export interface ImageCaps {
  /** 该模型能否实际接收参考图（kit 能力判定，绝不抛穿）；解析失败按不支持处理，失败原因另记入 notes 留痕 */
  supportsRefs: boolean
  /** 宿主登记/缺省的参考图上限（用于在总量内收紧取用） */
  maxRefs: number
  /** 是否走 kit extra 负向提示词通道（ComfyUI / Kling） */
  supportsNegativePrompt: boolean
  /** 面向日志与快照的能力说明（为何取该上限） */
  notes: string[]
}

/** 未登记模型的保守参考图上限（宿主总量之内收紧，避免越界发送被供应商拒绝） */
export const DEFAULT_MAX_REFS = 4

interface CapEntry {
  provider: RegExp
  maxRefs: number
  note: string
}

/** 供应商上限登记表：保守起步为空——空表时全部落到 DEFAULT_MAX_REFS，逐条按官方文档校准后再登记 */
const CAP_TABLE: CapEntry[] = []

/** kit extra.negative_prompt 透传白名单（对齐 kit catalog/extra-params 实际行为：ComfyUI / Kling） */
const NEGATIVE_PROMPT_PROVIDERS = ['comfy', 'kling']

/**
 * 能力解析失败的说明前缀。
 * 端点未配置 / 适配器未注册 与「该模型确实不支持参考图」在 kit 取值上都落为空，若不落痕就会被压成
 * 同一个 supportsRefs:false，事后既看不出是宿主配置缺失、也看不出是供应商能力不足。
 * 因此失败分支把脱敏截断后的失败原因写进 notes（以该前缀开头），随任务参数快照留档，供日志与审计区分两种成因。
 * 脱敏/压平/截断的共享口径见 error-note.ts（与一致性评分失败说明同一家族）。
 */
export const CAPS_FAILURE_NOTE_PREFIX = '图像端点/适配器解析失败'

/**
 * 本次能力解析是否走了失败降级（而非供应商真实声明不支持）：命中则返回该失败说明原文，否则返回 null。
 * 判据两条同时成立——supportsRefs 为假，且 notes 里有以解析失败前缀开头的说明（只有 catch 分支会写）。
 * 调用方据此在运行日志里把「宿主配置缺失」与「供应商能力不足」分开陈述。
 */
export function capsResolutionFailure(caps: ImageCaps): string | null {
  if (caps.supportsRefs) return null
  return caps.notes.find((note) => note.startsWith(CAPS_FAILURE_NOTE_PREFIX)) ?? null
}

/**
 * 能力静态判定（纯同步，不触达端点/网络）：命中登记表用登记值，未命中取保守缺省。
 * 负向通道仅由供应商键是否含白名单项决定。
 * notes 里必须写清负向词的生效通道（记录而非静默）：产品对两种供应商都把「必须剔除：」段注进提示词，
 * 差别只在供应商是否有原生字段可用——谎称已路由到供应商字段会让排查负向词失效时找错地方。
 */
export function capsForProvider(providerKey?: string, model?: string): { maxRefs: number; supportsNegativePrompt: boolean; notes: string[] } {
  const key = (providerKey ?? '').toLowerCase()
  const supportsNegativePrompt = NEGATIVE_PROMPT_PROVIDERS.some((token) => key.includes(token))
  const negativeNote = supportsNegativePrompt
    ? '该供应商有原生负向提示词字段（kit extra 透传白名单），产品当前仍统一走提示词锚点通道下发负向词'
    : '该供应商无原生负向提示词字段，负向词经提示词锚点（必须剔除：）生效，非供应商字段'
  const entry = CAP_TABLE.find((e) => e.provider.test(key))
  if (entry) return { maxRefs: entry.maxRefs, supportsNegativePrompt, notes: [entry.note, negativeNote] }
  const label = providerKey ? `未登记模型：${providerKey}${model ? `/${model}` : ''}` : '未登记模型'
  return { maxRefs: DEFAULT_MAX_REFS, supportsNegativePrompt, notes: [`${label}：参考图上限取保守缺省 ${DEFAULT_MAX_REFS}，实际以供应商文档为准`, negativeNote] }
}

/**
 * 解析一次图像出图所用模型的真实参考图能力。
 * supportsRefs 走 kit：端点解析/适配器取值任一异常都降级为不支持（不阻断主线、不抛穿），
 * 并把清洗过的失败原因作为一条 notes 说明留在结果里（去凭据、限长度，供参数快照与运行日志区分「配置缺失」与「供应商能力不足」）；
 * providerKey 判定优先用入参，缺省回落到解析出的端点供应商键。
 */
export async function resolveImageCaps(providerKey?: string, model?: string): Promise<ImageCaps> {
  let kitCap: 'none' | 'base64' = 'none'
  let capsProviderKey = providerKey
  let failureNote: string | null = null
  try {
    const endpoint = await resolveEndpoint('image', providerKey)
    kitCap = getImageAdapter(endpoint.providerKey).referenceImages ?? 'none'
    capsProviderKey = providerKey ?? endpoint.providerKey
  } catch (err) {
    // 端点缺失/适配器未注册：视为不支持参考图，交由纯文本锚定降级，不影响入队；清洗过的原因进 notes 留痕
    failureNote = `${CAPS_FAILURE_NOTE_PREFIX}：${sanitizeErrorNote((err as Error).message)}，按不支持参考图处理`
  }
  const { maxRefs, supportsNegativePrompt, notes } = capsForProvider(capsProviderKey, model)
  return { supportsRefs: kitCap === 'base64', maxRefs, supportsNegativePrompt, notes: failureNote ? [...notes, failureNote] : notes }
}
