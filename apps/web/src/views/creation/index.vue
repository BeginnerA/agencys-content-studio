<script setup lang="ts">
/**
 * 创作画布页（spec §2.4；URL ?project=&canvas= 为单一真源）
 * - 布局：左侧素材面板（拖入 / 单击送至视口中心）+ 中部 CreationBoard + 右侧 CreationInspector（选中时覆盖）
 * - 数据：creationApi.doc 全量读模型；socket join canvas:{id} room，canvas.changed → 350ms 防抖静默重拉
 * - 操作：拖拽落点乐观更新 + PATCH；其余走 creationApi → 重拉（400 文案 toast）
 * - 联动：送去运行（RunFormModal prefillInput setting_docs）/ 导出模板草案（Modal + 复制）/ 画布管理（新建·复制·删除）
 */
import CreationInspector from '../../components/creation/inspector/index.vue'
import Icon from '../../components/common/Icon.vue'
import CanvasToolbar from './CanvasToolbar.vue'
import CanvasPalette from './CanvasPalette.vue'
import CanvasBoardArea from './CanvasBoardArea.vue'
import CanvasOverview from './CanvasOverview.vue'
import CanvasOutputModals from './CanvasOutputModals.vue'
import CanvasEstimateModal from './CanvasEstimateModal.vue'
import CanvasRefModal from './CanvasRefModal.vue'
import CanvasTrashModal from './CanvasTrashModal.vue'
import CanvasSnapshotsModal from './CanvasSnapshotsModal.vue'
import CanvasCopyToModal from './CanvasCopyToModal.vue'
import CanvasAdviceModal from './CanvasAdviceModal.vue'
import { useCanvasView } from './use-canvas-view'
import { ref } from 'vue'

const cv = useCanvasView()
const showPalette = ref(window.innerWidth >= 1100)

/** 检查器 refresh（抽帧等改节点数操作）：静默重拉文档 + 刷画布目录（下拉计数） */
function onInspectorRefresh(): void {
  void cv.loadDoc(true)
  void cv.loadCanvases()
}
</script>

<template>
  <div class="crt-page">
    <CanvasToolbar
      :cv="cv"
      :show-palette="showPalette"
      @toggle-palette="showPalette = !showPalette"
    />
    <div v-if="cv.err" class="errbar">
      <Icon name="alert" :size="13" />
      <span class="eb-t">{{ cv.err }}</span>
      <button type="button" class="btn sm" @click="cv.loadDoc()">重试</button>
    </div>

    <!-- ===== 舞台 ===== -->
    <div class="crt-stage">
      <CanvasPalette
        v-show="showPalette"
        :cv="cv"
        @close="showPalette = false"
      />
      <CanvasBoardArea :cv="cv">
        <!-- 右：检查器（选中时覆盖） -->
        <CreationInspector
          v-if="cv.canvasId != null && (cv.selNode || cv.selEdge)"
          :node="cv.selNode"
          :edge="cv.selEdge"
          :nodes="cv.nodes"
          :edges="cv.edges"
          :canvas-id="cv.canvasId"
          :project-id="cv.activeProjectId"
          :apply-patch="cv.applyNodePatch"
          :apply-run="cv.applyNodeRun"
          :apply-extract="cv.applyNodeExtract"
          :apply-delete="cv.applyDeleteFromInspector"
          :apply-remove-edge="cv.applyRemoveEdge"
          @refresh="onInspectorRefresh"
          @clear="cv.onClearSelection"
          @notice="cv.toast"
        />

        <CanvasOverview :cv="cv" />
      </CanvasBoardArea>
    </div>

    <!-- toast -->
    <Transition name="toast">
      <div v-if="cv.toastMsg" class="crt-toast" role="status">
        {{ cv.toastMsg }}
      </div>
    </Transition>

    <CanvasOutputModals :cv="cv" />
    <CanvasEstimateModal :cv="cv" />
    <CanvasRefModal :cv="cv" />
    <CanvasTrashModal :cv="cv" />
    <CanvasSnapshotsModal :cv="cv" />
    <CanvasCopyToModal :cv="cv" />
    <CanvasAdviceModal :cv="cv" />
  </div>
</template>

<style scoped>
.crt-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: calc(100dvh - 44px);
  min-height: 540px;
  container: creation / inline-size;
}

.errbar {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--bad);
  background: var(--bad-weak);
  border: 1px solid rgb(248 113 113 / 30%);
  border-radius: 9px;
  padding: 7px 12px;
  font-size: 12.5px;
}

.eb-t {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.crt-stage {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--bg);
}

.crt-stage :deep(.ci),
.crt-stage :deep(.ov-drawer) {
  max-width: 100%;
}
@container creation (max-width: 760px) {
  .crt-stage :deep(.crt-palette) {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 8;
    width: min(240px, 100%);
    box-shadow: var(--shadow-lg);
  }
}

.crt-toast {
  position: fixed;
  left: 50%;
  bottom: 30px;
  transform: translateX(-50%);
  background: var(--panel-2, var(--panel));
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 9px 18px;
  font-size: 12.5px;
  color: var(--text);
  box-shadow: 0 10px 30px rgb(0 0 0 / 40%);
  z-index: 40;
  max-width: 72vw;
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.2s,
    transform 0.2s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>
