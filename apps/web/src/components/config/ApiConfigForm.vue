<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Modal from '../common/Modal.vue'
import SearchSelect from '../common/SearchSelect.vue'
import type { ApiProvider, ProviderConfigLite, VendorCredential, VideoCreationCapabilities } from '../../lib/types'
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
 * [M31+] 视频「轻松创作能力声明」可视化表单：仅管理 extra.creationCapabilities，
 * 其余透传参数（promptExtend / watermark / seed…）仍由下方原始 JSON 文本框维护，二者互不覆盖。
 * 视频实例加载时把 creationCapabilities 从 JSON 文本框剥离、回填到这里；提交时再合并回去。
 */
const CAP_RESOLUTIONS = ['480p', '720p', '1080p', '768P', '2K'] as const
const isVideo = computed(() => props.provider.serviceType === 'video')
const capsVerified = ref(false)
const capsModel = ref('')
const capsModes = ref<string[]>([])
const capsDurations = ref('')
const capsAspectRatios = ref<string[]>([])
const capsResolution = ref('')
const capsErr = ref('')

/** 能力声明模型与实例所选模型不一致（预检会拒绝执行）——实时提示，不等提交 */
const capsModelMismatch = computed(() => {
  const inst = model.value.trim()
  const c = capsModel.value.trim()
  return !!inst && !!c && c !== inst
})

/** 依供应商 + 模型给出已知适配器约束提示（源自各适配器实现，非猜测） */
const capsHint = computed(() => {
  const key = props.provider.key
  const m = (capsModel.value || model.value).toLowerCase()
  if (key === 'pollinations_video') {
    return /minimax/.test(m)
      ? 'Pollinations 网关：minimax 系模型上游仅接受 5 / 10 / 15 秒三档（其余就近取档）；该适配器不支持首帧注入，请只声明文生视频（t2v）。'
      : 'Pollinations 网关为同步长请求，不支持首帧注入（i2v）；动态模式请声明文生视频（t2v）。'
  }
  if (key === 'minimax_video') return 'MiniMax 适配器：时长透传 4–15 秒；分辨率仅 768P / 2K 两档（480p/720p 归 768P，1080p 归 2K）。'
  if (key === 'volcengine_video') return '火山 Seedance 适配器：时长 4–15 秒；分辨率仅 480p / 720p（1080p 收敛到 720p）。'
  if (key === 'aliyun_wan_video') return '万相适配器：时长至少 2 秒；分辨率支持 480P / 720P / 1080P。'
  if (key === 'siliconflow_video') return '硅基流动适配器不下发 duration，只能声明一个经核实的固定产出时长；启用 i2v 需模型名含 I2V。'
  return ''
})

/** 勾选了适配器实际不支持的 i2v 时给出明确警告（避免声明与能力背离） */
const capsI2vWarn = computed(() => {
  if (!capsModes.value.includes('i2v')) return ''
  if (props.provider.key === 'pollinations_video') {
    return '该 Pollinations 适配器不支持首帧注入（i2v）；若方案含首帧参考会预检失败，动态模式请改用文生视频（t2v）。'
  }
  if (props.provider.key === 'siliconflow_video' && !/i2v/i.test(capsModel.value || model.value)) {
    return '硅基流动 i2v 需模型名包含 I2V，否则预检会拒绝首帧。'
  }
  return ''
})

function resetCaps(): void {
  capsVerified.value = false
  capsModel.value = ''
  capsModes.value = []
  capsDurations.value = ''
  capsAspectRatios.value = []
  capsResolution.value = ''
  capsErr.value = ''
}

// 勾选启用时若模型未填，自动带入当前所选模型（省去复制）
watch(capsVerified, (v) => {
  if (v && !capsModel.value) capsModel.value = model.value.trim()
})

/** 逗号/空格分隔文本 → 去重升序整数秒数组；含非法值返回 null */
function parseCapsDurations(): number[] | null {
  const nums = capsDurations.value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
  if (!nums.length || nums.some((d) => !Number.isInteger(d) || d < 1 || d > 30)) return null
  return [...new Set(nums)].sort((a, b) => a - b)
}

