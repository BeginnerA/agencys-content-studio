/**
 * [对白严格 ASR 开关] 「人物对白严格 ASR 核验」策略解析（全局默认 + 项目级覆盖，仿 brand-config 三层）。
 *
 * 背景：严格 ASR（见 ./strict-asr.ts）把「逐字核验 + 毫秒分段字幕」定成人物对白模式的硬门禁——
 * 这是一道质量门而非功能必需（huobao / Toonflow 均无 ASR 也能出片）。本策略提供一个逃生阀：
 * 用户可显式关闭严格 ASR，让对白需求在无可用 ASR 后端时仍能创作（降级为原生出声 + 估算字幕，或旁白）。
 *
 * 数据模型（与 brand 三层同构，均为可选键，缺失 = 维持现状严格）：
 * - 全局默认：settings 表 key='dialogue_asr'，JSON { strict: boolean }（缺失/损坏 → true）
 * - 项目覆盖：projects.settings.dialogue_asr = { strict: boolean }（缺失 → 继承全局）
 *
 * 红线：本服务只读取 + 解析优先级，不改任何执行语义；分片①不接线到门禁（preflight/dialogue 调用属后续分片）。
 * 默认恒为 true（严格）——未显式配置的用户零感知、零回归。
 */
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { projects, settings } from '../db/schema'

export const DIALOGUE_ASR_SETTINGS_KEY = 'dialogue_asr'

export type DialogueAsrSource = 'default' | 'global' | 'project'

export interface DialogueAsrPolicy {
  /** true = 维持现状（人物对白强制严格 ASR 核验）；false = 放行免 ASR 创作 */
  strict: boolean
  /** 生效来源：硬默认 / 全局设置 / 项目覆盖（供 UI 与日志如实标注） */
  source: DialogueAsrSource
}

/** 全局默认：settings.dialogue_asr.strict（缺失/损坏/非布尔 → { strict:true, configured:false }） */
export async function readGlobalDialogueAsr(): Promise<{ strict: boolean; configured: boolean }> {
  try {
    const rows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, DIALOGUE_ASR_SETTINGS_KEY))
      .limit(1)
    const raw = rows[0]?.value
    if (!raw) return { strict: true, configured: false }
    const parsed = JSON.parse(raw) as { strict?: unknown }
    if (typeof parsed?.strict === 'boolean') return { strict: parsed.strict, configured: true }
    return { strict: true, configured: false }
  } catch {
    return { strict: true, configured: false }
  }
}

/** 项目级覆盖：projects.settings.dialogue_asr.strict（未设 / 无项目 / 损坏 → null = 继承） */
export async function readProjectDialogueAsrOverride(projectId?: number | null): Promise<boolean | null> {
  if (projectId == null || !Number.isFinite(projectId)) return null
  try {
    const rows = await db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
    const raw = rows[0]?.settings
    if (!raw) return null
    const parsed = JSON.parse(raw) as { dialogue_asr?: unknown }
    const o = parsed?.dialogue_asr
    if (o && typeof o === 'object' && !Array.isArray(o) && typeof (o as { strict?: unknown }).strict === 'boolean') {
      return (o as { strict: boolean }).strict
    }
    return null
  } catch {
    return null
  }
}

/**
 * 唯一入口：解析该项目的「严格 ASR」生效值。
 * 优先级 = 项目覆盖 → 全局默认 → 硬默认(true)。任何异常一律回落 true（保持现状，绝不因解析失败而放开门禁）。
 */
export async function resolveDialogueAsrPolicy(projectId?: number | null): Promise<DialogueAsrPolicy> {
  const override = await readProjectDialogueAsrOverride(projectId)
  if (override !== null) return { strict: override, source: 'project' }
  const global = await readGlobalDialogueAsr()
  if (global.configured) return { strict: global.strict, source: 'global' }
  return { strict: true, source: 'default' }
}
