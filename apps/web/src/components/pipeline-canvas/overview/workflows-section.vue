<script setup lang="ts">
/**
 * 全景「编排链」区（spec §2.5 I3）
 * 横向节点序列（模板名 + 段间箭头）+ 段 run 状态/成本徽章 + 链级 autoAdvance 开关 + 启动/暂停/续跑/克隆/删除。
 * 交互直调 workflowApi，成功后 emit('changed') 由父级刷新 overview；段卡点击 emit('open-run') 导航。
 * 纯展示数据来自 overview.workflows（buildCanvasOverview 派生），本组件不自持链数据副本。
 */
import { onMounted, ref } from 'vue'
import Icon from '../../common/Icon.vue'
import ChainBuilder from './chain-builder.vue'
import { templateApi, workflowApi } from '../../../lib/api'
import { fmtCost, runStatus, workflowStatus } from '../../../lib/format'
import type {
  TemplateMeta,
  WorkflowOverviewLite,
  WorkflowSegmentLite,
} from '../../../lib/types'

const props = defineProps<{
  projectId: number
  workflows: WorkflowOverviewLite[]
}>()
const emit = defineEmits<{ changed: []; 'open-run': [id: number] }>()

const templates = ref<TemplateMeta[]>([])
const showBuilder = ref(false)
const busy = ref<Record<number, boolean>>({})
const err = ref('')

onMounted(async () => {
  try {
    templates.value = (await templateApi.list()).items
  } catch {
    templates.value = []
  }
})

function segBadge(s: WorkflowSegmentLite): { text: string; cls: string } {
  if (!s.runId) return { text: '未开始', cls: 'queued' }
  return runStatus(s.runStatus!)
}

async function act(id: number, fn: () => Promise<unknown>, okMsg = '') {
  err.value = ''
  busy.value = { ...busy.value, [id]: true }
  try {
    await fn()
    if (okMsg) err.value = okMsg
    emit('changed')
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    const next = { ...busy.value }
    delete next[id]
    busy.value = next
  }
}

const toggleAuto = (w: WorkflowOverviewLite) =>
  act(w.id, () =>
    workflowApi.update(w.id, { autoAdvance: w.autoAdvance === 1 ? 0 : 1 }),
  )
const start = (w: WorkflowOverviewLite) =>
  act(w.id, () => workflowApi.start(w.id))
const pause = (w: WorkflowOverviewLite) =>
  act(w.id, () => workflowApi.pause(w.id))
const resume = (w: WorkflowOverviewLite) =>
  act(w.id, () => workflowApi.resume(w.id))
const clone = (w: WorkflowOverviewLite) =>
  act(w.id, () => workflowApi.clone(w.id))
const remove = (w: WorkflowOverviewLite) => {
  if (!window.confirm(`删除编排链「${w.name}」？（仅草稿/完成/已取消链可删）`))
    return
  act(w.id, () => workflowApi.remove(w.id))
}

function onCreated() {
  showBuilder.value = false
  err.value = ''
  emit('changed')
}
</script>

