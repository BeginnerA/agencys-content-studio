<script setup lang="ts">
import AspectDeriveModal from '../../components/run/AspectDeriveModal.vue'
import GateDialog from '../../components/run/GateDialog.vue'
import TaskPanel from '../../components/run/TaskPanel.vue'
import AssetPreviewer from '../../components/asset/previewer/index.vue'
import Icon from '../../components/common/Icon.vue'
import ExportWizardModal from '../../components/run/ExportWizardModal.vue'
import PublishModal from '../../components/run/PublishModal.vue'
import RunFormModal from '../../components/run/RunFormModal.vue'
import RerunModal from '../../components/run/RerunModal.vue'
import { fmtMs, runStatus } from '../../lib/format'
import RunTimeline from './RunTimeline.vue'
import RunLogPanel from './RunLogPanel.vue'
import RunCostPanel from './RunCostPanel.vue'
import RunExportsPanel from './RunExportsPanel.vue'
import RunPubsPanel from './RunPubsPanel.vue'
import { useRunDetail } from './use-run-detail'
import { useRunExtras } from './use-run-extras'

const u = useRunDetail({
  loadBadges: () => e.loadBadges(),
  loadExtras: (projectId) => e.loadExtras(projectId),
  refreshExtras: () => e.refreshExtras(),
  loadTplMetas: () => e.loadTplMetas(),
})
const e = useRunExtras({ runId: u.runId, detail: u.detail, run: u.run, steps: u.steps, err: u.err })
const { router, runId, err, busy, gateStep, gateMessage, gateText, gateTextName, showLog, run, canCancel, canResume, hasTasks, active, gateSkipLabel, parallelHint, snapshot, snapshotTip, loadDetail, toggleLog, decide, cancelRun, resumeRun, previewAssets, previewOpen, previewStart, rerunStep, notice, onRerunDone } = u
const { showRelay, relayTplKey, tplName, nextOptions, openRelay, onRelayDone, showExport, showPublish, runAssets, publishCandidate, deriveOpen, onDerived, onExportDone, onPubSaved } = e
</script>

