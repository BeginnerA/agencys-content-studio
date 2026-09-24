/**
 * 设计态编排（画布内编辑落盘通道）——views/canvas/index.vue 拆分（纯重构，逻辑逐字搬移）
 * 轻提示 toast + Board 连线/删边 + 落盘预检 + 导出草案（edit-draft）+ 保存为新模板（edit-save）。
 * 依赖注入：edit（本地草稿层）、tab/tplKey（当前画布目标）、onSaved（保存成功后刷新目录）。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { Ref } from 'vue'
import { templateApi } from '../../lib/api'
import type { TemplateEdits, TemplateValidation } from '../../lib/types'
import type { CanvasEditState } from './use-canvas-edit'

export function useCanvasDesign(opts: {
  edit: CanvasEditState
  tab: Ref<'run' | 'template' | 'overview'>
  tplKey: Ref<string | null>
  onSaved: () => Promise<void>
}) {
  const { edit, tab, tplKey, onSaved } = opts

  // ===== 轻提示（连线拒绝原因 / 落盘结果；2.8s 自动消退）=====
  const toastMsg = ref('')
  let toastTimer: number | null = null
  function showToast(msg: string): void {
    toastMsg.value = msg
    if (toastTimer != null) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toastTimer = null
      toastMsg.value = ''
    }, 2800)
  }
  onBeforeUnmount(() => {
    if (toastTimer != null) window.clearTimeout(toastTimer)
  })

  // ===== 设计态编排（拖拽连线 + 落盘通道：草案预览 / 保存为新模板）=====
  const boardEdit = computed(
    () => tab.value === 'template' && edit.editMode.value,
  )

  /** Board 拖拽连线：编辑层校验（仅前→后；已存在静默忽略），拒绝原因 toast */
  function onConnect(from: string, to: string): void {
    if (!boardEdit.value) return
    const reason = edit.connect(from, to)
    if (reason) showToast(reason)
  }

  /** Board Del 删除调度边：when 隐含引用拒绝，其余物化移除 */
  function onDelEdge(from: string, to: string): void {
    if (!boardEdit.value) return
    const reason = edit.delEdge(from, to)
    if (reason) showToast(reason)
  }

  /** 落盘前本地预检（空标题等）→ 不通过时 toast 并返回 null */
  function editsOrNotify(): TemplateEdits | null {
    const errs = edit.validateLocal()
    if (errs.length) {
      showToast(errs[0]!)
      return null
    }
    const edits = edit.buildEdits()
    if (!edits) {
      showToast('没有可保存的修改')
      return null
    }
    return edits
  }

  // ---- 导出草案（edit-draft：不落盘，仅受控 edits 应用的 YAML 预览）----
  const showDraft = ref(false)
  const draftBusy = ref(false)
  const draftYaml = ref('')
  const draftValidation = ref<TemplateValidation | null>(null)

  async function openDraftModal(): Promise<void> {
    const key = tplKey.value
    if (!key) return
    const edits = editsOrNotify()
    if (!edits) return
    draftBusy.value = true
    try {
      const res = await templateApi.editDraft(key, edits)
      draftYaml.value = res.yaml
      draftValidation.value = res.validation
      showDraft.value = true
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      draftBusy.value = false
    }
  }

  async function copyDraftYaml(): Promise<void> {
    try {
      await navigator.clipboard.writeText(draftYaml.value)
      showToast('YAML 已复制到剪贴板')
    } catch {
      showToast('复制失败（剪贴板不可用，可手动全选复制）')
    }
  }

  // ---- 保存为新模板（edit-save：落新文件，原模板零触碰）----
  const showSave = ref(false)
  const saveBusy = ref(false)
  const saveKey = ref('')
  const saveErr = ref('')

  function openSaveModal(): void {
    const key = tplKey.value
    if (!key) return
    if (!editsOrNotify()) return
    saveKey.value = `${key}-edit`
    saveErr.value = ''
    showSave.value = true
  }

  /** 草案 Modal → 保存 Modal（不重复预检） */
  function draftToSave(): void {
    showDraft.value = false
    openSaveModal()
  }

  async function doSave(): Promise<void> {
    const key = tplKey.value
    if (!key || saveBusy.value || !saveKey.value.trim()) return
    const edits = edit.buildEdits()
    if (!edits) {
      showSave.value = false
      return
    }
    saveBusy.value = true
    saveErr.value = ''
    try {
      const res = await templateApi.editSave(
        key,
        edits,
        saveKey.value.trim() || undefined,
      )
      showSave.value = false
      showToast(`已保存为新模板「${res.templateKey}」（原模板文件零改动）`)
      edit.exit()
      await onSaved()
    } catch (e) {
      saveErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      saveBusy.value = false
    }
  }

  return {
    toastMsg,
    boardEdit,
    onConnect,
    onDelEdge,
    showDraft,
    draftBusy,
    draftYaml,
    draftValidation,
    openDraftModal,
    copyDraftYaml,
    showSave,
    saveBusy,
    saveKey,
    saveErr,
    openSaveModal,
    draftToSave,
    doSave,
  }
}
