/**
 * 排产日历「新建表单」状态机（自 ScheduleCalendar.vue 拆出，行为零变更）
 * 持有新建计划表单的全部状态（showForm/formXxx/formInputs）与提交逻辑；
 * 展示、日历网格与数据加载留父视图，经返回值接线（v-model 透传 ScheduleFormModal）。
 * projectId/err 为父子共享真源，由父级传入 Ref；创建成功后经 onCreated 回调触发父级刷新。
 */
import { ref, watch, type Ref } from 'vue'
import { scheduleApi, templateApi } from '../../lib/api'
import type { TemplateDetail, TemplateInputDef } from '../../lib/types'

export function useScheduleForm(opts: {
  projectId: Ref<number | ''>
  err: Ref<string>
  onCreated: () => void
}) {
  const { projectId, err, onCreated } = opts

  // 新建表单
  const showForm = ref(false)
  const creating = ref(false)
  const formName = ref('')
  const formTemplateKey = ref('')
  const formScheduledAt = ref('') // YYYY-MM-DDTHH:mm（DatePicker withTime）
  const formNote = ref('')
  // 模板输入动态表单
  const formTemplateDetail = ref<TemplateDetail | null>(null)
  const formInputs = ref<Array<Record<string, unknown>>>([{}]) // 多组输入，每组对应一次 run
  const formInputsLoading = ref(false)

  // 模板切换时加载详情（含 inputs 定义）
  watch(formTemplateKey, async (key) => {
    if (!key) {
      formTemplateDetail.value = null
      return
    }
    formInputsLoading.value = true
    try {
      const res = await templateApi.detail(key)
      formTemplateDetail.value = res.template
      // 重置为默认值（一组，按模板 defaults 预填）
      const defaults: Record<string, unknown> = {}
      for (const def of res.template.inputs) {
        if (def.default !== undefined) defaults[def.key] = def.default
      }
      formInputs.value = [defaults]
    } catch {
      formTemplateDetail.value = null
    } finally {
      formInputsLoading.value = false
    }
  })

  /** 加载模板详情 + 预填默认值 */
  async function loadTemplateDetail(key: string) {
    formInputsLoading.value = true
    try {
      const res = await templateApi.detail(key)
      formTemplateDetail.value = res.template
      const defaults: Record<string, unknown> = {}
      for (const def of res.template.inputs) {
        if (def.default !== undefined) defaults[def.key] = def.default
      }
      formInputs.value = [defaults]
    } catch {
      formTemplateDetail.value = null
    } finally {
      formInputsLoading.value = false
    }
  }

  function openForm() {
    formName.value = ''
    formScheduledAt.value = ''
    formNote.value = ''
    formTemplateDetail.value = null // 清除旧模板，避免闪烁
    formInputs.value = [{}]
    showForm.value = true
    // 重新加载当前模板详情 + 默认值
    if (formTemplateKey.value) void loadTemplateDetail(formTemplateKey.value)
  }

  async function submitForm() {
    if (!projectId.value) {
      err.value = '请选择项目'
      return
    }
    if (!formScheduledAt.value) {
      err.value = '请设置触发时间'
      return
    }
    if (formInputsLoading.value) {
      err.value = '模板定义加载中，请稍候'
      return
    }
    if (!formTemplateDetail?.value) {
      err.value = '模板定义未加载'
      return
    }
    // 序列化表单输入
    const inputTemplate = formInputs.value
      .map((row) => serializeInputRow(row, formTemplateDetail.value?.inputs ?? []))
      .filter((row) => Object.keys(row).length > 0)
    if (!inputTemplate.length) {
      err.value = '至少填写一组输入'
      return
    }
    creating.value = true
    err.value = ''
    try {
      await scheduleApi.create(projectId.value as number, {
        name: formName.value,
        template_key: formTemplateKey.value,
        scheduled_at: new Date(formScheduledAt.value).getTime(),
        input_template: inputTemplate,
        note: formNote.value || undefined,
      })
      showForm.value = false
      onCreated()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    } finally {
      creating.value = false
    }
  }

  function addInputGroup() {
    // 新增一组（复制上一组的值作为起点，或空对象）
    const last = formInputs.value[formInputs.value.length - 1] ?? {}
    formInputs.value.push({ ...last })
  }
  function removeInputGroup(idx: number) {
    if (formInputs.value.length <= 1) return
    formInputs.value.splice(idx, 1)
  }

  return {
    showForm,
    creating,
    formName,
    formTemplateKey,
    formScheduledAt,
    formNote,
    formTemplateDetail,
    formInputs,
    formInputsLoading,
    openForm,
    submitForm,
    loadTemplateDetail,
    addInputGroup,
    removeInputGroup,
  }
}

/** 将表单行序列化为后端期望的输入对象（类型转换 + 过滤空值） */
function serializeInputRow(
  row: Record<string, unknown>,
  defs: TemplateInputDef[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of defs) {
    const v = row[def.key]
    if (v === undefined || v === null || v === '') continue
    if (def.kind === 'int') {
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isInteger(n)) out[def.key] = n
    } else if (def.kind === 'bool') {
      out[def.key] = v === true || v === 'true'
    } else if (def.kind === 'files') {
      // files: 逗号分隔的 id 字符串 → 数字数组
      const ids =
        typeof v === 'string'
          ? v
              .split(',')
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isInteger(n) && n > 0)
          : Array.isArray(v)
            ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0)
            : []
      if (ids.length) out[def.key] = ids
    } else {
      out[def.key] = typeof v === 'string' ? v : String(v)
    }
  }
  return out
}
