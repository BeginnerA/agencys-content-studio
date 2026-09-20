<script setup lang="ts">
/**
 * [M32] 视频「轻松创作能力」编辑器：视频实例专属子组件（父组件仅在 serviceType==='video' 时挂载）。
 * Tier A 智能化：能力以服务端「单一真源表」为准——命中背书档位时默认「自动背书」（不写 creationCapabilities，
 * 交由服务端 preflight 按表推导，用户无需逐项核实）；用户可「改为手动声明」覆盖。未背书（siliconflow / 未知）
 * → 回退手动声明表单。手动声明为空 = 不写能力（服务端按表背书或 fail-closed），保留「先建实例、稍后声明」路径。
 */
import { computed, ref, watch } from 'vue'
import { configApi } from '../../lib/api'
import ProvenanceBadge from '../common/ProvenanceBadge.vue'
import type { VideoCreationCapabilities, VideoModelCaps } from '../../lib/types'

const props = defineProps<{
  providerKey: string
  providerName: string
  /** 实例所选模型（父组件双向绑定值；本组件据此拉取背书档位并做一致性提示） */
  model: string
  /** 编辑回显：既有 extra.creationCapabilities（无则 null）；变化时载入 */
  initial?: unknown | null
}>()

const CAP_RESOLUTIONS = ['480p', '720p', '1080p', '768P', '2K'] as const
type CapsMode = 'auto' | 'manual'
const capsMode = ref<CapsMode>('auto')
const capsSupported = ref(false)
const autoCaps = ref<VideoModelCaps | null>(null)
const capsFetching = ref(false)
const capsModel = ref('')
const capsModes = ref<string[]>([])
const capsDurations = ref('')
const capsAspectRatios = ref<string[]>([])
const capsResolution = ref('')
const capsErr = ref('')

const modelStr = computed(() => props.model ?? '')

/** 能力声明模型与实例所选模型不一致（预检会拒绝执行）——实时提示，不等提交 */
const capsModelMismatch = computed(() => {
  const inst = modelStr.value.trim()
  const c = capsModel.value.trim()
  return !!inst && !!c && c !== inst
})

/** 依供应商 + 模型给出已知适配器约束提示（用于未背书时的手填引导；命中背书的档位以 autoCaps 为准，不在此重复） */
const capsHint = computed(() => {
  const key = props.providerKey
  const m = (capsModel.value || modelStr.value).toLowerCase()
  if (key === 'pollinations_video') {
    return /minimax/.test(m)
      ? 'Pollinations 网关：minimax 系模型上游仅接受 5 / 10 / 15 秒三档（其余就近取档）；该适配器不支持首帧注入，请只声明文生视频（t2v）。'
      : 'Pollinations 网关为同步长请求，不支持首帧注入（i2v）；动态模式请声明文生视频（t2v）。'
  }
  if (key === 'siliconflow_video')
    return '硅基流动适配器不下发 duration，只能声明一个经核实的固定产出时长；启用 i2v 需模型名含 I2V。'
  return ''
})

/** 勾选了适配器实际不支持的 i2v 时给出明确警告（避免声明与能力背离） */
const capsI2vWarn = computed(() => {
  if (!capsModes.value.includes('i2v')) return ''
  if (props.providerKey === 'pollinations_video') {
    return '该 Pollinations 适配器不支持首帧注入（i2v）；若方案含首帧参考会预检失败，动态模式请改用文生视频（t2v）。'
  }
  if (
    props.providerKey === 'siliconflow_video' &&
    !/i2v/i.test(capsModel.value || modelStr.value)
  ) {
    return '硅基流动 i2v 需模型名包含 I2V，否则预检会拒绝首帧。'
  }
  return ''
})

function resetCaps(): void {
  capsMode.value = 'auto'
  capsModel.value = ''
  capsModes.value = []
  capsDurations.value = ''
  capsAspectRatios.value = []
  capsResolution.value = ''
  capsErr.value = ''
}

