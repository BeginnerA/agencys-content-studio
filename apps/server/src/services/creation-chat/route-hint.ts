/**
 * M57 意图驱动的智能载体路由（轻松创作 → 专业链方向建议）。
 *
 * 本质是一个**确定性纯函数路由器**：不调用任何模型、零计费、绝不改本次出片载体
 * （轻松创作执行模板恒由 execution.ts 的 recipe 决定，见 project-meta.ts 同源注释）。
 * 仅当用户意图明显越出轻内容能力（整本小说改编 / 连载 / 多角色短剧质感 / 视频反推 / 现成素材拼片 / 超总时长上限单条）时，
 * 产出一条**人话方向建议**（Tier B 非阻断），前端渲染为方案卡上的「更合适的选择」提示条，
 * 一键引导至 M56 毕业通道或专业端建项目。命中不了信号返回 null——不猜、不打扰。
 *
 * 与 §四原 spec 的机制差异（已按实态修正）：routeHint 由服务端确定性派生而非 LLM 产出，
 * 故不注入钱路径提示词、不改 planningReplySchema；routeHint 存进 assistant 方案消息 payload，
 * 天然不进 planHash=hashJson({plan,execution})——改建议不作废已确认方案（沿用 project 建议先例）。
 *
 * 信号集是可扩展枚举：**新增信号必须同步 probe-m57 / probe-m62 断言**（防「指哪打哪」漏收口）。
 */
import { listTemplates } from '../../pipeline/loader'
import { isCreationTemplate } from './recipe'
import { PLAN_DURATION_MAX, type CreationPlan } from './contract'

export interface RouteHint {
  /** 建议的专业模板 key（∈ ROUTE_TARGETS，且模板真源存在） */
  target: string
  /** 模板中文显示名（sanitize 时按 listTemplates 真源回填，不采信入参） */
  label: string
  /** 给用户的可见理由（≤80 字，说清「为什么这个载体更合适」） */
  reason: string
}

export interface RouteSignalInput {
  /** 本轮用户输入原文（信号主要来源于此） */
  userText: string
  /** 当前方案（可为空——clarify 轮也可给方向建议） */
  plan: CreationPlan | null
  /** 本轮已采纳「视频内容解析」参考（role=content 且 kind=video） */
  hasVideoContentRef: boolean
  /** 本轮已采纳图片参考（kind=image 且非 content）；M58 补口：图片反推路由信号前置（undefined 当 false，既有调用零改动） */
  hasImageRef?: boolean
  /** 规划模型声明视觉理解（extra.vision）；无则反推类建议不产出（沿用 M31 不降级） */
  hasVision: boolean
}

/** 可路由的专业家族目标：新增目标须在此登记且保证模板真源在位（越界/删档一律 sanitize 丢弃）。 */
const ROUTE_TARGETS = ['novel-adapt', 'series-setup', 'mengbao-episode', 'video-reverse', 'image-reverse', 'photo-montage', 'video-plan'] as const
const REASON_MAX = 80

const includes = (text: string, ...words: string[]): boolean => words.some((w) => text.includes(w))

/** 「视频反推」意图措辞单一真源：M57 路由信号③与 M58 2a 分镜初稿触发共用，防两处漂移。 */
export const REVERSE_INTENT_WORDS = ['反推', '类似这个视频', '像这个视频', '照这个视频', '同款视频', '这个视频的风格'] as const

/** 文本是否含反推意图措辞（仅措辞判定；能力/参考前置由调用方把关：M57 看 vision+内容参考，M58 看解析产物存在）。 */
export function wantsReverseIntent(text: string): boolean {
  return includes(text, ...REVERSE_INTENT_WORDS)
}

/** 是否有「明确长于轻松成片总时长上限」诉求（上限真源 = contract PLAN_DURATION_MAX，M59 放宽后同步，防误路由 61–90s 请求）。 */
function wantsLongerThanCap(text: string): boolean {
  let maxSec = 0
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*分钟/g)) maxSec = Math.max(maxSec, Number(m[1]) * 60)
  for (const m of text.matchAll(/(\d+)\s*(?:秒|s)/gi)) maxSec = Math.max(maxSec, Number(m[1]))
  return maxSec > PLAN_DURATION_MAX
}

/** M62：「整本小说改编」= 小说/原著/网文 + 改编动作 复合判定；片段/梗概/选段/简介类排除（有节选走轻成片即可，不误报）。 */
function wantsNovelAdapt(text: string): boolean {
  if (includes(text, '片段', '梗概', '选段', '简介')) return false
  const isNovel = includes(text, '小说', '原著', '网文')
  const isAdapt = includes(text, '改编', '改写成', '改成短剧', '改成剧本', '改剧本', '转剧本', '转成剧本', '剧本化', '拆章', '切章', '章节切分', '分集剧本', '改成连载')
  return isNovel && isAdapt
}

