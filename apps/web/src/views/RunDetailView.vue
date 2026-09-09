<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GateDialog from '../components/GateDialog.vue'
import TaskPanel from '../components/TaskPanel.vue'
import Icon from '../components/Icon.vue'
import { assetApi, runApi, templateApi } from '../lib/api'
import type { RunDetail, RunStep, TemplateDetail } from '../lib/types'
import { fmtMs, fmtTime, runStatus, skipReasonText, stepStatus } from '../lib/format'
import { getSocket, useStudio } from '../lib/socket'
import type { StudioEventMap } from '../lib/socket'

const route = useRoute()
const router = useRouter()
const runId = Number(route.params.id)

const detail = ref<RunDetail | null>(null)
const tpl = ref<TemplateDetail | null>(null)
const err = ref('')
const busy = ref(false)

// 闸门状态
const gateStep = ref<RunStep | null>(null)
const gateMessage = ref('')
const gateText = ref('')
const gateTextName = ref('')

// 日志
const showLog = ref(false)
const logText = ref('')
const autoScroll = ref(true)
const logEl = ref<HTMLElement | null>(null)

const run = computed(() => detail.value?.run ?? null)
const steps = computed(() => detail.value?.steps ?? [])
const canCancel = computed(() => {
  const s = run.value?.status
  return s === 'queued' || s === 'running' || s === 'waiting_input'
})
const canResume = computed(() => {
  const s = run.value?.status
  return s === 'failed' || s === 'cancelled'
})
const hasTasks = computed(() => steps.value.some((s) => s.actionKey === 'ai_image'))
const active = computed(() => run.value?.status === 'running' || run.value?.status === 'queued')

// [M2] 当前闸门的免审按钮文案（模板 gate.skip_label）；模板不可达时隐藏
const gateSkipLabel = computed(() => {
  const step = gateStep.value
  if (!step) return undefined
  const def = tpl.value?.steps.find((d) => d.key === step.stepKey)
  return def?.gate?.skip_label
})

// [M2] 并行执行提示：同一时刻 ≥2 步骤处于执行/待审状态（引擎就绪集并发 ≤2）
const parallelHint = computed(() => {
  const actives = steps.value.filter((s) => s.status === 'running' || s.status === 'waiting_input')
  return actives.length >= 2 ? `并行执行中：${actives.length} 步并发推进` : ''
})

/** 模板 gate message 的 {input.x} 插值（离线回填场景） */
function interpolate(msg: string, input: Record<string, unknown>): string {
  return msg.replace(/\{input\.([\w-]+)\}/g, (_, k: string) => String(input[k] ?? ''))
}

async function loadGate() {
  gateStep.value = null
  gateText.value = ''
  const step = steps.value.find((s) => s.status === 'waiting_input')
  if (!step || !run.value) return
  // 消息优先取模板定义（服务端事件已解析；此处静态插值）
  const stepDef = tpl.value?.steps.find((d) => d.key === step.stepKey)
  gateMessage.value = interpolate(stepDef?.gate?.message ?? `请审阅「${step.title}」的产物`, run.value.input)
  const assetId = (step.output?.asset_ids as number[] | undefined)?.[0]
  if (!assetId) return
  gateStep.value = step
  try {
    const a = await assetApi.detail(assetId)
    if (a.kind === 'text' || a.purpose === 'script' || a.purpose === 'storyboard') {
      gateTextName.value = a.name
      const res = await fetch(a.urls.file)
      if (res.ok) gateText.value = await res.text()
    }
  } catch {
    // 产物不可读则只显示操作按钮
  }
}

