import { parseWhenExpr, whenRefs } from './refs'
import type { Template, TemplateStepDef } from './types'

/**
 * [M15] DAG 依赖语义共享模块——单一真源。
 * 逐行迁自 engine 原私有 depsFor/whenExprs（M15 前为引擎独有）：调度（engine）与
 * 画布调度边（services/canvas）必须同源消费本模块，禁止第二套实现。
 * 语义：①显式 after（多值、排除自身、按键去重）取代默认；②无 after → 前一步骤 key；
 * ③平铺 when/when_any/gate.when 全部表达式的 steps.x.count 隐含引用。
 */

/** 依赖来源：显式 after / 缺省前一步 / when 表达式隐含步骤引用 */
export type DepOrigin = 'after' | 'default' | 'when'

/** 平铺步骤全部条件表达式（when/when_any/gate.when） */
function whenExprs(def: TemplateStepDef): string[] {
  const out: string[] = []
  const add = (v: string | string[] | undefined): void => {
    if (v) out.push(...(Array.isArray(v) ? v : [v]))
  }
  add(def.when)
  add(def.when_any)
  add(def.gate?.when)
  return out
}

/** 步骤实际依赖（带来源标注；画布调度边消费——与 stepDeps 同源同序，首见来源优先） */
export function stepDepEdges(
  def: TemplateStepDef,
  template: Template,
  orderByKey: Map<string, number>,
): Array<{ from: string; origin: DepOrigin }> {
  const edges: Array<{ from: string; origin: DepOrigin }> = []
  const push = (k: string, origin: DepOrigin): void => {
    if (k && k !== def.key && !edges.some((e) => e.from === k)) edges.push({ from: k, origin })
  }
  if (def.after !== undefined) {
    for (const k of def.after) push(k, 'after')
  } else {
    const idx = orderByKey.get(def.key) ?? 0
    if (idx > 0) {
      const prev = template.steps[idx - 1]
      if (prev) push(prev.key, 'default')
    }
  }
  for (const raw of whenExprs(def)) {
    try {
      const ref = whenRefs(parseWhenExpr(raw))
      if (ref.stepKey) push(ref.stepKey, 'when')
    } catch {
      // loader 已静态校验；快照损坏由执行期求值兜底报错
    }
  }
  return edges
}

/** 步骤实际依赖：显式 after（缺省 = 前一步骤）+ when 表达式中 steps.x.count 的隐式依赖 */
export function stepDeps(def: TemplateStepDef, template: Template, orderByKey: Map<string, number>): string[] {
  return stepDepEdges(def, template, orderByKey).map((e) => e.from)
}
