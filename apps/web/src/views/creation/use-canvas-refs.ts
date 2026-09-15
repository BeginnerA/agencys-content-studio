/** [M28] 创作画布：CanvasRefs；依赖显式注入，原函数体保持不变。 */
import { ref } from 'vue'
import { creationApi, entityApi } from '../../lib/api'
import type { EntityItem } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'

type Dependencies = Pick<CanvasState, 'nodes' | 'selectedIds' | 'projectId' | 'toast'>

export function useCanvasRefs(deps: Dependencies) {
  const { nodes, selectedIds, projectId, toast } = deps

  // ===== [M18] 加入实体参考（批量：选中节点显示产物 → 实体并集挂接） =====
  const showRefPick = ref(false)
  const refPickBusy = ref(false)
  const refPickLoading = ref(false)
  const refPickErr = ref('')
  const refPickEntities = ref<EntityItem[]>([])

  /** 选中节点显示产物资产（去重；skipped = 无产物节点数） */
  function selectedProductAssets(): { assetIds: number[]; skipped: number } {
    const assetIds: number[] = []
    const seen = new Set<number>()
    let contributing = 0
    for (const n of nodes.value) {
      if (!selectedIds.value.includes(n.id)) continue
      const aid = n.kind === 'gen' ? (n.displayTask?.resultAssetId ?? n.assetId) : n.kind === 'asset' ? n.assetId : null
      if (aid == null) continue
      contributing += 1
      if (!seen.has(aid)) {
        seen.add(aid)
        assetIds.push(aid)
      }
    }
    return { assetIds, skipped: selectedIds.value.length - contributing }
  }

  async function openRefPick(): Promise<void> {
    const pid = projectId.value
    if (pid == null || refPickBusy.value) return
    showRefPick.value = true
    refPickErr.value = ''
    refPickLoading.value = true
    try {
      const params = `&project_id=${pid}`
      const [c, s, p] = await Promise.all([
        entityApi.list('character', params),
        entityApi.list('scene', params),
        entityApi.list('prop', params),
      ])
      refPickEntities.value = [...c.items, ...s.items, ...p.items]
    } catch (e) {
      refPickErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      refPickLoading.value = false
    }
  }

  async function attachToEntity(e: EntityItem): Promise<void> {
    const { assetIds, skipped } = selectedProductAssets()
    if (!assetIds.length) {
      refPickErr.value = '选中节点均无显示产物（可先生成或采纳产物）'
      return
    }
    refPickBusy.value = true
    refPickErr.value = ''
    try {
      const r = await creationApi.attachRefAssets(e.id, assetIds)
      showRefPick.value = false
      toast(skipped > 0
        ? `已挂接「${e.name}」参考图（新增 ${r.added ?? 0} 张，跳过 ${skipped} 个无产物节点）`
        : `已挂接「${e.name}」参考图（新增 ${r.added ?? 0} 张）`)
    } catch (err) {
      refPickErr.value = err instanceof Error ? err.message : String(err)
    } finally {
      refPickBusy.value = false
    }
  }

  return {
    showRefPick,
    refPickBusy,
    refPickLoading,
    refPickErr,
    refPickEntities,
    selectedProductAssets,
    openRefPick,
    attachToEntity,
  }
}

export type CanvasRefs = ReturnType<typeof useCanvasRefs>
