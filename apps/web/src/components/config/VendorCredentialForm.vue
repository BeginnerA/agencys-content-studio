<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Modal from '../common/Modal.vue'
import type { VendorCredential } from '../../lib/types'
import { vendorApi } from '../../lib/api'

// credential=null 为新建模式（填厂商标识）；非空为编辑模式（厂商标识不可改）
const props = defineProps<{
  credential: VendorCredential | null
}>()
const emit = defineEmits<{ saved: []; close: [] }>()

const isCreate = computed(() => props.credential == null)
const vendor = ref('')
const name = ref('')
const apiKey = ref('')
const baseUrl = ref('')
const err = ref('')
const busy = ref(false)

watch(
  () => props.credential,
  (cr) => {
    vendor.value = cr?.vendor ?? ''
    name.value = cr?.name ?? ''
    baseUrl.value = cr?.baseUrl ?? ''
    apiKey.value = ''
    err.value = ''
  },
  { immediate: true },
)

async function submit() {
  if (isCreate.value && !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(vendor.value.trim())) {
    err.value = '厂商标识必填：字母/数字/下划线/连字符，1–32 位（如 my-gateway）'
    return
  }
  if (!name.value.trim()) {
    err.value = '请填写显示名'
    return
  }
  if (isCreate.value && !apiKey.value.trim()) {
    err.value = '新建条目必须填写 API Key'
    return
  }
  busy.value = true
  err.value = ''
  try {
    const body: Record<string, unknown> = {
      vendor: (props.credential?.vendor ?? vendor.value).trim(),
      name: name.value.trim(),
    }
    if (baseUrl.value.trim()) body.base_url = baseUrl.value.trim()
    else if (!isCreate.value) body.base_url = null
    if (apiKey.value.trim()) body.api_key = apiKey.value.trim()
    if (isCreate.value) await vendorApi.create(body)
    else await vendorApi.update(props.credential!.id, body)
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
    :title="credential ? `密钥保管：${credential.name}` : '添加密钥保管条目'"
    :width="480"
    @close="emit('close')"
  >
    <label v-if="isCreate" class="fld">
      厂商标识（vendor）
      <input v-model="vendor" type="text" placeholder="如：my-gateway" />
      <span class="note"
        >唯一标识，建后不可改；与内置厂商重名将合并为一条</span
      >
    </label>
    <label class="fld">
      显示名
      <input v-model="name" type="text" placeholder="如：阿里百炼" />
    </label>
    <label class="fld">
      API Key
      <input
        v-model="apiKey"
        type="password"
        :placeholder="
          !isCreate && credential?.hasKey
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
