import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { projects, stylePresets } from '../db/schema'
import { createLogger } from '../logger'

const log = createLogger('style-preset')

/**
 * M8 风格预设服务：项目绑定解析（ai_image 运行时注入链）。
 * 宽容降级（对齐 huobao getDramaStylePrompt「查不到/已停用返回空串」）：
 * 未绑定 / 预设停用 / 被删 / settings 畸形 → null + 日志，绝不炸链路。
 */

/** 解析项目绑定的风格预设词块：projects.settings.style_preset_id → style_presets(is_active=1)；未绑定/停用/不存在 → null */
export async function resolveProjectStyleSnippet(projectId: number): Promise<{ id: number; name: string; snippet: string } | null> {
  const projRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  const proj = projRows[0]
  if (!proj) return null
  const presetId = stylePresetIdOf(proj.settings)
  if (presetId === null) return null // 未绑定属常态：静默（入队侧另有一次/step 提示日志）
  const rows = await db
    .select()
    .from(stylePresets)
    .where(and(eq(stylePresets.id, presetId), eq(stylePresets.isActive, 1)))
    .limit(1)
  const preset = rows[0]
  if (!preset) {
    log.warn(`项目 #${projectId} 绑定的风格预设 #${presetId} 不存在或已停用，跳过风格注入`)
    return null
  }
  const snippet = preset.snippet.trim()
  if (!snippet) return null
  return { id: preset.id, name: preset.name, snippet }
}

/** settings JSON 解析 style_preset_id（整数 >0；缺失/畸形 → null） */
export function stylePresetIdOf(settingsJson: string): number | null {
  try {
    const v = JSON.parse(settingsJson) as Record<string, unknown>
    const n = Number(v['style_preset_id'])
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}
