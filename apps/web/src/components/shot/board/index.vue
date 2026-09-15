<script setup lang="ts">
/**
 * [M7] 镜头级轻工作台（spec §3.5）
 * 挂载：RunDetailView 步骤卡内（actionKey ∈ {ai_image, ai_video}）
 * 交互约定（写死）：
 * - 时长编辑：change 即提交（单条 edit），刷新后输入框保留新值
 * - 版本选用 / 启用开关：本地 draft，头条「应用选择」统一提交 select
 * - 重生成：即时提交（可选改词），执行进度由 TaskPanel / socket 呈现
 * - 重新合成：确认弹窗 → recompose；active（run 运行中）时全部操作禁用
 * ---- [M28] 已拆分：internals / use-shot-board / ShotCard / VersionStrip / ComposeBar（行为零变更；状态经 useShotBoard 装配）----
 */
import Icon from '../../common/Icon.vue'
import AssetPreviewer from '../../asset/previewer/index.vue'
import ComposeSettingsModal from '../../run/ComposeSettingsModal.vue'
import StoryboardEditor from '../storyboard-editor/index.vue'
import ShotSfxModal from '../ShotSfxModal.vue'
import ShotCard from './ShotCard.vue'
import ComposeBar from './ComposeBar.vue'
import { useShotBoard } from './use-shot-board'
import type { ShotBoardEmits, ShotBoardProps } from './internals'

const props = defineProps<ShotBoardProps>()
const emit = defineEmits<ShotBoardEmits>()

// ---- M28 装配：状态/操作经 composable；模板标识符解构直用 ----
const {
  sb,
  loading, err, notice, shots, compose, repairable, canOperate, summary, draftCount, allPicked,
  previewOpen, previewAssets, previewIndex, editorOpen, composeSettingsOpen, sfxShotId, sfxMap,
  uploadInput, isVideoStep, bulkDuration, bulkPicked,
  openEditor, doRecompose, applySelection, toggleAll, applyBulkDuration, doCleanupVersions, resetSelection,
  onUploadPicked, onPreviewAssetChanged, loadComposeCfg, onSfxChanged, onEditorSaved, saveTransition,
  isEnabled, openPreview, thumbUrl, markThumbFailed, lineIdsOf, selectedQualityWarn,
  onCardDragOver, onCardDragLeave, onCardDrop, onGripDragStart, clearDrag,
  togglePick, toggleEnable, durationValue, onDurationInput, commitDuration,
  togglePrompt, doRegenerate, pickUpload, toggleGallery, openSfx, savePrompt,
  effSelected, verQualityWarn, toggleVersionFavorite, markVerThumbFailed, pickVersion,
} = useShotBoard(props, emit)
</script>

