<script setup lang="ts">
/**
 * [M20] 发布数据面板（B2 回采系统化 + B3 A/B 测试）
 * 三个子视图：列表 / 趋势 / A/B 对比
 */
import { computed, onMounted, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { projectApi, publicationApi } from '../../lib/api'
import type {
  AbGroupItem,
  Publication,
  Project,
  PublicationTrendItem,
} from '../../lib/types'
import { fmtQty } from '../../lib/format'

const SUB_TABS = [
  { key: 'list', label: '列表' },
  { key: 'trend', label: '趋势' },
  { key: 'ab', label: 'A/B 对比' },
] as const
type SubTab = (typeof SUB_TABS)[number]['key']
const subTab = ref<SubTab>('list')

const loading = ref(true)
const err = ref('')
const projects = ref<Project[]>([])
const projectId = ref<number | ''>('')
const publications = ref<Publication[]>([])
const trendItems = ref<PublicationTrendItem[]>([])
const abItems = ref<AbGroupItem[]>([])
const days = ref(30)

// 批量导入
const showBatch = ref(false)
const batchText = ref('')
const batchResult = ref('')
const importing = ref(false)

async function load() {
  loading.value = true
  err.value = ''
  try {
    const [pl, pub] = await Promise.all([
      projectApi.list(),
      publicationApi.list(
        projectId.value ? `?project_id=${projectId.value}` : '',
      ),
    ])
    projects.value = pl.items
    publications.value = pub.items
    if (subTab.value === 'trend') await loadTrend()
    if (subTab.value === 'ab') await loadAb()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadTrend() {
  const r = await publicationApi.trend(
    `?days=${days.value}${projectId.value ? `&project_id=${projectId.value}` : ''}`,
  )
  trendItems.value = r.items
}

async function loadAb() {
  const r = await publicationApi.abGroups(
    projectId.value ? `?project_id=${projectId.value}` : '',
  )
  abItems.value = r.items
}

onMounted(() => void load())

// 切换子 Tab 时按需加载
async function switchTab(t: SubTab) {
  subTab.value = t
  if (t === 'trend') await loadTrend()
  if (t === 'ab') await loadAb()
}

// 批量导入解析（支持 JSON 数组 / CSV）
function parseBatchInput(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim()
  if (!trimmed) return []
  // JSON 数组
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as Array<Record<string, unknown>>
    } catch {
      return []
    }
  }
  // CSV（首行 header）
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length < 2) return []
  const headers = lines[0]!.split(',').map((h) => h.trim().toLowerCase())
  const items: Array<Record<string, unknown>> = []
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i]!.split(',').map((v) => v.trim())
    const obj: Record<string, unknown> = {}
    for (let j = 0; j < headers.length; j++) {
      const h = headers[j]!
      const v = vals[j] ?? ''
      if (
        h === 'project_id' ||
        h === 'run_id' ||
        h === 'asset_id' ||
        h === 'published_at'
      ) {
        obj[h] = v ? Number(v) : undefined
      } else if (
        h === 'views' ||
        h === 'likes' ||
        h === 'comments' ||
        h === 'favorites' ||
        h === 'shares'
      ) {
        if (!obj.metrics) obj.metrics = {}
        ;(obj.metrics as Record<string, number>)[h] = Number(v) || 0
      } else {
        obj[h] = v
      }
    }
    items.push(obj)
  }
  return items
}

