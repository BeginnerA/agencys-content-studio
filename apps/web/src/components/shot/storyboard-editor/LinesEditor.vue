<script setup lang="ts">
import Icon from '../../common/Icon.vue'
import type { EditorApi, DraftShot } from './use-storyboard-editor'
const props = defineProps<{
  s: EditorApi
  active: DraftShot
  canOperate: boolean
}>()
const { lineSuggest, lineList, addLine, removeLine, lineLabelOf } = props.s
</script>

<template>
  <div class="se-tags">
    <span
      v-for="id in lineList(active)"
      :key="id"
      class="se-tag mono"
      :title="lineLabelOf(id)"
    >
      {{ id }}
      <button
        type="button"
        aria-label="移除台词"
        :disabled="!canOperate"
        @click="removeLine(active, id)"
      >
        <Icon name="x" :size="10" />
      </button>
    </span>
    <input
      type="text"
      class="se-tag-input"
      list="se-line-ids"
      placeholder="输入台词 id 回车"
      :disabled="!canOperate"
      @keydown.enter.prevent="addLine(active, $event)"
    />
    <datalist id="se-line-ids">
      <option v-for="s in lineSuggest" :key="s.id" :value="s.id">
        {{ s.label }}
      </option>
    </datalist>
  </div>
  <div v-if="lineSuggest.length" class="muted se-lines-tip">
    台词表共
    {{ lineSuggest.length }}
    句；每句恰好归属一镜，无台词镜留空（重新合成时按此对齐配音与字幕）
  </div>
</template>

<style scoped>
.se-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  border: 1px solid var(--border-strong);
  background: var(--code-bg);
  border-radius: 8px;
  padding: 5px 8px;
  min-height: 34px;
}

.se-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text);
  background: rgb(99 102 241 / 16%);
  border: 1px solid rgb(99 102 241 / 28%);
  border-radius: 999px;
  padding: 1px 8px;
}

.se-tag button {
  border: none;
  background: none;
  color: var(--text-2);
  cursor: pointer;
  padding: 0;
  display: inline-flex;
}

.se-tag button:hover:not(:disabled) {
  color: var(--bad);
}

.se-tag-input {
  flex: 1;
  min-width: 120px;
  background: none !important;
  border: none !important;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  padding: 2px 0 !important;
}

/* 台词建议提示 */
.se-lines-tip {
  margin-top: 4px;
  font-size: 11.5px;
}
</style>
