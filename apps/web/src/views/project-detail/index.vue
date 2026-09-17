<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import RunFormModal from '../../components/run/RunFormModal.vue'
import PublishModal from '../../components/run/PublishModal.vue'
import BatchFormModal from '../../components/project/BatchFormModal.vue'
import ProjectFormModal from '../../components/project/ProjectFormModal.vue'
import ProjectDangerModal from '../../components/project/ProjectDangerModal.vue'
import { fmtQty } from '../../lib/format'
import { useProjectDetailPage } from './use-project-detail'
import RunsPanel from './RunsPanel.vue'
import AssetsPanel from './AssetsPanel.vue'
import PubsPanel from './PubsPanel.vue'
import BrandPanel from './BrandPanel.vue'
import UploadModal from './UploadModal.vue'
import FetchSourceModal from './FetchSourceModal.vue'

const s = useProjectDetailPage()
const { projectId, TABS, activeTab, switchTab, project, assets, pubs, pubSummary, coreLoading, coreErr, runningCount, waitingRuns, assetCount, gotoRuns, cntOf, showUpload, showFetch, showRunForm, showBatch, runFormTplKey, runFormPrefill, closeRunForm, onRunCreated, onBatchCreated, showPublish, editingPub, onPubSaved, showEdit, showDanger, tplName, defaultTplKey, onEdited, onDeleted } = s
</script>