<template>
  <div>
    <div class="page-h">
      <RouterLink :to="`/projects/${run?.projectId ?? ''}`" class="back">
        <Icon name="arrow-left" :size="14" /> 项目
      </RouterLink>
      <h1>Run #{{ runId }}</h1>
      <span v-if="run" class="badge" :class="run.status">{{ runStatus(run.status).text }}</span>
      <span v-if="run" class="sub">{{ tplName(run.templateKey) }}</span>
      <span v-if="snapshot" class="badge skip" :title="snapshotTip(snapshot)">快照 v{{ snapshot.rv }}</span>
      <span v-if="run?.summary?.durationMs" class="sub muted">{{ fmtMs(run.summary.durationMs) }}</span>
      <div style="margin-left: auto; display: flex; gap: 8px">
        <button class="btn" title="在流水线画布中查看（节点状态 / 闸门 / 任务 / 产物，可就地操作）" @click="router.push(`/canvas?run=${runId}`)">
          <Icon name="flow" :size="14" /> 画布视图
        </button>
        <button v-if="canCancel" class="btn danger" :disabled="busy" @click="cancelRun">取消运行</button>
        <button v-if="canResume" class="btn primary" :disabled="busy" @click="resumeRun">
          <Icon name="refresh" :size="14" /> 断点续跑
        </button>
        <button class="btn" :disabled="!runAssets.length" title="选择产物打包下载" @click="showExport = true">
          <Icon name="download" :size="14" /> 导出发布包
        </button>
        <button class="btn" @click="toggleLog">
          <Icon :name="showLog ? 'x' : 'doc'" :size="14" /> {{ showLog ? '隐藏日志' : '运行日志' }}
        </button>
      </div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="notice" class="notice-box"><Icon name="check" :size="12" /> {{ notice }}</div>
    <div v-if="!run" class="empty">{{ err || '加载中…' }}</div>

    <template v-if="run">
      <div v-if="run.error" class="errbox">{{ run.error }}</div>

      <!-- 完成态「下一步建议」：模板 next 声明的下游模板，点击一键接力 -->
      <div v-if="nextOptions.length" class="nextbar panel">
        <span class="nb-t"><Icon name="sparkles" :size="13" /> 下一步建议</span>
        <button v-for="t in nextOptions" :key="t.key" type="button" class="nb-chip" @click="openRelay(t.key)">
          去「{{ t.name }}」<Icon name="chevron-right" :size="11" :stroke-width="2.2" />
        </button>
      </div>

      <!-- 闸门审阅 -->
      <div v-if="parallelHint && !gateStep" class="phint">
        <Icon name="refresh" :size="13" /> {{ parallelHint }}（引擎并发上限 2）
      </div>
      <GateDialog
        v-if="gateStep"
        :step-title="gateStep.title"
        :message="gateMessage"
        :artifact-text="gateText || undefined"
        :artifact-name="gateTextName"
        :skip-label="gateSkipLabel"
        :busy="busy"
        @decided="decide"
      />

      <div class="cols">
        <!-- 步骤时间线 -->
        <RunTimeline :u="u" :e="e" />

        <!-- 右栏：日志 + 任务 -->
        <div class="right">
          <RunLogPanel :u="u" />

          <TaskPanel v-if="hasTasks" :run-id="runId" :active="active" class="tpanel-wrap" @changed="loadDetail()" />

          <RunCostPanel :e="e" />

          <RunExportsPanel :e="e" />

          <RunPubsPanel :e="e" />
        </div>
      </div>
    </template>

    <!-- [M4] 单 run 导出向导 / 标记发布 -->
    <ExportWizardModal v-if="showExport" :run-id="runId" @done="onExportDone" @close="showExport = false" />
    <!-- [M19] 成片多画幅派生（A 路径） -->
    <AspectDeriveModal
      v-if="deriveOpen"
      :run-id="runId"
      :project-id="run?.projectId ?? 0"
      :run-assets="runAssets"
      @changed="onDerived"
      @close="deriveOpen = false"
    />
    <PublishModal
      v-if="showPublish"
      :project-id="run?.projectId ?? 0"
      :run-id="runId"
      :asset-options="runAssets.map((a) => ({ id: a.id, name: a.name }))"
      :default-asset-id="publishCandidate"
      @done="onPubSaved"
      @close="showPublish = false"
    />

    <!-- [M11] 单步重跑弹窗 -->
    <RerunModal
      v-if="rerunStep"
      :run-id="runId"
      :step="rerunStep"
      @close="rerunStep = null"
      @done="onRerunDone"
    />

    <!-- 完成态接力：以推荐模板直达启动表单（initialTemplateKey 命中直接进表单段） -->
    <RunFormModal
      v-if="showRelay && run"
      :project-id="run.projectId"
      :initial-template-key="relayTplKey"
      @done="onRelayDone"
      @close="showRelay = false"
    />

    <!-- 产物统一预览 -->
    <AssetPreviewer v-if="previewOpen" :assets="previewAssets" :index="previewStart" @close="previewOpen = false" />
  </div>
</template>

<style scoped>
.errbox {
  background: var(--bad-weak);
  color: var(--bad);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  margin-bottom: 14px;
  word-break: break-all;
}

/* [M2] 并行执行提示条 */
.phint {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--run);
  background: var(--run-weak);
  border: 1px solid rgb(129 140 248 / 22%);
  border-radius: 8px;
  padding: 6px 12px;
  margin-bottom: 12px;
}

/* [M2] 并行执行提示条 */
.phint {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--run);
  background: var(--run-weak);
  border: 1px solid rgb(129 140 248 / 22%);
  border-radius: 8px;
  padding: 6px 12px;
  margin-bottom: 12px;
}

/* 完成态「下一步建议」接力条（模板元数据 next 声明） */
.nextbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
}

.nb-t {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}

.nb-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid rgb(99 102 241 / 26%);
  background: var(--accent-weak);
  color: var(--accent);
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.nb-chip:hover {
  border-color: rgb(99 102 241 / 45%);
  background: rgb(99 102 241 / 24%);
}

.cols {
  display: grid;
  /* minmax(0,…)：避免右栏任务长 prompt（nowrap）经 auto min 撑破轨道致整页横滚（M11 实弹修复） */
  grid-template-columns: minmax(0, 1fr) 400px;
  gap: 16px;
  align-items: start;
}

.right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: sticky;
  top: 16px;
}

.notice-box {
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--ok-weak);
  color: var(--ok);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12.5px;
  margin-bottom: 12px;
  word-break: break-all;
}

.tpanel-wrap {
  max-height: 360px;
  overflow-y: auto;
}

@media (max-width: 1080px) {
  .cols {
    grid-template-columns: minmax(0, 1fr);
  }

  .right {
    position: static;
  }
}
</style>
