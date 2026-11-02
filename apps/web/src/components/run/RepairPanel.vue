<script setup lang="ts">
/**
 * 修复面板（R06 修复闭环）：质量修复提案 → 批准 → 执行 → 采纳/拒绝。
 *
 * 基于四维质量评分识别低分维度，生成修复建议并评估影响范围。
 * 修复状态机：proposed → approved → running → completed/cancelled/failed
 * 所有操作均通过 REST 端点，不调用真实付费模型。
 */
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../common/Icon.vue'
import {
  repairsApi,
  type RepairView,
  type RepairProposal,
  type RepairIssue,
  type RepairImpactScope,
} from '../../lib/api/runs'
import { ApiError } from '../../lib/api/core'

// ─── Props ───────────────────────────────────────────────────────────────────

const props = defineProps<{
  runId: number
  episodeIdx: number
}>()

// ─── 状态 ────────────────────────────────────────────────────────────────────

/** 当前修复记录（查询后填充） */
const repair = ref<RepairView | null>(null)

/** 最新提案（propose 成功后填充，用于批准前展示） */
const proposal = ref<RepairProposal | null>(null)

/** 提案返回的修复 id（用于后续查询 / 操作） */
const repairId = ref<string | null>(null)

const loading = ref(false)
const proposing = ref(false)
const operating = ref(false)
const errText = ref('')

/** 轮询定时器（修复执行中定时刷新状态） */
let pollTimer: ReturnType<typeof setInterval> | null = null

// ─── 维度标签映射 ────────────────────────────────────────────────────────────

const DIMENSION_LABELS: Record<string, string> = {
  citation: '引文完整度',
  consistency: '角色一致性',
  coherence: '剧情连贯度',
  cost: '费用效率',
}

// ─── 计算属性 ────────────────────────────────────────────────────────────────

/** 修复状态是否为「待批准」（显示批准/取消按钮） */
const isProposed = computed(() => repair.value?.status === 'proposed' || proposal.value != null)

/** 修复状态是否为「执行中」（显示进度，启动轮询） */
const isRunning = computed(() => {
  const s = repair.value?.status
  return s === 'approved' || s === 'running'
})

/** 修复状态是否为「已完成」（显示采纳/拒绝按钮） */
const isCompleted = computed(() => repair.value?.status === 'completed')

/** 修复状态是否为「终态」（取消/失败/已采纳） */
const isTerminal = computed(() => {
  const s = repair.value?.status
  return s === 'cancelled' || s === 'failed'
})

/** 状态文案 */
const statusText = computed(() => {
  const s = repair.value?.status
  if (!s) return ''
  const map: Record<string, string> = {
    proposed: '待批准',
    approved: '已批准',
    running: '执行中',
    completed: '已完成',
    cancelled: '已取消',
    failed: '失败',
  }
  return map[s] ?? s
})

/** 状态对应的 badge CSS 类名 */
const statusBadgeClass = computed(() => {
  const s = repair.value?.status
  if (!s) return ''
  const map: Record<string, string> = {
    proposed: 'queued',
    approved: 'queued',
    running: 'running',
    completed: 'succeeded',
    cancelled: 'failed',
    failed: 'failed',
  }
  return map[s] ?? ''
})

/** 修复进度百分比（attempt_count / 最大重试次数 3） */
const progressPercent = computed(() => {
  if (!repair.value) return 0
  return Math.min(100, Math.round((repair.value.attemptCount / 3) * 100))
})

/** 修复前后分数提升 */
const scoreImprovement = computed(() => {
  if (!repair.value || repair.value.scoreBefore == null || repair.value.scoreAfter == null)
    return null
  return Math.round((repair.value.scoreAfter - repair.value.scoreBefore) * 100) / 100
})

/** 当前展示的问题列表（优先从 repair 取，其次从 proposal 取） */
const issues = computed<RepairIssue[]>(() => {
  if (repair.value?.issues?.length) return repair.value.issues
  if (proposal.value?.issues?.length) return proposal.value.issues
  return []
})

