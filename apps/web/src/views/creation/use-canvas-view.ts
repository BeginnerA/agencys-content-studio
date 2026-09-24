import { onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import { studioOn } from '../../lib/socket'
import { useCanvasState } from './use-canvas-state'
import { useCanvasTarget } from './use-canvas-target'
import { useCanvasDoc } from './use-canvas-doc'
import { useCanvasSocket } from './use-canvas-socket'
import { useCanvasSelection } from './use-canvas-selection'
import { useCanvasCommands } from './use-canvas-commands'
import { useCanvasGroups } from './use-canvas-groups'
import { useCanvasBatch } from './use-canvas-batch'
import { useCanvasEstimate } from './use-canvas-estimate'
import { useCanvasRefs } from './use-canvas-refs'
import { useCanvasExport } from './use-canvas-export'
import { useCanvasRuns } from './use-canvas-runs'
import { useCanvasOverview } from './use-canvas-overview'
import { useCanvasPalette } from './use-canvas-palette'
import { useCanvasTrash } from './use-canvas-trash'
import { useCanvasSnapshots } from './use-canvas-snapshots'
import { useCanvasCopyTo } from './use-canvas-copyto'
import { useCanvasAdvice } from './use-canvas-advice'

/** 视图装配入口；URL 与 socket 的 immediate 顺序保持原页语义。 */
export function useCanvasView() {
  const state = useCanvasState()
  const target = useCanvasTarget({
    ...state,
    loadDoc: (silent) => document.loadDoc(silent),
  })
  const document = useCanvasDoc({ ...state, ...target })
  const { route, syncFromQuery } = target
  watch(() => route.query, syncFromQuery, { immediate: true })

  const socket = useCanvasSocket({ ...state, ...document })
  const selection = useCanvasSelection({ ...state })
  const commands = useCanvasCommands({ ...state, ...document, ...target })
  const groups = useCanvasGroups({ ...state, ...document })
  const batch = useCanvasBatch({ ...state, ...document })
  const estimate = useCanvasEstimate({ ...state })
  const refs = useCanvasRefs({ ...state })
  const exports = useCanvasExport({ ...state, ...commands, ...document })
  const runs = useCanvasRuns({ ...state, ...commands, ...document })
  const overview = useCanvasOverview({ ...state, ...runs })
  const advice = useCanvasAdvice({ ...state, focusNode: overview.focusNode })
  const palette = useCanvasPalette({
    ...state,
    ...commands,
    ...document,
    ...target,
  })
  const trash = useCanvasTrash({ ...state, ...target })
  const snapshots = useCanvasSnapshots({ ...state, ...document, ...target })
  const copyTo = useCanvasCopyTo({ ...state, ...document, ...target })

  const { loadLists } = target
  const { onCanvasEvent } = socket

  // ===== 生命周期 =====
  onMounted(() => {
    studioOn('canvas.changed', onCanvasEvent)
    void loadLists()
  })
  onBeforeUnmount(() => {
    socket.disposeSocket()
    document.disposeRefresh()
    state.disposeToast()
    runs.disposeRunPoll()
  })

  return reactive({
    ...state,
    ...target,
    ...document,
    ...socket,
    ...selection,
    ...commands,
    ...groups,
    ...batch,
    ...estimate,
    ...refs,
    ...exports,
    ...runs,
    ...overview,
    ...palette,
    ...trash,
    ...snapshots,
    ...copyTo,
    ...advice,
  })
}

export type CanvasViewState = ReturnType<typeof useCanvasView>
