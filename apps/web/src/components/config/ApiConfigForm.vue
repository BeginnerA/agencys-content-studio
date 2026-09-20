<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Modal from '../common/Modal.vue'
import SearchSelect from '../common/SearchSelect.vue'
import type {
  ApiProvider,
  ProviderConfigLite,
  VendorCredential,
} from '../../lib/types'
import VideoCapsEditor from './VideoCapsEditor.vue'
import PricingSuggest from './PricingSuggest.vue'
import { configApi } from '../../lib/api'

const props = defineProps<{
  provider: ApiProvider
  /** 编辑时传现有配置（列表精简态，含 baseUrl / apiKeyMasked / extra / pricing 回显字段）；新建为空 */
  config?: ProviderConfigLite | null
  /** 供应商凭证列表（用于下拉选择） */
  credentials?: VendorCredential[]
}>()
const emit = defineEmits<{ saved: []; close: [] }>()

const name = ref('')
const baseUrl = ref('')
const model = ref('')
const apiKey = ref('')
const credentialId = ref<number | null>(null)
const isDefault = ref(false)
const isActive = ref(true)
const err = ref('')
const busy = ref(false)
/** 扩展参数（JSON 文本；空 = 不设置，编辑时清空原值则显式提交 {}） */
const extraText = ref('')
const extraErr = ref('')

/**
 * [M32] 视频「轻松创作能力」子组件（VideoCapsEditor）：仅管理 extra.creationCapabilities，
 * 命中平台能力表时默认自动背书、免手填核实；其余透传参数仍由下方原始 JSON 文本框维护，二者互不覆盖。
 * 编辑时把 creationCapabilities 剥离出 JSON 文本框、以 initial 传入子组件；提交时经子组件 buildExtra 合并。
 */
const isVideo = computed(() => props.provider.serviceType === 'video')
const capsEditor = ref<InstanceType<typeof VideoCapsEditor> | null>(null)
/** 编辑回显：既有 creationCapabilities（无则 null），作为子组件 initial 传入 */
const capsInitial = ref<unknown>(null)

/**
 * [M33] 定价智能带出子组件（PricingSuggest，全通道）：命中平台参考定价表→自动预填（可改），
 * 未命中→回落手填。编辑回显经 pricingInitial 传入，提交经其 buildPricing 回收。
 * 「选中即生成」：@suggest 回报参考定价命中 / 默认通道建议（新建且该通道无实例时自动勾 isDefault，用户可取消）。
 */
const pricingSuggest = ref<InstanceType<typeof PricingSuggest> | null>(null)
const pricingInitial = ref<Record<string, number> | null>(null)
const pricingHit = ref(false)
const suggestDefault = ref(false)
const defaultTouched = ref(false)
function onPricingSuggest(p: { pricingHit: boolean; suggestDefault: boolean }): void {
  pricingHit.value = p.pricingHit
  suggestDefault.value = p.suggestDefault
  if (p.suggestDefault && !props.config && !defaultTouched.value) isDefault.value = true
}

/** 凭证下拉候选：显示 "厂商名 ****tail" */
const credentialOptions = computed(() => {
  return (props.credentials ?? []).map((cr) => ({
    value: cr.id,
    label: cr.hasKey
      ? `${cr.name} ${cr.apiKeyMasked}`
      : `${cr.name}（未配 Key）`,
  }))
})

/** 模型候选：目录预置 → 在线拉取覆盖 */
const modelOptions = ref<string[]>([])
/** 拉取结果说明（在线数量 / 回退原因） */
const fetchNote = ref('')
const fetchNoteWarn = ref(false)
const fetchBusy = ref(false)

watch(
  () => props.config,
  (c) => {
    name.value = c?.name ?? ''
    baseUrl.value = c?.baseUrl ?? ''
    model.value = c?.model ?? ''
    isDefault.value = c?.isDefault ?? false
    isActive.value = c?.isActive ?? true
    credentialId.value = c?.credentialId ?? null
    apiKey.value = ''
    modelOptions.value = props.provider.presetModels ?? []
    fetchNote.value = ''
    fetchNoteWarn.value = false
    fetchBusy.value = false
    // 扩展参数回显：视频实例把 creationCapabilities 剥离给上方可视化表单，JSON 文本框仅留其余透传参数
    const rawExtra: Record<string, unknown> =
      c?.extra && typeof c.extra === 'object' ? { ...c.extra } : {}
    if (isVideo.value) {
      const caps = rawExtra.creationCapabilities
      delete rawExtra.creationCapabilities
      extraText.value = Object.keys(rawExtra).length
        ? JSON.stringify(rawExtra, null, 2)
        : ''
      capsInitial.value =
        caps && typeof caps === 'object' && !Array.isArray(caps) ? caps : null
    } else {
      extraText.value = Object.keys(rawExtra).length
        ? JSON.stringify(rawExtra, null, 2)
        : ''
      capsInitial.value = null
    }
    extraErr.value = ''
    // 定价回显（[M33] 交子组件 PricingSuggest：有存量则尊重、否则按平台参考价自动预填）
    pricingInitial.value =
      c?.pricing && Object.keys(c.pricing).length ? { ...c.pricing } : null
    pricingHit.value = false
    suggestDefault.value = false
    defaultTouched.value = false
    // 编辑既有实例：静默刷新一次在线目录（带存量密钥；失败保留预置候选不打扰）
    if (c) void fetchModels(true)
  },
  { immediate: true },
)

