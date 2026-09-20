<script setup lang="ts">
/**
 * [M31+] 轻松创作「从素材选取」弹窗：浏览各项目素材库存量资产，多选登记为参考。
 * 仅图片/视频/音频可选（与服务端 ref kind 对齐）；选取项由服务端复制进会话项目
 * （sha256 去重，不计费、不触发规划），本组件零拷贝逻辑，只做浏览与勾选。
 */
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../../components/common/Icon.vue'
import Modal from '../../components/common/Modal.vue'
import { projectApi } from '../../lib/api'
import { REF_MAX_COUNT } from '../../lib/types'
import type { Asset, Project } from '../../lib/types'

const emit = defineEmits<{
  close: []
  pick: [assets: Asset[]]
}>()

const REF_KINDS = new Set(['image', 'video', 'audio'])
const KIND_LABEL: Record<string, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
}
type TabKind = 'all' | 'image' | 'video' | 'audio'
const TABS: Array<{ key: TabKind; label: string; icon: string }> = [
  { key: 'all', label: '全部', icon: 'arrange' },
  { key: 'image', label: '图片', icon: 'photo' },
  { key: 'video', label: '视频', icon: 'film' },
  { key: 'audio', label: '音频', icon: 'speaker-wave' },
]
const tab = ref<TabKind>('all')

const projects = ref<Project[]>([])
const projectId = ref(0)
const loading = ref(false)
const loadErr = ref('')
const items = ref<Asset[]>([])
const total = ref(0)
const loadedCount = ref(0)
const PAGE = 100
const search = ref('')
const selected = ref<Asset[]>([])
// 缩略图加载失败（视频封面可能 404）→ 回退类型图标，避免破图（媒体缩略图三大陷阱红线）
const thumbFailed = ref(new Set<number>())

// 搜索为已加载页内的客户端过滤（素材名 + 生成提示词），不另开后端检索面
const shown = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return items.value
  return items.value.filter(
    (a) =>
      a.name.toLowerCase().includes(q) ||
      (a.prompt ?? '').toLowerCase().includes(q),
  )
})
const hasMore = computed(() => loadedCount.value < total.value)
const selectedIds = computed(() => new Set(selected.value.map((a) => a.id)))

