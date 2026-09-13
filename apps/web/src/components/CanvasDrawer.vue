<script setup lang="ts">
/**
 * [M15] 节点抽屉（spec §2.4）
 * - run 态：操作（闸门三决策 / 单步重跑 RerunModal / 重新合成 / 任务行内 retry·cancel）+ 输入 + 产物 + 日志
 * - template 态：设计态信息（gate / 依赖 / 条件 / 批量 / 产物用途 / 引用清单；无运行字段与操作）
 * - node.key / status / assetIds 变化重载各分区；操作后 emit refresh 由父级全量重拉（REST 对账）
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { Asset, GenTask, RerunResult, RunCanvasNode, RunStep, TemplateCanvasNode } from '../lib/types'
import { assetApi, runApi, shotApi, taskApi } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import { fmtMs, fmtTime, KIND_TEXT, purposeText, skipReasonText, stepStatus, taskStatus } from '../lib/format'
import AssetPreviewer from './AssetPreviewer.vue'
import CanvasTargetModal from './CanvasTargetModal.vue'
import GateDialog from './GateDialog.vue'
import Icon from './Icon.vue'
import RerunModal from './RerunModal.vue'

type DrawerSel =
  | { mode: 'run'; node: RunCanvasNode }
  | { mode: 'template'; node: TemplateCanvasNode }

const props = defineProps<{ runId: number | null; sel: DrawerSel; log: string; projectId: number | null }>()
const emit = defineEmits<{ close: []; refresh: []; 'open-canvas': [canvasId: number] }>()

/** run / template 两态视图（互斥非空） */
const rn = computed<RunCanvasNode | null>(() => (props.sel.mode === 'run' ? props.sel.node : null))
const tn = computed<TemplateCanvasNode | null>(() => (props.sel.mode === 'template' ? props.sel.node : null))

const notice = ref('')
const opErr = ref('')

// ===== ① 闸门（waiting_input 时内嵌 GateDialog，产物文本可审阅修改）=====
const gateBusy = ref(false)
const gateErr = ref('')
const gateText = ref('')
const gateTextName = ref('')

const gateVisible = computed(() => {
  const n = rn.value
  return !!n && n.status === 'waiting_input' && !!n.gate && !!n.actions.gate && (n.actions.gate.approve || n.actions.gate.reject)
})
const gateSkipLabel = computed(() => {
  const n = rn.value
  return n && n.actions.gate?.skip ? (n.gate?.skipLabel ?? undefined) : undefined
})

async function loadGateArtifact(): Promise<void> {
  gateText.value = ''
  gateTextName.value = ''
  const n = rn.value
  if (!n || !n.gate || n.status !== 'waiting_input') return
  const assetId = n.assetIds[0]
  if (!assetId) return
  try {
    const { asset: a } = await assetApi.detail(assetId)
    if (a.kind === 'text' || a.purpose === 'script' || a.purpose === 'storyboard') {
      gateTextName.value = a.name
      const res = await fetch(a.urls.file)
      if (res.ok) gateText.value = await res.text()
    }
  } catch {
    // 产物不可读则只显示操作按钮
  }
}

async function onGateDecided(
  action: 'approve' | 'reject' | 'skip' | 'abort',
  payload: { note?: string; textOverride?: string },
): Promise<void> {
  const n = rn.value
  if (!n || props.runId == null) return
  gateBusy.value = true
  gateErr.value = ''
  try {
    const body: Record<string, unknown> = { step_key: n.key, decision: action }
    if (payload.note) body.note = payload.note
    if (payload.textOverride) body.text_override = payload.textOverride
    await runApi.gate(props.runId, body)
    notice.value = '闸门决策已提交，正在对账…'
    emit('refresh')
  } catch (e) {
    gateErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    gateBusy.value = false
  }
}

// ===== ② 单步重跑 / 重新合成 =====
const showRerun = ref(false)
const recomposeBusy = ref(false)

