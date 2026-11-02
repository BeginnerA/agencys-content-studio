<script setup lang="ts">
/**
 * M70 台账弹层（brief 11.3）：按集拆「来源 / 编辑 / 影响」三段。
 * - 来源：SourcePicker 展示候选；提取预检走 GET（纯读）；AI 整理是唯一付费操作（LONG 超时，
 *   断连后按同 operationKey 重试/查询，不重复发送请求）。
 * - 编辑：EntryEditor 结构化编辑草稿；并发 409 保留用户编辑并提示重新载入；确认 CAS 绑定所见当前头。
 * - 影响：ImpactPanel 三区展示下游引用。
 * 浏览器端到端实测留 Task 13；本组件只保证真实 API 契约与状态纪律。
 */
import { computed, onMounted, ref } from 'vue'
import { assetVersionApi } from '../../../lib/api/versions'
import { ApiError } from '../../../lib/api/core'
import { continuityApi } from '../../../lib/api/continuity'
import type {
  EntryDoc,
  EntryView,
  ExtractPreview,
  SourceCandidate,
  SourcePick,
} from '../../../lib/types/continuity'
import SourcePicker from './SourcePicker.vue'
import EntryEditor from './EntryEditor.vue'
import ImpactPanel from './ImpactPanel.vue'

const props = defineProps<{
  projectId: number
  episodeId: number
  episodeNumber: number
}>()
const emit = defineEmits<{ changed: [] }>()

const tab = ref<'sources' | 'editor' | 'impact'>('sources')
const sources = ref<SourceCandidate[]>([])
const entries = ref<EntryView[]>([])
const loading = ref(false)
const err = ref('')
const pick = ref<SourcePick | null>(null)
const pickedCandidate = ref<SourceCandidate | null>(null)
const preview = ref<ExtractPreview | null>(null)
const unpricedConsent = ref(false)
const extracting = ref(false)
const draft = ref<EntryView | null>(null)
const sourceText = ref('')
const impactId = ref<number | null>(null)
const confirmedMsg = ref('')
/** 同源同预览的超时重试复用操作键；成功/确定失败后清空，允许下一次全新操作。 */
let pendingExtract: { fingerprint: string; key: string } | null = null

