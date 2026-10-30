/**
 * route 输入物化（M70 Task 8）：InputSpecItem → 具体值。
 * 原 route-execution 私有 materialize 原样抽出（逐字迁出，无行为变化）：
 * 确认侧（route-execution）与连续性目标定位侧（continuity/route-bridge）必须同源物化，
 * 否则批准包 inputHash 与确认物化输入将失配。default/prev 不参与单模板物化——
 * prev 仅链内运行期由 orchestrator 解析。纯函数、零 IO。
 */
import type { InputSpecItem } from './agent/decision-schema'

export function materializeRouteInputs(spec: Record<string, InputSpecItem>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, item] of Object.entries(spec)) {
    switch (item.kind) {
      case 'text': out[field] = item.value; break
      case 'number': out[field] = item.value; break
      case 'boolean': out[field] = item.value; break
      case 'asset': out[field] = item.assetId; break
      case 'assets': out[field] = item.assetIds; break
      case 'default':
      case 'prev': break
    }
  }
  return out
}
