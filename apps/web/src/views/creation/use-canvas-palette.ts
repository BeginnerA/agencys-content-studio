/** 创作画布：CanvasPalette；依赖显式注入，原函数体保持不变。 */
import type { Asset, EntityItem } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasCommands } from './use-canvas-commands'
import type { CanvasDocument } from './use-canvas-doc'
import type { CanvasTarget } from './use-canvas-target'

type Dependencies = Pick<CanvasState, 'canvasId' | 'boardRef' | 'toast'> &
  Pick<CanvasCommands, 'addNodesCommand' | 'onDropFiles'> &
  Pick<CanvasDocument, 'loadDoc'> &
  Pick<CanvasTarget, 'fileInput'>

export function useCanvasPalette(deps: Dependencies) {
  const {
    canvasId,
    boardRef,
    addNodesCommand,
    toast,
    loadDoc,
    fileInput,
    onDropFiles,
  } = deps

  // ===== 素材面板 =====
  function paletteDragStart(ev: DragEvent, a: Asset): void {
    ev.dataTransfer?.setData('text/acs-asset-id', String(a.id))
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy'
  }

  let paletteSeq = 0
  async function paletteClick(a: Asset): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    const at = boardRef.value?.centerWorld() ?? { x: 160, y: 120 }
    const jitter = (paletteSeq++ % 5) * 26
    try {
      await addNodesCommand(
        cid,
        [{ kind: 'asset', assetId: a.id, x: at.x + jitter, y: at.y + jitter }],
        '新建素材节点',
      )
      toast('已加入素材节点')
      void loadDoc(true)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  /** 实体 Tab：类型标签 + 拖入 / 单击送至视口中心（建 entity 节点） */
  const ENT_KIND_TEXT: Record<EntityItem['kind'], string> = {
    character: '角色',
    scene: '场景',
    prop: '道具',
  }
  function paletteEntityDragStart(ev: DragEvent, e: EntityItem): void {
    ev.dataTransfer?.setData('text/acs-entity-id', String(e.id))
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy'
  }
  async function paletteEntityClick(e: EntityItem): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    const at = boardRef.value?.centerWorld() ?? { x: 160, y: 120 }
    const jitter = (paletteSeq++ % 5) * 26
    try {
      await addNodesCommand(
        cid,
        [
          {
            kind: 'entity',
            entityId: e.id,
            x: at.x + jitter,
            y: at.y + jitter,
          },
        ],
        '新建实体节点',
      )
      toast('已加入实体节点')
      void loadDoc(true)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }
  async function onDropEntity(p: {
    entityId: number
    x: number
    y: number
  }): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    try {
      await addNodesCommand(
        cid,
        [{ kind: 'entity', entityId: p.entityId, x: p.x, y: p.y }],
        '新建实体节点',
      )
      toast('已加入实体节点')
      void loadDoc(true)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }

  function pickFiles(): void {
    fileInput.value?.click()
  }
  async function onFilePicked(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (!files.length) return
    const at = boardRef.value?.centerWorld() ?? { x: 160, y: 120 }
    await onDropFiles({ files, x: at.x, y: at.y })
  }

  return {
    paletteDragStart,
    paletteClick,
    ENT_KIND_TEXT,
    paletteEntityDragStart,
    paletteEntityClick,
    onDropEntity,
    pickFiles,
    onFilePicked,
  }
}

export type CanvasPalette = ReturnType<typeof useCanvasPalette>