/** 手动声明是否已填内容（用于避免自动背书刷新覆盖用户的显式声明） */
function manualHasContent(): boolean {
  return !!(
    capsModel.value.trim() ||
    capsModes.value.length ||
    capsDurations.value.trim() ||
    capsAspectRatios.value.length ||
    capsResolution.value
  )
}

/** [M32] 按供应商 + 模型拉取平台能力表背书档位；命中→默认自动背书，未命中→回退手动声明 */
async function refreshVideoCaps(): Promise<void> {
  capsFetching.value = true
  try {
    const res = await configApi.videoCaps(props.providerKey, modelStr.value.trim())
    capsSupported.value = res.supported && !!res.caps
    autoCaps.value = res.supported ? (res.caps ?? null) : null
    if (!capsSupported.value) capsMode.value = 'manual'
    else if (!manualHasContent()) capsMode.value = 'auto'
  } catch {
    capsSupported.value = false
    autoCaps.value = null
    if (!manualHasContent()) capsMode.value = 'manual'
  } finally {
    capsFetching.value = false
  }
}

/** 逗号/空格分隔文本 → 去重升序整数秒数组；含非法值返回 null */
function parseCapsDurations(): number[] | null {
  const nums = capsDurations.value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
  if (!nums.length || nums.some((d) => !Number.isInteger(d) || d < 1 || d > 30))
    return null
  return [...new Set(nums)].sort((a, b) => a - b)
}

/** 组装并校验能力声明对象（与服务端 videoCapabilitiesSchema 逐字段对齐） */
function buildVideoCaps():
  | { ok: true; value: VideoCreationCapabilities }
  | { ok: false; error: string } {
  const inst = modelStr.value.trim()
  const m = capsModel.value.trim() || inst
  if (!m)
    return { ok: false, error: '请填写能力声明模型（或先在上方选择模型）' }
  if (inst && m !== inst)
    return {
      ok: false,
      error: `能力声明模型「${m}」与实例模型「${inst}」不一致，预检会拒绝执行`,
    }
  const modes = capsModes.value.filter(
    (x): x is 'i2v' | 't2v' => x === 'i2v' || x === 't2v',
  )
  if (!modes.length)
    return { ok: false, error: '生成模式至少勾选一项（i2v / t2v）' }
  const durations = parseCapsDurations()
  if (!durations)
    return {
      ok: false,
      error: '时长须为 1–30 的整数秒，逗号分隔（如 5, 10, 15）',
    }
  const ar = capsAspectRatios.value.filter(
    (x): x is '9:16' | '16:9' | '1:1' =>
      x === '9:16' || x === '16:9' || x === '1:1',
  )
  if (!ar.length) return { ok: false, error: '画幅至少勾选一项' }
  if (!capsResolution.value) return { ok: false, error: '请选择输出分辨率' }
  return {
    ok: true,
    value: {
      model: m,
      verified: true,
      modes,
      durations,
      aspectRatios: ar,
      resolution:
        capsResolution.value as VideoCreationCapabilities['resolution'],
    },
  }
}

/** 一键填入推荐起点：命中平台背书 → 按能力表填入（单一真源）；未命中 → 保守起点，须用户核实 */
function applyCapsPreset(): void {
  if (!capsModel.value) capsModel.value = modelStr.value.trim()
  if (autoCaps.value) {
    capsModes.value = [...autoCaps.value.modes]
    capsDurations.value = autoCaps.value.durations.join(', ')
    capsAspectRatios.value = [...autoCaps.value.aspectRatios]
    capsResolution.value = autoCaps.value.defaultResolution
    return
  }
  capsAspectRatios.value = ['9:16', '16:9', '1:1']
  const m = (capsModel.value || modelStr.value).toLowerCase()
  if (props.providerKey === 'siliconflow_video') {
    capsModes.value = /i2v/i.test(m) ? ['i2v'] : ['t2v']
    capsDurations.value = '4'
    capsResolution.value = '720p'
  } else {
    capsModes.value = ['t2v']
    capsDurations.value = '5, 10'
    capsResolution.value = '720p'
  }
}

