<script setup lang="ts">
import CreationBoard from '../../components/creation/board/index.vue'
import Icon from '../../components/common/Icon.vue'
import { computed, toRef } from 'vue'
import ActionMenu, {
  type ActionMenuItem,
} from '../../components/common/ActionMenu.vue'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{
  cv: Pick<
    CanvasViewState,
    | 'boardRef'
    | 'canvasId'
    | 'doc'
    | 'nodes'
    | 'edges'
    | 'groups'
    | 'selectedIds'
    | 'selectedEdgeId'
    | 'onSelect'
    | 'onSelectEdge'
    | 'onMoved'
    | 'onNudge'
    | 'onConnect'
    | 'onCreateNode'
    | 'onDropFiles'
    | 'onDropAsset'
    | 'onDropEntity'
    | 'onViewportSettled'
    | 'onDeleteSelected'
    | 'onCopySelected'
    | 'openCopyTo'
    | 'onClearSelection'
    | 'onGroupCreate'
    | 'onGroupPatch'
    | 'onGroupDelete'
    | 'onGroupsMoved'
    | 'onUndo'
    | 'onRedo'
    | 'batchBusy'
    | 'batchArrange'
    | 'batchChain'
    | 'batchNumber'
    | 'estimateBusy'
    | 'openEstimate'
    | 'openRefPick'
    | 'batchRun'
    | 'canvases'
    | 'goCanvas'
    | 'projectId'
    | 'createCanvas'
  >
}>()
const cv = props.cv
const boardRef = toRef(cv, 'boardRef')
const alignItems = computed<ActionMenuItem[]>(() => [
  { id: 'left', label: '左对齐', action: () => cv.batchArrange('align-left') },
  {
    id: 'right',
    label: '右对齐',
    action: () => cv.batchArrange('align-right'),
  },
  { id: 'top', label: '顶对齐', action: () => cv.batchArrange('align-top') },
  {
    id: 'bottom',
    label: '底对齐',
    action: () => cv.batchArrange('align-bottom'),
  },
  {
    id: 'horizontal',
    label: '水平等间距分布',
    separator: true,
    action: () => cv.batchArrange('distribute-h'),
  },
  {
    id: 'vertical',
    label: '垂直等间距分布',
    action: () => cv.batchArrange('distribute-v'),
  },
  {
    id: 'layered',
    label: '分层整理选中节点',
    icon: 'arrange',
    separator: true,
    action: () => cv.batchArrange('layered'),
  },
])
const organizeItems = computed<ActionMenuItem[]>(() => [
  {
    id: 'group',
    label: '编为一组',
    icon: 'folder',
    shortcut: 'Ctrl+G',
    action: cv.onGroupCreate,
  },
  {
    id: 'chain',
    label: '自动串联',
    icon: 'link',
    detail: '按选中顺序连接相邻节点',
    action: cv.batchChain,
  },
  {
    id: 'number',
    label: '故事板编号',
    icon: 'flow',
    detail: '从左到右编号 1–N',
    action: cv.batchNumber,
  },
])
const editItems = computed<ActionMenuItem[]>(() => [
  {
    id: 'copy',
    label: '复制选中节点',
    icon: 'copy',
    shortcut: 'Ctrl+D',
    action: cv.onCopySelected,
  },
  {
    id: 'copy-to',
    label: '复制到其他画布…',
    icon: 'external',
    action: cv.openCopyTo,
  },
  {
    id: 'reference',
    label: '设为实体参考',
    icon: 'users',
    separator: true,
    action: cv.openRefPick,
  },
  {
    id: 'delete',
    label: '删除选中节点',
    icon: 'trash',
    shortcut: 'Del',
    separator: true,
    danger: true,
    action: () => cv.onDeleteSelected(),
  },
])
</script>

