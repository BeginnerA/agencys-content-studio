/**
 * 宿主侧图像模型参考图能力表。
 * supportsRefs 基础值来自 kit adapter.referenceImages（'none'|'base64'，kit 为外部依赖不可改）；
 * maxRefs/负向通道为宿主登记策略：登记表保守起步为空 → 全部走缺省 4，
 * 真实供应商上限按官方文档校准后逐条登记（探针只断言缺省与登记行为，不锁死供应商数值）。
 */
import { getImageAdapter, resolveEndpoint } from '../adapters/provider'

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
 */
export const CAPS_FAILURE_NOTE_PREFIX = '图像端点/适配器解析失败'

/** 会被换行/连续空白压平后写进失败说明的原始错误文案；URL 与密钥片段在写库前抹除，见 sanitizeCapsFailureNote */
const URL_FRAGMENT = /https?:\/\/[^\s"'“”‘’（）()【】〔〕《》「」，。；、！？]+/gi
/** 形似供应商标识的密钥（sk- 开头跟 6 位以上字母数字下划线连字符，OpenAI/智谱/月之暗面等的通行前缀） */
const SK_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{6,}/g
/** 无明显前缀但长度已达凭据级别的连续字母数字（令牌、签名串、端点指纹哈希） */
const LONG_TOKEN = /\b[A-Za-z0-9]{24,}\b/g
/** 失败说明保留的最大字符数：超出即截断，避免整段供应商回包挤占参数快照与运行日志 */
const CAPS_FAILURE_NOTE_MAX_CHARS = 160

/**
 * 落库前清洗能力解析失败的原始错误文案。
 * notes 会随 gen_tasks.params 持久化、并原样进运行日志，而图像端点配置里同时存着密钥与完整 baseUrl：
 * 供应商/kit 的错误文案常把实例名、baseUrl 或密钥片段复述进异常信息（「实例「…」缺少 baseUrl」这类句式
 * 直接把用户填的名称带出来），原样拼接就等于把凭据抄进一个可被任意读取的落盘文件。
 * 故三步走：压平换行与连续空白（日志保持单行，也堵住借换行伪造日志行）；
 * 把 URL 片段与形似密钥的长串整体换成占位文字（保住「哪一类环节出了什么问题」的诊断线索，只去掉凭据本身）；
 * 截断到固定长度（错误文案可达数 KB，一条降级说明不该独占整份快照）。
 */
function sanitizeCapsFailureNote(raw: string): string {
  // 抛出的未必是 Error（第三方可能丢一个无 message 的对象），兜成空串让留痕退化为「只有前缀」而非二次抛错
  const collapsed = String(raw ?? '').replace(/\s+/g, ' ').trim()
  const masked = collapsed
    .replace(URL_FRAGMENT, '[已隐去地址]')
    .replace(SK_STYLE_KEY, '[已隐去密钥]')
    .replace(LONG_TOKEN, '[已隐去密钥]')
  return masked.length > CAPS_FAILURE_NOTE_MAX_CHARS ? `${masked.slice(0, CAPS_FAILURE_NOTE_MAX_CHARS)}…` : masked
}

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
 */
export function capsForProvider(providerKey?: string, model?: string): { maxRefs: number; supportsNegativePrompt: boolean; notes: string[] } {
  const key = (providerKey ?? '').toLowerCase()
  const supportsNegativePrompt = NEGATIVE_PROMPT_PROVIDERS.some((token) => key.includes(token))
  const entry = CAP_TABLE.find((e) => e.provider.test(key))
  if (entry) return { maxRefs: entry.maxRefs, supportsNegativePrompt, notes: [entry.note] }
  const label = providerKey ? `未登记模型：${providerKey}${model ? `/${model}` : ''}` : '未登记模型'
  return { maxRefs: DEFAULT_MAX_REFS, supportsNegativePrompt, notes: [`${label}：参考图上限取保守缺省 ${DEFAULT_MAX_REFS}，实际以供应商文档为准`] }
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
    failureNote = `${CAPS_FAILURE_NOTE_PREFIX}：${sanitizeCapsFailureNote((err as Error).message)}，按不支持参考图处理`
  }
  const { maxRefs, supportsNegativePrompt, notes } = capsForProvider(capsProviderKey, model)
  return { supportsRefs: kitCap === 'base64', maxRefs, supportsNegativePrompt, notes: failureNote ? [...notes, failureNote] : notes }
}
