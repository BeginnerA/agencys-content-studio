<script setup lang="ts">
import AssetPreviewer from '../../components/asset/previewer/index.vue'
import CreationCandidates from './CreationCandidates.vue'
import CreationRework from './CreationRework.vue'
import Icon from '../../components/common/Icon.vue'
import SubtitleReworkEntry from '../../components/run/subtitle-rework/SubtitleReworkEntry.vue'
import type { useEasyCreate } from './use-creation-chat'
import { useCreationArtifacts } from './use-creation-artifacts'

/**
 * 成果墙：缩略图优先的逐镜盘点 + 候选版本选择 + 本地重新合成入口 + 局部返修入口。
 * 卡片主体=画面缩略图（点开预览），视频/配音/候选收进卡底图标快捷键，台词做两行遮罩，长列表靠筛选 chips 定位。
 * 候选块只在「run 已收敛」且「该镜该模态有 >1 个可用候选」时出现：制作中不展示，避免对着半成品选版本。
 * 选片零计费、不改成片（只写在用指针），因此必须再走一次本地重新合成才落到成片 —— 由 selectionDirty 驱动提示。
 * 返修入口同样只给已收敛的 run（解析要先花一次文本模型费用，制作中不给出计费出口）。
 * 脚本逻辑另拆 use-creation-artifacts.ts（[M26-split]，行为零变更）。
 */
const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

const {
  artifacts,
  preview,
  loading,
  error,
  brokenThumbs,
  FILTERS,
  filter,
  stats,
  shownShots,
  imageStep,
  hasFilm,
  filmRunId,
  subBurn,
  recomposing,
  expanded,
  pending,
  boards,
  boardError,
  keyOf,
  selected,
  shotActions,
  shotHasReused,
  placeholderText,
  markBroken,
  open,
  toggleCandidates,
  pickCandidate,
  applyCandidate,
  onRecompose,
} = useCreationArtifacts(props.s)
</script>

