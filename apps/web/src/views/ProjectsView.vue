<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Modal from '../components/Modal.vue'
import Icon from '../components/Icon.vue'
import { projectApi, templateApi } from '../lib/api'
import { ApiError } from '../lib/api'
import type { Project, TemplateMeta } from '../lib/types'
import { runStatus, fmtTime } from '../lib/format'

const projects = ref<Project[]>([])
const templates = ref<TemplateMeta[]>([])
const loading = ref(true)
const err = ref('')

// 新建项目弹窗
const showNew = ref(false)
const newName = ref('')
const newBrief = ref('')
const newGenre = ref('drama_short')
const newTpl = ref('')
const newErr = ref('')
const creating = ref(false)

async function load() {
  loading.value = true
  err.value = ''
  try {
    const data = await projectApi.list()
    projects.value = data.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())

async function openNew() {
  newName.value = ''
  newBrief.value = ''
  newGenre.value = 'drama_short'
  newTpl.value = ''
  newErr.value = ''
  showNew.value = true
  try {
    const t = await templateApi.list()
    templates.value = t.items
    newTpl.value = t.items[0]?.key ?? ''
  } catch {
    // 模板加载失败不阻塞创建
  }
}

async function createProject() {
  if (!newName.value.trim()) {
    newErr.value = '请填写项目名'
    return
  }
  creating.value = true
  newErr.value = ''
  try {
    await projectApi.create({
      name: newName.value.trim(),
      genre: newGenre.value,
      brief: newBrief.value.trim(),
      template_key: newTpl.value || undefined,
    })
    showNew.value = false
    await load()
  } catch (e) {
    newErr.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

const genres = [
  { v: 'drama_short', t: '短剧' },
  { v: 'article', t: '图文' },
  { v: 'talk', t: '口播' },
]
</script>

<template>
  <div>
    <div class="page-h">
      <h1>项目</h1>
      <span class="sub">{{ projects.length }} 个</span>
      <button class="btn primary" style="margin-left: auto" @click="openNew">
        <Icon name="plus" :size="14" :stroke-width="2.2" /> 新建项目
      </button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!projects.length" class="empty">
      还没有项目。<br /><br />
      <button class="btn primary" @click="openNew">创建第一个项目</button>
    </div>

    <div v-else class="grid">
      <RouterLink v-for="p in projects" :key="p.id" class="card panel" :to="`/projects/${p.id}`">
        <div class="top">
          <span class="nm">{{ p.name }}</span>
          <span v-if="p.status !== 'active'" class="badge cancelled">{{ p.status }}</span>
        </div>
        <div class="brief">{{ p.brief || '—' }}</div>
        <div class="meta">
          <span class="chip">{{ genres.find((g) => g.v === p.genre)?.t ?? p.genre }}</span>
          <span class="chip">{{ p.templateKey ?? '未绑定模板' }}</span>
          <span class="chip">{{ p.assetCount }} 资产</span>
        </div>
        <div v-if="p.recentRuns.length" class="runs">
          <div v-for="r in p.recentRuns.slice(0, 3)" :key="r.id" class="run">
            <span class="badge" :class="r.status">{{ runStatus(r.status).text }}</span>
            <span class="muted mono">#{{ r.id }}</span>
            <span class="muted">{{ fmtTime(r.updatedAt) }}</span>
          </div>
        </div>
        <div v-else class="muted" style="padding: 6px 0">尚未运行</div>
      </RouterLink>
    </div>

    <Modal v-if="showNew" title="新建项目" :width="560" @close="showNew = false">
      <label class="fld">
        项目名 <span class="req">*</span>
        <input v-model="newName" type="text" placeholder="如：萌宝镖客" />
      </label>
      <label class="fld">
        体裁
        <select v-model="newGenre">
          <option v-for="g in genres" :key="g.v" :value="g.v">{{ g.t }}</option>
        </select>
      </label>
      <label class="fld">
        默认模板
        <select v-model="newTpl">
          <option v-for="t in templates" :key="t.key" :value="t.key">{{ t.name }}</option>
        </select>
      </label>
      <label class="fld">
        简介 brief
        <textarea v-model="newBrief" rows="2" placeholder="一句话说明本项目定位（将作为创作上下文）" />
      </label>
      <div v-if="newErr" class="err-text">{{ newErr }}</div>
      <template #footer>
        <button class="btn" @click="showNew = false">取消</button>
        <button class="btn primary" :disabled="creating" @click="createProject">
          {{ creating ? '创建中…' : '创建' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 16px;
}

.card {
  display: block;
  padding: 16px;
  color: inherit;
  text-decoration: none;
  transition: transform 0.12s, box-shadow 0.12s;
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
  text-decoration: none;
  border-color: rgb(139 92 246 / 45%);
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.nm {
  font-size: 16px;
  font-weight: 600;
}

.brief {
  color: var(--text-2);
  font-size: 13px;
  margin: 8px 0 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 38px;
}

.meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.chip {
  font-size: 11.5px;
  background: var(--chip-bg);
  color: var(--text-2);
  padding: 2px 9px;
  border-radius: 999px;
}

.runs {
  margin-top: 12px;
  border-top: 1px dashed var(--border-strong);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.run {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
</style>
