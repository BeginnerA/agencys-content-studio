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
