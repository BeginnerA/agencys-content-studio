<script setup lang="ts">
/**
 * 预算面板（B4）
 * 展示预算配置 + 使用情况 + 告警历史。
 * [重设计·渐进优化] 顶部新增 KPI 概览条、内容卡片化、进度条与编辑表单层级优化；
 * 仅改模板与样式，后端接口与保存/校验逻辑保持不变。
 */
import { computed, onMounted, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { budgetApi, projectApi } from '../../lib/api'
import type {
  BudgetAlert,
  BudgetOverviewResult,
  BudgetUsage,
  Project,
} from '../../lib/types'
import { fmtCost, fmtTime } from '../../lib/format'

const loading = ref(true)
const err = ref('')
const saving = ref(false)
const overview = ref<BudgetOverviewResult | null>(null)
const alerts = ref<BudgetAlert[]>([])
const projects = ref<Project[]>([])
const editing = ref(false)

// 编辑表单
const editGlobalMonthly = ref('')
const editGlobalTotal = ref('')
const editAlertRatio = ref('0.8')
const editProjectBudgets = ref<
  Array<{ projectId: number; monthly: string; total: string }>
>([])

async function load() {
  loading.value = true
  err.value = ''
  try {
    const [ov, al, pl] = await Promise.all([
      budgetApi.overview(),
      budgetApi.alerts(),
      projectApi.list(),
    ])
    overview.value = ov
    alerts.value = al.items
    projects.value = pl.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

function startEdit() {
  const ov = overview.value
  if (!ov) return
  editGlobalMonthly.value = ov.config.global?.monthly?.toString() ?? ''
  editGlobalTotal.value = ov.config.global?.total?.toString() ?? ''
  editAlertRatio.value = (ov.config.alertRatio ?? 0.8).toString()
  editProjectBudgets.value = projects.value.map((p) => {
    const pb = ov.config.projects?.[String(p.id)]
    return {
      projectId: p.id,
      monthly: pb?.monthly?.toString() ?? '',
      total: pb?.total?.toString() ?? '',
    }
  })
  editing.value = true
}

async function saveEdit() {
  if (!overview.value) return
  saving.value = true
  err.value = ''
  try {
    const cfg = { ...overview.value.config }
    // 全局
    const gm = parseFloat(editGlobalMonthly.value)
    const gt = parseFloat(editGlobalTotal.value)
    cfg.global = {
      ...(Number.isFinite(gm) && gm > 0 ? { monthly: gm } : {}),
      ...(Number.isFinite(gt) && gt > 0 ? { total: gt } : {}),
    }
    if (!Object.keys(cfg.global).length) delete cfg.global
    // 告警比例
    const ar = parseFloat(editAlertRatio.value)
    if (Number.isFinite(ar) && ar > 0 && ar <= 1) cfg.alertRatio = ar
    // 项目级
    const projBudgets: Record<string, { monthly?: number; total?: number }> = {}
    for (const pb of editProjectBudgets.value) {
      const m = parseFloat(pb.monthly)
      const t = parseFloat(pb.total)
      if ((Number.isFinite(m) && m > 0) || (Number.isFinite(t) && t > 0)) {
        projBudgets[String(pb.projectId)] = {
          ...(Number.isFinite(m) && m > 0 ? { monthly: m } : {}),
          ...(Number.isFinite(t) && t > 0 ? { total: t } : {}),
        }
      }
    }
    if (Object.keys(projBudgets).length) cfg.projects = projBudgets
    else delete cfg.projects

    await budgetApi.save(cfg)
    editing.value = false
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function ratioColor(r: number): string {
  if (r >= 1) return 'var(--bad)'
  if (r >= 0.8) return 'var(--warn)'
  if (r >= 0.5) return 'var(--accent)'
  return 'var(--ok)'
}

function projName(id: number) {
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`
}

const hasAnyBudget = computed(() => {
  const ov = overview.value
  if (!ov) return false
  return !!(
    ov.config.global?.monthly ||
    ov.config.global?.total ||
    (ov.config.projects && Object.keys(ov.config.projects).length)
  )
})

// ── [重设计] KPI 概览派生数据（仅读 overview / alerts，不触后端）──
const alertRatio = computed(() => overview.value?.config.alertRatio ?? 0.8)
const globalMonthly = computed<BudgetUsage | null>(
  () => overview.value?.global?.monthly ?? null,
)
const projectsWithBudget = computed(() =>
  (overview.value?.projects ?? []).filter(
    (p) => p.monthly.budget > 0 || p.total.budget > 0,
  ),
)
/** 所有配了预算的用量条目（全局月度 + 各项目月度 / 总计），用于统计预警与超支 */
const allUsages = computed<Array<{ label: string; u: BudgetUsage }>>(() => {
  const out: Array<{ label: string; u: BudgetUsage }> = []
  const gm = overview.value?.global?.monthly
  if (gm && gm.budget > 0) out.push({ label: '全局 · 月度', u: gm })
  for (const p of overview.value?.projects ?? []) {
    if (p.monthly.budget > 0)
      out.push({ label: `${projName(p.projectId)} · 月度`, u: p.monthly })
    if (p.total.budget > 0)
      out.push({ label: `${projName(p.projectId)} · 总计`, u: p.total })
  }
  return out
})
const overCount = computed(
  () => allUsages.value.filter((x) => x.u.ratio >= 1).length,
)
const warnCount = computed(
  () =>
    allUsages.value.filter(
      (x) => x.u.ratio >= alertRatio.value && x.u.ratio < 1,
    ).length,
)
</script>

<template>
  <div class="budget-panel">
    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-if="overview && !loading">
      <!-- 无预算配置：引导式空态 -->
      <div v-if="!hasAnyBudget && !editing" class="empty-state panel">
        <div class="es-ic"><Icon name="shield" :size="24" /></div>
        <div class="es-title">暂未设置预算</div>
        <p class="es-sub">
          设定全局 / 项目级月度与总额上限后，系统会在用量触及告警阈值时提醒并拦截超支。
        </p>
        <button class="btn primary" @click="startEdit">
          <Icon name="plus" :size="13" /> 设置预算
        </button>
      </div>

      <!-- 预算概览 -->
      <div v-else-if="!editing" class="budget-overview">
        <!-- KPI 概览条 -->
        <div class="bkpis">
          <div class="bkpi panel">
            <div class="bk-l">全局月度</div>
            <div
              class="bk-v"
              :style="{
                color: globalMonthly
                  ? ratioColor(globalMonthly.ratio)
                  : 'var(--text-3)',
              }"
            >
              {{ globalMonthly ? Math.round(globalMonthly.ratio * 100) + '%' : '—' }}
            </div>
            <div class="bk-s muted mono">
              {{
                globalMonthly
                  ? fmtCost(globalMonthly.spent) + ' / ' + fmtCost(globalMonthly.budget)
                  : '未设月度上限'
              }}
            </div>
          </div>
          <div class="bkpi panel">
            <div class="bk-l">项目预算</div>
            <div class="bk-v">{{ projectsWithBudget.length }}</div>
            <div class="bk-s muted">已配置预算的项目</div>
          </div>
          <div class="bkpi panel" :class="{ 'is-warn': warnCount > 0 }">
            <div class="bk-l">接近阈值</div>
            <div
              class="bk-v"
              :style="{ color: warnCount ? 'var(--warn)' : 'var(--text)' }"
            >
              {{ warnCount }}
            </div>
            <div class="bk-s muted">达到 {{ Math.round(alertRatio * 100) }}% 告警线</div>
          </div>
          <div class="bkpi panel" :class="{ 'is-bad': overCount > 0 }">
            <div class="bk-l">已超支</div>
            <div
              class="bk-v"
              :style="{ color: overCount ? 'var(--bad)' : 'var(--text)' }"
            >
              {{ overCount }}
            </div>
            <div class="bk-s muted">{{ alerts.length }} 条告警记录</div>
          </div>
        </div>

        <!-- 使用进度卡片 -->
        <div class="bo-card panel">
          <div class="bo-header">
            <h3><Icon name="chart" :size="14" /> 预算使用</h3>
            <button class="btn sm" @click="startEdit">
              <Icon name="edit" :size="12" /> 编辑预算
            </button>
          </div>

          <!-- 全局预算 -->
          <div v-if="globalMonthly" class="bo-group">
            <div class="bo-row">
              <div class="bo-label">全局月度</div>
              <div class="bo-bar">
                <div
                  class="bo-fill"
                  :style="{
                    width: Math.min(100, globalMonthly.ratio * 100) + '%',
                    background: ratioColor(globalMonthly.ratio),
                  }"
                />
              </div>
              <div class="bo-text mono">
                {{ fmtCost(globalMonthly.spent) }} /
                {{ fmtCost(globalMonthly.budget) }}
              </div>
              <div class="bo-pct mono" :style="{ color: ratioColor(globalMonthly.ratio) }">
                {{ Math.round(globalMonthly.ratio * 100) }}%
              </div>
            </div>
          </div>

          <!-- 项目级预算 -->
          <div
            v-for="pb in projectsWithBudget"
            :key="pb.projectId"
            class="bo-section"
          >
            <div class="bo-proj-name">
              <Icon name="folder" :size="12" /> {{ projName(pb.projectId) }}
            </div>
            <div v-if="pb.monthly.budget" class="bo-row">
              <div class="bo-label">月度</div>
              <div class="bo-bar">
                <div
                  class="bo-fill"
                  :style="{
                    width: Math.min(100, pb.monthly.ratio * 100) + '%',
                    background: ratioColor(pb.monthly.ratio),
                  }"
                />
              </div>
              <div class="bo-text mono">
                {{ fmtCost(pb.monthly.spent) }} / {{ fmtCost(pb.monthly.budget) }}
              </div>
              <div class="bo-pct mono" :style="{ color: ratioColor(pb.monthly.ratio) }">
                {{ Math.round(pb.monthly.ratio * 100) }}%
              </div>
            </div>
            <div v-if="pb.total.budget" class="bo-row">
              <div class="bo-label">总计</div>
              <div class="bo-bar">
                <div
                  class="bo-fill"
                  :style="{
                    width: Math.min(100, pb.total.ratio * 100) + '%',
                    background: ratioColor(pb.total.ratio),
                  }"
                />
              </div>
              <div class="bo-text mono">
                {{ fmtCost(pb.total.spent) }} / {{ fmtCost(pb.total.budget) }}
              </div>
              <div class="bo-pct mono" :style="{ color: ratioColor(pb.total.ratio) }">
                {{ Math.round(pb.total.ratio * 100) }}%
              </div>
            </div>
          </div>

          <div
            v-if="!globalMonthly && !projectsWithBudget.length"
            class="bo-none muted"
          >
            已保存配置，但暂无生效的月度用量。
          </div>
        </div>

        <!-- 告警历史 -->
        <div v-if="alerts.length" class="bo-alerts panel">
          <div class="bo-header">
            <h3><Icon name="alert" :size="14" /> 最近告警</h3>
          </div>
          <div
            v-for="a in alerts.slice(-8).reverse()"
            :key="a.id"
            class="alert-row"
          >
            <span
              class="alert-dot"
              :style="{ background: ratioColor(a.ratio) }"
            />
            <span class="alert-scope">{{
              a.scope === 'global' ? '全局' : projName(a.scopeId!)
            }}</span>
            <span class="alert-kind">{{
              a.kind === 'monthly' ? '月度' : '总计'
            }}</span>
            <span class="alert-ratio mono" :style="{ color: ratioColor(a.ratio) }"
              >{{ Math.round(a.ratio * 100) }}%</span
            >
            <span class="alert-time muted mono">{{ fmtTime(a.createdAt) }}</span>
          </div>
        </div>
      </div>

      <!-- 编辑模式 -->
      <div v-else class="budget-edit panel">
        <div class="bo-header">
          <h3><Icon name="sliders" :size="14" /> 编辑预算</h3>
        </div>
        <div class="edit-section">
          <h4>全局预算（元）</h4>
          <div class="edit-fields">
            <label class="edit-field">
              <span class="ef-label">月度上限</span>
              <input
                v-model="editGlobalMonthly"
                type="number"
                min="0"
                step="100"
                placeholder="不限"
              />
            </label>
            <label class="edit-field">
              <span class="ef-label">总额上限</span>
              <input
                v-model="editGlobalTotal"
                type="number"
                min="0"
                step="100"
                placeholder="不限"
              />
            </label>
          </div>
        </div>
        <div class="edit-section">
          <h4>告警阈值</h4>
          <label class="edit-field">
            <span class="ef-label">使用率达到此比例时告警（0.1–1，默认 0.8）</span>
            <input
              v-model="editAlertRatio"
              type="number"
              min="0.1"
              max="1"
              step="0.05"
            />
          </label>
        </div>
        <div class="edit-section">
          <h4>项目级预算（元）</h4>
          <div class="edit-proj-grid">
            <div class="ep-row ep-head">
              <span class="ep-name">项目</span>
              <span class="ep-col">月度上限</span>
              <span class="ep-col">总额上限</span>
            </div>
            <div
              v-for="pb in editProjectBudgets"
              :key="pb.projectId"
              class="ep-row"
            >
              <span class="ep-name">{{ projName(pb.projectId) }}</span>
              <input
                class="ep-input"
                v-model="pb.monthly"
                type="number"
                min="0"
                step="100"
                placeholder="不限"
              />
              <input
                class="ep-input"
                v-model="pb.total"
                type="number"
                min="0"
                step="100"
                placeholder="不限"
              />
            </div>
          </div>
        </div>
        <div class="edit-foot">
          <button class="btn" @click="editing = false">取消</button>
          <button class="btn primary" :disabled="saving" @click="saveEdit">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.budget-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.muted {
  color: var(--text-3);
}
.mono {
  font-family: var(--mono);
}
.err-text {
  color: var(--bad);
  font-size: 12px;
}

/* ── KPI 概览条 ── */
.bkpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.bkpi {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: relative;
  overflow: hidden;
}
.bkpi::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent);
  opacity: 0.7;
}
.bkpi.is-warn::before {
  background: var(--warn);
}
.bkpi.is-bad::before {
  background: var(--bad);
}
.bk-l {
  font-size: 12px;
  color: var(--text-2);
}
.bk-v {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 0.3px;
}
.bk-s {
  font-size: 11.5px;
}

/* ── 卡片容器 ── */
.bo-card,
.bo-alerts,
.budget-edit,
.empty-state {
  padding: 14px 16px 16px;
}
.bo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 12px;
}
.bo-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ── 进度行 ── */
.bo-group {
  padding-bottom: 4px;
}
.bo-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.bo-label {
  width: 68px;
  font-size: 12px;
  color: var(--text-2);
  flex-shrink: 0;
}
.bo-bar {
  flex: 1;
  height: 8px;
  background: var(--chip-bg);
  border-radius: 999px;
  overflow: hidden;
  min-width: 80px;
}
.bo-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s ease-out;
}
.bo-text {
  font-size: 12px;
  min-width: 130px;
  text-align: right;
  color: var(--text-2);
}
.bo-pct {
  font-size: 13px;
  font-weight: 600;
  min-width: 42px;
  text-align: right;
}
.bo-section {
  padding: 8px 0 4px;
  border-top: 1px solid var(--border);
  margin-top: 6px;
}
.bo-proj-name {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 2px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
}
.bo-none {
  font-size: 12px;
  padding: 8px 0;
}

/* ── 告警 ── */
.alert-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  padding: 6px 0;
  border-top: 1px solid var(--border);
}
.alert-row:first-of-type {
  border-top: none;
}
.alert-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}
.alert-scope {
  font-weight: 500;
}
.alert-kind {
  color: var(--text-3);
}
.alert-ratio {
  font-weight: 600;
}
.alert-time {
  margin-left: auto;
  font-size: 11px;
}

/* ── 空态 ── */
.empty-state {
  text-align: center;
  padding: 48px 20px;
  color: var(--text-3);
}
.es-ic {
  width: 56px;
  height: 56px;
  margin: 0 auto 12px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background: var(--accent-weak);
  color: var(--accent-h);
}
.es-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.es-sub {
  margin: 6px auto 18px;
  max-width: 420px;
  font-size: 12.5px;
  line-height: 1.6;
}

/* ── 编辑表单 ── */
.budget-edit {
  max-width: 720px;
}
.edit-section {
  margin-bottom: 18px;
}
.edit-section h4 {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.edit-fields {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.edit-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
  min-width: 200px;
  font-size: 12px;
  color: var(--text-3);
}
.edit-section > .edit-field {
  max-width: 320px;
}
.budget-edit input {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  color: var(--text);
  font-size: 13px;
  width: 100%;
  box-sizing: border-box;
}
.budget-edit input:focus {
  outline: none;
  border-color: var(--accent);
}
/* 项目预算表格 */
.edit-proj-grid {
  display: flex;
  flex-direction: column;
}
.ep-row {
  display: grid;
  grid-template-columns: 1fr 170px 170px;
  align-items: center;
  gap: 16px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.ep-head {
  border-top: none;
  padding: 0 0 6px;
}
.ep-head .ep-name,
.ep-head .ep-col {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.ep-name {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.edit-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
</style>
