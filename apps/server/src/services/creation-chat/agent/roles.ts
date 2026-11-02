/**
 * 角色注册表（轻松创作 Agent 化的「注册制角色 + 智能编队」真源）。
 * 设计取舍（拍板）：
 * - 角色 = 人设片段（workspace/prompts/roles/*.md，零代码扩展）+ 代码侧能力声明（modes / 模板子集）。
 *   纯 LLM 临场造角色被否决：人设无边界会风格漂移、不可探针断言，且"自动角色"给用户
 *   "什么都能做"的错觉——角色必须绑定真实可调度的模板，LLM 造不出"调不出色的调色师"。
 * - LLM 的智能体现在「点将」：decision.roleKey 决定这条建议由谁署名、team 决定后续环节由谁规划；
 *   说话者恒在注册表内——未注册 roleKey 归一回落 planner（不静默：由调用方在 message 注明）。
 * - persona 文件缺失不致命（仅人设语气缺失，能力声明在代码里仍是权威），读不到返回空。
 */
import { loadPromptTemplate } from '../../llm'
import type { AgentMode } from './decision-schema'

export interface RoleCard {
  key: string
  /** 署名（对话气泡与编队展示用中文名） */
  name: string
  /** 一句话定位（注入路由提示词的角色目录） */
  blurb: string
  /** 人设提示词文件（相对 PROMPTS_DIR） */
  personaFile: string
  /** 允许该角色产出的执行模式 */
  modes: AgentMode[]
  /** 允许该角色调度的模板 key 子集；'*' = 全目录兜底 */
  templateKeys: string[] | '*'
}

export const FALLBACK_ROLE = 'planner'

export const ROLE_CARDS: readonly RoleCard[] = [
  {
    key: 'planner',
    name: '策划',
    blurb: '全能兜底：需求含糊、跨环节、未命中专精领域时由策划发言；唯一可产出 synth 临时模板的角色。',
    personaFile: 'roles/planner.md',
    modes: ['easy', 'template', 'chain', 'synth'],
    templateKeys: '*',
  },
  {
    key: 'screenwriter',
    name: '编剧',
    blurb: '文字与叙事：小说改编、连载立项、一致性回查、选题与脚本类诉求。',
    personaFile: 'roles/screenwriter.md',
    modes: ['easy', 'template', 'chain'],
    templateKeys: ['novel-adapt', 'novel-audit', 'series-setup', 'topic-radar', 'video-plan', 'article-clip', 'note-clip'],
  },
  {
    key: 'storyboard',
    name: '分镜师',
    blurb: '画面与视觉：反推（图/视频→提示词/分镜）、混剪、快速视频、单集制作等视觉生产链。',
    personaFile: 'roles/storyboard.md',
    modes: ['easy', 'template', 'chain'],
    templateKeys: ['image-reverse', 'video-reverse', 'photo-montage', 'quick-video', 'talking-clip', 'mengbao-episode', 'note-clip'],
  },
  {
    key: 'operator',
    name: '运营',
    blurb: '分发与复盘：多平台适配、出海翻译、数据复盘回灌等发布后链路。',
    personaFile: 'roles/operator.md',
    modes: ['template', 'chain'],
    templateKeys: ['platform-adapt', 'translate-export', 'review-restock', 'topic-radar'],
  },
]

const byKey = new Map(ROLE_CARDS.map((r) => [r.key, r]))

export function isRegisteredRole(key: unknown): key is string {
  return typeof key === 'string' && byKey.has(key)
}

export function getRole(key: string): RoleCard | undefined {
  return byKey.get(key)
}

/** 未注册 key 归一回落策划（兜底角色能力最全，不欺骗：回落后可做的事与 planner 声明一致） */
export function resolveRole(key: unknown): RoleCard {
  return getRole(isRegisteredRole(key) ? key : FALLBACK_ROLE)!
}

/** 角色能力核验：mode 与目标模板是否在该角色声明范围内（'*' 放行全目录） */
export function roleCan(role: RoleCard, mode: AgentMode, templateKey?: string): boolean {
  if (!role.modes.includes(mode)) return false
  if (!templateKey || role.templateKeys === '*') return true
  return role.templateKeys.includes(templateKey)
}

/** 注入路由提示词的紧凑角色目录（key｜名字｜blurb｜可执行模式｜可调度模板） */
export function renderRolesForPrompt(): string {
  return ROLE_CARDS.map((r) =>
    `- ${r.key}「${r.name}」: ${r.blurb} 可执行模式: ${r.modes.join('/')}；可调度模板: ${r.templateKeys === '*' ? '全部' : r.templateKeys.join(', ')}`,
  ).join('\n')
}

/** 人设片段（读失败返回空串：仅损失语气风格，不损失能力与问责边界） */
export function personaPrompt(key: string): string {
  const card = getRole(key)
  if (!card) return ''
  try {
    return loadPromptTemplate(card.personaFile)
  } catch {
    return ''
  }
}
