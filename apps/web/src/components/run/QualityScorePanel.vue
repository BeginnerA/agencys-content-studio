<script setup lang="ts">
/**
 * 质量评分面板（R01 基线）：四维雷达图 + 分项进度条 + 权重调整 + 元数据展示。
 *
 * 四个评分维度：引文完整度 / 角色一致性 / 剧情连贯度 / 费用效率。
 * 雷达图用 SVG 原生绘制，不依赖第三方图表库。
 * 权重默认 0.3/0.3/0.2/0.2，用户可通过滑块调整（总和恒为 1）。
 * 评分触发走 POST /runs/:id/quality，不调用真实付费模型。
 */
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../common/Icon.vue'
import { qualityApi, type QualityScoreView } from '../../lib/api/runs'
import { ApiError } from '../../lib/api/core'

// ─── Props ───────────────────────────────────────────────────────────────────

const props = defineProps<{
  runId: number
  episodeIdx: number
}>()

// ─── 状态 ────────────────────────────────────────────────────────────────────

const score = ref<QualityScoreView | null>(null)
const createdAt = ref<string | null>(null)
const loading = ref(false)
const scoring = ref(false)
const errText = ref('')
const showWeights = ref(false)

// 权重（默认 0.3/0.3/0.2/0.2）
const weights = ref({
  citation: 0.3,
  consistency: 0.3,
  coherence: 0.2,
  cost: 0.2,
})

// ─── 维度定义 ────────────────────────────────────────────────────────────────

interface Dimension {
  key: keyof QualityScoreView
  label: string
  weightKey: keyof typeof weights.value
  color: string
}

const dimensions: Dimension[] = [
  {
    key: 'citationScore',
    label: '引文完整度',
    weightKey: 'citation',
    color: '#8b5cf6',
  },
  {
    key: 'consistencyScore',
    label: '角色一致性',
    weightKey: 'consistency',
    color: '#6366f1',
  },
  {
    key: 'coherenceScore',
    label: '剧情连贯度',
    weightKey: 'coherence',
    color: '#4f46e5',
  },
  { key: 'costScore', label: '费用效率', weightKey: 'cost', color: '#4ade80' },
]

// ─── 计算属性 ────────────────────────────────────────────────────────────────

/** 综合分百分比（0~100） */
const overallPercent = computed(() => {
  if (!score.value) return 0
  return Math.round(score.value.overallScore * 100)
})

/** 综合分等级文案 */
const overallGrade = computed(() => {
  const p = overallPercent.value
  if (p >= 90) return '优秀'
  if (p >= 70) return '良好'
  if (p >= 50) return '一般'
  return '待改进'
})

/** 权重总和（用于校验） */
const weightSum = computed(() =>
  Object.values(weights.value).reduce((a, b) => a + b, 0),
)

/** 权重归一化后的值（确保总和为 1） */
const normalizedWeights = computed(() => {
  const sum = weightSum.value
  if (sum === 0)
    return { citation: 0.25, consistency: 0.25, coherence: 0.25, cost: 0.25 }
  return {
    citation: weights.value.citation / sum,
    consistency: weights.value.consistency / sum,
    coherence: weights.value.coherence / sum,
    cost: weights.value.cost / sum,
  }
})

// ─── 雷达图 SVG 计算 ─────────────────────────────────────────────────────────

/** 雷达图参数 */
const radarSize = 200
const radarCenter = radarSize / 2
const radarRadius = 75
const radarLevels = [0.25, 0.5, 0.75, 1.0]

/** 计算雷达图各顶点坐标 */
function radarPoint(index: number, value: number): { x: number; y: number } {
  const angle = (Math.PI * 2 * index) / 4 - Math.PI / 2 // 从顶部开始顺时针
  const r = radarRadius * value
  return {
    x: radarCenter + r * Math.cos(angle),
    y: radarCenter + r * Math.sin(angle),
  }
}

/** 雷达图数据多边形路径 */
const radarPath = computed(() => {
  if (!score.value) return ''
  const values = [
    score.value.citationScore,
    score.value.consistencyScore,
    score.value.coherenceScore,
    score.value.costScore,
  ]
  const points = values.map((v, i) => radarPoint(i, v))
  return (
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z'
  )
})

/** 雷达图网格层路径（正方形网格） */
const radarGridPaths = computed(() =>
  radarLevels.map((level) => {
    const points = [0, 1, 2, 3].map((i) => radarPoint(i, level))
    return (
      points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') +
      ' Z'
    )
  }),
)

/** 雷达图轴线 */
const radarAxes = computed(() =>
  [0, 1, 2, 3].map((i) => {
    const p = radarPoint(i, 1)
    return { x1: radarCenter, y1: radarCenter, x2: p.x, y2: p.y }
  }),
)

/** 雷达图维度标签位置 */
const radarLabels = computed(() =>
  dimensions.map((dim, i) => {
    const p = radarPoint(i, 1.25)
    return { ...p, label: dim.label, color: dim.color }
  }),
)

// ─── 数据加载 ────────────────────────────────────────────────────────────────

