<script setup lang="ts">
import {
  nodeClass,
  skipInfo,
  assetIds,
  inputPretty,
  outputPretty,
  iconOf,
} from './internals'
import ShotBoard from '../../components/shot/board/index.vue'
import NovelBoard from '../../components/NovelBoard.vue'
import Icon from '../../components/common/Icon.vue'
import SubtitleBurnToggle from '../../components/run/SubtitleBurnToggle.vue'
import { fmtTime, stepStatus } from '../../lib/format'
import {
  EDIT_EX_FORMATS,
  editExEnabled,
  editExTitle,
} from '../../lib/edit-exchange'
import type { RunDetailApi } from './use-run-detail'
import type { ExtrasApi } from './use-run-extras'
import type { RunStep } from '../../lib/types'
const props = defineProps<{ s: RunStep; u: RunDetailApi; e: ExtrasApi }>()
const {
  runId,
  busy,
  run,
  active,
  loadDetail,
  previewBusy,
  openAssetPreview,
  WB_ACTIONS,
  composeInfo,
  onComposeInfo,
  recomposeStep,
  canRerunStep,
  canCascadeStep,
  openRerun,
} = props.u
const {
  badges,
  deriveOpen,
  hasFinalVideo,
  editExFormats,
  editExBusy,
  exportEditExchange,
} = props.e
</script>

<template>
  <div class="st" :class="[nodeClass(s), { dim: s.status === 'pending' }]">
    <div class="rail">
      <div class="dot"><Icon :name="iconOf(s.actionKey)" :size="14" /></div>
      <div class="line" />
    </div>
    <div class="card">
      <div class="head">
        <span class="tt">{{ s.title }}</span>
        <span
          class="badge"
          :class="s.status === 'waiting_input' ? 'waiting_input' : s.status"
        >
          {{ stepStatus(s.status).text }}
        </span>
        <span
          v-if="skipInfo(s)"
          class="badge skip"
          :class="{ ghost: !skipInfo(s)?.userSkip }"
        >
          {{ skipInfo(s)?.text }}
        </span>
        <span class="muted mono" style="font-size: 11px">{{
          s.actionKey
        }}</span>
        <span v-if="badges[s.id]" class="badge mem">{{ badges[s.id] }}</span>
      </div>
      <div v-if="skipInfo(s)?.userSkip" class="skipnote muted">
        免审放行：产物已保留，下游正常执行
      </div>
      <div v-if="s.error" class="serr mono">{{ s.error }}</div>
      <div class="meta muted">
        第 {{ s.seq + 1 }} 步 · 尝试 {{ s.attempts }}
        <template v-if="s.startedAt"> · {{ fmtTime(s.startedAt) }}</template>
        <template v-if="s.completedAt">
          → {{ fmtTime(s.completedAt) }}</template
        >
      </div>

      <!-- 镜头级轻工作台（ai_image / ai_video 步骤卡内嵌） -->
      <ShotBoard
        v-if="WB_ACTIONS.has(s.actionKey)"
        :run-id="runId"
        :project-id="run?.projectId ?? 0"
        :step="s"
        :active="active"
        @changed="loadDetail()"
        @compose="onComposeInfo"
      />

      <!-- 小说改编看板（text_split 步骤卡内嵌，只读） -->
      <NovelBoard
        v-if="s.actionKey === 'text_split'"
        :run-id="runId"
        :step="s"
      />

      <!-- 合成步骤：重新合成 + stale 徽标（数据来自工作台上抛） -->
      <div v-if="s.actionKey === 'ffmpeg_merge'" class="compose-ops">
        <span
          v-if="composeInfo?.stale === true"
          class="badge warn-c"
          title="镜头选择 / 分镜 / 时长有更新，重新合成后生效"
        >
          待重新合成
        </span>
        <span
          v-else-if="composeInfo?.stale === false"
          class="badge ok-c"
          title="成片与当前选择一致"
        >
          合成已最新
        </span>
        <button
          class="btn sm"
          :disabled="busy || active"
          @click="recomposeStep(s)"
        >
          <Icon name="film" :size="12" /> 重新合成
        </button>
        <!-- 成片字幕开关（与轻松创作同一 _compose 真源）：改后点「重新合成」方落入成片 -->
        <SubtitleBurnToggle :run-id="runId" :disabled="busy || active" />
        <!-- A 路径：对已有成片二次派生其他发布画幅 -->
        <button
          class="btn sm"
          :disabled="busy || active || !hasFinalVideo"
          :title="
            hasFinalVideo
              ? '从成片再编码一份 9:16 / 1:1 / 4:5 / 16:9 产物（不动原片）'
              : '尚未合成成片，无法派生'
          "
          @click="deriveOpen = true"
        >
          <Icon name="crop" :size="12" /> 派生画幅
        </button>
      </div>

      <!-- 剪辑工程交换导出：成片导出为多轨工程（FCPXML/EDL/OTIO）继续专业精剪 -->
      <div
        v-if="s.actionKey === 'ffmpeg_merge' && editExFormats?.final_video"
        class="editex-ops"
      >
        <span class="editex-lab muted">导出剪辑工程</span>
        <button
          v-for="f in EDIT_EX_FORMATS"
          :key="f.key"
          class="btn sm"
          :aria-busy="editExBusy"
          :disabled="busy || active || editExBusy || !editExEnabled(editExFormats, f.key)"
          :title="editExTitle(editExFormats, f.key, editExBusy)"
          @click="exportEditExchange(f.key)"
        >
          <Icon name="cube" :size="12" /> {{ f.label }}
        </button>
      </div>

      <!-- 重跑（单步或级联任一可用即展示；弹窗内再细分范围，真实门禁以服务端为准） -->
      <div v-if="canRerunStep(s) || canCascadeStep(s)" class="rerun-ops">
        <button
          class="btn sm"
          :disabled="busy"
          title="重跑该步骤：可仅本步（复用/全量）或级联到末尾（下游按新产物依次重做）"
          @click="openRerun(s)"
        >
          <Icon name="refresh" :size="12" /> 重跑…
        </button>
      </div>

      <details v-if="s.output && assetIds(s).length" class="prods">
        <summary>产物（{{ assetIds(s).length }} 项）</summary>
        <div class="links">
          <button
            v-for="aid in assetIds(s)"
            :key="aid"
            class="prod"
            :disabled="previewBusy !== null"
            :title="previewBusy === aid ? '正在载入资产…' : '内联预览资产'"
            @click="openAssetPreview(assetIds(s), aid)"
          >
            <Icon name="eye" :size="11" />
            {{ previewBusy === aid ? '载入中…' : `资产 #${aid}` }}
          </button>
        </div>
      </details>
      <details class="raw">
        <summary>输入 / 输出快照</summary>
        <pre>{{ inputPretty(s) }}</pre>
        <pre v-if="s.output">{{ outputPretty(s) }}</pre>
      </details>
    </div>
  </div>
