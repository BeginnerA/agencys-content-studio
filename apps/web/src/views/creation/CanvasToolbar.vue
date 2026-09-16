<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import { ref, toRef } from 'vue'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{ cv: Pick<CanvasViewState,
  | 'canvasNameInput'
  | 'projSel'
  | 'projects'
  | 'renamingCanvas'
  | 'canvasNameDraft'
  | 'saveCanvasName'
  | 'canvases'
  | 'canvasSel'
  | 'canvasId'
  | 'startRenameCanvas'
  | 'projectId'
  | 'createCanvas'
  | 'duplicateCanvas'
  | 'removeCanvas'
  | 'openTrash'
  | 'openSnaps'
  | 'selectedIds'
  | 'openCopyTo'
  | 'listErr'
  | 'loading'
  | 'canUndo'
  | 'undoTitle'
  | 'onUndo'
  | 'canRedo'
  | 'redoTitle'
  | 'onRedo'
  | 'boardRef'
  | 'runAssetIds'
  | 'openSendRun'
  | 'draftBusy'
  | 'openDraft'
  | 'batchBusy'
  | 'nodes'
  | 'arrangeAll'
  | 'exportBusy'
  | 'onExportZip'
  | 'imageBusy'
  | 'onExportSvg'
  | 'onExportPng'
  | 'hasLiveTasks'
  | 'cancelAllBusy'
  | 'onCancelAllTasks'
  | 'showOverview'
> }>()
const cv = props.cv
const canvasNameInput = toRef(cv, 'canvasNameInput')

/** [M22] 导出菜单（zip / PNG / SVG 三合一；透明背板点击关闭） */
const exportMenu = ref(false)
function pickExport(kind: 'zip' | 'png' | 'svg'): void {
  exportMenu.value = false
  if (kind === 'zip') void cv.onExportZip()
  else if (kind === 'png') void cv.onExportPng()
  else void cv.onExportSvg()
}
</script>

