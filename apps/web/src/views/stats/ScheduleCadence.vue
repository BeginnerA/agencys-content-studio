<script setup lang="ts">
/**
 * 排期发布节奏模板（Tier A，纯日期数学，零 LLM 零计费）
 * 以某条既有排产计划为「模板源」（克隆其 input_template / template_key），
 * 按日更 / 隔 N 日 / 每周指定星期展开为未来一串时间戳，先预览再批量建。
 * 不猜测：count/intervalDays/weekdays 越界 → 服务端 errors 原样回显；未来过滤由后端保证。
 */
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../../components/common/Icon.vue'
import ProvenanceBadge from '../../components/common/ProvenanceBadge.vue'
import { projectApi, scheduleApi } from '../../lib/api'
import type { Cadence, Project, Schedule } from '../../lib/types'

const projects = ref<Project[]>([])
const projectId = ref<number | ''>('')
const sources = ref<Schedule[]>([])
const sourceId = ref<number | ''>('')

const loading = ref(false)
const err = ref('')
const msg = ref('')

type Kind = 'daily' | 'interval' | 'weekly'
const kind = ref<Kind>('daily')
const intervalDays = ref(2)
const weekdays = ref<number[]>([1, 3, 5])
// 起始时间：本地 datetime-local 字符串
const startStr = ref('')
const count = ref(7)
const namePrefix = ref('')
const note = ref('')

const preview = ref<number[]>([])
const previewErrors = ref<string[]>([])
const previewing = ref(false)
const creating = ref(false)

const WEEKDAYS: Array<{ v: number; label: string }> = [
  { v: 1, label: '一' },
  { v: 2, label: '二' },
  { v: 3, label: '三' },
  { v: 4, label: '四' },
  { v: 5, label: '五' },
  { v: 6, label: '六' },
  { v: 0, label: '日' },
]

const source = computed(() => sources.value.find((s) => s.id === sourceId.value) ?? null)

function buildCadence(): Cadence {
  if (kind.value === 'interval') return { kind: 'interval', intervalDays: Number(intervalDays.value) }
  if (kind.value === 'weekly') return { kind: 'weekly', weekdays: [...weekdays.value] }
  return { kind: 'daily' }
}

function startAt(): number {
  return startStr.value ? new Date(startStr.value).getTime() : NaN
}

