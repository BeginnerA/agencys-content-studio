<script setup lang="ts">
import CreationBoard from '../../components/creation/board/index.vue'
import Icon from '../../components/common/Icon.vue'
import { toRef } from 'vue'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{ cv: Pick<CanvasViewState,
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
  | 'onGroupCreate'
  | 'onGroupPatch'
  | 'onGroupDelete'
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
> }>()
const cv = props.cv
const boardRef = toRef(cv, 'boardRef')
</script>

<template>
      <!-- 中：画布 -->
      <div class="crt-board">
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
          @undo="cv.onUndo"
          @redo="cv.onRedo"
        />

        <!-- [M17] 多选批量浮动条 -->
        <div v-if="cv.canvasId != null && cv.doc && cv.selectedIds.length >= 2" class="batch-bar panel">
          <span class="bb-n">已选 {{ cv.selectedIds.length }}</span>
          <span class="bb-sep" />
          <button type="button" class="btn sm" :disabled="cv.batchBusy" title="左对齐" @click="cv.batchArrange('align-left')">左对齐</button>
          <button type="button" class="btn sm" :disabled="cv.batchBusy" title="右对齐" @click="cv.batchArrange('align-right')">右对齐</button>
          <button type="button" class="btn sm" :disabled="cv.batchBusy" title="顶对齐" @click="cv.batchArrange('align-top')">顶对齐</button>
          <button type="button" class="btn sm" :disabled="cv.batchBusy" title="底对齐" @click="cv.batchArrange('align-bottom')">底对齐</button>
          <span class="bb-sep" />
          <button type="button" class="btn sm" :disabled="cv.batchBusy" title="水平等间距分布" @click="cv.batchArrange('distribute-h')">水平分布</button>
          <button type="button" class="btn sm" :disabled="cv.batchBusy" title="垂直等间距分布" @click="cv.batchArrange('distribute-v')">垂直分布</button>
          <button type="button" class="btn sm" :disabled="cv.batchBusy" title="对选中集分层整理" @click="cv.batchArrange('layered')">整理</button>
          <span class="bb-sep" />
          <button type="button" class="btn sm" :disabled="cv.batchBusy" title="按选中顺序对相邻对自动建边（规则式）" @click="cv.batchChain">串联</button>
          <button type="button" class="btn sm" :disabled="cv.batchBusy" title="按 x 序编 seq 1..N（故事板序号）" @click="cv.batchNumber">编号</button>
          <button type="button" class="btn sm" :disabled="cv.batchBusy" title="复制选中（偏移 +40,+40）" @click="cv.onCopySelected">复制</button>
          <button type="button" class="btn sm" title="把选中节点编为一组（Ctrl+G）" @click="cv.onGroupCreate">成组</button>
          <span class="bb-sep" />
          <button
            type="button"
            class="btn sm"
            :disabled="cv.batchBusy || cv.estimateBusy"
            title="预估所选节点执行成本（零副作用；含未定价提示）"
            @click="cv.openEstimate"
          >
            <Icon name="chart" :size="11" /> {{ cv.estimateBusy ? '预估中…' : '预估成本' }}
          </button>
          <button
            type="button"
            class="btn sm"
            :disabled="cv.batchBusy"
            title="把选中节点的显示产物挂接为实体参考图（并集去重）"
            @click="cv.openRefPick"
          >
            <Icon name="users" :size="11" /> 实体参考
          </button>
          <span class="bb-sep" />
          <button type="button" class="btn sm primary" :disabled="cv.batchBusy" title="批量执行（只入队就绪节点）" @click="cv.batchRun">
            <Icon name="play" :size="11" /> 执行
          </button>
          <button type="button" class="btn sm danger" :disabled="cv.batchBusy" title="删除选中节点" @click="cv.onDeleteSelected()">
            <Icon name="trash" :size="11" /> 删除
          </button>
        </div>

        <!-- 空态引导 -->
        <div v-else class="crt-guide">
          <div class="gd-card panel">
            <Icon name="wand" :size="30" />
            <div class="gd-t">创作画布</div>
            <p class="muted gd-desc">
              自由摆放素材与生成节点、拖拽端口连线组织引用关系；双击空白新建生成节点，就地生成 / 编辑，
              产物可一键送去运行或导出为模板草案。左键拖拽框选（平移用空格 / 中键），Del 删除 / Ctrl+Z 撤销。
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
            <button type="button" class="btn primary" :disabled="cv.projectId == null" @click="cv.createCanvas">
              <Icon name="plus" :size="13" /> 新建画布
            </button>
          </div>
        </div>
      </div>

</template>

<style scoped>
.crt-board {
  position: relative;
  flex: 1;
  min-width: 0;
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

/* ===== [M17] 批量浮动条 / 总览抽屉 / 导出弹窗 ===== */
.batch-bar {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  max-width: calc(100% - 24px);
  padding: 7px 10px;
  border-radius: 10px;
  z-index: 5;
  box-shadow: 0 10px 30px rgb(0 0 0 / 45%);
}

.bb-n {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.bb-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
}

</style>
