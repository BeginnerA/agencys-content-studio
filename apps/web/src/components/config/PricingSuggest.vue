<script setup lang="ts">
/**
 * 定价智能带出（Tier A）：全通道定价区子组件，从 ApiConfigForm 抽出。
 * 复用 「单一真源 + 用户可覆盖 + 预览确认」范式：选供应商 + 模型后自动拉 `model-suggest`——
 * 命中平台参考定价表 → 自动预填（用户可改），标注来源锚点；未命中（无核实依据）→ 回落手填空框 + 明确提示补录。
 * 编辑态：实例已有 pricing → 尊重存量（不覆盖），仅提供「改用平台参考价」一键切换。
 * 安全线：真源表只影响「建实例预填」，不改事后计价口径（未命中绝不塞通用默认价，成本可见不降级）。
 */
import { computed, ref, watch } from 'vue'
import { configApi } from '../../lib/api'
import ProvenanceBadge from '../common/ProvenanceBadge.vue'
import type { ModelPricing } from '../../lib/types'

const props = defineProps<{
  serviceType: string
  providerKey: string
  /** 实例所选模型（父组件双向绑定值；本组件据此拉取参考定价） */
  model: string
  /** 编辑回显：既有实例 pricing（无则 null）；有则尊重存量、不自动覆盖 */
  initial?: Record<string, number> | null
  /** 在线目录带出的参考定价（供应商接口明确返回，如阿里百炼 LLM）；优先级 live > 核实表 */
  live?: ModelPricing | null
}>()
const emit = defineEmits<{
  suggest: [payload: { hit: boolean; source: 'live' | 'table' | 'stored' | 'none'; suggestDefault: boolean }]
}>()

const priceInput = ref('')
const priceOutput = ref('')
const suggested = ref<ModelPricing | null>(null)
const fetching = ref(false)
/** 'live'=命中供应商在线目录价 · 'auto'=命中平台核实表 · 'stored'=沿用实例存量 · 'manual'=手填（默认 / 未命中 / 用户改过） */
const mode = ref<'live' | 'auto' | 'stored' | 'manual'>('manual')
/** 用户是否手动编辑过定价框（编辑后自动带出不覆盖用户输入） */
const edited = ref(false)

/** 当前能力类型对应的定价单位与是否双栏（迁移自父组件 pricingUnits） */
const units = computed(() => {
  const st = props.serviceType
  if (st === 'llm') return { input: '元/百万 token（输入）', output: '元/百万 token（输出）', dual: true }
  if (st === 'image') return { input: '元/张', output: '', dual: false }
  if (st === 'video') return { input: '元/秒', output: '', dual: false }
  return { input: '元/千字符', output: '', dual: false } // audio/tts
})

function hasInitial(): boolean {
  return !!(props.initial && Object.keys(props.initial).length)
}

/** 把参考定价 prices 按服务类型映射进输入框 */
function fillFromPrices(prices: ModelPricing['prices']): void {
  const st = props.serviceType
  if (st === 'llm') {
    priceInput.value = prices.tokens_in != null ? String(prices.tokens_in) : ''
    priceOutput.value = prices.tokens_out != null ? String(prices.tokens_out) : ''
  } else {
    const u = st === 'image' ? 'image' : st === 'video' ? 'second' : 'char'
    priceInput.value = prices[u] != null ? String(prices[u]!) : ''
    priceOutput.value = ''
  }
}

/** 按优先级带出参考定价：编辑存量 stored > 在线目录 live > 平台核实表 auto > 手填 manual（未命中不塞默认价） */
async function refresh(): Promise<void> {
  fetching.value = true
  try {
    const res = await configApi.modelSuggest(props.providerKey, props.serviceType, (props.model ?? '').trim())
    applyPricing(res.pricing ?? null, !!res.suggestDefault)
  } catch {
    // model-suggest 失败：仍有 live（父组件已从 fetch-models 拿到）/ 存量则照带，否则回落手填（不猜）
    applyPricing(null, false)
  } finally {
    fetching.value = false
  }
}

/** 带出优先级落地：依据 live / 存量 / 核实表填价并回报父（source 供主区只读摘要展示） */
function applyPricing(table: ModelPricing | null, sd: boolean): void {
  if (hasInitial()) {
    fillFromPrices(props.initial!)
    suggested.value = props.live ?? table
    mode.value = 'stored'
    emit('suggest', { hit: true, source: 'stored', suggestDefault: sd })
  } else if (props.live) {
    fillFromPrices(props.live.prices)
    suggested.value = props.live
    mode.value = props.model ? 'live' : 'manual'
    emit('suggest', { hit: !!props.model, source: 'live', suggestDefault: sd })
  } else if (table && !edited.value) {
    fillFromPrices(table.prices)
    suggested.value = table
    mode.value = 'auto'
    emit('suggest', { hit: true, source: 'table', suggestDefault: sd })
  } else {
    suggested.value = table
    if (!edited.value) {
      priceInput.value = ''
      priceOutput.value = ''
    }
    mode.value = 'manual'
    emit('suggest', { hit: false, source: 'none', suggestDefault: sd })
  }
}