</template>

<style scoped>
.skipnote {
  font-size: 11.5px;
  margin-top: 6px;
}

.skipnote {
  font-size: 11.5px;
  margin-top: 6px;
}

.card {
  flex: 1;
  padding: 10px 4px 14px;
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tt {
  font-weight: 600;
  font-size: 14px;
}

.serr {
  margin-top: 8px;
  background: var(--bad-weak);
  color: var(--bad);
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.meta {
  font-size: 11.5px;
  margin-top: 4px;
}

.prods {
  margin-top: 6px;
  font-size: 12.5px;
}

.prods summary,
.raw summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 12px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 5px;
}

.prod {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  background: var(--accent-weak);
  border: 1px solid transparent;
  color: var(--accent-h);
  padding: 2px 9px;
  border-radius: 999px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.prod:hover {
  border-color: rgb(99 102 241 / 45%);
  color: #fff;
}

.prod:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.raw {
  margin-top: 5px;
}

.raw pre {
  background: var(--code-bg);
  color: #b9c7dc;
  font-size: 11px;
  border-radius: 8px;
  border: 1px solid var(--border);
  padding: 8px 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 4px 0 0;
}

/* 记忆/角色徽标：品牌靛蓝，与状态徽标区分 */
.badge.mem {
  background: var(--accent-weak);
  color: var(--accent);
  border-color: rgb(99 102 241 / 26%);
}

/* 合成步骤操作行：重新合成 + stale 徽标 */
.compose-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

/* 剪辑工程交换导出行：标签 + 三格式按钮（窄屏自动换行） */
.editex-ops {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.editex-lab {
  font-size: 12px;
}

/* 单步重跑按钮行 + 成功 notice */
.rerun-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.badge.warn-c {
  background: var(--warn-weak);
  color: var(--warn);
  border-color: rgb(245 158 11 / 24%);
}

.badge.ok-c {
  background: var(--ok-weak);
  color: var(--ok);
  border-color: rgb(34 197 94 / 22%);
}
</style>
