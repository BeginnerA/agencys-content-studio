<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import { fmtSize, fmtTime } from '../../lib/format'
import type { PromptsApi } from './use-prompts'

const props = defineProps<{ p: PromptsApi }>()
const { prompts, pLoading, pListErr, pSelected, openPrompt, openNewPrompt } =
  props.p
</script>

<template>
  <aside class="panel list" aria-label="提示词文件列表">
    <div class="lhead">
      <span>提示词（{{ prompts.length }}）</span>
      <button class="btn sm" @click="openNewPrompt">
        <Icon name="plus" :size="12" :stroke-width="2.2" /> 新建
      </button>
    </div>
    <div v-if="pListErr" class="err-text">{{ pListErr }}</div>
    <div v-if="pLoading" class="empty">加载中…</div>
    <div v-else-if="!prompts.length" class="empty">
      workspace/prompts 下暂无文件
    </div>
    <button
      v-for="p in prompts"
      :key="p.name"
      class="item"
      :class="{ active: pSelected === p.name }"
      @click="openPrompt(p.name)"
    >
      <div class="r1">
        <span class="k mono">{{ p.name }}</span>
        <span v-if="p.builtin" class="chip builtin" title="系统内置提示词·只读，不可修改/删除">内置</span>
      </div>
      <div class="r3 muted">
        {{ fmtSize(p.size) }} · {{ fmtTime(p.updatedAt) }}
      </div>
    </button>
  </aside>
</template>

<style scoped>
.list {
  width: 264px;
  flex: none;
  padding: 10px;
  max-height: calc(100vh - 130px);
  overflow-y: auto;
}

.lhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 4px 10px;
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

.item .r1 {
  display: flex;
  align-items: center;
  gap: 7px;
  justify-content: space-between;
}

.item .k {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item .r3 {
  margin-top: 5px;
  font-size: 11px;
}

.item .chip.builtin {
  flex: none;
  padding: 1px 6px;
  font-size: 10.5px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 999px;
}
</style>