/** 拉取在线模型目录；silent=true 时失败不提示（编辑打开自动刷新用） */
async function fetchModels(silent = false) {
  fetchBusy.value = true
  if (!silent) {
    fetchNote.value = ''
    fetchNoteWarn.value = false
  }
  try {
    const body: Record<string, unknown> = { provider_key: props.provider.key }
    if (baseUrl.value.trim()) body['base_url'] = baseUrl.value.trim()
    if (apiKey.value.trim()) body['api_key'] = apiKey.value.trim()
    if (props.config) body['config_id'] = props.config.id
    const res = await configApi.fetchModels(body)
    modelOptions.value = res.models
    if (!silent) {
      if (res.source === 'preset') {
        fetchNote.value = res.note ?? '已回退预置列表'
        fetchNoteWarn.value = true
      } else {
        fetchNote.value = `已获取 ${res.models.length} 个在线模型`
        fetchNoteWarn.value = false
      }
    }
  } catch (e) {
    if (!silent) {
      fetchNote.value = e instanceof Error ? e.message : String(e)
      fetchNoteWarn.value = true
    }
  } finally {
    fetchBusy.value = false
  }
}

/** 组装定价 JSON：已由 [M33] PricingSuggest 子组件 buildPricing 负责 */

async function submit() {
  if (!name.value.trim()) {
    err.value = '请填写实例名'
    return
  }
  // 扩展参数：JSON 文本框维护透传参数；视频实例的 creationCapabilities 由子组件管理并合并
  extraErr.value = ''
  let baseExtra: Record<string, unknown> = {}
  const extraRaw = extraText.value.trim()
  if (extraRaw) {
    try {
      const parsed: unknown = JSON.parse(extraRaw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        extraErr.value = '需为 JSON 对象，如 {"appid":"..."}'
        return
      }
      baseExtra = parsed as Record<string, unknown>
    } catch {
      extraErr.value = 'JSON 语法错误：请检查双引号与括号配对'
      return
    }
  }
  // [M32] 能力声明由子组件裁决：自动背书 / 空声明 → 不写 creationCapabilities（服务端按表推导）；手动声明 → 校验后合并
  let finalExtra: Record<string, unknown> = baseExtra
  if (isVideo.value) {
    const r = capsEditor.value?.buildExtra()
    if (r && !r.ok) return // 子组件已就地显示 caps 错误提示
    if (r?.ok && r.write && r.caps)
      finalExtra = { ...baseExtra, creationCapabilities: r.caps }
  }
  const body: Record<string, unknown> = {
    provider_key: props.provider.key,
    service_type: props.provider.serviceType,
    name: name.value.trim(),
    is_default: isDefault.value,
    is_active: isActive.value,
  }
  // 凭证关联（优先）或旧式 per-instance key
  if (credentialId.value != null) body.credential_id = credentialId.value
  if (baseUrl.value.trim()) body.base_url = baseUrl.value.trim()
  if (model.value.trim()) body.model = model.value.trim()
  if (apiKey.value.trim()) body.api_key = apiKey.value.trim()
  // 扩展参数：有值 → 提交合并结果；编辑时原值非空但现被清空 → 显式传 {} 清空
  if (Object.keys(finalExtra).length > 0) body.extra = finalExtra
  else if (props.config?.extra && Object.keys(props.config.extra).length > 0)
    body.extra = {}
  // 定价（[M33] 由子组件按服务类型组装；留空 → {}，编辑清空原值由下方分支显式传 {}）
  const pricing = pricingSuggest.value?.buildPricing() ?? {}
  body.pricing = pricing
  busy.value = true
  err.value = ''
  try {
    if (props.config) await configApi.update(props.config.id, body)
    else await configApi.create(body)
    emit('saved')
    emit('close')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal
    :title="config ? `编辑实例：${config.name}` : `新建 ${provider.name} 实例`"
    :width="560"
    @close="emit('close')"
  >
    <label class="fld">
      实例名
      <input
        v-model="name"
        type="text"
        placeholder="如：主用图像 / DeepSeek 网关"
      />
    </label>

    <!-- 供应商凭证选择（替代原来的 API Key 字段） -->
    <div class="fld">
      <span>供应商凭证</span>
      <select v-model="credentialId" class="cred-sel">
        <option :value="null">—— 选择凭证（共享 Key）——</option>
        <option
          v-for="opt in credentialOptions"
          :key="opt.value"
          :value="opt.value"
        >
          {{ opt.label }}
        </option>
      </select>
      <span class="note"
        >选择后无需每次填写 API Key，凭证在「供应商凭证」面板统一管理</span
      >
    </div>

    <!-- 无凭证时回退显示独立 Key 输入 -->
    <label v-if="credentialId == null" class="fld">
      API Key（独立）
      <input
        v-model="apiKey"
        type="password"
        :placeholder="
          config
            ? '留空保持不变（已配置 ' + (config.apiKeyMasked ?? '') + '）'
            : '粘贴明文 key（仅存本地 secrets.json）'
        "
      />
    </label>

    <div class="fld">
      <span>模型</span>
      <div class="mrow">
        <SearchSelect
          v-model="model"
          class="grow"
          :options="modelOptions"
          blank-label="（使用供应商默认模型）"
          placeholder="搜索或输入模型 ID"
          aria-label="模型（搜索或输入模型 ID）"
        />
        <button
          type="button"
          class="btn sm"
          :disabled="fetchBusy"
          @click="fetchModels()"
        >
          {{ fetchBusy ? '获取中…' : '获取模型' }}
        </button>
      </div>
      <span v-if="fetchNote" class="note" :class="{ warn: fetchNoteWarn }">{{
        fetchNote
      }}</span>
      <span v-else-if="!modelOptions.length" class="note"
        >点「获取模型」按官方 API 在线查询可用模型</span
      >
    </div>

    <!-- [M33] 定价智能带出：命中平台参考定价表自动预填（Tier A），未命中回落手填 -->
    <PricingSuggest
      ref="pricingSuggest"
      :service-type="provider.serviceType"
      :provider-key="provider.key"
      :model="model"
      :initial="pricingInitial"
      @suggest="onPricingSuggest"
    />

    <!-- [M33] 选中即生成汇总（视频能力档位另由下方编辑器就地背书提示） -->
    <div v-if="!config && (pricingHit || suggestDefault)" class="note">
      「选中即生成」：参考定价
      {{ pricingHit ? '已按平台真源带出（可修改）' : '暂无（需核实手填）' }}
      <template v-if="suggestDefault"> · 该通道首个实例，已建议设为默认</template>
    </div>

    <!-- [M32] 视频「轻松创作能力」：默认平台自动背书（Tier A），可覆盖为手动声明；逻辑见 VideoCapsEditor -->
    <VideoCapsEditor
      v-if="isVideo"
      ref="capsEditor"
      :provider-key="provider.key"
      :provider-name="provider.name"
      :model="model"
      :initial="capsInitial"
    />

    <details class="adv">
      <summary>
        高级：自定义端点{{
          provider.defaultUrl ? `（默认 ${provider.defaultUrl}）` : ''
        }}
      </summary>
      <label class="fld">
        端点 base_url
        <input
          v-model="baseUrl"
          type="text"
          :placeholder="
            provider.defaultUrl
              ? '留空即使用默认端点'
              : '如 https://api.deepseek.com/v1'
          "
        />
      </label>
      <label class="fld">
        扩展参数（JSON，可选）
        <textarea
          v-model="extraText"
          class="code"
          rows="3"
          spellcheck="false"
          placeholder='供适配器透传，如火山 TTS：{"appid":"你的应用 ID"}'
          @input="extraErr = ''"
        ></textarea>
      </label>
      <span v-if="extraErr" class="note warn">{{ extraErr }}</span>
      <span v-else class="note">{{
        isVideo
          ? '仅填其余透传参数（如 seed / watermark）；creationCapabilities 由上方「轻松创作能力声明」维护，无需在此手写'
          : '留空表示无扩展参数（编辑时清空即移除）'
      }}</span>
    </details>

    <div class="opts">
      <label
        ><input
          v-model="isDefault"
          type="checkbox"
          @change="defaultTouched = true"
        />
        同类型默认实例</label
      >
      <label><input v-model="isActive" type="checkbox" /> 启用</label>
    </div>
    <div v-if="err" class="err-text">{{ err }}</div>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="busy" @click="submit">
        {{ busy ? '保存中…' : '保存' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.fld {
  display: block;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--text-2);
}

.cred-sel {
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

.mrow {
  display: flex;
  gap: 8px;
  margin-top: 5px;
}

.grow {
  flex: 1;
  min-width: 0;
}

.mrow .btn {
  flex: none;
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

.adv {
  margin: 2px 0 12px;
  font-size: 12px;
}

.adv summary {
  cursor: pointer;
  color: var(--text-3);
  user-select: none;
}

.adv summary:hover {
  color: var(--text-2);
}

.adv[open] summary {
  margin-bottom: 8px;
}

.adv .fld {
  margin-bottom: 0;
}

/* 高级区内多字段纵向间距（base_url 与扩展参数） */
.adv .fld + .fld {
  margin-top: 10px;
}

/* 扩展参数：JSON 等宽字体 */
.adv .code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.opts {
  display: flex;
  gap: 22px;
  font-size: 13px;
  margin-top: 2px;
}

.opts label {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}
</style>
