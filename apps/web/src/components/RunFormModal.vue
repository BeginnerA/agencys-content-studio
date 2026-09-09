<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import Modal from './Modal.vue'
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
      const d = defaults[inp.key]
      if (inp.kind === 'int') form.value[inp.key] = d ?? ''
      else if (inp.kind === 'files') form.value[inp.key] = []
      else form.value[inp.key] = d ?? ''
    }
  } finally {
    loading.value = false
  }
})

function toggleAsset(inpKey: string, id: number) {
  const arr = (form.value[inpKey] as number[]) ?? []
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  form.value[inpKey] = [...arr]
}

function textOf(k: string): string {
  const v = form.value[k]
  return typeof v === 'string' ? v : ''
}

function numOf(k: string): string {
  const v = form.value[k]
  return v === undefined || v === '' ? '' : String(v)
}

function setText(k: string, s: string) {
  form.value[k] = s
}

function setNum(k: string, s: string) {
  form.value[k] = s
}

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
        <div v-for="inp in tpl.inputs" :key="inp.key" class="fld">
          <template v-if="inp.kind === 'text'">
            <label class="fld">
              {{ inp.label }} <span v-if="inp.required" class="req">*</span>
              <textarea
                :value="textOf(inp.key)"
                rows="3"
                @input="setText(inp.key, ($event.target as HTMLTextAreaElement).value)"
              />
            </label>
          </template>
          <template v-else-if="inp.kind === 'int'">
            <label class="fld">
              {{ inp.label }} <span v-if="inp.required" class="req">*</span>
              <input
                :value="numOf(inp.key)"
                type="number"
                @input="setNum(inp.key, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </template>
          <template v-else-if="inp.kind === 'files'">
            <div class="fld">
              {{ inp.label }}
              <span class="muted">（选 {{ ((form[inp.key] as number[]) ?? []).length }} 项）</span>
            </div>
            <div v-if="assets.length" class="picklist">
              <label v-for="a in assets" :key="a.id" class="opt">
                <input
                  type="checkbox"
                  :checked="((form[inp.key] as number[]) ?? []).includes(a.id)"
                  @change="toggleAsset(inp.key, a.id)"
                />
                <span>#{{ a.id }}</span> {{ a.name }}
                <em>{{ a.purpose }}</em>
              </label>
            </div>
            <div v-else class="muted">项目暂无资产——可先在项目页上传素材。</div>
          </template>
        </div>
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

.picklist {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
}

.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  padding: 2px 4px;
  cursor: pointer;
}

.opt:hover {
  background: #f5f7fa;
  border-radius: 5px;
}

.opt em {
  color: var(--text-3);
  font-style: normal;
  margin-left: auto;
  font-size: 11px;
}
</style>
