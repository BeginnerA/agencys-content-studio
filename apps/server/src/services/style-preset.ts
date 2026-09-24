import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { projects, stylePresets } from '../db/schema'
import { createLogger } from '../logger'
import { assertProjectAssets } from '../pipeline/refs'
import { assetToDataUri } from './asset-ref'
import { chatCompleteDetailed, loadPromptTemplate, type ChatContentPart } from './llm'
import { recordLlmUsage } from './usage'

const log = createLogger('style-preset')

/** [M13] 单次提取的参考图上限（多图综合；超出拒绝） */
export const MAX_EXTRACT_IMAGES = 4
/** [M13] snippet 长度上限（解析输出截断，防超长污染提示词） */
export const MAX_SNIPPET_CHARS = 400

/**
 * M8 风格预设服务：项目绑定解析（ai_image 运行时注入链）。
 * [M13] 多选叠加：settings.style_preset_ids 数组（旧 style_preset_id 单值回退），按绑定顺序逐块拼接注入；
 * [M13] 视觉提取：extractStyleSnippetFromAssets（参考图 → 画风词；不落库，前端预填表单）。
 * 宽容降级（对齐 huobao getDramaStylePrompt「查不到/已停用返回空串」）：
 * 未绑定 / 预设停用 / 被删 / settings 畸形 → 空 + 日志，绝不炸链路。
 */

/** [M13] 解析项目绑定的全部风格预设词块（按绑定顺序；跳过已删除/停用项；去重保序） */
export async function resolveProjectStyleSnippets(projectId: number): Promise<Array<{ id: number; name: string; snippet: string }>> {
  const projRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  const proj = projRows[0]
  if (!proj) return []
  const ids = stylePresetIdsOf(proj.settings)
  if (ids.length === 0) return [] // 未绑定属常态：静默（入队侧另有一次/step 提示日志）
  const rows = await db
    .select()
    .from(stylePresets)
    .where(and(inArray(stylePresets.id, ids), eq(stylePresets.isActive, 1)))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: Array<{ id: number; name: string; snippet: string }> = []
  for (const id of ids) {
    const preset = byId.get(id)
    if (!preset) {
      log.warn(`项目 #${projectId} 绑定的风格预设 #${id} 不存在或已停用，跳过该词块`)
      continue
    }
    const snippet = preset.snippet.trim()
    if (!snippet) continue
    out.push({ id: preset.id, name: preset.name, snippet })
  }
  return out
}

/** [M8] 单预设解析（旧签名薄封装）：返回首个绑定词块；存量调用与 M8 探针零改动 */
export async function resolveProjectStyleSnippet(projectId: number): Promise<{ id: number; name: string; snippet: string } | null> {
  return (await resolveProjectStyleSnippets(projectId))[0] ?? null
}

