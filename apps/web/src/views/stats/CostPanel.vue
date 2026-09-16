<script setup lang="ts">
/**
 * [M20] 成本聚合增强面板（B6）
 * 三维度分解：按 provider:model / 按项目 / 按 kind
 */
import { onMounted, ref } from 'vue'
import { statsApi } from '../../lib/api'
import type { CostBreakdown, CostItem } from '../../lib/types'
import { fmtCost, fmtQty } from '../../lib/format'

const loading = ref(true)
const err = ref('')
const data = ref<CostBreakdown | null>(null)
const days = ref(30)
const DAY_OPTIONS = [7, 30, 90] as const

async function load() {
  loading.value = true
  err.value = ''
  try {
    const from = Date.now() - days.value * 86_400_000
    data.value = await statsApi.costBreakdown(`?from=${from}`)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

function maxCost(items: CostItem[]): number {
  return Math.max(1, ...items.map((i) => i.cost))
}
</script>

<template>
  <div class="cost-panel">
    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-if="data && !loading">
      <!-- 工具栏 -->
      <div class="cost-toolbar">
        <div class="seg" role="group">
          <button v-for="d in DAY_OPTIONS" :key="d" :class="{ on: days === d }" @click="days = d; load()">{{ d }} 天</button>
        </div>
        <span class="cost-total mono">合计 <strong>{{ fmtCost(data.totals.cost) }}</strong> 元</span>
        <span v-if="data.totals.unpriced" class="unpriced-badge muted">{{ data.totals.unpriced }} 条未计价</span>
      </div>

      <!-- 按 provider:model -->
      <div class="panel block">
        <div class="bh">
          <span class="bt">按模型</span>
          <span class="muted">{{ data.byProviderModel.items.length }} 个模型</span>
        </div>
        <table class="tbl">
          <thead><tr><th>provider:model</th><th>调用</th><th>成本</th><th>占比</th></tr></thead>
          <tbody>
            <tr v-for="it in data.byProviderModel.items" :key="it.key">
              <td class="mono key">{{ it.key }}</td>
              <td class="mono">{{ fmtQty(it.count) }}</td>
              <td class="mono">{{ fmtCost(it.cost) }}</td>
              <td>
                <div class="mini-bar">
                  <div class="mini-fill" :style="{ width: (it.cost / maxCost(data.byProviderModel.items)) * 100 + '%' }" />
                </div>
              </td>
            </tr>
            <tr v-if="!data.byProviderModel.items.length">
              <td colspan="4"><div class="empty" style="padding: 12px 0">窗口内无用量</div></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 按项目 -->
      <div class="panel block">
        <div class="bh">
          <span class="bt">按项目</span>
          <span class="muted">{{ data.byProject.items.length }} 个项目</span>
        </div>
        <table class="tbl">
          <thead><tr><th>项目 ID</th><th>调用</th><th>成本</th><th>占比</th></tr></thead>
          <tbody>
            <tr v-for="it in data.byProject.items" :key="it.key">
              <td>项目 #{{ it.key }}</td>
              <td class="mono">{{ fmtQty(it.count) }}</td>
              <td class="mono">{{ fmtCost(it.cost) }}</td>
              <td>
                <div class="mini-bar">
                  <div class="mini-fill" :style="{ width: (it.cost / maxCost(data.byProject.items)) * 100 + '%' }" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 按 kind -->
      <div class="panel block">
        <div class="bh">
          <span class="bt">按类型</span>
          <span class="muted">{{ data.byKind.items.length }} 种类型</span>
        </div>
        <div class="kind-chips">
          <div v-for="it in data.byKind.items" :key="it.key" class="kind-chip">
            <span class="kc-label">{{ it.key }}</span>
            <span class="kc-cost mono">{{ fmtCost(it.cost) }}</span>
            <span class="kc-qty muted">{{ fmtQty(it.count) }} 次</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cost-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.seg { display: inline-flex; gap: 3px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 3px; }
.seg button { border: none; background: none; color: var(--text-2); font-size: 12px; padding: 4px 12px; border-radius: 7px; cursor: pointer; transition: all 0.15s; }
.seg button:hover { color: var(--text); background: var(--hover); }
.seg button.on { background: var(--accent-weak); color: #a5b4fc; box-shadow: inset 0 0 0 1px rgb(99 102 241 / 45%); }
.cost-total { font-size: 14px; }
.cost-total strong { font-size: 16px; color: var(--accent); }
.unpriced-badge { font-size: 11px; background: var(--warn-weak); padding: 2px 8px; border-radius: 999px; }
.block { padding: 12px 16px 16px; margin-bottom: 16px; }
.bh { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.bt { font-weight: 600; font-size: 14px; }
.key { font-size: 12px; word-break: break-all; }
.mini-bar { width: 80px; height: 6px; background: var(--chip-bg); border-radius: 999px; overflow: hidden; }
.mini-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.3s ease-out; }
.kind-chips { display: flex; gap: 10px; flex-wrap: wrap; }
.kind-chip { display: flex; align-items: center; gap: 8px; padding: 8px 14px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; }
.kc-label { font-weight: 600; font-size: 13px; }
.kc-cost { font-size: 14px; font-weight: 700; color: var(--accent); }
.kc-qty { font-size: 11px; }
.muted { color: var(--text-3); }
</style>
