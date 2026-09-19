<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{
  cv: Pick<
    CanvasViewState,
    | 'showOverview'
    | 'canvasId'
    | 'nodes'
    | 'overviewRows'
    | 'selectedIds'
    | 'focusNode'
  >
}>()
const cv = props.cv
</script>

<template>
  <!-- [M17] 全局状态总览抽屉（doc 派生；点击定位） -->
  <aside
    v-if="cv.showOverview && cv.canvasId != null"
    class="ov-drawer panel"
    aria-label="全局状态总览"
  >
    <div class="ov-h">
      <span>总览</span>
      <span class="muted mini">{{ cv.nodes.length }} 节点</span>
      <button
        type="button"
        class="iconbtn"
        title="收起"
        @click="cv.showOverview = false"
      >
        <Icon name="x" :size="12" />
      </button>
    </div>
    <div class="muted mini ov-legend">
      按严重度排序：失败 › 未就绪 › 运行中 › 就绪 › 完成 /
      空闲；点击行定位到节点。
    </div>
    <div v-if="!cv.overviewRows.length" class="muted mini">画布暂无节点</div>
    <div v-else class="ov-list">
      <button
        v-for="r in cv.overviewRows"
        :key="r.id"
        type="button"
        class="ov-row"
        :class="{ active: cv.selectedIds.includes(r.id) }"
        :title="r.summary"
        @click="cv.focusNode(r.id)"
      >
        <span class="ov-dot" :class="r.dot" />
        <span class="ov-title">{{ r.title }}</span>
        <span class="ov-kind muted mini">{{ r.kind }}</span>
        <span class="ov-sum">{{ r.summary }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.mini {
  font-size: 11px;
}

.iconbtn {
  display: flex;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 3px;
  border-radius: 6px;
}

.iconbtn:hover {
  background: var(--hover);
  color: #fff;
}

.ov-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 312px;
  max-width: 88vw;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 12px 14px;
  border-left: 1px solid var(--border);
  box-shadow: -14px 0 30px rgb(0 0 0 / 34%);
  overflow-y: auto;
  z-index: 7;
}

.ov-h {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 13.5px;
}

.ov-h .iconbtn {
  margin-left: auto;
}

.ov-legend {
  line-height: 1.6;
}

.ov-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ov-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  color: var(--text);
  padding: 6px 9px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}

.ov-row:hover {
  border-color: var(--accent);
}

.ov-row.active {
  border-color: var(--accent);
  background: var(--hover);
}

.ov-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
}

.ov-dot.bad {
  background: var(--bad);
}

.ov-dot.warn {
  background: var(--warn);
}

.ov-dot.run {
  background: var(--accent);
}

.ov-dot.ok {
  background: var(--ok);
}

.ov-title {
  flex: 0 1 auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-kind {
  flex: none;
}

.ov-sum {
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
}
</style>
