<script setup lang="ts">
/**
 * 创作画布边层（自 CreationBoard.vue 整块迁移：SVG 三次贝塞尔 + 箭头 marker + 临时连线）
 */
import type { EdgePath } from './internals'

defineProps<{
  edgePaths: EdgePath[]
  linkPath: string | null
  svgBox: { x: number; y: number; w: number; h: number }
}>()
const emit = defineEmits<{
  selectEdge: [id: number]
}>()
</script>

<template>
  <svg
    class="cb-edges"
    :width="svgBox.w"
    :height="svgBox.h"
    :viewBox="`${svgBox.x} ${svgBox.y} ${svgBox.w} ${svgBox.h}`"
    :style="{ left: `${svgBox.x}px`, top: `${svgBox.y}px` }"
  >
    <defs>
      <marker
        id="cb-arrow"
        viewBox="0 0 10 10"
        refX="8.5"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(148 163 184 / 60%)" />
      </marker>
      <marker
        id="cb-arrow-sel"
        viewBox="0 0 10 10"
        refX="8.5"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent-h)" />
      </marker>
    </defs>
    <g v-for="e in edgePaths" :key="e.id">
      <path
        :d="e.d"
        class="cb-edge-hit"
        @pointerdown.stop="emit('selectEdge', e.id)"
      />
      <path
        :d="e.d"
        class="cb-edge"
        :class="{ sel: e.sel }"
        :port="e.port"
        :marker-end="e.sel ? 'url(#cb-arrow-sel)' : 'url(#cb-arrow)'"
      />
    </g>
    <path v-if="linkPath" :d="linkPath" class="cb-edge tmp" />
  </svg>
</template>

<style scoped>
.cb-edges {
  position: absolute;
  pointer-events: none;
  overflow: visible;
}

.cb-edge {
  fill: none;
  stroke: rgb(148 163 184 / 58%);
  stroke-width: 1.7;
}

.cb-edge.sel {
  stroke: var(--accent-h);
  stroke-width: 2.4;
}

.cb-edge.tmp {
  stroke: var(--accent-h);
  stroke-width: 1.8;
  stroke-dasharray: 6 5;
  animation: cb-dash 0.8s linear infinite;
}

@keyframes cb-dash {
  to {
    stroke-dashoffset: -22;
  }
}

.cb-edge-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  pointer-events: stroke;
  cursor: pointer;
}
</style>
