<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import Modal from '../../components/common/Modal.vue'
import { fmtTime } from '../../lib/format'
import type { SnapshotDiffBucket } from '../../lib/types'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{
  cv: Pick<
    CanvasViewState,
    | 'showSnaps'
    | 'snapLabel'
    | 'createSnap'
    | 'snapsBusy'
    | 'snapsLoading'
    | 'snapItems'
    | 'snapActing'
    | 'restoreSnap'
    | 'deleteSnap'
    | 'diffFor'
    | 'diffAgainst'
    | 'diffLoading'
    | 'diffData'
    | 'openDiff'
    | 'loadDiff'
    | 'closeDiff'
    | 'branchFor'
    | 'branchName'
    | 'branchBusy'
    | 'startBranch'
    | 'branchSnap'
  >
}>()
const cv = props.cv

/** 对比目标候选（排除基准快照自身） */
const otherSnaps = computed(() =>
  cv.snapItems.filter((s) => s.id !== cv.diffFor?.id),
)

/** diff 三分区（节点/连线/分组） */
const diffSections = computed<
  Array<{ key: string; label: string; b: SnapshotDiffBucket }>
>(() => {
  const d = cv.diffData
  if (!d) return []
  return [
    { key: 'nodes', label: '节点', b: d.nodes },
    { key: 'edges', label: '连线', b: d.edges },
    { key: 'groups', label: '分组', b: d.groups },
  ]
})

/** diff 展示值（服务端已截断；对象保留结构直显） */
function dv(v: unknown): string {
  if (v === null || v === undefined) return '（空）'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}
</script>

<template>
  <!-- 文档快照（保留 id 重放；恢复前自动备份）； 对比/分支 -->
  <Modal
    v-if="cv.showSnaps"
    title="文档快照"
    :width="640"
    @close="cv.showSnaps = false"
  >
    <!-- 对比视图（基准快照 ↔ live/另一快照） -->
    <template v-if="cv.diffFor">
      <div class="diff-head">
        <button type="button" class="btn sm" @click="cv.closeDiff()">
          <Icon name="arrow-left" :size="11" /> 返回列表
        </button>
        <span class="muted mini">{{ cv.diffFor.label }} ↔</span>
        <select
          v-model="cv.diffAgainst"
          class="diff-sel"
          @change="cv.loadDiff()"
        >
          <option value="live">当前画布（live）</option>
          <option v-for="s in otherSnaps" :key="s.id" :value="String(s.id)">
            {{ s.label }}
          </option>
        </select>
      </div>
      <div class="muted mini">
        基准「{{ cv.diffFor.label }}」→ 目标；＋新增 −删除
        ~修改（字段级，显示值超 200 字截断）。
      </div>
      <div v-if="cv.diffLoading" class="muted">计算差异中…</div>
      <template v-else-if="cv.diffData">
        <div class="diff-sum">
          <span v-for="sec in diffSections" :key="sec.key" class="dsum">
            {{ sec.label }}
            <b class="dv-add">+{{ sec.b.added.length }}</b>
            <b class="dv-del">−{{ sec.b.removed.length }}</b>
            <b class="dv-mod">~{{ sec.b.modified.length }}</b>
          </span>
        </div>
        <div class="diff-body">
          <details
            v-for="sec in diffSections"
            :key="sec.key"
            class="diff-sec"
            open
          >
            <summary>
              {{ sec.label }}（变化
              {{
                sec.b.added.length +
                sec.b.removed.length +
                sec.b.modified.length
              }}）
            </summary>
            <div
              v-if="
                !sec.b.added.length &&
                !sec.b.removed.length &&
                !sec.b.modified.length
              "
              class="muted mini"
            >
              无差异
            </div>
            <div
              v-for="it in sec.b.added"
              :key="`a${it.id}`"
              class="dl-row add"
            >
              <span class="dl-mark">＋</span>{{ it.title
              }}<span class="muted mini"> #{{ it.id }}</span>
            </div>
            <div
              v-for="it in sec.b.removed"
              :key="`r${it.id}`"
              class="dl-row del"
            >
              <span class="dl-mark">−</span>{{ it.title
              }}<span class="muted mini"> #{{ it.id }}</span>
            </div>
            <div v-for="en in sec.b.modified" :key="`m${en.id}`" class="dl-mod">
              <div class="dl-row mod">
                <span class="dl-mark">~</span>{{ en.title
                }}<span class="muted mini"> #{{ en.id }}</span>
              </div>
              <div v-for="ch in en.changes" :key="ch.field" class="dl-chg">
                <span class="mono dl-field">{{ ch.field }}</span>
                <span class="dl-before">{{ dv(ch.before) }}</span>
                <span class="muted">→</span>
                <span class="dl-after">{{ dv(ch.after) }}</span>
              </div>
            </div>
          </details>
        </div>
      </template>
    </template>
    <!-- 列表视图 -->
    <template v-else>
      <div class="snap-bar">
        <input
          v-model="cv.snapLabel"
          class="snap-label-in"
          placeholder="快照名称（可选，缺省「快照 N」）"
          @keydown.enter="cv.createSnap"
        />
        <button
          type="button"
          class="btn sm"
          :disabled="cv.snapsBusy"
          @click="cv.createSnap"
        >
          <Icon name="plus" :size="11" />
          {{ cv.snapsBusy ? '创建中…' : '创建快照' }}
        </button>
      </div>
      <div class="muted mini">
        恢复会先自动备份当前状态为新快照；节点 id
        原样保留（生成任务历史不断链）。上限 20 个。
      </div>
      <div v-if="cv.snapsLoading" class="muted">加载中…</div>
      <div v-else-if="!cv.snapItems.length" class="muted">暂无快照。</div>
      <div v-else class="snap-list">
        <div v-for="s in cv.snapItems" :key="s.id" class="snap-cell">
          <div class="snap-item">
            <div class="ti-main">
              <div class="ti-name" :title="s.label">{{ s.label }}</div>
              <div class="muted mini">
                {{ s.nodeCount }} 节点 · {{ s.edgeCount }} 边 ·
                {{ fmtTime(s.createdAt) }}
              </div>
            </div>
            <span class="sp" />
            <button
              type="button"
              class="btn sm"
              :disabled="cv.snapActing != null"
              title="与该快照字段级对比（默认 vs 当前画布）"
              @click="cv.openDiff(s)"
            >
              <Icon name="flow" :size="11" /> 对比
            </button>
            <button
              type="button"
              class="btn sm"
              :disabled="cv.snapActing != null"
              title="从该快照分支为新画布（新 id 重放）"
              @click="cv.startBranch(s)"
            >
              <Icon name="copy" :size="11" /> 分支
            </button>
            <button
              type="button"
              class="btn sm"
              :disabled="cv.snapActing != null"
              @click="cv.restoreSnap(s)"
            >
              <Icon name="undo" :size="11" /> 恢复
            </button>
            <button
              type="button"
              class="btn sm danger"
              :disabled="cv.snapActing != null"
              @click="cv.deleteSnap(s)"
            >
              <Icon name="trash" :size="11" /> 删除
            </button>
          </div>
          <!-- 分支命名面板 -->
          <div v-if="cv.branchFor?.id === s.id" class="branch-panel">
            <input
              v-model="cv.branchName"
              class="snap-label-in"
              :placeholder="`新画布名称（可选，缺省「源画布名 分支」）`"
              @keydown.enter="cv.branchSnap()"
            />
            <button
              type="button"
              class="btn sm primary"
              :disabled="cv.branchBusy"
              @click="cv.branchSnap()"
            >
              {{ cv.branchBusy ? '创建中…' : '创建分支' }}
            </button>
            <button
              type="button"
              class="btn sm"
              :disabled="cv.branchBusy"
              @click="cv.branchFor = null"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </template>
    <template #footer>
      <button type="button" class="btn" @click="cv.showSnaps = false">
        关闭
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.sp {
  flex: 1;
}

