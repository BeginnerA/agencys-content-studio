<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import RefGenPanel from './RefGenPanel.vue'
import EntityCard from './EntityCard.vue'
import EntityFormModal from './EntityFormModal.vue'
import RefGenModal from './RefGenModal.vue'
import { useEntitiesPage } from './use-entities'

const s = useEntitiesPage()
const {
  KINDS,
  kind,
  cfg,
  items,
  projects,
  loading,
  err,
  projectFilter,
  selected,
  polishing,
  notice,
  switchKind,
  onFilterChange,
  openNew,
  polishSelected,
  REFGEN_MAX_ITEMS,
  openRefGen,
} = s
</script>

<template>
  <div>
    <div class="page-h">
      <h1>素材</h1>
      <div class="tabs" role="tablist" aria-label="素材类型">
        <button
          v-for="k in KINDS"
          :key="k.kind"
          class="tab"
          :class="{ on: kind === k.kind }"
          role="tab"
          :aria-selected="kind === k.kind"
          @click="switchKind(k.kind)"
        >
          <Icon :name="k.icon" :size="14" /> {{ k.label }}
        </button>
      </div>
      <span class="sub">{{ items.length }} 项</span>
      <select
        v-model="projectFilter"
        style="width: 180px"
        aria-label="按归属筛选"
        @change="onFilterChange"
      >
        <option value="">全部归属</option>
        <option value="global">仅全局</option>
        <option v-for="p in projects" :key="p.id" :value="String(p.id)">
          项目#{{ p.id }} {{ p.name }}
        </option>
      </select>
      <button
        class="btn"
        style="margin-left: auto"
        :disabled="polishing || !selected.size"
        :title="
          selected.size
            ? `已选素材批量出参考图（≤${REFGEN_MAX_ITEMS} 项，完成后自动挂接）`
            : '先勾选素材卡片'
        "
        @click="openRefGen"
      >
        <Icon name="imageplus" :size="14" /> 生成参考图（{{ selected.size }}）
      </button>
      <button
        class="btn"
        :disabled="polishing || !selected.size"
        :title="
          selected.size
            ? `对已选 ${selected.size} 项润色 appearance（≤10 项/次）`
            : '先勾选素材卡片'
        "
        @click="polishSelected"
      >
        <Icon name="sparkles" :size="14" />
        {{ polishing ? '润色中…' : `批量润色（${selected.size}）` }}
      </button>
      <button class="btn primary" @click="openNew">
        <Icon name="plus" :size="14" :stroke-width="2.2" /> 新建{{ cfg.label }}
      </button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="notice" class="notice-box">{{ notice }}</div>

    <RefGenPanel :s="s" />
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!items.length" class="empty">{{ cfg.empty }}</div>

    <div v-else class="grid">
      <EntityCard v-for="c in items" :key="c.id" :s="s" :c="c" />
    </div>

    <EntityFormModal :s="s" />

    <RefGenModal :s="s" />
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}
/* 批量润色结果 notice */
.notice-box {
  margin-bottom: 12px;
  padding: 9px 12px;
  border: 1px solid rgb(34 197 94 / 35%);
  border-radius: 9px;
  background: var(--ok-weak);
  color: var(--ok);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-line;
}
</style>
