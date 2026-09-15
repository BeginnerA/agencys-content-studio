/** [M28] 创作画布：CanvasSnapshots；依赖显式注入，原函数体保持不变。 */
import { ref } from 'vue'
import { creationApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { CanvasSnapshotMeta } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasDocument } from './use-canvas-doc'
import type { CanvasTarget } from './use-canvas-target'

type Dependencies = Pick<CanvasState, 'canvasId' | 'toast' | 'history'>
  & Pick<CanvasDocument, 'loadDoc'>
  & Pick<CanvasTarget, 'loadCanvases'>

export function useCanvasSnapshots(deps: Dependencies) {
  const { canvasId, toast, history, loadDoc, loadCanvases } = deps

  // ===== [M18] 文档快照（保留 id 重放恢复；恢复前自动备份）=====
  const showSnaps = ref(false)
  const snapsBusy = ref(false)
  const snapsLoading = ref(false)
  const snapItems = ref<CanvasSnapshotMeta[]>([])
  const snapLabel = ref('')
  const snapActing = ref<number | null>(null)

  async function openSnaps(): Promise<void> {
    if (canvasId.value == null) return
    snapLabel.value = ''
    showSnaps.value = true
    await loadSnaps()
  }
  async function loadSnaps(): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    snapsLoading.value = true
    try {
      const r = await creationApi.snapshots(cid)
      if (canvasId.value !== cid) return
      snapItems.value = r.items
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      snapsLoading.value = false
    }
  }
  async function createSnap(): Promise<void> {
    const cid = canvasId.value
    if (cid == null || snapsBusy.value) return
    snapsBusy.value = true
    try {
      const r = await creationApi.createSnapshot(cid, snapLabel.value.trim() || undefined)
      snapLabel.value = ''
      toast(`快照「${r.snapshot.label}」已创建`)
      await loadSnaps()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      snapsBusy.value = false
    }
  }
  async function restoreSnap(s: CanvasSnapshotMeta): Promise<void> {
    const cid = canvasId.value
    if (cid == null || snapActing.value != null) return
    const ok = await confirmDialog({
      title: '恢复快照',
      message: `将画布回退到「${s.label}」（${s.nodeCount} 节点 · ${s.edgeCount} 边）？当前状态会先自动备份为新快照；节点 id 原样保留，生成任务历史不断链。`,
      confirmText: '恢复快照',
      danger: true,
    })
    if (!ok) return
    snapActing.value = s.id
    try {
      const r = await creationApi.restoreSnapshot(cid, s.id)
      showSnaps.value = false
      history.clear() // 快照恢复重放文档 → 命令栈失效
      toast(`已恢复「${s.label}」（重放 ${r.restored.nodes} 节点/${r.restored.edges} 边；恢复前状态已自动备份）`)
      await loadDoc(true)
      void loadCanvases()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      snapActing.value = null
    }
  }
  async function deleteSnap(s: CanvasSnapshotMeta): Promise<void> {
    const cid = canvasId.value
    if (cid == null || snapActing.value != null) return
    const ok = await confirmDialog({
      title: '删除快照',
      message: `删除快照「${s.label}」？此操作不可撤销。`,
      confirmText: '删除快照',
      danger: true,
    })
    if (!ok) return
    snapActing.value = s.id
    try {
      await creationApi.deleteSnapshot(cid, s.id)
      toast('快照已删除')
      await loadSnaps()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      snapActing.value = null
    }
  }

  return {
    showSnaps,
    snapsBusy,
    snapsLoading,
    snapItems,
    snapLabel,
    snapActing,
    openSnaps,
    loadSnaps,
    createSnap,
    restoreSnap,
    deleteSnap,
  }
}

export type CanvasSnapshots = ReturnType<typeof useCanvasSnapshots>