.mini {
  font-size: 11px;
}

/* ===== 回收站 / 文档快照弹窗 ===== */
.trash-list,
.snap-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow-y: auto;
  margin-top: 10px;
}

.trash-item,
.snap-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--code-bg);
  padding: 8px 10px;
}

.ti-main {
  min-width: 0;
}

.ti-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.snap-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.snap-label-in {
  flex: 1;
  padding: 5px 8px;
  font-size: 12.5px;
}

/* ===== 快照对比视图 ===== */
.diff-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.diff-sel {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  font-size: 12.5px;
}

.diff-sum {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 10px 0;
}

.dsum {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 9px;
  background: var(--code-bg);
}

.dv-add {
  color: #4ade80;
}

.dv-del {
  color: #f87171;
}

.dv-mod {
  color: #fbbf24;
}

.diff-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 46vh;
  overflow-y: auto;
}

.diff-sec {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--code-bg);
  padding: 8px 10px;
}

.diff-sec > summary {
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 600;
}

.dl-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 3px 0;
}

.dl-mark {
  flex: none;
  width: 14px;
  text-align: center;
  font-weight: 700;
}

.dl-row.add,
.dl-row.add .dl-mark {
  color: #4ade80;
}

.dl-row.del,
.dl-row.del .dl-mark {
  color: #f87171;
}

.dl-row.mod,
.dl-row.mod .dl-mark {
  color: #fbbf24;
}

.dl-mod {
  margin: 3px 0 6px;
}

.dl-chg {
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-wrap: wrap;
  padding: 2px 0 2px 20px;
  font-size: 11.5px;
}

.dl-field {
  flex: none;
  color: var(--text-2);
}

.dl-before {
  color: #f87171;
  text-decoration: line-through;
  word-break: break-all;
}

.dl-after {
  color: #4ade80;
  word-break: break-all;
}

/* ===== 分支命名面板 ===== */
.snap-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.branch-panel {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}
</style>