/** 「改为手动声明」：切手动态并按平台/保守起点预填（命名方法，避免多语句内联表达式解析歧义） */
function switchToManual(): void {
  capsMode.value = 'manual'
  applyCapsPreset()
}

/** 编辑回显：载入既有 creationCapabilities（有 → 进入手动模式并回填；无 → 复位为默认自动） */
function loadFromExtra(caps: unknown): void {
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    const o = caps as Record<string, unknown>
    capsMode.value = 'manual' // 既有显式声明 → 尊重并进入手动模式（可切回平台自动背书）
    capsModel.value = typeof o.model === 'string' ? o.model : ''
    capsModes.value = Array.isArray(o.modes)
      ? o.modes.filter((x) => x === 'i2v' || x === 't2v')
      : []
    capsDurations.value = Array.isArray(o.durations)
      ? o.durations.join(', ')
      : ''
    capsAspectRatios.value = Array.isArray(o.aspectRatios)
      ? o.aspectRatios.filter((x) => x === '9:16' || x === '16:9' || x === '1:1')
      : []
    capsResolution.value = typeof o.resolution === 'string' ? o.resolution : ''
    capsErr.value = ''
  } else {
    resetCaps()
  }
}

/** 父组件提交时调用：产出是否写入 creationCapabilities（自动背书 / 空声明 → 不写；手动声明 → 校验后写） */
function buildExtra(): {
  ok: boolean
  write: boolean
  error?: string
  caps?: VideoCreationCapabilities
} {
  capsErr.value = ''
  if (capsMode.value === 'auto' && capsSupported.value)
    return { ok: true, write: false }
  if (!manualHasContent()) return { ok: true, write: false }
  const built = buildVideoCaps()
  if (!built.ok) {
    capsErr.value = built.error
    return { ok: false, write: false, error: built.error }
  }
  return { ok: true, write: true, caps: built.value }
}

defineExpose({ buildExtra, loadFromExtra, resetCaps })

watch([() => props.providerKey, modelStr], () => void refreshVideoCaps(), {
  immediate: true,
})
watch(
  () => props.initial,
  (v) => loadFromExtra(v ?? null),
  { immediate: true },
)
</script>

