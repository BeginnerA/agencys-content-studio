<script setup lang="ts">
import { ref, watch } from 'vue'
import Modal from '../common/Modal.vue'
import type { VendorCredential } from '../../lib/types'
import { vendorApi } from '../../lib/api'

const props = defineProps<{
  credential: VendorCredential
}>()
const emit = defineEmits<{ saved: []; close: [] }>()

const name = ref('')
const apiKey = ref('')
const baseUrl = ref('')
const err = ref('')
const busy = ref(false)

watch(
  () => props.credential,
  (cr) => {
    name.value = cr.name ?? ''
    baseUrl.value = cr.baseUrl ?? ''
    apiKey.value = ''
    err.value = ''
  },
  { immediate: true },
)

async function submit() {
  if (!name.value.trim()) {
    err.value = '请填写供应商名称'
    return
  }
  busy.value = true
  err.value = ''
  try {
    const body: Record<string, unknown> = {
      vendor: props.credential.vendor,
      name: name.value.trim(),
    }
    if (baseUrl.value.trim()) body.base_url = baseUrl.value.trim()
    else body.base_url = null
    if (apiKey.value.trim()) body.api_key = apiKey.value.trim()
    await vendorApi.update(props.credential.id, body)
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
    :title="`供应商凭证：${credential.name}`"
    :width="480"
    @close="emit('close')"
  >
    <label class="fld">
      显示名
      <input v-model="name" type="text" placeholder="如：阿里千问" />
    </label>
    <label class="fld">
      API Key
      <input
        v-model="apiKey"
        type="password"
        :placeholder="
          credential.hasKey
            ? '留空保持不变（已配置 ' + credential.apiKeyMasked + '）'
            : '粘贴明文 key（仅存本地 secrets.json）'
        "
      />
    </label>
    <label class="fld">
      自定义端点（可选）
      <input
        v-model="baseUrl"
        type="text"
        placeholder="留空使用各能力默认端点"
      />
      <span class="note"
        >覆盖该厂商所有能力的默认 base_url（通常不需要填）</span
      >
    </label>
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

.note {
  display: block;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-3);
}
</style>