<template>
  <div class="wb">
    <!-- 头条：汇总 + stale 徽标 + 合成 / 应用选择 -->
    <div class="wb-head">
      <span class="wb-title"><Icon name="sliders" :size="13" /> 镜头工作台</span>
      <span class="muted wb-sum">{{ summary }}</span>
      <span
        v-if="compose?.stale === true"
        class="wb-tag warn"
        title="镜头选择 / 分镜 / 时长有更新，重新合成后生效"
      >
        <Icon name="alert" :size="11" /> 待重新合成
      </span>
      <span v-else-if="compose?.stale === false" class="wb-tag ok" title="成片与当前选择一致">合成已最新</span>
      <span class="grow" />
      <button class="btn sm" :disabled="!canOperate" @click="openEditor">
        <Icon name="pencil" :size="12" /> 编辑分镜
      </button>
      <button v-if="compose" class="btn sm" :disabled="!canOperate" @click="doRecompose">
        <Icon name="film" :size="12" /> 重新合成
      </button>
      <button class="btn sm" :class="{ primary: draftCount > 0 }" :disabled="!canOperate || draftCount === 0" @click="applySelection">
        <Icon name="check" :size="12" /> 应用选择{{ draftCount ? ` (${draftCount})` : '' }}
      </button>
    </div>

    <!-- [M19] 合成设置行：转场 + 合成设置（配乐/字幕样式；不触发执行；重新合成后生效） -->
    <ComposeBar :sb="sb" :save-transition="saveTransition" />

    <div v-if="!repairable.ok && repairable.reason" class="wb-lock">
      <Icon name="alert" :size="12" /> {{ repairable.reason }}
    </div>
    <div v-else-if="props.active" class="wb-lock muted">
      <Icon name="clock" :size="12" /> run 执行中，返修操作暂不可用（完成后自动刷新）
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="notice" class="wb-notice"><Icon name="check" :size="12" /> {{ notice }}</div>

    <!-- 批量工具行 -->
    <div class="wb-tools">
      <label class="wb-ck" title="全选：批量时长应用目标">
        <input type="checkbox" :checked="allPicked" :disabled="!shots.length" @change="toggleAll" /> 全选
      </label>
      <span class="muted">批量时长</span>
      <input
        v-model="bulkDuration"
        type="number"
        min="0.5"
        max="60"
        step="0.5"
        placeholder="秒"
        class="wb-num"
        :disabled="!canOperate"
      />
      <button class="btn sm" :disabled="!canOperate || !bulkPicked.length" @click="applyBulkDuration">应用</button>
      <span v-if="bulkPicked.length" class="muted">已勾选 {{ bulkPicked.length }} 镜</span>
      <span class="grow" />
      <button
        class="btn sm"
        title="每组保留最新 / 收藏 / 在用版本，其余软删（回收空间前可回溯）"
        :disabled="!canOperate"
        @click="doCleanupVersions"
      >
        <Icon name="trash" :size="12" /> 清理旧版本
      </button>
      <button class="btn sm" :disabled="!canOperate" @click="resetSelection">恢复全量默认</button>
    </div>

    <!-- 镜头网格 -->
    <div class="wb-grid">
      <ShotCard
        v-for="shot in shots"
        :key="shot.shotId"
        :shot="shot"
        :sb="sb"
        :is-enabled="isEnabled"
        :open-preview="openPreview"
        :mark-thumb-failed="markThumbFailed"
        :line-ids-of="lineIdsOf"
        :selected-quality-warn="selectedQualityWarn"
        :on-card-drag-over="onCardDragOver"
        :on-card-drag-leave="onCardDragLeave"
        :on-card-drop="onCardDrop"
        :on-grip-drag-start="onGripDragStart"
        :clear-drag="clearDrag"
        :toggle-pick="togglePick"
        :toggle-enable="toggleEnable"
        :duration-value="durationValue"
        :on-duration-input="onDurationInput"
        :commit-duration="commitDuration"
        :toggle-prompt="togglePrompt"
        :do-regenerate="doRegenerate"
        :pick-upload="pickUpload"
        :toggle-gallery="toggleGallery"
        :open-sfx="openSfx"
        :save-prompt="savePrompt"
        :eff-selected="effSelected"
        :ver-quality-warn="verQualityWarn"
        :toggle-version-favorite="toggleVersionFavorite"
        :mark-ver-thumb-failed="markVerThumbFailed"
        :pick-version="pickVersion"
        :thumb-url="thumbUrl"
      />

      <div v-if="!shots.length && !loading" class="empty wb-empty">无镜头数据（分镜为空或解析失败）</div>
    </div>

    <input
      ref="uploadInput"
      type="file"
      class="wb-file"
      :accept="isVideoStep ? 'video/*' : 'image/*'"
      @change="onUploadPicked"
    />

    <AssetPreviewer
      v-if="previewOpen"
      :assets="previewAssets"
      :index="previewIndex"
      @close="previewOpen = false"
      @changed="onPreviewAssetChanged"
    />

    <ComposeSettingsModal
      v-if="composeSettingsOpen"
      :run-id="props.runId"
      :project-id="props.projectId"
      @close="composeSettingsOpen = false"
      @changed="loadComposeCfg"
    />

    <ShotSfxModal
      v-if="sfxShotId"
      :run-id="props.runId"
      :project-id="props.projectId"
      :shot-id="sfxShotId"
      :bound="sfxMap[sfxShotId] ?? null"
      @close="sfxShotId = null"
      @changed="onSfxChanged"
    />

    <StoryboardEditor
      v-if="editorOpen"
      :run-id="props.runId"
      :step="props.step"
      :shots="shots"
      :can-operate="canOperate"
      @close="editorOpen = false"
      @saved="onEditorSaved"
    />
  </div>
</template>

<style scoped>
.wb {
  margin-top: 10px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.wb-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}

.wb-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}

.wb-sum {
  font-size: 12px;
}

.wb-lock {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-weak);
  border: 1px solid rgb(245 158 11 / 20%);
  border-radius: 8px;
  padding: 5px 10px;
  margin: 6px 0;
}

.wb-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ok);
  background: var(--ok-weak);
  border: 1px solid rgb(34 197 94 / 20%);
  border-radius: 8px;
  padding: 5px 10px;
  margin: 6px 0;
}

/* stale 徽标三态（true=warn / false=ok；null 不显示） */
.wb-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  border-radius: 999px;
  padding: 1px 9px;
  border: 1px solid transparent;
}

.wb-tag.warn {
  color: var(--warn);
  background: var(--warn-weak);
  border-color: rgb(245 158 11 / 24%);
}

.wb-tag.ok {
  color: var(--ok);
  background: var(--ok-weak);
  border-color: rgb(34 197 94 / 22%);
}

/* ---------- 批量工具行 ---------- */
.wb-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  margin: 6px 0;
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

/* ---------- 镜头网格 ---------- */
.wb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(156px, 1fr));
  gap: 10px;
  margin-top: 8px;
}

.wb-empty {
  grid-column: 1 / -1;
  padding: 18px 0;
}

.wb-file {
  display: none;
}
</style>