<template>
    <!-- ===== 顶栏 ===== -->
    <div class="crt-bar">
      <select v-model="cv.projSel" class="sel" title="项目">
        <option v-for="p in cv.projects" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
      </select>
      <span class="bar-sep">/</span>
      <input
        v-if="cv.renamingCanvas"
        ref="canvasNameInput"
        v-model="cv.canvasNameDraft"
        class="canvas-name-in"
        @keydown.enter="cv.saveCanvasName"
        @keydown.esc="cv.renamingCanvas = false"
        @blur="cv.saveCanvasName"
      />
      <select v-else-if="cv.canvases.length" v-model="cv.canvasSel" class="sel" title="画布">
        <option v-for="c in cv.canvases" :key="c.id" :value="String(c.id)">
          {{ c.name }}（{{ c.nodeCount }} 节点）
        </option>
      </select>
      <span v-else class="muted">暂无画布</span>
      <button
        v-if="cv.canvasId != null && !cv.renamingCanvas"
        type="button"
        class="btn sm"
        title="重命名当前画布"
        @click="cv.startRenameCanvas"
      >
        <Icon name="pencil" :size="11" />
      </button>
      <button type="button" class="btn sm" title="新建空画布" :disabled="cv.projectId == null" @click="cv.createCanvas">
        <Icon name="plus" :size="11" /> 新建
      </button>
      <button
        type="button"
        class="btn sm"
        title="复制当前画布（节点与连线一并复制）"
        :disabled="cv.canvasId == null"
        @click="cv.duplicateCanvas"
      >
        <Icon name="copy" :size="11" /> 复制
      </button>
      <button
        type="button"
        class="btn sm danger"
        title="删除当前画布（移入回收站）"
        :disabled="cv.canvasId == null"
        @click="cv.removeCanvas"
      >
        <Icon name="trash" :size="11" />
      </button>
      <button
        type="button"
        class="btn sm"
        title="回收站（已删除画布：恢复 / 彻底删除）"
        :disabled="cv.projectId == null"
        @click="cv.openTrash"
      >
        <Icon name="inbox" :size="11" /> 回收站
      </button>
      <button
        type="button"
        class="btn sm"
        title="文档快照（保存 / 恢复画布状态；恢复保留节点 id）"
        :disabled="cv.canvasId == null"
        @click="cv.openSnaps"
      >
        <Icon name="clock" :size="11" /> 快照
      </button>
      <button
        type="button"
        class="btn sm"
        title="把选中节点复制到其他画布（同项目直接引用；跨项目自动拷贝素材与实体）"
        :disabled="cv.canvasId == null || !cv.selectedIds.length"
        @click="cv.openCopyTo"
      >
        <Icon name="copy" :size="11" /> 复制到画布…
      </button>

      <span class="sp" />
      <span v-if="cv.listErr" class="muted" :title="cv.listErr">目录加载失败</span>
      <span v-if="cv.loading" class="muted">加载中…</span>
      <button type="button" class="btn sm" :disabled="!cv.canUndo" :title="cv.undoTitle" @click="cv.onUndo">
        <Icon name="undo" :size="12" />
      </button>
      <button type="button" class="btn sm" :disabled="!cv.canRedo" :title="cv.redoTitle" @click="cv.onRedo">
        <Icon name="redo" :size="12" />
      </button>
      <button type="button" class="btn sm" title="适应视图（0）" :disabled="cv.canvasId == null" @click="cv.boardRef?.fit()">
        <Icon name="zoom-in" :size="12" /> 适应视图
      </button>
      <button
        type="button"
        class="btn sm"
        title="把画布素材节点/产物预填到运行表单（setting_docs）"
        :disabled="!cv.runAssetIds.length"
        @click="cv.openSendRun"
      >
        <Icon name="play" :size="11" /> 送去运行
      </button>
      <button
        type="button"
        class="btn sm"
        title="导出为模板草案（低保真 YAML + 校验自检，不落盘）"
        :disabled="cv.canvasId == null || cv.draftBusy"
        @click="cv.openDraft"
      >
        <Icon name="doc" :size="11" /> {{ cv.draftBusy ? '导出中…' : '模板草案' }}
      </button>
      <button
        type="button"
        class="btn sm"
        title="一键整理布局（按上下游分层排列；可撤销）"
        :disabled="cv.canvasId == null || cv.batchBusy || !cv.nodes.length"
        @click="cv.arrangeAll('layered')"
      >
        <Icon name="arrange" :size="11" /> 整理布局
      </button>
      <button
        type="button"
        class="btn sm"
        title="按故事板序号排列（grid；有 seq 优先，行优先）"
        :disabled="cv.canvasId == null || cv.batchBusy || !cv.nodes.length"
        @click="cv.arrangeAll('grid')"
      >
        <Icon name="flow" :size="11" /> 按序号
      </button>
      <!-- [M22] 导出菜单（zip / PNG / SVG 三合一；原单枚 zip 按钮并入） -->
      <div class="exp-wrap">
        <button
          type="button"
          class="btn sm"
          title="导出：打包 zip / 布局图 PNG / 布局图 SVG"
          :disabled="cv.canvasId == null || cv.exportBusy || cv.imageBusy"
          @click="exportMenu = !exportMenu"
        >
          <Icon name="download" :size="11" />
          {{ cv.exportBusy ? '打包中…' : cv.imageBusy ? '导出中…' : '导出' }}
          <Icon name="chevron-down" :size="9" />
        </button>
        <template v-if="exportMenu">
          <div class="exp-backdrop" @pointerdown="exportMenu = false" />
          <div class="exp-menu panel">
            <button type="button" class="exp-item" @click="pickExport('zip')">打包 zip（产物 + manifest）</button>
            <button type="button" class="exp-item" @click="pickExport('png')">导出 PNG（布局图 · 2x）</button>
            <button type="button" class="exp-item" @click="pickExport('svg')">导出 SVG（布局图）</button>
          </div>
        </template>
      </div>
      <button
        v-if="cv.hasLiveTasks"
        type="button"
        class="btn sm danger"
        title="停止当前画布全部在途任务（等待/处理中 → 已取消）"
        :disabled="cv.cancelAllBusy"
        @click="cv.onCancelAllTasks"
      >
        <Icon name="stop" :size="11" /> {{ cv.cancelAllBusy ? '停止中…' : '停止全部' }}
      </button>
      <button
        type="button"
        class="btn sm"
        :class="{ primary: cv.showOverview }"
        title="全局状态总览（按严重度排序；点击定位）"
        :disabled="cv.canvasId == null"
        @click="cv.showOverview = !cv.showOverview"
      >
        <Icon name="eye" :size="11" /> 总览
      </button>
    </div>

</template>

<style scoped>
.crt-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sel {
  width: auto;
  max-width: 280px;
  padding: 5px 8px;
  font-size: 12px;
}

.bar-sep {
  color: var(--text-3);
}

.canvas-name-in {
  width: 240px;
  padding: 5px 8px;
  font-size: 12.5px;
}

.sp {
  flex: 1;
}

/* [M22] 导出菜单（三合一） */
.exp-wrap {
  position: relative;
}

.exp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}

.exp-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 31;
  display: flex;
  flex-direction: column;
  min-width: 210px;
  padding: 4px;
  box-shadow: 0 10px 30px rgb(0 0 0 / 45%);
}

.exp-item {
  border: none;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-size: 12.5px;
  font-family: inherit;
  padding: 7px 10px;
  border-radius: 7px;
  cursor: pointer;
}

.exp-item:hover {
  background: var(--code-bg);
}
</style>
