/** [M28] 模板区：列表 / 说明书切换 / YAML 编辑校验 / 新建副本删除；原函数体逐字保留。 */
import { computed, ref, watch } from 'vue'
import { templateApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import { msg, skeleton, withKey } from './internals'
import type { TemplateDetail, TemplateMeta, TemplateValidation } from '../../lib/types'

export function useTemplates() {
  // ===== 模板区状态 =====
  const metas = ref<TemplateMeta[]>([])
  const metasLoading = ref(true)
  const listErr = ref('')
  const selected = ref<string | null>(null)
  /** [说明书改造] 视图模式：guide=说明书视图（默认，普通使用者视角）；edit=YAML 高级编辑 */
  const mode = ref<'guide' | 'edit'>('guide')
  /** [说明书改造] 字段速查弹层 */
  const helpDlg = ref(false)
  const yamlText = ref('')
  const baseline = ref('')
  const detail = ref<TemplateDetail | null>(null)
  const validation = ref<TemplateValidation | null>(null)
  const validating = ref(false)
  const saving = ref(false)
  const loadErr = ref('')
  const actionErr = ref('')

  const dirty = computed(() => selected.value !== null && yamlText.value !== baseline.value)
  /** 实时解析结果：编辑中优先校验产物（实时结构），否则已保存版本；说明书视图固定显示已保存版本 */
  const liveTpl = computed<TemplateDetail | null>(() =>
    mode.value === 'edit' ? (validation.value?.template ?? detail.value) : detail.value,
  )

  async function refreshMetas(autoOpen = false) {
    metasLoading.value = true
    try {
      const r = await templateApi.list()
      metas.value = r.items
      listErr.value = ''
      if (autoOpen && !selected.value && metas.value.length) await openTemplate(metas.value[0]!.key)
    } catch (e) {
      listErr.value = msg(e)
    } finally {
      metasLoading.value = false
    }
  }

  let openSeq = 0
  async function openTemplate(key: string) {
    if (dirty.value) {
      const ok = await confirmDialog({
        title: '放弃未保存修改',
        message: '当前模板修改尚未保存，确定放弃并切换？',
        confirmText: '放弃并切换',
      })
      if (!ok) return
    }
    const seq = ++openSeq
    stopValidate()
    selected.value = key
    // [说明书改造] 切换模板默认回说明书视图
    mode.value = 'guide'
    loadErr.value = ''
    actionErr.value = ''
    validation.value = null
    try {
      const r = await templateApi.detail(key)
      if (seq !== openSeq) return
      detail.value = r.template
      yamlText.value = r.yaml
      baseline.value = r.yaml
    } catch (e) {
      if (seq !== openSeq) return
      detail.value = null
      loadErr.value = msg(e)
    }
  }

  // ===== 实时校验（防抖 800ms）=====
  let timer: number | null = null
  let valSeq = 0
  function stopValidate() {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  watch(yamlText, () => {
    stopValidate()
    if (!dirty.value) {
      validation.value = null
      validating.value = false
      return
    }
    timer = window.setTimeout(() => void doValidate(), 800)
  })

  async function doValidate() {
    const seq = ++valSeq
    validating.value = true
    try {
      const r = await templateApi.validate(yamlText.value, selected.value ?? undefined)
      if (seq === valSeq) validation.value = r
    } catch (e) {
      if (seq === valSeq) validation.value = { ok: false, errors: [msg(e)], warnings: [] }
    } finally {
      if (seq === valSeq) validating.value = false
    }
  }

  async function save() {
    if (!selected.value || saving.value) return
    saving.value = true
    actionErr.value = ''
    stopValidate()
    try {
      const r = await templateApi.update(selected.value, yamlText.value)
      baseline.value = yamlText.value
      detail.value = r.template
      validation.value = null
      await refreshMetas()
    } catch (e) {
      actionErr.value = msg(e)
    } finally {
      saving.value = false
    }
  }

  // ===== [说明书改造] 视图模式切换：不丢弃编辑内容，未保存徽标持续提示 =====
  function toEdit() {
    mode.value = 'edit'
  }

  function toGuide() {
    mode.value = 'guide'
  }

  // ===== 新建 / 另存为副本 / 删除 =====
  const newDlg = ref(false)
  const newKey = ref('')
  const newErr = ref('')
  const creating = ref(false)

  const copyDlg = ref(false)
  const copyKey = ref('')
  const copyErr = ref('')
  const copying = ref(false)


  function openNew() {
    newDlg.value = true
    newKey.value = ''
    newErr.value = ''
  }

  async function doCreate() {
    const key = newKey.value.trim()
    if (!/^[\w-]+$/.test(key)) {
      newErr.value = 'key 仅允许字母/数字/下划线/中划线'
      return
    }
    creating.value = true
    try {
      await templateApi.create(key, skeleton(key))
      newDlg.value = false
      await refreshMetas()
      await openTemplate(key)
      // [说明书改造] 新模板直接进入编辑（空骨架待填写）
      mode.value = 'edit'
    } catch (e) {
      newErr.value = msg(e)
    } finally {
      creating.value = false
    }
  }

  function openCopy() {
    if (!selected.value) return
    copyDlg.value = true
    copyKey.value = `${selected.value}-copy`
    copyErr.value = ''
  }

  async function doCopy() {
    const key = copyKey.value.trim()
    if (!/^[\w-]+$/.test(key)) {
      copyErr.value = 'key 仅允许字母/数字/下划线/中划线'
      return
    }
    copying.value = true
    try {
      await templateApi.create(key, withKey(yamlText.value, key))
      copyDlg.value = false
      await refreshMetas()
      await openTemplate(key)
      // [说明书改造] 新建副本同样直接进入编辑
      mode.value = 'edit'
    } catch (e) {
      copyErr.value = msg(e)
    } finally {
      copying.value = false
    }
  }

  async function removeTemplate(key: string, name: string) {
    const ok = await confirmDialog({
      title: '删除模板',
      message: `删除模板「${name}」（${key}）？\n文件将从 workspace/templates 移除，且不可撤销。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    actionErr.value = ''
    try {
      await templateApi.remove(key)
      if (selected.value === key) {
        selected.value = null
        detail.value = null
        yamlText.value = ''
        baseline.value = ''
        validation.value = null
      }
      await refreshMetas()
    } catch (e) {
      actionErr.value = msg(e)
    }
  }

  /** textarea 内 tab → 2 空格（spec：tab=2） */
  function onTab(e: KeyboardEvent) {
    const el = e.target as HTMLTextAreaElement
    const s = el.selectionStart
    const en = el.selectionEnd
    yamlText.value = yamlText.value.slice(0, s) + '  ' + yamlText.value.slice(en)
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = s + 2
    })
  }


  return {
    metas,
    metasLoading,
    listErr,
    selected,
    mode,
    helpDlg,
    yamlText,
    baseline,
    detail,
    validation,
    validating,
    saving,
    loadErr,
    actionErr,
    dirty,
    liveTpl,
    refreshMetas,
    openTemplate,
    stopValidate,
    doValidate,
    save,
    toEdit,
    toGuide,
    newDlg,
    newKey,
    newErr,
    creating,
    copyDlg,
    copyKey,
    copyErr,
    copying,
    openNew,
    doCreate,
    openCopy,
    doCopy,
    removeTemplate,
    onTab,
  }
}

export type TemplatesApi = ReturnType<typeof useTemplates>
