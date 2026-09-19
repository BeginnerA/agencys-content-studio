<script setup lang="ts">
import type { SettingsApi } from './use-settings'
const props = defineProps<{ s: SettingsApi }>()
const { visible, selectedKey, selectedProvider, railStatus } = props.s
</script>

<template>
  <aside class="panel rail" aria-label="供应商列表">
    <div class="rhead">供应商（{{ visible.length }}）</div>
    <button
      v-for="p in visible"
      :key="p.key"
      class="item"
      :class="{ active: selectedProvider?.key === p.key }"
      :aria-current="selectedProvider?.key === p.key ? 'true' : undefined"
      @click="selectedKey = p.key"
    >
      <div class="i1">
        <span class="ik">{{ p.name }}</span>
        <span v-if="p.configs.length" class="icount">{{
          p.configs.length
        }}</span>
      </div>
      <div class="ist">
        <span class="dot" :class="railStatus(p).cls" />{{ railStatus(p).text }}
      </div>
    </button>
  </aside>
</template>

<style scoped>
.rail {
  width: 258px;
  flex: none;
  padding: 10px;
  max-height: calc(100vh - 190px);
  overflow-y: auto;
}

.rhead {
  padding: 2px 6px 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}

.item {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  border-radius: 10px;
  padding: 8px 10px;
  margin-bottom: 2px;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.item:hover {
  background: var(--hover);
}

.item.active {
  background: rgb(99 102 241 / 14%);
  border-color: rgb(99 102 241 / 32%);
}

.i1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
}

.ik {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icount {
  font-size: 10.5px;
  min-width: 17px;
  height: 17px;
  line-height: 17px;
  text-align: center;
  border-radius: 999px;
  padding: 0 3px;
  flex: none;
  background: rgb(148 163 184 / 14%);
  color: var(--text-3);
}

.ist {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 3px;
}

.ist .dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--text-3);
  flex: none;
}

.ist .dot.ok {
  background: var(--ok);
}

.ist .dot.warn {
  background: var(--warn);
}
</style>
