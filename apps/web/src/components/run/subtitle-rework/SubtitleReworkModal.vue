<script setup lang="ts">
// 字幕精确返修弹窗：结构化 cue 列表（原文只读 + 新文字 + 起止 HH:MM:SS.mmm）、
// 勾选批量平移（逐行改数值）、服务端预览确认两步流。能力不支持时显示真实原因，
// 不伪造可编辑态；预览/影响/风险全部展示后端返回值，前端零推算（规格 §3.1/§9）。
// 四入口共用本组件与 use-subtitle-rework（P11 接线），此处不接入任何入口。
import { computed, ref, toRef } from 'vue'
import Modal from '../../common/Modal.vue'
import { msToClock, parseClock, useSubtitleRework, type SubtitleRow } from './use-subtitle-rework'

const props = defineProps<{ runId: number; stepKey?: string }>()
const emit = defineEmits<{ close: []; applied: [requestId: string] }>()

const {
  model, loading, submitting, applying, loadError, previewError, rowErrors,
  rows, selected, preview, supported, capability, changes, dirty, changeCount,
  load, onRowEdited, shiftSelected, toggleSelect, toggleSelectAll, allSelected,
  requestPreview, applyConfirmed, guardClose,
} = useSubtitleRework(toRef(props, 'runId'), computed(() => props.stepKey), {
  onApplied: (id) => emit('applied', id),
})

/** 批量平移输入（毫秒，可为负） */
const shiftMs = ref('0')
const clockInvalid = ref<Set<string>>(new Set())
/** 时钟输入草稿：仅存用户正在编辑的字段；提交（失焦解析成功）即删除回退行值 */
const clockDraft = ref<Record<string, string>>({})
const appliedNote = ref('')

async function onClose() {
  if (!(await guardClose())) return
  emit('close')
}

async function onShift() {
  const n = Number(shiftMs.value)
  if (!Number.isFinite(n) || n === 0) return
  if (selected.value.size === 0) {
    previewError.value = '请先勾选需要平移的字幕行'
    return
  }
  shiftSelected(n)
  previewError.value = ''
  appliedNote.value = ''
}

function clockShown(r: SubtitleRow, field: 'startMs' | 'endMs'): string {
  const key = r.cueId + ':' + field
  return clockDraft.value[key] ?? msToClock(r[field])
}

function onClockInput(r: SubtitleRow, field: 'startMs' | 'endMs', v: string) {
  clockDraft.value[r.cueId + ':' + field] = v
}

/** 失焦解析草稿 → 整数毫秒回写行；非法保留原文并就近标错 */
function onClockBlur(r: SubtitleRow, field: 'startMs' | 'endMs') {
  const key = r.cueId + ':' + field
  const draft = clockDraft.value[key]
  delete clockDraft.value[key]
  if (draft === undefined) return
  const parsed = parseClock(draft)
  if (parsed === null) {
    const next = new Set(clockInvalid.value)
    next.add(key)
    clockInvalid.value = next
    return
  }
  const next = new Set(clockInvalid.value)
  next.delete(key)
  clockInvalid.value = next
  if (r[field] !== parsed) {
    r[field] = parsed
    onRowEdited()
  }
}

function clockInvalidFor(r: SubtitleRow, field: 'startMs' | 'endMs'): boolean {
  return clockInvalid.value.has(r.cueId + ':' + field)
}

/** 重载/重置后清空全部草稿与标错（行编辑不走此处，不会误清输入中内容） */
function resetClockInputs(): void {
  clockDraft.value = {}
  clockInvalid.value = new Set()
}

async function onApply() {
  const ok = await applyConfirmed()
  if (ok) {
    resetClockInputs()
    appliedNote.value = '已确认：新版本已登记，本地续跑已入队'
  }
}

function rowErrorFor(cueId: string): string {
  const errs = rowErrors.value.get(cueId)
  return errs?.length ? errs.map((e) => e.message).join('；') : ''
}

function fieldLabel(field: string): string {
  return field === 'text' ? '文字' : field === 'startMs' ? '起点' : '终点'
}
function diffValue(field: string, v: string | number): string {
  return field === 'text' ? String(v) : `${v} ms（${msToClock(Number(v))}）`
}

const staleBanner = computed(() => {
  const edit = model.value?.current_edit
  if (edit?.stale) return '当前人工修订已过期（依赖发生变化），将按最新基准重新计算，请核对后再确认'
  if (model.value?.output.pending_recompose) return '已有修订尚未进入成片，确认后自动续跑合成'
  return ''
})