function fmtTs(ts: number): string {
  const d = new Date(ts)
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 周${wd}`
}

async function loadProjects() {
  try {
    const r = await projectApi.list()
    projects.value = r.items
    if (projectId.value === '' && r.items[0]) projectId.value = r.items[0].id
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

async function loadSources() {
  sources.value = []
  sourceId.value = ''
  if (projectId.value === '') return
  try {
    const r = await scheduleApi.list(`?project_id=${projectId.value}`)
    sources.value = r.items
    if (sources.value[0]) sourceId.value = sources.value[0].id
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

watch(projectId, () => void loadSources())

onMounted(() => void loadProjects())

async function doPreview() {
  err.value = ''
  msg.value = ''
  previewErrors.value = []
  preview.value = []
  previewing.value = true
  try {
    const r = await scheduleApi.cadencePreview({
      start_at: startAt(),
      count: Number(count.value),
      cadence: buildCadence(),
    })
    preview.value = r.timestamps
    previewErrors.value = r.errors
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewing.value = false
  }
}

async function doCreate() {
  if (projectId.value === '' || !source.value) {
    err.value = '请先选择项目与模板源计划'
    return
  }
  const ok = confirm(
    `将按节奏批量创建 ${preview.value.length} 条排产计划（克隆「${source.value.name}」的输入），确认继续？`,
  )
  if (!ok) return
  err.value = ''
  creating.value = true
  try {
    const r = await scheduleApi.cadenceCreate(projectId.value as number, {
      start_at: startAt(),
      count: Number(count.value),
      cadence: buildCadence(),
      input_template: (source.value.inputTemplate as Array<Record<string, unknown>>) ?? [],
      template_key: source.value.templateKey,
      name_prefix: namePrefix.value.trim() || source.value.name,
      note: note.value || undefined,
    })
    msg.value = `已创建 ${r.created.length} 条排产计划${r.skipped ? `（跳过 ${r.skipped} 条非未来时间）` : ''}`
    preview.value = []
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

function toggleWeekday(v: number) {
  const i = weekdays.value.indexOf(v)
  if (i >= 0) weekdays.value.splice(i, 1)
  else weekdays.value.push(v)
}
</script>

<template>
  <div class="cadence-panel panel">
    <div class="cp-header">
      <h3><Icon name="calendar" :size="15" /> 按节奏批量排期</h3>
      <span class="muted sm">克隆既有计划的输入，按日更 / 隔日 / 周更展开为未来一串计划（纯日期数学，零成本）</span>
    </div>

    <div class="cp-grid">
      <label>
        项目
        <select v-model="projectId">
          <option value="" disabled>请选择项目</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label>
        模板源计划
        <select v-model="sourceId" :disabled="projectId === ''">
          <option value="" disabled>{{ sources.length ? '请选择' : '该项目暂无计划可选' }}</option>
          <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <label>
        节奏类型
        <select v-model="kind">
          <option value="daily">每日</option>
          <option value="interval">隔 N 日</option>
          <option value="weekly">每周指定日</option>
        </select>
      </label>
      <label v-if="kind === 'interval'">
        间隔天数
        <input v-model.number="intervalDays" type="number" min="2" max="30" />
      </label>
      <label>
        起始时间
        <input v-model="startStr" type="datetime-local" />
      </label>
      <label>
        数量
        <input v-model.number="count" type="number" min="1" max="60" />
      </label>
      <label>
        名称前缀
        <input v-model="namePrefix" :placeholder="source ? source.name : '默认取模板源名称'" />
      </label>
    </div>

    <div v-if="kind === 'weekly'" class="cp-weekdays">
      <span class="muted sm">每周星期：</span>
      <button
        v-for="w in WEEKDAYS"
        :key="w.v"
        class="wd"
        :class="{ on: weekdays.includes(w.v) }"
        @click="toggleWeekday(w.v)"
      >
        {{ w.label }}
      </button>
    </div>

    <div class="cp-actions">
      <button class="btn sm" :disabled="previewing || !sourceId" @click="doPreview">
        {{ previewing ? '预览中…' : '预览日期' }}
      </button>
      <button
        class="btn sm primary"
        :disabled="creating || !preview.length"
        @click="doCreate"
      >
        {{ creating ? '创建中…' : `批量创建 ${preview.length} 条` }}
      </button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="msg" class="cp-msg ok">
      <ProvenanceBadge
        kind="auto"
        text="节奏模板展开"
        title="时间点由纯日期数学按所选节奏展开（零 LLM 零计费），入参继承模板源计划"
      />
      {{ msg }}
    </div>
    <div v-if="previewErrors.length" class="cp-msg bad">
      校验未通过：{{ previewErrors.join('；') }}
    </div>
    <div v-if="preview.length" class="cp-preview">
      <div class="muted sm">将创建以下 {{ preview.length }} 个时间点：</div>
      <ol>
        <li v-for="(ts, i) in preview" :key="i" class="mono">{{ fmtTs(ts) }}</li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.cadence-panel {
  margin-top: 16px;
  padding: 16px;
}
.cp-header {
  margin-bottom: 12px;
}
.cp-header h3 {
  margin: 0 0 4px;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sm {
  font-size: 12px;
}
.muted {
  color: var(--text-3);
}
.cp-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 10px;
}
.cp-grid label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--text-3);
}
.cp-grid input,
.cp-grid select {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  color: var(--text);
  font-size: 12px;
}
.cp-weekdays {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.wd {
  border: 1px solid var(--border);
  background: var(--code-bg);
  color: var(--text-2);
  border-radius: 6px;
  padding: 3px 9px;
  font-size: 12px;
  cursor: pointer;
}
.wd.on {
  background: var(--accent, #6366f1);
  color: #fff;
  border-color: transparent;
}
.cp-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.cp-msg {
  margin-top: 10px;
  font-size: 12px;
}
.cp-msg.ok {
  color: var(--ok, #16a34a);
}
.cp-msg.bad {
  color: var(--danger, #dc2626);
}
.cp-preview {
  margin-top: 10px;
}
.cp-preview ol {
  margin: 6px 0 0;
  padding-left: 22px;
  font-size: 12px;
  color: var(--text-2);
  max-height: 240px;
  overflow: auto;
}
.mono {
  font-family: var(--mono, monospace);
}
.err-text {
  margin-top: 10px;
  color: var(--danger, #dc2626);
  font-size: 12px;
}
</style>
