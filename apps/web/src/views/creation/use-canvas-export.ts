/** [M28] 创作画布：CanvasExport；依赖显式注入，原函数体保持不变。 */
import { ref } from 'vue'
import { creationApi } from '../../lib/api'
import type { CanvasExportResult, TemplateValidation } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasCommands } from './use-canvas-commands'
import type { CanvasDocument } from './use-canvas-doc'

type Dependencies = Pick<CanvasState, 'canvasId' | 'toast' | 'boardRef'>
  & Pick<CanvasCommands, 'addNodesCommand'>
  & Pick<CanvasDocument, 'loadDoc'>

export function useCanvasExport(deps: Dependencies) {
  const { canvasId, toast, boardRef, addNodesCommand, loadDoc } = deps

  // ===== [M17] 导出 zip（打包为 archive 资产 → 下载复用资产文件端点） =====
  const exportBusy = ref(false)
  const showExport = ref(false)
  const exportResult = ref<CanvasExportResult | null>(null)

  async function onExportZip(): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    exportBusy.value = true
    try {
      exportResult.value = await creationApi.exportZip(cid)
      showExport.value = true
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      exportBusy.value = false
    }
  }

  // ===== 联动②：导出模板草案 v2 =====
  const showDraft = ref(false)
  const draftBusy = ref(false)
  const draftTryBusy = ref(false)
  const draftYaml = ref('')
  const draftValidation = ref<TemplateValidation | null>(null)
  const draftLossy = ref<string[]>([])

  async function openDraft(): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    draftBusy.value = true
    try {
      const r = await creationApi.templateDraft(cid)
      draftYaml.value = r.yaml
      draftValidation.value = r.validation
      draftLossy.value = r.lossy ?? []
      showDraft.value = true
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      draftBusy.value = false
    }
  }
  async function copyDraft(): Promise<void> {
    try {
      await navigator.clipboard.writeText(draftYaml.value)
      toast('YAML 已复制到剪贴板')
    } catch {
      toast('复制失败（剪贴板不可用，可手动全选复制）')
    }
  }

  /** [M18] 草案弹窗内「试跑」：建 queued run + 视口中心自动创建 run 节点 */
  async function tryRunFromDraft(): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    draftTryBusy.value = true
    try {
      const r = await creationApi.templateTry(cid)
      const at = boardRef.value?.centerWorld() ?? { x: 160, y: 120 }
      try {
        await addNodesCommand(cid, [{ kind: 'run', runId: r.runId, x: at.x, y: at.y }], '试跑新建运行节点')
        await loadDoc(true)
      } catch (e) {
        toast(`run 已建但节点创建失败：${e instanceof Error ? e.message : String(e)}`)
      }
      toast(`已试跑→ 模板「${r.templateKey}」· run #${r.runId}（queued）${r.lossy.length ? ` · ${r.lossy.length} 项降级` : ''}`)
      showDraft.value = false
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      draftTryBusy.value = false
    }
  }

  return {
    exportBusy,
    showExport,
    exportResult,
    onExportZip,
    showDraft,
    draftBusy,
    draftTryBusy,
    draftYaml,
    draftValidation,
    draftLossy,
    openDraft,
    copyDraft,
    tryRunFromDraft,
  }
}

export type CanvasExport = ReturnType<typeof useCanvasExport>
