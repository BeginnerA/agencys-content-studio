<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { projectApi, statsApi } from '../lib/api'
import type { Overview, Project, UsageSummary } from '../lib/types'
import { KIND_TEXT, fmtCost, fmtQty } from '../lib/format'
import { projectGenreText } from '../lib/scene'

const loading = ref(true)
const err = ref('')
const ov = ref<Overview | null>(null)
const usage = ref<UsageSummary | null>(null)
const projects = ref<Project[]>([])

const projectId = ref<number | ''>('')
const days = ref(30)
const DAY_OPTIONS = [7, 30, 90] as const
const usageGroup = ref<'provider_model' | 'kind'>('provider_model')

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_input: '待审阅',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}
const STATUS_ORDER = ['running', 'waiting_input', 'queued', 'completed', 'failed', 'cancelled']

/** 查询串（跳过空值） */
function qs(obj: Record<string, string | number | undefined>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === '') continue
    parts.push(`${k}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

async function load() {
  loading.value = true
  err.value = ''
  try {
    const pid = projectId.value === '' ? undefined : projectId.value
    const [o, u] = await Promise.all([
      statsApi.overview(qs({ project_id: pid, days: days.value })),
      // usage 端点无 days 参数（§B）：窗口用 from 换算
      statsApi.usage(
        qs({
          group_by: usageGroup.value,
          project_id: pid,
          from: Date.now() - days.value * 86_400_000,
        }),
      ),
    ])
    ov.value = o
    usage.value = u
    void loadProjects()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  try {
    const p = await projectApi.list()
    projects.value = p.items
  } catch {
    // 项目下拉失败不阻塞看板
  }
  await load()
})
watch([projectId, days, usageGroup], () => void load())

/** 项目对比表：逐项目调 overview（N 项目 N 请求；本地单机规模可控，非阻塞） */
const projRows = ref<
  Array<{ id: number; name: string; genre: string; runs: number; rate: number; cost: number; assets: number; pubs: number }>
>([])
async function loadProjects() {
  const list = projects.value
  projRows.value = []
  if (!list.length) return
  try {
    const results = await Promise.all(list.map((p) => statsApi.overview(qs({ project_id: p.id, days: days.value }))))
    projRows.value = list.map((p, i) => {
      const r = results[i]
      return {
        id: p.id,
        name: p.name,
        genre: p.genre,
        runs: r?.runs.total ?? 0,
        rate: r?.runs.successRate ?? 0,
        cost: r?.cost.total ?? 0,
        assets: r?.assets.total ?? 0,
        pubs: r?.publications.total ?? 0,
      }
    })
  } catch {
    // 项目对比失败不阻塞主看板
  }
}

/** 活跃度柱状几何（viewBox 0 0 100 100；preserveAspectRatio=none 由外层容器等比拉伸） */
const chart = computed(() => {
  const acts = ov.value?.activity ?? []
  const n = acts.length || 1
  const max = Math.max(1, ...acts.map((a) => a.runs))
  const gap = n > 45 ? 0.7 : n > 14 ? 1.6 : 4
  const bw = Math.max(0.5, 100 / n - gap)
  return acts.map((a, i) => {
    // 无运行日画 0.8 高「地平线」小条；有运行最低 2 保证可见
    const h = a.runs > 0 ? Math.max(2, (a.runs / max) * 96) : 0.8
    const x = Math.round((i * (100 / n) + gap / 2) * 100) / 100
    return { ...a, x, bw: Math.round(bw * 100) / 100, h, y: 100 - h }
  })
})
const peak = computed(() => Math.max(0, ...(ov.value?.activity ?? []).map((a) => a.runs)))

/** 状态分布行（固定顺序在前，未知状态垫后；全时间口径） */
const statusRows = computed(() => {
  const bs = ov.value?.runs.byStatus ?? {}
  const total = Math.max(1, ov.value?.runs.total ?? 0)
  const known = STATUS_ORDER.filter((k) => (bs[k] ?? 0) > 0)
  const rest = Object.keys(bs).filter((k) => !STATUS_ORDER.includes(k) && (bs[k] ?? 0) > 0)
  return [...known, ...rest].map((k) => ({
    key: k,
    text: STATUS_TEXT[k] ?? k,
    n: bs[k] ?? 0,
    w: `${Math.max(2, Math.round(((bs[k] ?? 0) / total) * 100))}%`,
  }))
})

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}
</script>

<template>
  <div>
    <div class="page-h">
      <h1>统计</h1>
      <span class="sub">近 {{ days }} 天 · 运行 / 成本 / 发布复盘</span>
      <div class="ctl">
        <select v-model="projectId" aria-label="按项目筛选">
          <option value="">全部项目</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <div class="seg" role="group" aria-label="时间窗口">
          <button v-for="d in DAY_OPTIONS" :key="d" :class="{ on: days === d }" @click="days = d">
            {{ d }} 天
          </button>
        </div>
      </div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading && !ov" class="empty">加载中…</div>

    <template v-if="ov">
      <div class="kpis">
        <div class="kpi panel">
          <div class="kl">运行总数</div>
          <div class="kv mono">{{ ov.runs.total }}</div>
          <div class="ks muted">成功率 {{ pct(ov.runs.successRate) }}（终态口径）</div>
        </div>
        <div class="kpi panel">
          <div class="kl">总成本</div>
          <div class="kv mono">{{ fmtCost(ov.cost.total) }}</div>
          <div class="ks muted">近 30 天 {{ fmtCost(ov.cost.last30d) }}</div>
        </div>
        <div class="kpi panel">
          <div class="kl">资产</div>
          <div class="kv mono">{{ ov.assets.total }}</div>
          <div class="ks chips">
            <span v-for="(n, k) in ov.assets.byKind" :key="k" class="chip">{{ KIND_TEXT[k] ?? k }} {{ n }}</span>
          </div>
        </div>
        <div class="kpi panel">
          <div class="kl">发布登记</div>
          <div class="kv mono">{{ ov.publications.total }}</div>
          <div class="ks muted">播放 {{ fmtQty(ov.publications.views) }} · 互动 {{ fmtQty(ov.publications.interactions) }}</div>
        </div>
      </div>

      <div class="panel block">
        <div class="bh">
          <span class="bt">运行活跃度</span>
          <span class="muted">{{ ov.activeDays }}/{{ days }} 天有运行 · 单日峰值 {{ peak }}</span>
        </div>
        <svg class="bars" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="每日运行次数柱状图">
          <rect v-for="(b, i) in chart" :key="i" :x="b.x" :y="b.y" :width="b.bw" :height="b.h" rx="0.4">
            <title>{{ b.day }} · {{ b.runs }} 次 · {{ fmtCost(b.cost) }}</title>
          </rect>
        </svg>
        <div class="axis muted">
          <span>{{ chart[0]?.day ?? '—' }}</span>
          <span>悬停柱体查看当日运行数与成本</span>
          <span>{{ chart[chart.length - 1]?.day ?? '—' }}</span>
        </div>
      </div>

      <div class="two">
        <div class="panel block">
          <div class="bh">
            <span class="bt">成本构成</span>
            <span class="muted">合计 {{ fmtCost(usage?.totals.cost ?? 0) }} · 近 {{ days }} 天</span>
            <div class="seg sm" style="margin-left: auto" role="group" aria-label="分组切换">
              <button :class="{ on: usageGroup === 'provider_model' }" @click="usageGroup = 'provider_model'">按模型</button>
              <button :class="{ on: usageGroup === 'kind' }" @click="usageGroup = 'kind'">按类型</button>
            </div>
          </div>
          <div v-if="usage?.totals.unpriced" class="unpriced">
            <span>{{ usage.totals.unpriced }} 条用量未计价（缺定价配置）</span>
            <RouterLink class="btn sm" to="/settings">去配置定价</RouterLink>
          </div>
          <table class="tbl">
            <thead>
              <tr>
                <th>{{ usageGroup === 'provider_model' ? 'provider:model' : 'kind' }}</th>
                <th>调用</th>
                <th>用量</th>
                <th>成本</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in usage?.items ?? []" :key="it.key">
                <td class="mono key">{{ it.key }}</td>
                <td class="mono">{{ it.count }}</td>
                <td class="mono">{{ fmtQty(it.quantity) }}</td>
                <td class="mono">
                  {{ fmtCost(it.cost) }}
                  <span v-if="it.unpriced" class="unp">未计价 {{ it.unpriced }}</span>
                </td>
              </tr>
              <tr v-if="!usage?.items.length">
                <td colspan="4"><div class="empty" style="padding: 18px 0">窗口内无用量记录</div></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="panel block">
          <div class="bh">
            <span class="bt">运行状态分布</span>
            <span class="muted">全时间</span>
          </div>
          <div v-if="statusRows.length" class="rows">
            <div v-for="s in statusRows" :key="s.key" class="row">
              <span class="badge" :class="s.key">{{ s.text }}</span>
              <div class="track"><div class="fill" :class="s.key" :style="{ width: s.w }" /></div>
              <span class="mono n">{{ s.n }}</span>
            </div>
          </div>
          <div v-else class="empty" style="padding: 18px 0">暂无运行记录</div>
        </div>
      </div>

      <div class="panel block">
        <div class="bh">
          <span class="bt">项目对比</span>
          <span class="muted">{{ projRows.length }} 个项目 · 全时间</span>
        </div>
        <table class="tbl">
          <thead>
            <tr>
              <th>项目</th>
              <th>体裁</th>
              <th>运行</th>
              <th>成功率</th>
              <th>成本</th>
              <th>资产</th>
              <th>发布</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in projRows" :key="p.id">
              <td>{{ p.name }}</td>
              <td class="muted">{{ projectGenreText(p.genre) }}</td>
              <td class="mono">{{ p.runs }}</td>
              <td class="mono">{{ pct(p.rate) }}</td>
              <td class="mono">{{ fmtCost(p.cost) }}</td>
              <td class="mono">{{ p.assets }}</td>
              <td class="mono">{{ p.pubs }}</td>
              <td><RouterLink :to="`/projects/${p.id}`">查看 →</RouterLink></td>
            </tr>
            <tr v-if="!projRows.length">
              <td colspan="8"><div class="empty" style="padding: 18px 0">暂无项目</div></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ctl {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.ctl select {
  width: 170px;
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

.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.kpi {
  padding: 14px 16px;
}

.kl {
  font-size: 12px;
  color: var(--text-2);
}

.kv {
  font-size: 24px;
  font-weight: 700;
  margin: 4px 0 2px;
  letter-spacing: 0.3px;
}

.ks {
  font-size: 11.5px;
}

.chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
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

.bars {
  width: 100%;
  height: 140px;
  display: block;
}

.bars rect {
  fill: var(--accent);
  opacity: 0.85;
}

.bars rect:hover {
  fill: var(--accent-h);
  opacity: 1;
}

.axis {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
}

.two {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  gap: 16px;
  align-items: start;
}

@media (max-width: 1100px) {
  .two {
    grid-template-columns: 1fr;
  }
}

.unpriced {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-weak);
  border: 1px solid rgb(245 158 11 / 26%);
  border-radius: 8px;
  padding: 7px 10px;
  margin-bottom: 8px;
}

.unp {
  color: var(--warn);
  font-size: 11px;
  margin-left: 6px;
}

.key {
  font-size: 12px;
  word-break: break-all;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.track {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--chip-bg);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 999px;
  background: var(--run);
  transition: width 0.3s ease-out;
}

.fill.completed {
  background: var(--ok);
}

.fill.failed {
  background: var(--bad);
}

.fill.cancelled {
  background: #64748b;
}

.fill.waiting_input,
.fill.queued {
  background: var(--warn);
}

.n {
  width: 36px;
  text-align: right;
  font-size: 12px;
}

.seg.sm button {
  padding: 2px 9px;
  font-size: 11.5px;
}
</style>
