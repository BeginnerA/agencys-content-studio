import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../../db'
import { characters, projects } from '../../db/schema'
import { resolveProjectStyleSnippets } from '../style-preset'

/**
 * [batch5] 轻松创作「角色 / 风格预设」软提示注入：
 * 复用既有 style_presets 库与 characters 实体库（零建表），把用户在建方案前预选的风格/角色
 * 作为**基线软提示**喂给规划模型（LLM 仍可细化措辞，但不凭空替换画风或丢弃已选角色核心特征）。
 * 预设属于**项目级配置**（与 asrPolicy 同侧信道，仅实时落 projects.settings，不进入消息幂等指纹 / 票据内容），
 * 因此不触碰 create/send 的计费与幂等不变量。未绑定 → resolveCreationPresetHint 返回 null，规划零变更。
 */

/** 风格词块绑定上限（对齐项目多选，防提示词膨胀） */
export const MAX_STYLE_PRESET_BIND = 6
/** 角色绑定上限（对齐 cast min2/max4） */
export const MAX_CHARACTER_PRESET_BIND = 4

/** 归一 id 数组：正整数、去重保序、截断到 cap；非数组 → [] */
function safeIds(v: unknown, cap: number): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const x of v) {
    const n = Number(x)
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
    if (out.length >= cap) break
  }
  return out
}

function parseSettings(settingsJson: string): Record<string, unknown> {
  try {
    const v = JSON.parse(settingsJson) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 读-合并写：把选中的预设 id 落到项目 settings（键 style_preset_ids / character_preset_ids）。
 * 仅当对应入参提供时才写该键（未提供保持原值不动）；style_preset_ids 兼容下游 ai_image 注入链。
 */
export async function applyCreationPresets(projectId: number, styleIds?: number[], charIds?: number[]): Promise<void> {
  if (styleIds === undefined && charIds === undefined) return
  const rows = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1)
  const proj = rows[0]
  if (!proj) return
  const obj = parseSettings(proj.settings)
  if (styleIds !== undefined) obj['style_preset_ids'] = safeIds(styleIds, MAX_STYLE_PRESET_BIND)
  if (charIds !== undefined) obj['character_preset_ids'] = safeIds(charIds, MAX_CHARACTER_PRESET_BIND)
  await db.update(projects).set({ settings: JSON.stringify(obj), updatedAt: Date.now() }).where(eq(projects.id, projectId))
}

/** 依项目绑定的风格 / 角色预设构建「软提示」system 文本；两者皆未绑定（或绑定项已删）→ null */
export async function resolveCreationPresetHint(projectId: number): Promise<string | null> {
  const rows = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1)
  const proj = rows[0]
  if (!proj) return null
  const obj = parseSettings(proj.settings)
  const parts: string[] = []

  // 风格：复用 resolveProjectStyleSnippets（读 settings.style_preset_ids，跳已删/停用，去重保序）
  const styles = await resolveProjectStyleSnippets(projectId)
  if (styles.length > 0) parts.push(`画风基线：${styles.map((s) => `${s.name}「${s.snippet}」`).join('；')}`)

  // 角色：按 id 取项目域 + 全局行，保留绑定顺序；缺外貌/声线如实标注（不编造）
  const charIds = safeIds(obj['character_preset_ids'], MAX_CHARACTER_PRESET_BIND)
  if (charIds.length > 0) {
    const cs = await db
      .select()
      .from(characters)
      .where(and(inArray(characters.id, charIds), or(eq(characters.projectId, projectId), isNull(characters.projectId))))
    const byId = new Map(cs.map((c) => [c.id, c]))
    const list = charIds.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => !!c && c.kind === 'character')
    if (list.length > 0) {
      parts.push(`可复用角色：${list.map((c) => `${c.name}（外貌：${(c.appearance ?? '').trim() || '未填'}；声线：${(c.voice ?? '').trim() || '未填'}）`).join('；')}`)
    }
  }

  if (parts.length === 0) return null
  return `【预设基线（软提示）】用户已为本次创作预选以下风格 / 角色，请让方案的 style 与 cast 优先对齐这些基线——可在其上细化措辞，但不得凭空替换画风、也不得丢弃已选角色的外貌 / 声线核心特征：\n${parts.join('\n')}`
}