<template>
  <section
    v-if="s.state.detail?.progress"
    class="panel ec-artifacts"
    aria-label="已有成果"
  >
    <header class="ec-art-head">
      <div class="ec-art-title">
        <h2>已有成果</h2>
        <p class="ec-art-stats muted">
          {{ stats.n }} 镜 · {{ stats.voices }} 配音 · {{ stats.docs }} 文档
          <template v-if="stats.reused"> · {{ stats.reused }} 复用</template>
          <template v-if="stats.unavailable">
            <span class="ec-art-warn"> · {{ stats.unavailable }} 不可用</span>
          </template>
        </p>
      </div>
      <div class="ec-art-ops">
        <button
          v-if="s.rework.canUse.value && !s.rework.state.open"
          class="btn sm"
          type="button"
          aria-controls="ec-rework"
          @click="s.rework.toggle()"
        >
          <Icon name="pencil" :size="13" /> 局部返修
        </button>
        <label
          v-if="hasFilm"
          class="ec-art-sub"
          :title="subBurn ? '成片烧录硬字幕；取消后下次重新合成成片不含字幕' : '已关闭：重新合成后成片不含字幕（字幕文件仍生成可下载）'"
        >
          <input type="checkbox" :checked="subBurn" :disabled="s.state.busyAction" aria-label="在成片烧录字幕" @change="subBurn = ($event.target as HTMLInputElement).checked" />
          <span><Icon name="doc" :size="13" /> 成片字幕</span>
        </label>
        <!-- 字幕精确返修：与其他三入口同一编辑器与确认流（本地修订、零模型计费） -->
        <SubtitleReworkEntry
          v-if="hasFilm && filmRunId"
          :run-id="filmRunId!"
          :disabled="s.state.busyAction"
          @applied="s.refreshStatus()"
        />
        <button
          v-if="s.state.selectionDirty || hasFilm"
          class="btn sm primary"
          type="button"
          :disabled="s.state.busyAction"
          @click="onRecompose"
        >
          <Icon name="refresh" :size="13" /> 重新合成
        </button>
      </div>
    </header>

    <div v-if="s.state.selectionDirty" class="ec-art-banner">
      <span class="badge queued">已改选版本 · 待重新合成落到成片</span>
      <button
        class="ec-art-more"
        type="button"
        :aria-expanded="recomposing"
        @click="recomposing = !recomposing"
      >
        {{ recomposing ? '收起说明' : '会再花钱吗？' }}
      </button>
      <p v-if="recomposing" class="muted">
        不会。重新合成只在本地把现有画面/视频素材拼成新成片，不调用任何付费生成模型。
      </p>
    </div>

    <CreationRework v-if="s.rework.canUse.value" :s="s" />

    <div
      v-if="stats.n"
      class="ec-art-filters"
      role="group"
      aria-label="成果筛选"
    >
      <button
        v-for="f in FILTERS"
        :key="f.key"
        class="ec-art-chip"
        :class="{ on: filter === f.key }"
        type="button"
        :aria-pressed="filter === f.key"
        @click="filter = f.key"
      >
        {{ f.label
        }}<template v-if="f.key === 'reused' && stats.reused">
          {{ stats.reused }}</template
        ><template v-else-if="f.key === 'unavailable' && stats.unavailable">
          {{ stats.unavailable }}</template
        >
      </button>
      <span class="ec-art-hint muted"
        >缩略图点开预览 · 卡片右下角选版本与配音</span
      >
    </div>

    <p
      v-if="!artifacts?.shots.length && !artifacts?.documents.length"
      class="ec-art-empty muted"
    >
      <Icon name="photo" :size="22" />
      暂无可核实的成果。素材生成后会自动显示在这里，恢复制作时会继续复用可用成果。
    </p>
    <p v-else-if="!shownShots.length" class="ec-art-empty muted">
      没有命中该筛选的镜头。
    </p>
    <p v-if="error" role="alert" class="err-text">{{ error }}</p>

    <ul v-if="shownShots.length" class="ec-art-grid">
      <li v-for="shot in shownShots" :key="shot.shotId" class="ec-art-shot">
        <div class="ec-art-card">
          <button
            v-if="shotActions(shot).image"
            class="ec-art-thumb"
            type="button"
            :disabled="loading !== null"
            :aria-label="`预览第 ${shot.index} 镜画面`"
            @click="open(shotActions(shot).image!)"
          >
            <img
              v-if="!brokenThumbs.has(shotActions(shot).image!.assetId)"
              :src="`/api/v1/assets/${shotActions(shot).image!.assetId}/thumb?v=2`"
              :alt="`第 ${shot.index} 镜画面`"
              loading="lazy"
              @error="markBroken(shotActions(shot).image!.assetId)"
            />
            <span v-else class="ec-art-ph-text"
              >缩略图暂不可用，点击查看原图</span
            >
            <span class="ec-art-no"
              >第 {{ shot.index }} 镜 · {{ shot.duration }}s</span
            >
            <span v-if="shotHasReused(shot)" class="ec-art-reuse">复用</span>
            <span class="ec-art-zoom" aria-hidden="true"
              ><Icon name="zoom-in" :size="15"
            /></span>
          </button>
          <div
            v-else
            class="ec-art-thumb ec-art-missing"
            :class="{ bad: placeholderText(shot) === '素材文件不可用' }"
          >
            <span>{{ placeholderText(shot) }}</span>
            <span class="ec-art-no"
              >第 {{ shot.index }} 镜 · {{ shot.duration }}s</span
            >
          </div>
          <p v-if="shot.text" class="ec-art-text muted" :title="shot.text">
            {{ shot.text }}
          </p>
          <div class="ec-art-foot">
            <span v-if="!shot.text" class="ec-art-notext muted">无台词</span>
            <span class="ec-art-acts">
              <button
                v-if="shotActions(shot).video"
                class="ec-art-act"
                :class="{ on: shotActions(shot).video!.available }"
                type="button"
                :disabled="
                  !shotActions(shot).video!.available || loading !== null
                "
                :aria-label="
                  shotActions(shot).video!.available
                    ? `预览第 ${shot.index} 镜视频`
                    : `第 ${shot.index} 镜视频素材不可用`
                "
                @click="open(shotActions(shot).video!)"
              >
                <Icon name="play" :size="13" />
              </button>
              <button
                v-for="(voice, i) in shotActions(shot).voices"
                :key="voice.assetId"
                class="ec-art-act"
                :class="{ on: voice.available }"
                type="button"
                :disabled="!voice.available || loading !== null"
                :aria-label="`试听第 ${shot.index} 镜配音${shotActions(shot).voices.length > 1 ? ` ${i + 1}` : ''}`"
                @click="open(voice)"
              >
                <Icon name="speaker-wave" :size="13" />
              </button>
              <button
                v-if="shotActions(shot).imageCands.length"
                class="ec-art-act"
                :class="{ on: expanded.has(keyOf(imageStep, shot.shotId)) }"
                type="button"
                :aria-expanded="expanded.has(keyOf(imageStep, shot.shotId))"
                :aria-label="`第 ${shot.index} 镜画面候选 ${shotActions(shot).imageCands.length} 版`"
                @click="toggleCandidates(imageStep, shot.shotId)"
              >
                <Icon name="layers" :size="13" />
                {{ shotActions(shot).imageCands.length }}
              </button>
              <button
                v-if="shotActions(shot).videoCands.length"
                class="ec-art-act"
                :class="{ on: expanded.has(keyOf('motion', shot.shotId)) }"
                type="button"
                :aria-expanded="expanded.has(keyOf('motion', shot.shotId))"
                :aria-label="`第 ${shot.index} 镜视频候选 ${shotActions(shot).videoCands.length} 版`"
                @click="toggleCandidates('motion', shot.shotId)"
              >
                <Icon name="film" :size="13" />
                {{ shotActions(shot).videoCands.length }}
              </button>
            </span>
          </div>
        </div>
        <div
          v-if="
            shotActions(shot).imageCands.length &&
            expanded.has(keyOf(imageStep, shot.shotId))
          "
          class="ec-art-cand"
        >
          <CreationCandidates
            :index="shot.index"
            :shot-id="shot.shotId"
            label="画面"
            :candidates="shot.image.candidates"
            :selected-id="selected(shot.image)?.assetId ?? null"
            :pending="pending[keyOf(imageStep, shot.shotId)] ?? null"
            :busy="s.state.busyAction"
            :board="boards[imageStep] ?? null"
            @pick="pickCandidate(imageStep, shot.shotId, $event)"
            @apply="applyCandidate(imageStep, shot.shotId)"
            @cancel="pending[keyOf(imageStep, shot.shotId)] = null"
          />
          <p v-if="boardError[imageStep]" role="alert" class="err-text">
            {{ boardError[imageStep] }}
          </p>
        </div>
        <div
          v-if="
            shotActions(shot).videoCands.length &&
            expanded.has(keyOf('motion', shot.shotId))
          "
          class="ec-art-cand"
        >
          <CreationCandidates
            :index="shot.index"
            :shot-id="shot.shotId"
            label="视频"
            :candidates="shot.video.candidates"
            :selected-id="selected(shot.video)?.assetId ?? null"
            :pending="pending[keyOf('motion', shot.shotId)] ?? null"
            :busy="s.state.busyAction"
            :board="boards.motion ?? null"
            @pick="pickCandidate('motion', shot.shotId, $event)"
            @apply="applyCandidate('motion', shot.shotId)"
            @cancel="pending[keyOf('motion', shot.shotId)] = null"
          />
          <p v-if="boardError.motion" role="alert" class="err-text">
            {{ boardError.motion }}
          </p>
        </div>
      </li>
    </ul>

    <div v-if="artifacts?.documents.length" class="ec-art-docs">
      <h3>字幕与批准文本</h3>
      <div class="ec-art-doc-list">
        <button
          v-for="doc in artifacts.documents"
          :key="`${doc.label}-${doc.assetId}`"
          class="ec-art-doc"
          type="button"
          :disabled="!doc.available || loading !== null"
          @click="open(doc)"
        >
          <Icon name="doc" :size="14" />
          <span>{{ doc.label }}</span>
          <span v-if="doc.reused" class="ec-art-reuse inline">复用</span>
          <span v-if="!doc.available" class="ec-art-doc-bad">不可用</span>
        </button>
      </div>
    </div>

    <p v-if="loading !== null" role="status">正在加载预览…</p>
    <AssetPreviewer
      v-if="preview"
      :assets="[preview]"
      :index="0"
      @close="preview = null"
    />
  </section>
