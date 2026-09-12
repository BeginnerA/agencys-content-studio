<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Icon from '../components/Icon.vue'
import ProjectFormModal from '../components/ProjectFormModal.vue'
import { projectApi, templateApi } from '../lib/api'
import { pendingOf } from '../lib/pending'
import type { Project, TemplateMeta } from '../lib/types'
import { runStatus, fmtTime } from '../lib/format'
import { projectGenreText } from '../lib/scene'

const projects = ref<Project[]>([])
const templates = ref<TemplateMeta[]>([])
const loading = ref(true)
const err = ref('')

// 新建项目弹窗
const showNew = ref(false)

/** 模板 key → 短名（列表未载/未知 key 回退原 key） */
function tplName(key: string): string {
  return templates.value.find((t) => t.key === key)?.name ?? key
}

async function load() {
  loading.value = true
  err.value = ''
  // 项目列表为主数据；模板列表独立静默加载（仅用于短名展示，失败不阻塞）
  const [p, tpls] = await Promise.allSettled([projectApi.list(), templateApi.list()])
  if (p.status === 'fulfilled') {
    projects.value = p.value.items
  } else {
    err.value = p.reason instanceof Error ? p.reason.message : String(p.reason)
  }
  if (tpls.status === 'fulfilled') templates.value = tpls.value.items
  loading.value = false
}
onMounted(() => void load())

function onCreated() {
  showNew.value = false
  void load()
}

/** 有待审阅时直达运行区待审阅筛选（ProjectDetailView 读取 ?tab=&filter=） */
function cardTo(p: Project) {
  return pendingOf(p.id) > 0
    ? { path: `/projects/${p.id}`, query: { tab: 'runs', filter: 'waiting' } }
    : `/projects/${p.id}`
}
</script>

<template>
  <div>
    <div class="page-h">
      <h1>项目</h1>
      <span class="sub">{{ projects.length }} 个</span>
      <button class="btn primary" style="margin-left: auto" @click="showNew = true">
        <Icon name="plus" :size="14" :stroke-width="2.2" /> 新建项目
      </button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!projects.length" class="empty">
      还没有项目。<br /><br />
      <button class="btn primary" @click="showNew = true">创建第一个项目</button>
    </div>

    <div v-else class="grid">
      <RouterLink v-for="p in projects" :key="p.id" class="card panel" :to="cardTo(p)">
        <div class="top">
          <span class="nm">{{ p.name }}</span>
          <span class="tops">
            <span
              v-if="pendingOf(p.id)"
              class="badge waiting_input"
              :title="`${pendingOf(p.id)} 项待审阅（点击直达）`"
            >待审阅 {{ pendingOf(p.id) }}</span>
            <span v-if="p.status !== 'active'" class="badge cancelled">{{ p.status }}</span>
          </span>
        </div>
        <div class="brief">{{ p.brief || '—' }}</div>
        <div class="meta">
          <span class="chip">{{ projectGenreText(p.genre) }}</span>
          <span class="chip">{{ p.templateKey ? tplName(p.templateKey) : '未绑定模板' }}</span>
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

    <ProjectFormModal v-if="showNew" @done="onCreated" @close="showNew = false" />
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
  border-color: rgb(99 102 241 / 45%);
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.nm {
  font-size: 16px;
  font-weight: 600;
}

.tops {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
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
