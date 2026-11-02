<script setup lang="ts">
/**
 * M70 影响面板（brief 11.3）：直接 / 间接 / 缺证三区，链接真实 run 与版本；
 * prepared / 完成 / 未知 / 历史缺证以文字+徽章区分，不只靠颜色。
 */
import { onMounted, ref } from 'vue'
import { continuityApi } from '../../../lib/api/continuity'
import { ApiError } from '../../../lib/api/core'
import type { ContinuityImpactRow } from '../../../lib/types/continuity'

const props = defineProps<{ projectId: number; recordId: number }>()

const direct = ref<ContinuityImpactRow[]>([])
const indirect = ref<ContinuityImpactRow[]>([])
const unknownRows = ref<ContinuityImpactRow[]>([])
const loading = ref(false)
const err = ref('')

async function load() {
  loading.value = true
  err.value = ''
  try {
    const r = await continuityApi.impact(props.projectId, props.recordId)
    direct.value = r.direct
    indirect.value = r.indirect
    unknownRows.value = r.unknown
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())

function stateText(row: ContinuityImpactRow): string {
  if (row.state === 'prepared') return '已准备未派发'
  if (row.state === 'completed') return '已完成消费'
  if (row.state === 'unknown') return '结果未知（可能已计费）'
  if (row.kind === 'entry' && row.state === 'confirmed') return '已确认登记'
  return row.state
}

function reasonText(row: ContinuityImpactRow): string {
  if (row.reason === 'history_unavailable') return '历史证据缺失'
  return row.reason
}
</script>

<template>
  <div class="im-box">
    <div class="im-head">
      <span class="im-sec">下游影响</span>
      <button class="btn sm" :disabled="loading" @click="load">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
    </div>
    <div v-if="err" class="err-text">{{ err }}</div>
    <template v-else>
      <div
        v-if="!direct.length && !indirect.length && !unknownRows.length"
        class="muted"
      >
        暂无下游引用。
      </div>
      <div
        v-for="sec in [
          { title: '直接消费（使用本记录承接包的 run）', rows: direct },
          { title: '间接影响（承接包 basis 链下游登记）', rows: indirect },
          { title: '缺证 / 未知（历史不可解释）', rows: unknownRows },
        ]"
        :key="sec.title"
        v-show="sec.rows.length"
        class="im-sec-box"
      >
        <div class="im-sec">{{ sec.title }}（{{ sec.rows.length }}）</div>
        <div v-for="row in sec.rows" :key="row.recordId" class="im-row">
          <span
            class="badge"
            :class="
              row.state === 'unknown'
                ? 'running'
                : row.state === 'completed'
                  ? 'succeeded'
                  : ''
            "
          >
            {{ stateText(row) }}
          </span>
          <span class="mono muted"
            >第 {{ row.unitOrdinal }} 集 ·
            {{ row.kind === 'use' ? '调用证据' : '台账' }} #{{
              row.recordId
            }}</span
          >
          <RouterLink
            v-if="row.runId"
            class="im-link"
            :to="`/runs/${row.runId}`"
            >Run #{{ row.runId }}</RouterLink
          >
          <RouterLink
            v-if="row.document"
            class="im-link"
            :to="`/projects/${props.projectId}?tab=assets&asset=${row.document.assetId}&version=${row.document.versionId}`"
            >版本 #{{ row.document.versionId }}</RouterLink
          >
          <span
            v-if="reasonText(row) && reasonText(row) !== row.state"
            class="muted im-reason"
            >{{ reasonText(row) }}</span
          >
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.im-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.im-head {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}
.im-sec {
  font-size: 12.5px;
  font-weight: 600;
}
.im-sec-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.im-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
  border-top: 1px dashed var(--border);
  flex-wrap: wrap;
}
.im-link {
  color: var(--accent-h);
  font-size: 12px;
}
.im-reason {
  font-size: 11.5px;
}
</style>