/** M62：「混剪/相册片」强词表——无须其他前置；词表取舍留档见 spec §三（婚宴/年会/拼贴/裸「相册」不入表，防误报）。 */
const MONTAGE_INTENT_WORDS = ['混剪', '电子相册', '纪念相册', '音乐相册', '相册视频', '相册短片', '照片拼', '拼照片', '照片配乐', '照片配音乐'] as const
/** M62：弱词句式 + 双前置（须已采纳图片参考 + 文本含图/照片/素材：防「把这段文案做成视频」误报）。 */
const MONTAGE_WEAK_RE = /(合成|拼成|做成|变成|合到|拼到).{0,4}(视频|短片|成片)/
function wantsPhotoMontage(text: string, hasImageRef: boolean): boolean {
  if (includes(text, ...MONTAGE_INTENT_WORDS)) return true
  return hasImageRef && includes(text, '图', '照片', '素材') && MONTAGE_WEAK_RE.test(text)
}

/**
 * 信号判定表（自上而下优先，取首个命中）。每条附**人话理由**，命中不了返回 null。
 * 纯文本/参考/能力谓词，无副作用——可被 probe-m57 逐信号与反例断言。
 */
function detect(input: RouteSignalInput): { target: string; reason: string } | null {
  const t = input.userText
  // 1 整本小说改编（M62 新，置顶于连载）：小说/原著/网文 + 改编动作 → 专业改编链（切章节→事件图谱→分集规划→逐集剧本，next 即连载立项）
  if (wantsNovelAdapt(t)) {
    return { target: 'novel-adapt', reason: '你做的是小说改编：专业链按章节切分→事件图谱→分集规划→逐集剧本，再接力连载立项；轻成片只产单条短片。' }
  }
  // 2 连载意图：多集 / 季 / 续集 / 分集 / 第 N 集 → 立项为连载系列（→ M56 series）
  if (includes(t, '连载', '多集', '续集', '分集', '新一季', '第二季') || /第\s*[0-9一二三四五六七八九十百]+\s*(?:集|季)/.test(t)) {
    return { target: 'series-setup', reason: '你要的是多集连载，轻松成片只产单条短片；立项为连载系列可建立角色档案与分集地图，再逐集出片' }
  }
  // 3 多角色短剧质感：定妆 / 形象一致 / 逐句配音 / BGM 对手戏 → 专业单集成片（→ M56 episode）
  if (includes(t, '对手戏', '定妆', '形象一致', '角色一致', '逐句配音', '背景音乐', 'BGM', '多角色短剧')) {
    return { target: 'mengbao-episode', reason: '多角色短剧质感（定妆照、逐句配音、背景音乐）是专业链能力，升级专业单集成片即可点亮' }
  }
  // 4 视频反推：已采纳内容解析参考 + vision 可用 + 想要同款 → 反推分镜（→ M58）
  if (input.hasVideoContentRef && input.hasVision && wantsReverseIntent(t)) {
    return { target: 'video-reverse', reason: '你上传了参考视频并想要同款成片，先反推分镜与脚本再产出，比单条轻成片更贴近原作' }
  }
  // 5 图片反推：已采纳图片参考 + vision 可用 + 反推措辞 → 专业图片反推链（含文案包；对话内已可反推提示词，此处为完整包路线建议）
  if (input.hasImageRef && input.hasVision && wantsReverseIntent(t)) {
    return { target: 'image-reverse', reason: '你上传了参考图并想反推，专业图片反推链可逐图产出可投产提示词与发布文案包，比对话内反推更完整' }
  }
  // 6 现成素材拼片（M62 新）：强混剪词或「图片参考 + 图类词 + 合成句式」弱词 → 专业混剪链（以原素材为画面，不重新生成）；先于超时长——「3 分钟相册」不得误路由 video-plan
  if (wantsPhotoMontage(t, input.hasImageRef === true)) {
    return { target: 'photo-montage', reason: '你要把现成照片/片段直接拼成成片：专业混剪链以原素材为画面（缓推/拼贴/BGM/字卡），不重新生成画面。' }
  }
  // 7 超总时长上限单条：明确要更长成片 → 专业策划链承载（阈值随 PLAN_DURATION_MAX 同步，而非为它再放宽）
  if (wantsLongerThanCap(t)) {
    return { target: 'video-plan', reason: `这条超过轻松成片 ${PLAN_DURATION_MAX} 秒上限，专业策划链能承载更完整的节奏分段与分镜` }
  }
  return null
}

/** 路由目标白名单真源：∈ ROUTE_TARGETS 且模板存在且非轻松创作批准链；返回其中文显示名，否则 null。 */
function routableLabel(target: string): string | null {
  if (!(ROUTE_TARGETS as readonly string[]).includes(target)) return null
  if (isCreationTemplate(target)) return null
  return listTemplates().find((m) => m.key === target)?.name ?? null
}

/**
 * 建议归一（防御式，即使 detect 只产合法目标也复用）：
 * - target 越界 / 模板已删 / 落在批准链 → 丢弃（不 noise、不静默保留非法建议）
 * - label 恒按模板真源回填；reason 非空且截断 ≤80 字，否则丢弃
 */
export function sanitizeRouteHint(raw: { target: string; reason: string } | null | undefined): RouteHint | null {
  if (!raw) return null
  const label = routableLabel(raw.target)
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, REASON_MAX) : ''
  if (!label || !reason) return null
  return { target: raw.target, label, reason }
}

/** 路由入口：确定性信号检测 → sanitize 白名单收口。命中不了返回 null。 */
export function deriveRouteHint(input: RouteSignalInput): RouteHint | null {
  return sanitizeRouteHint(detect(input))
}
