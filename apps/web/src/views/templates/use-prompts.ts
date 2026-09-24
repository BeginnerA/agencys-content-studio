/** 提示词区：列表 / 编辑 / 新建删除；refreshMetas 由装配方注入（删除后刷新模板引用态）。 */
import { computed, ref } from 'vue'
import { promptApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import { msg } from './internals'
import type { PromptItem } from '../../lib/types'

export function usePrompts(deps: { refreshMetas: () => Promise<void> }) {
  const { refreshMetas } = deps

  // ===== 提示词区 =====
  const prompts = ref<PromptItem[]>([])
  const pLoading = ref(true)
  const pListErr = ref('')
  const pSelected = ref<string | null>(null)
  const pText = ref('')
  const pBaseline = ref('')
  const pSaving = ref(false)
  const pErr = ref('')

  const pDirty = computed(
    () => pSelected.value !== null && pText.value !== pBaseline.value,
  )

  /** [内置保护] 当前选中提示词是否系统内置（真源取服务端 prompts.builtin）：内置则只读、不可保存/删除 */
  const currentPromptBuiltin = computed(
    () => prompts.value.find((p) => p.name === pSelected.value)?.builtin === true,
  )

  async function refreshPrompts() {
    pLoading.value = true
    try {
      const r = await promptApi.list()
      prompts.value = r.items
      pListErr.value = ''
    } catch (e) {
      pListErr.value = msg(e)
    } finally {
      pLoading.value = false
    }
  }

  async function openPrompt(name: string) {
    if (pDirty.value) {
      const ok = await confirmDialog({
        title: '放弃未保存修改',
        message: '当前提示词修改尚未保存，确定放弃并切换？',
        confirmText: '放弃并切换',
      })
      if (!ok) return
    }
    pSelected.value = name
    pErr.value = ''
    try {
      const r = await promptApi.get(name)
      pText.value = r.content
      pBaseline.value = r.content
    } catch (e) {
      pErr.value = msg(e)
    }
  }

  async function savePrompt() {
    if (!pSelected.value || pSaving.value) return
    // [内置保护] 内置提示词不可保存（UI 已只读，此处防御性兼顶）
    if (currentPromptBuiltin.value) {
      pErr.value = '系统内置提示词不可修改，请新建自定义提示词并在模板中改引用'
      return
    }
    pSaving.value = true
    pErr.value = ''
    try {
      await promptApi.put(pSelected.value, pText.value)
      pBaseline.value = pText.value
      await refreshPrompts()
    } catch (e) {
      pErr.value = msg(e)
    } finally {
      pSaving.value = false
    }
  }

  async function removePrompt(name: string) {
    // [内置保护] 内置提示词不可删除（UI 已隐藏删除按钮，此处防御性兼顶）
    if (prompts.value.find((p) => p.name === name)?.builtin === true) {
      pErr.value = `提示词「${name}」是系统内置提示词，不可删除`
      return
    }
    const ok = await confirmDialog({
      title: '删除提示词',
      message: `删除提示词「${name}」？引用它的模板将出现「引用缺失」提示。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    pErr.value = ''
    try {
      await promptApi.remove(name)
      if (pSelected.value === name) {
        pSelected.value = null
        pText.value = ''
        pBaseline.value = ''
      }
      await refreshPrompts()
      await refreshMetas()
    } catch (e) {
      pErr.value = msg(e)
    }
  }

  const newPromptDlg = ref(false)
  const newPromptName = ref('')
  const newPromptErr = ref('')
  const newPromptCreating = ref(false)

  function openNewPrompt() {
    newPromptDlg.value = true
    newPromptName.value = ''
    newPromptErr.value = ''
  }

  async function doCreatePrompt() {
    const name = newPromptName.value.trim().replace(/\\/g, '/')
    if (!name) {
      newPromptErr.value =
        '请输入文件相对路径（如 cover-talking.md 或 sub/dir/name.md）'
      return
    }
    newPromptCreating.value = true
    try {
      await promptApi.put(name, '')
      newPromptDlg.value = false
      await refreshPrompts()
      await openPrompt(name)
    } catch (e) {
      newPromptErr.value = msg(e)
    } finally {
      newPromptCreating.value = false
    }
  }

  return {
    prompts,
    pLoading,
    pListErr,
    pSelected,
    pText,
    pBaseline,
    pSaving,
    pErr,
    pDirty,
    currentPromptBuiltin,
    refreshPrompts,
    openPrompt,
    savePrompt,
    removePrompt,
    newPromptDlg,
    newPromptName,
    newPromptErr,
    newPromptCreating,
    openNewPrompt,
    doCreatePrompt,
  }
}

export type PromptsApi = ReturnType<typeof usePrompts>
