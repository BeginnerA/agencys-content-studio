<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import Modal from '../../components/common/Modal.vue'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{
  cv: Pick<
    CanvasViewState,
    | 'showCopyTo'
    | 'copyToIds'
    | 'copyToBusy'
    | 'copyToErr'
    | 'copyToProjects'
    | 'copyToPid'
    | 'copyToTargets'
    | 'copyToTarget'
    | 'copyTargetsBusy'
    | 'loadCopyTargets'
    | 'doCopyTo'
    | 'projectId'
  >
}>()
const cv = props.cv
</script>

<template>
  <!-- 跨画布复制：项目选择 + 目标画布列表（同项目直接引用 / 跨项目资产级联拷贝） -->
  <Modal
    v-if="cv.showCopyTo"
    title="复制到画布"
    :width="520"
    @close="cv.showCopyTo = false"
  >
    <div class="ct-row">
      <label class="ct-lab">目标项目</label>
      <select
        v-model.number="cv.copyToPid"
        class="ct-sel"
        :disabled="cv.copyToBusy"
        @change="cv.loadCopyTargets()"
      >
        <option v-for="p in cv.copyToProjects" :key="p.id" :value="p.id">
          {{ p.name }}{{ p.id === cv.projectId ? '（当前项目）' : '' }}
        </option>
      </select>
    </div>
    <div class="ct-row">
      <label class="ct-lab">目标画布</label>
      <select
        v-model.number="cv.copyToTarget"
        class="ct-sel"
        :disabled="cv.copyToBusy || cv.copyTargetsBusy"
      >
        <option :value="null" disabled>
          {{ cv.copyTargetsBusy ? '加载中…' : '选择目标画布' }}
        </option>
        <option v-for="c in cv.copyToTargets" :key="c.id" :value="c.id">
          {{ c.name }}（{{ c.nodeCount }} 节点）
        </option>
      </select>
    </div>
    <div class="muted mini">
      将复制
      {{ cv.copyToIds.length }}
      个选中节点（内部连线一并重建）。跨项目时素材、实体引用自动级联拷贝；
      运行节点等不可迁移项会被跳过。
    </div>
    <div v-if="cv.copyToErr" class="err-text">{{ cv.copyToErr }}</div>
    <template #footer>
      <button
        type="button"
        class="btn"
        :disabled="cv.copyToBusy"
        @click="cv.showCopyTo = false"
      >
        取消
      </button>
      <button
        type="button"
        class="btn primary"
        :disabled="cv.copyToBusy || cv.copyToTarget == null"
        @click="cv.doCopyTo"
      >
        <Icon name="copy" :size="12" /> {{ cv.copyToBusy ? '复制中…' : '复制' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.mini {
  font-size: 11px;
}

.ct-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.ct-lab {
  flex: none;
  width: 62px;
  font-size: 12.5px;
  color: var(--text-2);
}

.ct-sel {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  font-size: 12.5px;
}
</style>