function sizeText(a: Asset): string {
  if (!a.fileSize) return KIND_LABEL[a.kind] ?? a.kind
  const mb = a.fileSize / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.round(a.fileSize / 1024)}KB`
}

async function loadProjects(): Promise<void> {
  try {
    projects.value = (await projectApi.list()).items
    if (projects.value.length && !projectId.value) {
      projectId.value = projects.value[0]!.id
    }
  } catch (e) {
    loadErr.value = `项目列表加载失败：${(e as Error).message}`
  }
}

async function loadAssets(reset = true): Promise<void> {
  if (!projectId.value) return
  loading.value = true
  loadErr.value = ''
  try {
    const kindQ = tab.value === 'all' ? '' : `&kind=${tab.value}`
    const offset = reset ? 0 : loadedCount.value
    const res = await projectApi.assets(
      projectId.value,
      `?limit=${PAGE}&offset=${offset}${kindQ}`,
    )
    const media = res.items.filter((a) => REF_KINDS.has(a.kind))
    items.value = reset ? media : [...items.value, ...media]
    total.value = res.total
    loadedCount.value = offset + res.items.length
  } catch (e) {
    loadErr.value = `素材加载失败：${(e as Error).message}`
    if (reset) {
      items.value = []
      total.value = 0
      loadedCount.value = 0
    }
  } finally {
    loading.value = false
  }
}

watch(
  [projectId, tab],
  () => void loadAssets(true),
)

onMounted(() => void loadProjects())

function toggle(a: Asset): void {
  const i = selected.value.findIndex((s) => s.id === a.id)
  if (i >= 0) {
    selected.value.splice(i, 1)
  } else if (selected.value.length < REF_MAX_COUNT) {
    selected.value.push(a)
  }
}

function markThumbFailed(id: number): void {
  thumbFailed.value = new Set(thumbFailed.value).add(id)
}

function confirmPick(): void {
  if (!selected.value.length) return
  emit('pick', [...selected.value])
}
</script>

<template>
  <Modal title="从素材选取参考" :width="720" @close="emit('close')">
    <div class="pk-bar">
      <select
        v-model.number="projectId"
        class="pk-proj"
        aria-label="选择素材所属项目"
      >
        <option v-for="p in projects" :key="p.id" :value="p.id">
          {{ p.name }}
        </option>
      </select>
      <div class="tabs" role="tablist" aria-label="素材类型">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          :class="{ on: tab === t.key }"
          type="button"
          role="tab"
          :aria-selected="tab === t.key"
          @click="tab = t.key"
        >
          <Icon :name="t.icon" :size="12" /> {{ t.label }}
        </button>
      </div>
      <label class="pk-search">
        <Icon name="search" :size="13" />
        <input
          v-model="search"
          type="search"
          placeholder="搜索素材名 / 提示词"
          aria-label="搜索素材"
        />
      </label>
    </div>

    <div v-if="loadErr" class="err-text">{{ loadErr }}</div>
    <div v-if="!projects.length && !loading && !loadErr" class="empty">
      还没有项目素材，可先用「添加参考」上传文件。
    </div>
    <template v-else>
      <div v-if="loading && !shown.length" class="empty">加载中…</div>
      <div v-else-if="!shown.length" class="empty">
        {{ search ? '没有匹配的媒体素材（仅图片 / 视频 / 音频可选）' : '该项目暂无可选素材' }}
      </div>
      <div v-else class="pk-grid">
        <button
          v-for="a in shown"
          :key="a.id"
          type="button"
          class="pk-card"
          :class="{ on: selectedIds.has(a.id) }"
          role="option"
          :aria-selected="selectedIds.has(a.id)"
          :title="a.name"
          @click="toggle(a)"
        >
          <span class="pk-thumb">
            <img
              v-if="a.urls?.thumb && !thumbFailed.has(a.id)"
              :src="a.urls.thumb"
              :alt="a.name"
              loading="lazy"
              @error="markThumbFailed(a.id)"
            />
            <Icon
              v-else
              :name="a.kind === 'video' ? 'film' : a.kind === 'audio' ? 'speaker-wave' : 'photo'"
              :size="22"
            />
            <span v-if="selectedIds.has(a.id)" class="pk-check" aria-hidden="true">
              <Icon name="check" :size="12" :stroke-width="2.5" />
            </span>
          </span>
          <span class="pk-name">{{ a.name }}</span>
          <span class="pk-meta">{{ KIND_LABEL[a.kind] }} · {{ sizeText(a) }}</span>
        </button>
      </div>
      <div v-if="loading && shown.length" class="muted pk-more">加载中…</div>
      <button
        v-else-if="hasMore"
        class="btn sm ghost pk-morebtn"
        type="button"
        @click="loadAssets(false)"
      >
        <Icon name="chevron-down" :size="12" /> 加载更多（还有
        {{ total - loadedCount }} 项）
      </button>
    </template>

    <template #footer>
      <span class="muted pk-foot-hint">
        已选 {{ selected.length }} / {{ REF_MAX_COUNT }}
        · 选取参考不计费，服务端自动复制进会话项目
      </span>
      <button class="btn" type="button" @click="emit('close')">取消</button>
      <button
        class="btn primary"
        type="button"
        :disabled="!selected.length"
        @click="confirmPick"
      >
        <Icon name="plus" :size="13" /> 添加为参考
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.pk-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

/* 全局 select{width:100%} 会撑满整行，这里必须收窄（同 ConversationPanel .att-role 教训） */
.pk-proj {
  flex: none;
  width: auto;
  max-width: 240px;
  font-size: 12.5px;
  padding: 5px 8px;
  border-radius: 8px;
  background: var(--raised);
  border: 1px solid var(--border-strong);
  color: var(--text);
}

.pk-search {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text-3);
}

.pk-search input {
  border: none;
  background: none;
  outline: none;
  color: var(--text);
  font-size: 12.5px;
  width: 150px;
  padding: 0;
}

.pk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
  gap: 9px;
}

.pk-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition:
    border-color 0.15s,
    background 0.15s,
    box-shadow 0.15s;
}

.pk-card:hover {
  border-color: var(--border-strong);
  background: var(--raised);
}

.pk-card.on {
  border-color: var(--accent);
  background: var(--accent-weak);
  box-shadow: 0 6px 16px -12px rgb(79 70 229 / 70%);
}

.pk-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.pk-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  border-radius: 7px;
  overflow: hidden;
  background: var(--raised);
  border: 1px solid var(--border);
  color: var(--text-3);
}

.pk-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pk-check {
  position: absolute;
  right: 4px;
  top: 4px;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--grad-brand);
  color: #fff;
  box-shadow: 0 3px 8px -3px rgb(79 70 229 / 80%);
}

.pk-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-meta {
  font-size: 10.5px;
  color: var(--text-3);
}

.pk-more {
  text-align: center;
  margin-top: 10px;
}

.pk-morebtn {
  display: block;
  margin: 10px auto 0;
}

.pk-foot-hint {
  margin-right: auto;
  line-height: 1.4;
}

@media (prefers-reduced-motion: reduce) {
  .pk-card,
  .pk-card:hover {
    transition: none;
  }
}
</style>
