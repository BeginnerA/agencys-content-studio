<script setup lang="ts">
import { computed } from 'vue'
import { kindText, fmtDefault, BOX, BADGE_SLOT, computeFlow } from './internals'
import type { TemplatesApi } from './use-templates'

const props = defineProps<{ t: TemplatesApi }>()
const { liveTpl } = props.t

/** [M28] 流程图（由 internals.computeFlow 计算；viewBox 宽 560 固定）。 */
const flow = computed(() => computeFlow(liveTpl.value?.steps ?? []))
</script>

<template>
  <div v-if="liveTpl" class="info">
    <div class="ih">输入声明</div>
    <table v-if="liveTpl.inputs.length" class="tbl">
      <thead>
        <tr>
          <th>key</th>
          <th>label</th>
          <th>类型</th>
          <th>必填</th>
          <th>默认</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="inp in liveTpl.inputs" :key="inp.key">
          <td class="mono">{{ inp.key }}</td>
          <td>{{ inp.label ?? '—' }}</td>
          <td>{{ kindText(inp.kind) }}</td>
          <td>{{ inp.required ? '是' : '否' }}</td>
          <td class="mono">{{ fmtDefault(inp.default) }}</td>
        </tr>
      </tbody>
    </table>
    <div v-else class="muted">未声明输入</div>

    <div class="ih">步骤流程（依赖与徽标）</div>
    <svg
      class="flow"
      :viewBox="`0 0 560 ${flow.height}`"
      role="img"
      aria-label="步骤依赖流程图"
    >
      <defs>
        <marker
          id="flow-arr"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" class="farr" />
        </marker>
      </defs>
      <path
        v-for="(e, i) in flow.edges"
        :key="'e' + i"
        :d="e.d"
        class="fedge"
        marker-end="url(#flow-arr)"
      />
      <g v-for="b in flow.boxes" :key="'b' + b.i">
        <rect
          :x="BOX.x"
          :y="b.y"
          :width="BOX.w"
          :height="BOX.h"
          rx="10"
          class="fbox"
        />
        <text :x="BOX.x + 14" :y="b.y + 23" class="fk">
          {{ b.i + 1 }}. {{ b.key }}
        </text>
        <text :x="BOX.x + 14" :y="b.y + 42" class="ft">{{ b.title }}</text>
        <text
          :x="BOX.x + BOX.w - 14"
          :y="b.y + 23"
          text-anchor="end"
          class="fa"
        >
          {{ b.action }}
        </text>
        <g v-for="(bd, bi) in b.badges" :key="bi">
          <title>{{ bd.tip }}</title>
          <rect
            :x="BOX.x + BOX.w - 14 - 24 - bi * BADGE_SLOT"
            :y="b.y + 31"
            width="24"
            height="16"
            rx="5"
            class="fb"
            :class="bd.cls"
          />
          <text
            :x="BOX.x + BOX.w - 14 - 12 - bi * BADGE_SLOT"
            :y="b.y + 43"
            text-anchor="middle"
            class="fbt"
            :class="bd.cls"
          >
            {{ bd.text }}
          </text>
        </g>
      </g>
    </svg>
    <div class="legend">
      <span class="lg"><i class="dot gate" />闸门 gate</span>
      <span class="lg"><i class="dot batch" />批量 batch</span>
      <span class="lg"><i class="dot when" />条件 when</span>
      <span class="lg"><i class="dot any" />OR 组 when_any</span>
    </div>
  </div>
</template>

<style scoped>
/* ---------- 只读信息 ---------- */
.info {
  margin-top: 18px;
  border-top: 1px dashed var(--border);
  padding-top: 4px;
}

.ih {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-2);
  margin: 14px 0 8px;
}

.flow {
  width: 100%;
  height: auto;
  max-width: 720px;
  display: block;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.flow text {
  font-family: var(--mono);
}

.fbox {
  fill: #131c31;
  stroke: rgb(148 163 184 / 26%);
}

.fk {
  fill: #e8edf6;
  font-size: 12.5px;
  font-weight: 600;
}

.ft {
  fill: #66738e;
  font-size: 11px;
}

.fa {
  fill: #66738e;
  font-size: 10.5px;
}

.fedge {
  stroke: #3b4a6b;
  stroke-width: 1.4;
  fill: none;
}

.farr {
  fill: #3b4a6b;
}

.fb.gate {
  fill: rgb(139 92 246 / 16%);
  stroke: #a78bfa;
}

.fb.batch {
  fill: rgb(34 197 94 / 14%);
  stroke: #4ade80;
}

.fb.when,
.fb.any {
  fill: rgb(245 158 11 / 14%);
  stroke: #fbbf24;
}

.fbt.gate {
  fill: #c4b5fd;
  font-size: 10px;
}

.fbt.batch {
  fill: #86efac;
  font-size: 10px;
}

.fbt.when,
.fbt.any {
  fill: #fcd34d;
  font-size: 10px;
}

.legend {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.lg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-3);
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  display: inline-block;
  border: 1px solid;
}

.dot.gate {
  background: rgb(139 92 246 / 30%);
  border-color: #a78bfa;
}

.dot.batch {
  background: rgb(34 197 94 / 26%);
  border-color: #4ade80;
}

.dot.when,
.dot.any {
  background: rgb(245 158 11 / 26%);
  border-color: #fbbf24;
}
</style>
