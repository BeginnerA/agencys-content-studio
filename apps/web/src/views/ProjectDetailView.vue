<script setup lang="ts">
import { onMounted, ref, computed, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Modal from '../components/Modal.vue'
import Icon from '../components/Icon.vue'
import AssetGrid from '../components/AssetGrid.vue'
import RunFormModal from '../components/RunFormModal.vue'
import BatchFormModal from '../components/BatchFormModal.vue'
import PublishModal from '../components/PublishModal.vue'
import { batchApi, projectApi, publicationApi, uploadFiles } from '../lib/api'
import type { Asset, Batch, ProjectDetail, Publication, Run } from '../lib/types'
import { runStatus, fmtTime, fmtMs, purposeText, stepStatus, batchStatus, PLATFORM_TEXT } from '../lib/format'
import { getSocket, studioOff, studioOn } from '../lib/socket'

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

// [M4] 批次 + 发布记录
const showBatch = ref(false)
const batches = ref<Batch[]>([])
const pubs = ref<Publication[]>([])
const pubSummary = ref({ views: 0, interactions: 0 })
const showPublish = ref(false)
const editingPub = ref<Publication | null>(null)

/** 发布记录的资产名（复用已加载 assets；找不到回退 #id） */
function assetNameOf(id: number | null): string {
  if (id === null) return '—'
  return assets.value.find((a) => a.id === id)?.name ?? `#${id}`
}

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
    const [p, r, a, b, pub] = await Promise.all([
      projectApi.detail(projectId),
      projectApi.runs(projectId),
      projectApi.assets(projectId, '?limit=200'),
      batchApi.list(`?project_id=${projectId}`),
      publicationApi.list(`?project_id=${projectId}`),
    ])
    project.value = p
    runs.value = r.items
    assets.value = a.items
    batches.value = b.items
    pubs.value = pub.items
    pubSummary.value = pub.summary
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
  studioOn('run.step', onEvent)
  studioOn('run.completed', onEvent)
  studioOn('run.failed', onEvent)
  onBeforeUnmount(() => {
    studioOff('run.step', onEvent)
    studioOff('run.completed', onEvent)
    studioOff('run.failed', onEvent)
    s.emit('leave', `project:${projectId}`)
  })
})

function onRunCreated(runId: number) {
  showRunForm.value = false
  void loadAll()
  router.push(`/runs/${runId}`)
}

function onBatchCreated(batchId: number) {
  showBatch.value = false
  router.push(`/batches/${batchId}`)
}

function openPublish(pub: Publication | null) {
  editingPub.value = pub
  showPublish.value = true
}

async function removePub(pub: Publication) {
  if (!confirm(`删除这条发布记录（${PLATFORM_TEXT[pub.platform] ?? pub.platform}）？`)) return
  try {
    await publicationApi.remove(pub.id)
    await loadAll()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

function onPubSaved() {
  showPublish.value = false
  void loadAll()
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
      <RouterLink to="/" class="back"><Icon name="arrow-left" :size="14" /> 项目</RouterLink>
      <h1>{{ project?.name ?? `项目 #${projectId}` }}</h1>
      <span v-if="project" class="badge completed">active</span>
      <span v-if="project?.templateKey" class="sub mono">{{ project.templateKey }}</span>
      <div style="margin-left: auto; display: flex; gap: 8px">
        <button class="btn" @click="showUpload = true">
          <Icon name="upload" :size="14" /> 上传素材
        </button>
        <button class="btn" @click="showBatch = true">
          <Icon name="bolt" :size="14" /> 批量运行
        </button>
        <button class="btn primary" @click="showRunForm = true">
          <Icon name="bolt" :size="14" /> 启动流水线
        </button>
      </div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading && !project" class="empty">加载中…</div>

    <template v-if="project">
      <div class="brief muted">{{ project.brief }}</div>

      <!-- [M4] 批次 -->
      <div v-if="batches.length" class="panel block">
        <div class="bh">
          <span class="bt">批量运行（批次）</span>
          <span class="muted">{{ batches.length }} 个</span>
        </div>
        <table class="tbl">
          <thead>
            <tr>
              <th>名称</th>
              <th>状态</th>
              <th>进度</th>
              <th>成功 / 失败</th>
              <th>更新时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in batches" :key="b.id" class="rrow" @click="router.push(`/batches/${b.id}`)">
              <td>{{ b.name }}</td>
              <td><span class="badge" :class="batchStatus(b.status).cls">{{ batchStatus(b.status).text }}</span></td>
              <td class="mono">{{ b.finished }}/{{ b.total }}</td>
              <td class="mono">{{ b.succeeded }} / {{ b.failed }}</td>
              <td class="muted" style="white-space: nowrap">{{ fmtTime(b.updatedAt) }}</td>
              <td><span class="muted">详情 →</span></td>
            </tr>
          </tbody>
        </table>
      </div>

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
            <tr v-for="r in runs" :key="r.id" class="rrow" @click="router.push(`/runs/${r.id}`)">
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

      <!-- [M4] 发布记录 -->
      <div class="panel block">
        <div class="bh">
          <span class="bt">发布记录</span>
          <span class="muted">已发布 {{ pubs.length }} 条 · 播放 {{ pubSummary.views }} · 互动 {{ pubSummary.interactions }}</span>
          <button class="btn sm" style="margin-left: auto" @click="openPublish(null)">
            <Icon name="plus" :size="12" :stroke-width="2.2" /> 标记发布
          </button>
        </div>
        <table v-if="pubs.length" class="tbl">
          <thead>
            <tr>
              <th>平台</th>
              <th>资产</th>
              <th>日期</th>
              <th>播放 / 点赞 / 评论 / 收藏 / 转发</th>
              <th>链接</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pub in pubs" :key="pub.id">
              <td><span class="badge">{{ PLATFORM_TEXT[pub.platform] ?? pub.platform }}</span></td>
              <td class="muted">{{ assetNameOf(pub.assetId) }}</td>
              <td class="muted">{{ pub.publishedAt ? fmtTime(pub.publishedAt) : '—' }}</td>
              <td class="mono" style="font-size: 12px">
                {{ pub.metrics?.views ?? 0 }} / {{ pub.metrics?.likes ?? 0 }} / {{ pub.metrics?.comments ?? 0 }} /
                {{ pub.metrics?.favorites ?? 0 }} / {{ pub.metrics?.shares ?? 0 }}
              </td>
              <td>
                <a v-if="pub.url" :href="pub.url" target="_blank" rel="noopener"><Icon name="external" :size="12" /> 打开</a>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <div class="ops">
                  <button class="btn sm" @click="openPublish(pub)">编辑</button>
                  <button class="btn sm danger" @click="removePub(pub)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty" style="padding: 16px 0">还没有发布记录——发布后回来登记，积累复盘数据</div>
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

    <!-- [M4] 批量创建 -->
    <BatchFormModal v-if="showBatch" :project-id="projectId" @done="onBatchCreated" @close="showBatch = false" />

    <!-- [M4] 标记发布 / 编辑回填 -->
    <PublishModal
      v-if="showPublish"
      :project-id="projectId"
      :asset-options="assets.map((a) => ({ id: a.id, name: a.name }))"
      :publication="editingPub"
      @done="onPubSaved"
      @close="showPublish = false"
    />
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

.ops {
  display: flex;
  gap: 6px;
}

@keyframes blink {
  50% {
    opacity: 0.4;
  }
}
</style>
