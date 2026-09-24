<script setup lang="ts">
/**
 * [M26-split] 流水线画布页 · 顶栏（自 views/canvas/index.vue 原样搬出，行为零变更）：
 * 模式 tabs / 三态目标下拉 / 运行操作（取消·续跑）/ 模板操作（启动·编辑草稿通道）/ 全景摘要 / 适应视图。
 * —— 装配约定：状态真源在页面 index；操作函数经 props 直传（M28 shot-board 同约定）；
 * 三个目标下拉以 v-model 传父级 writable computed（get 回显 / set 路由跳转均留父级）。
 */
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { fmtTime, runStatus } from '../../lib/format'
import { filterSelectable } from '../../lib/scene'
import type {
  CanvasOverview,
  Project,
  Run,
  RunCanvas,
  TemplateMeta,
} from '../../lib/types'

type TabKey = 'run' | 'template' | 'overview'

const props = defineProps<{
  tab: TabKey
  runs: Run[]
  tplMetas: TemplateMeta[]
  projects: Project[]
  projectsLoaded: boolean
  overview: CanvasOverview | null
  overviewLoading: boolean
  curRun: NonNullable<RunCanvas['run']> | null
  runCanvas: RunCanvas | null
  listErr: string
  loading: boolean
  cancelBusy: boolean
  resumeBusy: boolean
  tplKey: string | null
  editMode: boolean
  editDirty: boolean
  editCount: number
  draftBusy: boolean
  goBack: () => void
  showTab: (t: TabKey) => void
  cancelRun: () => void
  resumeRun: () => void
  openStart: () => void
  toggleEdit: () => void
  resetEdits: () => void
  openDraftModal: () => void
  openSaveModal: () => void
  fitView: () => void
  clearTarget: () => void
}>()

const selRunId = defineModel<string>('runId', { required: true })
const selTplKey = defineModel<string>('tplSel', { required: true })
const selProject = defineModel<string>('project', { required: true })
// [入口收口] 顶栏「选模板→启动运行」不呈现轻松创作批准链模板（无 recipe 无法启动）；CanvasGuide 浏览设计不受影响
const selectableTpls = computed(() => filterSelectable(props.tplMetas))
// [方案C] 批准链 run：仅当存在受理状态不明任务（resumeNeedsVerification）时才不能就地续跑，顶栏改呈现直达会话链接；
// 无状态不明任务的轻松创作 run canResume 已为 true → 上面的「断点续跑」按钮直接可用（专业端 resume 委派 retryCreation）
const showCreationRecover = computed(
  () =>
    props.runCanvas?.runActions.isCreation === true &&
    props.runCanvas?.runActions.resumeNeedsVerification === true &&
    ['failed', 'cancelled'].includes(props.curRun?.status ?? ''),
)
</script>