/** [M13] settings JSON 解析绑定的风格预设 id 数组：优先 style_preset_ids（数组），回退旧单值 style_preset_id；去重保序 */
export function stylePresetIdsOf(settingsJson: string): number[] {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(settingsJson) as Record<string, unknown>
  } catch {
    return []
  }
  const raw = v['style_preset_ids']
  const list: unknown[] = Array.isArray(raw) ? raw : v['style_preset_id'] !== undefined ? [v['style_preset_id']] : []
  const out: number[] = []
  for (const x of list) {
    const n = Number(x)
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/** settings JSON 解析 style_preset_id（整数 >0；缺失/畸形 → null；M8 旧键，保留兼容） */
export function stylePresetIdOf(settingsJson: string): number | null {
  try {
    const v = JSON.parse(settingsJson) as Record<string, unknown>
    const n = Number(v['style_preset_id'])
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * 展示壳剥离（纯函数，供探针 import 断言）：
 * 「画风提取」与内置 seed 的 snippet 带展示壳 `（画风：中文描述,english prompt）`——
 * 中文供人读、英文供图像模型用；但注入出图提示词时整串直拼会把「画风」二字 + 中文 + 全角括号
 * 一起喂给图像模型（噪音）。此函数在**拼接注入前**剥壳：仅当整串恰好是展示壳时取首个逗号后的英文段，
 * 无逗号（纯中文壳）则取壳内全文；**不整体命中壳（如用户手写纯词块）→ 原样返回**（零副作用）。
 * 仅作用于出图注入；规划软提示（presets.ts）仍用带壳原文，人/LLM 阅读更友好。
 */
const STYLE_WRAPPER_RE = /^[（(]\s*画风[：:]\s*([^）)\n]+)[）)]$/
export function stripStyleWrapper(snippet: string): string {
  const s = typeof snippet === 'string' ? snippet.trim() : ''
  if (!s) return s
  const m = s.match(STYLE_WRAPPER_RE)
  if (!m || !m[1]) return s
  const inner = m[1].trim()
  const comma = inner.search(/[,，]/)
  const english = comma >= 0 ? inner.slice(comma + 1).trim() : inner
  return english || inner || s
}

/** [M13] 多词块拼接（trim → 剥展示壳 → 过滤空 → 「A；B」；全空 → null）；出图注入处调用，injectStyleAnchor 签名不破 */
export function combineStyleSnippets(snippets: string[]): string | null {
  const parts = snippets.map((s) => stripStyleWrapper(typeof s === 'string' ? s : '')).filter(Boolean)
  return parts.length > 0 ? parts.join('；') : null
}

/**
 * [M13] 视觉提取输出解析（供探针直接 import 断言）：
 * 剥 markdown 围栏 → 命中「(画风：…)」取括号内 → 规范化回「（画风：…）」；
 * 未命中 → 全文宽容回退；长度 cap MAX_SNIPPET_CHARS。
 */
export function extractSnippetFromText(raw: string): string {
  const text = raw.replace(/```[a-z]*\r?\n?/gi, '').replace(/```/g, '').trim()
  const m = text.match(/[（(]\s*画风[：:]\s*([^）)\n]+)[）)]/)
  if (m && m[1] && m[1].trim()) return `（画风：${m[1].trim()}）`.slice(0, MAX_SNIPPET_CHARS)
  return text.slice(0, MAX_SNIPPET_CHARS)
}

/**
 * [M13] 参考图 → 画风词提取（视觉 LLM）：1..MAX_EXTRACT_IMAGES 张项目图片 → data URI 多图入参；
 * system = style-extract.md；返回 snippet（不落库，前端预填表单）；用量 runId=null 记录（非 run 来源）。
 */
export async function extractStyleSnippetFromAssets(
  projectId: number,
  assetIds: unknown[],
): Promise<{ snippet: string; provider: string; model: string }> {
  if (!Array.isArray(assetIds) || assetIds.length === 0) throw new Error('asset_ids 至少 1 张图片')
  if (assetIds.length > MAX_EXTRACT_IMAGES) throw new Error(`asset_ids 最多 ${MAX_EXTRACT_IMAGES} 张（多图会稀释共同风格特征）`)
  const nums = await assertProjectAssets(projectId, assetIds, 'asset_ids')
  const cache = new Map<number, string>()
  const images: ChatContentPart[] = []
  for (const id of nums) images.push({ type: 'image_url', image_url: { url: await assetToDataUri(id, projectId, cache) } })
  const system = loadPromptTemplate('style-extract.md')
  const result = await chatCompleteDetailed(
    [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'text', text: `请提取以下 ${images.length} 张图片的共同画风提示词` }, ...images] },
    ],
    undefined,
    { temperature: 0.3, maxTokens: 400 },
  )
  await recordLlmUsage({ projectId, runId: null, provider: result.provider, model: result.model, usage: result.usage })
  return { snippet: extractSnippetFromText(result.content), provider: result.provider, model: result.model }
}
