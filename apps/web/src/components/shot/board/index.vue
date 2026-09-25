<script setup lang="ts">
/**
 * 镜头级轻工作台（spec §3.5）
 * 挂载：RunDetailView 步骤卡内（actionKey ∈ {ai_image, ai_video}）
 * 交互约定（写死）：
 * - 时长编辑：change 即提交（单条 edit），刷新后输入框保留新值
 * - 版本选用 / 启用开关：本地 draft，头条「应用选择」统一提交 select
 * - 重生成：即时提交（可选改词），执行进度由 TaskPanel / socket 呈现
 * - 重新合成：确认弹窗 → recompose；active（run 运行中）时全部操作禁用
 * ---- 已拆分：internals / use-shot-board / ShotCard / VersionStrip / ComposeBar（行为零变更；状态经 useShotBoard 装配）----
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

// ---- 装配：状态/操作经 composable；模板标识符解构直用 ----
const {
  sb,
  loading,
  err,
  notice,
  shots,
  compose,
  repairable,
  canOperate,
  summary,
  draftCount,
  allPicked,
  previewOpen,
  previewAssets,
  previewIndex,
  editorOpen,
  composeSettingsOpen,
  sfxShotId,
  sfxMap,
  uploadInput,
  isVideoStep,
  bulkDuration,
  bulkPicked,
  openEditor,
  doRecompose,
  applySelection,
  toggleAll,
  applyBulkDuration,
  doCleanupVersions,
  resetSelection,
  onUploadPicked,
  onPreviewAssetChanged,
  loadComposeCfg,
  onSfxChanged,
  onEditorSaved,
  saveTransition,
  isEnabled,
  openPreview,
  thumbUrl,
  markThumbFailed,
  lineIdsOf,
  selectedQualityWarn,
  onCardDragOver,
  onCardDragLeave,
  onCardDrop,
  onGripDragStart,
  clearDrag,
  togglePick,
  toggleEnable,
  durationValue,
  onDurationInput,
  commitDuration,
  togglePrompt,
  doRegenerate,
  pickUpload,
  toggleGallery,
  openSfx,
  savePrompt,
  effSelected,
  verQualityWarn,
  toggleVersionFavorite,
  markVerThumbFailed,
  pickVersion,
} = useShotBoard(props, emit)
</script>

<template>
  <div class="wb">
    <!-- 头条：身份区（标题/汇总/stale 徽标）+ 主操作区（应用选择为唯一主按钮，有草稿时点亮） -->
    <div class="wb-head">
      <span class="wb-title"
        ><Icon name="sliders" :size="13" /> 镜头工作台</span
      >
      <span class="muted wb-sum">{{ summary }}</span>
      <span
        v-if="compose?.stale === true"
        class="wb-tag warn"
        title="镜头选择 / 分镜 / 时长有更新，重新合成后生效"
      >
        <Icon name="alert" :size="11" /> 待重新合成
      </span>
      <span
        v-else-if="compose?.stale === false"
        class="wb-tag ok"
        title="成片与当前选择一致"
        >合成已最新</span
      >
      <span class="grow" />
      <div class="wb-acts">
        <button class="wb-ab" :disabled="!canOperate" @click="openEditor">
          <Icon name="pencil" :size="12" /> 编辑分镜
        </button>
        <button
          v-if="compose"
          class="wb-ab"
          :disabled="!canOperate"
          @click="doRecompose"
        >
          <Icon name="refresh" :size="12" /> 重新合成
        </button>
        <button
          class="wb-ab pri"
          :class="{ on: draftCount > 0 }"
          :disabled="!canOperate || draftCount === 0"
          @click="applySelection"
        >
          <Icon name="check" :size="12" /> 应用选择{{
            draftCount ? ` (${draftCount})` : ''
          }}
        </button>
      </div>
    </div>

    <!-- 控制条：转场设置 | 批量工具 | 合成工具，三段合并为一条深色 strip（纯呈现层重组，绑定不变） -->
    <div class="wb-strip">
      <ComposeBar :sb="sb" :save-transition="saveTransition" />
      <template v-if="shots.length">
        <span v-if="compose" class="wb-sep" />
        <label class="wb-ck" title="全选：批量时长应用目标">
          <input
            type="checkbox"
            :checked="allPicked"
            :disabled="!shots.length"
            @change="toggleAll"
          />
          全选
        </label>
        <span class="muted wb-lb">批量时长</span>
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
        <button
          class="wb-ab"
          :disabled="!canOperate || !bulkPicked.length"
          @click="applyBulkDuration"
        >
          应用
        </button>
        <span v-if="bulkPicked.length" class="muted wb-lb"
          >已勾选 {{ bulkPicked.length }} 镜</span
        >
      </template>
      <span class="grow" />
      <div class="wb-acts">
        <button
          v-if="compose"
          class="wb-ab"
          :title="
            sb.bgm
              ? `合成设置（当前配乐：${sb.bgm.name}）`
              : '合成设置：配乐 / 音效 / 字幕样式 / 水印与片头尾 / 多画幅'
          "
          @click="sb.composeSettingsOpen = true"
        >
          <Icon name="cog" :size="12" /> 合成设置
        </button>
        <button
          class="wb-ab"
          title="每组保留最新 / 收藏 / 在用版本，其余移入回收站（资产页可还原）"
          :disabled="!canOperate"
          @click="doCleanupVersions"
        >
          <Icon name="trash" :size="12" /> 清理旧版本
        </button>
        <button
          class="wb-ab"
          title="清空本地 draft，回到服务端当前选择"
          :disabled="!canOperate"
          @click="resetSelection"
        >
          <Icon name="undo" :size="12" /> 恢复全量默认
        </button>
      </div>
    </div>

    <div v-if="!repairable.ok && repairable.reason" class="wb-lock">
      <Icon name="alert" :size="12" /> {{ repairable.reason }}
    </div>
    <div v-else-if="props.active" class="wb-lock muted">
      <Icon name="clock" :size="12" /> run
      执行中，返修操作暂不可用（完成后自动刷新）
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="notice" class="wb-notice">
      <Icon name="check" :size="12" /> {{ notice }}
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

      <div v-if="!shots.length && !loading" class="empty wb-empty">
        无镜头数据（分镜为空或解析失败）
      </div>
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

.grow {
  flex: 1;
}

/* 动作按钮组（与 ShotCard 图标行同一套视觉语言） */
.wb-acts {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.wb-ab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}

.wb-ab .ic {
  flex: none;
}

.wb-ab:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
}

.wb-ab:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.wb-ab:focus-visible {
  outline: 2px solid var(--accent-h);
  outline-offset: 1px;
}

/* 主按钮：平时 ghost，有草稿/待保存时点亮渐变（唯一强色入口） */
.wb-ab.pri.on {
  background: var(--grad-brand);
  border-color: rgb(99 102 241 / 65%);
  color: #fff;
}

.wb-ab.pri.on:hover:not(:disabled) {
  filter: brightness(1.08);
  color: #fff;
  border-color: rgb(99 102 241 / 65%);
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

/* ---------- 控制条：转场 | 批量 | 工具 三段合并 ---------- */
.wb-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  padding: 7px 10px;
  margin: 8px 0 6px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.wb-sep {
  width: 1px;
  height: 18px;
  background: var(--border-strong);
  flex: none;
}

.wb-lb {
  font-size: 12px;
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
  background: var(--bg); /* 比 strip 底色（--code-bg）更深，避免输入框与控制条融为一体 */
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
  grid-template-columns: repeat(auto-fill, minmax(184px, 1fr));
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