</template>

<style scoped>
/* ===== 面板骨架 ===== */
.ec-artifacts {
  padding: 14px 16px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ec-art-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.ec-art-title {
  min-width: 0;
}
.ec-art-head h2 {
  font-size: 15px;
  margin: 0 0 3px;
}
.ec-art-stats {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.ec-art-warn {
  color: var(--warn);
}
.ec-art-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
/* 局部返修/重新合成按钮尺寸由全局 .btn 管（桌面紧凑 / 触屏兜底） */
/* 成片字幕开关：与同排按钮对齐；整行可点（命中区≥个 44px），不依赖文字大小 */
.ec-art-sub {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 0 8px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.ec-art-sub input {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
  cursor: pointer;
}

/* 改选待合成提示条 */
.ec-art-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid rgb(99 102 241 / 34%);
  border-radius: 9px;
  background: var(--accent-weak);
}
.ec-art-banner .muted {
  width: 100%;
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
.ec-art-more {
  border: 0;
  background: none;
  color: var(--text-3);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
  min-height: 44px;
}

/* 筛选 chips */
.ec-art-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ec-art-chip {
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s,
    background 0.15s;
}
.ec-art-chip:hover {
  border-color: var(--accent);
  color: var(--text);
}
.ec-art-chip.on {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: #a5b4fc;
  font-weight: 600;
}
.ec-art-hint {
  margin-left: auto;
  font-size: 11.5px;
}

.ec-art-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 22px 12px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  font-size: 12.5px;
  line-height: 1.7;
  text-align: center;
}
.ec-art-empty .ic {
  color: var(--text-3);
}

/* ===== 成果栅格：li 参与 grid，展开的候选块通栏 ===== */
.ec-art-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 10px;
}
.ec-art-shot {
  display: contents;
}

.ec-art-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel-2);
  transition: border-color 0.15s;
}
.ec-art-card:hover {
  border-color: var(--border-strong);
}

