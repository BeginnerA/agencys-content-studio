<script setup lang="ts">
/**
 * 通用「历史 · 影响」面板（文本资产 / 实体档案复用）。
 * 三不变式落地：
 *  - 还原内容 = 复制历史版本回工作副本并生成新版本（移动指针、保留全部历史、不动下游）；
 *  - 影响只报告 —— 列出消费它的执行清单（run/step/task/镜头），绝不自动生成或返修；
 *  - 与「锁定输入」「采用产物」严格分离（本面板不含锁版/选片，锁版见画布 gen 节点控件）。
 * 只读 + 显式还原；旧数据无版本指针 → 明确标「历史不可恢复」，不伪造。
 */
import { computed, ref, watch } from 'vue'
import { assetVersionApi, entityVersionApi } from '../../lib/api'
import type { Asset, ContentVersionView, ImpactRow } from '../../lib/types'
import { fmtTime } from '../../lib/format'
import { confirmDialog } from '../../lib/confirm'
import Icon from '../common/Icon.vue'

const props = defineProps<{ kind: 'asset' | 'entity'; objId: number }>()
const emit = defineEmits<{ restored: [asset?: Asset] }>()

type Tab = 'history' | 'impact'
const tab = ref<Tab>('history')

const SOURCE_TEXT: Record<string, string> = {
  baseline: '基线',
  edit: '编辑',
  import: '导入',
  generate: '生成',
  'ref-upload': '参考上传',
  'ref-gen': '参考生成',
  polish: '润色',
  restore: '还原',
}
const EXEC_TEXT: Record<string, string> = {
  pipeline_step: 'Pipeline 步骤',
  canvas_task: '画布任务',
  shot_task: '单镜任务',
  unknown: '历史执行',
}
const ROLE_TEXT: Record<string, string> = {
  text: '文本',
  reference: '参考图',
  first_frame: '首帧',
  last_frame: '尾帧',
  source: '源素材',
  mask: '蒙版',
  subtitle: '字幕',
  bgm: '背景乐',
  sfx: '音效',
  prev_text: '前文',
  voice: '配音',
}
const STATUS_TEXT: Record<string, string> = {
  upstream_changed: '上游已变更',
  current: '与当前一致',
  no_history: '历史不可恢复',
}
function sourceText(s: string): string {
  return SOURCE_TEXT[s] ?? s
}
function execText(k: string): string {
  return EXEC_TEXT[k] ?? k
}
function roleText(r: string): string {
  return ROLE_TEXT[r] ?? r
}
function statusText(s: string): string {
  return STATUS_TEXT[s] ?? s
}

// ---- 版本列表 ----
const versions = ref<ContentVersionView[]>([])
const currentRevision = ref(0)
const listLoading = ref(false)
const listErr = ref('')

async function loadVersions() {
  if (!props.objId) return
  listLoading.value = true
  listErr.value = ''
  try {
    const r =
      props.kind === 'asset'
        ? await assetVersionApi.list(props.objId)
        : await entityVersionApi.list(props.objId)
    versions.value = r.items
    currentRevision.value = r.currentRevision
  } catch (e) {
    listErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    listLoading.value = false
  }
}

// ---- 版本内容预览 ----
const activeVersionId = ref<number | null>(null)
const previewText = ref('')
const previewLoading = ref(false)
const previewErr = ref('')

