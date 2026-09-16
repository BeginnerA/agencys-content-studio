<script setup lang="ts">
import { ref } from 'vue'
import type { Asset } from '../../lib/types'
import { KIND_TEXT, fmtSize, fmtTime, parseAssetQuality, qualityText } from '../../lib/format'
import AssetPreviewer from './previewer/index.vue'
import AssetThumb from './AssetThumb.vue'
import Icon from '../common/Icon.vue'

const props = defineProps<{ assets: Asset[]; loading?: boolean; pickable?: boolean; selectable?: boolean; checkedIds?: number[] }>()
const emit = defineEmits<{ pick: [asset: Asset]; favorite: [asset: Asset]; changed: [asset: Asset]; toggleCheck: [asset: Asset] }>()

const previewIdx = ref<number | null>(null)

/** [M21] 选择模式：选中集合判断 */
function isChecked(a: Asset): boolean {
  return !!props.checkedIds?.includes(a.id)
}

/** 整卡激活：pickable 回传资产；selectable 切换选中（不改预览）；否则打开统一预览器 */
function activate(a: Asset) {
  if (props.pickable) {
    emit('pick', a)
    return
  }
  if (props.selectable) {
    emit('toggleCheck', a)
    return
  }
  previewIdx.value = Math.max(0, props.assets.findIndex((x) => x.id === a.id))
}

function kindText(kind: string): string {
  return KIND_TEXT[kind] ?? kind
}

/** 键盘与读屏可用的整卡描述 */
function ariaLabel(a: Asset): string {
  const act = props.pickable ? '选择' : props.selectable ? (isChecked(a) ? '取消选中' : '选中') : '预览'
  return `${a.name}，${kindText(a.kind)}，${fmtSize(a.fileSize)}，${fmtTime(a.createdAt)}，回车${act}`
}

/** [M12] 收藏切换（提交宿主：唯一使用方 ProjectDetailView 负责 API 与通知） */
function toggleFav(a: Asset) {
  emit('favorite', a)
}

/** [M12] 质量异常文案（仅 ok===false 返回；无 / 正常不显示徽标） */
function qualityWarn(a: Asset): string | null {
  const q = parseAssetQuality(a)
  return q && q.ok === false ? qualityText(q.reason) : null
}
</script>

<template>
  <div>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!assets.length" class="empty">暂无资产</div>
    <div v-else class="grid">
      <button
        v-for="a in assets"
        :key="a.id"
        type="button"
        class="cell"
        :aria-label="ariaLabel(a)"
        @click="activate(a)"
      >
        <AssetThumb :asset="a" :pickable="pickable" />
        <span v-if="selectable" class="ck" :class="{ on: isChecked(a) }" aria-hidden="true">
          <Icon v-if="isChecked(a)" name="check" :size="11" :stroke-width="2.6" />
        </span>
        <span
          v-if="qualityWarn(a)"
          class="qbadge"
          :class="{ right: selectable }"
          :title="`检测异常：${qualityWarn(a)}（预览中可重检）`"
        >
          <Icon name="alert" :size="11" /> {{ qualityWarn(a) }}
        </span>
        <span
          v-if="!selectable"
          class="fav"
          :class="{ on: a.isFavorite === 1 }"
          role="button"
          tabindex="0"
          :aria-label="a.isFavorite === 1 ? `取消收藏 ${a.name}` : `收藏 ${a.name}`"
          :title="a.isFavorite === 1 ? '取消收藏（版本清理保留豁免）' : '收藏（版本清理保留豁免）'"
          @click.stop="toggleFav(a)"
          @keydown.enter.stop.prevent="toggleFav(a)"
          @keydown.space.stop.prevent="toggleFav(a)"
        >
          <Icon name="heart" :size="13" />
        </span>
        <span class="meta">
          <span class="nm" :title="a.name">{{ a.name }}</span>
          <span v-if="a.tags?.length" class="tgs" :title="a.tags.join('、')">
            <span class="tg">{{ a.tags[0] }}</span>
            <span v-if="a.tags.length > 1" class="tg">{{ a.tags[1] }}</span>
            <span v-if="a.tags.length > 2" class="tg more">+{{ a.tags.length - 2 }}</span>
          </span>
          <span class="sub">
            <span class="kind">{{ kindText(a.kind) }}</span>
            <span class="sep">·</span>
            <span class="sz">{{ fmtSize(a.fileSize) }}</span>
            <span class="sep">·</span>
            <span class="tm">{{ fmtTime(a.createdAt) }}</span>
          </span>
        </span>
      </button>
    </div>

    <AssetPreviewer
      v-if="previewIdx !== null"
      :assets="assets"
      :index="previewIdx"
      @close="previewIdx = null"
      @changed="(u) => emit('changed', u)"
    />
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 16px;
}