<template>
  <section class="caps">
    <div class="caps-head">
      <b>轻松创作能力</b>
      <span v-if="capsFetching" class="note">正在按平台能力表核实档位…</span>
      <span v-else-if="capsSupported && capsMode === 'auto'" class="note">
        <ProvenanceBadge
          kind="endorse"
          text="平台能力表"
          :title="`已按「${providerName}${modelStr.trim() ? ` / ${modelStr.trim()}` : ''}」真源表担保档位，无需逐项核实`"
        />
        系统已按「{{ providerName
        }}<template v-if="modelStr.trim()"> / {{ modelStr.trim() }}</template
        >」能力表自动背书，无需手动核实；执行前预检卡仍可复核，如需可「改为手动声明」覆盖。
      </span>
      <span v-else-if="!capsSupported" class="note">
        该供应商 / 模型暂无平台背书档位（产出时长等未文档化），请手动声明支持范围，否则「一句话成片」预检会拒绝执行。
      </span>
    </div>

    <!-- 自动背书：只读摘要 -->
    <div
      v-if="capsSupported && capsMode === 'auto' && autoCaps"
      class="caps-auto"
    >
      <dl>
        <div>
          <dt>生成模式</dt>
          <dd>{{ autoCaps.modes.join(' / ') }}</dd>
        </div>
        <div>
          <dt>时长档位（秒）</dt>
          <dd>{{ autoCaps.durations.join(', ') }}</dd>
        </div>
        <div>
          <dt>分辨率</dt>
          <dd>
            {{ autoCaps.resolutions.join(' / ') }}（默认
            {{ autoCaps.defaultResolution }}）
          </dd>
        </div>
        <div>
          <dt>画幅</dt>
          <dd>{{ autoCaps.aspectRatios.join(' / ') }}</dd>
        </div>
      </dl>
      <div class="caps-actions">
        <button type="button" class="btn sm" @click="switchToManual">
          改为手动声明
        </button>
      </div>
    </div>

    <!-- 手动声明表单（未背书默认，或已背书但用户选择覆盖） -->
    <template v-else>
      <div class="caps-actions">
        <button type="button" class="btn sm" @click="applyCapsPreset">
          {{ capsSupported ? '按平台能力表填入' : '填入参考起点（请核实）' }}
        </button>
        <button
          v-if="modelStr.trim()"
          type="button"
          class="btn sm"
          @click="capsModel = modelStr.trim()"
        >
          同步上方模型
        </button>
        <button
          v-if="capsSupported"
          type="button"
          class="btn sm"
          @click="capsMode = 'auto'"
        >
          用平台自动背书
        </button>
      </div>

      <label class="fld">
        能力声明模型（须与所选模型一字不差）
        <input
          v-model="capsModel"
          type="text"
          :placeholder="modelStr.trim() || '如：minimax/minimax-h3-max-turbo'"
        />
        <span v-if="capsModelMismatch" class="note warn"
          >与上方实例模型「{{
            modelStr.trim()
          }}」不一致，轻松创作预检会拒绝执行</span
        >
        <span v-else class="note">留空则提交时自动取上方所选模型</span>
      </label>

      <div class="fld">
        <span>生成模式（至少一项）</span>
        <div class="checks">
          <label
            ><input v-model="capsModes" type="checkbox" value="i2v" /> 图生视频·首帧
            （i2v）</label
          >
          <label
            ><input v-model="capsModes" type="checkbox" value="t2v" /> 文生视频（t2v）</label
          >
        </div>
        <span v-if="capsI2vWarn" class="note warn">{{ capsI2vWarn }}</span>
        <span v-else class="note"
          >首帧参考 / 跨镜角色一致性需 i2v；仅文生动态视频勾 t2v 即可</span
        >
      </div>

      <label class="fld">
        支持时长（秒，逗号分隔，1–30 整数）
        <input
          v-model="capsDurations"
          type="text"
          placeholder="如：5, 10, 15"
        />
      </label>

      <div class="fld">
        <span>画幅（至少一项）</span>
        <div class="checks">
          <label
            ><input v-model="capsAspectRatios" type="checkbox" value="9:16" /> 9:16
            竖屏</label
          >
          <label
            ><input v-model="capsAspectRatios" type="checkbox" value="16:9" /> 16:9
            横屏</label
          >
          <label
            ><input v-model="capsAspectRatios" type="checkbox" value="1:1" /> 1:1
            方形</label
          >
        </div>
      </div>

      <label class="fld">
        输出分辨率
        <select v-model="capsResolution">
          <option value="">—— 选择 ——</option>
          <option v-for="r in CAP_RESOLUTIONS" :key="r" :value="r">
            {{ r }}
          </option>
        </select>
      </label>

      <p v-if="capsHint" class="note caps-hint">{{ capsHint }}</p>
      <span v-if="capsErr" class="note warn caps-err">{{ capsErr }}</span>
    </template>
  </section>
</template>

<style scoped>
.caps {
  margin: 2px 0 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.caps .fld {
  display: block;
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--text-2);
}

.caps .fld:last-of-type {
  margin-bottom: 0;
}

.caps select {
  display: block;
  width: 100%;
  margin-top: 5px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg);
  color: var(--text-1);
}

.caps-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.caps-head b {
  font-size: 13px;
  color: var(--text-1);
}

.caps-auto {
  margin-top: 4px;
}

.caps-auto dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 16px;
  margin: 0 0 8px;
}

.caps-auto dl > div {
  display: flex;
  gap: 6px;
  font-size: 12px;
}

.caps-auto dt {
  color: var(--text-3);
}

.caps-auto dd {
  margin: 0;
  color: var(--text-1);
}

.caps-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0 12px;
}

.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 5px;
}

.checks label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--text-1);
  cursor: pointer;
}

.caps-hint {
  margin: 10px 0 0;
}

.caps-err {
  margin-top: 8px;
}

.note {
  display: block;
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--text-3);
  word-break: break-word;
}

.note.warn {
  color: var(--warn);
}
</style>
