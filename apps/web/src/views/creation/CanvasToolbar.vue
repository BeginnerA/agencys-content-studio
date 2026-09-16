<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import { computed, ref, toRef } from 'vue'
import ActionMenu, {
  type ActionMenuItem,
} from '../../components/common/ActionMenu.vue'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{
  cv: Pick<
    CanvasViewState,
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
    | 'onCreateNode'
    | 'doc'
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
    | 'showAdvice'
    | 'openAdvice'
  >
  showPalette: boolean
}>()
const emit = defineEmits<{ togglePalette: [] }>()
const cv = props.cv
const canvasNameInput = toRef(cv, 'canvasNameInput')

const adding = ref(false)
const documentItems = computed<ActionMenuItem[]>(() => [
  {
    id: 'new',
    label: '新建画布',
    icon: 'plus',
    disabled: cv.projectId == null,
    action: cv.createCanvas,
  },
  {
    id: 'rename',
    label: '重命名画布',
    icon: 'pencil',
    disabled: !cv.doc,
    action: cv.startRenameCanvas,
  },
  {
    id: 'duplicate',
    label: '复制整张画布',
    icon: 'copy',
    detail: '保留节点与连线',
    disabled: !cv.doc,
    action: cv.duplicateCanvas,
  },
  {
    id: 'snapshots',
    label: '文档快照',
    icon: 'clock',
    detail: '保存或恢复画布状态',
    separator: true,
    disabled: !cv.doc,
    action: cv.openSnaps,
  },
  {
    id: 'trash',
    label: '回收站',
    icon: 'inbox',
    disabled: cv.projectId == null,
    action: cv.openTrash,
  },
  {
    id: 'delete',
    label: '删除当前画布',
    icon: 'trash',
    detail: '移入回收站，可恢复',
    separator: true,
    danger: true,
    disabled: !cv.doc,
    action: cv.removeCanvas,
  },
])
const layoutItems = computed<ActionMenuItem[]>(() => [
  {
    id: 'layered',
    label: '按连接关系分层',
    icon: 'arrange',
    detail: '上下游分层排列，可撤销',
    action: () => cv.arrangeAll('layered'),
  },
  {
    id: 'grid',
    label: '按故事板序号排列',
    icon: 'flow',
    detail: '优先按序号排列为网格',
    action: () => cv.arrangeAll('grid'),
  },
  {
    id: 'force',
    label: '力导向排列',
    icon: 'wand',
    detail: '按连线关系自动调整疏密',
    action: () => cv.arrangeAll('force'),
  },
])
const exportItems = computed<ActionMenuItem[]>(() => [
  {
    id: 'zip',
    label: '打包产物 ZIP',
    icon: 'download',
    detail: '包含产物文件与清单',
    action: cv.onExportZip,
  },
  {
    id: 'png',
    label: '导出布局图 PNG',
    icon: 'photo',
    detail: '2 倍清晰度',
    action: cv.onExportPng,
  },
  {
    id: 'svg',
    label: '导出布局图 SVG',
    icon: 'photo',
    detail: '可缩放的矢量布局图',
    action: cv.onExportSvg,
  },
  {
    id: 'draft',
    label: cv.draftBusy ? '生成草案中…' : '导出模板草案',
    icon: 'doc',
    separator: true,
    detail: '生成 YAML 草案并校验',
    disabled: cv.draftBusy,
    action: cv.openDraft,
  },
])
async function addNode(): Promise<void> {
  if (!cv.boardRef || adding.value || !cv.doc) return
  adding.value = true
  try {
    await cv.onCreateNode(cv.boardRef.centerWorld())
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <header class="canvas-header" @keydown.space.stop>
    <div class="document-bar" aria-label="画布文档">
      <div class="document-location">
        <span class="canvas-mark"><Icon name="flow" :size="19" /></span>
        <label class="location-field project-field">
          <span>项目</span>
          <select
            v-model="cv.projSel"
            aria-label="项目"
            :disabled="!cv.projects.length"
          >
            <option v-if="!cv.projects.length" value="">暂无项目</option>
            <option v-for="p in cv.projects" :key="p.id" :value="String(p.id)">
              {{ p.name }}
            </option>
          </select>
        </label>
        <Icon class="location-separator" name="chevron-right" :size="13" />
        <label class="location-field canvas-field">
          <span>创作画布</span>
          <input
            v-if="cv.renamingCanvas"
            ref="canvasNameInput"
            v-model="cv.canvasNameDraft"
            aria-label="画布名称"
            @keydown.enter.stop.prevent="cv.saveCanvasName"
            @keydown.esc.stop.prevent="cv.renamingCanvas = false"
            @blur="cv.saveCanvasName"
          />
          <select
            v-else
            v-model="cv.canvasSel"
            aria-label="画布"
            :disabled="!cv.canvases.length"
          >
            <option v-if="!cv.canvases.length" value="">暂无画布</option>
            <option v-for="c in cv.canvases" :key="c.id" :value="String(c.id)">
              {{ c.name }}
            </option>
          </select>
        </label>
      </div>
      <div class="document-actions">
        <ActionMenu
          :key="`document-${cv.projectId}-${cv.canvasId}`"
          label="画布管理"
          icon="doc"
          :items="documentItems"
        />
        <ActionMenu
          :key="`export-${cv.canvasId}`"
          :label="cv.exportBusy ? '打包中…' : cv.imageBusy ? '导出中…' : '导出'"
          icon="download"
          align="end"
          :items="exportItems"
          :disabled="!cv.doc || cv.exportBusy || cv.imageBusy"
        />
        <button
          type="button"
          class="btn send-run"
          :disabled="!cv.doc || !cv.runAssetIds.length"
          title="将画布素材预填到运行表单，确认后再运行"
          @click="cv.openSendRun"
        >
          <Icon name="play" :size="14" /> 送去运行
        </button>
      </div>
    </div>
    <div class="editing-bar" aria-label="画布编辑工具">
      <div class="editing-tools">
        <button
          type="button"
          class="btn primary"
          :disabled="!cv.doc || cv.loading || adding"
          @click="addNode"
        >
          <Icon name="plus" :size="16" /> {{ adding ? '添加中…' : '添加节点' }}
        </button>
        <div class="history-tools" role="group" aria-label="编辑历史">
          <button
            type="button"
            class="btn icon-tool"
            :disabled="!cv.canUndo"
            :title="cv.undoTitle"
            aria-label="撤销"
            @click="cv.onUndo"
          >
            <Icon name="undo" :size="16" />
          </button>
          <button
            type="button"
            class="btn icon-tool"
            :disabled="!cv.canRedo"
            :title="cv.redoTitle"
            aria-label="重做"
            @click="cv.onRedo"
          >
            <Icon name="redo" :size="16" />
          </button>
        </div>
        <ActionMenu
          :key="`layout-${cv.canvasId}`"
          label="整理布局"
          icon="arrange"
          :items="layoutItems"
          :disabled="!cv.doc || cv.batchBusy || !cv.nodes.length"
        />
        <span
          class="document-state"
          :class="{ error: cv.listErr }"
          role="status"
          :title="cv.listErr || undefined"
        >
          {{
            cv.listErr
              ? '目录加载失败'
              : cv.loading
                ? '加载中…'
                : cv.doc
                  ? `${cv.nodes.length} 个节点`
                  : '选择或新建画布'
          }}
        </span>
      </div>
      <div class="view-tools" role="group" aria-label="面板与辅助工具">
        <button
          v-if="cv.hasLiveTasks"
          type="button"
          class="btn danger"
          :disabled="cv.cancelAllBusy"
          @click="cv.onCancelAllTasks"
        >
          <Icon name="stop" :size="14" />
          {{ cv.cancelAllBusy ? '停止中…' : '停止全部' }}
        </button>
        <button
          type="button"
          class="btn quiet"
          :class="{ active: showPalette }"
          :aria-pressed="showPalette"
          :disabled="!cv.doc"
          title="展开或收起项目素材"
          @click="emit('togglePalette')"
        >
          <Icon name="photo" :size="15" /> 素材
        </button>
        <button
          type="button"
          class="btn quiet"
          :class="{ active: cv.showOverview }"
          :aria-pressed="cv.showOverview"
          :disabled="!cv.doc"
          title="查看节点状态并定位"
          @click="cv.showOverview = !cv.showOverview"
        >
          <Icon name="eye" :size="15" /> 总览
        </button>
        <button
          type="button"
          class="btn quiet"
          :disabled="!cv.doc"
          title="查看 AI 编排建议，不自动执行"
          @click="cv.openAdvice"
        >
          <Icon name="sparkles" :size="15" /> AI 建议
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.canvas-header {
  flex: none;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
}
.document-bar,
.editing-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 14px;
}
.document-bar {
  border-bottom: 1px solid var(--border);
}
.document-location,
.document-actions,
.editing-tools,
.view-tools,
.history-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.document-location {
  flex: 1;
}
.document-actions,
.view-tools {
  flex: none;
}
.canvas-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 10px;
  background: var(--accent-weak);
  color: var(--run);
}
.location-field {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.location-field > span {
  font-size: 11px;
  color: var(--text-2);
  padding-left: 6px;
}
.project-field {
  flex: 0 1 174px;
}
.canvas-field {
  flex: 0 1 240px;
}
.location-field select,
.location-field input {
  font-size: 13px;
  min-height: 30px;
  padding: 3px 6px;
  background: transparent;
  border-color: transparent;
}
.canvas-field select {
  font-weight: 600;
}
.location-field select:hover,
.location-field input {
  border-color: var(--border-strong);
  background: var(--code-bg);
}
.location-separator {
  color: var(--text-2);
}
.canvas-header .btn {
  min-height: 36px;
  padding: 7px 10px;
  white-space: nowrap;
  font-family: inherit;
}
.history-tools {
  gap: 2px;
  padding: 0 8px;
  border-right: 1px solid var(--border);
}
.canvas-header .icon-tool {
  width: 36px;
  justify-content: center;
  padding: 0;
  border-color: transparent;
  background: transparent;
}
.canvas-header .quiet {
  border-color: transparent;
  background: transparent;
  color: var(--text-2);
}
.canvas-header .quiet:hover {
  background: var(--hover);
  color: var(--text);
}
.canvas-header .quiet.active {
  background: var(--accent-weak);
  color: var(--text);
  border-color: var(--border-strong);
}
.send-run {
  border-color: var(--accent);
}
.document-state {
  color: var(--text-2);
  font-size: 12px;
  white-space: nowrap;
  padding-left: 4px;
}
.document-state.error {
  color: var(--bad);
}
@container creation (max-width: 1050px) {
  .canvas-mark {
    display: none;
  }
  .document-bar,
  .editing-bar {
    gap: 8px;
    padding: 10px;
  }
  .document-state {
    display: none;
  }
}
@container creation (max-width: 760px) {
  .document-bar {
    flex-wrap: wrap;
  }
  .document-location {
    flex-basis: 100%;
  }
  .project-field,
  .canvas-field {
    flex: 1;
  }
  .document-actions {
    margin-left: auto;
    flex-wrap: wrap;
  }
  .editing-bar {
    flex-wrap: wrap;
  }
  .view-tools {
    margin-left: auto;
    flex-wrap: wrap;
  }
}
@container creation (max-width: 520px) {
  .document-location {
    flex-wrap: wrap;
  }
  .location-separator {
    display: none;
  }
  .project-field,
  .canvas-field {
    flex: 1 1 100%;
  }
}
@container creation (max-width: 420px) {
  .document-bar,
  .editing-bar {
    flex-wrap: wrap;
  }
  .document-actions,
  .view-tools {
    flex: 1 1 100%;
    margin-left: 0;
    flex-wrap: wrap;
  }
  .editing-tools {
    flex-wrap: wrap;
  }
}
@media (pointer: coarse) {
  .canvas-header .btn {
    min-height: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .canvas-header .btn {
    transition: none;
  }
}
</style>