/** 当前展示的影响范围 */
const impactScope = computed<RepairImpactScope | null>(() => {
  if (repair.value?.impactScope) return repair.value.impactScope
  if (proposal.value?.impactScope) return proposal.value.impactScope
  return null
})

/** 预估费用（优先 proposal 的精确值） */
const estimatedCost = computed(() => {
  if (proposal.value?.estimatedCost != null) return proposal.value.estimatedCost
  if (repair.value?.totalCost != null) return repair.value.totalCost
  return 0
})

// ─── 数据加载 ────────────────────────────────────────────────────────────────

/**
 * 尝试加载已有的修复记录。
 * 当前实现：由于前端不持久化 repairId，每次打开面板时无法反查。
 * 实际场景中应由父组件传入 repairId 或通过 runId 反查。
 * 此处仅作为占位，首次进入时 repair 为 null，等待用户主动触发 propose。
 */
async function loadRepair(): Promise<void> {
  if (!repairId.value) return
  loading.value = true
  errText.value = ''
  try {
    const res = await repairsApi.get(repairId.value)
    repair.value = res.repair
    proposal.value = null
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      repair.value = null
    } else {
      errText.value = err instanceof Error ? err.message : '加载修复记录失败'
    }
  } finally {
    loading.value = false
  }
}

// ─── 操作 ────────────────────────────────────────────────────────────────────

/** 启动修复提案（POST /runs/:id/repair） */
async function doPropose(): Promise<void> {
  proposing.value = true
  errText.value = ''
  proposal.value = null
  repair.value = null
  repairId.value = null
  try {
    const res = await repairsApi.propose(props.runId, props.episodeIdx)
    repairId.value = res.repairId
    proposal.value = res.proposal
    // 立即查询完整状态
    await loadRepair()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '启动修复提案失败'
  } finally {
    proposing.value = false
  }
}

/** 批准修复（POST /repairs/:id/approve） */
async function doApprove(): Promise<void> {
  if (!repairId.value) return
  operating.value = true
  errText.value = ''
  try {
    await repairsApi.approve(repairId.value)
    // 批准后开始轮询执行进度
    await loadRepair()
    startPolling()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '批准修复失败'
  } finally {
    operating.value = false
  }
}

/** 取消修复（POST /repairs/:id/cancel） */
async function doCancel(): Promise<void> {
  if (!repairId.value) return
  operating.value = true
  errText.value = ''
  try {
    await repairsApi.cancel(repairId.value)
    stopPolling()
    await loadRepair()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '取消修复失败'
  } finally {
    operating.value = false
  }
}

/** 采纳修复结果（POST /repairs/:id/accept） */
async function doAccept(): Promise<void> {
  if (!repairId.value) return
  operating.value = true
  errText.value = ''
  try {
    await repairsApi.accept(repairId.value)
    await loadRepair()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '采纳修复失败'
  } finally {
    operating.value = false
  }
}

/** 拒绝修复 / 保留旧版本（POST /repairs/:id/reject） */
async function doReject(): Promise<void> {
  if (!repairId.value) return
  operating.value = true
  errText.value = ''
  try {
    await repairsApi.reject(repairId.value)
    await loadRepair()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '拒绝修复失败'
  } finally {
    operating.value = false
  }
}

// ─── 轮询 ────────────────────────────────────────────────────────────────────

/** 启动轮询（每 3 秒刷新修复状态，直到进入终态） */
function startPolling(): void {
  stopPolling()
  pollTimer = setInterval(async () => {
    await loadRepair()
    if (repair.value && (repair.value.status === 'completed' || repair.value.status === 'cancelled' || repair.value.status === 'failed')) {
      stopPolling()
    }
  }, 3000)
}

