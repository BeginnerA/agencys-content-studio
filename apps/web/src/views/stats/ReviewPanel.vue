<script setup lang="ts">
/**
 * 复盘数据面板（B7）
 * CSV 导出 + 趋势对比基线（当前周期 vs 上一周期）
 */
import { computed, onMounted, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { projectApi, statsApi } from '../../lib/api'
import type { CompareResult, Project } from '../../lib/types'
import { fmtCost, fmtQty } from '../../lib/format'

const loading = ref(false)
const err = ref('')
const projects = ref<Project[]>([])
const projectId = ref<number | ''>('')
const days = ref(30)
const DAY_OPTIONS = [7, 30, 90] as const
const compare = ref<CompareResult | null>(null)

async function loadProjects() {
  try {
    const p = await projectApi.list()
    projects.value = p.items
  } catch {
    /* 不阻塞 */
  }
}

async function loadCompare() {
  loading.value = true
  err.value = ''
  try {
    const params = `?days=${days.value}${projectId.value ? `&project_id=${projectId.value}` : ''}`
    compare.value = await statsApi.compare(params)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadProjects()
  void loadCompare()
})

function setDays(d: number) {
  days.value = d
  void loadCompare()
}

// CSV 下载
function downloadCsv(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  a.click()
}

const csvParams = computed(() => {
  const parts: string[] = []
  if (projectId.value) parts.push(`project_id=${projectId.value}`)
  return parts.length ? `?${parts.join('&')}` : ''
})

function deltaText(d: number, isPercent = false): string {
  if (d === 0) return '—'
  const sign = d > 0 ? '+' : ''
  if (isPercent) return `${sign}${(d * 100).toFixed(1)}%`
  return `${sign}${d}`
}

function deltaColor(d: number, invert = false): string {
  if (d === 0) return 'var(--text-3)'
  const positive = invert ? d < 0 : d > 0
  return positive ? 'var(--ok)' : 'var(--bad)'
}
</script>

<template>
  <div class="review-panel">
    <div v-if="err" class="err-text">{{ err }}</div>

    <!-- 工具栏 -->
    <div class="review-toolbar">
      <select v-model="projectId" @change="loadCompare()">
        <option value="">全部项目</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">
          {{ p.name }}
        </option>
      </select>
      <div class="seg" role="group">
        <button
          v-for="d in DAY_OPTIONS"
          :key="d"
          :class="{ on: days === d }"
          @click="setDays(d)"
        >
          {{ d }} 天
        </button>
      </div>
    </div>

    <!-- CSV 导出按钮 -->
    <div class="csv-section panel">
      <div class="csv-header">
        <h3><Icon name="download" :size="14" /> 复盘数据导出</h3>
        <span class="muted sm">导出 CSV 文件用于外部分析</span>
      </div>
      <div class="csv-buttons">
        <button
          class="btn sm"
          @click="downloadCsv(statsApi.csvRuns(csvParams))"
        >
          <Icon name="file" :size="12" /> 运行记录 CSV
        </button>
        <button
          class="btn sm"
          @click="downloadCsv(statsApi.csvPublications(csvParams))"
        >
          <Icon name="file" :size="12" /> 发布数据 CSV
        </button>
        <button
          class="btn sm"
          @click="downloadCsv(statsApi.csvUsage(csvParams))"
        >
          <Icon name="file" :size="12" /> 用量成本 CSV
        </button>
      </div>
    </div>

    <!-- 趋势对比基线 -->
    <div v-if="compare" class="compare-section">
      <h3>趋势对比（近 {{ compare.days }} 天 vs 上一周期）</h3>
      <div class="compare-grid">
        <div class="compare-card panel">
          <div class="cc-label">运行总数</div>
          <div class="cc-current mono">{{ compare.current.runs.total }}</div>
          <div class="cc-prev muted mono">
            上期 {{ compare.previous.runs.total }}
          </div>
          <div
            class="cc-delta mono"
            :style="{ color: deltaColor(compare.delta.runsTotal) }"
          >
            {{ deltaText(compare.delta.runsTotal) }}
          </div>
        </div>
        <div class="compare-card panel">
          <div class="cc-label">成功率</div>
          <div class="cc-current mono">
            {{ (compare.current.runs.successRate * 100).toFixed(1) }}%
          </div>
          <div class="cc-prev muted mono">
            上期 {{ (compare.previous.runs.successRate * 100).toFixed(1) }}%
          </div>
          <div
            class="cc-delta mono"
            :style="{ color: deltaColor(compare.delta.successRate) }"
          >
            {{ deltaText(compare.delta.successRate, true) }}
          </div>
        </div>
        <div class="compare-card panel">
          <div class="cc-label">总成本</div>
          <div class="cc-current mono">
            {{ fmtCost(compare.current.cost.total) }}
          </div>
          <div class="cc-prev muted mono">
            上期 {{ fmtCost(compare.previous.cost.total) }}
          </div>
          <div
            class="cc-delta mono"
            :style="{ color: deltaColor(compare.delta.costTotal, true) }"
          >
            {{ deltaText(compare.delta.costTotal) }}
          </div>
        </div>
        <div class="compare-card panel">
          <div class="cc-label">发布数</div>
          <div class="cc-current mono">
            {{ compare.current.publications.total }}
          </div>
          <div class="cc-prev muted mono">
            上期 {{ compare.previous.publications.total }}
          </div>
          <div
            class="cc-delta mono"
            :style="{
              color: deltaColor(
                compare.current.publications.total -
                  compare.previous.publications.total,
              ),
            }"
          >
            {{
              deltaText(
                compare.current.publications.total -
                  compare.previous.publications.total,
              )
            }}
          </div>
        </div>
        <div class="compare-card panel">
          <div class="cc-label">播放量</div>
          <div class="cc-current mono">
            {{ fmtQty(compare.current.publications.views) }}
          </div>
          <div class="cc-prev muted mono">
            上期 {{ fmtQty(compare.previous.publications.views) }}
          </div>
        </div>
        <div class="compare-card panel">
          <div class="cc-label">互动量</div>
          <div class="cc-current mono">
            {{ fmtQty(compare.current.publications.interactions) }}
          </div>
          <div class="cc-prev muted mono">
            上期 {{ fmtQty(compare.previous.publications.interactions) }}
          </div>
        </div>
      </div>
    </div>
    <div v-if="loading" class="empty">加载中…</div>
  </div>
</template>

<style scoped>
.review-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.review-toolbar select {
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
.csv-section {
  padding: 14px;
  margin-bottom: 16px;
}
.csv-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.csv-header h3 {
  margin: 0;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.csv-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.compare-section {
  margin-top: 8px;
}
.compare-section h3 {
  font-size: 14px;
  margin: 0 0 12px;
}
.compare-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}
.compare-card {
  padding: 14px;
  text-align: center;
}
.cc-label {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 6px;
}
.cc-current {
  font-size: 20px;
  font-weight: 700;
}
.cc-prev {
  font-size: 11px;
  margin-top: 2px;
}
.cc-delta {
  font-size: 13px;
  font-weight: 600;
  margin-top: 4px;
}
.sm {
  font-size: 12px;
}
.muted {
  color: var(--text-3);
}
</style>
