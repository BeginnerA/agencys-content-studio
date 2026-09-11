<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { batchApi, exportApi } from '../lib/api'
import type { BatchDetail } from '../lib/types'
import { runStatus, fmtTime, fmtCost, batchStatus, inputSummary } from '../lib/format'
import { getSocket, studioOff, studioOn } from '../lib/socket'
import type { StudioEventMap } from '../lib/socket'

const route = useRoute()
const router = useRouter()
const batchId = Number(route.params.id)

const detail = ref<BatchDetail | null>(null)
const loading = ref(true)
const err = ref('')
const notice = ref('')
const cancelling = ref(false)
const exporting = ref(false)
const exportResult = ref<Array<{ runId: number; assetId: number; name: string }> | null>(null)

const batch = computed(() => detail.value?.batch ?? null)
const runs = computed(() => detail.value?.runs ?? [])
const running = computed(() => batch.value?.status === 'running')
const progress = computed(() => {
  const b = batch.value
  if (!b || !b.total) return 0
  return Math.round((b.finished / b.total) * 100)
})

let projectJoined = false
let timer: number | undefined

/** 仅运行中批次保留 3s 轮询兜底（事件丢失时收敛）；终态自动停表 */
function syncTimer() {
  if (running.value && timer === undefined) {
    timer = window.setInterval(() => void load(), 3000)
  } else if (!running.value && timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

async function load() {
  try {
    detail.value = await batchApi.detail(batchId)
    if (!projectJoined) {
      // batch.updated / run.* 事件经 project room 投递（§F 桥接）
      getSocket().emit('join', `project:${detail.value.batch.projectId}`)
      projectJoined = true
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function refresh() {
  void load().then(syncTimer)
}

// batch.updated：按 batchId 过滤
function onBatchUpdated(p: StudioEventMap['batch.updated']) {
  if (p.batchId !== batchId) return
  refresh()
}
// run 事件：仅批内 run 响应（runs 集合过滤；加载前的早期事件由 batch.updated + 轮询兜底）
function onRunEvent(p: StudioEventMap['run.step'] | StudioEventMap['run.completed'] | StudioEventMap['run.failed']) {
  if (!runs.value.some((r) => r.id === p.runId)) return
  refresh()
}

onMounted(() => {
  refresh()
  studioOn('batch.updated', onBatchUpdated)
  studioOn('run.step', onRunEvent)
  studioOn('run.completed', onRunEvent)
  studioOn('run.failed', onRunEvent)
  onBeforeUnmount(() => {
    studioOff('batch.updated', onBatchUpdated)
    studioOff('run.step', onRunEvent)
    studioOff('run.completed', onRunEvent)
    studioOff('run.failed', onRunEvent)
    if (projectJoined && detail.value) getSocket().emit('leave', `project:${detail.value.batch.projectId}`)
    if (timer !== undefined) clearInterval(timer)
  })
})

async function cancelBatch() {
  if (!confirm(`取消批次 #${batchId}？批内未完成的 run 将全部取消（执行中的在当前步骤后停止）。`)) return
  cancelling.value = true
  err.value = ''
  try {
    await batchApi.cancel(batchId)
    refresh()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    cancelling.value = false
  }
}

async function exportAll() {
  exporting.value = true
  err.value = ''
  notice.value = ''
  exportResult.value = null
  try {
    const res = await batchApi.exportAll(batchId)
    exportResult.value = res.items
    const skipped = res.skipped.length
    notice.value = `已生成 ${res.items.length} 个发布包${skipped ? `，跳过 ${skipped} 个无产物 run` : ''}`
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    exporting.value = false
  }
}

/** 行内错误摘要 */
function errOf(s: string | null): string {
  if (!s) return ''
  return s.length > 64 ? s.slice(0, 64) + '…' : s
}
</script>

<template>
  <div>
    <div class="page-h">
      <RouterLink :to="batch ? `/projects/${batch.projectId}` : '/'" class="back">
        <Icon name="arrow-left" :size="14" /> 项目
      </RouterLink>
      <h1>{{ batch?.name ?? `批次 #${batchId}` }}</h1>
      <span v-if="batch" class="badge" :class="batchStatus(batch.status).cls">{{ batchStatus(batch.status).text }}</span>
      <span v-if="batch" class="sub mono">{{ batch.templateKey }}</span>
      <div style="margin-left: auto; display: flex; gap: 8px">
        <button v-if="running" class="btn danger" :disabled="cancelling" @click="cancelBatch">
          {{ cancelling ? '取消中…' : '取消批次' }}
        </button>
        <button class="btn primary" :disabled="exporting || !runs.length" @click="exportAll">
          <Icon name="download" :size="14" /> {{ exporting ? '打包中…' : '批量导出' }}
        </button>
      </div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading && !detail" class="empty">加载中…</div>

    <template v-if="batch">
      <div class="panel block">
        <div class="bh">
          <span class="bt">进度</span>
          <span class="muted mono">完成 {{ batch.finished }}/{{ batch.total }} · 成功 {{ batch.succeeded }} · 失败 {{ batch.failed }}</span>
          <span class="muted mono" style="margin-left: auto">并发上限 {{ batch.schedule.max_concurrent ?? 1 }}</span>
        </div>
        <div class="ptrack" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100">
          <div class="pfill" :style="{ width: progress + '%' }" />
        </div>
      </div>

      <div v-if="notice" class="notice">
        <span class="nt">{{ notice }}</span>
        <a
          v-for="it in exportResult ?? []"
          :key="it.assetId"
          class="chip dl"
          :href="exportApi.fileUrl(it.assetId, true)"
        >
          <Icon name="download" :size="12" /> {{ it.name }}
        </a>
      </div>

      <div class="panel block">
        <div class="bh">
          <span class="bt">批次运行</span>
          <span class="muted">{{ runs.length }} 个</span>
        </div>
        <table class="tbl">
          <thead>
            <tr>
              <th>序号</th>
              <th>状态</th>
              <th>输入摘要</th>
              <th>成本</th>
              <th>开始 / 结束</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id" class="rrow" @click="router.push(`/runs/${r.id}`)">
              <td class="mono">#{{ r.batchSeq ?? '—' }}</td>
              <td><span class="badge" :class="r.status">{{ runStatus(r.status).text }}</span></td>
              <td class="sum">
                <span v-if="r.error" class="em" :title="r.error">{{ errOf(r.error) }}</span>
                <span v-else class="muted">{{ inputSummary(r.input) }}</span>
              </td>
              <td class="mono">{{ fmtCost(r.cost) }}</td>
              <td class="muted" style="white-space: nowrap">
                {{ fmtTime(r.startedAt ?? r.createdAt) }}
                <template v-if="r.completedAt">→ {{ fmtTime(r.completedAt) }}</template>
              </td>
              <td><span class="muted">详情 →</span></td>
            </tr>
            <tr v-if="!runs.length">
              <td colspan="6"><div class="empty" style="padding: 18px 0">批次内还没有 run</div></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.block {
  padding: 12px 16px 16px;
  margin-bottom: 16px;
}

.bh {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.bt {
  font-weight: 600;
  font-size: 14px;
}

.ptrack {
  height: 8px;
  border-radius: 999px;
  background: var(--chip-bg);
  overflow: hidden;
}

.pfill {
  height: 100%;
  border-radius: 999px;
  background: var(--grad-brand);
  transition: width 0.3s ease-out;
}

.notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--ok);
  background: var(--ok-weak);
  border: 1px solid rgb(34 197 94 / 24%);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 16px;
}

.dl {
  color: var(--text);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.dl:hover {
  text-decoration: none;
  border-color: rgb(99 102 241 / 45%);
}

.rrow {
  cursor: pointer;
}

.sum {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.em {
  color: var(--bad);
}
</style>
