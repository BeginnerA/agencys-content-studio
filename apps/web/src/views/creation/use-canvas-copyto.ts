/** [M22] 创作画布：跨画布复制弹窗（项目选择 + 目标画布列表 → POST nodes/copy-to）；依赖显式注入。 */
import { ref } from 'vue'
import { creationApi, projectApi } from '../../lib/api'
import type { CanvasListItem } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasDocument } from './use-canvas-doc'
import type { CanvasTarget } from './use-canvas-target'

type Dependencies = Pick<CanvasState, 'canvasId' | 'projectId' | 'selectedIds' | 'toast'>
  & Pick<CanvasDocument, 'loadDoc'>
  & Pick<CanvasTarget, 'loadCanvases'>

export function useCanvasCopyTo(deps: Dependencies) {
  const { canvasId, projectId, selectedIds, toast, loadDoc, loadCanvases } = deps

  const showCopyTo = ref(false)
  /** 打开弹窗时的选中节点快照（复制期间选择变化不影响） */
  const copyToIds = ref<number[]>([])
  const copyToBusy = ref(false)
  const copyToErr = ref('')
  const copyToProjects = ref<Array<{ id: number; name: string }>>([])
  const copyToPid = ref<number | null>(null)
  const copyToTargets = ref<CanvasListItem[]>([])
  const copyToTarget = ref<number | null>(null)
  const copyTargetsBusy = ref(false)

  /** 打开弹窗：选中快照入列；项目列表懒加载一次（失败可重开重试） */
  async function openCopyTo(): Promise<void> {
    if (canvasId.value == null || !selectedIds.value.length) return
    copyToIds.value = [...selectedIds.value]
    copyToErr.value = ''
    copyToTarget.value = null
    showCopyTo.value = true
    if (!copyToProjects.value.length) {
      try {
        const r = await projectApi.list()
        copyToProjects.value = r.items.map((p) => ({ id: p.id, name: p.name }))
      } catch (e) {
        copyToErr.value = e instanceof Error ? e.message : String(e)
        return
      }
    }
    if (copyToPid.value == null) copyToPid.value = projectId.value
    await loadCopyTargets()
  }

  /** 目标项目切换 → 拉目标画布列表（排除当前画布自身——同画布复制请用「复制」） */
  async function loadCopyTargets(): Promise<void> {
    const pid = copyToPid.value
    if (pid == null) return
    copyToTarget.value = null
    copyTargetsBusy.value = true
    copyToErr.value = ''
    try {
      const r = await creationApi.list(pid)
      copyToTargets.value = r.items.filter((c) => !(pid === projectId.value && c.id === canvasId.value))
    } catch (e) {
      copyToErr.value = e instanceof Error ? e.message : String(e)
      copyToTargets.value = []
    } finally {
      copyTargetsBusy.value = false
    }
  }

  /** 确认复制：POST nodes/copy-to → 摘要 toast（节点/资产/跳过/警告）→ 静默重拉当前画布 + 刷画布列表（目标画布计数） */
  async function doCopyTo(): Promise<void> {
    const cid = canvasId.value
    const tid = copyToTarget.value
    if (cid == null || tid == null || copyToBusy.value) return
    copyToBusy.value = true
    copyToErr.value = ''
    try {
      const r = await creationApi.copyTo(cid, { targetCanvasId: tid, ids: copyToIds.value })
      const target = copyToTargets.value.find((c) => c.id === tid)
      let msg = `已复制 ${r.nodes.length} 个节点到「${target?.name ?? `#${tid}`}」`
      if (r.assetsCopied > 0) msg += `（含资产拷贝 ${r.assetsCopied} 个）`
      if (r.skipped.length > 0) msg += `；跳过 ${r.skipped.length} 项（运行节点等不支持跨项目）`
      if (r.warnings.length > 0) msg += `；警告：${r.warnings[0]}${r.warnings.length > 1 ? ` 等 ${r.warnings.length} 条` : ''}`
      showCopyTo.value = false
      toast(msg)
      await loadDoc(true)
      void loadCanvases()
    } catch (e) {
      copyToErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      copyToBusy.value = false
    }
  }

  return {
    showCopyTo,
    copyToIds,
    copyToBusy,
    copyToErr,
    copyToProjects,
    copyToPid,
    copyToTargets,
    copyToTarget,
    copyTargetsBusy,
    openCopyTo,
    loadCopyTargets,
    doCopyTo,
  }
}
