<script setup lang="ts">
/**
 * [M20] 排产日历视图（B1）
 * 月历形式展示排产计划，支持创建/取消/重置操作。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../../components/common/Icon.vue'
import DatePicker from '../../components/common/DatePicker.vue'
import { projectApi, scheduleApi, templateApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { Project, ScheduleCalendarItem, TemplateMeta } from '../../lib/types'
import { fmtTime } from '../../lib/format'

const router = useRouter()
const loading = ref(true)
const err = ref('')
const items = ref<ScheduleCalendarItem[]>([])
const projects = ref<Project[]>([])
const templates = ref<TemplateMeta[]>([])
const projectId = ref<number | ''>('')

// 日历状态
const viewDate = ref(new Date())
const showForm = ref(false)
const creating = ref(false)

// 新建表单
const formName = ref('')
const formTemplateKey = ref('')
const formScheduledAt = ref('') // YYYY-MM-DDTHH:mm（DatePicker withTime）
const formInputJson = ref('[{}]')
const formNote = ref('')

const STATUS_MAP: Record<string, { text: string; cls: string }> = {
  pending: { text: '待触发', cls: 's-pending' },
  triggered: { text: '已触发', cls: 's-triggered' },
  completed: { text: '已完成', cls: 's-completed' },
  cancelled: { text: '已取消', cls: 's-cancelled' },
  failed: { text: '失败', cls: 's-failed' },
}

// 日历计算
const calendarDays = computed(() => {
  const d = viewDate.value
  const year = d.getFullYear()
  const month = d.getMonth()
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  const startOffset = firstDay.getDay() // 0=Sun
  const totalDays = lastDay.getDate()
  const days: Array<{ date: Date; dayNum: number; inMonth: boolean; items: ScheduleCalendarItem[] }> = []

  // 前置空白
  for (let i = startOffset - 1; i >= 0; i--) {
    const date = new Date(year, month, -i)
    days.push({ date, dayNum: date.getDate(), inMonth: false, items: [] })
  }
  // 本月日
  for (let i = 1; i <= totalDays; i++) {
    const date = new Date(year, month, i)
    const dayItems = items.value.filter((it) => {
      const d2 = new Date(it.scheduledAt)
      return d2.getFullYear() === year && d2.getMonth() === month && d2.getDate() === i
    })
    days.push({ date, dayNum: i, inMonth: true, items: dayItems })
  }
  // 后置空白（补齐到 42 = 6 行）
  while (days.length < 42) {
    const date = new Date(year, month + 1, days.length - totalDays - startOffset + 1)
    days.push({ date, dayNum: date.getDate(), inMonth: false, items: [] })
  }
  return days
})

const monthLabel = computed(() => `${viewDate.value.getFullYear()}年${viewDate.value.getMonth() + 1}月`)

function prevMonth() {
  const d = new Date(viewDate.value)
  d.setMonth(d.getMonth() - 1)
  viewDate.value = d
}
function nextMonth() {
  const d = new Date(viewDate.value)
  d.setMonth(d.getMonth() + 1)
  viewDate.value = d
}
function goToday() {
  viewDate.value = new Date()
}

async function load() {
  loading.value = true
  err.value = ''
  try {
    const d = viewDate.value
    const from = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime()
    const to = new Date(d.getFullYear(), d.getMonth() + 2, 0).getTime()
    const qs: string[] = [`from=${from}`, `to=${to}`]
    if (projectId.value) qs.push(`project_id=${projectId.value}`)
    const res = await scheduleApi.calendar(`?${qs.join('&')}`)
    items.value = res.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadMeta() {
  try {
    const [p, t] = await Promise.all([projectApi.list(), templateApi.list()])
    projects.value = p.items
    templates.value = t.items
    if (t.items.length) formTemplateKey.value = t.items[0]!.key
  } catch { /* 静默 */ }
}

onMounted(() => {
  void loadMeta()
  void load()
})
watch([viewDate, projectId], () => void load())

function openForm() {
  formName.value = ''
  formScheduledAt.value = ''
  formInputJson.value = '[{}]'
  formNote.value = ''
  showForm.value = true
}

