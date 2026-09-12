<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'

defineProps<{ title: string; width?: number; zIndex?: number }>()
const emit = defineEmits<{ close: [] }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="mask" :style="zIndex !== undefined ? { zIndex } : undefined" @click.self="emit('close')">
      <div class="dlg panel" :style="width ? { width: width + 'px' } : {}">
        <div class="head">
          <span class="t">{{ title }}</span>
          <button class="x" aria-label="关闭" @click="emit('close')">
            <Icon name="x" :size="15" :stroke-width="2" />
          </button>
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
  background: rgb(3 6 14 / 62%);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: fade-in 0.15s ease-out;
}

.dlg {
  max-width: min(92vw, 960px);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: pop-in 0.18s ease-out;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
}

@keyframes pop-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.98);
  }
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--text-3);
  cursor: pointer;
  transition: all 0.15s;
}

.x:hover {
  color: var(--bad);
  background: var(--hover);
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
  background: var(--panel-2);
}
</style>
