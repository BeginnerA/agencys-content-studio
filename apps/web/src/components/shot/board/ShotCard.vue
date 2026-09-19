<script setup lang="ts">
import Icon from '../../common/Icon.vue'
import { taskStatus } from '../../../lib/format'
import type { ShotBoardShot } from '../../../lib/types'
import VersionStrip from './VersionStrip.vue'
import type { ShotBoardApi, ShotBoardState } from './use-shot-board'

const props = defineProps<{
  shot: ShotBoardShot
  sb: ShotBoardState
  isEnabled: ShotBoardApi['isEnabled']
  openPreview: ShotBoardApi['openPreview']
  markThumbFailed: ShotBoardApi['markThumbFailed']
  lineIdsOf: ShotBoardApi['lineIdsOf']
  selectedQualityWarn: ShotBoardApi['selectedQualityWarn']
  onCardDragOver: ShotBoardApi['onCardDragOver']
  onCardDragLeave: ShotBoardApi['onCardDragLeave']
  onCardDrop: ShotBoardApi['onCardDrop']
  onGripDragStart: ShotBoardApi['onGripDragStart']
  clearDrag: ShotBoardApi['clearDrag']
  togglePick: ShotBoardApi['togglePick']
  toggleEnable: ShotBoardApi['toggleEnable']
  durationValue: ShotBoardApi['durationValue']
  onDurationInput: ShotBoardApi['onDurationInput']
  commitDuration: ShotBoardApi['commitDuration']
  togglePrompt: ShotBoardApi['togglePrompt']
  doRegenerate: ShotBoardApi['doRegenerate']
  pickUpload: ShotBoardApi['pickUpload']
  toggleGallery: ShotBoardApi['toggleGallery']
  openSfx: ShotBoardApi['openSfx']
  savePrompt: ShotBoardApi['savePrompt']
  effSelected: ShotBoardApi['effSelected']
  verQualityWarn: ShotBoardApi['verQualityWarn']
  toggleVersionFavorite: ShotBoardApi['toggleVersionFavorite']
  markVerThumbFailed: ShotBoardApi['markVerThumbFailed']
  pickVersion: ShotBoardApi['pickVersion']
  thumbUrl: ShotBoardApi['thumbUrl']
}>()
const sb = props.sb
</script>

