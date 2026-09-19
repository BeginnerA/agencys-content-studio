<script setup lang="ts">
import { COST_KIND_TEXT } from './internals'
import { fmtCost, fmtQty } from '../../lib/format'
import type { ExtrasApi } from './use-run-extras'
const props = defineProps<{ e: ExtrasApi }>()
const { costUsage } = props.e
</script>

<template>
  <!-- [M4] 本 run 成本（usage_records 聚合，按 kind） -->
  <div class="panel mini">
    <div class="lhead">
      <span class="lt">本 run 成本</span>
      <span class="muted mono">{{
        costUsage ? fmtCost(costUsage.totals.cost) : '—'
      }}</span>
    </div>
    <div v-if="costUsage?.items.length" class="mrows">
      <div v-for="it in costUsage.items" :key="it.key" class="mrow">
        <span class="chip">{{ COST_KIND_TEXT[it.key] ?? it.key }}</span>
        <span class="muted mono">{{ fmtQty(it.quantity) }}</span>
        <span class="grow" />
        <span v-if="it.unpriced" class="badge skip"
          >未计价 {{ it.unpriced }}</span
        >
        <span class="mono">{{ fmtCost(it.cost) }}</span>
      </div>
    </div>
    <div v-else class="empty" style="padding: 10px 0">暂无用量记录</div>
  </div>
</template>

<style scoped>
/* [M4] 右栏辅助面板（成本 / 导出包 / 发布记录） */
.mini {
  padding: 10px 14px;
}

.mrows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.mrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.grow {
  flex: 1;
}

.lhead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.lt {
  font-weight: 600;
  font-size: 13px;
}
</style>
