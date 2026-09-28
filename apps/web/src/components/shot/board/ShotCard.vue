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
        v-if="lineIdsOf(shot).length || selectedQualityWarn(shot)"
        class="wb-chips"
      >
        <span
          v-if="lineIdsOf(shot).length"
          class="wb-cico"
          :title="`台词 ${lineIdsOf(shot).length} 句：${lineIdsOf(shot).join('、')}`"
        >
          <Icon name="chat" :size="11" /> {{ lineIdsOf(shot).length }}
        </span>
        <span
          v-if="selectedQualityWarn(shot)"
          class="wb-cico q"
          :title="`当前选中版本检测异常：${selectedQualityWarn(shot)}（仍按选中合成；可换版或重生成）`"
        >
          <Icon name="alert" :size="11" />
        </span>
      </span>
      <span
        v-if="sb.draftSelected[shot.shotId] !== undefined"
        class="wb-dot"
        title="已切换版本（待应用）"
      />
      <span v-if="shot.versions.length > 1" class="wb-vcount"
        >{{ shot.versions.length }} 版</span
      >
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

    <div class="wb-dur">
      <Icon name="clock" :size="12" class="wb-dur-ic" />
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
    </div>

    <!-- 图标动作行：改词 / 重生成 / 上传替换 / 版本 / 音效（逻辑不变，仅呈现层） -->
    <div class="wb-icons">
      <button
        class="wb-ib"
        :class="{ on: sb.promptShotId === shot.shotId }"
        :disabled="!sb.canEdit"
        aria-label="改提示词"
        :title="sb.promptShotId === shot.shotId ? '收起改词' : (sb.canEdit ? '改提示词' : '审阅闸门下仅非轻松创作模板可改词，其余待收敛后进行')"
        @click="togglePrompt(shot)"
      >
        <Icon name="pencil" :size="14" />
      </button>
      <button
        class="wb-ib"
        :disabled="!sb.canRegenerate || !shot.task"
        aria-label="重生成该镜"
        :title="shot.task ? '重生成该镜（重新计费）' : '该镜无生成任务'"
        @click="doRegenerate(shot)"
      >
        <Icon name="refresh" :size="14" />
      </button>
      <button
        class="wb-ib"
        :disabled="!sb.canOperate || sb.uploadBusy"
        aria-label="上传替换产物"
        :title="`上传本地${sb.isVideoStep ? '视频' : '图片'}替换该镜产物（重新合成后生效）`"
        @click="pickUpload(shot)"
      >
        <Icon name="upload" :size="14" />
      </button>
      <button
        class="wb-ib"
        :class="{ on: sb.galleryShotId === shot.shotId }"
        :disabled="!shot.versions.length"
        aria-label="版本画廊"
        :title="`版本 ${shot.versions.length}（展开选择）`"
        @click="toggleGallery(shot)"
      >
        <Icon name="copy" :size="14" />
        <span v-if="shot.versions.length" class="wb-ibn">{{
          shot.versions.length
        }}</span>
      </button>
      <button
        class="wb-ib wb-ib-sfx"
        :class="{ on: !!sb.sfxMap[shot.shotId] }"
        :disabled="!sb.canOperate"
        aria-label="绑定音效"
        :title="
          sb.sfxMap[shot.shotId]
            ? `音效：${sb.sfxMap[shot.shotId]!.name}（重新合成后生效）`
            : '为该镜绑定音效（上传 / 项目音频；重新合成后生效）'
        "
        @click="openSfx(shot)"
      >
        <Icon name="speaker-wave" :size="14" />
      </button>
    </div>

    <div v-if="sb.promptShotId === shot.shotId" class="wb-prompt">
      <div class="muted wb-lb">{{ sb.promptFieldLabel }}</div>
      <textarea
        v-model="sb.promptDraft"
        rows="3"
        spellcheck="false"
        :disabled="!sb.canEdit"
      ></textarea>
      <div class="wb-pa">
        <button
          class="btn sm"
          :disabled="!sb.canEdit"
          @click="savePrompt(shot)"
        >
          保存到分镜
        </button>
        <button
          class="btn sm"
          :disabled="!sb.canEdit"
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
/* ---------- 卡片容器 ---------- */
.wb-card {
  border: 1px solid var(--border);
  background: var(--panel-2);
  border-radius: 11px;
  overflow: hidden;
  min-width: 0;
  box-shadow: var(--shadow);
  transition:
    border-color 0.15s,
    transform 0.15s,
    box-shadow 0.15s,
    opacity 0.2s;
}