/** node → RunStep（RerunModal 按 step.id 过滤任务计数） */
const rerunStep = computed<RunStep | null>(() => {
  const n = rn.value
  if (!n || n.stepId == null) return null
  return {
    id: n.stepId,
    seq: n.seq,
    stepKey: n.key,
    actionKey: n.action,
    title: n.title,
    status: n.status,
    attempts: n.attempts,
    input: n.input && typeof n.input === 'object' && !Array.isArray(n.input) ? (n.input as Record<string, unknown>) : null,
    output: null,
    error: n.error,
    startedAt: n.startedAt,
    completedAt: n.completedAt,
  }
})

function onRerunDone(res: RerunResult): void {
  showRerun.value = false
  notice.value = res.note || '已提交单步重跑'
  emit('refresh')
}

async function doRecompose(): Promise<void> {
  const n = rn.value
  if (!n || props.runId == null) return
  const ok = await confirmDialog({
    title: '重新合成',
    message: `将重置「${n.title}」的合成结果并重新执行（本地 ffmpeg 合成，零计费；镜头选择保留）。`,
    confirmText: '重新合成',
  })
  if (!ok) return
  recomposeBusy.value = true
  opErr.value = ''
  try {
    const res = await shotApi.recompose(props.runId, n.key)
    notice.value = res.note || '已提交重新合成'
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    recomposeBusy.value = false
  }
}

// ===== ③ 子任务列表（run_id 拉取 → 按 stepId 前端过滤）=====
const tasks = ref<GenTask[]>([])
const tasksLoading = ref(false)
const taskBusy = ref<number | null>(null)
const taskErr = ref('')

async function loadTasks(): Promise<void> {
  tasks.value = []
  taskErr.value = ''
  const n = rn.value
  if (!n || props.runId == null || n.stepId == null) return
  tasksLoading.value = true
  try {
    const r = await taskApi.list(`?run_id=${props.runId}`)
    tasks.value = r.items.filter((t) => t.stepId === n.stepId)
  } catch (e) {
    taskErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    tasksLoading.value = false
  }
}

async function retryTask(t: GenTask): Promise<void> {
  taskBusy.value = t.id
  taskErr.value = ''
  try {
    await taskApi.retry(t.id)
    notice.value = `任务 #${t.id} 已重新入队`
    await loadTasks()
    emit('refresh')
  } catch (e) {
    taskErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    taskBusy.value = null
  }
}

async function cancelTask(t: GenTask): Promise<void> {
  const ok = await confirmDialog({
    title: '取消任务',
    message: `确认取消任务 #${t.id}？该任务尚未完成，取消后可在重跑时重新执行。`,
    confirmText: '取消任务',
    danger: true,
  })
  if (!ok) return
  taskBusy.value = t.id
  taskErr.value = ''
  try {
    await taskApi.cancel(t.id)
    notice.value = `任务 #${t.id} 已取消`
    await loadTasks()
    emit('refresh')
  } catch (e) {
    taskErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    taskBusy.value = null
  }
}

// ===== ④ 产物缩略（assetIds → detail 并发；点击自持预览器）=====
const ASSET_CAP = 24
const assets = ref<Asset[]>([])
const assetsLoading = ref(false)
const previewIdx = ref<number | null>(null)

async function loadAssets(): Promise<void> {
  assets.value = []
  const n = rn.value
  if (!n || !n.assetIds.length) return
  assetsLoading.value = true
  try {
    const settled = await Promise.allSettled(
      n.assetIds.slice(0, ASSET_CAP).map((id) => assetApi.detail(id).then((r) => r.asset)),
    )
    assets.value = settled
      .filter((r): r is PromiseFulfilledResult<Asset> => r.status === 'fulfilled')
      .map((r) => r.value)
  } finally {
    assetsLoading.value = false
  }
}

function onAssetChanged(updated: Asset): void {
  assets.value = assets.value.map((a) => (a.id === updated.id ? updated : a))
}