/** 组装并校验能力声明对象（与服务端 videoCapabilitiesSchema 逐字段对齐） */
function buildVideoCaps(): { ok: true; value: VideoCreationCapabilities } | { ok: false; error: string } {
  const inst = model.value.trim()
  const m = capsModel.value.trim() || inst
  if (!m) return { ok: false, error: '请填写能力声明模型（或先在上方选择模型）' }
  if (inst && m !== inst) return { ok: false, error: `能力声明模型「${m}」与实例模型「${inst}」不一致，预检会拒绝执行` }
  const modes = capsModes.value.filter((x): x is 'i2v' | 't2v' => x === 'i2v' || x === 't2v')
  if (!modes.length) return { ok: false, error: '生成模式至少勾选一项（i2v / t2v）' }
  const durations = parseCapsDurations()
  if (!durations) return { ok: false, error: '时长须为 1–30 的整数秒，逗号分隔（如 5, 10, 15）' }
  const ar = capsAspectRatios.value.filter((x): x is '9:16' | '16:9' | '1:1' => x === '9:16' || x === '16:9' || x === '1:1')
  if (!ar.length) return { ok: false, error: '画幅至少勾选一项' }
  if (!capsResolution.value) return { ok: false, error: '请选择输出分辨率' }
  return {
    ok: true,
    value: { model: m, verified: true, modes, durations, aspectRatios: ar, resolution: capsResolution.value as VideoCreationCapabilities['resolution'] },
  }
}

/** 一键填入推荐起点（按供应商真实约束预填，用户仍须核实并勾选「已核实」方生效） */
function applyCapsPreset(): void {
  if (!capsModel.value) capsModel.value = model.value.trim()
  const m = (capsModel.value || model.value).toLowerCase()
  capsAspectRatios.value = ['9:16', '16:9', '1:1']
  if (props.provider.key === 'pollinations_video') {
    capsModes.value = ['t2v']
    capsDurations.value = /minimax/.test(m) ? '5, 10, 15' : '5, 10'
    capsResolution.value = /minimax/.test(m) ? '480p' : '720p'
  } else if (props.provider.key === 'minimax_video') {
    capsModes.value = ['i2v', 't2v']; capsDurations.value = '5, 10'; capsResolution.value = '768P'
  } else if (props.provider.key === 'volcengine_video') {
    capsModes.value = ['i2v', 't2v']; capsDurations.value = '5, 10'; capsResolution.value = '720p'
  } else if (props.provider.key === 'aliyun_wan_video') {
    capsModes.value = ['i2v', 't2v']; capsDurations.value = '5'; capsResolution.value = '720p'
  } else if (props.provider.key === 'siliconflow_video') {
    capsModes.value = /i2v/i.test(m) ? ['i2v'] : ['t2v']; capsDurations.value = '4'; capsResolution.value = '720p'
  } else {
    capsModes.value = ['t2v']; capsDurations.value = '5, 10'; capsResolution.value = '720p'
  }
}

/** 实例级定价（按能力类型显示不同单位） */
const priceInput = ref('')
const priceOutput = ref('')

/** 当前能力类型对应的定价单位描述 */
const pricingUnits = computed(() => {
  const st = props.provider.serviceType
  if (st === 'llm') return { input: '元/百万 token（输入）', output: '元/百万 token（输出）', dual: true }
  if (st === 'image') return { input: '元/张', output: '', dual: false }
  if (st === 'video') return { input: '元/秒', output: '', dual: false }
  return { input: '元/千字符', output: '', dual: false } // audio/tts
})