async function openVersion(v: ContentVersionView) {
  if (activeVersionId.value === v.id) {
    activeVersionId.value = null
    previewText.value = ''
    return
  }
  activeVersionId.value = v.id
  previewLoading.value = true
  previewErr.value = ''
  previewText.value = ''
  try {
    if (props.kind === 'asset') {
      const r = await assetVersionApi.contentText(props.objId, v.id)
      previewText.value = r.content
    } else {
      const r = await entityVersionApi.contentDoc(props.objId, v.id)
      previewText.value = JSON.stringify(r.doc, null, 2)
    }
  } catch (e) {
    previewErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
}

// ---- 还原（生成新版本，保留历史，不动下游） ----
const restoringId = ref<number | null>(null)
const restoreErr = ref('')

async function doRestore(v: ContentVersionView) {
  if (restoringId.value) return
  const ok = await confirmDialog({
    title: '还原到历史版本',
    message: `将把当前内容还原为版本 #${v.revision}（${sourceText(v.source)} · ${fmtTime(v.createdAt)}）。\n这会生成一个新版本并保留全部历史，不会改动任何下游已生成的产物。确定还原？`,
    confirmText: '确认还原',
  })
  if (!ok) return
  restoringId.value = v.id
  restoreErr.value = ''
  try {
    if (props.kind === 'asset') {
      const r = await assetVersionApi.restore(props.objId, v.id)
      emit('restored', r.asset)
    } else {
      await entityVersionApi.restore(props.objId, v.id)
      emit('restored')
    }
    await loadVersions()
    activeVersionId.value = null
    previewText.value = ''
  } catch (e) {
    restoreErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    restoringId.value = null
  }
}

// ---- 下游影响（只报告，不生成） ----
const impacts = ref<ImpactRow[]>([])
const impactLoading = ref(false)
const impactErr = ref('')
const impactLoaded = ref(false)

async function loadImpact() {
  if (!props.objId || impactLoaded.value) return
  impactLoading.value = true
  impactErr.value = ''
  try {
    const r =
      props.kind === 'asset'
        ? await assetVersionApi.impact(props.objId)
        : await entityVersionApi.impact(props.objId)
    impacts.value = r.items
    impactLoaded.value = true
  } catch (e) {
    impactErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    impactLoading.value = false
  }
}

function selectTab(t: Tab) {
  tab.value = t
  if (t === 'impact') void loadImpact()
}

const changedCount = computed(
  () => impacts.value.filter((r) => r.status === 'upstream_changed').length,
)

watch(
  () => [props.kind, props.objId] as const,
  () => {
    activeVersionId.value = null
    previewText.value = ''
    previewErr.value = ''
    restoreErr.value = ''
    impacts.value = []
    impactLoaded.value = false
    impactErr.value = ''
    tab.value = 'history'
    void loadVersions()
  },
  { immediate: true },
)
</script>

<template>
  <div class="vh">
    <div class="tabs" role="tablist">
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'history'"
        :class="{ on: tab === 'history' }"
        @click="selectTab('history')"
      >
        <Icon name="clock" :size="12" /> 历史
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'impact'"
        :class="{ on: tab === 'impact' }"
        @click="selectTab('impact')"
      >
        <Icon name="link" :size="12" /> 影响
        <span v-if="impactLoaded && changedCount > 0" class="dot">{{
          changedCount
        }}</span>
      </button>
    </div>

    <!-- ===== 历史 ===== -->
    <div v-if="tab === 'history'" class="pane">
      <div v-if="listLoading" class="muted pad">加载中…</div>
      <div v-else-if="listErr" class="err-text pad">{{ listErr }}</div>
      <div v-else-if="!versions.length" class="muted pad">
        暂无历史版本（编辑或导入后生成）。
      </div>
      <ul v-else class="vlist">
        <li
          v-for="v in versions"
          :key="v.id"
          class="vrow"
          :class="{ cur: v.isCurrent }"
        >
          <div class="vmain">
            <button
              type="button"
              class="vhead"
              :aria-expanded="activeVersionId === v.id"
              @click="openVersion(v)"
            >
              <span class="rev mono">#{{ v.revision }}</span>
              <span class="src">{{ sourceText(v.source) }}</span>
              <span v-if="v.isCurrent" class="tag-cur">当前</span>
              <span class="when mono">{{ fmtTime(v.createdAt) }}</span>
              <Icon
                :name="
                  activeVersionId === v.id ? 'chevron-down' : 'chevron-right'
                "
                :size="11"
                class="caret"
              />
            </button>
            <span v-if="v.label" class="label">{{ v.label }}</span>
          </div>
          <button
            v-if="!v.isCurrent"
            type="button"
            class="btn sm"
            :disabled="restoringId !== null"
            title="还原到此版本（生成新版本，保留历史，不动下游）"
            @click="doRestore(v)"
          >
            <Icon name="undo" :size="12" />
            {{ restoringId === v.id ? '还原中…' : '还原' }}
          </button>
          <span v-else class="ph" />
        </li>
      </ul>
      <div v-if="restoreErr" class="err-text pad">
        还原失败：{{ restoreErr }}
      </div>
      <div v-if="activeVersionId !== null" class="preview">
        <div v-if="previewLoading" class="muted pad">读取版本内容…</div>
        <div v-else-if="previewErr" class="err-text pad">{{ previewErr }}</div>
        <pre v-else class="prebox">{{ previewText }}</pre>
      </div>
    </div>

    <!-- ===== 影响（只报告） ===== -->
    <div v-else class="pane">
      <p class="hint">
        以下为消费本{{
          kind === 'asset' ? '资产' : '实体'
        }}的执行清单。修改内容<strong>不会自动生成或返修</strong>下游，
        请据此自行决定重跑范围。
      </p>
      <div v-if="impactLoading" class="muted pad">加载中…</div>
      <div v-else-if="impactErr" class="err-text pad">{{ impactErr }}</div>
      <div v-else-if="!impacts.length" class="muted pad">
        暂无下游消费记录。
      </div>
      <ul v-else class="ilist">
        <li
          v-for="r in impacts"
          :key="r.snapshotId + ':' + r.role + ':' + (r.shotId ?? '')"
          class="irow"
          :class="`st-${r.status}`"
        >
          <div class="iline">
            <span class="istat">{{ statusText(r.status) }}</span>
            <span class="iexec">{{ execText(r.execKind) }}</span>
            <span class="imono mono">
              <template v-if="r.runId != null">run#{{ r.runId }}</template>
              <template v-else-if="r.taskId != null"
                >task#{{ r.taskId }}</template
              >
              <template v-else-if="r.stepId != null"
                >step#{{ r.stepId }}</template
              >
            </span>
            <span v-if="r.shotId" class="ishot mono">镜头 {{ r.shotId }}</span>
          </div>
          <div class="iline sub">
            <span
              >输入：{{ roleText(r.role) }} ·
              {{ r.used ? '已使用' : '已跳过' }}</span
            >
            <span v-if="r.status === 'no_history'">版本指针缺失（旧数据）</span>
            <span v-else
              >捕获 #{{ r.versionRevision ?? '—' }} / 当前 #{{
                r.currentRevision
              }}</span
            >
            <span class="mono">{{ fmtTime(r.frozenAt) }}</span>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.vh {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}

