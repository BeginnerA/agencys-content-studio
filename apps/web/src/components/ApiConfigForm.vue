<script setup lang="ts">
import { ref, watch } from 'vue'
import Modal from './Modal.vue'
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

watch(
  () => props.config,
  (c) => {
    name.value = c?.name ?? ''
    baseUrl.value = c?.baseUrl ?? ''
    model.value = c?.model ?? ''
    isDefault.value = c?.isDefault ?? false
    isActive.value = c?.isActive ?? true
    apiKey.value = ''
  },
  { immediate: true },
)

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
      端点 base_url
      <input v-model="baseUrl" type="text" :placeholder="provider.defaultUrl ?? '留空使用供应商默认端点'" />
    </label>
    <label class="fld">
      模型 model
      <input v-model="model" type="text" placeholder="留空使用供应商默认模型" />
    </label>
    <label class="fld">
      API Key
      <input v-model="apiKey" type="password" :placeholder="config ? '留空保持不变（已配置 ' + (config.apiKeyMasked ?? '') + '）' : '粘贴明文 key（仅存本地 secrets.json）'" />
    </label>
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
