<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Icon from '../common/Icon.vue'
import { projectApi, seriesApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import { runStatus } from '../../lib/format'
import type { Episode, RunStatus, SeriesInfo } from '../../lib/types'

/**
 * 剧集地图（一项目一剧：剧 → 集两级）。
 * - 数据：GET /projects/:id/series（集状态为服务端派生：最新 run 状态优先，回落行原值）。
 * - 起作：emit startEpisode(集号) → 父页面打开 RunFormModal（预选模板 + 预填 episode_number）。
 * - 刷新：父组件经 defineExpose reload() 在 run 创建 / 终态 / 闸门事件后静默重载。
 */
const props = defineProps<{ projectId: number }>()
const emit = defineEmits<{ startEpisode: [episodeNumber: number] }>()

const series = ref<SeriesInfo | null>(null)
const episodes = ref<Episode[]>([])
const loading = ref(false)
const err = ref('')
const busy = ref(false)

// 建剧表单
const createOpen = ref(false)
const cName = ref('')
const cTotal = ref('8')

// 集标题行内编辑
const editingId = ref<number | null>(null)
const editVal = ref('')

async function load(silent = false) {
  if (!silent) loading.value = true
  err.value = ''
  try {
    const r = await seriesApi.get(props.projectId)
    series.value = r.series
    episodes.value = r.episodes
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
  void loadMonetization()
}
onMounted(() => void load())

defineExpose({ reload: (silent = true) => load(silent) })

// —— 商业结构（M60）：立项 run 产出的「商业结构设计.json」折叠展示；卡点仅为剧情设计思路，真实付费由发布平台决定 ——
interface MonetizationEpisode {
  ep: number
  opening_hook?: string
  ending_cliffhanger: string
  paywall_candidate?: boolean
  paywall_note?: string
  rhythm_note?: string
}
interface MonetizationDoc {
  title?: string
  episode_count?: number
  free_episode_range?: number[]
  positioning_rationale?: string
  episodes: MonetizationEpisode[]
}
const mono = ref<MonetizationDoc | null>(null)
const monoOpen = ref(false)
const monoAssetId = ref<number | null>(null)

async function loadMonetization() {
  try {
    const r = await projectApi.assets(props.projectId, '?kind=text&purpose=monetization&limit=1')
    const a = r.items[0]
    if (!a) {
      mono.value = null
      monoAssetId.value = null
      return
    }
    monoAssetId.value = a.id
    const res = await fetch(`/api/v1/assets/${a.id}/file`)
    if (!res.ok) {
      mono.value = null
      return
    }
    const doc = (await res.json()) as MonetizationDoc
    mono.value = Array.isArray(doc.episodes) && doc.episodes.length > 0 ? doc : null
  } catch {
    mono.value = null // 展示面非致命：读取/解析失败折叠卡隐藏，不打扰主流程
  }
}

/** 写操作统一守卫：busy + 错误回显（服务端 409/400 消息原样透出） */
async function guard(fn: () => Promise<void>): Promise<void> {
  busy.value = true
  err.value = ''
  try {
    await fn()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

/** 展示状态：run 派生优先（runStatus 非空），否则手工态映射 */
function epStatus(e: Episode): { text: string; cls: string } {
  if (e.runStatus) return runStatus(e.runStatus as RunStatus)
  if (e.status === 'planning') return { text: '规划中', cls: 'running' }
  if (e.status === 'done') return { text: '已完成', cls: 'succeeded' }
  return { text: '未起作', cls: '' }
}

function replaceEp(ep: Episode) {
  const i = episodes.value.findIndex((x) => x.id === ep.id)
  if (i >= 0) episodes.value[i] = ep
}

function openCreate() {
  createOpen.value = true
  cName.value = ''
  cTotal.value = '8'
  err.value = ''
}

function doCreate() {
  const name = cName.value.trim()
  if (!name) {
    err.value = '剧名必填'
    return
  }
  const total = Number(cTotal.value)
  if (!Number.isInteger(total) || total < 1 || total > 999) {
    err.value = '集数需为 1..999 的整数'
    return
  }
  void guard(async () => {
    const r = await seriesApi.create(props.projectId, {
      name,
      total_episodes: total,
    })
    series.value = r.series
    episodes.value = r.episodes
    createOpen.value = false
  })
}

/** 集数 ±1（扩容追集；缩容仅删尾部空集，占用行服务端 409） */
function doChangeTotal(delta: number) {
  if (!series.value) return
  const target = series.value.totalEpisodes + delta
  void guard(async () => {
    const r = await seriesApi.updateTotal(series.value!.id, target)
    series.value = r.series
    episodes.value = r.episodes
  })
}

async function doRemoveSeries() {
  if (!series.value) return
  const ok = await confirmDialog({
    title: '删除剧集地图',
    message: `确认删除「${series.value.name}」的全部 ${episodes.value.length} 条集记录？\n已关联 run / 资产的集会拒绝整单删除（可先解除绑定）。`,
    danger: true,
  })
  if (!ok) return
  void guard(async () => {
    await seriesApi.remove(series.value!.id)
    series.value = null
    episodes.value = []
  })
}

function startEpisode(e: Episode) {
  emit('startEpisode', e.number)
}

function beginEdit(e: Episode) {
  editingId.value = e.id
  editVal.value = e.title ?? ''
}

function saveEdit(e: Episode) {
  if (editingId.value !== e.id) return
  editingId.value = null
  const title = editVal.value.trim()
  if (title === (e.title ?? '')) return
  void guard(async () => {
    const r = await seriesApi.updateEpisode(e.id, { title: title || null })
    replaceEp(r.episode)
  })
}

function setStatus(e: Episode, v: string) {
  if (v === e.rowStatus) return
  void guard(async () => {
    const r = await seriesApi.updateEpisode(e.id, { status: v })
    replaceEp(r.episode)
  })
}

async function doRemoveEpisode(e: Episode) {
  const ok = await confirmDialog({
    title: '删除集记录',
    message: `确认删除第 ${e.number} 集记录？已关联的 run 与资产会保留。`,
    danger: true,
  })
  if (!ok) return
  void guard(async () => {
    await seriesApi.removeEpisode(e.id)
    episodes.value = episodes.value.filter((x) => x.id !== e.id)
  })
}
</script>

<template>
  <div class="panel block">
    <div class="bh">
      <span class="bt">剧集地图</span>
      <span v-if="series" class="muted"
        >{{ series.name }} · {{ episodes.length }} 集</span
      >
      <div v-if="series" class="sb-ops">
        <button
          class="btn sm"
          :disabled="busy"
          title="追加一集"
          @click="doChangeTotal(1)"
        >
          +1 集
        </button>
        <button
          class="btn sm"
          :disabled="busy"
          title="删减一集（该集需未关联 run / 资产）"
          @click="doChangeTotal(-1)"
        >
          −1 集
        </button>
        <button class="btn sm danger" :disabled="busy" @click="doRemoveSeries">
          删剧
        </button>
      </div>
      <button
        v-else
        class="btn sm primary"
        style="margin-left: auto"
        @click="openCreate"
      >
        <Icon name="plus" :size="12" :stroke-width="2.2" /> 建立剧集地图
      </button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>

    <!-- 商业结构折叠卡（M60）：仅在立项产出过「商业结构设计.json」时出现 -->
    <div v-if="mono" class="mono-card">
      <button class="mono-head" :aria-expanded="monoOpen" @click="monoOpen = !monoOpen">
        <Icon :name="monoOpen ? 'chevron-down' : 'chevron-right'" :size="12" :stroke-width="2.2" />
        <span class="mono-title">商业结构 · {{ mono.episodes.length }} 集钩子/悬念链</span>
        <span v-if="mono.free_episode_range && mono.free_episode_range.length >= 2" class="muted mono-free">
          建议免费：第 {{ mono.free_episode_range[0] }}–{{ mono.free_episode_range[1] }} 集
        </span>
        <span class="muted mono-cap">卡点为剧情设计思路，付费由发布平台决定</span>
      </button>
      <div v-if="monoOpen" class="mono-body">
        <p v-if="mono.positioning_rationale" class="mono-why">{{ mono.positioning_rationale }}</p>
        <div v-for="e in mono.episodes" :key="e.ep" class="mono-row">
          <span class="mono-ep mono">{{ String(e.ep).padStart(2, '0') }}</span>
          <span class="mono-hooks">
            <span v-if="e.opening_hook" class="mono-hook">钩：{{ e.opening_hook }}</span>
            <span class="mono-cliff">悬念：{{ e.ending_cliffhanger }}</span>
            <span v-if="e.paywall_note" class="muted">卡点理由：{{ e.paywall_note }}</span>
          </span>
          <span v-if="e.paywall_candidate" class="badge running" title="此集结尾适合作为卡点（剧情设计建议）">卡点</span>
          <RouterLink v-if="monoAssetId" class="muted mono-link" :to="`/projects/${props.projectId}?tab=assets`">资产</RouterLink>
        </div>
      </div>
    </div>

    <!-- 建剧表单 -->
    <div v-if="createOpen && !series" class="sb-create">
      <label class="fld"
        >剧名
        <input
          v-model="cName"
          placeholder="如 萌宝镖客"
          @keyup.enter="doCreate"
        />
      </label>
      <label class="fld"
        >计划集数
        <input v-model="cTotal" type="number" min="1" max="999" />
      </label>
      <div class="sb-create-ops">
        <button class="btn" @click="createOpen = false">取消</button>
        <button class="btn primary" :disabled="busy" @click="doCreate">
          {{ busy ? '建立中…' : '建立（生成 1..N 集）' }}
        </button>
      </div>
    </div>

    <div v-else-if="loading && !series" class="empty" style="padding: 14px 0">
      加载中…
    </div>

    <!-- 集列表 -->
    <div v-else-if="series" class="ep-list">
      <div v-for="e in episodes" :key="e.id" class="ep-row">
        <span class="ep-no mono">{{ String(e.number).padStart(3, '0') }}</span>
        <span class="ep-title">
          <input
            v-if="editingId === e.id"
            v-model="editVal"
            class="ep-input"
            placeholder="集标题"
            @keyup.enter="saveEdit(e)"
            @blur="saveEdit(e)"
          />
          <button
            v-else
            class="lnk"
            title="点击编辑集标题"
            @click="beginEdit(e)"
          >
            {{ e.title || '未命名' }}
          </button>
        </span>
        <span class="badge" :class="epStatus(e).cls">{{
          epStatus(e).text
        }}</span>
        <span class="ep-run muted mono">
          <RouterLink v-if="e.latestRunId" :to="`/runs/${e.latestRunId}`"
            >Run #{{ e.latestRunId }}</RouterLink
          >
          <template v-else>—</template>
        </span>
        <select
          class="ep-st"
          :value="e.rowStatus"
          :disabled="busy"
          :aria-label="`第 ${e.number} 集手工状态`"
          @change="setStatus(e, ($event.target as HTMLSelectElement).value)"
        >
          <option value="locked">未起作</option>
          <option value="planning">规划中</option>
          <option value="done">已完成</option>
        </select>
        <span class="ep-ops">
          <button class="btn sm" :disabled="busy" @click="startEpisode(e)">
            起作
          </button>
          <button
            class="btn sm danger"
            :disabled="busy"
            @click="doRemoveEpisode(e)"
          >
            删
          </button>
        </span>
      </div>
    </div>

    <!-- 空态提示 -->
    <div v-else class="muted sb-hint">
      为本项目建立「剧 → 集」两级地图：按集起作 run，集状态与最新运行双向联动。
    </div>
  </div>
</template>

<style scoped>
/* .bh/.bt 系 ProjectDetailView scoped 样式（不穿透子组件），本组件内同名补定义 */
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

.sb-ops {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
}

.sb-create {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 0 12px;
  padding: 6px 0 2px;
}

.sb-create-ops {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.ep-list {
  display: flex;
  flex-direction: column;
}

.ep-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-top: 1px solid var(--border);
}

.ep-no {
  color: var(--text-3);
  font-size: 12px;
  width: 34px;
}

.ep-title {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.ep-title .lnk {
  border: none;
  background: none;
  padding: 0;
  color: var(--text-2);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}

.ep-title .lnk:hover {
  color: var(--accent-h);
}

.ep-input {
  width: 100%;
  font-size: 12.5px;
}

.ep-run {
  font-size: 12px;
  width: 86px;
  text-align: right;
}

.ep-run a {
  color: var(--accent-h);
}

.ep-st {
  width: 92px;
  font-size: 12px;
}

.ep-ops {
  display: flex;
  gap: 6px;
}

.sb-hint {
  padding: 6px 0 2px;
}

.mono-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin: 0 0 10px;
  overflow: hidden;
}

.mono-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text-2);
  text-align: left;
}

.mono-title {
  font-weight: 600;
}

.mono-cap {
  margin-left: auto;
  font-size: 11px;
  white-space: nowrap;
}

.mono-body {
  padding: 2px 10px 8px;
  border-top: 1px solid var(--border);
}

.mono-why {
  margin: 8px 0;
  font-size: 12px;
  color: var(--text-3);
}

.mono-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  border-top: 1px dashed var(--border);
  font-size: 12px;
}

.mono-ep {
  color: var(--text-3);
  width: 26px;
  flex: none;
}

.mono-hooks {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.mono-cliff {
  color: var(--text-2);
}

.mono-link {
  flex: none;
}
</style>
