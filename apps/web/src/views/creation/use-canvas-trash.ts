/** [M28] 创作画布：CanvasTrash；依赖显式注入，原函数体保持不变。 */
import { ref } from 'vue'
import { creationApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { CanvasListItem } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasTarget } from './use-canvas-target'

type Dependencies = Pick<CanvasState, 'projectId' | 'toast'> &
  Pick<CanvasTarget, 'loadCanvases'>

export function useCanvasTrash(deps: Dependencies) {
  const { projectId, toast, loadCanvases } = deps

  // ===== [M18] 回收站（软删画布：恢复 / 彻底删除）=====
  const showTrash = ref(false)
  const trashLoading = ref(false)
  const trashItems = ref<CanvasListItem[]>([])
  const trashActing = ref<number | null>(null)

  async function openTrash(): Promise<void> {
    showTrash.value = true
    await loadTrash()
  }
  async function loadTrash(): Promise<void> {
    const pid = projectId.value
    if (pid == null) {
      trashItems.value = []
      return
    }
    trashLoading.value = true
    try {
      const r = await creationApi.list(pid, { trash: true })
      trashItems.value = r.items
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      trashLoading.value = false
    }
  }
  async function restoreTrashed(c: CanvasListItem): Promise<void> {
    if (trashActing.value != null) return
    trashActing.value = c.id
    try {
      await creationApi.restore(c.id)
      toast(`画布「${c.name}」已恢复`)
      await loadTrash()
      await loadCanvases()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      trashActing.value = null
    }
  }
  async function purgeTrashed(c: CanvasListItem): Promise<void> {
    if (trashActing.value != null) return
    const ok = await confirmDialog({
      title: '彻底删除',
      message: `彻底删除画布「${c.name}」及其全部节点与连线？此操作不可撤销（产物资产保留在资产库）。`,
      confirmText: '彻底删除',
      danger: true,
    })
    if (!ok) return
    trashActing.value = c.id
    try {
      await creationApi.purge(c.id)
      toast('画布已彻底删除')
      await loadTrash()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      trashActing.value = null
    }
  }

  return {
    showTrash,
    trashLoading,
    trashItems,
    trashActing,
    openTrash,
    loadTrash,
    restoreTrashed,
    purgeTrashed,
  }
}

export type CanvasTrash = ReturnType<typeof useCanvasTrash>
