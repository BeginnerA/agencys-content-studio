<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import type { Asset, GenTask } from '../lib/types'
import { assetApi, taskApi } from '../lib/api'
import { taskStatus, fmtTime } from '../lib/format'
import AssetPreviewer from './AssetPreviewer.vue'
import { studioOff, studioOn } from '../lib/socket'
import type { StudioEventMap } from '../lib/socket'

const props = defineProps<{ runId: number; active: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const tasks = ref<GenTask[]>([])
const loading = ref(false)
const err = ref('')
let timer: number | undefined

async function load() {
  loading.value = true
  err.value = ''
  try {
    const data = await taskApi.list(`?run_id=${props.runId}&limit=200`)
    tasks.value = data.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const doneCount = computed(() => tasks.value.filter((t) => t.status === 'succeeded').length)
const sum = computed(() => ({
  total: tasks.value.length,
  done: doneCount.value,
  failed: tasks.value.filter((t) => t.status === 'failed').length,
  processing: tasks.value.filter((t) => t.status === 'processing').length,
}))

async function retry(t: GenTask) {
  await taskApi.retry(t.id)
  emit('changed')
  load()
}

async function cancel(t: GenTask) {
  await taskApi.cancel(t.id)
  emit('changed')
  load()
}

// ===== 结果资产预览（统一 AssetPreviewer） =====
const previewAsset = ref<Asset | null>(null)
const previewBusyId = ref<number | null>(null)

async function openPreview(t: GenTask) {
  const ra = t.resultAsset
  if (!ra || previewBusyId.value !== null) return
  previewBusyId.value = ra.id
  err.value = ''
  try {
    const { asset } = await assetApi.detail(ra.id)
    previewAsset.value = asset
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewBusyId.value = null
  }
}

/** [M2] video 任务处理中：provider 侧异步轮询（转圈 + 第 N 次尝试文案） */
function isVideoPoll(t: GenTask): boolean {
  return t.kind === 'video' && t.status === 'processing'
}

function statusText(t: GenTask): string {
  if (isVideoPoll(t)) return `生成中（第 ${Math.max(1, t.attempts)} 次尝试）`
  return taskStatus(t.status).text
}

function onTaskUpdated(p: StudioEventMap['task.updated']) {
  const t = tasks.value.find((x) => x.id === p.taskId)
  if (t) {
    t.status = p.status as GenTask['status']
    emit('changed')
  }
}

onMounted(() => {
  load()
  studioOn('task.updated', onTaskUpdated)
  timer = window.setInterval(() => {
    if (props.active || tasks.value.some((t) => t.status === 'processing')) load()
  }, 3000)
})

watch(
  () => props.runId,
  () => load(),
)

onBeforeUnmount(() => {
  studioOff('task.updated', onTaskUpdated)
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="panel tpanel">
    <div class="thead">
      <div class="t">生成任务</div>
      <div class="stat muted" v-if="sum.total">
        共 {{ sum.total }} · 成功 {{ sum.done }} · 失败 {{ sum.failed }} · 处理中 {{ sum.processing }}
      </div>
      <button class="btn sm" :disabled="loading" @click="load">刷新</button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading && !tasks.length" class="empty">加载中…</div>
    <div v-else-if="!tasks.length" class="empty">该运行没有任务（文本类步骤同步执行，不产生 task）</div>

    <div v-else class="list">
      <div v-for="t in tasks" :key="t.id" class="row">
        <span class="badge" :class="[t.status, { 'has-spin': isVideoPoll(t) }]">
          <span v-if="isVideoPoll(t)" class="spin" aria-hidden="true"></span>
          {{ statusText(t) }}
        </span>
        <span class="shot mono">{{ (t.params as Record<string, unknown> | null)?.['shotId'] ?? ('#' + t.id) }}</span>
        <span class="pr" :title="t.prompt">{{ t.prompt }}</span>
        <span v-if="t.errorMsg" class="em mono" :title="t.errorMsg">{{ t.errorMsg }}</span>
        <span v-else-if="t.resultAsset" class="ok-txt">→ {{ t.resultAsset.name }}</span>
        <span class="at muted">{{ fmtTime(t.completedAt ?? t.updatedAt) }} · 尝试 {{ t.attempts }}</span>
        <span class="ops">
          <button
            v-if="t.resultAsset"
            class="mini"
            :disabled="previewBusyId !== null"
            :title="previewBusyId === t.resultAsset.id ? '正在载入资产…' : '内联预览结果资产'"
            @click="openPreview(t)"
          >
            {{ previewBusyId === t.resultAsset.id ? '载入中…' : '查看' }}
          </button>
          <button v-if="t.status === 'failed'" class="btn sm" @click="retry(t)">重试</button>
          <button v-if="t.status === 'processing'" class="btn sm" @click="cancel(t)">取消</button>
        </span>
      </div>
    </div>

    <AssetPreviewer v-if="previewAsset" :assets="[previewAsset]" @close="previewAsset = null" />
  </div>
</template>

<style scoped>
.tpanel {
  padding: 10px 14px;
}

.thead {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.thead .t {
  font-weight: 600;
}

.thead .btn {
  margin-left: auto;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 300px;
  overflow-y: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 6px;
  font-size: 12px;
}

.row:hover {
  background: var(--hover);
}

.shot {
  font-size: 11px;
  color: var(--text-2);
  flex: none;
  width: 42px;
}

.pr {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.em {
  color: var(--bad);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ok-txt {
  color: var(--ok);
  flex: none;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.at {
  flex: none;
  white-space: nowrap;
}

.ops {
  flex: none;
  display: flex;
  gap: 6px;
  align-items: center;
}

.mini {
  font-size: 12px;
  border: none;
  background: none;
  color: var(--accent-h);
  cursor: pointer;
  padding: 0;
  transition: color 0.15s;
}

.mini:hover {
  color: #fff;
  text-decoration: underline;
}

.mini:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  text-decoration: none;
}

.badge {
  flex: none;
  min-width: 52px;
  justify-content: center;
}

/* [M2] video 轮询转圈（替换 badge 静点） */
.badge.has-spin::before {
  display: none;
}

.spin {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  animation: tspin 0.9s linear infinite;
}

@keyframes tspin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
