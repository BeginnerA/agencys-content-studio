/** [M28] 创作画布：CanvasState；依赖显式注入，原函数体保持不变。 */
import { computed, ref } from 'vue'
import CreationBoard from '../../components/creation/board/index.vue'
import { createCanvasHistory } from '../../lib/canvas-history'
import type { CanvasDoc, CanvasDocEdge, CanvasDocNode, CanvasGroup } from '../../lib/types'

export function useCanvasState() {
  // ===== 目标（route.query 单一真源）=====
  const projectId = ref<number | null>(null)
  const canvasId = ref<number | null>(null)

  const doc = ref<CanvasDoc | null>(null)
  const loading = ref(false)
  const err = ref('')

  const selectedIds = ref<number[]>([])
  const selectedEdgeId = ref<number | null>(null)
  /** [M17] 撤销/重做命令栈（移动/新建/删除/连线/复制入栈；选中/视口不入栈） */
  const history = createCanvasHistory()
  const boardRef = ref<InstanceType<typeof CreationBoard> | null>(null)
  /** [M17] 命令栈按钮状态（嵌套 ref → computed 供模板解包） */
  const canUndo = computed(() => history.canUndo.value)
  const canRedo = computed(() => history.canRedo.value)
  const undoTitle = computed(() => (history.undoLabel.value ? `撤销：${history.undoLabel.value}（Ctrl+Z）` : '撤销（Ctrl+Z）'))
  const redoTitle = computed(() => (history.redoLabel.value ? `重做：${history.redoLabel.value}（Ctrl+Shift+Z）` : '重做（Ctrl+Shift+Z）'))

  const nodes = computed<CanvasDocNode[]>(() => doc.value?.nodes ?? [])
  const edges = computed<CanvasDocEdge[]>(() => doc.value?.edges ?? [])
  const groups = computed<CanvasGroup[]>(() => doc.value?.groups ?? [])
  /** 单选详情（多选 → null；P5 批量浮动条浮出） */
  const selNode = computed<CanvasDocNode | null>(() => {
    const ids = selectedIds.value
    if (ids.length !== 1) return null
    return nodes.value.find((n) => n.id === ids[0]) ?? null
  })
  const selEdge = computed<CanvasDocEdge | null>(() =>
    selectedEdgeId.value == null ? null : (edges.value.find((e) => e.id === selectedEdgeId.value) ?? null),
  )
  const activeProjectId = computed(() => doc.value?.canvas.projectId ?? projectId.value ?? 0)

  // ===== toast =====
  const toastMsg = ref('')
  let toastTimer: number | null = null
  function toast(msg: string): void {
    toastMsg.value = msg
    if (toastTimer != null) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toastMsg.value = ''
      toastTimer = null
    }, 3600)
  }

  function disposeToast(): void {
    if (toastTimer != null) window.clearTimeout(toastTimer)
  }

  return {
    projectId,
    canvasId,
    doc,
    loading,
    err,
    selectedIds,
    selectedEdgeId,
    history,
    boardRef,
    canUndo,
    canRedo,
    undoTitle,
    redoTitle,
    nodes,
    edges,
    groups,
    selNode,
    selEdge,
    activeProjectId,
    toastMsg,
    toast,
    disposeToast,
  }
}

export type CanvasState = ReturnType<typeof useCanvasState>