// ===== ⑤ 输入区（引用清单 + step.input 快照）=====
const REF_KIND_TEXT: Record<string, string> = {
  input: '启动输入',
  step: '上游产物',
  'assets-purpose': '资产库',
}
const refs = computed(() => props.sel.node.inputsRefs ?? [])
const inputJson = computed<string>(() => {
  const n = rn.value
  if (!n || n.input == null) return ''
  if (typeof n.input === 'string') return n.input
  try {
    return JSON.stringify(n.input, null, 2)
  } catch {
    return String(n.input)
  }
})

// ===== ⑥ 模板态文案 =====
const depText = computed(() => {
  const n = tn.value
  if (!n) return '—'
  if (n.after === undefined) return '缺省：前一步'
  return n.after.length ? n.after.join('、') : '无（after: []）'
})
const condText = computed(() => {
  const n = tn.value
  if (!n) return '—'
  if (n.when) return Array.isArray(n.when) ? n.when.join(' ∧ ') : n.when
  if (n.whenAny?.length) return `任一：${n.whenAny.join(' ∨ ')}`
  return '—'
})
const batchText = computed(() => {
  const b = tn.value?.batch
  if (!b) return '—'
  let s = b.field
  if (b.maxConcurrent != null) s += ` · 并发 ${b.maxConcurrent}`
  if (b.retry != null) s += ` · 重试 ${b.retry}`
  return s
})

// ===== ⑦ 日志（父级已按 [stepKey] 过滤节流；此处按当前节点二次过滤）=====
const logEl = ref<HTMLElement | null>(null)
const logLines = computed(() => {
  const key = props.sel.node.key
  return props.log
    .split('\n')
    .filter((l) => l.includes(`[${key}]`))
    .slice(-200)
})
const logText = computed(() => logLines.value.join('\n'))

watch(
  () => props.log,
  () => {
    const el = logEl.value
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (nearBottom) void nextTick(() => { el.scrollTop = el.scrollHeight })
  },
)

// ===== ⑧ [M16] 送入创作画布（步骤产物 → 目标画布素材节点）=====
const showSend = ref(false)
const sendItems = computed<Array<{ id: number; name: string }>>(() => {
  const n = rn.value
  if (!n) return []
  const byId = new Map(assets.value.map((a) => [a.id, a]))
  return n.assetIds.map((id) => ({ id, name: byId.get(id)?.name ?? `产物 #${id}` }))
})
function onSendDone(canvasId: number): void {
  showSend.value = false
  notice.value = `已送入创作画布 #${canvasId}`
  emit('open-canvas', canvasId)
}

// ===== 重载：节点切换 / 状态与任务计数变化 / 产物变化 =====
watch(
  () => `${props.sel.mode}:${props.sel.node.key}`,
  () => {
    notice.value = ''
    opErr.value = ''
    void loadGateArtifact()
    void loadTasks()
    void loadAssets()
  },
  { immediate: true },
)
watch(
  () => {
    const n = rn.value
    return n ? `${n.status}|${n.tasks.total}|${n.tasks.succeeded}|${n.tasks.failed}|${n.tasks.cancelled}` : ''
  },
  () => {
    void loadGateArtifact()
    void loadTasks()
  },
)
watch(
  () => (rn.value ? rn.value.assetIds.join(',') : ''),
  () => void loadAssets(),
)
</script>