async function loadAll() {
  loading.value = true
  err.value = ''
  try {
    const [src, list] = await Promise.all([
      continuityApi.sources(props.projectId, props.episodeId),
      continuityApi.list(props.projectId, props.episodeId),
    ])
    sources.value = src.items
    entries.value = list.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(() => void loadAll())

const editable = computed(() =>
  entries.value.filter((e) => e.status === 'draft' && e.doc),
)
const confirmedHead = computed(
  () => entries.value.find((e) => e.status === 'confirmed') ?? null,
)

async function onPicked(p: SourcePick, candidate: SourceCandidate) {
  pick.value = p
  pickedCandidate.value = candidate
  preview.value = null
  unpricedConsent.value = false
  err.value = ''
  try {
    const r = await continuityApi.extractionPreview(
      props.projectId,
      props.episodeId,
      p,
    )
    preview.value = r.extractionPreview
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

/** 快照成功才生成版本：重取候选，用服务端最新可确认面替换旧快照态（不本地伪造确认权）。 */
async function onCaptured() {
  try {
    const src = await continuityApi.sources(props.projectId, props.episodeId)
    sources.value = src.items
    const p = pick.value
    if (!p) return
    pickedCandidate.value =
      src.items.find(
        (s) =>
          s.runId === p.runId &&
          s.stepId === p.stepId &&
          s.assetId === p.assetId &&
          s.versionId === p.versionId,
      ) ?? pickedCandidate.value
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

/** AI 整理（唯一付费端点）：预检在先；超时后按同 operationKey 查询，绝不换键重复付费。 */
async function doExtract() {
  if (!pick.value || !preview.value || extracting.value) return
  const p = pick.value
  const fingerprint = `${p.runId}:${p.stepId}:${p.assetId}:${p.versionId}:${preview.value.previewHash}`
  const operationKey =
    pendingExtract?.fingerprint === fingerprint
      ? pendingExtract.key
      : `ex_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`
  pendingExtract = { fingerprint, key: operationKey }
  extracting.value = true
  err.value = ''
  confirmedMsg.value = ''
  try {
    const r = await continuityApi.extract(props.projectId, props.episodeId, {
      source: p,
      previewHash: preview.value.previewHash,
      operationKey,
      allowModelCall: true,
      acceptUnpriced:
        preview.value.estimatedCost === null ? unpricedConsent.value : true,
    })
    pendingExtract = null
    if (!r.entry.doc) {
      err.value = `该操作尚无结果（${r.entry.status}）：未重复发送请求，请稍后刷新列表复查。`
      emit('changed')
      return
    }
    draft.value = r.entry
    tab.value = 'editor'
    await openDraft(r.entry)
    emit('changed')
  } catch (e) {
    // 只有客户端超时才保留操作键（服务端可能仍在处理）；确定失败允许下次换新键重来。
    if (!(e instanceof ApiError && e.code === 'timeout')) pendingExtract = null
    err.value =
      e instanceof ApiError && e.code === 'timeout'
        ? `${e.message}（服务端可能仍在处理：稍后重试将复用同一操作键查询，不会重复发送）`
        : e instanceof Error
          ? e.message
          : String(e)
  } finally {
    extracting.value = false
  }
}

/** 零模型复核：克隆草稿并绑定「当前来源」（设计 §7：复核旧记录须绑当前版本，人工重核证据）。 */
async function doReview(parent: EntryView) {
  if (!parent.doc || extracting.value) return
  const old = parent.doc.source
  extracting.value = true
  err.value = ''
  try {
    // 内存里的候选可能早于资产编辑：复核前重取，避免把旧版本当当前来源提交（服务端会 409）。
    const src = await continuityApi.sources(props.projectId, props.episodeId)
    sources.value = src.items
    const current = src.items.find(
      (s) =>
        s.runId === old.runId &&
        s.stepId === old.stepId &&
        s.assetId === old.assetId,
    )
    if (!current || current.versionId === null || !current.confirmable) {
      err.value =
        '复核需绑定当前可确认来源：未找到该来源的最新版本，请先在「来源」重新选择并生成快照'
      return
    }
    const r = await continuityApi.review(props.projectId, props.episodeId, {
      parentId: parent.id,
      source: {
        runId: current.runId,
        stepId: current.stepId,
        assetId: current.assetId,
        versionId: current.versionId,
      },
      operationKey: `rv_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
    })
    draft.value = r.entry
    tab.value = 'editor'
    await openDraft(r.entry)
    emit('changed')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    extracting.value = false
  }
}

/** 原文必须读所选不可变版本（R11），不用资产当前字节。 */
async function openDraft(entry: EntryView) {
  if (!entry.doc) return
  try {
    const r = await assetVersionApi.contentText(
      entry.doc.source.assetId,
      entry.doc.source.versionId,
    )
    sourceText.value = r.content
  } catch (e) {
    sourceText.value = ''
    err.value = `原文版本不可读：${e instanceof Error ? e.message : String(e)}`
  }
}

function editEntry(entry: EntryView) {
  draft.value = entry
  impactId.value = entry.id
  tab.value = 'editor'
  void openDraft(entry)
}

/** 保存草稿：409 冲突保留本地编辑、提示重新载入（EntryEditor 的 doc 不被覆盖）。 */
const conflictHint = ref(false)
async function onSaveDoc(doc: EntryDoc) {
  if (!draft.value) return
  err.value = ''
  conflictHint.value = false
  try {
    const r = await continuityApi.patch(props.projectId, draft.value.id, {
      expectedRevision: draft.value.revision,
      doc,
    })
    draft.value = r.entry
    await loadAll()
    emit('changed')
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      conflictHint.value = true
      err.value = `${e.message}——你的编辑已保留，核对服务端最新版本后重新载入。`
    } else {
      err.value = e instanceof Error ? e.message : String(e)
    }
  }
}

async function reloadDraft() {
  conflictHint.value = false
  err.value = ''
  await loadAll()
  const fresh = draft.value
    ? (entries.value.find((e) => e.id === draft.value!.id) ?? null)
    : null
  draft.value = fresh
  if (fresh) await openDraft(fresh)
}

/** 确认 CAS：绑定所见当前头与 warningsHash（服务端逐项复核，漂移 409）。 */
async function doConfirm(entry: EntryView) {
  if (!entry.doc) return
  err.value = ''
  confirmedMsg.value = ''
  try {
    const r = await continuityApi.confirm(props.projectId, entry.id, {
      expectedRevision: entry.revision,
      document: entry.document!,
      sourceFingerprint: entry.doc.source.fingerprint,
      warningsHash: entry.warningsHash,
      expectedCurrentConfirmedId: entry.currentConfirmedId,
      acceptedWarnings: [...entry.doc.warnings].sort(),
      approvalKey: `cf_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
    })
    confirmedMsg.value = `已确认 entry #${r.entry.id}（revision ${r.entry.revision}）`
    draft.value = null
    await loadAll()
    emit('changed')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

function statusBadge(e: EntryView): { text: string; cls: string } {
  if (e.status === 'confirmed') return { text: '已确认', cls: 'succeeded' }
  if (e.status === 'draft') return { text: '草稿', cls: 'running' }
  if (e.status === 'extracting') return { text: '提取中', cls: 'running' }
  if (e.status === 'unknown') return { text: '结果未知', cls: 'running' }
  if (e.status === 'failed') return { text: '失败', cls: 'failed' }
  return { text: '已被替代', cls: '' }
}

const validityText: Record<string, string> = {
  valid: '有效',
  stale: '待复核（来源已变）',
  missing: '缺历史',
  corrupt: '损坏',
}
</script>

<template>
  <div class="ct-panel">
    <div class="ct-head">
      <span class="ct-title">第 {{ episodeNumber }} 集 · 剧情台账</span>
      <button class="btn sm" :disabled="loading" @click="loadAll">
        {{ loading ? '加载中…' : '重新载入' }}
      </button>
    </div>
    <div class="ct-tabs">
      <button
        v-for="t in ['sources', 'editor', 'impact'] as const"
        :key="t"
        class="ct-tab"
        :class="{ act: tab === t }"
        @click="tab = t"
      >
        {{
          t === 'sources'
            ? '来源与提取'
            : t === 'editor'
              ? '编辑与确认'
              : '影响'
        }}
      </button>
    </div>
    <div v-if="err" class="err-text">
      {{ err }}
      <button v-if="conflictHint" class="btn sm" @click="reloadDraft">
        重新载入
      </button>
    </div>
    <div v-if="confirmedMsg" class="ct-ok">{{ confirmedMsg }}</div>

    <div v-show="tab === 'sources'" class="ct-body">
      <SourcePicker
        :project-id="projectId"
        :episode-id="episodeId"
        :sources="sources"
        @picked="onPicked"
        @captured="onCaptured"
      />
      <div v-if="preview" class="ct-preview">
        <div class="ct-meta">
          <span
            class="badge"
            :class="pickedCandidate?.confirmable ? 'succeeded' : 'running'"
          >
            {{
              pickedCandidate?.confirmable
                ? '来源可确认'
                : '来源不可确认（仅预检）'
            }}
          </span>
          <span class="muted"
            >依赖前集：{{ preview.basis.length }} 条 · 输入
            {{ preview.inputChars }} 字符</span
          >
          <span v-if="preview.estimatedCost !== null" class="muted mono"
            >预估费用 ¥{{ preview.estimatedCost.toFixed(4) }}</span
          >
          <span v-else class="badge running">无定价——需显式接受未计价</span>
        </div>
        <div v-if="preview.warnings.length" class="muted">
          警示：{{ preview.warnings.join('；') }}
        </div>
        <label class="ct-cost">
          <input
            v-model="unpricedConsent"
            type="checkbox"
            :disabled="preview.estimatedCost !== null"
          />
          AI
          整理会调用模型（唯一付费操作）；断连后请用「重新载入」按同一操作查询，不要重复发起。
        </label>
        <button
          class="btn primary"
          :disabled="
            extracting ||
            !pickedCandidate?.confirmable ||
            (preview.estimatedCost === null && !unpricedConsent)
          "
          @click="doExtract"
        >
          {{ extracting ? '整理中…' : 'AI 整理（付费）' }}
        </button>
      </div>
    </div>

    <div v-show="tab === 'editor'" class="ct-body">
      <div class="ct-list">
        <div class="ct-sec">本集登记（{{ entries.length }}）</div>
        <div v-if="!entries.length" class="muted">本集尚无剧情台账。</div>
        <div v-for="e in entries" :key="e.id" class="ct-entry">
          <span class="badge" :class="statusBadge(e).cls">{{
            statusBadge(e).text
          }}</span>
          <span v-if="e.doc" class="muted"
            >{{ validityText[e.validity] ?? e.validity }} · rev
            {{ e.revision }} ·
            {{ e.doc.items.filter((i) => i.included).length }} 条目</span
          >
          <span v-if="confirmedHead?.id === e.id" class="badge succeeded"
            >当前头</span
          >
          <span class="ct-entry-ops">
            <button
              v-if="e.status === 'draft' && e.doc"
              class="btn sm"
              @click="editEntry(e)"
            >
              编辑
            </button>
            <button
              v-if="e.status === 'draft' && e.doc"
              class="btn sm primary"
              @click="doConfirm(e)"
            >
              确认
            </button>
            <button
              v-if="
                (e.status === 'confirmed' || e.status === 'superseded') && e.doc
              "
              class="btn sm"
              :disabled="extracting"
              @click="doReview(e)"
            >
              零模型复核
            </button>
            <button
              class="btn sm"
              @click="
                impactId = e.id
                tab = 'impact'
              "
            >
              影响
            </button>
          </span>
        </div>
      </div>
      <EntryEditor
        v-if="draft?.doc"
        :entry="draft"
        :source-text="sourceText"
        @save="onSaveDoc"
      />
      <div v-else class="muted">
        选择一条草稿进行编辑；确认后登记进入当前头。
      </div>
    </div>

    <div v-show="tab === 'impact'" class="ct-body">
      <template v-if="impactId !== null">
        <ImpactPanel
          :key="impactId"
          :project-id="projectId"
          :record-id="impactId"
        />
      </template>
      <div v-else class="muted">
        先在「编辑与确认」里选择一条登记查看其影响。
      </div>
    </div>
  </div>
</template>

<style scoped>
.ct-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.ct-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ct-title {
  font-weight: 600;
  font-size: 13.5px;
}
.ct-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}
.ct-tab {
  border: none;
  background: none;
  padding: 6px 10px;
  cursor: pointer;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text-2);
  border-bottom: 2px solid transparent;
}
.ct-tab.act {
  color: var(--text-1);
  border-bottom-color: var(--accent-h);
}
.ct-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.ct-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
}
.ct-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
}
.ct-cost {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 12px;
  color: var(--text-2);
}
.ct-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ct-sec {
  font-size: 12.5px;
  font-weight: 600;
}
.ct-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
  border-top: 1px dashed var(--border);
  flex-wrap: wrap;
}
.ct-entry-ops {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.ct-ok {
  font-size: 12.5px;
  color: var(--text-2);
}
</style>
