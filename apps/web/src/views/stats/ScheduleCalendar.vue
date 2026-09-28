<script setup lang="ts">
/**
 * 排产日历视图（B1）
 * 月历形式展示排产计划，支持创建/取消/恢复/重置/删除操作。
 * ---- 新建弹窗拆至 ScheduleFormModal.vue（行为零变更）----
 * ---- 新建表单状态机与提交逻辑拆至 use-schedule-form.ts（行为零变更）----
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../../components/common/Icon.vue'
import ScheduleFormModal from './ScheduleFormModal.vue'
import { useScheduleForm } from './use-schedule-form'
import { projectApi, scheduleApi, templateApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import { filterSelectable } from '../../lib/scene'
import type {
  Project,
  ScheduleCalendarItem,
  TemplateMeta,
} from '../../lib/types'
import { fmtTime } from '../../lib/format'

const router = useRouter()
const route = useRoute()
const loading = ref(true)
const err = ref('')
const items = ref<ScheduleCalendarItem[]>([])
const projects = ref<Project[]>([])
const templates = ref<TemplateMeta[]>([])
const projectId = ref<number | ''>('')

// 日历状态
const viewDate = ref(new Date())

// 新建表单状态机（showForm/formXxx/提交逻辑）拆至 use-schedule-form.ts
const {
  showForm,
  creating,
  formName,
  formTemplateKey,
  formScheduledAt,
  formNote,
  formTemplateDetail,
  formInputs,
  formInputsLoading,
  assets,
  publications,
  onAssetsAppended,
  openForm,
  submitForm,
  loadTemplateDetail,
  addInputGroup,
  removeInputGroup,
} = useScheduleForm({ projectId, err, onCreated: () => void load() })

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
  const days: Array<{
    date: Date
    dayNum: number
    inMonth: boolean
    items: ScheduleCalendarItem[]
  }> = []

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
      return (
        d2.getFullYear() === year &&
        d2.getMonth() === month &&
        d2.getDate() === i
      )
    })
    days.push({ date, dayNum: i, inMonth: true, items: dayItems })
  }
  // 后置空白（补齐到 42 = 6 行）
  while (days.length < 42) {
    const date = new Date(
      year,
      month + 1,
      days.length - totalDays - startOffset + 1,
    )
    days.push({ date, dayNum: date.getDate(), inMonth: false, items: [] })
  }
  return days
})

const monthLabel = computed(
  () => `${viewDate.value.getFullYear()}年${viewDate.value.getMonth() + 1}月`,
)

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
    // 存全量供 tplName() 反查展示；预选默认取首个可选（排除 conversationOnly）
    templates.value = t.items
    const first = filterSelectable(t.items)[0]
    if (first) {
      formTemplateKey.value = first.key
      // 显式加载首个模板详情（watch 不再 immediate，避免空跑 + 重复请求）
      await loadTemplateDetail(first.key)
    }
  } catch {
    /* 静默 */
  }
}

onMounted(() => {
  void loadMeta()
  void load()
})
watch([viewDate, projectId], () => void load())

// ?new=1 深链接（命令面板「新建排产计划」直达）；消费后清 query（保留 tab 等其余键）
watch(
  () => route.query.new,
  (v) => {
    if (v !== '1') return
    openForm()
    const rest = { ...route.query }
    delete rest.new
    void router.replace({ query: rest })
  },
  { immediate: true },
)

