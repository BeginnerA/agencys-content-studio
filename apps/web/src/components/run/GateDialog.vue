<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import MarkdownPreview from '../common/MarkdownPreview.vue'
import { assetApi, runApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import { diffLines } from '../../lib/diff'
import type { DiffRow } from '../../lib/diff'
import { fmtTime } from '../../lib/format'
import type { RevisionItem } from '../../lib/types'

const props = defineProps<{
  stepTitle: string
  message: string
  /** 产物全文（可编辑覆盖） */
  artifactText?: string
  artifactName?: string
  /** 模板声明 skip_label 后显示「跳过」按钮（免审放行、产物保留） */
  skipLabel?: string
  busy?: boolean
  /** 版本对比：run id + 步骤 key（≥2 版文本产物时显示「对比」tab） */
  runId?: number
  stepKey?: string
}>()

const emit = defineEmits<{
  decided: [
    action: 'approve' | 'reject' | 'skip' | 'abort',
    payload: { note?: string; textOverride?: string },
  ]
}>()

const tab = ref<'view' | 'edit' | 'diff'>('view')
const edited = ref(props.artifactText ?? '')
const note = ref('')

const showEdit = computed(() => !!props.artifactText && tab.value === 'edit')

// ---- 版本对比（diff tab）：上一版本 vs 当前产物，可切换基准版本 ----
const revisions = ref<RevisionItem[]>([])
const hasDiff = computed(() => revisions.value.length >= 2)
/** 基准版本在 revisions 中的下标（默认 1 = 上一版本；新侧固定为当前产物 revisions[0]） */
const baseIdx = ref(1)
const diffRows = ref<DiffRow[]>([])
const diffTruncated = ref(false)
const diffLoading = ref(false)
const diffErr = ref('')
/** 已加载对比指纹（基准 assetId:当前 assetId），避免重复拉取 */
let diffKey = ''

/** 基准版本下拉（排除当前产物） */
const baseOptions = computed(() =>
  revisions.value.slice(1).map((it, i) => ({
    idx: i + 1,
    label: `第 ${revisions.value.length - (i + 1)} 版 · ${fmtTime(it.createdAt)} · ${it.name}`,
  })),
)

const diffStat = computed(() => {
  let add = 0
  let del = 0
  for (const r of diffRows.value) {
    if (r.type === 'add') add += 1
    else if (r.type === 'del') del += 1
  }
  return { add, del }
})

/** 读资产全文（与既有 artifactText 读取同法：detail 取 URL → fetch 文本） */
async function readAssetText(assetId: number): Promise<string> {
  const { asset: a } = await assetApi.detail(assetId)
  const res = await fetch(a.urls.file)
  if (!res.ok) throw new Error(`产物读取失败（HTTP ${res.status}）`)
  return res.text()
}

async function loadDiff(force = false): Promise<void> {
  const cur = revisions.value[0]
  const base = revisions.value[baseIdx.value]
  if (!cur || !base || cur.assetId === base.assetId) return
  const key = `${base.assetId}:${cur.assetId}`
  if (!force && key === diffKey) return
  diffLoading.value = true
  diffErr.value = ''
  try {
    const [oldText, newText] = await Promise.all([
      readAssetText(base.assetId),
      readAssetText(cur.assetId),
    ])
    const d = diffLines(oldText, newText)
    diffRows.value = d.rows
    diffTruncated.value = d.truncated
    diffKey = key
  } catch (e) {
    diffRows.value = []
    diffTruncated.value = false
    diffErr.value = e instanceof Error && e.message ? e.message : '对比加载失败'
    diffKey = ''
  } finally {
    diffLoading.value = false
  }
}

// 打开对比 tab / 切换基准版本 → 加载（指纹去重）
watch([tab, baseIdx], () => {
  if (tab.value === 'diff') void loadDiff()
})

onMounted(async () => {
  if (!props.runId || !props.stepKey) return
  try {
    revisions.value = (await runApi.revisions(props.runId, props.stepKey)).items
  } catch {
    // 静默：版本列表失败不阻塞审批主流程
  }
})

function approve() {
  emit('decided', 'approve', {
    textOverride:
      showEdit.value && edited.value !== props.artifactText
        ? edited.value
        : undefined,
  })
}

function reject() {
  if (!note.value.trim()) {
    alert('驳回需填写修改意见（将注入重跑的 LLM 输入）')
    return
  }
  emit('decided', 'reject', { note: note.value.trim() })
}

/** 免审放行：产物保留直接通过（模板声明 skip_label 才出现此按钮） */
function skip() {
  emit('decided', 'skip', {})
}

async function abort() {
  const ok = await confirmDialog({
    title: '中止运行',
    message: '确认中止该运行？当前步骤产物保留，run 置 cancelled。',
    confirmText: '中止运行',
    danger: true,
  })
  if (ok) emit('decided', 'abort', {})
}
</script>

<template>
  <div class="gate panel">
    <div class="ghead">
      <div class="tt"><span class="dot" /> 人工闸门 · {{ stepTitle }}</div>
      <div class="act">
        <button class="btn sm" :disabled="busy" @click="abort">中止</button>
        <button
          v-if="skipLabel"
          class="btn sm skip"
          :disabled="busy"
          @click="skip"
        >
          {{ skipLabel }}
        </button>
        <button class="btn sm ok" :disabled="busy" @click="approve">
          批准继续
        </button>
        <button class="btn sm danger" :disabled="busy" @click="reject">
          驳回重跑
        </button>
      </div>
    </div>

    <div class="msg">{{ message }}</div>

    <template v-if="artifactText">
      <div class="tabs">
        <button :class="{ on: tab === 'view' }" @click="tab = 'view'">
          预览产物
        </button>
        <button :class="{ on: tab === 'edit' }" @click="tab = 'edit'">
          审阅修改
        </button>
        <button
          v-if="hasDiff"
          :class="{ on: tab === 'diff' }"
          @click="tab = 'diff'"
        >
          对比（{{ revisions.length }} 版）
        </button>
      </div>
      <div v-if="tab === 'view'" class="doc">
        <MarkdownPreview :source="artifactText" />
      </div>
      <div v-else-if="tab === 'diff'" class="doc">
        <div class="diff-bar">
          <select v-model.number="baseIdx" aria-label="对比基准版本">
            <option v-for="o in baseOptions" :key="o.idx" :value="o.idx">
              {{ o.label }}
            </option>
          </select>
          <span class="muted">→ 当前产物</span>
          <span v-if="diffRows.length" class="stat mono">
            <span class="addn">+{{ diffStat.add }}</span>
            <span class="deln">-{{ diffStat.del }}</span>
          </span>
          <button
            class="btn sm"
            style="margin-left: auto"
            :disabled="diffLoading"
            @click="loadDiff(true)"
          >
            刷新
          </button>
        </div>
        <div v-if="diffErr" class="err-text">{{ diffErr }}</div>
        <div v-else-if="diffLoading" class="muted" style="padding: 8px 0">
          对比加载中…
        </div>
        <div v-else-if="!diffRows.length" class="muted" style="padding: 8px 0">
          两版内容一致或无可对比内容
        </div>
        <div v-else class="diff-rows">
          <div v-for="(r, i) in diffRows" :key="i" class="drow" :class="r.type">
            <span class="sign">{{
              r.type === 'add' ? '+' : r.type === 'del' ? '-' : ''
            }}</span>
            <span class="txt">{{ r.text || ' ' }}</span>
          </div>
        </div>
        <div v-if="diffTruncated" class="muted trunc">
          版本过大，已按规模保护截断显示
        </div>
      </div>
      <div v-else class="doc">
        <div class="muted" style="margin-bottom: 6px">
          修改后文本将覆盖产物再继续（不改则原样通过）。{{ artifactName }}
        </div>
        <textarea v-model="edited" rows="18" class="editor mono" />
      </div>
    </template>

    <div v-if="!artifactText" class="muted" style="padding: 10px 0 4px">
      本步骤无可预览文本产物，直接批准、跳过或驳回。
    </div>

    <div
      v-if="skipLabel"
      class="muted"
      style="padding: 2px 0 0; font-size: 11.5px"
    >
      「{{ skipLabel }}」= 免审放行：产物保留并继续下游，不产生修改。
    </div>

    <div class="note-row">
      <input
        v-model="note"
        type="text"
        placeholder="驳回意见（可选，批准/跳过时忽略）：指出要修改的点…"
      />
    </div>
  </div>
</template>

<style scoped>
.gate {
  border-left: 3px solid var(--warn);
  padding: 12px 16px;
  margin-bottom: 14px;
  background: linear-gradient(90deg, rgb(245 158 11 / 6%), transparent 42%);
}

.ghead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.tt {
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 7px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn);
  animation: pulse 1.4s infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.act {
  display: flex;
  gap: 8px;
}

/* 免审放行：中性次主按钮（介于批准与驳回之间） */
.btn.skip {
  border-color: rgb(148 163 184 / 32%);
  color: #b9c7dc;
}

.btn.skip:hover {
  border-color: rgb(165 180 252 / 55%);
  color: #c7d2fe;
  background: var(--accent-weak);
}

.msg {
  margin: 10px 0 4px;
  font-size: 13px;
  color: var(--text-2);
  background: var(--warn-weak);
  padding: 8px 12px;
  border-radius: 8px;
}

.tabs {
  display: flex;
  gap: 4px;
  margin: 10px 0 8px;
}

.tabs button {
  border: 1px solid transparent;
  background: none;
  font-size: 12px;
  padding: 4px 13px;
  border-radius: 999px;
  cursor: pointer;
  color: var(--text-2);
  transition: all 0.15s;
}

.tabs button:hover {
  color: #fff;
  background: var(--hover);
}

.tabs button.on {
  background: var(--accent-weak);
  border-color: rgb(99 102 241 / 45%);
  color: #a5b4fc;
}

.doc {
  max-height: 46vh;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  background: var(--code-bg);
}

.editor {
  border: none;
  outline: none;
  width: 100%;
  font-size: 12.5px;
  line-height: 1.7;
  background: transparent;
  color: var(--text);
  padding: 0;
}

.note-row {
  margin-top: 10px;
}

/* 版本对比 diff 视图：+ 绿 / - 红 / 上下文灰 */
.diff-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 12px;
}

.diff-bar select {
  width: min(300px, 55%);
}

.diff-bar .stat {
  margin-left: auto;
}

.diff-bar .addn {
  color: var(--ok);
}

.diff-bar .deln {
  color: var(--bad);
}

.diff-rows {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.65;
}

.drow {
  display: flex;
  gap: 8px;
  border-radius: 3px;
  padding: 0 4px;
}

.drow .sign {
  flex: none;
  width: 10px;
  color: var(--text-3);
}

.drow .txt {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.drow.add {
  background: var(--ok-weak);
}

.drow.add .sign {
  color: var(--ok);
}

.drow.del {
  background: var(--bad-weak);
}

.drow.del .sign {
  color: var(--bad);
}

.trunc {
  padding: 6px 0 0;
  font-size: 11.5px;
}
</style>
