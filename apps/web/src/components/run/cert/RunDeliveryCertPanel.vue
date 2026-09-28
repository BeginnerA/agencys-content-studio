<script setup lang="ts">
/**
 * 第五期 · 交付包认证面板（只读编辑器兼容认证）——运行详情右栏辅助面板，与「质量核验 / 导出包」同级（规格 §6）。
 * - 自治探测：挂载先读缓存（refresh=0），无交付包（verdict=needs_package）/ run 不存在（后端 404 run_not_found/not_found）→ 整体隐藏，不打扰。
 * - 只读硬约束：仅呈现后端结构良构 / 时长数学 / 跨格式一致 / 媒体可定位 / 时轴绑定 / 字幕交付 客观结论 + 缺项清单；
 *   不在前端推算帧 / 时长 / verdict，无任何写 / 造包 / 重合成按钮。
 * - 结构认证 ≠ 编辑器通过：editor_import 恒列「待人工实测」，交付放行仍走既有批准链。
 */
import { onMounted, ref } from 'vue'
import Icon from '../../common/Icon.vue'
import { deliveryCertApi } from '../../../lib/api/delivery-cert'
import { ApiError } from '../../../lib/api/core'
import type {
  CertCheckView,
  CertStatus,
  CertVerdict,
  DeliveryCertView,
} from '../../../lib/types/delivery-cert'

const props = defineProps<{ runId: number }>()

const cert = ref<DeliveryCertView | null>(null)
const loading = ref(false)
const hidden = ref(false)
const errText = ref('')

const KEY_TEXT: Record<CertCheckView['key'], string> = {
  package_present: '交付包存在',
  project_file_wellformed: '工程文件结构良构',
  duration_math_consistent: '时长/时码数学一致',
  cross_format_consistency: '跨格式一致性',
  media_refs_resolvable: '媒体引用可定位',
  timeline_source_bound: '时间轴快照绑定',
  subtitle_delivery_bound: '字幕交付绑定',
  editor_import_certified: '编辑器导入实测',
}

// 状态徽标复用全局 .badge 语义修饰（主题 token 同源，不新造配色）
const STATUS_BADGE: Record<CertStatus, string> = {
  passed: 'succeeded',
  failed: 'failed',
  stale: 'queued',
  not_tested: 'skip',
  unsupported: 'skip',
  not_applicable: 'cancelled',
}
const STATUS_TEXT: Record<CertStatus, string> = {
  passed: '通过',
  failed: '未通过',
  stale: '待重算',
  not_tested: '未测',
  unsupported: '不支持',
  not_applicable: '不适用',
}
const VERDICT_BADGE: Record<CertVerdict, string> = {
  package_sound: 'succeeded',
  needs_attention: 'queued',
  package_broken: 'failed',
  needs_package: 'cancelled',
}
const VERDICT_TEXT: Record<CertVerdict, string> = {
  package_sound: '结构可信',
  needs_attention: '需人工导入实测',
  package_broken: '交付包破损',
  needs_package: '尚无交付包',
}

const fmtVal = (v: CertCheckView['value']): string =>
  v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? '是' : '否') : String(v)

async function load(refresh: boolean): Promise<void> {
  loading.value = true
  errText.value = ''
  try {
    const r = await deliveryCertApi.get(props.runId, { refresh })
    // 无交付包：不为认证造包，整体隐藏，不打扰（能力探测驱动显隐）
    if (!refresh && r.verdict === 'needs_package') hidden.value = true
    else hidden.value = false
    cert.value = r
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'run_not_found' || e.code === 'not_found')) {
      hidden.value = true // run 不存在：整体隐藏，不打扰
    } else {
      errText.value = e instanceof ApiError ? e.message : '认证失败'
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
      <span class="lt"><Icon name="cube" :size="13" /> 交付包认证</span>
      <span v-if="cert" class="badge" :class="VERDICT_BADGE[cert.verdict]">
        {{ VERDICT_TEXT[cert.verdict] }}
      </span>
      <button
        v-else
        class="btn sm"
        :disabled="loading"
        title="读取缓存认证结果"
        @click="load(false)"
      >
        <Icon name="search" :size="12" /> 认证
      </button>
    </div>

    <div v-if="loading && !cert" class="empty" style="padding: 8px 0">认证中…</div>
    <div v-else-if="errText" class="empty err" style="padding: 8px 0">{{ errText }}</div>

    <template v-if="cert">
      <div class="meta">
        <span class="muted mono">{{ new Date(cert.checkedAt).toLocaleString() }}</span>
        <span class="badge skip">{{ cert.format }}</span>
        <span v-if="cert.fromCache" class="badge skip">缓存</span>
        <span class="grow" />
        <button
          class="btn sm"
          :disabled="loading"
          title="按需重算并刷新缓存（本地纯解析，零模型费用）"
          @click="load(true)"
        >
          <Icon name="refresh" :size="12" /> 重新认证
        </button>
      </div>

      <div class="rows">
        <div v-for="c in cert.checks" :key="c.key" class="row">
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
        只读认证：面板不造包、不改交付标记、不放行批准。结构良构 ≠ 编辑器已验证通过——
        编辑器导入 <span class="mono">{{ cert.missing.length }}</span> 项待人工实测（含导入 FCPx/EDL/OTIO 后人工核对）。
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
