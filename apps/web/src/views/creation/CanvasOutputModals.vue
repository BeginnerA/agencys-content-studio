<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import Modal from '../../components/common/Modal.vue'
import RunFormModal from '../../components/run/RunFormModal.vue'
import { exportApi } from '../../lib/api'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{ cv: Pick<CanvasViewState,
  | 'showRun'
  | 'activeProjectId'
  | 'runPrefillInput'
  | 'onRunStarted'
  | 'showDraft'
  | 'draftValidation'
  | 'draftLossy'
  | 'draftYaml'
  | 'copyDraft'
  | 'draftTryBusy'
  | 'tryRunFromDraft'
  | 'showExport'
  | 'exportResult'
> }>()
const cv = props.cv
</script>

<template>
    <!-- 送去运行（模板表单；产物预填 setting_docs） -->
    <RunFormModal
      v-if="cv.showRun && cv.activeProjectId"
      :project-id="cv.activeProjectId"
      :prefill-input="cv.runPrefillInput"
      @done="cv.onRunStarted"
      @close="cv.showRun = false"
    />

    <!-- 模板草案 v2 -->
    <Modal v-if="cv.showDraft" title="模板草案 v2（literal + 主步骤 + lossy）" :width="780" @close="cv.showDraft = false">
      <div class="draft-body">
        <div class="draft-meta">
          <span v-if="cv.draftValidation" class="badge" :class="cv.draftValidation.ok ? 'succeeded' : 'failed'">
            {{ cv.draftValidation.ok ? '校验通过' : '校验未通过' }}
          </span>
          <span class="muted mini">仅供人工整理为正式模板（workspace/templates）；不落盘。「试跑」将自动保存为 `<画布名>-try` 并建 queued run。</span>
        </div>
        <ul v-if="cv.draftValidation && cv.draftValidation.errors.length" class="prob">
          <li v-for="(e2, i) in cv.draftValidation.errors" :key="i">{{ e2 }}</li>
        </ul>
        <ul v-if="cv.draftValidation && cv.draftValidation.warnings.length" class="warnlist">
          <li v-for="(w, i) in cv.draftValidation.warnings" :key="i">{{ w }}</li>
        </ul>
        <div v-if="cv.draftLossy.length" class="lossy">
          <div class="lossy-head">降级清单（{{ cv.draftLossy.length }}）：</div>
          <ul>
            <li v-for="(s, i) in cv.draftLossy" :key="i">{{ s }}</li>
          </ul>
        </div>
        <pre class="yaml mono">{{ cv.draftYaml }}</pre>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="cv.showDraft = false">关闭</button>
        <button type="button" class="btn" @click="cv.copyDraft">
          <Icon name="copy" :size="12" /> 复制 YAML
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="!cv.draftValidation?.ok || cv.draftTryBusy"
          :title="cv.draftValidation?.ok ? '保存为模板并建 run（queued）' : '校验未通过无法试跑'"
          @click="cv.tryRunFromDraft"
        >
          <Icon name="play" :size="12" /> {{ cv.draftTryBusy ? '试跑中…' : '试跑' }}
        </button>
      </template>
    </Modal>

    <!-- [M17] 导出画布产物 zip -->
    <Modal v-if="cv.showExport && cv.exportResult" title="导出画布产物" :width="560" @close="cv.showExport = false">
      <div class="exp-meta">
        <div class="em-row"><span class="em-k">打包</span><span class="em-v">{{ cv.exportResult.stats.packed }} 个产物</span></div>
        <div class="em-row"><span class="em-k">跳过</span><span class="em-v">{{ cv.exportResult.stats.skipped }} 个（缺失产物 / 不打包类型）</span></div>
        <div class="em-row"><span class="em-k">文件</span><span class="em-v mono">{{ cv.exportResult.asset.name }}</span></div>
      </div>
      <div class="muted mini">zip 内含 manifest.json 与按序号命名的产物（seq-title-assetId.ext）；下载后可直接解包核对。</div>
      <template #footer>
        <button type="button" class="btn" @click="cv.showExport = false">关闭</button>
        <a class="btn primary" :href="exportApi.fileUrl(cv.exportResult.asset.id, true)">
          <Icon name="download" :size="12" /> 下载 zip
        </a>
      </template>
    </Modal>

</template>

<style scoped>
.mini {
  font-size: 11px;
}

.draft-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.draft-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prob {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--bad);
  line-height: 1.7;
}

.warnlist {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--warn);
  line-height: 1.7;
}

.lossy {
  border: 1px dashed var(--warn);
  border-radius: 8px;
  padding: 6px 10px;
  background: rgba(255, 176, 32, 0.06);
  font-size: 12px;
  line-height: 1.7;
}

.lossy-head {
  color: var(--warn);
  font-weight: 600;
  margin-bottom: 2px;
}

.lossy ul {
  margin: 0;
  padding-left: 18px;
  color: var(--fg-dim);
}

.yaml {
  margin: 0;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 11.5px;
  line-height: 1.6;
  max-height: 52vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.exp-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.em-row {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
}

.em-k {
  flex: none;
  width: 44px;
  color: var(--text-3);
}

.em-v {
  min-width: 0;
  word-break: break-all;
}

</style>