<template>
  <section class="panel wfsec">
    <div class="wfhead">
      <span class="wft"><Icon name="flow" :size="14" /> 编排链</span>
      <span class="muted mini">{{ workflows.length }} 条</span>
      <span class="sp" />
      <button type="button" class="btn primary sm" @click="showBuilder = true">
        <Icon name="plus" :size="12" /> 新建编排链
      </button>
    </div>

    <div v-if="err" class="err-text wferr">{{ err }}</div>

    <div v-if="!workflows.length" class="muted wfempty">
      暂无编排链。点击「新建编排链」把多个模板按序串成一条自动流水线（跨模板串链由你显式编排，逐链开关控制是否自动级联）。
    </div>

    <div v-else class="wflist">
      <div v-for="w in workflows" :key="w.id" class="wfcard">
        <!-- 链头 -->
        <div class="wfbar">
          <span class="wfname">{{ w.name }}</span>
          <span class="badge" :class="workflowStatus(w.status).cls">{{
            workflowStatus(w.status).text
          }}</span>
          <label
            class="switch"
            :title="w.autoAdvance === 1 ? '自动级联已开启' : '自动级联已关闭'"
          >
            <input
              type="checkbox"
              :checked="w.autoAdvance === 1"
              :disabled="!!busy[w.id]"
              aria-label="自动级联"
              @change="toggleAuto(w)"
            />
            <span class="sl"></span>
            <span class="sltxt">自动级联</span>
          </label>
          <span class="sp" />
          <div class="wfacts">
            <button
              v-if="w.status === 'draft'"
              type="button"
              class="btn sm primary"
              :disabled="!!busy[w.id]"
              @click="start(w)"
            >
              <Icon name="play" :size="11" /> 启动
            </button>
            <button
              v-else-if="w.status === 'active'"
              type="button"
              class="btn sm"
              :disabled="!!busy[w.id]"
              @click="pause(w)"
            >
              <Icon name="stop" :size="11" /> 暂停
            </button>
            <button
              v-else-if="w.status === 'paused'"
              type="button"
              class="btn sm primary"
              :disabled="!!busy[w.id]"
              @click="resume(w)"
            >
              <Icon name="play" :size="11" /> 续跑
            </button>
            <button
              type="button"
              class="btn sm"
              :disabled="!!busy[w.id]"
              title="克隆为草稿链"
              @click="clone(w)"
            >
              <Icon name="copy" :size="11" /> 克隆
            </button>
            <button
              v-if="
                w.status === 'draft' ||
                w.status === 'done' ||
                w.status === 'cancelled'
              "
              type="button"
              class="btn sm danger"
              :disabled="!!busy[w.id]"
              aria-label="删除链"
              @click="remove(w)"
            >
              <Icon name="trash" :size="11" />
            </button>
          </div>
        </div>

        <!-- 段节点序列（横向 + 箭头） -->
        <div class="chain">
          <template v-for="(s, i) in w.segments" :key="`${w.id}-${s.seq}`">
            <button
              type="button"
              class="node"
              :class="{ dead: !s.runId }"
              :disabled="!s.runId"
              :title="s.runId ? `查看 run #${s.runId}` : '该段尚未运行'"
              @click="s.runId && emit('open-run', s.runId)"
            >
              <span class="nseq mono">{{ i + 1 }}</span>
              <span class="nname" :title="s.templateKey">{{
                s.templateName
              }}</span>
              <span class="badge nst" :class="segBadge(s).cls">{{
                segBadge(s).text
              }}</span>
              <span v-if="s.cost != null" class="ncost mono">{{
                fmtCost(s.cost)
              }}</span>
            </button>
            <span
              v-if="i < w.segments.length - 1"
              class="arrow"
              aria-hidden="true"
            >
              <Icon name="chevron-right" :size="14" />
            </span>
          </template>
        </div>
      </div>
    </div>

    <ChainBuilder
      v-if="showBuilder"
      :project-id="projectId"
      :templates="templates"
      @close="showBuilder = false"
      @created="onCreated"
    />
  </section>
</template>

<style scoped>
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.wfsec {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 11px 14px 13px;
}

.wfhead {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wft {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13.5px;
  font-weight: 700;
}

.wferr {
  margin: 0;
}

.wfempty {
  padding: 10px 2px;
  line-height: 1.6;
}

.wflist {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wfcard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 9px 11px;
}

.wfbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.wfname {
  font-size: 13px;
  font-weight: 600;
}

.wfacts {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* autoAdvance 开关 */
.switch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  user-select: none;
}

.switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.sl {
  width: 28px;
  height: 16px;
  border-radius: 999px;
  background: var(--chip-bg);
  border: 1px solid var(--border);
  position: relative;
  transition: background 0.2s;
  flex: none;
}

.sl::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 1px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-3);
  transition:
    transform 0.2s,
    background 0.2s;
}

.switch input:checked + .sl {
  background: var(--accent);
}

.switch input:checked + .sl::after {
  transform: translateX(12px);
  background: #fff;
}

.switch input:focus-visible + .sl {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.switch input:disabled + .sl {
  opacity: 0.5;
}

.sltxt {
  font-size: 11.5px;
  color: var(--text-2);
}

/* 段节点序列 */
.chain {
  display: flex;
  align-items: stretch;
  gap: 4px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.node {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  text-align: left;
  font: inherit;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 10px;
  min-width: 118px;
  flex: none;
  cursor: pointer;
}

.node:hover:not(:disabled) {
  border-color: var(--accent);
}

.node:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.node.dead,
.node:disabled {
  cursor: default;
  opacity: 0.82;
}

.nseq {
  font-size: 10px;
  color: var(--text-3);
}

.nname {
  font-size: 12px;
  font-weight: 600;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nst {
  font-size: 10px;
}

.ncost {
  font-size: 10.5px;
  color: var(--text-2);
}

.arrow {
  display: inline-flex;
  align-items: center;
  color: var(--text-3);
  flex: none;
}

.btn.sm {
  padding: 3px 8px;
  font-size: 11.5px;
  gap: 3px;
  border-radius: 7px;
}

.btn.danger {
  color: var(--bad);
}

.btn.danger:hover {
  border-color: var(--bad);
}

.sp {
  flex: 1;
}
</style>