async function cancelItem(item: ScheduleCalendarItem) {
  const ok = await confirmDialog({
    title: '取消计划',
    message: `取消「${item.name}」？`,
    confirmText: '取消计划',
    danger: true,
  })
  if (!ok) return
  try {
    await scheduleApi.cancel(item.id)
    void load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

async function resetItem(item: ScheduleCalendarItem) {
  try {
    await scheduleApi.reset(item.id)
    void load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

async function deleteItem(item: ScheduleCalendarItem) {
  const ok = await confirmDialog({
    title: '删除计划',
    message: `确定删除「${item.name}」？删除后不可恢复。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await scheduleApi.remove(item.id)
    void load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

function statusOf(s: string) {
  return STATUS_MAP[s] ?? { text: s, cls: '' }
}
function tplName(key: string) {
  return templates.value.find((t) => t.key === key)?.name ?? key
}
function projName(id: number) {
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`
}

// [重设计] 当前月计划状态统计（仅读 items，不触后端），驱动顶部 KPI 条
interface MonthStats {
  total: number
  pending: number
  triggered: number
  completed: number
  failed: number
  cancelled: number
}
const monthStats = computed<MonthStats>(() => {
  const d = viewDate.value
  const year = d.getFullYear()
  const month = d.getMonth()
  const c: MonthStats = {
    total: 0,
    pending: 0,
    triggered: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const it of items.value) {
    const dt = new Date(it.scheduledAt)
    if (dt.getFullYear() !== year || dt.getMonth() !== month) continue
    c.total++
    if (it.status === 'pending') c.pending++
    else if (it.status === 'triggered') c.triggered++
    else if (it.status === 'completed') c.completed++
    else if (it.status === 'failed') c.failed++
    else if (it.status === 'cancelled') c.cancelled++
  }
  return c
})
</script>

<template>
  <div class="sched-cal">
    <!-- [重设计] 顶部 KPI 概览条（当前月） -->
    <div class="skpis">
      <div class="skpi panel">
        <div class="sk-v">{{ monthStats.total }}</div>
        <div class="sk-l">本月计划</div>
      </div>
      <div class="skpi panel sk-pending">
        <div class="sk-v">{{ monthStats.pending }}</div>
        <div class="sk-l">待触发</div>
      </div>
      <div class="skpi panel sk-run">
        <div class="sk-v">{{ monthStats.triggered }}</div>
        <div class="sk-l">进行中</div>
      </div>
      <div class="skpi panel sk-ok">
        <div class="sk-v">{{ monthStats.completed }}</div>
        <div class="sk-l">已完成</div>
      </div>
      <div
        class="skpi panel"
        :class="{ 'sk-bad': monthStats.failed + monthStats.cancelled > 0 }"
      >
        <div class="sk-v">{{ monthStats.failed + monthStats.cancelled }}</div>
        <div class="sk-l">异常 / 取消</div>
      </div>
    </div>

    <!-- 日历卡片 -->
    <div class="cal-card panel">
      <div class="cal-header">
        <div class="cal-nav">
          <button class="btn sm" @click="prevMonth">
            <Icon name="chevron-left" :size="12" />
          </button>
          <span class="cal-label">{{ monthLabel }}</span>
          <button class="btn sm" @click="nextMonth">
            <Icon name="chevron-right" :size="12" />
          </button>
          <button class="btn sm" @click="goToday">今天</button>
        </div>
        <div class="cal-filters">
          <select v-model="projectId" aria-label="按项目筛选">
            <option value="">全部项目</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">
              {{ p.name }}
            </option>
          </select>
          <button class="btn primary sm" @click="openForm">
            <Icon name="plus" :size="12" /> 新建计划
          </button>
        </div>
      </div>

      <!-- 状态图例 -->
      <div class="cal-legend">
        <span class="lg"><i class="dot s-pending" />待触发</span>
        <span class="lg"><i class="dot s-triggered" />进行中</span>
        <span class="lg"><i class="dot s-completed" />已完成</span>
        <span class="lg"><i class="dot s-failed" />失败</span>
        <span class="lg"><i class="dot s-cancelled" />已取消</span>
      </div>

      <div v-if="err" class="err-text">{{ err }}</div>
      <div v-if="loading && !items.length" class="empty">加载中…</div>

      <!-- 日历网格 -->
      <div v-if="items.length" class="cal-grid">
        <div
          v-for="wd in ['日', '一', '二', '三', '四', '五', '六']"
          :key="wd"
          class="cal-wd"
        >
          {{ wd }}
        </div>
        <div
          v-for="(day, i) in calendarDays"
          :key="i"
          class="cal-cell"
          :class="{
            'out-month': !day.inMonth,
            'is-today': day.date.toDateString() === new Date().toDateString(),
          }"
        >
          <div class="cell-day">{{ day.dayNum }}</div>
          <div
            v-for="it in day.items"
            :key="it.id"
            class="cal-item"
            :class="statusOf(it.status).cls"
            @click="
              it.lastBatchId
                ? router.push(`/batches/${it.lastBatchId}`)
                : undefined
            "
          >
            <span class="ci-name">{{ it.name }}</span>
            <span class="ci-proj">{{ projName(it.projectId) }}</span>
            <div class="ci-actions">
              <button
                v-if="it.status === 'pending'"
                class="ci-btn"
                title="取消"
                @click.stop="cancelItem(it)"
              >
                ×
              </button>
              <button
                v-if="['triggered', 'failed', 'cancelled'].includes(it.status)"
                class="ci-btn"
                title="重新触发"
                @click.stop="resetItem(it)"
              >
                ↻
              </button>
              <button
                v-if="['triggered', 'failed', 'cancelled'].includes(it.status)"
                class="ci-btn ci-btn-del"
                title="删除"
                @click.stop="deleteItem(it)"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 空态 -->
      <div v-else-if="!loading" class="cal-empty">
        <div class="ce-ic"><Icon name="calendar" :size="22" /></div>
        <p>暂无排产计划</p>
        <button class="btn primary sm" @click="openForm">
          <Icon name="plus" :size="12" /> 创建第一个计划
        </button>
      </div>
    </div>

    <!-- 新建弹窗（拆至 ScheduleFormModal.vue；表单状态真源在 use-schedule-form.ts，经父级 v-model 透传） -->
    <ScheduleFormModal
      v-if="showForm"
      v-model:project-id="projectId"
      v-model:form-name="formName"
      v-model:form-template-key="formTemplateKey"
      v-model:form-scheduled-at="formScheduledAt"
      v-model:form-note="formNote"
      v-model:form-inputs="formInputs"
      :projects="projects"
      :templates="templates"
      :form-template-detail="formTemplateDetail"
      :form-inputs-loading="formInputsLoading"
      :assets="assets"
      :publications="publications"
      :err="err"
      :creating="creating"
      @close="showForm = false"
      @submit="submitForm"
      @add-group="addInputGroup"
      @remove-group="removeInputGroup"
      @assets-appended="onAssetsAppended"
    />
  </div>
</template>

<style scoped>
.sched-cal {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ── KPI 概览条 ── */
.skpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.skpi {
  padding: 12px 16px;
  position: relative;
  overflow: hidden;
}
.skpi::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--text-3);
}
.skpi.sk-pending::before {
  background: var(--accent);
}
.skpi.sk-run::before {
  background: var(--run);
}
.skpi.sk-ok::before {
  background: var(--ok);
}
.skpi.sk-bad::before {
  background: var(--bad);
}
.sk-v {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 0.3px;
}
.sk-l {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 2px;
}

/* ── 日历卡片 ── */
.cal-card {
  padding: 14px 16px 16px;
}
.cal-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.cal-nav {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cal-label {
  font-weight: 600;
  font-size: 15px;
  min-width: 100px;
  text-align: center;
}
.cal-filters {
  display: flex;
  gap: 8px;
  margin-left: auto;
  align-items: center;
}

/* ── 状态图例 ── */
.cal-legend {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  font-size: 11.5px;
  color: var(--text-3);
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--text-3);
}
.dot.s-pending {
  background: var(--accent);
}
.dot.s-triggered {
  background: var(--run);
}
.dot.s-completed {
  background: var(--ok);
}
.dot.s-failed {
  background: var(--bad);
}
.dot.s-cancelled {
  background: var(--text-3);
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.cal-wd {
  background: var(--panel-2);
  padding: 7px 8px;
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  color: var(--text-2);
}
.cal-cell {
  background: var(--bg);
  min-height: 92px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cal-cell.out-month {
  opacity: 0.32;
}
.cal-cell.is-today {
  background: var(--accent-weak);
}
.cal-cell.is-today .cell-day {
  color: var(--accent-h);
}
.cell-day {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  padding: 2px 4px;
}
.cal-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 11px;
  cursor: pointer;
  background: var(--chip-bg);
  border-left: 3px solid var(--text-3);
  transition: background 0.15s;
}
.cal-item:hover {
  background: var(--hover);
}
.cal-item.s-pending {
  border-left-color: var(--accent);
}
.cal-item.s-triggered {
  border-left-color: var(--run);
}
.cal-item.s-completed {
  border-left-color: var(--ok);
  opacity: 0.72;
}
.cal-item.s-failed {
  border-left-color: var(--bad);
}
.cal-item.s-cancelled {
  border-left-color: var(--text-3);
  opacity: 0.5;
}
.ci-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ci-proj {
  color: var(--text-3);
  font-size: 10px;
}
.ci-actions {
  display: flex;
  gap: 2px;
}
.ci-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-3);
  padding: 0 2px;
  line-height: 1;
}
.ci-btn:hover {
  color: var(--text);
}
.ci-btn-del:hover {
  color: var(--bad);
}

/* ── 空态 / 加载 ── */
.err-text {
  color: var(--bad);
  font-size: 12px;
  margin-bottom: 8px;
}
.empty {
  text-align: center;
  padding: 24px 16px;
  color: var(--text-3);
  font-size: 13px;
}
.cal-empty {
  text-align: center;
  padding: 44px 16px;
  color: var(--text-3);
}
.ce-ic {
  width: 52px;
  height: 52px;
  margin: 0 auto 10px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background: var(--accent-weak);
  color: var(--accent-h);
}
.cal-empty p {
  margin: 0 0 14px;
  font-size: 13px;
}
</style>