.tabs button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: none;
  color: var(--text-3);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 7px;
  cursor: pointer;
  transition: all 0.15s;
}

.tabs button:hover {
  color: var(--text);
  background: var(--hover);
}

.tabs button.on {
  color: var(--accent);
  background: var(--chip-bg);
  font-weight: 600;
}

.dot {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: #d97706;
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}

.pane {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pad {
  padding: 8px 2px;
  font-size: 12px;
}

.vlist,
.ilist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.vrow {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 6px 4px 10px;
  background: var(--code-bg);
}

.vrow.cur {
  border-color: rgb(99 102 241 / 45%);
}

.vmain {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.vhead {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  padding: 3px 0;
  font-size: 12px;
  text-align: left;
}

.rev {
  font-weight: 700;
  color: var(--text);
}

.src {
  color: var(--text-2);
}

.when {
  color: var(--text-3);
  font-size: 11px;
  margin-left: auto;
}

.caret {
  color: var(--text-3);
  flex: none;
}

.tag-cur {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent-weak, rgb(99 102 241 / 16%));
  color: var(--accent);
}

.label {
  font-size: 11px;
  color: var(--text-3);
  padding-left: 2px;
  word-break: break-all;
}

.ph {
  width: 4px;
  flex: none;
}

.preview {
  border-top: 1px dashed var(--border);
  padding-top: 6px;
}

.prebox {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 11.5px;
  line-height: 1.6;
  color: #c7d3e6;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: 260px;
  overflow-y: auto;
}

.hint {
  font-size: 11.5px;
  color: var(--text-3);
  margin: 0;
  line-height: 1.6;
}

.hint strong {
  color: var(--text-2);
}

.irow {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: 8px;
  padding: 6px 10px;
  background: var(--code-bg);
}

.irow.st-upstream_changed {
  border-left-color: #d97706;
}

.irow.st-current {
  border-left-color: var(--ok, #16a34a);
}

.irow.st-no_history {
  border-left-color: var(--text-3);
}

.iline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  flex-wrap: wrap;
}

.iline.sub {
  color: var(--text-3);
  font-size: 11px;
}

.istat {
  font-weight: 600;
  color: var(--text);
}

.st-upstream_changed .istat {
  color: #d97706;
}

.st-current .istat {
  color: var(--ok, #16a34a);
}

.iexec {
  color: var(--text-2);
}

.imono,
.ishot {
  color: var(--text-3);
}

.ishot {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
}
</style>