<template>
  <div>
    <div class="page-h">
      <RouterLink to="/" class="back"><Icon name="arrow-left" :size="14" /> 项目</RouterLink>
      <h1>{{ project?.name ?? `项目 #${projectId}` }}</h1>
      <span v-if="project" class="badge" :class="project.status === 'active' ? 'completed' : 'cancelled'">
        {{ project.status === 'active' ? '进行中' : '已归档' }}
      </span>
      <span v-if="project?.templateKey" class="sub">默认模板：{{ tplName(project.templateKey) }}</span>
      <div style="margin-left: auto; display: flex; gap: 8px">
        <button class="btn" :disabled="!project" @click="showEdit = true">
          <Icon name="pencil" :size="14" /> 编辑
        </button>
        <button class="btn" @click="showUpload = true">
          <Icon name="upload" :size="14" /> 上传素材
        </button>
        <!-- [M25] G8 URL 抓正文入库（服务端抓取 + SSRF 守卫） -->
        <button class="btn" title="抓取网页正文存为素材资产（仅供个人素材整理）" @click="showFetch = true">
          <Icon name="link" :size="14" /> 从 URL 抓取
        </button>
        <button class="btn" @click="showBatch = true">
          <Icon name="bolt" :size="14" /> 批量运行
        </button>
        <button class="btn primary" @click="showRunForm = true">
          <Icon name="bolt" :size="14" /> 启动流水线
        </button>
        <button
          class="btn"
          :disabled="!project"
          title="归档 / 彻底删除项目"
          aria-label="归档 / 彻底删除项目"
          @click="showDanger = true"
        >
          <Icon name="trash" :size="14" />
        </button>
      </div>
    </div>

    <div v-if="coreErr && !project" class="err-text">{{ coreErr }}</div>
    <div v-if="coreLoading && !project" class="empty">加载中…</div>

    <template v-if="project">
      <div class="brief muted">{{ project.brief }}</div>

      <!-- KPI 指标条：状态快照，点击直达对应筛选 / 分区 -->
      <div class="stat-strip">
        <button class="stat panel" type="button" title="按「进行中」查看运行" @click="gotoRuns('active')">
          <span class="v">{{ runningCount }}</span>
          <span class="k">运行中</span>
        </button>
        <button
          class="stat panel"
          :class="{ attention: waitingRuns.length > 0 }"
          type="button"
          title="按「待审阅」查看运行"
          @click="gotoRuns('waiting')"
        >
          <span class="v">{{ waitingRuns.length }}</span>
          <span class="k">待审阅</span>
        </button>
        <button class="stat panel" type="button" title="查看资产" @click="switchTab('assets')">
          <span class="v">{{ assetCount }}</span>
          <span class="k">资产</span>
        </button>
        <button class="stat panel" type="button" title="查看发布记录" @click="switchTab('pubs')">
          <span class="v">{{ pubs.length }}</span>
          <span class="k">已发布</span>
          <span v-if="pubSummary.views || pubSummary.interactions" class="extra">
            播放 {{ fmtQty(pubSummary.views) }} · 互动 {{ fmtQty(pubSummary.interactions) }}
          </span>
        </button>
      </div>

      <!-- 页内 Tab（?tab= 深链接） -->
      <div class="tabs" role="tablist" aria-label="项目分区">
        <button
          v-for="t in TABS"
          :id="`ptab-${t.key}`"
          :key="t.key"
          class="tab"
          role="tab"
          :aria-selected="activeTab === t.key"
          :class="{ on: activeTab === t.key }"
          @click="switchTab(t.key)"
        >
          <Icon :name="t.icon" :size="13" :strokeWidth="1.8" />
          {{ t.label }}
          <span class="cnt">{{ cntOf(t.key) }}</span>
        </button>
      </div>

      <!-- 运行 -->
      <RunsPanel :s="s" />

      <!-- 资产 -->
      <AssetsPanel :s="s" />

      <!-- 发布 -->
      <PubsPanel :s="s" />

      <!-- [M19] 品牌（平台/项目/run 三层；项目层覆盖平台，保存后重新合成生效） -->
      <BrandPanel :s="s" />
    </template>

    <!-- 启动 run（[M14] 起作入口预选项目模板 + 预填 episode_number） -->
    <RunFormModal
      v-if="showRunForm"
      :project-id="projectId"
      :initial-template-key="runFormTplKey"
      :default-template-key="defaultTplKey"
      :prefill-input="runFormPrefill"
      @done="onRunCreated"
      @close="closeRunForm"
    />

    <!-- 上传素材 -->
    <UploadModal :s="s" />

    <!-- [M25] G8 从 URL 抓取 -->
    <FetchSourceModal :s="s" />

    <!-- [M4] 批量创建 -->
    <BatchFormModal
      v-if="showBatch"
      :project-id="projectId"
      :default-template-key="defaultTplKey"
      @done="onBatchCreated"
      @close="showBatch = false"
    />

    <!-- [优化] 编辑项目 -->
    <ProjectFormModal v-if="showEdit && project" :project="project" @done="onEdited" @close="showEdit = false" />

    <!-- 危险操作：归档 / 彻底删除 -->
    <ProjectDangerModal
      v-if="showDanger && project"
      :project="project"
      @archived="onDeleted"
      @purged="onDeleted"
      @close="showDanger = false"
    />

    <!-- [M4] 标记发布 / 编辑回填 -->
    <PublishModal
      v-if="showPublish"
      :project-id="projectId"
      :asset-options="assets.map((a) => ({ id: a.id, name: a.name }))"
      :publication="editingPub"
      @done="onPubSaved"
      @close="showPublish = false"
    />
  </div>
</template>

<style scoped>
.brief {
  margin: -6px 0 16px;
}
/* ---------- KPI 指标条 ---------- */
.stat-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.stat {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  column-gap: 8px;
  row-gap: 1px;
  padding: 10px 14px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.12s;
}

.stat:hover {
  border-color: rgb(99 102 241 / 45%);
  transform: translateY(-1px);
}

.stat .v {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.stat .k {
  font-size: 12.5px;
  color: var(--text-2);
}

.stat .extra {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.stat.attention {
  border-color: rgb(245 158 11 / 45%);
  background: linear-gradient(180deg, var(--warn-weak), transparent 78%), var(--panel);
}

.stat.attention .v {
  color: var(--warn);
}

/* ---------- 页内 Tab（全局原语 .tabs / .tab / .cnt，此处仅补间距） ---------- */
.tabs {
  margin: 0 0 14px;
}
@media (max-width: 860px) {
  .stat-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
