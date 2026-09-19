<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import SeriesBoard from '../../components/project/SeriesBoard.vue'
import {
  runStatus,
  fmtTime,
  fmtMs,
  batchStatus,
  inputSummary,
} from '../../lib/format'
import type { ProjectDetailApi } from './use-project-detail'
const props = defineProps<{ s: ProjectDetailApi }>()
const {
  router,
  projectId,
  activeTab,
  runs,
  batches,
  coreErr,
  RUN_FILTERS,
  RUN_LIMIT,
  BATCH_LIMIT,
  PAGE_SIZE,
  runFilter,
  rowPage,
  waitingRuns,
  topRows,
  rowPageCount,
  expanded,
  toggleBatch,
  pagedRows,
  seriesRef,
  onStartEpisode,
  tplName,
  errOf,
} = props.s
</script>

<template>
  <section
    v-show="activeTab === 'runs'"
    role="tabpanel"
    aria-labelledby="ptab-runs"
  >
    <!-- 待审阅置顶：唯一阻塞项，直达 gate 处理 -->
    <div v-if="waitingRuns.length" class="gate-banner panel">
      <div class="gb-h">
        <Icon name="clock" :size="14" />
        有 {{ waitingRuns.length }} 个运行等待审阅
      </div>
      <div v-for="r in waitingRuns" :key="r.id" class="gb-row">
        <span class="mono">Run #{{ r.id }}</span>
        <span class="muted">{{ tplName(r.templateKey) }}</span>
        <span class="muted">停在 {{ r.currentStepKey ?? '—' }}</span>
        <RouterLink class="gb-go" :to="`/runs/${r.id}`">去审阅 →</RouterLink>
      </div>
    </div>

    <!-- [M14] 剧集地图（一项目一剧；起作直达 run 表单并预填集号） -->
    <SeriesBoard
      ref="seriesRef"
      :project-id="projectId"
      @start-episode="onStartEpisode"
    />

    <div v-if="coreErr" class="err-text">{{ coreErr }}</div>

    <!-- 批次与运行：单表合并（批次行可展开批内运行；子运行并入批次行下） -->
    <div class="panel block">
      <div class="bh">
        <span class="bt">批次与运行</span>
        <span class="muted">{{ topRows.length }} 条记录</span>
        <select v-model="runFilter" class="filter" aria-label="按状态筛选运行">
          <option v-for="f in RUN_FILTERS" :key="f.v" :value="f.v">
            {{ f.t }}
          </option>
        </select>
      </div>
      <table class="tbl">
        <thead>
          <tr>
            <th>批次 / 运行</th>
            <th>状态</th>
            <th>模板</th>
            <th>摘要 / 进度</th>
            <th>时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in pagedRows" :key="row.key">
            <!-- 批次行：点击展开/收起批内运行，「详情 →」进批次页 -->
            <tr
              v-if="row.kind === 'batch'"
              class="rrow batch"
              @click="toggleBatch(row.batch.id)"
            >
              <td>
                <button
                  class="bexp"
                  type="button"
                  :aria-expanded="expanded.has(row.batch.id)"
                  :aria-label="`展开或收起批次「${row.batch.name}」的批内运行`"
                  :title="
                    expanded.has(row.batch.id) ? '收起批内运行' : '展开批内运行'
                  "
                >
                  <Icon name="chevron-right" :size="12" :stroke-width="2.2" />
                  <span class="bname">{{ row.batch.name }}</span>
                </button>
              </td>
              <td>
                <span
                  class="badge"
                  :class="batchStatus(row.batch.status).cls"
                  >{{ batchStatus(row.batch.status).text }}</span
                >
              </td>
              <td class="tkey">{{ tplName(row.batch.templateKey) }}</td>
              <td class="mono muted">
                {{ row.batch.finished }}/{{ row.batch.total }} 完成
                <template v-if="row.batch.failed">
                  ·
                  <span class="em">失败 {{ row.batch.failed }}</span></template
                >
                <template v-else-if="row.batch.succeeded">
                  · 成功 {{ row.batch.succeeded }}</template
                >
              </td>
              <td class="muted" style="white-space: nowrap">
                更新 {{ fmtTime(row.batch.updatedAt) }}
              </td>
              <td @click.stop>
                <RouterLink class="muted" :to="`/batches/${row.batch.id}`"
                  >详情 →</RouterLink
                >
              </td>
            </tr>

            <!-- 批内子运行：缩进 + 批内序号，点击进运行详情 -->
            <tr
              v-else-if="row.kind === 'child'"
              class="rrow child"
              @click="router.push(`/runs/${row.run.id}`)"
            >
              <td class="mono cid">└ #{{ row.run.id }}</td>
              <td>
                <span class="badge" :class="row.run.status">{{
                  runStatus(row.run.status).text
                }}</span>
              </td>
              <td class="muted mono tkey">
                批内 #{{ row.run.batchSeq ?? '—' }}
              </td>
              <td class="sum">
                <span
                  v-if="errOf(row.run)"
                  class="em"
                  :title="row.run.error ?? ''"
                  >{{ errOf(row.run) }}</span
                >
                <span v-else class="muted">{{
                  inputSummary(row.run.input)
                }}</span>
              </td>
              <td class="muted" style="white-space: nowrap">
                {{ fmtTime(row.run.startedAt ?? row.run.createdAt) }}
                <template v-if="row.run.completedAt"
                  >→ {{ fmtTime(row.run.completedAt) }}</template
                >
              </td>
              <td><span class="muted">详情 →</span></td>
            </tr>

            <!-- 独立运行行 -->
            <tr
              v-else-if="row.kind === 'run'"
              class="rrow"
              @click="router.push(`/runs/${row.run.id}`)"
            >
              <td class="mono">{{ row.run.id }}</td>
              <td>
                <span class="badge" :class="row.run.status">{{
                  runStatus(row.run.status).text
                }}</span>
              </td>
              <td class="tkey">{{ tplName(row.run.templateKey) }}</td>
              <td class="sum">
                <span
                  v-if="errOf(row.run)"
                  class="em"
                  :title="row.run.error ?? ''"
                  >{{ errOf(row.run) }}</span
                >
                <span v-else-if="row.run.summary?.durationMs" class="muted"
                  >共 {{ row.run.summary.stepCount }} 步 ·
                  {{ fmtMs(row.run.summary.durationMs) }}</span
                >
                <span
                  v-else-if="row.run.status === 'running'"
                  class="muted run-flash"
                  >执行中…</span
                >
                <span v-else class="muted">—</span>
              </td>
              <td class="muted" style="white-space: nowrap">
                {{ fmtTime(row.run.startedAt ?? row.run.createdAt) }}
                <template v-if="row.run.completedAt"
                  >→ {{ fmtTime(row.run.completedAt) }}</template
                >
              </td>
              <td><span class="muted">详情 →</span></td>
            </tr>

            <!-- 加载窗口提示行 -->
            <tr v-else-if="row.kind === 'note'">
              <td colspan="6">
                <div class="note">
                  {{ row.text }}
                  <RouterLink :to="`/batches/${row.batchId}`"
                    >批次详情 →</RouterLink
                  >
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!pagedRows.length">
            <td colspan="6">
              <div class="empty" style="padding: 18px 0">
                {{
                  runs.length || batches.length
                    ? '该筛选条件下暂无记录'
                    : '尚未运行——点右上「启动流水线」开始'
                }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="topRows.length > PAGE_SIZE" class="pager">
        <button class="btn sm" :disabled="rowPage <= 1" @click="rowPage--">
          上一页
        </button>
        <span class="muted mono">第 {{ rowPage }} / {{ rowPageCount }} 页</span>
        <button
          class="btn sm"
          :disabled="rowPage >= rowPageCount"
          @click="rowPage++"
        >
          下一页
        </button>
      </div>
      <div v-if="runs.length >= RUN_LIMIT" class="muted trunc">
        仅显示最近 {{ RUN_LIMIT }} 次运行（接口上限）
      </div>
      <div v-if="batches.length >= BATCH_LIMIT" class="muted trunc">
        仅显示最近 {{ BATCH_LIMIT }} 个批次（接口上限）
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ---------- 待审阅置顶 ---------- */
.gate-banner {
  margin-bottom: 14px;
  padding: 10px 14px 8px;
  border-color: rgb(245 158 11 / 40%);
  background:
    linear-gradient(180deg, var(--warn-weak), transparent 82%), var(--panel);
}

.gb-h {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--warn);
}

