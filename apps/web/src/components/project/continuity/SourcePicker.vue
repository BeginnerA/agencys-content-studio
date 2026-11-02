<script setup lang="ts">
/**
 * M70 来源选择器（brief 11.3）：展示真实步骤/版本/继承与可确认原因；
 * 未捕获版本（versionId=null）的按钮发 snapshot（免费 POST），绝不用 GET 产生副作用。
 */
import { computed, ref } from 'vue'
import { continuityApi } from '../../../lib/api/continuity'
import { ApiError } from '../../../lib/api/core'
import type { SourceCandidate, SourcePick } from '../../../lib/types/continuity'

const props = defineProps<{
  projectId: number
  episodeId: number
  sources: SourceCandidate[]
}>()
const emit = defineEmits<{
  picked: [pick: SourcePick, candidate: SourceCandidate]
  captured: []
}>()

const selectedRun = ref<number | null>(null)
const selectedVersion = ref<number | null>(null)
const snapshotBusy = ref<Record<number, boolean>>({})
const snapError = ref('')
const err = computed(() => snapError.value)

const selected = computed<SourceCandidate | null>(
  () => props.sources.find((s) => s.runId === selectedRun.value) ?? null,
)

const selectedPick = computed<SourcePick | null>(() => {
  const s = selected.value
  if (!s) return null
  const versionId = selectedVersion.value ?? s.versionId
  if (versionId === null) return null
  return { runId: s.runId, stepId: s.stepId, assetId: s.assetId, versionId }
})

function choose(s: SourceCandidate) {
  selectedRun.value = s.runId
  selectedVersion.value = s.versionId
  snapError.value = ''
  const pick = selectedPick.value
  if (pick) emit('picked', pick, s)
}

function chooseVersion(v: { versionId: number; hash: string }) {
  if (!selected.value) return
  selectedVersion.value = v.versionId
  snapError.value = ''
  emit(
    'picked',
    {
      runId: selected.value.runId,
      stepId: selected.value.stepId,
      assetId: selected.value.assetId,
      versionId: v.versionId,
    },
    selected.value,
  )
}

/** 版本按钮：先选中该来源再选版本（顺序依赖 chooseVersion 读 selected）。 */
function pickVersion(
  s: SourceCandidate,
  v: { versionId: number; hash: string },
) {
  choose(s)
  chooseVersion(v)
}

/** 未捕获版本：发 snapshot（免费），返回精确版本后自动选中（不作批准）。 */
async function doSnapshot(s: SourceCandidate) {
  snapshotBusy.value[s.runId] = true
  snapError.value = ''
  try {
    const r = await continuityApi.snapshot(props.projectId, props.episodeId, {
      runId: s.runId,
      stepId: s.stepId,
      assetId: s.assetId,
      seenHash: s.currentHash,
    })
    selectedRun.value = s.runId
    selectedVersion.value = r.source.versionId
    emit(
      'picked',
      {
        runId: s.runId,
        stepId: s.stepId,
        assetId: s.assetId,
        versionId: r.source.versionId,
      },
      s,
    )
    emit('captured')
  } catch (e) {
    snapError.value = e instanceof Error ? e.message : String(e)
  } finally {
    snapshotBusy.value[s.runId] = false
  }
}
</script>

<template>
  <div class="sp-box">
    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="!sources.length" class="muted">
      本项目还没有可作来源的剧本产物（先跑出 write_script 产物）。
    </div>
    <div
      v-for="s in sources"
      :key="`${s.runId}-${s.stepId}`"
      class="sp-row"
      :class="{ sel: selectedRun === s.runId }"
    >
      <button class="sp-main" @click="choose(s)">
        <span class="sp-title">{{ s.title || s.stepKey }}</span>
        <span class="muted mono sp-meta"
          >Run #{{ s.runId }} · {{ s.stepKey
          }}<template v-if="s.inheritedViaRunId">
            · 继承自 #{{ s.inheritedViaRunId }}</template
          ></span
        >
        <span class="badge" :class="s.confirmable ? 'succeeded' : 'running'">
          {{ s.confirmable ? '可确认' : '不可确认' }}
        </span>
      </button>
      <div v-if="!s.confirmable && s.reasons.length" class="sp-reasons muted">
        {{ s.reasons.join('；') }}
      </div>
      <div class="sp-vers">
        <button
          v-for="v in s.versions"
          :key="v.versionId"
          class="btn sm"
          :class="{ primary: selectedVersion === v.versionId }"
          :title="`版本 #${v.versionId}（${v.hash.slice(0, 10)}…）`"
          @click="pickVersion(s, v)"
        >
          v{{ v.versionId }}
        </button>
        <button
          v-if="s.versionId === null"
          class="btn sm"
          :disabled="snapshotBusy[s.runId] === true"
          @click="doSnapshot(s)"
        >
          {{ snapshotBusy[s.runId] ? '捕获中…' : '捕获快照' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sp-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sp-row {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sp-row.sel {
  border-color: var(--accent-h);
}
.sp-main {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: none;
  cursor: pointer;
  padding: 0;
  text-align: left;
  font-family: inherit;
}
.sp-title {
  font-size: 13px;
  color: var(--text);
}
.sp-meta {
  font-size: 11.5px;
}
.sp-reasons {
  font-size: 11.5px;
}
.sp-vers {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
