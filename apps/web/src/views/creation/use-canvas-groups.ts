/** [M28] 创作画布：CanvasGroups；依赖显式注入，原函数体保持不变。 */
import { creationApi } from '../../lib/api'
import type { CanvasState } from './use-canvas-state'
import type { CanvasDocument } from './use-canvas-doc'

type Dependencies = Pick<CanvasState, 'canvasId' | 'selectedIds' | 'toast'> &
  Pick<CanvasDocument, 'loadDoc'>

export function useCanvasGroups(deps: Dependencies) {
  const { canvasId, selectedIds, loadDoc, toast } = deps

  // ===== [M18] 分组：成组 / 改组 / 解组（spec §2.6⑩）=====
  /** Ctrl+G / 批量条成组：把当前选中集（≥2）归入新组 */
  async function onGroupCreate(): Promise<void> {
    const cid = canvasId.value
    const ids = [...selectedIds.value]
    if (cid == null || ids.length < 2) return
    try {
      const { group } = await creationApi.createGroup(cid, { nodeIds: ids })
      await loadDoc(true)
      toast(`已建组「${group.title}」（${ids.length} 个节点）`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  /** 组条改组（title / color / collapsed / parentId 局部）；重拉对账 */
  async function onGroupPatch(
    gid: number,
    patch: {
      title?: string
      color?: string | null
      collapsed?: boolean
      parentId?: number | null
    },
  ): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    try {
      await creationApi.updateGroup(cid, gid, patch)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
    await loadDoc(true)
  }

  /** [M22] 组条拖拽：后代组（含自身）锚点批量平移（节点平移走 moved 通道；失败重拉对账） */
  async function onGroupsMoved(
    moves: Array<{ id: number; x: number; y: number }>,
  ): Promise<void> {
    const cid = canvasId.value
    if (cid == null || !moves.length) return
    try {
      await Promise.all(
        moves.map((m) =>
          creationApi.updateGroup(cid, m.id, { x: m.x, y: m.y }),
        ),
      )
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      await loadDoc(true)
    }
  }

  /** 解组（成员保留，组行删除） */
  async function onGroupDelete(gid: number): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    try {
      await creationApi.deleteGroup(cid, gid)
      await loadDoc(true)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  return {
    onGroupCreate,
    onGroupPatch,
    onGroupDelete,
    onGroupsMoved,
  }
}

export type CanvasGroups = ReturnType<typeof useCanvasGroups>
