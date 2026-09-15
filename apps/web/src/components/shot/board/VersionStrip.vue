<script setup lang="ts">
import Icon from '../../common/Icon.vue'
import { fmtTime } from '../../../lib/format'
import type { ShotBoardShot } from '../../../lib/types'
import type { ShotBoardApi, ShotBoardState } from './use-shot-board'

const props = defineProps<{
  shot: ShotBoardShot
  sb: ShotBoardState
  effSelected: ShotBoardApi['effSelected']
  openPreview: ShotBoardApi['openPreview']
  markVerThumbFailed: ShotBoardApi['markVerThumbFailed']
  verQualityWarn: ShotBoardApi['verQualityWarn']
  toggleVersionFavorite: ShotBoardApi['toggleVersionFavorite']
  pickVersion: ShotBoardApi['pickVersion']
}>()
const sb = props.sb
</script>

<template>
        <div v-if="sb.galleryShotId === shot.shotId" class="wb-gallery">
          <div
            v-for="v in shot.versions"
            :key="v.id"
            class="wb-ver"
            :class="{ sel: effSelected(shot) === v.id }"
          >
            <div class="wb-vthumb" :title="`预览 ${v.name}`" @click="openPreview(shot, v.id)">
              <img
                v-if="v.urls.thumb && !sb.verThumbFailed.includes(v.id)"
                :src="v.urls.thumb"
                :alt="v.name"
                loading="lazy"
                @error="markVerThumbFailed(v.id)"
              />
              <span v-else class="wb-ph sm"><Icon :name="sb.isVideoStep ? 'play' : 'photo'" :size="14" /></span>
              <span v-if="v.source === 'upload'" class="wb-vtag" title="本地上传入库">上传</span>
              <span
                v-if="verQualityWarn(v)"
                class="wb-qbadge"
                :title="`检测异常：${verQualityWarn(v)}（仍可选用；建议换版或重生成）`"
              >
                <Icon name="alert" :size="10" />
              </span>
            </div>
            <div class="wb-vmeta">
              <button
                class="wb-heart"
                :class="{ on: v.isFavorite === 1 }"
                :disabled="sb.opBusy"
                :title="v.isFavorite === 1 ? '取消收藏（收藏版本清理时保留）' : '收藏（清理时保留该版本）'"
                @click="toggleVersionFavorite(v)"
              >
                <Icon name="heart" :size="11" />
              </button>
              <span class="muted mono wb-vtime">{{ fmtTime(v.createdAt) }}</span>
              <button class="wb-mini" :disabled="!sb.canOperate" @click="pickVersion(shot, v.id)">
                {{ effSelected(shot) === v.id ? '当前' : '选用' }}
              </button>
            </div>
          </div>
          <div v-if="!shot.versions.length" class="muted wb-tip">暂无历史版本</div>
        </div>
</template>

<style scoped>
/* ---------- 版本画廊 ---------- */
.wb-gallery {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 0 7px 8px;
}

.wb-ver {
  flex: none;
  width: 72px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
}

.wb-ver.sel {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgb(99 102 241 / 22%);
}

.wb-vthumb {
  position: relative;
  aspect-ratio: 3 / 4;
  background: var(--img-ph);
  cursor: zoom-in;
  overflow: hidden;
}

/* [M10] 上传资产角标（与任务版区分） */
.wb-vtag {
  position: absolute;
  left: 3px;
  top: 3px;
  font-size: 9.5px;
  line-height: 14px;
  color: #fff;
  background: rgb(99 102 241 / 85%);
  border-radius: 4px;
  padding: 0 4px;
  pointer-events: none;
}

.wb-vthumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.wb-vmeta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 3px 5px;
}

.wb-vtime {
  font-size: 9.5px;
  white-space: nowrap;
  overflow: hidden;
}

.wb-tip {
  font-size: 11.5px;
}

.wb-qbadge {
  position: absolute;
  right: 3px;
  top: 3px;
  display: inline-flex;
  align-items: center;
  color: #fff;
  background: rgb(248 113 113 / 82%);
  border-radius: 4px;
  padding: 1px 3px;
  pointer-events: none;
}

/* [M12] 收藏按钮（版本画廊） */
.wb-heart {
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 0 2px;
  display: inline-flex;
  flex: none;
  transition: color 0.15s;
}

.wb-heart:hover {
  color: var(--bad);
}

.wb-heart.on {
  color: var(--bad);
}

.wb-heart.on .ic {
  fill: currentColor;
}

.wb-heart:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.wb-mini {
  border: none;
  background: none;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
  padding: 0 2px;
  transition: color 0.15s;
  flex: none;
}

.wb-mini:hover {
  color: var(--text);
}

.wb-mini:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

@media (prefers-reduced-motion: reduce) {
  .wb-heart {
    transition: none;
  }
}
</style>
