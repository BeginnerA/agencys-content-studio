<script setup lang="ts">
import Modal from '../../components/common/Modal.vue'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{ cv: Pick<CanvasViewState,
  | 'showRefPick'
  | 'refPickLoading'
  | 'refPickEntities'
  | 'refPickBusy'
  | 'attachToEntity'
  | 'ENT_KIND_TEXT'
  | 'refPickErr'
> }>()
const cv = props.cv
</script>

<template>
    <!-- [M18] 加入实体参考（批量：选中节点显示产物 → 实体并集挂接） -->
    <Modal v-if="cv.showRefPick" title="加入实体参考" :width="560" @close="cv.showRefPick = false">
      <div class="muted mini">将选中节点的显示产物挂接为实体参考图（并集去重；无产物的节点自动跳过）。</div>
      <div v-if="cv.refPickLoading" class="muted">加载中…</div>
      <div v-else-if="!cv.refPickEntities.length" class="muted">该项目暂无实体素材，可在「实体馆」页创建。</div>
      <div v-else class="refpick-list">
        <button
          v-for="e in cv.refPickEntities"
          :key="e.id"
          type="button"
          class="pal-item"
          :disabled="cv.refPickBusy"
          :title="`挂接为「${e.name}」参考图`"
          @click="cv.attachToEntity(e)"
        >
          <img v-if="e.refAssets[0]" :src="e.refAssets[0].urls.thumb ?? e.refAssets[0].urls.file" loading="lazy" alt="" />
          <span v-else class="pal-ph">无参考图</span>
          <span class="pal-name">{{ e.name }}</span>
          <span class="pal-ebadge">{{ cv.ENT_KIND_TEXT[e.kind] }} · {{ e.refAssetIds.length }}图</span>
        </button>
      </div>
      <div v-if="cv.refPickErr" class="err-text mini">{{ cv.refPickErr }}</div>
      <template #footer>
        <button type="button" class="btn" @click="cv.showRefPick = false">关闭</button>
      </template>
    </Modal>

</template>

<style scoped>
.pal-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  padding: 3px;
  cursor: grab;
  overflow: hidden;
  font-family: inherit;
}

.pal-item:hover {
  border-color: var(--accent);
}

.pal-item img {
  display: block;
  width: 100%;
  height: 62px;
  object-fit: cover;
  border-radius: 5px;
  pointer-events: none;
}

.pal-name {
  font-size: 10px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

.pal-ebadge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  pointer-events: none;
}

.pal-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 62px;
  border-radius: 5px;
  border: 1px dashed var(--border);
  font-size: 10px;
  color: var(--text-3);
}

.mini {
  font-size: 11px;
}

.refpick-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
  margin-top: 8px;
}

</style>