.wb-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-2px);
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

/* 拖拽重排态：源半透明 / 目标左右插入线 */
.wb-card.dragging {
  opacity: 0.45;
}

.wb-card.drop-left {
  box-shadow: inset 3px 0 0 var(--accent);
}

.wb-card.drop-right {
  box-shadow: inset -3px 0 0 var(--accent);
}

/* ---------- 缩略图 ---------- */
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

/* 角标：左上图标簇（台词 / 图异常）+ 右上待应用点 + 右下版数 */
.wb-chips {
  position: absolute;
  left: 6px;
  top: 6px;
  display: flex;
  gap: 4px;
  z-index: 2;
}

.wb-cico {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 20px;
  padding: 0 6px;
  border-radius: 6px;
  font-size: 10.5px;
  color: #fff;
  background: rgb(10 14 24 / 62%);
  backdrop-filter: blur(4px);
}

.wb-cico.q {
  background: rgb(248 113 113 / 85%);
}

.wb-vcount {
  position: absolute;
  right: 6px;
  bottom: 6px;
  font-size: 10.5px;
  color: #fff;
  background: rgb(10 14 24 / 62%);
  backdrop-filter: blur(4px);
  border-radius: 999px;
  padding: 0 7px;
  z-index: 2;
}

.wb-dot {
  position: absolute;
  right: 6px;
  top: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-h);
  box-shadow: 0 0 0 3px rgb(139 92 246 / 25%);
  z-index: 2;
}

/* ---------- 元信息行 ---------- */
.wb-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 7px 0;
}

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

/* 拖拽把手（2×3 点阵） */
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

/* ---------- 时长行 ---------- */
.wb-dur {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 7px 0;
  font-size: 12px;
}

.wb-dur-ic {
  color: var(--text-3);
  flex: none;
}

.wb-lb {
  font-size: 11.5px;
}

.wb-num {
  width: 52px;
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
  font-family: var(--mono);
}

.wb-num:disabled {
  opacity: 0.5;
}

/* ---------- 图标动作行 ---------- */
.wb-icons {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 7px 7px 8px;
}

.wb-ib {
  position: relative;
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--raised);
  color: var(--text-2);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    color 0.14s,
    border-color 0.14s,
    background 0.14s;
}

.wb-ib:hover {
  color: var(--text);
  border-color: var(--accent);
  background: var(--accent-weak);
}

.wb-ib.on {
  color: var(--accent-h);
  border-color: rgb(99 102 241 / 45%);
}

/* 音效已绑定：成功绿（与改词 / 版本展开的靛色 on 态区分） */
.wb-ib-sfx.on {
  color: var(--ok);
  border-color: rgb(34 197 94 / 40%);
}

.wb-ib:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.wb-ibn {
  position: absolute;
  right: 2px;
  bottom: 1px;
  font-size: 8.5px;
  line-height: 1;
  color: var(--text-3);
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

/* 报错：2 行换行不再截断 */
.wb-err {
  margin: 0 7px 7px;
  font-size: 11px;
  color: var(--bad);
  background: var(--bad-weak);
  border-radius: 6px;
  padding: 4px 7px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .wb-card {
    transition: none;
  }

  .wb-card:hover {
    transform: none;
  }

  .wb-ib {
    transition: none;
  }
}
</style>
