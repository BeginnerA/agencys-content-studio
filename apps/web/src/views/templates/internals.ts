/** [M28] 模板视图共享纯逻辑：消息格式化 / YAML 骨架 / 只读信息字典 / 流程图几何。 */
import { ApiError } from '../../lib/api'
import { KIND_TEXT } from '../../lib/template-dict'
import type { TemplateStepDef } from '../../lib/types'

export function msg(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

/** 最小合法骨架（manual_ingest 在 KNOWN_ACTIONS 内） */
export function skeleton(key: string): string {
  return `key: ${key}
version: 1
name: ${key}
genre: talk
inputs: []
steps:
  - key: ingest
    action: manual_ingest
    title: 素材导入
    inputs: {}
`
}

/** 副本 yaml：key 行替换为目标 key（无 key 行则补一行） */
export function withKey(text: string, key: string): string {
  return /^key:.*$/m.test(text) ? text.replace(/^key:.*$/m, `key: ${key}`) : `key: ${key}\n${text}`
}

// ===== 只读信息：inputs 表 + steps 流程图（svg 竖排）=====
export function kindText(k: string): string {
  return KIND_TEXT[k] ?? k
}

export function fmtDefault(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

export interface FlowBadge {
  text: string
  cls: 'gate' | 'batch' | 'when' | 'any'
  tip: string
}

/** [说明书改造] 步骤徽标生成：svg 流程图与说明书步骤列表共用 */
export function stepBadgesOf(s: TemplateStepDef): FlowBadge[] {
  const badges: FlowBadge[] = []
  if (s.gate) badges.push({ text: '闸', cls: 'gate', tip: `人工闸门（${s.gate.mode}）` })
  if (s.batch) badges.push({ text: '批', cls: 'batch', tip: `批量字段：${s.batch.field}` })
  if (s.when) badges.push({ text: '条', cls: 'when', tip: '条件步骤（满足才执行）' })
  if (s.when_any) badges.push({ text: '或', cls: 'any', tip: 'OR 条件组（任一满足）' })
  return badges
}

/** [说明书改造] 说明书视图的友好徽标文案（编辑模式流程图仍用单字） */
export const GUIDE_BADGE_TEXT: Record<FlowBadge['cls'], string> = {
  gate: '人工审阅',
  batch: '批量逐项',
  when: '条件执行',
  any: '条件执行',
}

export interface FlowBox {
  i: number
  y: number
  key: string
  title: string
  action: string
  badges: FlowBadge[]
}

export interface FlowEdge {
  d: string
}

/** 流程图几何（viewBox 宽度固定 560；盒宽+走廊） */
export const BOX = { x: 56, w: 468, h: 56, gap: 30, top: 16 }
export const CORRIDOR = BOX.x - 22
export const BADGE_SLOT = 30


/** [M28] 步骤流程图几何（原 flow computed 提纯：boxes/edges/height）。 */
export function computeFlow(steps: TemplateStepDef[]) {
  const boxes: FlowBox[] = []
  const edges: FlowEdge[] = []
  const idxByKey = new Map<string, number>()
  steps.forEach((s, i) => idxByKey.set(s.key, i))
  steps.forEach((s, i) => {
    const y = BOX.top + i * (BOX.h + BOX.gap)
    const badges = stepBadgesOf(s)
    boxes.push({ i, y, key: s.key, title: s.title, action: s.action, badges })
    // 依赖边：after 显式声明；缺省 = 前一步；[] = 无依赖
    const deps = s.after !== undefined ? s.after : i > 0 ? [steps[i - 1]!.key] : []
    for (const dep of deps) {
      const j = idxByKey.get(dep)
      if (j === undefined || j >= i) continue
      const yj = BOX.top + j * (BOX.h + BOX.gap)
      if (j === i - 1) {
        edges.push({ d: `M ${BOX.x + BOX.w / 2} ${yj + BOX.h} L ${BOX.x + BOX.w / 2} ${y}` })
      } else {
        // 跨步依赖：绕左侧走廊
        edges.push({
          d: `M ${BOX.x + 12} ${yj + BOX.h} L ${CORRIDOR} ${yj + BOX.h} L ${CORRIDOR} ${y + BOX.h / 2} L ${BOX.x - 6} ${y + BOX.h / 2}`,
        })
      }
    }
  })
  const height = BOX.top + Math.max(steps.length, 1) * (BOX.h + BOX.gap)
  return { boxes, edges, height }
}
