/** [M28] 创作画布：CanvasSelection；依赖显式注入，原函数体保持不变。 */
import type { CanvasState } from './use-canvas-state'

type Dependencies = Pick<CanvasState, 'selectedIds' | 'selectedEdgeId'>

export function useCanvasSelection(deps: Dependencies) {
  const { selectedIds, selectedEdgeId } = deps

  // ===== 选择 =====
  function onSelect(ids: number[]): void {
    selectedIds.value = ids
    if (ids.length) selectedEdgeId.value = null
  }
  function onSelectEdge(id: number | null): void {
    selectedEdgeId.value = id
    if (id != null) selectedIds.value = []
  }
  function onClearSelection(): void {
    selectedIds.value = []
    selectedEdgeId.value = null
  }

  return {
    onSelect,
    onSelectEdge,
    onClearSelection,
  }
}

export type CanvasSelection = ReturnType<typeof useCanvasSelection>
