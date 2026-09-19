/** [M28] 创作画布：CanvasDocument；依赖显式注入，原函数体保持不变。 */
import { creationApi } from '../../lib/api'
import type { CanvasState } from './use-canvas-state'
import type { CanvasTarget } from './use-canvas-target'

type Dependencies = Pick<
  CanvasState,
  | 'canvasId'
  | 'loading'
  | 'err'
  | 'doc'
  | 'projectId'
  | 'selectedIds'
  | 'selectedEdgeId'
> &
  Pick<CanvasTarget, 'loadCanvases' | 'loadPalette'>

export function useCanvasDoc(deps: Dependencies) {
  const {
    canvasId,
    loading,
    err,
    doc,
    projectId,
    loadCanvases,
    loadPalette,
    selectedIds,
    selectedEdgeId,
  } = deps

  // 文档拉取序列守卫（须先于下方 URL watch 声明：其 immediate 回调会同步触发 loadDoc）
  let docSeq = 0

  // ===== 文档拉取（静默对账）=====
  async function loadDoc(silent = false): Promise<void> {
    const id = canvasId.value
    if (id == null) return
    const seq = ++docSeq
    if (!silent) {
      loading.value = true
      err.value = ''
    }
    try {
      const d = await creationApi.doc(id)
      if (seq !== docSeq || canvasId.value !== id) return
      doc.value = d
      err.value = ''
      if (projectId.value == null) {
        projectId.value = d.canvas.projectId
        void loadCanvases()
        void loadPalette()
      }
      const nodeIdSet = new Set(d.nodes.map((n) => n.id))
      selectedIds.value = selectedIds.value.filter((id) => nodeIdSet.has(id))
      if (
        selectedEdgeId.value != null &&
        !d.edges.some((e) => e.id === selectedEdgeId.value)
      )
        selectedEdgeId.value = null
    } catch (e) {
      if (!silent) err.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (!silent && seq === docSeq) loading.value = false
    }
  }

  let refreshTimer: number | null = null
  function scheduleRefresh(): void {
    if (refreshTimer != null) window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null
      void loadDoc(true)
    }, 350)
  }

  function disposeRefresh(): void {
    if (refreshTimer != null) window.clearTimeout(refreshTimer)
  }

  return {
    loadDoc,
    scheduleRefresh,
    disposeRefresh,
  }
}

export type CanvasDocument = ReturnType<typeof useCanvasDoc>