<template>
  <!-- 中：画布 -->
  <div class="crt-board">
    <div
      v-if="cv.canvasId != null && cv.doc && cv.selectedIds.length"
      class="selection-bar"
      aria-label="选中节点操作"
      @keydown.space.stop
    >
      <div class="selection-count">
        <span
          >已选 <strong>{{ cv.selectedIds.length }}</strong> 个节点</span
        >
        <button
          type="button"
          class="btn clear-selection"
          title="取消选择（Esc）"
          aria-label="取消选择"
          @click="cv.onClearSelection"
        >
          <Icon name="x" :size="14" />
        </button>
      </div>
      <div
        class="selection-tools"
        :key="`${cv.canvasId}-${cv.selectedIds.join(',')}`"
      >
        <ActionMenu
          v-if="cv.selectedIds.length >= 2"
          label="对齐分布"
          icon="arrange"
          :items="alignItems"
          :disabled="cv.batchBusy"
        />
        <ActionMenu
          v-if="cv.selectedIds.length >= 2"
          label="编排"
          icon="flow"
          :items="organizeItems"
          :disabled="cv.batchBusy"
        />
        <ActionMenu
          label="编辑选中"
          icon="pencil"
          :items="editItems"
          :disabled="cv.batchBusy"
        />
        <button
          type="button"
          class="btn"
          :disabled="cv.batchBusy || cv.estimateBusy"
          @click="cv.openEstimate"
        >
          <Icon name="chart" :size="14" />
          {{ cv.estimateBusy ? '预估中…' : '预估成本' }}
        </button>
        <button
          v-if="cv.selectedIds.length >= 2"
          type="button"
          class="btn primary"
          :disabled="cv.batchBusy"
          title="仅将选中且就绪的节点加入执行队列"
          @click="cv.batchRun"
        >
          <Icon name="play" :size="14" /> 执行选中
        </button>
      </div>
    </div>
    <div class="board-surface">
      <CreationBoard
        v-if="cv.canvasId != null && cv.doc"
        :key="cv.canvasId"
        ref="boardRef"
        :nodes="cv.nodes"
        :edges="cv.edges"
        :groups="cv.groups"
        :selected-ids="cv.selectedIds"
        :selected-edge-id="cv.selectedEdgeId"
        :initial-viewport="cv.doc.canvas.viewport"
        @select="cv.onSelect"
        @select-edge="cv.onSelectEdge"
        @moved="cv.onMoved"
        @nudge="cv.onNudge"
        @connect="cv.onConnect"
        @create-node="cv.onCreateNode"
        @drop-files="cv.onDropFiles"
        @drop-asset="cv.onDropAsset"
        @drop-entity="cv.onDropEntity"
        @viewport-settled="cv.onViewportSettled"
        @delete-selected="cv.onDeleteSelected"
        @copy-selected="cv.onCopySelected"
        @group-create="cv.onGroupCreate"
        @group-patch="cv.onGroupPatch"
        @group-delete="cv.onGroupDelete"
        @groups-moved="cv.onGroupsMoved"
        @undo="cv.onUndo"
        @redo="cv.onRedo"
      />

      <!-- 空态引导 -->
      <div v-else class="crt-guide">
        <div class="gd-card panel">
          <Icon name="wand" :size="30" />
          <div class="gd-t">创作画布</div>
          <p class="muted gd-desc">
            自由摆放素材与生成节点、拖拽端口连线组织引用关系；双击空白新建生成节点，就地生成
            / 编辑，
            产物可一键送去运行或导出为模板草案。左键拖拽框选（平移用空格 /
            中键），Del 删除 / Ctrl+Z 撤销。
          </p>
          <div class="gd-sec">
            <div class="gd-h">选择画布</div>
            <div v-if="cv.canvases.length" class="chips">
              <button
                v-for="c in cv.canvases"
                :key="c.id"
                type="button"
                class="chip chipbtn canvas-chip"
                @click="cv.goCanvas(c.id)"
              >
                <span class="cc-cover">
                  <img
                    v-if="c.cover"
                    :src="c.cover.urls.thumb ?? c.cover.urls.file"
                    :alt="c.name"
                    loading="lazy"
                  />
                  <Icon v-else name="photo" :size="16" />
                </span>
                <span class="cc-meta">
                  <span class="cc-name">{{ c.name }}</span>
                  <span class="cc-count">{{ c.nodeCount }} 节点</span>
                </span>
              </button>
            </div>
            <div v-else class="muted">该项目暂无画布</div>
          </div>
          <button
            type="button"
            class="btn primary"
            :disabled="cv.projectId == null"
            @click="cv.createCanvas"
          >
            <Icon name="plus" :size="13" /> 新建画布
          </button>
        </div>
      </div>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.crt-board {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  container-type: inline-size;
  container-name: board-area;
}
.board-surface {
  flex: 1;
  min-height: 0;
  position: relative;
}
.selection-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  flex: none;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-strong);
  background: var(--panel);
}
.selection-count {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  color: var(--text-2);
  font-size: 12px;
}
.selection-count strong {
  color: var(--run);
  font: 600 14px var(--mono);
}
.selection-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.selection-bar .btn {
  min-height: 36px;
  padding: 7px 10px;
  font-family: inherit;
  white-space: nowrap;
}
.selection-bar .clear-selection {
  width: 28px;
  min-height: 28px;
  padding: 0;
  justify-content: center;
  border-color: transparent;
  background: transparent;
}
@container board-area (max-width: 660px) {
  .selection-bar {
    gap: 6px;
  }
  .selection-count {
    width: 100%;
    justify-content: space-between;
  }
}
@media (pointer: coarse) {
  .selection-bar .btn {
    min-height: 44px;
  }
}

.crt-guide {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 20px;
}

.gd-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 520px;
  padding: 26px 28px;
  text-align: center;
}

.gd-t {
  font-weight: 700;
  font-size: 16px;
}

.gd-desc {
  font-size: 12.5px;
  line-height: 1.8;
  margin: 0;
}

.gd-sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.gd-h {
  font-size: 12px;
  color: var(--text-2);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
}

.chipbtn {
  cursor: pointer;
  font-family: inherit;
}

.chipbtn:hover {
  border-color: var(--accent);
  color: #fff;
}

/* [M18] 画布选择卡片：封面缩略（⑤） */
.canvas-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 6px;
  text-align: left;
}

.canvas-chip .cc-cover {
  flex: none;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  color: var(--text-3);
}

.canvas-chip .cc-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.canvas-chip .cc-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.canvas-chip .cc-name {
  max-width: 140px;
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.canvas-chip .cc-count {
  font-size: 11px;
  color: var(--text-3);
}

.crt-guide {
  overflow-y: auto;
}
</style>
