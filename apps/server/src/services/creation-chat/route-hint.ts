/**
 * M57 意图驱动的智能载体路由（轻松创作 → 专业链方向建议）。
 *
 * 本质是一个**确定性纯函数路由器**：不调用任何模型、零计费、绝不改本次出片载体
 * （轻松创作执行模板恒由 execution.ts 的 recipe 决定，见 project-meta.ts 同源注释）。
 * 仅当用户意图明显越出轻内容能力（连载 / 多角色短剧质感 / 视频反推 / 超 60s 单条）时，
 * 产出一条**人话方向建议**（Tier B 非阻断），前端渲染为方案卡上的「更合适的选择」提示条，
 * 一键引导至 M56 毕业通道或专业端建项目。命中不了信号返回 null——不猜、不打扰。
 *
 * 与 §四原 spec 的机制差异（已按实态修正）：routeHint 由服务端确定性派生而非 LLM 产出，
 * 故不注入钱路径提示词、不改 planningReplySchema；routeHint 存进 assistant 方案消息 payload，
 * 天然不进 planHash=hashJson({plan,execution})——改建议不作废已确认方案（沿用 project 建议先例）。
 *
 * 信号集是可扩展枚举：**新增信号必须同步 probe-m57 断言**（防「指哪打哪」漏收口）。
 */
import { listTemplates } from '../../pipeline/loader'
import { isCreationTemplate } from './recipe'
import type { CreationPlan } from './contract'

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
  /** 规划模型声明视觉理解（extra.vision）；无则反推类建议不产出（沿用 M31 不降级） */
  hasVision: boolean
}

/** 可路由的专业家族目标：新增目标须在此登记且保证模板真源在位（越界/删档一律 sanitize 丢弃）。 */
const ROUTE_TARGETS = ['series-setup', 'mengbao-episode', 'video-reverse', 'video-plan'] as const
const REASON_MAX = 80

const includes = (text: string, ...words: string[]): boolean => words.some((w) => text.includes(w))

/** 是否有「明确长于 60s 单条」诉求（轻松成片 duration 上限 60s，见 contract clamp）。 */
function wantsLongerThanCap(text: string): boolean {
  let maxSec = 0
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*分钟/g)) maxSec = Math.max(maxSec, Number(m[1]) * 60)
  for (const m of text.matchAll(/(\d+)\s*(?:秒|s)/gi)) maxSec = Math.max(maxSec, Number(m[1]))
  return maxSec > 60
}

/**
 * 信号判定表（自上而下优先，取首个命中）。每条附**人话理由**，命中不了返回 null。
 * 纯文本/参考/能力谓词，无副作用——可被 probe-m57 逐信号与反例断言。
 */
function detect(input: RouteSignalInput): { target: string; reason: string } | null {
  const t = input.userText
  // 1 连载意图：多集 / 季 / 续集 / 分集 / 第 N 集 → 立项为连载系列（→ M56 series）
  if (includes(t, '连载', '多集', '续集', '分集', '新一季', '第二季') || /第\s*[0-9一二三四五六七八九十百]+\s*(?:集|季)/.test(t)) {
    return { target: 'series-setup', reason: '你要的是多集连载，轻松成片只产单条短片；立项为连载系列可建立角色档案与分集地图，再逐集出片' }
  }
  // 2 多角色短剧质感：定妆 / 形象一致 / 逐句配音 / BGM 对手戏 → 专业单集成片（→ M56 episode）
  if (includes(t, '对手戏', '定妆', '形象一致', '角色一致', '逐句配音', '背景音乐', 'BGM', '多角色短剧')) {
    return { target: 'mengbao-episode', reason: '多角色短剧质感（定妆照、逐句配音、背景音乐）是专业链能力，升级专业单集成片即可点亮' }
  }
  // 3 视频反推：已采纳内容解析参考 + vision 可用 + 想要同款 → 反推分镜（→ M58）
  if (input.hasVideoContentRef && input.hasVision && includes(t, '反推', '类似这个视频', '像这个视频', '照这个视频', '同款视频', '这个视频的风格')) {
    return { target: 'video-reverse', reason: '你上传了参考视频并想要同款成片，先反推分镜与脚本再产出，比单条轻成片更贴近原作' }
  }
  // 4 超 60s 单条：明确要更长成片 → 专业策划链承载（而非 M59 的放宽，见其理由）
  if (wantsLongerThanCap(t)) {
    return { target: 'video-plan', reason: '这条超过轻松成片 60 秒上限，专业策划链能承载更完整的节奏分段与分镜' }
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
