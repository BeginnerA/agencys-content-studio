<script setup lang="ts">
import { onMounted, ref, computed, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Modal from '../components/Modal.vue'
import AssetGrid from '../components/AssetGrid.vue'
import RunFormModal from '../components/RunFormModal.vue'
import { projectApi, uploadFiles } from '../lib/api'
import type { Asset, ProjectDetail, Run } from '../lib/types'
import { runStatus, fmtTime, fmtMs, purposeText, stepStatus } from '../lib/format'
import { getSocket } from '../lib/socket'
import type { StudioEventMap } from '../lib/socket'

const route = useRoute()
const router = useRouter()
const projectId = Number(route.params.id)

const project = ref<ProjectDetail | null>(null)
const runs = ref<Run[]>([])
const assets = ref<Asset[]>([])
const loading = ref(true)
const err = ref('')

const showRunForm = ref(false)
const showUpload = ref(false)
const purposeFilter = ref('all')
const uploadPurpose = ref('source')
const uploadFilesSel = ref<File[]>([])
const uploading = ref(false)
const uploadErr = ref('')

const purposes = computed(() => {
  const set = new Set(assets.value.map((a) => a.purpose))
  return ['all', ...set]
})

const filteredAssets = computed(() =>
  purposeFilter.value === 'all' ? assets.value : assets.value.filter((a) => a.purpose === purposeFilter.value),
)

async function loadAll() {
  loading.value = true
  err.value = ''
  try {
    const [p, r, a] = await Promise.all([
      projectApi.detail(projectId),
      projectApi.runs(projectId),
      projectApi.assets(projectId, '?limit=200'),
    ])
    project.value = p
    runs.value = r.items
    assets.value = a.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void loadAll()
  const s = getSocket()
  s.emit('join', `project:${projectId}`)
  const onEvent = () => void loadAll()
  s.on('run.step', onEvent as never)
  s.on('run.completed', onEvent as never)
  s.on('run.failed', onEvent as never)
  onBeforeUnmount(() => {
    s.off('run.step', onEvent as never)
    s.off('run.completed', onEvent as never)
    s.off('run.failed', onEvent as never)
    s.emit('leave', `project:${projectId}`)
  })
})

function onRunCreated(runId: number) {
  showRunForm.value = false
  void loadAll()
  router.push(`/runs/${runId}`)
}

function onUploadChange(e: Event) {
  const input = e.target as HTMLInputElement
  uploadFilesSel.value = input.files ? Array.from(input.files) : []
}

async function doUpload() {
  if (!uploadFilesSel.value.length) return
  uploading.value = true
  uploadErr.value = ''
  try {
    await uploadFiles(projectId, uploadPurpose.value, uploadFilesSel.value)
    uploadFilesSel.value = []
    showUpload.value = false
    await loadAll()
  } catch (e) {
    uploadErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    uploading.value = false
  }
}

/** runs 行内错误摘要 */
function errOf(r: Run): string {
  if (r.status !== 'failed') return ''
  const s = r.error ?? ''
  return s.length > 90 ? s.slice(0, 90) + '…' : s
}
</script>

<template>
  <div>
    <div class="page-h">
      <RouterLink to="/" class="muted" style="font-size: 13px">← 项目</RouterLink>
      <h1>{{ project?.name ?? `项目 #${projectId}` }}</h1>
      <span v-if="project" class="badge completed">active</span>
      <span v-if="project?.templateKey" class="sub mono">{{ project.templateKey }}</span>
      <div style="margin-left: auto; display: flex; gap: 8px">
        <button class="btn" @click="showUpload = true">↑ 上传素材</button>
        <button class="btn primary" @click="showRunForm = true">▶ 启动流水线</button>
      </div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading && !project" class="empty">加载中…</div>

    <template v-if="project">
      <div class="brief muted">{{ project.brief }}</div>

      <!-- 运行列表 -->
      <div class="panel block">
        <div class="bh">
          <span class="bt">流水线运行</span>
          <span class="muted">{{ runs.length }} 次</span>
        </div>
        <table class="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>状态</th>
              <th>模板</th>
              <th>结果摘要</th>
              <th>开始 / 结束</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in [...runs].reverse()" :key="r.id" class="rrow" @click="router.push(`/runs/${r.id}`)">
              <td class="mono">{{ r.id }}</td>
              <td><span class="badge" :class="r.status">{{ runStatus(r.status).text }}</span></td>
              <td class="mono" style="font-size: 12px">{{ r.templateKey }}</td>
              <td class="sum">
                <span v-if="errOf(r)" class="em" :title="r.error ?? ''">{{ errOf(r) }}</span>
                <span v-else-if="r.summary?.durationMs" class="muted">共 {{ r.summary.stepCount }} 步 · {{ fmtMs(r.summary.durationMs) }}</span>
                <span v-else-if="r.status === 'running'" class="muted run-flash">执行中…</span>
                <span v-else class="muted">—</span>
              </td>
              <td class="muted" style="white-space: nowrap">
                {{ fmtTime(r.startedAt ?? r.createdAt) }}
                <template v-if="r.completedAt">→ {{ fmtTime(r.completedAt) }}</template>
              </td>
              <td><span class="muted">详情 →</span></td>
            </tr>
            <tr v-if="!runs.length">
              <td colspan="6">
                <div class="empty" style="padding: 18px 0">尚未运行——点右上「启动流水线」开始</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 资产浏览 -->
      <div class="panel block">
        <div class="bh">
          <span class="bt">资产</span>
          <span class="muted">{{ assets.length }} 个</span>
          <div style="margin-left: auto; display: flex; gap: 8px; align-items: center">
            <select v-model="purposeFilter" style="width: 150px">
              <option value="all">全部用途</option>
              <template v-for="p in purposes" :key="p">
                <option v-if="p !== 'all'" :value="p">
                  {{ purposeText(p) }}
                </option>
              </template>
            </select>
            <button class="btn sm" @click="loadAll()">刷新</button>
          </div>
        </div>
        <AssetGrid :assets="filteredAssets" :loading="loading" />
      </div>
    </template>

    <!-- 启动 run -->
    <RunFormModal v-if="showRunForm" :project-id="projectId" @done="onRunCreated" @close="showRunForm = false" />

    <!-- 上传素材 -->
    <Modal v-if="showUpload" title="上传素材（入库为资产，sha256 去重）" :width="520" @close="showUpload = false">
      <label class="fld">
        用途
        <select v-model="uploadPurpose">
          <option value="source">素材 source（设定/参考底稿）</option>
          <option value="reference_character">角色参考 reference_character</option>
          <option value="brief">题材简报 brief</option>
          <option value="archive">归档 archive</option>
        </select>
      </label>
      <label class="fld">
        文件（可多选）
        <input type="file" multiple @change="onUploadChange" />
      </label>
      <div v-if="uploadFilesSel.length" class="muted">{{ uploadFilesSel.length }} 个文件待上传</div>
      <div v-if="uploadErr" class="err-text">{{ uploadErr }}</div>
      <template #footer>
        <button class="btn" @click="showUpload = false">取消</button>
        <button class="btn primary" :disabled="uploading || !uploadFilesSel.length" @click="doUpload">
          {{ uploading ? '上传中…' : '上传' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.brief {
  margin: -6px 0 16px;
}

.block {
  padding: 12px 16px 16px;
  margin-bottom: 18px;
}

.bh {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.bt {
  font-weight: 600;
  font-size: 14px;
}

.rrow {
  cursor: pointer;
}

.sum {
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.em {
  color: var(--bad);
}

.run-flash {
  animation: blink 1.2s infinite;
}

@keyframes blink {
  50% {
    opacity: 0.4;
  }
}
</style>
