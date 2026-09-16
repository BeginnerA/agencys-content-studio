<script setup lang="ts">
/**
 * [M23] 全景面板（spec §2.4；E1/E2）——项目内跨批次/跨模板聚合视图
 * - 页头：项目名 + stats（run 计数按状态 / 总成本）
 * - 批次组：批次头（名称/状态/进度/计数/时间 → 批次详情）+ 组内 run 卡（batchSeq 升序）
 * - 独立运行组：无批次归属 runs
 * 纯展示：数据由页面 loadOverview 拉取；卡片点击 emit 由页面导航
 */
import { computed } from 'vue'
import Icon from '../../common/Icon.vue'
import RunCard from './run-card.vue'
import { batchStatus, fmtCost, fmtTime, runStatus } from '../../../lib/format'
import type { CanvasOverview, CanvasOverviewBatch } from '../../../lib/types'
import type { RunStatus } from '../../../lib/types'

const props = defineProps<{ data: CanvasOverview }>()
const emit = defineEmits<{ 'open-run': [id: number]; 'open-batch': [id: number] }>()

/** 常见状态固定顺序，未知状态追加在后 */
const STATUS_ORDER: RunStatus[] = ['running', 'completed', 'failed', 'cancelled']
const statusChips = computed(() => {
  const by = props.data.stats.byStatus
  const seen = new Set<string>()
  const out: Array<{ s: RunStatus; n: number }> = []
  for (const s of STATUS_ORDER) {
    if (by[s]) {
      out.push({ s, n: by[s] })
      seen.add(s)
    }
  }
  for (const [s, n] of Object.entries(by)) {
    if (!seen.has(s)) out.push({ s: s as RunStatus, n })
  }
  return out
})

function batchProgress(b: CanvasOverviewBatch): number {
  if (!b.total) return 0
  return Math.round((b.finished / b.total) * 100)
}
</script>

<template>
  <div class="ov">
    <!-- 页头：项目 + stats -->
    <div class="panel ov-head">
      <div class="oh-l">
        <div class="oh-t">{{ data.project.name }}</div>
        <div class="muted oh-sub">共 {{ data.stats.runCount }} 条运行 · {{ data.batches.length }} 个批次</div>
      </div>
      <div class="oh-r">
        <span v-for="c in statusChips" :key="c.s" class="badge" :class="runStatus(c.s).cls">
          {{ runStatus(c.s).text }} {{ c.n }}
        </span>
        <span class="cost mono">总成本 {{ fmtCost(data.stats.totalCost) }}</span>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="!data.stats.runCount" class="panel ov-empty">
      <Icon name="map" :size="26" />
      <div class="muted">该项目暂无运行记录（可从项目页启动一条）</div>
    </div>

    <template v-else>
      <!-- 批次组 -->
      <section v-for="b in data.batches" :key="`b${b.id}`" class="panel bgrp">
        <div class="bhead" role="button" tabindex="0" :title="`查看批次 #${b.id}`" @click="emit('open-batch', b.id)" @keydown.enter="emit('open-batch', b.id)">
          <span class="bname">{{ b.name }}</span>
          <span class="badge" :class="batchStatus(b.status).cls">{{ batchStatus(b.status).text }}</span>
          <span class="bmeta mono muted">完成 {{ b.finished }}/{{ b.total }} · 成功 {{ b.succeeded }} · 失败 {{ b.failed }}</span>
          <span class="sp" />
          <span class="muted btime">{{ fmtTime(b.createdAt) }}</span>
          <span class="bgo muted">查看批次 <Icon name="chevron-right" :size="11" /></span>
        </div>
        <div class="ptrack"><div class="pfill" :style="{ width: `${batchProgress(b)}%` }" /></div>
        <div v-if="b.runs.length" class="rgrid">
          <RunCard v-for="r in b.runs" :key="r.id" :run="r" show-seq @open="emit('open-run', $event)" />
        </div>
        <div v-else class="muted">批次内暂无运行</div>
      </section>

      <!-- 独立运行组 -->
      <section v-if="data.standaloneRuns.length" class="panel bgrp">
        <div class="bhead">
          <span class="bname">独立运行</span>
          <span class="bmeta mono muted">{{ data.standaloneRuns.length }} 条 · 不隶属批次</span>
        </div>
        <div class="rgrid">
          <RunCard v-for="r in data.standaloneRuns" :key="r.id" :run="r" @open="emit('open-run', $event)" />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.ov {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  overflow-y: auto;
  padding: 12px;
}

.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.ov-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 11px 14px;
}

.oh-t {
  font-size: 15px;
  font-weight: 700;
}

.oh-sub {
  font-size: 12px;
  margin-top: 2px;
}

.oh-r {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin-left: auto;
}

.cost {
  font-size: 12px;
  color: var(--text-2);
}

.ov-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 46px 20px;
  color: var(--text-3);
}

.bgrp {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 11px 14px 13px;
}

.bhead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  cursor: pointer;
  border-radius: 7px;
  padding: 2px 4px;
  margin: -2px -4px;
}

.bhead:hover {
  background: var(--hover);
}

.bhead[role='button']:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.bname {
  font-size: 13.5px;
  font-weight: 600;
}

.bmeta {
  font-size: 11.5px;
}

.btime {
  font-size: 11.5px;
}

.bgo {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11.5px;
}

.ptrack {
  height: 6px;
  border-radius: 999px;
  background: var(--chip-bg);
  overflow: hidden;
}

.pfill {
  height: 100%;
  border-radius: 999px;
  background: var(--grad-brand);
  transition: width 0.3s ease-out;
}

.rgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}

.sp {
  flex: 1;
}
</style>