<template>
  <aside class="dr" aria-label="节点详情">
    <div class="dr-head">
      <div class="tt-wrap">
        <div class="tt" :title="sel.node.title">{{ sel.node.title }}</div>
        <div class="sub mono">#{{ sel.node.seq + 1 }} · {{ sel.node.key }} · {{ sel.node.action }}</div>
      </div>
      <button type="button" class="x" title="关闭（保持节点选中）" @click="emit('close')">
        <Icon name="x" :size="14" />
      </button>
    </div>

    <!-- ===== run 态：状态行 ===== -->
    <div v-if="rn" class="dr-status">
      <span class="badge" :class="rn.status === 'skipped' ? 'skip' : rn.status">{{ stepStatus(rn.status).text }}</span>
      <span v-if="rn.durationMs != null" class="muted">耗时 {{ fmtMs(rn.durationMs) }}</span>
      <span v-if="rn.attempts > 0" class="muted">尝试 {{ rn.attempts }}</span>
      <span v-if="rn.startedAt" class="muted">{{ fmtTime(rn.startedAt) }}</span>
    </div>
    <div v-if="rn && rn.error" class="err-text">{{ rn.error }}</div>
    <div v-if="rn && rn.skippedReason" class="muted sk">跳过原因：{{ skipReasonText(rn.skippedReason) }}</div>
    <div v-if="rn && rn.gateTrace" class="muted sk">
      上轮闸门：{{ rn.gateTrace.decision === 'approve' ? '批准' : '驳回' }}
      <template v-if="rn.gateTrace.note">（{{ rn.gateTrace.note }}）</template>
      · {{ fmtTime(rn.gateTrace.at) }}
    </div>

    <!-- ===== run 态：操作区 ===== -->
    <section v-if="rn" class="sec">
      <div class="sec-h">操作</div>

      <GateDialog
        v-if="gateVisible"
        :step-title="sel.node.title"
        :message="rn ? rn.gate?.message ?? '' : ''"
        :artifact-text="gateText || undefined"
        :artifact-name="gateTextName || undefined"
        :skip-label="gateSkipLabel"
        :busy="gateBusy"
        @decided="onGateDecided"
      />
      <div v-if="gateErr" class="err-text">{{ gateErr }}</div>

      <div v-if="!gateVisible" class="ops">
        <button
          v-if="rn.actions.rerun"
          type="button"
          class="btn sm"
          :disabled="!rn.actions.rerun.allowed || rerunStep === null"
          :title="rn.actions.rerun.allowed ? '重跑该步骤（可复用成功子任务）' : rn.actions.rerun.reason ?? ''"
          @click="showRerun = true"
        >
          <Icon name="refresh" :size="12" /> 单步重跑…
        </button>
        <button
          v-if="rn.actions.recompose"
          type="button"
          class="btn sm"
          :disabled="!rn.actions.recompose.allowed || recomposeBusy"
          :title="rn.actions.recompose.allowed ? '重置合成并重新执行（本地 ffmpeg）' : rn.actions.recompose.reason ?? ''"
          @click="doRecompose"
        >
          <Icon name="film" :size="12" /> {{ recomposeBusy ? '提交中…' : '重新合成' }}
        </button>
        <span v-if="!rn.actions.rerun && !rn.actions.recompose" class="muted">当前状态无可用操作</span>
      </div>
      <div
        v-if="!gateVisible && rn.actions.rerun && !rn.actions.rerun.allowed && rn.actions.rerun.reason"
        class="muted reason"
      >
        {{ rn.actions.rerun.reason }}
      </div>
      <div
        v-if="!gateVisible && rn.actions.recompose && !rn.actions.recompose.allowed && rn.actions.recompose.reason"
        class="muted reason"
      >
        {{ rn.actions.recompose.reason }}
      </div>

      <div v-if="notice" class="notice-box">{{ notice }}</div>
      <div v-if="opErr" class="err-text">{{ opErr }}</div>
    </section>

    <!-- ===== run 态：子任务 ===== -->
    <section v-if="rn && rn.stepId != null" class="sec">
      <div class="sec-h">子任务（{{ tasks.length }}）</div>
      <div v-if="tasksLoading" class="muted">加载中…</div>
      <div v-else-if="!tasks.length" class="muted">该步骤为整体执行型（无子任务）</div>
      <div v-else class="tlist">
        <div v-for="t in tasks" :key="t.id" class="trow">
          <span class="mono tid">#{{ t.id }}</span>
          <span class="badge" :class="taskStatus(t.status).cls">{{ taskStatus(t.status).text }}</span>
          <span class="muted tkind mono">{{ t.kind }}</span>
          <span v-if="t.errorMsg" class="t-err" :title="t.errorMsg">{{ t.errorMsg }}</span>
          <span class="sp" />
          <button
            v-if="(t.status === 'failed' || t.status === 'cancelled') && rn.actions.taskRetry"
            type="button"
            class="btn sm"
            :disabled="taskBusy === t.id"
            title="重新入队该任务"
            @click="retryTask(t)"
          >
            重试
          </button>
          <button
            v-if="t.status === 'pending' || t.status === 'processing'"
            type="button"
            class="btn sm danger"
            :disabled="taskBusy === t.id"
            title="取消该任务"
            @click="cancelTask(t)"
          >
            取消
          </button>
        </div>
      </div>
      <div v-if="taskErr" class="err-text">{{ taskErr }}</div>
    </section>

    <!-- ===== template 态：设计信息 ===== -->
    <section v-if="tn" class="sec">
      <div class="sec-h">设计态</div>
      <div class="kv">
        <span class="k">闸门</span>
        <span v-if="tn.gate" class="v">
          {{ tn.gate.mode }} · {{ tn.gate.message }}<em v-if="tn.gate.skipLabel">（免审放行：{{ tn.gate.skipLabel }}）</em>
        </span>
        <span v-else class="v muted">无</span>
      </div>
      <div class="kv"><span class="k">依赖</span><span class="v mono">{{ depText }}</span></div>
      <div class="kv"><span class="k">条件</span><span class="v mono">{{ condText }}</span></div>
      <div class="kv"><span class="k">批量</span><span class="v">{{ batchText }}</span></div>
      <div class="kv"><span class="k">产物</span><span class="v">{{ tn.output ? purposeText(tn.output.purpose) : '—' }}</span></div>
      <div class="muted hint">模板画布为设计态预览；运行状态与操作请切换到运行画布。</div>
    </section>

    <!-- ===== 输入引用（两态共用） ===== -->
    <section class="sec">
      <div class="sec-h">输入引用</div>
      <div v-if="refs.length" class="refs">
        <div v-for="(r, i) in refs" :key="i" class="refrow">
          <span class="rfield mono">{{ r.field }}</span>
          <span class="rkind" :data-k="r.kind">{{ REF_KIND_TEXT[r.kind] }}</span>
          <span class="rref mono" :title="r.ref">{{ r.ref }}</span>
        </div>
      </div>
      <div v-else class="muted">无引用（纯静态输入）</div>
      <details v-if="rn && inputJson" class="fold">
        <summary>输入快照（step.input）</summary>
        <pre class="pre mono">{{ inputJson }}</pre>
      </details>
    </section>

    <!-- ===== run 态：产物 ===== -->
    <section v-if="rn" class="sec">
      <div class="sec-h sh-row">
        <span>产物（{{ rn.assetIds.length }}）</span>
        <span class="sp" />
        <button
          v-if="rn.assetIds.length && projectId != null"
          type="button"
          class="btn sm"
          title="把本步骤产物送入创作画布作为素材节点"
          @click="showSend = true"
        >
          <Icon name="wand" :size="11" /> 送入创作画布…
        </button>
      </div>
      <div v-if="assetsLoading" class="muted">加载中…</div>
      <div v-else-if="!rn.assetIds.length" class="muted">此步骤暂无产物</div>
      <template v-else>
        <div class="thumbs">
          <button v-for="(a, i) in assets" :key="a.id" type="button" class="thumb" :title="a.name" @click="previewIdx = i">
            <img v-if="a.urls.thumb || a.kind === 'image'" :src="a.urls.thumb ?? a.urls.file" loading="lazy" alt="" />
            <span v-else class="tkindbox">{{ KIND_TEXT[a.kind] ?? a.kind }}</span>
            <span class="tname">{{ a.name }}</span>
          </button>
        </div>
        <div v-if="rn.assetIds.length > assets.length" class="muted more">
          仅展示前 {{ assets.length }} 项（共 {{ rn.assetIds.length }}）
        </div>
      </template>
    </section>

    <!-- ===== run 态：日志（按 [stepKey] 过滤） ===== -->
    <section v-if="rn" class="sec">
      <div class="sec-h">日志（{{ logLines.length }} 行 · 按 [{{ sel.node.key }}] 过滤）</div>
      <pre ref="logEl" class="log mono">{{ logText || '暂无该步骤日志' }}</pre>
    </section>

    <!-- 重跑弹窗（复用 M11） -->
    <RerunModal
      v-if="showRerun && rerunStep && runId != null"
      :run-id="runId"
      :step="rerunStep"
      @close="showRerun = false"
      @done="onRerunDone"
    />
    <!-- [M16] 送入创作画布 -->
    <CanvasTargetModal
      v-if="showSend && projectId != null && rn"
      :project-id="projectId"
      :assets="sendItems"
      @done="onSendDone"
      @close="showSend = false"
    />
    <!-- 产物预览（自持） -->
    <AssetPreviewer
      v-if="previewIdx !== null && assets.length"
      :assets="assets"
      :index="previewIdx"
      @close="previewIdx = null"
      @changed="onAssetChanged"
    />
  </aside>
