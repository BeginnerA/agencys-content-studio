<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import { fmtTime } from '../../lib/format'
import type { TemplatesApi } from './use-templates'

const props = defineProps<{ t: TemplatesApi }>()
const { metas, metasLoading, listErr, selected, openTemplate, openNew } =
  props.t
</script>

<template>
  <aside class="panel list" aria-label="模板文件列表">
    <div class="lhead">
      <span>模板文件（{{ metas.length }}）</span>
      <button class="btn sm" @click="openNew">
        <Icon name="plus" :size="12" :stroke-width="2.2" /> 新建
      </button>
    </div>
    <div v-if="listErr" class="err-text">{{ listErr }}</div>
    <div v-if="metasLoading" class="empty">加载中…</div>
    <div v-else-if="!metas.length" class="empty">
      workspace/templates 下暂无模板
    </div>
    <button
      v-for="m in metas"
      :key="m.key"
      class="item"
      :class="{ active: selected === m.key }"
      @click="openTemplate(m.key)"
    >
      <div class="r1">
        <span class="k mono">{{ m.key }}</span>
        <span
          v-if="m.promptsDirty"
          class="badge skip"
          title="params.prompt_tpl 引用的提示词文件缺失"
          >引用缺失</span
        >
      </div>
      <div class="nm">{{ m.name }}</div>
      <div class="r2">
        <span v-if="m.builtin" class="chip builtin" title="系统内置模板·只读，可另存为副本自定义">内置</span>
        <span class="chip">{{ m.genre }}</span>
        <span class="chip">v{{ m.version }}</span>
        <span class="chip">{{ m.stepCount }} 步</span>
      </div>
      <div class="r3 muted">{{ fmtTime(m.updatedAt) }}</div>
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

.item .nm {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item .r2 {
  display: flex;
  gap: 5px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.item .r3 {
  margin-top: 5px;
  font-size: 11px;
}

.item .chip.builtin {
  color: var(--text-3);
  border: 1px solid var(--border);
}
</style>