async function doBatchImport() {
  const items = parseBatchInput(batchText.value)
  if (!items.length) {
    batchResult.value = '未解析到有效记录'
    return
  }
  importing.value = true
  batchResult.value = ''
  try {
    const r = await publicationApi.batch(items)
    batchResult.value = `成功导入 ${r.count} 条`
    batchText.value = ''
    await load()
  } catch (e) {
    batchResult.value = `导入失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    importing.value = false
  }
}

const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音',
  wechat_channels: '视频号',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: 'B站',
  other: '其他',
}

const maxTrendViews = computed(() =>
  Math.max(1, ...trendItems.value.map((t) => t.views)),
)

function projName(id: number) {
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`
}
</script>

<template>
  <div class="pub-panel">
    <div v-if="err" class="err-text">{{ err }}</div>

    <!-- 工具栏 -->
    <div class="pub-toolbar">
      <div class="seg" role="tablist">
        <button
          v-for="t in SUB_TABS"
          :key="t.key"
          :class="{ on: subTab === t.key }"
          @click="switchTab(t.key)"
        >
          {{ t.label }}
        </button>
      </div>
      <select v-model="projectId" aria-label="按项目筛选" @change="load()">
        <option value="">全部项目</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">
          {{ p.name }}
        </option>
      </select>
      <button
        v-if="subTab === 'list'"
        class="btn sm primary"
        @click="showBatch = !showBatch"
      >
        <Icon name="upload" :size="12" /> 批量导入
      </button>
      <select v-if="subTab === 'trend'" v-model="days" @change="loadTrend()">
        <option :value="7">7 天</option>
        <option :value="30">30 天</option>
        <option :value="90">90 天</option>
      </select>
    </div>

    <!-- 批量导入弹窗 -->
    <div v-if="showBatch && subTab === 'list'" class="batch-import panel">
      <h4>批量导入发布数据</h4>
      <p class="muted sm">
        粘贴 JSON 数组或 CSV（首行 header，必填：project_id,
        platform；可选：title, ab_group, views, likes, comments, published_at）
      </p>
      <textarea
        v-model="batchText"
        rows="6"
        placeholder='[{"project_id":1,"platform":"douyin","title":"测试","metrics":{"views":1000}}]'
      />
      <div class="batch-foot">
        <span v-if="batchResult" class="batch-result">{{ batchResult }}</span>
        <button class="btn sm" @click="showBatch = false">取消</button>
        <button
          class="btn sm primary"
          :disabled="importing"
          @click="doBatchImport"
        >
          {{ importing ? '导入中…' : '导入' }}
        </button>
      </div>
    </div>

    <div v-if="loading && !publications.length" class="empty">加载中…</div>

    <!-- 列表视图 -->
    <template v-if="subTab === 'list' && !loading">
      <table v-if="publications.length" class="tbl">
        <thead>
          <tr>
            <th>标题</th>
            <th>平台</th>
            <th>A/B</th>
            <th>播放</th>
            <th>互动</th>
            <th>发布时间</th>
            <th>项目</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in publications" :key="p.id">
            <td>{{ p.title || '—' }}</td>
            <td>
              <span class="chip">{{
                PLATFORM_LABELS[p.platform] ?? p.platform
              }}</span>
            </td>
            <td>
              <span v-if="p.abGroup" class="chip ab">{{ p.abGroup }}</span
              ><span v-else class="muted">—</span>
            </td>
            <td class="mono">{{ fmtQty(p.metrics?.views ?? 0) }}</td>
            <td class="mono">
              {{
                fmtQty(
                  (p.metrics?.likes ?? 0) +
                    (p.metrics?.comments ?? 0) +
                    (p.metrics?.favorites ?? 0) +
                    (p.metrics?.shares ?? 0),
                )
              }}
            </td>
            <td class="muted">
              {{
                p.publishedAt
                  ? new Date(p.publishedAt).toLocaleDateString()
                  : '—'
              }}
            </td>
            <td class="muted">{{ projName(p.projectId) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无发布记录。点击「批量导入」添加数据。</div>
    </template>

    <!-- 趋势视图 -->
    <template v-if="subTab === 'trend'">
      <div v-if="trendItems.length" class="trend-view">
        <div class="panel block">
          <div class="bh">
            <span class="bt">播放量趋势</span>
            <span class="muted">近 {{ days }} 天</span>
          </div>
          <svg
            class="trend-bars"
            viewBox="0 0 100 60"
            preserveAspectRatio="none"
            role="img"
          >
            <rect
              v-for="(t, i) in trendItems"
              :key="i"
              :x="(i / trendItems.length) * 100"
              :y="60 - (t.views / maxTrendViews) * 56"
              :width="Math.max(0.5, 100 / trendItems.length - 0.3)"
              :height="(t.views / maxTrendViews) * 56"
              rx="0.3"
            >
              <title>
                {{ t.day }} · {{ fmtQty(t.views) }} 播放 · {{ t.count }} 条发布
              </title>
            </rect>
          </svg>
        </div>
        <table class="tbl">
          <thead>
            <tr>
              <th>日期</th>
              <th>发布数</th>
              <th>播放</th>
              <th>互动</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="t in trendItems.slice().reverse().slice(0, 14)"
              :key="t.day"
            >
              <td class="mono">{{ t.day }}</td>
              <td class="mono">{{ t.count }}</td>
              <td class="mono">{{ fmtQty(t.views) }}</td>
              <td class="mono">{{ fmtQty(t.interactions) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">
        暂无趋势数据（需有已发布且含发布时间的记录）
      </div>
    </template>

    <!-- A/B 对比视图 -->
    <template v-if="subTab === 'ab'">
      <div v-if="abItems.length" class="ab-view">
        <table class="tbl">
          <thead>
            <tr>
              <th>分组</th>
              <th>发布数</th>
              <th>总播放</th>
              <th>总互动</th>
              <th>均播放</th>
              <th>均互动</th>
              <th>平台</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in abItems" :key="g.group">
              <td>
                <span class="chip ab">{{ g.group }}</span>
              </td>
              <td class="mono">{{ g.count }}</td>
              <td class="mono">{{ fmtQty(g.views) }}</td>
              <td class="mono">{{ fmtQty(g.interactions) }}</td>
              <td class="mono">{{ fmtQty(g.avgViews) }}</td>
              <td class="mono">{{ fmtQty(g.avgInteractions) }}</td>
              <td class="muted">
                {{ g.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(', ') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">
        暂无 A/B 分组数据。发布时设置 ab_group 字段即可启用对比。
      </div>
    </template>
  </div>
</template>

<style scoped>
.pub-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pub-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.pub-toolbar select {
  width: 150px;
}
.seg {
  display: inline-flex;
  gap: 3px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 3px;
}
.seg button {
  border: none;
  background: none;
  color: var(--text-2);
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 7px;
  cursor: pointer;
  transition: all 0.15s;
}
.seg button:hover {
  color: var(--text);
  background: var(--hover);
}
.seg button.on {
  background: var(--accent-weak);
  color: #a5b4fc;
  box-shadow: inset 0 0 0 1px rgb(99 102 241 / 45%);
}
.batch-import {
  padding: 14px;
}
.batch-import h4 {
  margin: 0 0 6px;
  font-size: 14px;
}
.batch-import textarea {
  width: 100%;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  color: var(--text);
  font-family: var(--mono, monospace);
  font-size: 12px;
  resize: vertical;
}
.batch-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.batch-result {
  margin-right: auto;
  font-size: 12px;
}
.chip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--chip-bg);
  color: var(--text-2);
}
.chip.ab {
  background: var(--accent-weak);
  color: #a5b4fc;
}
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
.trend-bars {
  width: 100%;
  height: 120px;
  display: block;
}
.trend-bars rect {
  fill: var(--accent);
  opacity: 0.85;
}
.trend-bars rect:hover {
  fill: var(--accent-h);
  opacity: 1;
}
.sm {
  font-size: 12px;
}
.muted {
  color: var(--text-3);
}
</style>
