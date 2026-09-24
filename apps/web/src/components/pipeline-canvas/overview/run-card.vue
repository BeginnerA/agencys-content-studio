<script setup lang="ts">
/**
 * 全景 run 卡片（spec §2.4）——批次组内与独立组共用
 * 纯展示：状态/模板版本/时间/耗时/成本；点击整卡 emit open（页面负责导航）
 */
import { fmtCost, fmtMs, fmtTime, runStatus } from '../../../lib/format'
import type { OverviewRunLite } from '../../../lib/types'

const props = defineProps<{ run: OverviewRunLite; showSeq?: boolean }>()
const emit = defineEmits<{ open: [id: number] }>()

/** 运行时长（起止齐全才计算；运行中/未开始 → —） */
function durOf(): string {
  const r = props.run
  if (r.startedAt && r.completedAt) return fmtMs(r.completedAt - r.startedAt)
  return '—'
}

/** 行内错误摘要（超长截断） */
function errOf(s: string): string {
  return s.length > 72 ? `${s.slice(0, 72)}…` : s
}
</script>

<template>
  <button
    type="button"
    class="rcard"
    :class="{ haserr: !!run.error }"
    @click="emit('open', run.id)"
  >
    <div class="r1">
      <span class="rid mono">#{{ run.id }}</span>
      <span class="badge" :class="runStatus(run.status).cls">{{
        runStatus(run.status).text
      }}</span>
      <span v-if="showSeq && run.batchSeq != null" class="seq mono"
        >批内 #{{ run.batchSeq }}</span
      >
      <span class="sp" />
      <span v-if="run.templateVersion != null" class="ver mono"
        >v{{ run.templateVersion }}</span
      >
    </div>
    <div class="tkey mono" :title="run.templateKey">{{ run.templateKey }}</div>
    <div class="r3 muted">
      <span>{{ fmtTime(run.createdAt) }}</span>
      <span>耗时 {{ durOf() }}</span>
      <span class="cost">{{ fmtCost(run.cost) }}</span>
    </div>
    <div v-if="run.error" class="rerr" :title="run.error">
      {{ errOf(run.error) }}
    </div>
  </button>
</template>

<style scoped>
.rcard {
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-align: left;
  font: inherit;
  color: var(--text);
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 9px 11px;
  cursor: pointer;
  min-width: 0;
}

.rcard:hover {
  border-color: var(--accent);
}

.rcard.haserr {
  border-color: rgb(248 113 113 / 38%);
}

.r1 {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.rid {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.seq {
  font-size: 11px;
  color: var(--text-3);
}

.ver {
  font-size: 11px;
  color: var(--text-3);
}

.tkey {
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.r3 {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  flex-wrap: wrap;
}

.cost {
  color: var(--text-2);
}

.rerr {
  font-size: 11px;
  color: var(--bad);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sp {
  flex: 1;
}
</style>