<template>
  <div
    class="wb-card"
    :class="{
      off: !isEnabled(shot),
      fail: shot.task?.status === 'failed',
      dragging: sb.dragShotId === shot.shotId,
      'drop-left':
        sb.dropTarget?.shotId === shot.shotId && sb.dropTarget.side === 'left',
      'drop-right':
        sb.dropTarget?.shotId === shot.shotId && sb.dropTarget.side === 'right',
    }"
    @dragover="onCardDragOver(shot, $event)"
    @dragleave="onCardDragLeave(shot, $event)"
    @drop.prevent="onCardDrop(shot, $event)"
  >
    <div
      class="wb-thumb"
      :title="`预览镜头 ${shot.shotId}`"
      @click="openPreview(shot)"
    >
      <img
        v-if="thumbUrl(shot) && !sb.thumbFailed.includes(shot.shotId)"
        :src="thumbUrl(shot)!"
        :alt="shot.shotId"
        loading="lazy"
        @error="markThumbFailed(shot.shotId)"
      />
      <span v-else class="wb-ph"
        ><Icon :name="sb.isVideoStep ? 'play' : 'photo'" :size="22"
      /></span>
      <span
        v-if="lineIdsOf(shot).length"
        class="wb-lines"
        :title="`台词 ${lineIdsOf(shot).length} 句：${lineIdsOf(shot).join('、')}`"
      >
        台词 {{ lineIdsOf(shot).length }} 句
      </span>
      <span
        v-if="selectedQualityWarn(shot)"
        class="wb-qwarn"
        :title="`当前选中版本检测异常：${selectedQualityWarn(shot)}（仍按选中合成；可换版或重生成）`"
      >
        <Icon name="alert" :size="10" /> 图异常
      </span>
      <span v-if="shot.versions.length > 1" class="wb-vcount"
        >{{ shot.versions.length }} 版</span
      >
      <span
        v-if="sb.draftSelected[shot.shotId] !== undefined"
        class="wb-dot"
        title="已切换版本（待应用）"
      />
    </div>

    <div class="wb-meta">
      <span
        class="wb-grip"
        :class="{ disabled: !sb.canOperate }"
        :draggable="sb.canOperate"
        title="拖拽调整镜头顺序（重新合成后生效）"
        @dragstart="onGripDragStart(shot, $event)"
        @dragend="clearDrag"
      />
      <label class="wb-ck" title="勾选参与批量时长">
        <input
          type="checkbox"
          :checked="sb.bulkPicked.includes(shot.shotId)"
          @change="togglePick(shot.shotId)"
        />
      </label>
      <span class="wb-id mono">{{ shot.shotId }}</span>
      <span
        v-if="shot.task"
        class="badge"
        :class="shot.task.status"
        :title="shot.task.errorMsg ?? ''"
      >
        {{ taskStatus(shot.task.status).text }}
      </span>
      <span v-else class="badge pending">无任务</span>
      <span class="grow" />
      <button
        class="wb-eye"
        :class="{ off: !isEnabled(shot) }"
        :disabled="!sb.canOperate || !shot.versions.length"
        :title="
          !shot.versions.length
            ? '暂无产物版本'
            : isEnabled(shot)
              ? '停用：不进成片（应用选择后生效）'
              : '启用：纳入成片'
        "
        @click="toggleEnable(shot)"
      >
        <Icon name="eye" :size="13" />
      </button>
    </div>

    <div class="wb-row">
      <span class="muted wb-lb">时长</span>
      <input
        type="number"
        class="wb-num"
        min="0.5"
        max="60"
        step="0.5"
        placeholder="默认"
        :value="durationValue(shot)"
        :disabled="!sb.canOperate"
        @input="onDurationInput(shot, $event)"
        @blur="commitDuration(shot)"
        @keyup.enter="commitDuration(shot)"
      />
      <span class="muted">s</span>
      <span class="grow" />
      <button
        class="wb-mini"
        :disabled="!sb.canOperate"
        @click="togglePrompt(shot)"
      >
        {{ sb.promptShotId === shot.shotId ? '收起' : '改词' }}
      </button>
      <button
        class="wb-mini"
        :disabled="!sb.canOperate || !shot.task"
        :title="shot.task ? '重生成该镜（重新计费）' : '该镜无生成任务'"
        @click="doRegenerate(shot)"
      >
        重生成
      </button>
      <button
        class="wb-mini"
        :disabled="!sb.canOperate || sb.uploadBusy"
        :title="`上传本地${sb.isVideoStep ? '视频' : '图片'}替换该镜产物（重新合成后生效）`"
        @click="pickUpload(shot)"
      >
        上传替换
      </button>
      <button
        class="wb-mini"
        :disabled="!shot.versions.length"
        @click="toggleGallery(shot)"
      >
        版本 {{ shot.versions.length }}
      </button>
      <button
        class="wb-mini"
        :class="{ on: !!sb.sfxMap[shot.shotId] }"
        :disabled="!sb.canOperate"
        :title="
          sb.sfxMap[shot.shotId]
            ? `音效：${sb.sfxMap[shot.shotId]!.name}（重新合成后生效）`
            : '为该镜绑定音效（上传 / 项目音频；重新合成后生效）'
        "
        @click="openSfx(shot)"
      >
        音效{{ sb.sfxMap[shot.shotId] ? ' · 1' : '' }}
      </button>
    </div>

    <div v-if="sb.promptShotId === shot.shotId" class="wb-prompt">
      <div class="muted wb-lb">{{ sb.promptFieldLabel }}</div>
      <textarea
        v-model="sb.promptDraft"
        rows="3"
        spellcheck="false"
        :disabled="!sb.canOperate"
      ></textarea>
      <div class="wb-pa">
        <button
          class="btn sm"
          :disabled="!sb.canOperate"
          @click="savePrompt(shot)"
        >
          保存到分镜
        </button>
        <button
          class="btn sm"
          :disabled="!sb.canOperate"
          @click="doRegenerate(shot, true)"
        >
          保存并重生成
        </button>
      </div>
    </div>

    <VersionStrip
      :shot="shot"
      :sb="sb"
      :eff-selected="effSelected"
      :open-preview="openPreview"
      :mark-ver-thumb-failed="markVerThumbFailed"
      :ver-quality-warn="verQualityWarn"
      :toggle-version-favorite="toggleVersionFavorite"
      :pick-version="pickVersion"
    />

    <div
      v-if="shot.task?.errorMsg"
      class="wb-err mono"
      :title="shot.task.errorMsg"
    >
      {{ shot.task.errorMsg }}
    </div>
  </div>
</template>

<style scoped>
.wb-ck {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  flex: none;
}

.wb-ck input {
  accent-color: var(--accent);
  cursor: pointer;
}

