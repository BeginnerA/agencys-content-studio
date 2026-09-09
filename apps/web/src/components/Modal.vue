<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'

defineProps<{ title: string; width?: number }>()
const emit = defineEmits<{ close: [] }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="mask" @click.self="emit('close')">
      <div class="dlg panel" :style="width ? { width: width + 'px' } : {}">
        <div class="head">
          <span class="t">{{ title }}</span>
          <button class="x" @click="emit('close')">✕</button>
        </div>
        <div class="body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgb(10 14 24 / 45%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.dlg {
  max-width: min(92vw, 960px);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  font-size: 14px;
}

.x {
  border: none;
  background: none;
  font-size: 13px;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px 6px;
}

.x:hover {
  color: var(--bad);
}

.body {
  padding: 16px;
  overflow-y: auto;
}

.foot {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  background: #fafbfc;
}
</style>