/** 停止轮询 */
function stopPolling(): void {
  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// ─── 生命周期 ────────────────────────────────────────────────────────────────

onMounted(() => {
  loadRepair()
})

// runId 或 episodeIdx 变化时重新加载
watch(
  () => [props.runId, props.episodeIdx],
  () => {
    stopPolling()
    repairId.value = null
    repair.value = null
    proposal.value = null
    loadRepair()
  },
)
</script>

<template>
  <div class="panel" style="padding: 14px 16px">
    <!-- 标题行 -->
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px">
      <Icon name="wand" :size="15" />
      <span style="font-size: 13px; font-weight: 600">质量修复</span>
      <span class="chip">第 {{ episodeIdx }} 集</span>
      <span v-if="repair" class="badge" :class="statusBadgeClass" style="margin-left: 4px">
        {{ statusText }}
      </span>
      <span v-if="loading" class="muted" style="margin-left: auto">加载中…</span>
      <button
        v-if="!repair && !loading"
        class="btn sm"
        style="margin-left: auto"
        :disabled="proposing"
        @click="doPropose"
      >
        <Icon :name="proposing ? 'refresh' : 'wand'" :size="12" />
        {{ proposing ? '分析中…' : '启动修复' }}
      </button>
    </div>

    <!-- 错误提示 -->
    <div v-if="errText" class="err-text">{{ errText }}</div>

    <!-- 无修复记录且未触发提案 -->
    <div
      v-if="!loading && !repair && !proposal && !errText"
      class="empty"
      style="padding: 24px 0"
    >
      <Icon name="wand" :size="20" />
      <p style="margin: 8px 0 12px">
        基于四维质量评分识别低分维度，生成定向修复建议。
        <br />点击「启动修复」分析当前集质量问题。
      </p>
      <button class="btn sm" :disabled="proposing" @click="doPropose">
        <Icon :name="proposing ? 'refresh' : 'play'" :size="12" />
        {{ proposing ? '分析中…' : '启动修复' }}
      </button>
    </div>

    <!-- 问题列表（卡片形式） -->
    <template v-if="issues.length > 0">
      <div style="font-size: 12px; font-weight: 500; color: var(--text-2); margin-bottom: 8px">
        <Icon name="alert" :size="12" /> 识别到 {{ issues.length }} 个质量维度低于阈值（{{ issues[0]?.threshold ?? 70 }} 分）
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px">
        <div
          v-for="issue in issues"
          :key="issue.dimension"
          class="card"
          style="padding: 10px 12px"
        >
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px">
            <span style="font-size: 12px; font-weight: 600">
              {{ DIMENSION_LABELS[issue.dimension] ?? issue.dimension }}
            </span>
            <span
              class="badge"
              :class="issue.score >= (issue.threshold ?? 70) ? 'succeeded' : 'failed'"
            >
              {{ Math.round(issue.score) }} 分
            </span>
            <span class="muted" style="font-size: 11px; margin-left: auto">
              阈值 {{ issue.threshold ?? 70 }}
            </span>
          </div>
          <p style="font-size: 11.5px; color: var(--text-2); margin: 0; line-height: 1.5">
            {{ issue.suggestion }}
          </p>
        </div>
      </div>
    </template>

    <!-- 影响范围 -->
    <div
      v-if="impactScope"
      style="
        padding: 10px 12px;
        background: var(--panel-2);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        margin-bottom: 14px;
        font-size: 12px;
      "
    >
      <div style="display: flex; align-items: center; gap: 5px; margin-bottom: 8px; font-weight: 500; color: var(--text-2)">
        <Icon name="layers" :size="12" />
        <span>影响范围</span>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; color: var(--text-2)">
        <span>受影响运行</span>
        <span class="mono" style="color: var(--text)">
          {{ impactScope.affectedRunIds.length }} 个
        </span>
        <span>受影响集号</span>
        <span class="mono" style="color: var(--text)">
          {{ impactScope.affectedEpisodes.length > 0
            ? impactScope.affectedEpisodes.join(', ')
            : '—' }}
        </span>
        <span>共享数据源</span>
        <span class="mono" style="color: var(--text)">
          {{ impactScope.sharedSources.length }} 条
        </span>
        <span>预估费用</span>
        <span class="mono" style="color: var(--text)">
          ¥{{ estimatedCost.toFixed(2) }}
        </span>
      </div>
    </div>

    <!-- 操作按钮区（根据状态动态显示） -->
    <div v-if="repair || proposal" style="display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap">
      <!-- proposed 状态：批准 / 取消 -->
      <template v-if="repair?.status === 'proposed' || (proposal && !repair)">
        <button
          class="btn sm primary"
          :disabled="operating"
          @click="doApprove"
        >
          <Icon name="check" :size="12" />
          {{ operating ? '处理中…' : '批准修复' }}
        </button>
        <button
          class="btn sm"
          :disabled="operating"
          @click="doCancel"
        >
          <Icon name="x" :size="12" /> 取消
        </button>
      </template>

      <!-- running / approved 状态：可取消 -->
      <template v-if="isRunning">
        <button
          class="btn sm"
          :disabled="operating"
          @click="doCancel"
        >
          <Icon name="x" :size="12" />
          {{ operating ? '处理中…' : '取消修复' }}
        </button>
      </template>

      <!-- completed 状态：采纳 / 拒绝 -->
      <template v-if="isCompleted">
        <button
          class="btn sm primary"
          :disabled="operating"
          @click="doAccept"
        >
          <Icon name="check" :size="12" />
          {{ operating ? '处理中…' : '采纳修复' }}
        </button>
        <button
          class="btn sm"
          :disabled="operating"
          @click="doReject"
        >
          <Icon name="undo" :size="12" /> 保留旧版本
        </button>
      </template>

      <!-- terminal 状态：可重新发起 -->
      <template v-if="isTerminal">
        <button
          class="btn sm"
          :disabled="proposing"
          @click="doPropose"
        >
          <Icon name="refresh" :size="12" />
          {{ proposing ? '分析中…' : '重新修复' }}
        </button>
      </template>
    </div>

    <!-- 修复进度（执行中或已完成时显示） -->
    <div
      v-if="repair && (isRunning || isCompleted || isTerminal)"
      style="
        padding: 10px 12px;
        background: var(--code-bg);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        font-size: 12px;
      "
    >
      <div style="display: flex; align-items: center; gap: 5px; margin-bottom: 8px; font-weight: 500; color: var(--text-2)">
        <Icon name="chart" :size="12" />
        <span>修复进度</span>
        <span v-if="isRunning" class="muted" style="margin-left: auto">
          <Icon name="refresh" :size="11" /> 自动刷新中
        </span>
      </div>

      <!-- 进度条 -->
      <div
        v-if="isRunning"
        style="
          height: 6px;
          background: var(--panel-2);
          border-radius: 3px;
          overflow: hidden;
          margin-bottom: 10px;
        "
      >
        <div
          :style="{
            width: progressPercent + '%',
            height: '100%',
            background: 'var(--accent)',
            borderRadius: '3px',
            transition: 'width 0.3s ease',
          }"
        />
      </div>

      <!-- 进度数字 -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; color: var(--text-2)">
        <span>尝试次数</span>
        <span class="mono" style="color: var(--text)">
          {{ repair.attemptCount }} / 3
        </span>
        <span>累计费用</span>
        <span class="mono" style="color: var(--text)">
          ¥{{ repair.totalCost.toFixed(2) }}
        </span>
        <span v-if="repair.scoreBefore != null">修复前分数</span>
        <span v-if="repair.scoreBefore != null" class="mono" style="color: var(--text)">
          {{ Math.round(repair.scoreBefore) }} 分
        </span>
        <span v-if="repair.scoreAfter != null">修复后分数</span>
        <span
          v-if="repair.scoreAfter != null"
          class="mono"
          :style="{ color: scoreImprovement != null && scoreImprovement > 0 ? 'var(--ok)' : 'var(--text)' }"
        >
          {{ Math.round(repair.scoreAfter) }} 分
          <span v-if="scoreImprovement != null" style="font-size: 11px">
            （{{ scoreImprovement > 0 ? '+' : '' }}{{ scoreImprovement }}）
          </span>
        </span>
        <span v-if="repair.stopReason">终止原因</span>
        <span v-if="repair.stopReason" style="color: var(--text); font-size: 11px; word-break: break-all">
          {{ repair.stopReason }}
        </span>
      </div>
    </div>
  </div>
</template>