async function loadScore(): Promise<void> {
  loading.value = true
  errText.value = ''
  try {
    const res = await qualityApi.getEpisode(props.runId, props.episodeIdx)
    score.value = res.score
    createdAt.value = res.createdAt
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // 尚未评分，不视为错误
      score.value = null
      createdAt.value = null
    } else {
      errText.value = err instanceof Error ? err.message : '加载评分失败'
    }
  } finally {
    loading.value = false
  }
}

/** 触发评分（POST /runs/:id/quality） */
async function triggerScore(): Promise<void> {
  scoring.value = true
  errText.value = ''
  try {
    const res = await qualityApi.score(props.runId, {
      episodeIdx: props.episodeIdx,
      weights: normalizedWeights.value,
    })
    score.value = res.score
    createdAt.value = new Date().toISOString()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : '评分失败'
  } finally {
    scoring.value = false
  }
}

/** 重置权重为默认值 */
function resetWeights(): void {
  weights.value = { citation: 0.3, consistency: 0.3, coherence: 0.2, cost: 0.2 }
}

// ─── 生命周期 ────────────────────────────────────────────────────────────────

onMounted(() => {
  loadScore()
})

// runId 或 episodeIdx 变化时重新加载
watch(
  () => [props.runId, props.episodeIdx],
  () => loadScore(),
)
</script>

