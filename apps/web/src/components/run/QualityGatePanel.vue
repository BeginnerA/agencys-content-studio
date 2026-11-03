<script setup lang="ts">
/**
 * 质量门禁面板：五阶段流水线检查 + 问题清单 + 豁免操作。
 *
 * 五个阶段依次覆盖大纲、分集、分场、台词、成片，每阶段独立门禁状态。
 * 点击阶段标签加载该阶段的详细问题列表，支持 blocking 问题的豁免与取消豁免。
 */
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../common/Icon.vue'
import { qualityGatesApi } from '../../lib/api/runs'

// ─── Props ───────────────────────────────────────────────────────────────────

const props = defineProps<{
  runId: number
  episodeIdx: number
}>()

// ─── 类型定义 ────────────────────────────────────────────────────────────────

interface GateStatus {
  runId: number
  episodeIdx: number
  stage: string
  status: 'pending' | 'pass' | 'fail' | 'exempt'
  blockingCount: number
  warningCount: number
  exemptCount: number
  checkedAt: string | null
}

interface QualityIssue {
  id: number
  runId: number
  episodeIdx: number
  stage: string
  checker: string
  dimension: string
  severity: string
  checkType: string
  targetType: string
  targetId: string
  evidence: Record<string, unknown>
  suggestion: string
  exempted: boolean
  exemptedBy: string | null
  exemptedAt: string | null
  exemptReason: string | null
  createdAt: string
}

// ─── 阶段定义 ────────────────────────────────────────────────────────────────

interface StageDef {
  key: string
  label: string
}

const stages: StageDef[] = [
  { key: 'outline', label: '大纲' },
  { key: 'episode', label: '分集' },
  { key: 'scene', label: '分场' },
  { key: 'dialogue', label: '台词' },
  { key: 'final', label: '成片' },
]

// ─── 状态 ────────────────────────────────────────────────────────────────────

const gates = ref<GateStatus[]>([])
const selectedStage = ref<string | null>(null)
const stageIssues = ref<QualityIssue[]>([])
const loading = ref(false)
const triggering = ref(false)
const loadingIssues = ref(false)
const errText = ref('')

/** 豁免弹窗：当前正在操作的问题 id */
const exemptingId = ref<number | null>(null)
const exemptReason = ref('')
const exemptSubmitting = ref(false)

// ─── 计算属性 ────────────────────────────────────────────────────────────────

/** 按阶段索引查找门禁状态 */
function gateForStage(stageKey: string): GateStatus | undefined {
  return gates.value.find((g) => g.stage === stageKey)
}

/** 当前选中阶段的门禁状态 */
const selectedGate = computed(() =>
  selectedStage.value ? gateForStage(selectedStage.value) : null,
)

/** 状态图标映射 */
function statusIcon(status: string): string {
  switch (status) {
    case 'pass':
      return 'check'
    case 'fail':
      return 'x'
    case 'exempt':
      return 'shield'
    default:
      return 'circle'
  }
}

/** 状态颜色类名 */
function statusColor(status: string): string {
  switch (status) {
    case 'pass':
      return 'var(--ok)'
    case 'fail':
      return 'var(--bad)'
    case 'exempt':
      return 'var(--warn)'
    default:
      return 'var(--text-2)'
  }
}

/** 严重程度 badge 类名 */
function severityBadgeClass(severity: string): string {
  switch (severity) {
    case 'blocking':
      return 'failed'
    case 'warning':
      return 'queued'
    default:
      return ''
  }
}

