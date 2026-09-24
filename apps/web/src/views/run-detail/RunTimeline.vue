<script setup lang="ts">
import RunStepCard from './RunStepCard.vue'
import type { RunDetailApi } from './use-run-detail'
import type { ExtrasApi } from './use-run-extras'
const props = defineProps<{ u: RunDetailApi; e: ExtrasApi }>()
const { u, e } = props
const { steps } = props.u
</script>

<template>
  <div class="timeline panel">
    <RunStepCard v-for="s in steps" :key="s.id" :s="s" :u="u" :e="e" />

    <div v-if="!steps.length" class="empty">该 run 尚无步骤记录</div>
  </div>
</template>

<style scoped>
.timeline {
  padding: 10px 14px;
}

.st {
  display: flex;
  gap: 12px;
}

.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 28px;
}

.dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgb(148 163 184 / 13%);
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  z-index: 1;
  border: 1px solid rgb(148 163 184 / 14%);
}

.line {
  width: 2px;
  flex: 1;
  min-height: 12px;
  background: var(--border);
}

.st:last-child .line {
  display: none;
}

.st.ok .dot {
  background: var(--ok-weak);
  color: var(--ok);
  border-color: rgb(34 197 94 / 25%);
}

/* skipped：中性灰，虚线标记「无产物经过」 */
.st.skip .dot {
  background: rgb(148 163 184 / 7%);
  color: var(--text-3);
  border-color: rgb(148 163 184 / 18%);
  border-style: dashed;
}

.st.skip .line {
  background-image: linear-gradient(
    90deg,
    transparent 30%,
    var(--border) 31%,
    var(--border) 69%,
    transparent 70%
  );
  background-size: 6px 2px;
  background-repeat: repeat-x;
  background-position: 0 60%;
}

.st.running .dot {
  background: var(--run-weak);
  color: var(--run);
  border-color: rgb(129 140 248 / 30%);
  animation: pulse 1.2s infinite;
}

.st.failed .dot {
  background: var(--bad-weak);
  color: var(--bad);
  border-color: rgb(248 113 113 / 26%);
}

.st.gate .dot {
  background: var(--warn-weak);
  color: var(--warn);
  border-color: rgb(245 158 11 / 28%);
  box-shadow: 0 0 0 4px rgb(245 158 11 / 10%);
}

.st.cancel .dot {
  background: rgb(148 163 184 / 9%);
  color: var(--text-3);
  border-color: rgb(148 163 184 / 16%);
}

@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}

.dim {
  opacity: 0.55;
}
</style>
