/** [M28] 创作画布：CanvasSnapshots；依赖显式注入，原函数体保持不变。 */
import { ref } from 'vue'
import { creationApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { CanvasSnapshotMeta, SnapshotDiffResult } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasDocument } from './use-canvas-doc'
import type { CanvasTarget } from './use-canvas-target'

type Dependencies = Pick<CanvasState, 'canvasId' | 'toast' | 'history'>
  & Pick<CanvasDocument, 'loadDoc'>
  & Pick<CanvasTarget, 'loadCanvases' | 'goCanvas'>

export function useCanvasSnapshots(deps: Dependencies) {
  const { canvasId, toast, history, loadDoc, loadCanvases, goCanvas } = deps

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

  // ===== [M22] 快照对比（diff）：快照 ↔ live/另一快照 字段级差异 =====
  /** 当前对比基准快照（null=未打开对比视图） */
  const diffFor = ref<CanvasSnapshotMeta | null>(null)
  /** 对比目标：'live'（当前画布）或快照 id 字符串 */
  const diffAgainst = ref('live')
  const diffLoading = ref(false)
  const diffData = ref<SnapshotDiffResult | null>(null)

  async function openDiff(s: CanvasSnapshotMeta): Promise<void> {
    diffFor.value = s
    diffAgainst.value = 'live'
    branchFor.value = null
    await loadDiff()
  }
  async function loadDiff(): Promise<void> {
    const cid = canvasId.value
    const s = diffFor.value
    if (cid == null || !s) return
    diffLoading.value = true
    try {
      diffData.value = await creationApi.snapshotDiff(cid, s.id, diffAgainst.value)
    } catch (e) {
      diffData.value = null
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      diffLoading.value = false
    }
  }
  function closeDiff(): void {
    diffFor.value = null
    diffData.value = null
  }

  // ===== [M22] 从快照分支为新画布（命名 → 创建 → 跳转） =====
  /** 待分支快照（null=未展开命名面板） */
  const branchFor = ref<CanvasSnapshotMeta | null>(null)
  const branchName = ref('')
  const branchBusy = ref(false)

  function startBranch(s: CanvasSnapshotMeta): void {
    branchFor.value = s
    branchName.value = ''
    diffFor.value = null
  }
  async function branchSnap(): Promise<void> {
    const cid = canvasId.value
    const s = branchFor.value
    if (cid == null || !s || branchBusy.value) return
    branchBusy.value = true
    try {
      const r = await creationApi.branchSnapshot(cid, s.id, branchName.value.trim() || undefined)
      showSnaps.value = false
      branchFor.value = null
      toast(`已从「${s.label}」分支为新画布「${r.canvas.name}」`)
      await loadCanvases()
      goCanvas(r.canvas.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      branchBusy.value = false
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
    diffFor,
    diffAgainst,
    diffLoading,
    diffData,
    openDiff,
    loadDiff,
    closeDiff,
    branchFor,
    branchName,
    branchBusy,
    startBranch,
    branchSnap,
  }
}

export type CanvasSnapshots = ReturnType<typeof useCanvasSnapshots>