async function loadDetail() {
  err.value = ''
  try {
    const d = await runApi.detail(runId)
    detail.value = d
    // 模板详情仅按需拉取（含 gate 消息定义）
    if (!tpl.value || tpl.value.key !== d.run.templateKey) {
      try {
        const t = await templateApi.detail(d.run.templateKey)
        tpl.value = t.template
      } catch {
        tpl.value = null
      }
    }
    void loadGate()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

let logTimer: number | undefined
async function loadLog() {
  try {
    const res = await runApi.log(runId, 400)
    logText.value = res.log
    if (autoScroll.value && logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  } catch {
    // 日志缺失不打扰
  }
}

function toggleLog() {
  showLog.value = !showLog.value
  if (showLog.value) void loadLog()
}

async function decide(
  action: 'approve' | 'reject' | 'skip' | 'abort',
  payload: { note?: string; textOverride?: string },
) {
  if (!gateStep.value) return
  busy.value = true
  err.value = ''
  try {
    const body: Record<string, unknown> = { step_key: gateStep.value.stepKey, decision: action }
    if (payload.note) body.note = payload.note
    if (payload.textOverride) body.text_override = payload.textOverride
    const res = await runApi.gate(runId, body)
    detail.value = res
    void loadGate()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function cancelRun() {
  if (!confirm(`确认取消 run #${runId}？当前步骤产物会保留。`)) return
  busy.value = true
  try {
    await runApi.cancel(runId)
    await loadDetail()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function resumeRun() {
  if (!confirm('从断点续跑：将新建一个 run，跳过已成功步骤继续执行。')) return
  busy.value = true
  try {
    const res = await runApi.resume(runId)
    router.push(`/runs/${res.run.id}`)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

// ===== socket 实时 =====
const studio = useStudio(runId)
function onStep(p: StudioEventMap['run.step']) {
  if (p.run_id !== runId) return
  const local = steps.value.find((s) => s.id === p.step.id)
  if (local && p.step.status) {
    local.status = p.step.status
    local.attempts = p.step.attempts ?? local.attempts
    if (p.step.status === 'waiting_input' || p.step.status === 'succeeded' || p.step.status === 'skipped') {
      void loadDetail()
    }
  }
}
function onTerminal(p: StudioEventMap['run.completed' | 'run.failed']) {
  if ((p as { run_id: number }).run_id === runId) void loadDetail()
}
function onGate(p: StudioEventMap['run.gate']) {
  if (p.run_id === runId) void loadDetail()
}
function onLog(p: StudioEventMap['step.log']) {
  if (showLog.value) void loadLog()
}

onMounted(() => {
  void loadDetail()
  void loadLog()
  studio.join()
  studio.on('run.step', onStep)
  studio.on('run.completed', onTerminal)
  studio.on('run.failed', onTerminal)
  studio.on('run.gate', onGate)
  studio.on('step.log', onLog)
  logTimer = window.setInterval(() => {
    if (showLog.value && active.value) void loadLog()
  }, 2500)
})

onBeforeUnmount(() => {
  studio.leave()
  if (logTimer) window.clearInterval(logTimer)
})

// ===== 步骤块渲染辅助 =====
function nodeClass(s: RunStep): string {
  if (s.status === 'running') return 'running'
  if (s.status === 'waiting_input') return 'gate'
  if (s.status === 'failed') return 'failed'
  if (s.status === 'succeeded') return 'ok'
  if (s.status === 'skipped') return 'skip'
  if (s.status === 'cancelled') return 'cancel'
  return 'idle'
}

/** [M2] 跳过原因（output.skipped.reason）；succeeded 且带 skipped 记录 = 免审放行 */
function skipInfo(s: RunStep): { text: string; userSkip: boolean } | null {
  const reason = (s.output as { skipped?: { reason?: string } } | null)?.skipped?.reason
  if (s.status === 'skipped') return { text: skipReasonText(reason ?? 'skipped'), userSkip: false }
  if (s.status === 'succeeded' && reason === 'user_skip') return { text: '免审放行', userSkip: true }
  return null
}

function assetIds(s: RunStep): number[] {
  const out = s.output?.asset_ids
  return Array.isArray(out) ? (out as number[]) : []
}

function inputPretty(s: RunStep): string {
  if (!s.input) return '—'
  return JSON.stringify(s.input, null, 1)
}

function outputPretty(s: RunStep): string {
  if (!s.output) return '—'
  return JSON.stringify(s.output, null, 1)
}

const ACTION_ICON: Record<string, string> = {
  manual_ingest: 'inbox',
  ai_text: 'pencil',
  ai_image: 'photo',
  ffmpeg_merge: 'film',
  ai_video: 'video',
}

function iconOf(key: string): string {
  return ACTION_ICON[key] ?? 'doc'
}
</script>

<template>
  <div>
    <div class="page-h">
      <RouterLink :to="`/projects/${run?.projectId ?? ''}`" class="back">
        <Icon name="arrow-left" :size="14" /> 项目
      </RouterLink>
      <h1>Run #{{ runId }}</h1>
      <span v-if="run" class="badge" :class="run.status">{{ runStatus(run.status).text }}</span>
      <span v-if="run" class="sub mono">{{ run.templateKey }}</span>
      <span v-if="run?.summary?.durationMs" class="sub muted">{{ fmtMs(run.summary.durationMs) }}</span>
      <div style="margin-left: auto; display: flex; gap: 8px">
        <button v-if="canCancel" class="btn danger" :disabled="busy" @click="cancelRun">取消运行</button>
        <button v-if="canResume" class="btn primary" :disabled="busy" @click="resumeRun">
          <Icon name="refresh" :size="14" /> 断点续跑
        </button>
        <button class="btn" @click="toggleLog">
          <Icon :name="showLog ? 'x' : 'doc'" :size="14" /> {{ showLog ? '隐藏日志' : '运行日志' }}
        </button>
      </div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="!run" class="empty">{{ err || '加载中…' }}</div>

    <template v-if="run">
      <div v-if="run.error" class="errbox">{{ run.error }}</div>

      <!-- 闸门审阅 -->
      <div v-if="parallelHint && !gateStep" class="phint">
        <Icon name="refresh" :size="13" /> {{ parallelHint }}（引擎并发上限 2）
      </div>
      <GateDialog
        v-if="gateStep"
        :step-title="gateStep.title"
        :message="gateMessage"
        :artifact-text="gateText || undefined"
        :artifact-name="gateTextName"
        :skip-label="gateSkipLabel"
        :busy="busy"
        @decided="decide"
      />

      <div class="cols">
        <!-- 步骤时间线 -->
        <div class="timeline panel">
          <div v-for="s in steps" :key="s.id" class="st" :class="[nodeClass(s), { dim: s.status === 'pending' }]">
            <div class="rail">
              <div class="dot"><Icon :name="iconOf(s.actionKey)" :size="14" /></div>
              <div class="line" />
            </div>
            <div class="card">
              <div class="head">
                <span class="tt">{{ s.title }}</span>
                <span class="badge" :class="s.status === 'waiting_input' ? 'waiting_input' : s.status">
                  {{ stepStatus(s.status).text }}
                </span>
                <span v-if="skipInfo(s)" class="badge skip" :class="{ ghost: !skipInfo(s)?.userSkip }">
                  {{ skipInfo(s)?.text }}
                </span>
                <span class="muted mono" style="font-size: 11px">{{ s.actionKey }}</span>
              </div>
              <div v-if="skipInfo(s)?.userSkip" class="skipnote muted">免审放行：产物已保留，下游正常执行</div>
              <div v-if="s.error" class="serr mono">{{ s.error }}</div>
              <div class="meta muted">
                第 {{ s.seq + 1 }} 步 · 尝试 {{ s.attempts }}
                <template v-if="s.startedAt"> · {{ fmtTime(s.startedAt) }}</template>
                <template v-if="s.completedAt"> → {{ fmtTime(s.completedAt) }}</template>
              </div>

              <details v-if="s.output && assetIds(s).length" class="prods">
                <summary>产物（{{ assetIds(s).length }} 项）</summary>
                <div class="links">
                  <a
                    v-for="aid in assetIds(s)"
                    :key="aid"
                    class="prod"
                    :href="`/api/v1/assets/${aid}/file`"
                    target="_blank"
                  >
                    资产 #{{ aid }}
                  </a>
                </div>
              </details>
              <details class="raw">
                <summary>输入 / 输出快照</summary>
                <pre>{{ inputPretty(s) }}</pre>
                <pre v-if="s.output">{{ outputPretty(s) }}</pre>
              </details>
            </div>
          </div>

          <div v-if="!steps.length" class="empty">该 run 尚无步骤记录</div>
        </div>

        <!-- 右栏：日志 + 任务 -->
        <div class="right">
          <div v-if="showLog" class="panel logbox">
            <div class="lhead">
              <span class="lt">运行日志</span>
              <label class="autosc"><input v-model="autoScroll" type="checkbox" /> 自动滚动</label>
            </div>
            <pre ref="logEl" class="log mono">{{ logText || '（暂无日志）' }}</pre>
          </div>

          <TaskPanel v-if="hasTasks" :run-id="runId" :active="active" class="tpanel-wrap" @changed="loadDetail()" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.errbox {
  background: var(--bad-weak);
  color: var(--bad);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  margin-bottom: 14px;
  word-break: break-all;
}

/* [M2] 并行执行提示条 */
.phint {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--run);
  background: var(--run-weak);
  border: 1px solid rgb(129 140 248 / 22%);
  border-radius: 8px;
  padding: 6px 12px;
  margin-bottom: 12px;
}

.skipnote {
  font-size: 11.5px;
  margin-top: 6px;
}

/* [M2] 并行执行提示条 */
.phint {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--run);
  background: var(--run-weak);
  border: 1px solid rgb(129 140 248 / 22%);
  border-radius: 8px;
  padding: 6px 12px;
  margin-bottom: 12px;
}

.skipnote {
  font-size: 11.5px;
  margin-top: 6px;
}

.cols {
  display: grid;
  grid-template-columns: 1fr 400px;
  gap: 16px;
  align-items: start;
}

.right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: sticky;
  top: 16px;
}

.timeline {
  padding: 10px 14px;
}

.st {
  display: flex;
  gap: 12px;
}

.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 28px;
}

.dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgb(148 163 184 / 13%);
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  z-index: 1;
  border: 1px solid rgb(148 163 184 / 14%);
}

.line {
  width: 2px;
  flex: 1;
  min-height: 12px;
  background: var(--border);
}

.st:last-child .line {
  display: none;
}

.st.ok .dot {
  background: var(--ok-weak);
  color: var(--ok);
  border-color: rgb(34 197 94 / 25%);
}

/* [M2] skipped：中性灰，虚线标记「无产物经过」 */
.st.skip .dot {
  background: rgb(148 163 184 / 7%);
  color: var(--text-3);
  border-color: rgb(148 163 184 / 18%);
  border-style: dashed;
}

.st.skip .line {
  background-image: linear-gradient(90deg, transparent 30%, var(--border) 31%, var(--border) 69%, transparent 70%);
  background-size: 6px 2px;
  background-repeat: repeat-x;
  background-position: 0 60%;
}

.st.running .dot {
  background: var(--run-weak);
  color: var(--run);
  border-color: rgb(129 140 248 / 30%);
  animation: pulse 1.2s infinite;
}

.st.failed .dot {
  background: var(--bad-weak);
  color: var(--bad);
  border-color: rgb(248 113 113 / 26%);
}

.st.gate .dot {
  background: var(--warn-weak);
  color: var(--warn);
  border-color: rgb(245 158 11 / 28%);
  box-shadow: 0 0 0 4px rgb(245 158 11 / 10%);
}

.st.cancel .dot {
  background: rgb(148 163 184 / 9%);
  color: var(--text-3);
  border-color: rgb(148 163 184 / 16%);
}

@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}

.card {
  flex: 1;
  padding: 10px 4px 14px;
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tt {
  font-weight: 600;
  font-size: 14px;
}

.serr {
  margin-top: 8px;
  background: var(--bad-weak);
  color: var(--bad);
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.meta {
  font-size: 11.5px;
  margin-top: 4px;
}

.prods {
  margin-top: 6px;
  font-size: 12.5px;
}

.prods summary,
.raw summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 12px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 5px;
}

.prod {
  font-size: 11.5px;
  background: var(--accent-weak);
  padding: 2px 9px;
  border-radius: 999px;
}

.raw {
  margin-top: 5px;
}

.raw pre {
  background: var(--code-bg);
  color: #b9c7dc;
  font-size: 11px;
  border-radius: 8px;
  border: 1px solid var(--border);
  padding: 8px 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 4px 0 0;
}

.dim {
  opacity: 0.55;
}

.logbox {
  padding: 10px 14px;
}

.lhead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.lt {
  font-weight: 600;
  font-size: 13px;
}

.autosc {
  font-size: 11.5px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 4px;
}

.log {
  margin: 0;
  max-height: 420px;
  overflow-y: auto;
  background: var(--code-bg);
  color: #b9c7dc;
  font-size: 11px;
  line-height: 1.6;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-all;
}

.tpanel-wrap {
  max-height: 360px;
  overflow-y: auto;
}

@media (max-width: 1080px) {
  .cols {
    grid-template-columns: 1fr;
  }

  .right {
    position: static;
  }
}
</style>