/** 命中平台参考价但用户想清空重填 */
function toManual(): void {
  mode.value = 'manual'
  edited.value = true
  priceInput.value = ''
  priceOutput.value = ''
}

/** 存量 / 手填态一键改用平台参考价 */
function applySuggested(): void {
  if (!suggested.value) return
  fillFromPrices(suggested.value.prices)
  mode.value = 'auto'
  edited.value = false
}

/** 父组件提交时调用：按服务类型组装定价 JSON（等价迁移前 buildPricing，留空 → 不写该单位） */
function buildPricing(): Record<string, number> {
  const st = props.serviceType
  const out: Record<string, number> = {}
  const v1 = parseFloat(priceInput.value)
  const v2 = parseFloat(priceOutput.value)
  if (st === 'llm') {
    if (Number.isFinite(v1) && v1 >= 0) out['tokens_in'] = v1
    if (Number.isFinite(v2) && v2 >= 0) out['tokens_out'] = v2
  } else if (st === 'image') {
    if (Number.isFinite(v1) && v1 >= 0) out['image'] = v1
  } else if (st === 'video') {
    if (Number.isFinite(v1) && v1 >= 0) out['second'] = v1
  } else {
    if (Number.isFinite(v1) && v1 >= 0) out['char'] = v1
  }
  return out
}

defineExpose({ buildPricing, suggested, mode })

watch(
  () => [props.providerKey, props.serviceType, (props.model ?? '').trim()] as const,
  () => void refresh(),
  { immediate: true },
)
watch(
  () => props.initial,
  () => void refresh(),
)
// 在线目录带出价到达（选定模型后 fetch-models 结果）→ 重评优先级
watch(
  () => props.live,
  () => void refresh(),
)
</script>

<template>
  <div class="fld">
    <span>定价（可选，留空则按全局兜底定价 / 未计价记录）</span>
    <div class="prow">
      <input
        v-model="priceInput"
        type="number"
        min="0"
        step="0.0001"
        :placeholder="units.input"
        @input="edited = true; mode = 'manual'"
      />
      <input
        v-if="units.dual"
        v-model="priceOutput"
        type="number"
        min="0"
        step="0.0001"
        :placeholder="units.output"
        @input="edited = true; mode = 'manual'"
      />
    </div>

    <span v-if="fetching" class="note">正在按平台定价真源核实…</span>
    <template v-else-if="(mode === 'auto' || mode === 'live') && suggested">
      <!-- 统一来源徽标：预填依据一目了然，核实锚点收进 hover -->
      <span class="prow-line">
        <ProvenanceBadge
          kind="auto"
          :text="mode === 'live' ? '供应商在线目录定价' : '平台核实表定价'"
          :title="`参考定价锚点：${suggested.source}；可直接修改`"
        />
        <span class="note ok">已按参考定价预填（可改）</span>
      </span>
      <div class="pacts">
        <button type="button" class="btn sm" @click="toManual">改为手填</button>
      </div>
    </template>
    <template v-else-if="mode === 'stored'">
      <span class="note">沿用该实例已配置的定价（保存后仍按实例价计费）</span>
      <div v-if="suggested" class="pacts">
        <button type="button" class="btn sm" @click="applySuggested">
          改用平台参考价
        </button>
      </div>
    </template>
    <template v-else>
      <span v-if="suggested" class="note">
        已获取参考定价（{{ suggested.source }}）
      </span>
      <div v-if="suggested" class="pacts">
        <button type="button" class="btn sm" @click="applySuggested">
          用平台参考价填入
        </button>
      </div>
      <span v-else class="note warn">
        该模型暂无平台核实的参考定价，请核实后手填（否则用量按未计价记录）
      </span>
    </template>
  </div>
</template>

<style scoped>
.fld {
  display: block;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--text-2);
}

.prow {
  display: flex;
  gap: 8px;
  margin-top: 5px;
}

.prow input {
  flex: 1;
  min-width: 0;
}

.pacts {
  margin-top: 6px;
}

/* 徽标 + 短注一行 */
.prow-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 5px;
}
.prow-line .note {
  display: inline;
  margin-top: 0;
}

.note {
  display: block;
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--text-3);
  word-break: break-word;
}

.note.ok {
  color: var(--ok, #2e7d32);
}

.note.warn {
  color: var(--warn);
}
</style>
