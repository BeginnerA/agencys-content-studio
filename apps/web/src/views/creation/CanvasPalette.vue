<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import { toRef } from 'vue'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{
  cv: Pick<
    CanvasViewState,
    | 'fileInput'
    | 'canvasId'
    | 'palKind'
    | 'pickFiles'
    | 'paletteLoading'
    | 'palEntities'
    | 'palette'
    | 'ENT_KIND_TEXT'
    | 'paletteEntityDragStart'
    | 'paletteEntityClick'
    | 'paletteDragStart'
    | 'paletteClick'
    | 'paletteErr'
    | 'onFilePicked'
  >
}>()
const emit = defineEmits<{ close: [] }>()
const cv = props.cv
const fileInput = toRef(cv, 'fileInput')
</script>

<template>
  <!-- 左：素材面板 -->
  <aside
    v-if="cv.canvasId != null"
    class="crt-palette"
    aria-label="素材面板"
    @keydown.space.stop
  >
    <div class="pal-h">
      <strong>项目素材</strong>
      <button
        type="button"
        class="iconbtn"
        title="收起素材面板"
        aria-label="收起素材面板"
        @click="emit('close')"
      >
        <Icon name="chevron-left" :size="15" />
      </button>
    </div>
    <button type="button" class="btn upload-btn" @click="cv.pickFiles">
      <Icon name="upload" :size="14" /> 上传素材
    </button>
    <div class="tabs pal-tabs" role="group" aria-label="素材类型">
      <button
        type="button"
        class="tab"
        :class="{ on: cv.palKind === 'image' }"
        :aria-pressed="cv.palKind === 'image'"
        @click="cv.palKind = 'image'"
      >
        图片
      </button>
      <button
        type="button"
        class="tab"
        :class="{ on: cv.palKind === 'video' }"
        :aria-pressed="cv.palKind === 'video'"
        @click="cv.palKind = 'video'"
      >
        视频
      </button>
      <button
        type="button"
        class="tab"
        :class="{ on: cv.palKind === 'audio' }"
        :aria-pressed="cv.palKind === 'audio'"
        @click="cv.palKind = 'audio'"
      >
        音频
      </button>
      <button
        type="button"
        class="tab"
        :class="{ on: cv.palKind === 'entity' }"
        :aria-pressed="cv.palKind === 'entity'"
        @click="cv.palKind = 'entity'"
      >
        实体
      </button>
    </div>
    <p class="pal-help">拖入画布，或单击添加到画布中心</p>
    <div v-if="cv.paletteLoading" class="muted mini">加载中…</div>
    <div
      v-else-if="cv.palKind === 'entity' && !cv.palEntities.length"
      class="muted mini"
    >
      该项目暂无实体素材，可在「实体馆」页创建。
    </div>
    <div
      v-else-if="cv.palKind !== 'entity' && !cv.palette.length"
      class="muted mini"
    >
      该项目暂无此类素材，可上传，或从流水线抽屉「送入创作画布」。
    </div>
    <div v-else-if="cv.palKind === 'entity'" class="pal-list">
      <button
        v-for="e in cv.palEntities"
        :key="e.id"
        type="button"
        class="pal-item"
        draggable="true"
        :title="`${e.name}（${cv.ENT_KIND_TEXT[e.kind]}；拖入画布 / 单击送至视口中心）`"
        @dragstart="cv.paletteEntityDragStart($event, e)"
        @click="cv.paletteEntityClick(e)"
      >
        <img
          v-if="e.refAssets[0]"
          :src="e.refAssets[0].urls.thumb ?? e.refAssets[0].urls.file"
          loading="lazy"
          alt=""
        />
        <span v-else class="pal-ph">无参考图</span>
        <span class="pal-name">{{ e.name }}</span>
        <span class="pal-ebadge"
          >{{ cv.ENT_KIND_TEXT[e.kind] }} · {{ e.refAssetIds.length }}图</span
        >
      </button>
    </div>
    <div v-else class="pal-list">
      <button
        v-for="a in cv.palette"
        :key="a.id"
        type="button"
        class="pal-item"
        draggable="true"
        :title="`${a.name}（拖入画布 / 单击送至视口中心）`"
        @dragstart="cv.paletteDragStart($event, a)"
        @click="cv.paletteClick(a)"
      >
        <img
          v-if="a.urls.thumb || a.kind === 'image'"
          :src="a.urls.thumb ?? a.urls.file"
          loading="lazy"
          alt=""
        />
        <span class="pal-name">{{ a.name }}</span>
      </button>
    </div>
    <div v-if="cv.paletteErr" class="err-text mini">{{ cv.paletteErr }}</div>
    <input
      ref="fileInput"
      type="file"
      multiple
      accept="image/*,video/*,audio/*,.md,.txt,.json"
      class="hidden-file"
      @change="cv.onFilePicked"
    />
  </aside>
</template>

<style scoped>
.crt-palette {
  width: 224px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background: var(--panel);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

.pal-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}

.pal-tabs {
  display: flex;
  gap: 2px;
  width: 100%;
}
.pal-tabs .tab {
  flex: 1;
  justify-content: center;
  padding: 6px 2px;
  font-size: 12px;
}
.pal-help {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.6;
}
.upload-btn {
  justify-content: center;
  min-height: 36px;
  font-family: inherit;
}
.pal-h strong {
  font-size: 13px;
  color: var(--text);
}

.pal-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

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
  /* [M52] 实体参考图多为横版多视图，contain 免裁 */
  object-fit: contain;
  border-radius: 5px;
  pointer-events: none;
}

.pal-name {
  font-size: 12px;
  color: var(--text-2);
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

.iconbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
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

.hidden-file {
  display: none;
}
</style>
