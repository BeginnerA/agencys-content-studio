<script setup lang="ts">
/**
 * [M20] 预算面板（B4）
 * 展示预算配置 + 使用情况 + 告警历史。
 */
import { computed, onMounted, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { budgetApi, projectApi } from '../../lib/api'
import type {
  BudgetAlert,
  BudgetOverviewResult,
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
  if (r >= 0.8) return 'var(--warn, orange)'
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
</script>

<template>
  <div class="budget-panel">
    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-if="overview && !loading">
      <!-- 无预算配置 -->
      <div v-if="!hasAnyBudget && !editing" class="empty-state">
        <Icon name="shield" :size="32" />
        <p>暂未设置预算</p>
        <button class="btn primary sm" @click="startEdit">设置预算</button>
      </div>

      <!-- 预算概览 -->
      <div v-else-if="!editing" class="budget-overview">
        <div class="bo-header">
          <h3>预算概览</h3>
          <button class="btn sm" @click="startEdit">
            <Icon name="edit" :size="12" /> 编辑
          </button>
        </div>

        <!-- 全局预算 -->
        <div v-if="overview.global.monthly" class="bo-row">
          <div class="bo-label">全局月度</div>
          <div class="bo-bar">
            <div
              class="bo-fill"
              :style="{
                width: Math.min(100, overview.global.monthly.ratio * 100) + '%',
                background: ratioColor(overview.global.monthly.ratio),
              }"
            />
          </div>
          <div class="bo-text mono">
            {{ fmtCost(overview.global.monthly.spent) }} /
            {{ fmtCost(overview.global.monthly.budget) }}
          </div>
          <div
            class="bo-pct mono"
            :style="{ color: ratioColor(overview.global.monthly.ratio) }"
          >
            {{ Math.round(overview.global.monthly.ratio * 100) }}%
          </div>
        </div>

        <!-- 项目级预算 -->
        <div
          v-for="pb in overview.projects"
          :key="pb.projectId"
          class="bo-section"
        >
          <div class="bo-proj-name">{{ projName(pb.projectId) }}</div>
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
            <div
              class="bo-pct mono"
              :style="{ color: ratioColor(pb.monthly.ratio) }"
            >
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
            <div
              class="bo-pct mono"
              :style="{ color: ratioColor(pb.total.ratio) }"
            >
              {{ Math.round(pb.total.ratio * 100) }}%
            </div>
          </div>
        </div>

        <!-- 告警历史 -->
        <div v-if="alerts.length" class="bo-alerts">
          <h4>最近告警</h4>
          <div
            v-for="a in alerts.slice(-5).reverse()"
            :key="a.id"
            class="alert-row"
          >
            <span class="alert-scope">{{
              a.scope === 'global' ? '全局' : projName(a.scopeId!)
            }}</span>
            <span class="alert-kind">{{
              a.kind === 'monthly' ? '月度' : '总计'
            }}</span>
            <span
              class="alert-ratio mono"
              :style="{ color: ratioColor(a.ratio) }"
              >{{ Math.round(a.ratio * 100) }}%</span
            >
            <span class="alert-time muted">{{ fmtTime(a.createdAt) }}</span>
          </div>
        </div>
      </div>

      <!-- 编辑模式 -->
      <div v-else class="budget-edit">
        <h3>编辑预算</h3>
        <div class="edit-section">
          <h4>全局预算（元）</h4>
          <div class="edit-row">
            <label
              >月度上限
              <input
                v-model="editGlobalMonthly"
                type="number"
                min="0"
                step="100"
                placeholder="不限"
            /></label>
            <label
              >总上限
              <input
                v-model="editGlobalTotal"
                type="number"
                min="0"
                step="100"
                placeholder="不限"
            /></label>
          </div>
        </div>
        <div class="edit-section">
          <h4>告警阈值</h4>
          <label
            >使用率达到此比例时告警
            <input
              v-model="editAlertRatio"
              type="number"
              min="0.1"
              max="1"
              step="0.05"
          /></label>
        </div>
        <div class="edit-section">
          <h4>项目级预算（元）</h4>
          <div
            v-for="pb in editProjectBudgets"
            :key="pb.projectId"
            class="edit-proj-row"
          >
            <span class="ep-name">{{ projName(pb.projectId) }}</span>
            <label
              >月度
              <input
                v-model="pb.monthly"
                type="number"
                min="0"
                step="100"
                placeholder="不限"
            /></label>
            <label
              >总计
              <input
                v-model="pb.total"
                type="number"
                min="0"
                step="100"
                placeholder="不限"
            /></label>
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
.budget-overview,
.budget-edit {
  padding: 0;
}
.bo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.bo-header h3 {
  margin: 0;
  font-size: 15px;
}
.bo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}
.bo-label {
  width: 56px;
  font-size: 12px;
  color: var(--text-3);
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
  min-width: 120px;
  text-align: right;
}
.bo-pct {
  font-size: 13px;
  font-weight: 600;
  min-width: 40px;
  text-align: right;
}
.bo-section {
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.bo-proj-name {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}
.bo-alerts {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.bo-alerts h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-3);
}
.alert-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
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
}
.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-3);
}
.empty-state p {
  margin: 8px 0 16px;
}
.budget-edit h3 {
  margin: 0 0 16px;
  font-size: 15px;
}
.edit-section {
  margin-bottom: 16px;
}
.edit-section h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-3);
}
.edit-row {
  display: flex;
  gap: 12px;
}
.edit-row label,
.edit-section > label,
.edit-proj-row label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-3);
}
.edit-row input,
.edit-section input,
.edit-proj-row input {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--text);
  font-size: 13px;
  width: 120px;
}
.edit-proj-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}
.ep-name {
  flex: 1;
  font-size: 13px;
}
.edit-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