async function submitForm() {
  if (!projectId.value) { err.value = '请选择项目'; return }
  if (!formScheduledAt.value) { err.value = '请设置触发时间'; return }
  creating.value = true
  err.value = ''
  try {
    let inputTemplate: unknown
    try { inputTemplate = JSON.parse(formInputJson.value) } catch { err.value = '输入模板 JSON 格式错误'; return }
    await scheduleApi.create(projectId.value as number, {
      name: formName.value,
      template_key: formTemplateKey.value,
      scheduled_at: new Date(formScheduledAt.value).getTime(),
      input_template: inputTemplate,
      note: formNote.value || undefined,
    })
    showForm.value = false
    void load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

async function cancelItem(item: ScheduleCalendarItem) {
  const ok = await confirmDialog({ title: '取消计划', message: `取消「${item.name}」？`, confirmText: '取消计划', danger: true })
  if (!ok) return
  try { await scheduleApi.cancel(item.id); void load() } catch (e) { err.value = e instanceof Error ? e.message : String(e) }
}

async function resetItem(item: ScheduleCalendarItem) {
  try { await scheduleApi.reset(item.id); void load() } catch (e) { err.value = e instanceof Error ? e.message : String(e) }
}

function statusOf(s: string) { return STATUS_MAP[s] ?? { text: s, cls: '' } }
function tplName(key: string) { return templates.value.find((t) => t.key === key)?.name ?? key }
function projName(id: number) { return projects.value.find((p) => p.id === id)?.name ?? `#${id}` }
</script>

<template>
  <div class="sched-cal">
    <div class="cal-header">
      <div class="cal-nav">
        <button class="btn sm" @click="prevMonth"><Icon name="chevron-left" :size="12" /></button>
        <span class="cal-label">{{ monthLabel }}</span>
        <button class="btn sm" @click="nextMonth"><Icon name="chevron-right" :size="12" /></button>
        <button class="btn sm" @click="goToday">今天</button>
      </div>
      <div class="cal-filters">
        <select v-model="projectId" aria-label="按项目筛选">
          <option value="">全部项目</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <button class="btn primary sm" @click="openForm">
          <Icon name="plus" :size="12" /> 新建计划
        </button>
      </div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading && !items.length" class="empty">加载中…</div>

    <!-- 日历网格 -->
    <div class="cal-grid">
      <div v-for="wd in ['日', '一', '二', '三', '四', '五', '六']" :key="wd" class="cal-wd">{{ wd }}</div>
      <div
        v-for="(day, i) in calendarDays"
        :key="i"
        class="cal-cell"
        :class="{ 'out-month': !day.inMonth, 'is-today': day.date.toDateString() === new Date().toDateString() }"
      >
        <div class="cell-day">{{ day.dayNum }}</div>
        <div v-for="it in day.items" :key="it.id" class="cal-item" :class="statusOf(it.status).cls" @click="it.lastBatchId ? router.push(`/batches/${it.lastBatchId}`) : undefined">
          <span class="ci-name">{{ it.name }}</span>
          <span class="ci-proj">{{ projName(it.projectId) }}</span>
          <div class="ci-actions">
            <button v-if="it.status === 'pending'" class="ci-btn" title="取消" @click.stop="cancelItem(it)">×</button>
            <button v-if="['triggered','failed','cancelled'].includes(it.status)" class="ci-btn" title="重新触发" @click.stop="resetItem(it)">↻</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建弹窗 -->
    <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <div class="modal-box panel">
        <h3>新建排产计划</h3>
        <div class="form-grid">
          <label>计划名称 <input v-model="formName" placeholder="例：每日更新第5集" /></label>
          <label>项目
            <select v-model="projectId">
              <option value="">请选择</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <label>模板
            <select v-model="formTemplateKey">
              <option v-for="t in templates" :key="t.key" :value="t.key">{{ t.name }}</option>
            </select>
          </label>
          <label>触发时间
            <DatePicker v-model="formScheduledAt" placeholder="选择日期和时间" :with-time="true" />
          </label>
          <label>输入模板（JSON）
            <textarea v-model="formInputJson" rows="3" placeholder='[{"input":{"title":"..."}}]' />
          </label>
          <label>备注 <input v-model="formNote" placeholder="可选" /></label>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="showForm = false">取消</button>
          <button class="btn primary" :disabled="creating" @click="submitForm">{{ creating ? '创建中…' : '创建' }}</button>
        </div>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="!loading && !items.length" class="empty">
      <Icon name="calendar" :size="24" />
      <p>暂无排产计划</p>
      <button class="btn primary sm" @click="openForm">创建第一个计划</button>
    </div>
  </div>
</template>

<style scoped>
.cal-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.cal-nav { display: flex; align-items: center; gap: 6px; }
.cal-label { font-weight: 600; font-size: 15px; min-width: 100px; text-align: center; }
.cal-filters { display: flex; gap: 8px; margin-left: auto; align-items: center; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; background: var(--border); border-radius: 8px; overflow: hidden; }
.cal-wd { background: var(--chip-bg); padding: 6px 8px; font-size: 12px; font-weight: 600; text-align: center; color: var(--text-3); }
.cal-cell { background: var(--bg); min-height: 80px; padding: 4px; display: flex; flex-direction: column; gap: 2px; }
.cal-cell.out-month { opacity: 0.35; }
.cal-cell.is-today { background: var(--chip-bg); }
.cell-day { font-size: 11px; font-weight: 600; color: var(--text-3); padding: 2px 4px; }
.cal-item { display: flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; font-size: 11px; cursor: pointer; background: var(--chip-bg); border-left: 3px solid var(--text-3); }
.cal-item:hover { background: var(--hover); }
.cal-item.s-pending { border-left-color: var(--accent); }
.cal-item.s-triggered { border-left-color: var(--ok); }
.cal-item.s-completed { border-left-color: var(--ok); opacity: 0.7; }
.cal-item.s-failed { border-left-color: var(--bad); }
.cal-item.s-cancelled { border-left-color: var(--text-3); opacity: 0.5; }
.ci-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-proj { color: var(--text-3); font-size: 10px; }
.ci-actions { display: flex; gap: 2px; }
.ci-btn { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--text-3); padding: 0 2px; line-height: 1; }
.ci-btn:hover { color: var(--text); }
.modal-mask { position: fixed; inset: 0; background: rgb(0 0 0 / 50%); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-box { width: 480px; max-width: 90vw; padding: 20px; }
.modal-box h3 { margin: 0 0 16px; font-size: 16px; }
.form-grid { display: grid; gap: 10px; }
.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-3); }
.form-grid input, .form-grid select, .form-grid textarea { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; color: var(--text); font-size: 13px; }
.form-grid :deep(.dp) { margin-top: 2px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>