/** evidence 摘要文本（取前 3 个键值对） */
function evidenceSummary(evidence: Record<string, unknown>): string {
  const entries = Object.entries(evidence).slice(0, 3)
  if (entries.length === 0) return ''
  return entries
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}: ${val.length > 40 ? val.slice(0, 40) + '...' : val}`
    })
    .join('; ')
}

// ─── 数据加载 ────────────────────────────────────────────────────────────────

/** 加载全部门禁状态 */
async function loadGates(): Promise<void> {
  loading.value = true
  errText.value = ''
  try {
    const res = await qualityGatesApi.getAll(props.runId, props.episodeIdx)
    gates.value = res.gates
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '加载门禁失败'
  } finally {
    loading.value = false
  }
}

/** 加载指定阶段的问题列表 */
async function loadStageIssues(stage: string): Promise<void> {
  loadingIssues.value = true
  stageIssues.value = []
  try {
    const res = await qualityGatesApi.getStage(props.runId, stage, props.episodeIdx)
    stageIssues.value = res.issues
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '加载问题列表失败'
  } finally {
    loadingIssues.value = false
  }
}

/** 触发全部门禁检查 */
async function triggerAll(): Promise<void> {
  triggering.value = true
  errText.value = ''
  try {
    const res = await qualityGatesApi.triggerAll(props.runId, props.episodeIdx)
    gates.value = res.gates
    // 如果当前已选中阶段，刷新其问题列表
    if (selectedStage.value) {
      await loadStageIssues(selectedStage.value)
    }
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '触发检查失败'
  } finally {
    triggering.value = false
  }
}

/** 选择阶段标签 */
function selectStage(stageKey: string): void {
  if (selectedStage.value === stageKey) {
    selectedStage.value = null
    stageIssues.value = []
    return
  }
  selectedStage.value = stageKey
  loadStageIssues(stageKey)
}

/** 提交豁免 */
async function submitExempt(issueId: number): Promise<void> {
  if (!exemptReason.value.trim()) return
  exemptSubmitting.value = true
  try {
    await qualityGatesApi.exemptIssue(issueId, exemptReason.value.trim())
    exemptingId.value = null
    exemptReason.value = ''
    // 刷新当前阶段问题列表与门禁状态
    if (selectedStage.value) {
      await loadStageIssues(selectedStage.value)
    }
    await loadGates()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '豁免失败'
  } finally {
    exemptSubmitting.value = false
  }
}

/** 取消豁免 */
async function cancelExempt(issueId: number): Promise<void> {
  exemptSubmitting.value = true
  try {
    await qualityGatesApi.unexemptIssue(issueId)
    // 刷新当前阶段问题列表与门禁状态
    if (selectedStage.value) {
      await loadStageIssues(selectedStage.value)
    }
    await loadGates()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '取消豁免失败'
  } finally {
    exemptSubmitting.value = false
  }
}

// ─── 生命周期 ────────────────────────────────────────────────────────────────

onMounted(() => {
  loadGates()
})

watch(
  () => [props.runId, props.episodeIdx],
  () => {
    selectedStage.value = null
    stageIssues.value = []
    loadGates()
  },
)
</script>

<template>
  <div class="panel" style="padding: 14px 16px">
    <!-- 标题行 -->
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px">
      <Icon name="shield" :size="15" />
      <span style="font-size: 13px; font-weight: 600">质量门禁</span>
      <span class="chip">第 {{ episodeIdx }} 集</span>
      <span v-if="loading" class="muted" style="margin-left: auto">加载中...</span>
      <button
        class="btn sm"
        style="margin-left: auto"
        :disabled="triggering || loading"
        @click="triggerAll"
      >
        <Icon :name="triggering ? 'refresh' : 'play'" :size="12" />
        {{ triggering ? '检查中...' : '运行全部检查' }}
      </button>
    </div>

    <!-- 错误提示 -->
    <div v-if="errText" class="err-text">{{ errText }}</div>

    <!-- 阶段时间线（横向步骤条） -->
    <div
      v-if="!loading"
      style="
        display: flex;
        align-items: center;
        gap: 0;
        margin-bottom: 14px;
        padding: 8px 0;
        overflow-x: auto;
      "
    >
      <template v-for="(stage, idx) in stages" :key="stage.key">
        <!-- 阶段节点 -->
        <button
          class="stage-node"
          :class="{ active: selectedStage === stage.key }"
          @click="selectStage(stage.key)"
        >
          <!-- 状态图标 -->
          <span
            class="stage-icon"
            :style="{ color: statusColor(gateForStage(stage.key)?.status ?? 'pending') }"
          >
            <Icon :name="statusIcon(gateForStage(stage.key)?.status ?? 'pending')" :size="14" />
          </span>
          <span class="stage-label">{{ stage.label }}</span>
          <!-- 计数 -->
          <span v-if="gateForStage(stage.key)" class="stage-counts">
            <span v-if="gateForStage(stage.key)!.blockingCount > 0" class="count-bad">
              {{ gateForStage(stage.key)!.blockingCount }}
            </span>
            <span v-if="gateForStage(stage.key)!.warningCount > 0" class="count-warn">
              {{ gateForStage(stage.key)!.warningCount }}
            </span>
            <span v-if="gateForStage(stage.key)!.exemptCount > 0" class="count-exempt">
              {{ gateForStage(stage.key)!.exemptCount }}
            </span>
          </span>
        </button>
        <!-- 连接线 -->
        <div
          v-if="idx < stages.length - 1"
          class="stage-connector"
          :style="{
            background:
              gateForStage(stage.key)?.status === 'pass'
                ? 'var(--ok)'
                : gateForStage(stage.key)?.status === 'fail'
                  ? 'var(--bad)'
                  : 'var(--border)',
          }"
        />
      </template>
    </div>

    <!-- 加载中占位 -->
    <div v-if="loading" class="empty" style="padding: 20px 0">
      <Icon name="refresh" :size="18" />
      <p style="margin: 8px 0 0">加载门禁状态...</p>
    </div>

    <!-- 无数据占位 -->
    <div v-if="!loading && gates.length === 0 && !errText" class="empty" style="padding: 20px 0">
      <Icon name="shield" :size="20" />
      <p style="margin: 8px 0 12px">尚未运行门禁检查，点击「运行全部检查」启动五阶段质量门禁</p>
    </div>

    <!-- 问题列表 -->
    <div v-if="selectedStage && !loadingIssues && stageIssues.length > 0">
      <div style="font-size: 12px; font-weight: 500; color: var(--text-2); margin-bottom: 8px">
        <Icon name="alert" :size="12" />
        {{ selectedGate?.status === 'pass' ? '全部通过' : `${stageIssues.length} 个问题` }}
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px">
        <div
          v-for="issue in stageIssues"
          :key="issue.id"
          class="card"
          style="padding: 10px 12px"
        >
          <!-- 问题头部：checker + 维度 + 严重程度 -->
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap">
            <span style="font-size: 12px; font-weight: 600">{{ issue.checker }}</span>
            <span class="badge" :class="severityBadgeClass(issue.severity)">
              {{ issue.severity === 'blocking' ? '阻断' : issue.severity === 'warning' ? '警告' : issue.severity }}
            </span>
            <span class="chip" style="font-size: 10px">{{ issue.dimension }}</span>
            <!-- 已豁免标记 -->
            <span v-if="issue.exempted" class="badge" style="background: var(--warn-weak, rgb(234 179 8 / 15%)); color: var(--warn)">
              已豁免
            </span>
          </div>

          <!-- evidence 摘要 -->
          <div
            v-if="Object.keys(issue.evidence).length > 0"
            class="mono"
            style="font-size: 11px; color: var(--text-2); margin-bottom: 6px; word-break: break-all; line-height: 1.5"
          >
            {{ evidenceSummary(issue.evidence) }}
          </div>

          <!-- 建议 -->
          <p v-if="issue.suggestion" style="font-size: 11.5px; color: var(--text-2); margin: 0 0 8px; line-height: 1.5">
            {{ issue.suggestion }}
          </p>

          <!-- 豁免原因展示 -->
          <div
            v-if="issue.exempted && issue.exemptReason"
            style="
              font-size: 11px;
              color: var(--text-2);
              padding: 6px 8px;
              background: var(--panel-2);
              border-radius: var(--radius-sm);
              margin-bottom: 8px;
            "
          >
            豁免原因：{{ issue.exemptReason }}
          </div>

          <!-- 操作按钮 -->
          <div style="display: flex; gap: 6px; align-items: center">
            <!-- 未豁免的 blocking 问题：显示豁免按钮 -->
            <template v-if="!issue.exempted && issue.severity === 'blocking'">
              <button
                v-if="exemptingId !== issue.id"
                class="btn sm"
                style="font-size: 11px; padding: 2px 8px"
                :disabled="exemptSubmitting"
                @click="exemptingId = issue.id; exemptReason = ''"
              >
                豁免
              </button>
              <!-- 豁免输入框 -->
              <div
                v-else
                style="display: flex; gap: 4px; align-items: center; flex: 1"
              >
                <input
                  v-model="exemptReason"
                  type="text"
                  placeholder="豁免原因..."
                  style="
                    flex: 1;
                    font-size: 11px;
                    padding: 3px 6px;
                    border: 1px solid var(--border);
                    border-radius: var(--radius-sm);
                    background: var(--panel-2);
                    color: var(--text);
                    outline: none;
                  "
                  @keydown.enter="submitExempt(issue.id)"
                />
                <button
                  class="btn sm primary"
                  style="font-size: 11px; padding: 2px 8px"
                  :disabled="exemptSubmitting || !exemptReason.trim()"
                  @click="submitExempt(issue.id)"
                >
                  确认
                </button>
                <button
                  class="btn sm"
                  style="font-size: 11px; padding: 2px 8px"
                  @click="exemptingId = null; exemptReason = ''"
                >
                  取消
                </button>
              </div>
            </template>
            <!-- 已豁免的问题：显示取消豁免按钮 -->
            <button
              v-if="issue.exempted"
              class="btn sm"
              style="font-size: 11px; padding: 2px 8px"
              :disabled="exemptSubmitting"
              @click="cancelExempt(issue.id)"
            >
              取消豁免
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 选中阶段但无问题 -->
    <div
      v-if="selectedStage && !loadingIssues && stageIssues.length === 0 && gates.length > 0"
      class="empty"
      style="padding: 16px 0"
    >
      <Icon name="check" :size="16" />
      <p style="margin: 6px 0 0; font-size: 12px">该阶段无问题或尚未检查</p>
    </div>

    <!-- 加载问题中 -->
    <div v-if="loadingIssues" class="muted" style="text-align: center; padding: 12px 0; font-size: 12px">
      <Icon name="refresh" :size="12" /> 加载问题列表...
    </div>
  </div>
</template>

<style scoped>
.stage-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  min-width: 56px;
  font-family: inherit;
}

.stage-node:hover {
  border-color: var(--accent);
  background: var(--accent-weak, rgb(99 102 241 / 8%));
}

.stage-node.active {
  border-color: var(--accent);
  background: var(--accent-weak, rgb(99 102 241 / 12%));
}

.stage-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.stage-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text);
}

.stage-counts {
  display: flex;
  gap: 4px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.count-bad {
  color: var(--bad);
}

.count-warn {
  color: var(--warn);
}

.count-exempt {
  color: var(--text-2);
}

.stage-connector {
  width: 20px;
  height: 2px;
  flex: none;
  border-radius: 1px;
}
</style>