/* [M10] 拖拽把手（2×3 点阵） */
.wb-grip {
  flex: none;
  width: 12px;
  height: 16px;
  cursor: grab;
  background-image: radial-gradient(
    circle,
    var(--text-3) 1px,
    transparent 1.1px
  );
  background-size: 5px 5px;
  background-position: 1px 1px;
  opacity: 0.75;
}

.wb-grip:hover {
  opacity: 1;
}

.wb-grip:active {
  cursor: grabbing;
}

.wb-grip.disabled {
  cursor: not-allowed;
  opacity: 0.3;
}

.wb-num {
  width: 64px;
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
  font-family: inherit;
}

.wb-num:disabled {
  opacity: 0.5;
}

.wb-card {
  border: 1px solid var(--border);
  background: var(--panel-2);
  border-radius: 10px;
  overflow: hidden;
  min-width: 0;
  transition:
    border-color 0.15s,
    opacity 0.2s;
}

.wb-card:hover {
  border-color: var(--border-strong);
}

/* 停用：半透明 + 缩略图去饱和 */
.wb-card.off {
  opacity: 0.55;
}

.wb-card.off .wb-thumb img {
  filter: grayscale(0.9);
}

.wb-card.fail {
  border-color: rgb(248 113 113 / 34%);
}

/* [M10] 拖拽重排态：源半透明 / 目标左右插入线 */
.wb-card.dragging {
  opacity: 0.45;
}

.wb-card.drop-left {
  box-shadow: inset 3px 0 0 var(--accent);
}

.wb-card.drop-right {
  box-shadow: inset -3px 0 0 var(--accent);
}

.wb-thumb {
  position: relative;
  display: block;
  aspect-ratio: 3 / 4;
  background: var(--img-ph);
  cursor: zoom-in;
  overflow: hidden;
}

.wb-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.wb-ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-3);
  background:
    radial-gradient(112% 78% at 50% 8%, rgb(99 102 241 / 12%), transparent 62%),
    var(--img-ph);
}

.wb-ph.sm {
  position: static;
  width: 100%;
  height: 100%;
}

.wb-vcount {
  position: absolute;
  right: 5px;
  bottom: 5px;
  font-size: 10.5px;
  color: #fff;
  background: rgb(10 14 24 / 62%);
  backdrop-filter: blur(4px);
  border-radius: 999px;
  padding: 0 7px;
}

/* [M11] 台词角标（raw.lines 非空） */
.wb-lines {
  position: absolute;
  left: 5px;
  top: 5px;
  font-size: 10.5px;
  color: var(--accent-h);
  background: rgb(10 14 24 / 62%);
  backdrop-filter: blur(4px);
  border-radius: 999px;
  padding: 0 7px;
}

.wb-dot {
  position: absolute;
  left: 5px;
  top: 5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-h);
  box-shadow: 0 0 0 3px rgb(139 92 246 / 25%);
}

.wb-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px 0;
}

.wb-id {
  font-size: 11px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-meta .badge {
  font-size: 10.5px;
  line-height: 17px;
  padding: 0 7px;
  flex: none;
}

.wb-eye {
  border: none;
  background: none;
  color: var(--accent-h);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  flex: none;
}

.wb-eye.off {
  color: var(--text-3);
  opacity: 0.7;
}

.wb-eye:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.wb-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 7px;
  font-size: 12px;
  flex-wrap: wrap;
}

.wb-lb {
  font-size: 11.5px;
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

/* [M19] 音效按钮：已绑定高亮 */
.wb-mini.on {
  color: var(--ok);
}

/* ---------- 改词区 ---------- */
.wb-prompt {
  padding: 0 7px 7px;
}

.wb-prompt textarea {
  width: 100%;
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  resize: vertical;
  margin-top: 4px;
}

.wb-pa {
  display: flex;
  gap: 6px;
  margin-top: 5px;
}

.wb-err {
  margin: 0 7px 7px;
  font-size: 11px;
  color: var(--bad);
  background: var(--bad-weak);
  border-radius: 6px;
  padding: 4px 7px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* [M12] 质量异常角标（不阻断合成，提示换版 / 重生成） */
.wb-qwarn {
  position: absolute;
  right: 5px;
  top: 5px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
  color: #fff;
  background: rgb(248 113 113 / 82%);
  backdrop-filter: blur(4px);
  border-radius: 999px;
  padding: 0 7px;
}

@media (prefers-reduced-motion: reduce) {
  .wb-card,
  .wb-mini {
    transition: none;
  }
}
</style>