const reviewGateOpen = computed(() => {
  const rv = model.value?.review
  return rv?.gate_required === true && rv.decision == null
})

const versions = computed(() => model.value?.versions ?? [])

load()
</script>

<template>
  <Modal title="字幕精确返修" :width="860" @close="onClose">
    <div v-if="loading" class="rw-state">加载中…</div>
    <div v-else-if="loadError" class="rw-state">
      <div class="rw-bad">{{ loadError }}</div>
      <button class="btn" @click="load()">重试</button>
    </div>
    <div v-else-if="!supported" class="rw-state" role="alert">
      <div class="rw-bad">{{ capability?.message || '当前运行不支持字幕精确返修' }}</div>
      <div class="rw-hint">原因码：{{ capability?.code }}。返修只在合成完成且依赖可复验时开放，未伪造可编辑状态。</div>
      <button class="btn" @click="load()">重新检查</button>
    </div>
    <div v-else class="rw-body">
      <p v-if="staleBanner" class="rw-banner">{{ staleBanner }}</p>
      <p v-if="reviewGateOpen" class="rw-banner">该运行有复核门未决策，成片交付前需在运行详情中完成复核。</p>

      <div class="rw-toolbar">
        <label class="rw-check">
          <input type="checkbox" :checked="allSelected()" @change="toggleSelectAll()" />
          全选
        </label>
        <span class="rw-count">已选 {{ selected.size }} / {{ rows.length }} 条，修改 {{ changeCount }} 项</span>
        <span class="rw-shift">
          <label for="rw-shift-ms">平移(ms)</label>
          <input id="rw-shift-ms" v-model="shiftMs" type="number" step="1" class="rw-input rw-shift-input" />
          <button class="btn" :disabled="submitting || applying" @click="onShift">平移选中行</button>
        </span>
      </div>

      <div class="rw-list" aria-label="字幕列表">
        <div class="rw-row rw-head-row">
          <span></span>
          <span>原文（只读）</span>
          <span>新文字</span>
          <span>起点</span>
          <span>终点</span>
        </div>
        <div
          v-for="r in rows"
          :key="r.cueId"
          class="rw-row"
          :class="{ 'rw-row-error': !!rowErrorFor(r.cueId) }"
        >
          <input
            type="checkbox"
            class="rw-check-box"
            :checked="selected.has(r.cueId)"
            :aria-label="'选择字幕 ' + r.cueId"
            @change="toggleSelect(r.cueId)"
          />
          <div class="rw-orig" :title="r.originalText">{{ r.originalText }}</div>
          <input
            v-model="r.text"
            type="text"
            class="rw-input"
            :class="{ 'rw-input-invalid': !!rowErrorFor(r.cueId) }"
            :aria-label="'新文字 ' + r.cueId"
            @input="onRowEdited()"
          />
          <input
            :value="clockShown(r, 'startMs')"
            type="text"
            inputmode="numeric"
            class="rw-input rw-clock"
            :class="{ 'rw-input-invalid': clockInvalidFor(r, 'startMs') || !!rowErrorFor(r.cueId) }"
            :aria-label="'起点 ' + r.cueId"
            @input="onClockInput(r, 'startMs', ($event.target as HTMLInputElement).value)"
            @blur="onClockBlur(r, 'startMs')"
          />
          <input
            :value="clockShown(r, 'endMs')"
            type="text"
            inputmode="numeric"
            class="rw-input rw-clock"
            :class="{ 'rw-input-invalid': clockInvalidFor(r, 'endMs') || !!rowErrorFor(r.cueId) }"
            :aria-label="'终点 ' + r.cueId"
            @input="onClockInput(r, 'endMs', ($event.target as HTMLInputElement).value)"
            @blur="onClockBlur(r, 'endMs')"
          />
          <div v-if="rowErrorFor(r.cueId)" class="rw-row-error-msg" role="alert">{{ rowErrorFor(r.cueId) }}</div>
        </div>
      </div>

      <div class="rw-actions">
        <button class="btn btn-primary" :disabled="!dirty || submitting || applying" @click="requestPreview()">
          {{ submitting ? '预览请求中…' : '预览变更（' + changeCount + '）' }}
        </button>
      </div>

      <div v-if="previewError" class="rw-bad rw-live" role="alert">{{ previewError }}</div>
      <p v-if="appliedNote && !preview" class="rw-ok" role="status">{{ appliedNote }}</p>

      <section v-if="preview" class="rw-preview" aria-label="变更预览">
        <h4 class="rw-h4">变更确认</h4>
        <ul class="rw-diffs">
          <li v-for="(d, i) in preview.diffs" :key="i">
            <b>{{ d.cueId }} · {{ fieldLabel(d.field) }}</b>
            <span class="rw-diff-before">{{ diffValue(d.field, d.before) }}</span>
            →
            <span class="rw-diff-after">{{ diffValue(d.field, d.after) }}</span>
          </li>
        </ul>
        <ul class="rw-impact">
          <li>仅本地字幕修订：0 次模型调用，不重跑生成步骤</li>
          <li v-if="preview.impact.resetSteps.length">重置步骤：{{ preview.impact.resetSteps.join('、') }}</li>
          <li v-if="preview.impact.keepNotes.length">保留：{{ preview.impact.keepNotes.join('、') }}</li>
          <li>{{ preview.impact.subtitleBurn ? '成片将烧录新字幕' : '当前配置不烧录字幕：交付含独立字幕文件' }}</li>
          <li>确认后需重新复核</li>
        </ul>
        <ul v-if="preview.risks.length" class="rw-risks">
          <li v-for="(risk, i) in preview.risks" :key="i">风险：{{ risk }}</li>
        </ul>
        <button
          class="btn btn-primary"
          :disabled="applying || submitting"
          @click="onApply"
        >
          {{ applying ? '确认提交中…' : '确认并应用' }}
        </button>
      </section>

      <details v-if="versions.length" class="rw-versions">
        <summary>字幕版本历史（{{ versions.length }}）</summary>
        <ul>
          <li v-for="v in versions" :key="v.version_id">
            <span v-if="v.is_current" class="rw-cur">当前</span>
            r{{ v.revision }} · {{ v.source }}{{ v.label ? ' · ' + v.label : '' }} ·
            <a :href="v.download_url" target="_blank" rel="noopener">下载</a>
            <span class="rw-hint">· {{ v.change_summary }}</span>
          </li>
        </ul>
      </details>
    </div>

    <template #footer>
      <button class="btn" @click="onClose">关闭</button>
    </template>
  </Modal>
