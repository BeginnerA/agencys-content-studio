<script setup lang="ts">
import { ref, watch } from 'vue'
import Modal from './Modal.vue'
import SearchSelect from './SearchSelect.vue'
import type { ApiConfig, ApiProvider } from '../lib/types'
import { configApi } from '../lib/api'

const props = defineProps<{
  provider: ApiProvider
  /** 编辑时传现有配置；新建为空 */
  config?: ApiConfig | null
}>()
const emit = defineEmits<{ saved: []; close: [] }>()

const name = ref('')
const baseUrl = ref('')
const model = ref('')
const apiKey = ref('')
const isDefault = ref(false)
const isActive = ref(true)
const err = ref('')
const busy = ref(false)

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
    apiKey.value = ''
    modelOptions.value = props.provider.presetModels ?? []
    fetchNote.value = ''
    fetchNoteWarn.value = false
    fetchBusy.value = false
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

async function submit() {
  if (!name.value.trim()) {
    err.value = '请填写实例名'
    return
  }
  const body: Record<string, unknown> = {
    provider_key: props.provider.key,
    service_type: props.provider.serviceType,
    name: name.value.trim(),
    is_default: isDefault.value,
    is_active: isActive.value,
  }
  if (baseUrl.value.trim()) body.base_url = baseUrl.value.trim()
  if (model.value.trim()) body.model = model.value.trim()
  if (apiKey.value.trim()) body.api_key = apiKey.value.trim()
  // 未填 api_key 且编辑时：保留原 ref（后端 PUT 仅按显式字段覆盖）
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
      <input v-model="name" type="text" placeholder="如：主用文生图 / DeepSeek 网关" />
    </label>
    <label class="fld">
      API Key
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

    <details class="adv">
      <summary>高级：自定义端点{{ provider.defaultUrl ? `（默认 ${provider.defaultUrl}）` : '' }}</summary>
      <label class="fld">
        端点 base_url
        <input v-model="baseUrl" type="text" :placeholder="provider.defaultUrl ? '留空即使用默认端点' : '如 https://api.deepseek.com/v1'" />
      </label>
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
