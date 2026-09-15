<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import Modal from '../../components/common/Modal.vue'
import { fmtTime } from '../../lib/format'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{ cv: Pick<CanvasViewState,
  | 'showSnaps'
  | 'snapLabel'
  | 'createSnap'
  | 'snapsBusy'
  | 'snapsLoading'
  | 'snapItems'
  | 'snapActing'
  | 'restoreSnap'
  | 'deleteSnap'
> }>()
const cv = props.cv
</script>

<template>
    <!-- [M18] 文档快照（保留 id 重放；恢复前自动备份） -->
    <Modal v-if="cv.showSnaps" title="文档快照" :width="640" @close="cv.showSnaps = false">
      <div class="snap-bar">
        <input v-model="cv.snapLabel" class="snap-label-in" placeholder="快照名称（可选，缺省「快照 N」）" @keydown.enter="cv.createSnap" />
        <button type="button" class="btn sm" :disabled="cv.snapsBusy" @click="cv.createSnap">
          <Icon name="plus" :size="11" /> {{ cv.snapsBusy ? '创建中…' : '创建快照' }}
        </button>
      </div>
      <div class="muted mini">恢复会先自动备份当前状态为新快照；节点 id 原样保留（生成任务历史不断链）。上限 20 个。</div>
      <div v-if="cv.snapsLoading" class="muted">加载中…</div>
      <div v-else-if="!cv.snapItems.length" class="muted">暂无快照。</div>
      <div v-else class="snap-list">
        <div v-for="s in cv.snapItems" :key="s.id" class="snap-item">
          <div class="ti-main">
            <div class="ti-name" :title="s.label">{{ s.label }}</div>
            <div class="muted mini">{{ s.nodeCount }} 节点 · {{ s.edgeCount }} 边 · {{ fmtTime(s.createdAt) }}</div>
          </div>
          <span class="sp" />
          <button type="button" class="btn sm" :disabled="cv.snapActing != null" @click="cv.restoreSnap(s)">
            <Icon name="undo" :size="11" /> 恢复
          </button>
          <button type="button" class="btn sm danger" :disabled="cv.snapActing != null" @click="cv.deleteSnap(s)">
            <Icon name="trash" :size="11" /> 删除
          </button>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="cv.showSnaps = false">关闭</button>
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

.snap-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.snap-label-in {
  flex: 1;
  padding: 5px 8px;
  font-size: 12.5px;
}
</style>
