/**
 * [入口改造] 模板场景展示工具：scene 元数据 → 分组卡片（入口选择器）与下拉 optgroup。
 * 纯展示层，不参与引擎执行；无 scene 或未知值回落「其他」组（新模板零改动可扩展）。
 */
import type { TemplateMeta } from './types'

export const SCENE_ORDER = ['produce', 'plan', 'operate'] as const

export const SCENE_LABELS: Record<string, string> = {
  produce: '出成品',
  plan: '做规划',
  operate: '发布与复盘',
}

export const SCENE_HINTS: Record<string, string> = {
  produce: '一句话进去，成品出来',
  plan: '选题 · 策划 · 立项',
  operate: '多平台适配 · 数据回灌',
}

/** genre 英文值 → 中文标签（卡片/下拉展示用） */
export const GENRE_LABELS: Record<string, string> = {
  note: '图文',
  article: '长文',
  talking_head: '口播',
  drama_short: '短剧',
  other: '通用',
}

export function genreText(g: string): string {
  return GENRE_LABELS[g] ?? g
}

// ===== 项目体裁字典（与模板 genre 及存量数据对齐；见优化计划） =====

/** 项目体裁选项（顺序即下拉顺序）：与库内存量值一致（drama_short/note/talking_head/other） */
export const PROJECT_GENRES: { value: string; label: string }[] = [
  { value: 'drama_short', label: '短剧' },
  { value: 'note', label: '图文' },
  { value: 'article', label: '长文' },
  { value: 'talking_head', label: '口播' },
  { value: 'other', label: '其他' },
]

/** 历史表单值 ≥ 现行字典的兼容归一（talk 为旧表单遗留值） */
export function normalizeGenre(g: string): string {
  return g === 'talk' ? 'talking_head' : g
}

/** 项目体裁展示：归一 → 项目字典 → 模板字典 → 原值兜底 */
export function projectGenreText(g: string): string {
  const k = normalizeGenre(g)
  return (
    PROJECT_GENRES.find((x) => x.value === k)?.label ?? GENRE_LABELS[k] ?? g
  )
}

/** 体裁 → 默认模板弱关联（仅预选，不校验；命中模板列表才换） */
export const GENRE_DEFAULT_TPL: Record<string, string> = {
  drama_short: 'mengbao-episode',
  note: 'note-clip',
  article: 'article-clip',
  talking_head: 'talking-clip',
}

export interface SceneGroup {
  key: string
  label: string
  hint?: string
  items: TemplateMeta[]
}

/** 按 scene 分组（SCENE_ORDER 排序；空组剔除；无/未知 scene → 「其他」组兜底） */
export function groupTemplates(items: TemplateMeta[]): SceneGroup[] {
  const groups: SceneGroup[] = SCENE_ORDER.map((s) => ({
    key: s,
    label: SCENE_LABELS[s] ?? s,
    hint: SCENE_HINTS[s],
    items: [],
  }))
  const byKey = new Map(groups.map((g) => [g.key, g]))
  const other: SceneGroup = { key: 'other', label: '其他', items: [] }
  for (const t of items) {
    const g = (t.scene ? byKey.get(t.scene) : undefined) ?? other
    g.items.push(t)
  }
  const out = groups.filter((g) => g.items.length > 0)
  if (other.items.length > 0) out.push(other)
  return out
}

/**
 * [入口收口] 从模板列表中剔除轻松创作批准链专用模板（conversationOnly）。
 * 所有「用户选模板去启动/批量/建项目/排程/画布运行」的选择器均须先过此函数；
 * 而按 key 反查名字展示（run/项目/批量详情、模板编辑器）不过滤（需能显示 easy-* 存量项）。
 * 真源为服务端 isCreationTemplate，前端不硬编码键名。
 */
export function filterSelectable(items: TemplateMeta[]): TemplateMeta[] {
  return items.filter((t) => !t.conversationOnly)
}
