<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../../components/common/Icon.vue'
import ProjectDangerModal from '../../components/project/ProjectDangerModal.vue'
import ProjectFormModal from '../../components/project/ProjectFormModal.vue'
import { projectApi, templateApi } from '../../lib/api'
import { pendingOf } from '../../lib/pending'
import type { Project, TemplateMeta } from '../../lib/types'
import { runStatus, fmtTime } from '../../lib/format'
import { projectGenreText } from '../../lib/scene'

const projects = ref<Project[]>([])
const templates = ref<TemplateMeta[]>([])
const loading = ref(true)
const err = ref('')
const route = useRoute()
const router = useRouter()

// 新建项目弹窗
const showNew = ref(false)

// [M21] ?new=1 深链接（命令面板「新建项目」直达）；消费后清 query（防刷新重复弹）
watch(
  () => route.query.new,
  (v) => {
    if (v !== '1') return
    showNew.value = true
    const rest = { ...route.query }
    delete rest.new
    void router.replace({ query: rest })
  },
  { immediate: true },
)

// 列表状态筛选（进行中 / 已归档）
const statusTab = ref<'active' | 'archived'>('active')

// 危险操作弹窗（归档 / 彻底删除）
const dangerProject = ref<Project | null>(null)

// 恢复中的项目 id（按卡片禁用）
const restoringId = ref(0)

// ===== [M21] 标签筛选（客户端聚合去重） =====
const tagFilter = ref('all')

const allTags = computed(() => {
  const set = new Set<string>()
  for (const p of projects.value) for (const t of p.tags ?? []) set.add(t)
  return [...set].sort((x, y) => x.localeCompare(y, 'zh'))
})

const filteredProjects = computed(() =>
  tagFilter.value === 'all' ? projects.value : projects.value.filter((p) => (p.tags ?? []).includes(tagFilter.value)),
)

/** 模板 key → 短名（列表未载/未知 key 回退原 key） */
function tplName(key: string): string {
  return templates.value.find((t) => t.key === key)?.name ?? key
}

async function load() {
  loading.value = true
  err.value = ''
  // 项目列表为主数据；模板列表独立静默加载（仅用于短名展示，失败不阻塞）
  const [p, tpls] = await Promise.allSettled([projectApi.list(`?status=${statusTab.value}`), templateApi.list()])
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

function switchStatus(s: 'active' | 'archived') {
  if (statusTab.value === s) return
  statusTab.value = s
  projects.value = []
  void load()
}

/** 归档 / 彻底删除完成：关弹窗并刷新列表 */
function onDangerDone() {
  dangerProject.value = null
  void load()
}

/** 恢复归档项目为进行中 */
async function restore(p: Project) {
  restoringId.value = p.id
  try {
    await projectApi.restore(p.id)
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    restoringId.value = 0
  }
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
      <div class="tabs" role="tablist" aria-label="项目筛选">
        <button
          class="tab"
          role="tab"
          :aria-selected="statusTab === 'active'"
          :class="{ on: statusTab === 'active' }"
          @click="switchStatus('active')"
        >
          进行中
        </button>
        <button
          class="tab"
          role="tab"
          :aria-selected="statusTab === 'archived'"
          :class="{ on: statusTab === 'archived' }"
          @click="switchStatus('archived')"
        >
          已归档
        </button>
      </div>
      <select v-if="allTags.length" v-model="tagFilter" style="width: 140px" aria-label="按标签筛选项目">
        <option value="all">全部标签</option>
        <option v-for="t in allTags" :key="t" :value="t">{{ t }}</option>
      </select>
      <span class="sub">{{ filteredProjects.length }} 个</span>
      <button class="btn primary" style="margin-left: auto" @click="showNew = true">
        <Icon name="plus" :size="14" :stroke-width="2.2" /> 新建项目
      </button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!projects.length" class="empty">
      <template v-if="statusTab === 'active'">
        还没有项目。<br /><br />
        <button class="btn primary" @click="showNew = true">创建第一个项目</button>
      </template>
      <template v-else>没有已归档的项目。</template>
    </div>

    <div v-else-if="!filteredProjects.length" class="empty">无标签「{{ tagFilter }}」的项目</div>

    <div v-else class="grid">
      <RouterLink v-for="p in filteredProjects" :key="p.id" class="card panel" :to="cardTo(p)">
        <div class="top">
          <span class="nm">{{ p.name }}</span>
          <span class="tops">
            <span
              v-if="pendingOf(p.id)"
              class="badge waiting_input"
              :title="`${pendingOf(p.id)} 项待审阅（点击直达）`"
            >待审阅 {{ pendingOf(p.id) }}</span>
            <span v-if="statusTab === 'active' && p.status !== 'active'" class="badge cancelled">{{ p.status }}</span>
            <button
              v-if="statusTab === 'archived'"
              class="op always"
              title="恢复为进行中"
              :disabled="restoringId === p.id"
              @click.stop.prevent="restore(p)"
            >
              <Icon name="refresh" :size="13" />
            </button>
            <button class="op danger" title="归档 / 彻底删除" @click.stop.prevent="dangerProject = p">
              <Icon name="trash" :size="13" />
            </button>
          </span>
        </div>
        <div class="brief">{{ p.brief || '—' }}</div>
        <div class="meta">
          <span class="chip">{{ projectGenreText(p.genre) }}</span>
          <span class="chip">{{ p.templateKey ? tplName(p.templateKey) : '未绑定模板' }}</span>
          <span class="chip">{{ p.assetCount }} 资产</span>
        </div>
        <div v-if="p.tags?.length" class="meta tags">
          <span v-for="t in p.tags" :key="t" class="chip tag">{{ t }}</span>
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

    <!-- 危险操作：归档 / 彻底删除 -->
    <ProjectDangerModal
      v-if="dangerProject"
      :project="dangerProject"
      @archived="onDangerDone"
      @purged="onDangerDone"
      @close="dangerProject = null"
    />
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

.op {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s, background 0.15s;
}

.card:hover .op,
.op:focus-visible {
  opacity: 1;
}

.op:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.op:hover:not(:disabled) {
  color: var(--text);
  background: var(--hover);
}

.op.always {
  opacity: 0.7;
}

.card:hover .op.always,
.op.always:hover:not(:disabled) {
  opacity: 1;
}

.op.danger:hover:not(:disabled) {
  color: var(--bad);
  border-color: rgb(248 113 113 / 40%);
  background: var(--bad-weak);
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

/* [M21] 标签 chips 与筛选色 */
.tags {
  margin-top: 6px;
}

.chip.tag {
  color: var(--accent-h);
  background: var(--accent-weak);
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
