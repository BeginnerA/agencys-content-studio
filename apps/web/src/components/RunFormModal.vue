<script setup lang="ts">
import { ref } from 'vue'
import Modal from './Modal.vue'
import TemplatePicker from './TemplatePicker.vue'
import TemplateInputFields from './TemplateInputFields.vue'
import type { Asset, TemplateDetail, TemplateMeta } from '../lib/types'
import { projectApi, runApi, templateApi } from '../lib/api'

const props = defineProps<{ projectId: number; initialTemplateKey?: string; defaultTemplateKey?: string }>()
const emit = defineEmits<{ done: [runId: number]; close: [] }>()

const templates = ref<TemplateMeta[]>([])
const tplKey = ref('')
const tpl = ref<TemplateDetail | null>(null)
const assets = ref<Asset[]>([])
const form = ref<Record<string, unknown>>({})
const err = ref('')
const busy = ref(false)
const loading = ref(false)
const loadingDetail = ref(false)

/** 第二步：选中模板 → 加载详情 + 回填默认值 */
async function selectTemplate(key: string) {
  tplKey.value = key
  tpl.value = null
  form.value = {}
  err.value = ''
  loadingDetail.value = true
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
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadingDetail.value = false
  }
}

/** 返回第一步（重选模板） */
function backToPicker() {
  tplKey.value = ''
  tpl.value = null
  form.value = {}
  err.value = ''
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
    // 接力入口（initialTemplateKey 命中）直达表单；否则停在选卡段（不再自动选中字母序第一个）
    const initKey = props.initialTemplateKey
    if (initKey && tRes.items.some((t) => t.key === initKey)) await selectTemplate(initKey)
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
      <!-- 第一步：场景选卡（默认入口，按「出成品 / 做规划 / 发布与复盘」分组） -->
      <template v-if="!tplKey">
        <div class="lead muted">
          选择要做什么——产出类模板直接出成品；选题、策划、适配、复盘等辅助模板按需单独使用。
          <template v-if="defaultTemplateKey">带「默认」标记的是本项目常用模板。</template>
        </div>
        <TemplatePicker :templates="templates" :default-key="defaultTemplateKey" @select="selectTemplate" />
      </template>
      <!-- 第二步：输入表单 -->
      <template v-else>
        <div class="sel-h">
          <button type="button" class="lnk" @click="backToPicker">← 重选模板</button>
          <span class="sel-nm">{{ tpl?.name ?? tplKey }}</span>
        </div>
        <div v-if="loadingDetail" class="empty">加载中…</div>
        <template v-else-if="tpl">
          <div class="desc muted" style="margin-bottom: 10px">{{ tpl.description }}</div>
          <TemplateInputFields :tpl="tpl" :assets="assets" :values="form" @change="(k, v) => (form[k] = v)" />
        </template>
      </template>

      <div v-if="err" class="err-text">{{ err }}</div>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="busy || !tpl || !tplKey" @click="submit">
        {{ busy ? '启动中…' : '启动' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.lead {
  margin-bottom: 10px;
}

.sel-h {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.lnk {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent-h);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
}

.lnk:hover {
  text-decoration: underline;
}

.sel-nm {
  font-size: 14px;
  font-weight: 600;
}

.desc {
  margin-top: -4px;
}
</style>
