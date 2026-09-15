<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import Modal from '../../components/common/Modal.vue'
import { fmtTime } from '../../lib/format'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{ cv: Pick<CanvasViewState,
  | 'showTrash'
  | 'trashLoading'
  | 'trashItems'
  | 'trashActing'
  | 'restoreTrashed'
  | 'purgeTrashed'
> }>()
const cv = props.cv
</script>

<template>
    <!-- [M18] 回收站（软删画布：恢复 / 彻底删除） -->
    <Modal v-if="cv.showTrash" title="回收站" :width="640" @close="cv.showTrash = false">
      <div class="muted mini">已删除的画布（在途任务已自动取消）。恢复后可继续编辑；彻底删除不可撤销。</div>
      <div v-if="cv.trashLoading" class="muted">加载中…</div>
      <div v-else-if="!cv.trashItems.length" class="muted">回收站是空的。</div>
      <div v-else class="trash-list">
        <div v-for="c in cv.trashItems" :key="c.id" class="trash-item">
          <div class="ti-main">
            <div class="ti-name" :title="c.name">{{ c.name }}</div>
            <div class="muted mini">{{ c.nodeCount }} 节点 · 删除于 {{ fmtTime(c.deletedAt) }}</div>
          </div>
          <span class="sp" />
          <button type="button" class="btn sm" :disabled="cv.trashActing != null" @click="cv.restoreTrashed(c)">
            <Icon name="undo" :size="11" /> 恢复
          </button>
          <button type="button" class="btn sm danger" :disabled="cv.trashActing != null" @click="cv.purgeTrashed(c)">
            <Icon name="trash" :size="11" /> 彻底删除
          </button>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="cv.showTrash = false">关闭</button>
      </template>
    </Modal>

</template>

<style scoped>
.sp {
  flex: 1;
}

.mini {
  font-size: 11px;
}

/* ===== [M18] 回收站 / 文档快照弹窗 ===== */
.trash-list,
.snap-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow-y: auto;
  margin-top: 10px;
}

.trash-item,
.snap-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--code-bg);
  padding: 8px 10px;
}

.ti-main {
  min-width: 0;
}

.ti-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

</style>