<template>
  <div class="cv-bar">
    <button type="button" class="btn sm" title="返回上一页" @click="goBack">
      <Icon name="arrow-left" :size="13" />
    </button>
    <div
      class="tabs"
      role="tablist"
      aria-label="运行画布 / 模板画布 / 全景切换"
    >
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="tab === 'run'"
        :class="{ on: tab === 'run' }"
        @click="showTab('run')"
      >
        <Icon name="flow" :size="13" /> 运行画布
      </button>
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="tab === 'template'"
        :class="{ on: tab === 'template' }"
        @click="showTab('template')"
      >
        <Icon name="doc" :size="13" /> 模板画布
      </button>
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="tab === 'overview'"
        :class="{ on: tab === 'overview' }"
        @click="showTab('overview')"
      >
        <Icon name="map" :size="13" /> 全景
      </button>
    </div>

    <template v-if="tab === 'run'">
      <select
        v-model="selRunId"
        class="sel"
        aria-label="选择运行"
        :disabled="!runs.length"
      >
        <option value="" disabled>选择运行…</option>
        <option v-for="r in runs" :key="r.id" :value="String(r.id)">
          #{{ r.id }} · {{ r.templateKey }} · {{ runStatus(r.status).text }} ·
          {{ fmtTime(r.createdAt) }}
        </option>
      </select>
      <template v-if="curRun">
        <span class="badge" :class="curRun.status">{{
          runStatus(curRun.status).text
        }}</span>
        <span class="muted mono">#{{ curRun.id }}</span>
      </template>
      <button
        v-if="runCanvas?.runActions.canCancel"
        type="button"
        class="btn sm danger"
        :disabled="cancelBusy"
        @click="cancelRun"
      >
        <Icon name="stop" :size="12" />
        {{ cancelBusy ? '处理中…' : '取消运行' }}
      </button>
      <button
        v-if="runCanvas?.runActions.canResume"
        type="button"
        class="btn sm primary"
        :disabled="resumeBusy"
        @click="resumeRun"
      >
        <Icon name="play" :size="12" />
        {{ resumeBusy ? '处理中…' : '断点续跑' }}
      </button>
      <RouterLink
        v-else-if="showCreationRecover"
        class="btn sm primary"
        to="/create"
        title="该运行由轻松创作发起，到会话中核验失败任务后恢复制作（专业端续跑/重试会被拦截，防重复计费）"
      >
        <Icon name="play" :size="12" /> 去轻松创作恢复
      </RouterLink>
    </template>

    <template v-else-if="tab === 'template'">
      <select
        v-model="selTplKey"
        class="sel"
        aria-label="选择模板"
        :disabled="!selectableTpls.length"
      >
        <option value="" disabled>选择模板…</option>
        <option v-for="t in selectableTpls" :key="t.key" :value="t.key">
          {{ t.name }}（v{{ t.version }}）
        </option>
      </select>
      <select
        v-model="selProject"
        class="sel"
        aria-label="选择启动项目"
        :disabled="!projects.length"
      >
        <option value="" disabled>选择项目…</option>
        <option v-for="p in projects" :key="p.id" :value="String(p.id)">
          {{ p.name }}
        </option>
      </select>
      <!-- 空态出路：无项目时「启动运行」永远灰着，给出新建项目入口 -->
      <RouterLink
        v-if="projectsLoaded && !projects.length"
        class="sel-link"
        to="/"
        title="运行需要先有一个项目，点击去创建"
      >
        <Icon name="plus" :size="12" /> 还没有项目？先创建一个
      </RouterLink>
      <button
        type="button"
        class="btn sm primary"
        :disabled="!tplKey || !selProject"
        title="以当前模板启动新运行（需先选项目）"
        @click="openStart"
      >
        <Icon name="play" :size="12" /> 启动运行
      </button>

      <!-- [M23] 画布内编辑（本地草稿） -->
      <button
        v-if="!editMode"
        type="button"
        class="btn sm"
        title="进入画布内编辑（本地草稿，不改动原模板文件）"
        @click="toggleEdit"
      >
        <Icon name="pencil" :size="12" /> 编辑
      </button>
      <template v-else>
        <span class="edit-flag">编辑中</span>
        <span v-if="editDirty" class="edit-dirty"
          >有未保存修改（{{ editCount }} 步）</span
        >
        <button
          v-if="editDirty"
          type="button"
          class="btn sm"
          title="丢弃全部编辑草稿"
          @click="resetEdits"
        >
          <Icon name="undo" :size="12" /> 重置修改
        </button>
        <!-- [M23] E4 落盘通道：草案预览（不落盘）/ 保存为新模板（原文件零触碰） -->
        <button
          v-if="editDirty"
          type="button"
          class="btn sm"
          :disabled="draftBusy"
          title="以受控 edits 生成新模板 YAML 预览（不落盘）"
          @click="openDraftModal"
        >
          <Icon name="doc" :size="12" />
          {{ draftBusy ? '生成中…' : '导出草案' }}
        </button>
        <button
          v-if="editDirty"
          type="button"
          class="btn sm primary"
          :disabled="draftBusy"
          title="落盘为新模板文件（key 冲突自动后缀避让；原模板不被修改）"
          @click="openSaveModal"
        >
          <Icon name="download" :size="12" /> 保存为新模板
        </button>
        <button
          type="button"
          class="btn sm"
          title="退出编辑（有修改时需确认）"
          @click="toggleEdit"
        >
          <Icon name="check" :size="12" /> 退出编辑
        </button>
      </template>
    </template>

    <template v-else>
      <select
        v-model="selProject"
        class="sel"
        aria-label="选择项目"
        :disabled="!projects.length"
      >
        <option value="" disabled>选择项目…</option>
        <option v-for="p in projects" :key="p.id" :value="String(p.id)">
          {{ p.name }}
        </option>
      </select>
      <span v-if="overview" class="muted mono"
        >{{ overview.stats.runCount }} 条运行 ·
        {{ overview.batches.length }} 个批次</span
      >
      <span v-else-if="overviewLoading" class="muted">加载中…</span>
    </template>

    <span class="sp" />
    <span v-if="listErr" class="muted" :title="listErr">目录加载失败</span>
    <span v-if="loading" class="muted">加载中…</span>
    <button type="button" class="btn sm" title="适应视图（0）" @click="fitView">
      <Icon name="zoom-in" :size="12" /> 适应视图
    </button>
  </div>
</template>

<style scoped>
.cv-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sel {
  width: auto;
  max-width: 320px;
  padding: 5px 8px;
  font-size: 12px;
}

/* 空态出路链接：与下拉同高同字号，胶囊描边区分于控件 */
.sel-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--accent-h);
  text-decoration: none;
  border: 1px dashed rgb(99 102 241 / 45%);
  border-radius: 999px;
  background: var(--accent-weak);
  transition:
    border-color 0.15s,
    color 0.15s;
}

.sel-link:hover {
  border-color: var(--accent);
  color: #fff;
  text-decoration: none;
}

.sp {
  flex: 1;
}

/* [M23] 编辑标记（顶栏） */
.edit-flag {
  font-size: 11px;
  color: var(--warn);
  border: 1px solid rgb(251 191 36 / 35%);
  border-radius: 999px;
  padding: 1px 8px;
}

.edit-dirty {
  font-size: 11.5px;
  color: var(--warn);
}
</style>