</template>

<style scoped>
.dr {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 420px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 18px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: -14px 0 30px rgb(0 0 0 / 34%);
  overflow-y: auto;
  z-index: 6;
  animation: dr-in 0.18s ease;
}

@keyframes dr-in {
  from {
    transform: translateX(26px);
    opacity: 0;
  }
}

.dr-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.tt-wrap {
  flex: 1;
  min-width: 0;
}

.tt {
  font-weight: 700;
  font-size: 14.5px;
}

.sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  word-break: break-all;
}

.x {
  display: flex;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}

.x:hover {
  background: var(--hover);
  color: #fff;
}

.dr-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  flex-wrap: wrap;
}

.sk {
  font-size: 12px;
}

.sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

.sec-h {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.4px;
}

.sh-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ops {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.reason {
  font-size: 11.5px;
}

.notice-box {
  border: 1px solid rgb(34 197 94 / 30%);
  background: var(--ok-weak);
  color: var(--ok);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
}

.tlist {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trow {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  padding: 4px 2px;
  min-width: 0;
}

.tid {
  color: var(--text-3);
  flex: none;
}

.tkind {
  flex: none;
}

.t-err {
  flex: 1;
  min-width: 0;
  color: var(--bad);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sp {
  flex: 1;
}

.refs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.refrow {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  min-width: 0;
}

.rfield {
  flex: none;
  color: var(--accent-h);
  font-size: 11.5px;
}

.rkind {
  flex: none;
  font-size: 10.5px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
}

.rkind[data-k='step'] {
  color: var(--ok);
  border-color: rgb(34 197 94 / 35%);
}

.rkind[data-k='assets-purpose'] {
  color: var(--warn);
  border-color: rgb(251 191 36 / 35%);
}

.rref {
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fold summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
}

.fold summary:hover {
  color: #fff;
}

.pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 11.5px;
  line-height: 1.6;
  overflow: auto;
  max-height: 220px;
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.thumbs {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.thumb {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px;
  background: var(--code-bg);
  cursor: pointer;
  overflow: hidden;
}

.thumb:hover {
  border-color: var(--accent);
}

.thumb img {
  display: block;
  width: 100%;
  height: 56px;
  object-fit: cover;
  border-radius: 5px;
}

.tkindbox {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 56px;
  font-size: 11px;
  color: var(--text-3);
  background: rgb(148 163 184 / 7%);
  border-radius: 5px;
}

.tname {
  font-size: 10px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more {
  font-size: 11px;
}

.log {
  min-height: 140px;
  max-height: 300px;
  overflow: auto;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}

.kv {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.kv .k {
  flex: none;
  width: 56px;
  color: var(--text-3);
}

.kv .v {
  min-width: 0;
  color: var(--text-2);
  word-break: break-all;
}

.kv .v em {
  font-style: normal;
  color: var(--warn);
}

.hint {
  font-size: 11.5px;
}
</style>