</template>

<style scoped>
.rw-state {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 0;
  font-size: 13px;
}

.rw-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rw-bad {
  color: var(--bad);
  font-size: 13px;
}

.rw-ok {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  font-size: 13px;
}

.rw-hint {
  color: var(--text-3);
  font-size: 12px;
}

.rw-banner {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--text-3);
  font-size: 12px;
}

.rw-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-3);
}

.rw-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}

.rw-shift {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.rw-shift-input {
  width: 90px;
}

.rw-count {
  min-width: 120px;
}

.rw-list {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.rw-row {
  display: grid;
  grid-template-columns: 28px 1fr 1.2fr 118px 118px;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.rw-row:last-child {
  border-bottom: none;
}

.rw-head-row {
  background: var(--panel-2);
  color: var(--text-3);
  font-size: 12px;
}

.rw-row-error {
  background: color-mix(in srgb, var(--bad) 6%, transparent);
}

.rw-row-error-msg {
  grid-column: 1 / -1;
  color: var(--bad);
  font-size: 12px;
}

.rw-orig {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-3);
}

.rw-input {
  width: 100%;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font-size: 13px;
}

.rw-clock {
  font-variant-numeric: tabular-nums;
}

.rw-input-invalid {
  border-color: var(--bad);
}

.rw-actions {
  display: flex;
  justify-content: flex-end;
}

.rw-live {
  padding: 8px 10px;
  border: 1px solid var(--bad);
  border-radius: 8px;
}

.rw-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  font-size: 13px;
}

.rw-h4 {
  margin: 0;
  font-size: 13px;
}

.rw-diffs,
.rw-impact,
.rw-risks {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.rw-diff-before {
  text-decoration: line-through;
  color: var(--text-3);
  margin: 0 6px;
}

.rw-diff-after {
  color: var(--bad);
  font-weight: 600;
}

.rw-risks li {
  color: var(--bad);
}

.rw-versions {
  font-size: 12px;
  color: var(--text-3);
}

.rw-versions ul {
  margin: 6px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rw-cur {
  font-weight: 600;
}

/* 移动端：表格行卡片化，控件保持可点（规格 §3.1 验收项） */
@media (max-width: 720px) {
  .rw-row {
    grid-template-columns: 28px 1fr;
    grid-auto-rows: auto;
  }

  .rw-head-row {
    display: none;
  }

  .rw-orig {
    white-space: normal;
  }

  .rw-shift {
    margin-left: 0;
    width: 100%;
  }
}
</style>
