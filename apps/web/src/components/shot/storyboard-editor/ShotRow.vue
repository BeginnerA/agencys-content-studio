<script setup lang="ts">
import Icon from '../../common/Icon.vue'
import type { EditorApi, DraftShot } from './use-storyboard-editor'
const props = defineProps<{
  s: EditorApi
  d: DraftShot
  i: number
  canOperate: boolean
}>()
const {
  activeUid,
  selectDraft,
  promptPreview,
  dragUid,
  dropUid,
  onDragStart,
  onItemDragOver,
  onItemDragLeave,
  clearDrag,
  onDrop,
  toggleDeleted,
} = props.s
</script>

<template>
  <div
    class="se-item"
    :class="{
      active: d.uid === activeUid,
      dead: d.deleted,
      dragging: dragUid === d.uid,
      'drop-before': dropUid?.uid === d.uid && dropUid.side === 'before',
      'drop-after': dropUid?.uid === d.uid && dropUid.side === 'after',
    }"
    @click="selectDraft(d)"
    @dragover="onItemDragOver(d, $event)"
    @dragleave="onItemDragLeave(d, $event)"
    @drop.prevent="onDrop(d, $event)"
  >
    <span
      class="se-grip"
      :class="{ disabled: !canOperate }"
      :draggable="canOperate"
      title="拖拽调整顺序"
      @dragstart="onDragStart(d, $event)"
      @dragend="clearDrag"
    />
    <span class="se-seq mono">{{ i + 1 }}</span>
    <div class="se-item-main">
      <div class="se-item-top">
        <span class="se-item-id mono">{{ d.id || '（未命名）' }}</span>
        <span v-if="d.isNew" class="se-badge new">新增</span>
        <span v-if="d.deleted" class="se-badge dead">待删除</span>
      </div>
      <div class="se-item-sub">{{ promptPreview(d) }}</div>
    </div>
    <button
      class="se-item-del"
      :class="{ undo: d.deleted }"
      :disabled="!canOperate"
      :title="d.deleted ? '撤销删除' : '标记删除（保存后移除）'"
      @click.stop="toggleDeleted(d)"
    >
      <Icon :name="d.deleted ? 'arrow-path' : 'trash'" :size="12" />
    </button>
  </div>
</template>

<style scoped>
.se-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 7px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  cursor: pointer;
  transition:
    border-color 0.15s,
    opacity 0.2s;
}

.se-item:hover {
  border-color: var(--border-strong);
}

.se-item.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgb(99 102 241 / 18%);
}

.se-item.dead {
  opacity: 0.55;
  border-style: dashed;
}

.se-item.dead .se-item-id {
  text-decoration: line-through;
}

.se-item.dragging {
  opacity: 0.4;
}

.se-item.drop-before {
  box-shadow: 0 -3px 0 var(--accent);
}

.se-item.drop-after {
  box-shadow: 0 3px 0 var(--accent);
}

.se-grip {
  flex: none;
  width: 13px;
  height: 18px;
  cursor: grab;
  background-image: radial-gradient(
    circle,
    var(--text-3) 1px,
    transparent 1.1px
  );
  background-size: 5px 5px;
  background-position: 1px 1px;
  opacity: 0.75;
}

.se-grip:hover {
  opacity: 1;
}

.se-grip:active {
  cursor: grabbing;
}

.se-grip.disabled {
  cursor: not-allowed;
  opacity: 0.3;
}

.se-seq {
  flex: none;
  font-size: 10.5px;
  color: var(--text-3);
  min-width: 14px;
  text-align: right;
}

.se-item-main {
  flex: 1;
  min-width: 0;
}

.se-item-top {
  display: flex;
  align-items: center;
  gap: 5px;
}

.se-item-id {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.se-badge {
  flex: none;
  font-size: 10px;
  line-height: 15px;
  border-radius: 999px;
  padding: 0 6px;
}

.se-badge.new {
  color: var(--ok);
  background: var(--ok-weak);
}

.se-badge.dead {
  color: var(--bad);
  background: var(--bad-weak);
}

.se-item-sub {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.se-item-del {
  flex: none;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  border-radius: 6px;
}

.se-item-del:hover:not(:disabled) {
  color: var(--bad);
}

.se-item-del.undo {
  color: var(--accent-h);
}

.se-item-del:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