/* 整卡为按钮：键盘可达 + 可见焦点环 */
.cell {
  position: relative;
  display: block;
  width: 100%;
  padding: 0;
  margin: 0;
  text-align: left;
  font: inherit;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    box-shadow 0.16s ease,
    border-color 0.16s ease;
}

.cell:hover {
  /* 下发给 AssetThumb：显示悬停提示 + 媒体轻微放大 */
  --veil: 1;
  --thumb-zoom: 1.045;
  transform: translateY(-2px);
  box-shadow: 0 14px 30px -18px rgb(0 0 0 / 72%);
  border-color: rgb(99 102 241 / 45%);
}

.cell:focus-visible {
  outline: none;
  border-color: var(--ring);
  box-shadow: 0 0 0 3px rgb(139 92 246 / 28%);
}

.meta {
  display: block;
  padding: 8px 12px 12px;
}

.nm {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-3);
  min-width: 0;
}

.sub .kind {
  flex: none;
  color: var(--text-2);
}

.sub .sep {
  flex: none;
  opacity: 0.45;
}

.sub .sz {
  flex: none;
}

.sub .tm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* [M21] 选择模式复选框（空格视觉指示；整卡点击即切换） */
.ck {
  position: absolute;
  left: 6px;
  top: 6px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 1.5px solid rgb(255 255 255 / 55%);
  background: rgb(10 14 24 / 55%);
  backdrop-filter: blur(4px);
  color: #fff;
}

.ck.on {
  border-color: var(--accent);
  background: var(--accent);
}

/* 选择模式：质量角标避让左上复选框，移至右上 */
.qbadge.right {
  left: auto;
  right: 6px;
}

/* [M21] 标签 chips（≤2 + N；title 展开全文） */
.tgs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 3px;
  min-width: 0;
  overflow: hidden;
}

.tg {
  flex: none;
  max-width: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  line-height: 16px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--chip-bg);
  color: var(--text-2);
}

.tg.more {
  color: var(--text-3);
}

/* [M12] 质量异常角标（不阻断；提示在预览中重检） */
.qbadge {
  position: absolute;
  left: 6px;
  top: 6px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
  line-height: 18px;
  color: #fff;
  background: rgb(248 113 113 / 82%);
  backdrop-filter: blur(4px);
  border-radius: 999px;
  padding: 0 7px;
  pointer-events: none;
}

/* [M12] 收藏按钮（hover / 聚焦 / 已收藏常显；收藏态填充心形） */
.fav {
  position: absolute;
  right: 6px;
  top: 6px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: #fff;
  background: rgb(10 14 24 / 62%);
  backdrop-filter: blur(4px);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease;
}

.cell:hover .fav,
.cell:focus-visible .fav,
.fav:focus-visible,
.fav.on {
  opacity: 1;
}

.fav:hover,
.fav.on {
  color: var(--bad);
}

.fav.on .ic {
  fill: currentColor;
}

@media (prefers-reduced-motion: reduce) {
  .cell {
    transition: none;
  }

  .cell:hover {
    transform: none;
  }

  .fav {
    transition: none;
  }
}
</style>
