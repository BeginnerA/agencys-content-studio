<script setup lang="ts">
import { computed } from 'vue'
import type { TemplateMeta } from '../lib/types'
import { groupTemplates, genreText } from '../lib/scene'

const props = defineProps<{ templates: TemplateMeta[]; selected?: string; defaultKey?: string }>()
const emit = defineEmits<{ select: [key: string] }>()

const groups = computed(() => groupTemplates(props.templates))
</script>

<template>
  <div class="tp">
    <div v-for="g in groups" :key="g.key" class="grp">
      <div class="grp-h">
        <span class="grp-t">{{ g.label }}</span>
        <span v-if="g.hint" class="grp-hint">{{ g.hint }}</span>
      </div>
      <div class="cards">
        <button
          v-for="t in g.items"
          :key="t.key"
          type="button"
          class="tc"
          :class="{ on: t.key === selected }"
          @click="emit('select', t.key)"
        >
          <span class="tc-h">
            <span class="tc-nm">
              {{ t.name }}
              <span v-if="t.key === defaultKey" class="tc-def">默认</span>
            </span>
            <span class="tc-meta">{{ t.stepCount }} 步 · {{ genreText(t.genre) }}</span>
          </span>
          <span class="tc-ds">{{ t.description }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tp {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.grp-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 7px;
}

.grp-t {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.3px;
}

.grp-t::before {
  content: '';
  display: inline-block;
  width: 3px;
  height: 12px;
  border-radius: 2px;
  background: var(--grad-brand);
  margin-right: 7px;
  vertical-align: -1px;
}

.grp-hint {
  font-size: 11.5px;
  color: var(--text-3);
}

.cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.tc {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  font-family: inherit;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  cursor: pointer;
  color: var(--text);
  transition: background 0.15s, border-color 0.15s, transform 0.1s;
}

.tc:hover {
  background: var(--raised);
  border-color: rgb(99 102 241 / 55%);
}

.tc:active {
  transform: translateY(1px);
}

.tc.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgb(99 102 241 / 20%);
}

.tc-h {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.tc-nm {
  font-size: 13px;
  font-weight: 600;
}

/** [优化] 「默认」徽章：项目默认模板标记（不改变默认选中态） */
.tc-def {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-h);
  background: var(--accent-weak);
  border: 1px solid rgb(99 102 241 / 30%);
  border-radius: 999px;
  padding: 0 6px;
  margin-left: 5px;
  vertical-align: 1px;
  letter-spacing: 0.2px;
}

.tc-meta {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.tc-ds {
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