.gb-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  padding: 3px 0 0 21px;
}

.gb-go {
  margin-left: auto;
  font-size: 12.5px;
}
/* ---------- 区块 ---------- */
.block {
  padding: 12px 16px 16px;
  margin-bottom: 18px;
}
.bh {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.bt {
  font-weight: 600;
  font-size: 14px;
}
.filter {
  margin-left: auto;
  width: 122px;
  padding: 3px 8px;
  font-size: 12px;
}
.rrow {
  cursor: pointer;
}

/* ---------- 批次行（可展开）/ 批内子运行行 ---------- */
.rrow.batch td {
  background: rgb(148 163 184 / 6%);
}

.rrow.batch:hover td {
  background: var(--hover);
}

.bexp {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.bexp .ic {
  color: var(--text-3);
  transition: transform 0.15s ease-out;
}

.bexp[aria-expanded='true'] .ic {
  transform: rotate(90deg);
}

.bname {
  font-weight: 600;
}

.child .cid {
  padding-left: 26px;
}

.tkey {
  font-size: 12px;
}

.note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  font-size: 12.5px;
  color: var(--text-3);
}

@media (prefers-reduced-motion: reduce) {
  .bexp .ic {
    transition: none;
  }
}

.sum {
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.em {
  color: var(--bad);
}

.run-flash {
  animation: blink 1.2s infinite;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 10px;
}

.trunc {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
@keyframes blink {
  50% {
    opacity: 0.4;
  }
}
</style>