/** 凭证下拉候选：显示 "厂商名 ****tail" */
const credentialOptions = computed(() => {
  return (props.credentials ?? []).map((cr) => ({
    value: cr.id,
    label: cr.hasKey ? `${cr.name} ${cr.apiKeyMasked}` : `${cr.name}（未配 Key）`,
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
    const rawExtra: Record<string, unknown> = c?.extra && typeof c.extra === 'object' ? { ...c.extra } : {}
    if (isVideo.value) {
      const caps = rawExtra.creationCapabilities
      delete rawExtra.creationCapabilities
      extraText.value = Object.keys(rawExtra).length ? JSON.stringify(rawExtra, null, 2) : ''
      if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
        const o = caps as Record<string, unknown>
        capsVerified.value = o.verified === true
        capsModel.value = typeof o.model === 'string' ? o.model : ''
        capsModes.value = Array.isArray(o.modes) ? o.modes.filter((x) => x === 'i2v' || x === 't2v') : []
        capsDurations.value = Array.isArray(o.durations) ? o.durations.join(', ') : ''
        capsAspectRatios.value = Array.isArray(o.aspectRatios) ? o.aspectRatios.filter((x) => x === '9:16' || x === '16:9' || x === '1:1') : []
        capsResolution.value = typeof o.resolution === 'string' ? o.resolution : ''
      } else {
        resetCaps()
      }
      capsErr.value = ''
    } else {
      extraText.value = Object.keys(rawExtra).length ? JSON.stringify(rawExtra, null, 2) : ''
      resetCaps()
    }
    extraErr.value = ''
    // 定价回显
    const p = c?.pricing ?? {}
    const st = props.provider.serviceType
    if (st === 'llm') {
      priceInput.value = p['tokens_in'] != null ? String(p['tokens_in']) : ''
      priceOutput.value = p['tokens_out'] != null ? String(p['tokens_out']) : ''
    } else if (st === 'image') {
      priceInput.value = p['image'] != null ? String(p['image']) : ''
      priceOutput.value = ''
    } else if (st === 'video') {
      priceInput.value = p['second'] != null ? String(p['second']) : ''
      priceOutput.value = ''
    } else {
      priceInput.value = p['char'] != null ? String(p['char']) : ''
      priceOutput.value = ''
    }
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

/** 组装定价 JSON */
function buildPricing(): Record<string, number> {
  const st = props.provider.serviceType
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

async function submit() {
  if (!name.value.trim()) {
    err.value = '请填写实例名'
    return
  }
  // 扩展参数：JSON 文本框维护透传参数；视频实例的 creationCapabilities 由可视化表单管理并合并
  extraErr.value = ''
  capsErr.value = ''
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
  // 视频且勾选「已核实」→ 校验并合并能力声明；未勾选 → 不写 creationCapabilities（编辑时即移除旧声明）
  let finalExtra: Record<string, unknown> = baseExtra
  if (isVideo.value && capsVerified.value) {
    const built = buildVideoCaps()
    if (!built.ok) {
      capsErr.value = built.error
      return
    }
    finalExtra = { ...baseExtra, creationCapabilities: built.value }
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
  else if (props.config?.extra && Object.keys(props.config.extra).length > 0) body.extra = {}
  // 定价
  const pricing = buildPricing()
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
  <Modal :title="config ? `编辑实例：${config.name}` : `新建 ${provider.name} 实例`" :width="560" @close="emit('close')">
    <label class="fld">
      实例名
      <input v-model="name" type="text" placeholder="如：主用图像 / DeepSeek 网关" />
    </label>

    <!-- 供应商凭证选择（替代原来的 API Key 字段） -->
    <div class="fld">
      <span>供应商凭证</span>
      <select v-model="credentialId" class="cred-sel">
        <option :value="null">—— 选择凭证（共享 Key）——</option>
        <option v-for="opt in credentialOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <span class="note">选择后无需每次填写 API Key，凭证在「供应商凭证」面板统一管理</span>
    </div>

    <!-- 无凭证时回退显示独立 Key 输入 -->
    <label v-if="credentialId == null" class="fld">
      API Key（独立）
      <input v-model="apiKey" type="password" :placeholder="config ? '留空保持不变（已配置 ' + (config.apiKeyMasked ?? '') + '）' : '粘贴明文 key（仅存本地 secrets.json）'" />
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
        <button type="button" class="btn sm" :disabled="fetchBusy" @click="fetchModels()">
          {{ fetchBusy ? '获取中…' : '获取模型' }}
        </button>
      </div>
      <span v-if="fetchNote" class="note" :class="{ warn: fetchNoteWarn }">{{ fetchNote }}</span>
      <span v-else-if="!modelOptions.length" class="note">点「获取模型」按官方 API 在线查询可用模型</span>
    </div>

    <!-- 实例级定价 -->
    <div class="fld">
      <span>定价（可选，留空则用全局兜底定价）</span>
      <div class="prow">
        <input v-model="priceInput" type="number" min="0" step="0.0001" :placeholder="pricingUnits.input" />
        <input v-if="pricingUnits.dual" v-model="priceOutput" type="number" min="0" step="0.0001" :placeholder="pricingUnits.output" />
      </div>
    </div>

    <!-- [M31+] 视频「轻松创作能力声明」可视化表单：替代手写 creationCapabilities JSON；仅管理该键，其余透传参数仍在下方原始 JSON 维护 -->
    <section v-if="isVideo" class="caps">
      <label class="caps-head">
        <input v-model="capsVerified" type="checkbox" />
        <span>
          <b>声明轻松创作能力</b>
          <em
            >「一句话成片」不猜测模型能力——需你核实并显式声明支持的时长 / 画幅 / 分辨率 / 生成模式，确认后才会写入扩展参数
            <code>creationCapabilities</code>。</em
          >
        </span>
      </label>

      <template v-if="capsVerified">
        <div class="caps-actions">
          <button type="button" class="btn sm" @click="applyCapsPreset">填入推荐起点（请核实）</button>
          <button v-if="model.trim()" type="button" class="btn sm" @click="capsModel = model.trim()">同步上方模型</button>
        </div>

        <label class="fld">
          能力声明模型（须与所选模型一字不差）
          <input v-model="capsModel" type="text" :placeholder="model.trim() || '如：minimax/minimax-h3-max-turbo'" />
          <span v-if="capsModelMismatch" class="note warn">与上方实例模型「{{ model.trim() }}」不一致，轻松创作预检会拒绝执行</span>
          <span v-else class="note">留空则提交时自动取上方所选模型</span>
        </label>

        <div class="fld">
          <span>生成模式（至少一项）</span>
          <div class="checks">
            <label><input v-model="capsModes" type="checkbox" value="i2v" /> 图生视频·首帧（i2v）</label>
            <label><input v-model="capsModes" type="checkbox" value="t2v" /> 文生视频（t2v）</label>
          </div>
          <span v-if="capsI2vWarn" class="note warn">{{ capsI2vWarn }}</span>
          <span v-else class="note">首帧参考 / 跨镜角色一致性需 i2v；仅文生动态视频勾 t2v 即可</span>
        </div>

        <label class="fld">
          支持时长（秒，逗号分隔，1–30 整数）
          <input v-model="capsDurations" type="text" placeholder="如：5, 10, 15" />
        </label>

        <div class="fld">
          <span>画幅（至少一项）</span>
          <div class="checks">
            <label><input v-model="capsAspectRatios" type="checkbox" value="9:16" /> 9:16 竖屏</label>
            <label><input v-model="capsAspectRatios" type="checkbox" value="16:9" /> 16:9 横屏</label>
            <label><input v-model="capsAspectRatios" type="checkbox" value="1:1" /> 1:1 方形</label>
          </div>
        </div>

        <label class="fld">
          输出分辨率
          <select v-model="capsResolution">
            <option value="">—— 选择 ——</option>
            <option v-for="r in CAP_RESOLUTIONS" :key="r" :value="r">{{ r }}</option>
          </select>
        </label>

        <p v-if="capsHint" class="note caps-hint">{{ capsHint }}</p>
        <span v-if="capsErr" class="note warn caps-err">{{ capsErr }}</span>
      </template>
    </section>

    <details class="adv">
      <summary>高级：自定义端点{{ provider.defaultUrl ? `（默认 ${provider.defaultUrl}）` : '' }}</summary>
      <label class="fld">
        端点 base_url
        <input v-model="baseUrl" type="text" :placeholder="provider.defaultUrl ? '留空即使用默认端点' : '如 https://api.deepseek.com/v1'" />
      </label>
      <label class="fld">
        扩展参数（JSON，可选）
        <textarea v-model="extraText" class="code" rows="3" spellcheck="false" placeholder='供适配器透传，如火山 TTS：{"appid":"你的应用 ID"}' @input="extraErr = ''"></textarea>
      </label>
      <span v-if="extraErr" class="note warn">{{ extraErr }}</span>
      <span v-else class="note">{{ isVideo ? '仅填其余透传参数（如 seed / watermark）；creationCapabilities 由上方「轻松创作能力声明」维护，无需在此手写' : '留空表示无扩展参数（编辑时清空即移除）' }}</span>
    </details>

    <div class="opts">
      <label><input v-model="isDefault" type="checkbox" /> 同类型默认实例</label>
      <label><input v-model="isActive" type="checkbox" /> 启用</label>
    </div>
    <div v-if="err" class="err-text">{{ err }}</div>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="busy" @click="submit">{{ busy ? '保存中…' : '保存' }}</button>
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

.prow {
  display: flex;
  gap: 8px;
  margin-top: 5px;
}

.prow input {
  flex: 1;
  min-width: 0;
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

/* [M31+] 轻松创作能力声明区块 */
.caps {
  margin: 2px 0 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.caps-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}

.caps-head input[type='checkbox'] {
  margin-top: 2px;
  flex: none;
}

.caps-head b {
  font-size: 13px;
  color: var(--text-1);
}

.caps-head em {
  display: block;
  margin-top: 3px;
  font-style: normal;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
}

.caps-head code {
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg);
}

.caps-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0 12px;
}

.caps .fld {
  margin-bottom: 10px;
}

.caps .fld:last-of-type {
  margin-bottom: 0;
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

.caps-hint {
  margin: 10px 0 0;
}

.caps-err {
  margin-top: 8px;
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