<template>
  <div class="panel" style="padding: 14px 16px">
    <!-- 标题行 -->
    <div
      style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px"
    >
      <Icon name="shield-check" :size="15" />
      <span style="font-size: 13px; font-weight: 600">质量评分</span>
      <span class="chip">第 {{ episodeIdx }} 集</span>
      <span v-if="loading" class="muted" style="margin-left: auto"
        >加载中…</span
      >
      <button
        v-if="!loading"
        class="btn sm"
        style="margin-left: auto"
        :disabled="scoring"
        @click="triggerScore"
      >
        <Icon :name="scoring ? 'refresh' : 'play'" :size="12" />
        {{ scoring ? '评分中…' : score ? '重新评分' : '评分' }}
      </button>
    </div>

    <!-- 错误提示 -->
    <div v-if="errText" class="err-text">{{ errText }}</div>

    <!-- 无评分数据 -->
    <div
      v-if="!loading && !score && !errText"
      class="empty"
      style="padding: 24px 0"
    >
      <Icon name="bar-chart-2" :size="20" />
      <p style="margin: 8px 0 12px">尚未评分，点击「评分」按钮触发四维评估</p>
    </div>

    <!-- 评分结果展示 -->
    <template v-if="score">
      <!-- 综合分 + 雷达图 -->
      <div
        style="
          display: flex;
          gap: 16px;
          align-items: flex-start;
          margin-bottom: 14px;
        "
      >
        <!-- 综合分 -->
        <div style="flex: none; text-align: center; min-width: 80px">
          <div
            style="
              font-size: 32px;
              font-weight: 700;
              line-height: 1;
              font-variant-numeric: tabular-nums;
            "
            :style="{
              color:
                overallPercent >= 70
                  ? 'var(--ok)'
                  : overallPercent >= 50
                    ? 'var(--warn)'
                    : 'var(--bad)',
            }"
          >
            {{ overallPercent }}
          </div>
          <div class="muted" style="margin-top: 4px">综合分</div>
          <span
            class="badge"
            :class="
              overallPercent >= 70
                ? 'succeeded'
                : overallPercent >= 50
                  ? 'queued'
                  : 'failed'
            "
            style="margin-top: 6px"
          >
            {{ overallGrade }}
          </span>
        </div>

        <!-- 雷达图 SVG -->
        <div style="flex: 1; display: flex; justify-content: center">
          <svg
            :width="radarSize"
            :height="radarSize"
            :viewBox="`0 0 ${radarSize} ${radarSize}`"
            style="overflow: visible"
          >
            <!-- 网格层 -->
            <path
              v-for="(path, idx) in radarGridPaths"
              :key="'grid-' + idx"
              :d="path"
              fill="none"
              stroke="var(--border)"
              stroke-width="0.5"
            />
            <!-- 轴线 -->
            <line
              v-for="(axis, idx) in radarAxes"
              :key="'axis-' + idx"
              :x1="axis.x1"
              :y1="axis.y1"
              :x2="axis.x2"
              :y2="axis.y2"
              stroke="var(--border)"
              stroke-width="0.5"
            />
            <!-- 数据区域 -->
            <path
              :d="radarPath"
              fill="rgb(139 92 246 / 20%)"
              stroke="var(--accent-h)"
              stroke-width="1.5"
            />
            <!-- 数据点 -->
            <circle
              v-for="(dim, idx) in dimensions"
              :key="'dot-' + idx"
              :cx="radarPoint(idx, score[dim.key] as number).x"
              :cy="radarPoint(idx, score[dim.key] as number).y"
              r="3"
              :fill="dim.color"
            />
            <!-- 维度标签 -->
            <text
              v-for="(lbl, idx) in radarLabels"
              :key="'lbl-' + idx"
              :x="lbl.x"
              :y="lbl.y"
              text-anchor="middle"
              dominant-baseline="middle"
              fill="var(--text-2)"
              font-size="10"
            >
              {{ lbl.label }}
            </text>
          </svg>
        </div>
      </div>

      <!-- 四维分项得分（进度条） -->
      <div
        style="
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 14px;
        "
      >
        <div
          v-for="dim in dimensions"
          :key="dim.key"
          style="display: flex; align-items: center; gap: 8px"
        >
          <span
            style="
              width: 72px;
              font-size: 12px;
              color: var(--text-2);
              flex: none;
            "
          >
            {{ dim.label }}
          </span>
          <div
            style="
              flex: 1;
              height: 6px;
              background: var(--panel-2);
              border-radius: 3px;
              overflow: hidden;
            "
          >
            <div
              :style="{
                width: Math.round((score[dim.key] as number) * 100) + '%',
                height: '100%',
                background: dim.color,
                borderRadius: '3px',
                transition: 'width 0.3s ease',
              }"
            />
          </div>
          <span
            style="
              width: 36px;
              text-align: right;
              font-size: 12px;
              font-variant-numeric: tabular-nums;
              color: var(--text);
            "
          >
            {{ Math.round((score[dim.key] as number) * 100) }}
          </span>
        </div>
      </div>

      <!-- 权重调整区 -->
      <div style="margin-bottom: 14px">
        <button
          class="btn sm"
          style="width: 100%; justify-content: space-between"
          @click="showWeights = !showWeights"
        >
          <span style="display: flex; align-items: center; gap: 5px">
            <Icon name="sliders" :size="12" /> 权重调整
          </span>
          <Icon
            :name="showWeights ? 'chevron-up' : 'chevron-down'"
            :size="11"
          />
        </button>
        <div
          v-if="showWeights"
          style="
            margin-top: 8px;
            padding: 10px 12px;
            background: var(--panel-2);
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
          "
        >
          <div
            v-for="dim in dimensions"
            :key="'w-' + dim.weightKey"
            style="
              display: flex;
              align-items: center;
              gap: 8px;
              margin-bottom: 6px;
            "
          >
            <span
              style="
                width: 72px;
                font-size: 11px;
                color: var(--text-2);
                flex: none;
              "
            >
              {{ dim.label }}
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="weights[dim.weightKey]"
              style="flex: 1; accent-color: var(--accent)"
              @input="
                (e) => {
                  weights[dim.weightKey] = parseFloat(
                    (e.target as HTMLInputElement).value,
                  )
                }
              "
            />
            <span
              style="
                width: 32px;
                text-align: right;
                font-size: 11px;
                font-variant-numeric: tabular-nums;
                color: var(--text-2);
              "
            >
              {{ weights[dim.weightKey].toFixed(2) }}
            </span>
          </div>
          <div
            style="
              display: flex;
              align-items: center;
              justify-content: space-between;
              margin-top: 4px;
            "
          >
            <span class="muted">
              权重总和：{{ weightSum.toFixed(2) }}
              <span
                v-if="Math.abs(weightSum - 1) > 0.01"
                style="color: var(--warn)"
                >（将自动归一化）</span
              >
            </span>
            <button class="btn sm" @click="resetWeights">重置</button>
          </div>
        </div>
      </div>

      <!-- 评分元数据 -->
      <div
        v-if="score.metadata"
        style="
          padding: 10px 12px;
          background: var(--code-bg);
          border-radius: var(--radius-sm);
          border: 1px solid var(--border);
          font-size: 11px;
        "
      >
        <div
          style="
            display: flex;
            align-items: center;
            gap: 5px;
            margin-bottom: 6px;
            color: var(--text-2);
          "
        >
          <Icon name="info" :size="11" />
          <span style="font-weight: 500">评分元数据</span>
          <span v-if="createdAt" class="muted" style="margin-left: auto">
            {{ new Date(createdAt).toLocaleString() }}
          </span>
        </div>
        <div
          style="
            display: grid;
            grid-template-columns: 80px 1fr;
            gap: 3px 8px;
            color: var(--text-2);
          "
        >
          <span>模板版本</span>
          <span class="mono" style="color: var(--text)">{{
            score.metadata.templateVersion || '—'
          }}</span>
          <span>提示词版本</span>
          <span class="mono" style="color: var(--text)">{{
            score.metadata.promptVersion || '—'
          }}</span>
          <span>模型</span>
          <span class="mono" style="color: var(--text)">{{
            score.metadata.model || '—'
          }}</span>
          <span v-if="Object.keys(score.metadata.assetVersions).length > 0">
            资产版本
          </span>
          <span
            v-if="Object.keys(score.metadata.assetVersions).length > 0"
            class="mono"
            style="color: var(--text); font-size: 10px; word-break: break-all"
          >
            {{
              Object.entries(score.metadata.assetVersions)
                .map(([k, v]) => `${k}→${v}`)
                .join('; ')
            }}
          </span>
        </div>
      </div>
    </template>
  </div>
</template>
