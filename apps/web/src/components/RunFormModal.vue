<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import Modal from './Modal.vue'
import TemplateInputFields from './TemplateInputFields.vue'
import type { Asset, TemplateDetail, TemplateMeta } from '../lib/types'
import { projectApi, runApi, templateApi } from '../lib/api'

const props = defineProps<{ projectId: number }>()
const emit = defineEmits<{ done: [runId: number]; close: [] }>()

const templates = ref<TemplateMeta[]>([])
const tplKey = ref('')
const tpl = ref<TemplateDetail | null>(null)
const assets = ref<Asset[]>([])
const form = ref<Record<string, unknown>>({})
const err = ref('')
const busy = ref(false)
const loading = ref(false)

// 模板切换后回填默认值
watch(tplKey, async (key) => {
  form.value = {}
  err.value = ''
  if (!key) {
    tpl.value = null
    return
  }
  loading.value = true
  try {
    const res = await templateApi.detail(key)
    tpl.value = res.template
    const defaults = (res.template.defaults ?? {}) as Record<string, unknown>
    for (const inp of res.template.inputs) {
      // 输入预填同源：优先 inputs.default（模板声明级），兼容旧 defaults[inp.key] 写法
      const d = inp.default !== undefined ? inp.default : defaults[inp.key]
      if (inp.kind === 'int') form.value[inp.key] = d ?? ''
      else if (inp.kind === 'bool') form.value[inp.key] = d === true
      else if (inp.kind === 'files') form.value[inp.key] = []
      else form.value[inp.key] = d ?? ''
    }
  } finally {
    loading.value = false
  }
})

async function submit() {
  if (!tpl.value) return
  // 归一化：空字符串 → 未填
  const input: Record<string, unknown> = {}
  for (const inp of tpl.value.inputs) {
    const v = form.value[inp.key]
    if (inp.required && (v === '' || v === undefined || (Array.isArray(v) && v.length === 0))) {
      err.value = `请填写必填项「${inp.label}」`
      return
    }
    if (inp.kind === 'int') input[inp.key] = Number(v)
    else if (inp.kind === 'bool') input[inp.key] = v === true
    else if (inp.kind === 'files') input[inp.key] = (v as number[]) ?? []
    else input[inp.key] = v ?? ''
  }
  busy.value = true
  err.value = ''
  try {
    const res = await runApi.start(props.projectId, { template_key: tpl.value.key, input })
    emit('done', res.run.id)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function init() {
  loading.value = true
  try {
    const [tRes, aRes] = await Promise.all([templateApi.list(), projectApi.assets(props.projectId, '?limit=100')])
    templates.value = tRes.items
    assets.value = aRes.items
    if (tRes.items.length) {
      tplKey.value = tRes.items[0]?.key ?? ''
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
init()
</script>

<template>
  <Modal title="启动流水线（新建 Run）" :width="680" @close="emit('close')">
    <div v-if="loading" class="empty">加载中…</div>
    <template v-else>
      <label class="fld">
        模板
        <select v-model="tplKey">
          <option v-for="t in templates" :key="t.key" :value="t.key">
            {{ t.name }}（{{ t.genre }} · {{ t.stepCount }} 步）
          </option>
        </select>
      </label>

      <template v-if="tpl">
        <div class="desc muted" style="margin-bottom: 10px">{{ tpl.description }}</div>
        <TemplateInputFields :tpl="tpl" :assets="assets" :values="form" @change="(k, v) => (form[k] = v)" />
      </template>

      <div v-if="err" class="err-text">{{ err }}</div>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="busy || !tpl" @click="submit">
        {{ busy ? '启动中…' : '启动' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.desc {
  margin-top: -4px;
}
</style>
