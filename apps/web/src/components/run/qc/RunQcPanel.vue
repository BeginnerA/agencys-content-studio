<script setup lang="ts">
/**
 * 第四期 · 统一 QC 面板（只读成片质量核验）——运行详情右栏辅助面板，与「合成返修 / 导出包」同级（规格 §6）。
 * - 自治探测：挂载先读缓存（refresh=0），无成片 / run 不存在（后端 404 no_final_video/not_found）→ 整体隐藏，不打扰。
 * - 只读硬约束：仅呈现后端客观测量 / 一致性结论 / 缺项清单；不在前端推算 Σ、clamp 或 verdict，无任何写 / 重合成按钮。
 * - 面板不等于质量通过：主观项（视觉一致性 / 道具连续 / 听感失真）恒列缺项待人工，交付放行仍走既有批准链。
 */
import { onMounted, ref } from 'vue'
import Icon from '../../common/Icon.vue'
import { qcApi } from '../../../lib/api/qc'
import { ApiError } from '../../../lib/api/core'
import type { QcCheckView, QcReportView, QcStatus, QcVerdict } from '../../../lib/types/qc'

const props = defineProps<{ runId: number }>()

const report = ref<QcReportView | null>(null)
const loading = ref(false)
const hidden = ref(false)
const errText = ref('')

const KEY_TEXT: Record<QcCheckView['key'], string> = {
  file_readable: '文件可读',
  stream_spec: '容器 / 流规格',
  duration_vs_timeline: '实测时长 vs 声明总长',
  timeline_source: '时间轴快照来源',
  rework_receipt_consistency: '返修回执一致性',
  shot_duration_applied: '镜头时长已入轴',
  subtitle_alignment_present: '字幕结构对齐',
  audio_peak: '音频真峰值（客观）',
  delivery_flag: '交付标记（只读）',
  manual_quality_review: '主观人工复核',
}

// 状态徽标复用全局 .badge 语义修饰（主题 token 同源，不新造配色）
const STATUS_BADGE: Record<QcStatus, string> = {
  passed: 'succeeded',
  failed: 'failed',
  stale: 'queued',
  not_tested: 'skip',
  unsupported: 'skip',
  not_applicable: 'cancelled',
}
const STATUS_TEXT: Record<QcStatus, string> = {
  passed: '通过',
  failed: '未通过',
  stale: '待重算',
  not_tested: '未测',
  unsupported: '不支持',
  not_applicable: '不适用',
}
const VERDICT_BADGE: Record<QcVerdict, string> = {
  ready: 'succeeded',
  needs_review: 'queued',
  not_ready: 'failed',
}
const VERDICT_TEXT: Record<QcVerdict, string> = {
  ready: '可交付（客观项）',
  needs_review: '需复核',
  not_ready: '未就绪',
}

const fmtVal = (v: QcCheckView['value']): string =>
  v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? '是' : '否') : String(v)

async function load(refresh: boolean): Promise<void> {
  loading.value = true
  errText.value = ''
  try {
    report.value = await qcApi.get(props.runId, refresh)
    hidden.value = false
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'no_final_video' || e.code === 'not_found')) {
      hidden.value = true // 无成片：整体隐藏，不打扰（能力探测驱动显隐）
    } else {
      errText.value = e instanceof ApiError ? e.message : '核验失败'
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => load(false))
</script>

<template>
  <div v-if="!hidden" class="panel mini">
    <div class="lhead">
      <span class="lt"><Icon name="shield" :size="13" /> 质量核验</span>
      <span v-if="report" class="badge" :class="VERDICT_BADGE[report.verdict]">
        {{ VERDICT_TEXT[report.verdict] }}
      </span>
      <button
        v-else
        class="btn sm"
        :disabled="loading"
        title="读取缓存核验结果"
        @click="load(false)"
      >
        <Icon name="search" :size="12" /> 核验
      </button>
    </div>

    <div v-if="loading && !report" class="empty" style="padding: 8px 0">核验中…</div>
    <div v-else-if="errText" class="empty err" style="padding: 8px 0">{{ errText }}</div>

    <template v-if="report">
      <div class="meta">
        <span class="muted mono">{{ new Date(report.checkedAt).toLocaleString() }}</span>
        <span v-if="report.fromCache" class="badge skip">缓存</span>
        <span class="grow" />
        <button
          class="btn sm"
          :disabled="loading"
          title="按需重算并刷新缓存（本地测量，零模型费用）"
          @click="load(true)"
        >
          <Icon name="refresh" :size="12" /> 重新核验
        </button>
      </div>

      <div class="rows">
        <div v-for="c in report.checks" :key="c.key" class="row">
          <div class="rline">
            <span class="rk">{{ KEY_TEXT[c.key] }}</span>
            <span class="grow" />
            <span class="badge" :class="STATUS_BADGE[c.status]">{{ STATUS_TEXT[c.status] }}</span>
          </div>
          <div class="rsub">
            <span v-if="c.value !== null && c.value !== undefined" class="mono rval">{{ fmtVal(c.value) }}</span>
            <span v-if="c.reason" class="muted rwhy">{{ c.reason }}</span>
            <span class="src">{{ c.source }}</span>
          </div>
        </div>
      </div>

      <p class="foot muted">
        只读核验：面板不改动交付标记、不放行批准。主观项（视觉一致性 / 道具连续 / 听感失真）及缺项
        <span class="mono">{{ report.missing.length }}</span> 条仍需人工看片听审后决定。
      </p>
    </template>
  </div>
</template>

<style scoped>
.mini {
  padding: 10px 14px;
}
.lhead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.lt {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  font-size: 13px;
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  margin-bottom: 8px;
}
.grow {
  flex: 1;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 300px;
  overflow-y: auto;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
.rline {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rk {
  font-weight: 500;
}
.rsub {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}
.rval {
  color: var(--text-2);
}
.rwhy {
  flex: 1 1 160px;
  min-width: 0;
  font-size: 11px;
  line-height: 1.5;
}
.src {
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid rgb(148 163 184 / 18%);
  border-radius: 6px;
  padding: 0 6px;
  white-space: nowrap;
}
.foot {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.6;
}
.err {
  color: var(--bad);
}
</style>
