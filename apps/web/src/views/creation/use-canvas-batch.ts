/** [M28] 创作画布：CanvasBatch；依赖显式注入，原函数体保持不变。 */
import { computed, ref } from 'vue'
import { creationApi } from '../../lib/api'
import type { CanvasArrangeMode } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasDocument } from './use-canvas-doc'

type Dependencies = Pick<CanvasState, 'canvasId' | 'nodes' | 'history' | 'toast' | 'selectedIds'>
  & Pick<CanvasDocument, 'loadDoc'>

export function useCanvasBatch(deps: Dependencies) {
  const { canvasId, nodes, history, loadDoc, toast, selectedIds } = deps

  // ===== [M17] 批量编排（多选浮动条 / 顶栏整理）=====
  const ARRANGE_LABEL: Record<CanvasArrangeMode, string> = {
    layered: '分层整理',
    grid: '按序号排列',
    'align-left': '左对齐',
    'align-right': '右对齐',
    'align-top': '顶对齐',
    'align-bottom': '底对齐',
    'distribute-h': '水平分布',
    'distribute-v': '垂直分布',
  }
  const batchBusy = ref(false)

  /** 整理/对齐/分布（positions 快照入栈；失败 toast） */
  async function runArrange(mode: CanvasArrangeMode, nodeIds?: number[]): Promise<void> {
    const cid = canvasId.value
    if (cid == null || !nodes.value.length) return
    batchBusy.value = true
    try {
      const targets = nodeIds ? nodes.value.filter((n) => nodeIds.includes(n.id)) : nodes.value
      const before = targets.map((n) => ({ id: n.id, x: n.x, y: n.y }))
      const r = await creationApi.arrange(cid, mode === 'grid' ? { mode, nodeIds, sortBy: 'seq' } : { mode, nodeIds })
      const after = r.positions
      history.push({
        label: ARRANGE_LABEL[mode],
        undo: async () => {
          await creationApi.batchNodes(cid, before)
          await loadDoc(true)
        },
        redo: async () => {
          await creationApi.batchNodes(cid, after)
          await loadDoc(true)
        },
      })
      await loadDoc(true)
      toast(`${ARRANGE_LABEL[mode]}：更新 ${r.updated} 个节点`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      batchBusy.value = false
    }
  }
  function batchArrange(mode: CanvasArrangeMode): void {
    void runArrange(mode, [...selectedIds.value])
  }
  function arrangeAll(mode: 'layered' | 'grid'): void {
    void runArrange(mode)
  }

  /** 编号：按 x 序（同 x 按 y）编 seq 1..N → batch 一条命令 */
  async function batchNumber(): Promise<void> {
    const cid = canvasId.value
    const sel = nodes.value.filter((n) => selectedIds.value.includes(n.id))
    if (cid == null || sel.length < 2) return
    const sorted = [...sel].sort((a, b) => a.x - b.x || a.y - b.y)
    const before = sorted.map((n) => ({ id: n.id, seq: n.seq ?? null }))
    const updates = sorted.map((n, i) => ({ id: n.id, seq: i + 1 }))
    batchBusy.value = true
    try {
      await creationApi.batchNodes(cid, updates)
      history.push({
        label: `编号 1–${updates.length}`,
        undo: async () => {
          await creationApi.batchNodes(cid, before)
          await loadDoc(true)
        },
        redo: async () => {
          await creationApi.batchNodes(cid, updates)
          await loadDoc(true)
        },
      })
      await loadDoc(true)
      toast(`已按 x 序编号 1–${updates.length}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      batchBusy.value = false
    }
  }

  /** 规则式串联（相邻对建边；created 可变引用，全跳过时提示原因） */
  async function batchChain(): Promise<void> {
    const cid = canvasId.value
    const ids = [...selectedIds.value]
    if (cid == null || ids.length < 2) return
    batchBusy.value = true
    try {
      const r = await creationApi.chainNodes(cid, ids)
      let created = r.created.map((e) => e.id)
      if (!created.length) {
        toast(`未能串联：${r.skipped[0]?.reason ?? '无可连接的相邻对'}`)
        return
      }
      history.push({
        label: `串联 ${created.length} 条边`,
        undo: async () => {
          await Promise.all(created.map((id) => creationApi.removeEdge(id)))
          await loadDoc(true)
        },
        redo: async () => {
          const rr = await creationApi.chainNodes(cid, ids)
          created = rr.created.map((e) => e.id)
          await loadDoc(true)
        },
      })
      await loadDoc(true)
      toast(r.skipped.length ? `已串联 ${created.length} 条边，跳过 ${r.skipped.length} 对` : `已串联 ${created.length} 条边`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      batchBusy.value = false
    }
  }

  /** 批量执行（只入队就绪节点；不入栈） */
  async function batchRun(): Promise<void> {
    const cid = canvasId.value
    const ids = [...selectedIds.value]
    if (cid == null || ids.length < 2) return
    batchBusy.value = true
    try {
      const r = await creationApi.runBatch(cid, { nodeIds: ids })
      await loadDoc(true)
      if (r.started.length && r.skipped.length) toast(`已入队 ${r.started.length} 个节点，跳过 ${r.skipped.length} 个（未就绪）`)
      else if (r.started.length) toast(`已入队 ${r.started.length} 个节点执行`)
      else toast(`无可执行节点：${r.skipped[0]?.problems.join('；') ?? '均未就绪'}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      batchBusy.value = false
    }
  }

  // ===== [M18] 一键停止全部（画布级在途任务；socket canvas.changed 驱动可见性） =====
  /** 在途 gen 任务（pending/processing；doc 由 socket 静默重拉） */
  const hasLiveTasks = computed(() =>
    nodes.value.some((n) => n.kind === 'gen' && (n.status === 'pending' || n.status === 'processing')),
  )
  const cancelAllBusy = ref(false)

  async function onCancelAllTasks(): Promise<void> {
    const cid = canvasId.value
    if (cid == null || cancelAllBusy.value) return
    cancelAllBusy.value = true
    try {
      const r = await creationApi.cancelTasks(cid)
      await loadDoc(true)
      toast(r.cancelled > 0 ? `已停止 ${r.cancelled} 个在途任务` : '当前没有在途任务')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      cancelAllBusy.value = false
    }
  }

  return {
    ARRANGE_LABEL,
    batchBusy,
    runArrange,
    batchArrange,
    arrangeAll,
    batchNumber,
    batchChain,
    batchRun,
    hasLiveTasks,
    cancelAllBusy,
    onCancelAllTasks,
  }
}

export type CanvasBatch = ReturnType<typeof useCanvasBatch>