/* 缩略图主体 */
.ec-art-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  padding: 0;
  border: 0;
  overflow: hidden;
  background: var(--img-ph, var(--panel));
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
}
button.ec-art-thumb {
  cursor: pointer;
}
.ec-art-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ec-art-thumb::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    rgb(9 9 11 / 45%),
    transparent 34%,
    transparent 62%,
    rgb(9 9 11 / 45%)
  );
  opacity: 0.9;
  transition: opacity 0.15s;
  pointer-events: none;
}
button.ec-art-thumb:hover::after {
  opacity: 1;
}
.ec-art-ph-text {
  position: relative;
  z-index: 1;
  padding: 0 10px;
  font-size: 11.5px;
  line-height: 1.5;
  text-align: center;
}
.ec-art-missing {
  border-bottom: 1px solid var(--border);
  text-align: center;
}
.ec-art-missing > span:first-child {
  position: relative;
  z-index: 1;
  padding: 0 10px;
  font-size: 12px;
}
.ec-art-missing.bad {
  color: var(--warn);
}
.ec-art-no {
  position: absolute;
  left: 8px;
  top: 7px;
  z-index: 1;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  background: rgb(9 9 11 / 72%);
  color: #fff;
}
.ec-art-reuse {
  position: absolute;
  right: 8px;
  top: 7px;
  z-index: 1;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  background: var(--accent);
  color: #fff;
}
.ec-art-reuse.inline {
  position: static;
}
.ec-art-zoom {
  position: absolute;
  right: 8px;
  bottom: 7px;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid rgb(255 255 255 / 25%);
  border-radius: 8px;
  color: #fff;
  background: rgb(9 9 11 / 55%);
  opacity: 0;
  transition: opacity 0.15s;
}
button.ec-art-thumb:hover .ec-art-zoom,
button.ec-art-thumb:focus-visible .ec-art-zoom {
  opacity: 1;
}

/* 台词遮罩与卡底动作条 */
.ec-art-text {
  margin: 0;
  padding: 7px 9px 0;
  font-size: 11.5px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.ec-art-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 7px 6px;
  min-height: 34px;
}
.ec-art-notext {
  font-size: 11px;
}
.ec-art-acts {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
}
.ec-art-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 30px;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text-3);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s,
    background 0.15s;
}
.ec-art-act.on {
  color: var(--text-2);
}
.ec-art-act.on:hover:not(:disabled) {
  border-color: var(--accent);
  color: #a5b4fc;
  background: var(--accent-weak);
}
.ec-art-act.on[aria-expanded='true'],
.ec-art-act.on[aria-pressed='true'] {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: #a5b4fc;
}
.ec-art-act:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 展开的候选块：通栏放在所属卡片下一行 */
.ec-art-cand {
  grid-column: 1 / -1;
  margin-top: -2px;
  padding: 10px 12px;
  border: 1px solid rgb(99 102 241 / 34%);
  border-radius: 12px;
  background: var(--panel);
  animation: ec-art-in 0.18s ease-out;
}
.ec-art-cand .err-text {
  margin: 6px 0 0;
}
@keyframes ec-art-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ec-art-cand {
    animation: none;
  }
  .ec-art-thumb::after,
  .ec-art-zoom {
    transition: none;
  }
}

/* ===== 文档区 ===== */
.ec-art-docs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ec-art-docs h3 {
  font-size: 13px;
  margin: 0;
}
.ec-art-doc-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ec-art-doc {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  color: var(--text-2);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s,
    background 0.15s;
}
.ec-art-doc:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
  background: var(--accent-weak);
}
.ec-art-doc .ic {
  color: var(--accent-h);
  flex: none;
}
.ec-art-doc:disabled {
  opacity: 0.55;
  cursor: default;
}
.ec-art-doc-bad {
  font-size: 11px;
  color: var(--warn);
}

.ec-artifacts :is(button):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 600px) {
  /* 窄屏保证两列：minmax 用 min() 收窄下限，候选缩略图保持三列 */
  .ec-art-grid {
    grid-template-columns: repeat(auto-fill, minmax(min(132px, 100%), 1fr));
  }
  .ec-art-hint {
    display: none;
  }
}
</style>
