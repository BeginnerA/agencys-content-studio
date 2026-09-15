<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import Modal from '../../components/common/Modal.vue'
import Icon from '../../components/common/Icon.vue'
import { memoryApi, projectApi } from '../../lib/api'
import { ApiError } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { MemoryItem, MemoryStatus, Project } from '../../lib/types'
import { fmtTime } from '../../lib/format'

const items = ref<MemoryItem[]>([])
const status = ref<MemoryStatus | null>(null)
const projects = ref<Project[]>([])
const loading = ref(true)
const busy = ref(false)
const err = ref('')
const hint = ref('')

// 筛选：'' = 全部 | 'global' = 仅全局 | `${id}` = 项目域
const q = ref('')
const typeFilter = ref('')
const projectFilter = ref('')

// 新建 / 编辑表单
const showForm = ref(false)
const form = reactive({
  id: 0,
  content: '',
  type: 'note',
  name: '',
  scope: 'project' as 'project' | 'global',
  projectId: 0,
})
const formErr = ref('')

const searching = computed(() => q.value.trim().length > 0)

function buildParams(): string {
  const sp = new URLSearchParams()
  if (projectFilter.value === 'global') sp.set('scope', 'global')
  else if (projectFilter.value) {
    sp.set('scope', 'project')
    sp.set('project_id', projectFilter.value)
  }
  if (typeFilter.value.trim()) sp.set('type', typeFilter.value.trim())
  if (searching.value) {
    sp.set('q', q.value.trim())
    sp.set('limit', '10')
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

async function load() {
  loading.value = true
  err.value = ''
  hint.value = ''
  try {
    const data = await memoryApi.list(buildParams())
    items.value = data.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadStatus() {
  try {
    status.value = await memoryApi.status()
  } catch {
    status.value = null
  }
}

onMounted(() => {
  void load()
  void loadStatus()
  projectApi
    .list()
    .then((d) => (projects.value = d.items))
    .catch(() => (projects.value = []))
})

function openNew() {
  form.id = 0
  form.content = ''
  form.type = 'note'
  form.name = ''
  form.scope = projectFilter.value && projectFilter.value !== 'global' ? 'project' : projectFilter.value === 'global' ? 'global' : 'project'
  form.projectId = projectFilter.value && projectFilter.value !== 'global' ? Number(projectFilter.value) : (projects.value[0]?.id ?? 0)
  formErr.value = ''
  showForm.value = true
}

function openEdit(it: MemoryItem) {
  form.id = it.id
  form.content = it.content
  form.type = it.type
  form.name = it.name ?? ''
  form.scope = it.scope
  form.projectId = it.projectId ?? 0
  formErr.value = ''
  showForm.value = true
}

async function save() {
  if (!form.content.trim()) {
    formErr.value = '请填写记忆内容'
    return
  }
  if (form.id === 0 && form.scope === 'project' && !form.projectId) {
    formErr.value = '请选择归属项目（或选择全局）'
    return
  }
  busy.value = true
  formErr.value = ''
  try {
    const body: Record<string, unknown> = {
      content: form.content.trim(),
      type: form.type.trim() || 'note',
      name: form.name.trim() || null,
    }
    if (form.id) {
      await memoryApi.update(form.id, body)
    } else {
      body.scope = form.scope
      if (form.scope === 'project') body.project_id = form.projectId
      await memoryApi.create(body)
    }
    showForm.value = false
    await load()
    await loadStatus()
  } catch (e) {
    formErr.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function removeItem(it: MemoryItem) {
  const ok = await confirmDialog({
    title: '删除记忆',
    message: `确认删除记忆 #${it.id}（${it.type}）？该操作不可撤销。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await memoryApi.remove(it.id)
    await load()
    await loadStatus()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function reindex() {
  busy.value = true
  err.value = ''
  try {
    const r = await memoryApi.reindex()
    hint.value = `索引重建完成：${r.rebuilt}/${r.total} 条（跳过 ${r.skipped}）`
    await loadStatus()
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function scopeText(it: MemoryItem): string {
  return it.scope === 'global' ? '全局' : `项目#${it.projectId}`
}
</script>

<template>
  <div>
    <div class="page-h">
      <h1>记忆</h1>
      <span class="sub">{{ items.length }} 条</span>
      <div style="margin-left: auto; display: flex; gap: 8px">
        <button class="btn" :disabled="busy" @click="reindex">
          <Icon name="refresh" :size="14" /> {{ busy ? '处理中…' : '重建索引' }}
        </button>
        <button class="btn primary" @click="openNew">
          <Icon name="plus" :size="14" :stroke-width="2.2" /> 新建记忆
        </button>
      </div>
    </div>

    <!-- 模型状态栏 -->
    <div v-if="status" class="statusbar panel" :class="{ warn: !status.ready }">
      <template v-if="status.ready">
        <span class="dot ok" />
        模型 <b class="mono">{{ status.modelName }}</b>
        <span class="sep">·</span> 维度 {{ status.dims ?? '—' }}
        <span class="sep">·</span> 共 {{ status.count }} 条
        <span class="sep">·</span> 无索引
        <b :class="status.missingEmbedding > 0 ? 'miss' : ''">{{ status.missingEmbedding }}</b>
      </template>
      <template v-else>
        <span class="dot bad" />
        embedding 模型未就绪：请将模型置于 <code class="mono">{{ status.modelDir }}</code>，或运行
        <code class="mono">pnpm --filter @acs/server model:prepare</code>
      </template>
    </div>

    <!-- 筛选行 -->
    <div class="filters">
      <select v-model="projectFilter" aria-label="按归属筛选" @change="load()">
        <option value="">全部归属</option>
        <option value="global">仅全局</option>
        <option v-for="p in projects" :key="p.id" :value="String(p.id)">项目#{{ p.id }} {{ p.name }}</option>
      </select>
      <input v-model="typeFilter" type="text" placeholder="type 过滤" style="width: 130px" aria-label="按 type 过滤" @keydown.enter="load()" />
      <div class="searchbox">
        <Icon name="search" :size="14" class="sic" />
        <input v-model="q" type="text" placeholder="语义检索（回车）" aria-label="语义检索" @keydown.enter="load()" />
        <button v-if="searching" class="clr" aria-label="清空检索" @click="q = ''; load()">
          <Icon name="x" :size="12" :stroke-width="2.2" />
        </button>
      </div>
      <span v-if="searching" class="sub muted">按相似度排序 · score 为余弦相似度</span>
    </div>

    <div v-if="hint" class="hint-text">{{ hint }}</div>
    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!items.length" class="empty">
      {{ searching ? '未检索到相关记忆' : '还没有记忆。运行记忆类模板或在运行页产物中沉淀，也可以手动新建。' }}
    </div>

    <div v-else class="list">
      <div v-for="it in items" :key="it.id" class="row panel">
        <div class="rhead">
          <span class="muted mono">#{{ it.id }}</span>
          <span class="badge" :class="{ skip: it.scope === 'global' }">{{ scopeText(it) }}</span>
          <span class="chip">{{ it.type }}</span>
          <span v-if="it.name" class="mono nm">{{ it.name }}</span>
          <span v-if="!it.hasEmbedding" class="badge waiting_input" title="embedding 缺失，语义检索不会命中">无索引</span>
          <span v-if="it.score !== undefined" class="badge running" title="余弦相似度">{{ it.score.toFixed(3) }}</span>
          <span class="muted time">{{ fmtTime(it.updatedAt) }}</span>
          <div class="ops">
            <button class="btn tiny" @click="openEdit(it)"><Icon name="pencil" :size="12" /> 编辑</button>
            <button class="btn tiny danger" :disabled="busy" @click="removeItem(it)"><Icon name="trash" :size="12" /> 删除</button>
          </div>
        </div>
        <div class="content">{{ it.content }}</div>
      </div>
    </div>

    <Modal v-if="showForm" :title="form.id ? `编辑记忆 #${form.id}` : '新建记忆'" :width="620" @close="showForm = false">
      <label class="fld">
        内容 <span class="req">*</span>
        <textarea v-model="form.content" rows="6" placeholder="记忆全文（将计算 embedding 供语义召回）" />
      </label>
      <div class="frow">
        <label class="fld">
          type
          <input v-model="form.type" type="text" placeholder="note" />
        </label>
        <label class="fld">
          name（具名 = 同名 upsert 幂等）
          <input v-model="form.name" type="text" placeholder="可空" />
        </label>
      </div>
      <div v-if="!form.id" class="frow">
        <label class="fld">
          归属
          <select v-model="form.scope">
            <option value="project">项目域</option>
            <option value="global">全局（跨项目）</option>
          </select>
        </label>
        <label v-if="form.scope === 'project'" class="fld">
          项目
          <select v-model.number="form.projectId">
            <option v-for="p in projects" :key="p.id" :value="p.id">项目#{{ p.id }} {{ p.name }}</option>
          </select>
        </label>
      </div>
      <div v-else class="muted" style="font-size: 12px">归属：{{ form.scope === 'global' ? '全局（不可改）' : `项目#${form.projectId}（不可改）` }}</div>
      <div v-if="formErr" class="err-text">{{ formErr }}</div>
      <template #footer>
        <button class="btn" @click="showForm = false">取消</button>
        <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 9px 14px;
  font-size: 12.5px;
  color: var(--text-2);
  margin-bottom: 12px;
}

.statusbar.warn {
  border-color: rgb(245 158 11 / 40%);
  background: var(--warn-weak);
  color: var(--warn);
}

.statusbar code {
  font-size: 11.5px;
  background: rgb(148 163 184 / 12%);
  padding: 1px 6px;
  border-radius: 5px;
}

.statusbar .sep {
  color: var(--border-strong);
}

.statusbar .miss {
  color: var(--warn);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}

.dot.ok {
  background: var(--ok);
  box-shadow: 0 0 6px rgb(34 197 94 / 70%);
}

.dot.bad {
  background: var(--warn);
  box-shadow: 0 0 6px rgb(245 158 11 / 70%);
}

.filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.filters select {
  width: 170px;
}

.searchbox {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.searchbox .sic {
  position: absolute;
  left: 9px;
  color: var(--text-3);
  pointer-events: none;
}

.searchbox input {
  padding-left: 28px;
  padding-right: 26px;
  width: 230px;
}

.clr {
  position: absolute;
  right: 6px;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  display: inline-flex;
  padding: 2px;
  border-radius: 5px;
}

.clr:hover {
  color: #fff;
  background: var(--hover);
}

.hint-text {
  color: var(--ok);
  font-size: 12.5px;
  margin: 6px 0;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  padding: 11px 14px;
}

.rhead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.rhead .nm {
  font-size: 13px;
  font-weight: 600;
}

.rhead .time {
  margin-left: auto;
  font-size: 11.5px;
}

.ops {
  display: flex;
  gap: 6px;
}

.btn.tiny {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 7px;
}

.btn.tiny.danger:hover {
  border-color: rgb(248 113 113 / 60%);
  color: var(--bad);
}

.content {
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.55;
  margin-top: 7px;
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.frow {
  display: flex;
  gap: 12px;
}

.frow .fld {
  flex: 1;
}
</style>
