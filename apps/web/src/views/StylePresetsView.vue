<script setup lang="ts">
/**
 * [M8] 风格预设库：平台级通用画风词块（CRUD + 启用开关 + 排序）。
 * 项目绑定在项目「编辑」弹窗（settings.style_preset_id）；出图时由 ai_image 运行时解析注入。
 */
import { onMounted, reactive, ref } from 'vue'
import Modal from '../components/Modal.vue'
import Icon from '../components/Icon.vue'
import { stylePresetApi } from '../lib/api'
import { ApiError } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import type { StylePresetItem } from '../lib/types'

const items = ref<StylePresetItem[]>([])
const loading = ref(true)
const busy = ref(false)
const err = ref('')

const showForm = ref(false)
const form = reactive({
  id: 0,
  name: '',
  snippet: '',
  description: '',
  sortOrder: 0,
})
const formErr = ref('')

async function load() {
  loading.value = true
  err.value = ''
  try {
    const data = await stylePresetApi.list()
    items.value = data.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

function openNew() {
  form.id = 0
  form.name = ''
  form.snippet = ''
  form.description = ''
  form.sortOrder = (items.value[items.value.length - 1]?.sortOrder ?? 0) + 1
  formErr.value = ''
  showForm.value = true
}

function openEdit(p: StylePresetItem) {
  form.id = p.id
  form.name = p.name
  form.snippet = p.snippet
  form.description = p.description ?? ''
  form.sortOrder = p.sortOrder
  formErr.value = ''
  showForm.value = true
}

async function save() {
  if (!form.name.trim()) {
    formErr.value = '请填写预设名'
    return
  }
  if (!form.snippet.trim()) {
    formErr.value = '请填写风格词块 snippet（出图时逐字注入提示词）'
    return
  }
  busy.value = true
  formErr.value = ''
  try {
    const body = {
      name: form.name.trim(),
      snippet: form.snippet.trim(),
      description: form.description.trim() || null,
      sort_order: Number(form.sortOrder) || 0,
    }
    if (form.id) await stylePresetApi.update(form.id, body)
    else await stylePresetApi.create(body)
    showForm.value = false
    await load()
  } catch (e) {
    formErr.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

/** 启用 / 停用开关（停用后已绑定项目运行时零注入 + 日志，不炸链路） */
async function toggle(p: StylePresetItem) {
  busy.value = true
  try {
    await stylePresetApi.update(p.id, { is_active: p.isActive ? 0 : 1 })
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function removeItem(p: StylePresetItem) {
  const ok = await confirmDialog({
    title: '删除风格预设',
    message: `确认删除「${p.name}」？已绑定该预设的项目将退化为零风格注入（不报错），可先解绑再删。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await stylePresetApi.remove(p.id)
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-h">
      <h1>风格预设</h1>
      <span class="sub">{{ items.length }} 条 · 启用 {{ items.filter((p) => p.isActive).length }} 条</span>
      <button class="btn primary" style="margin-left: auto" @click="openNew">
        <Icon name="plus" :size="14" :stroke-width="2.2" /> 新建预设
      </button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!items.length" class="empty">
      还没有风格预设。新建画风词块（如「3D 写实厚涂」）后，在项目「编辑」里绑定 → 分镜图/首帧图/参考图出图时统一注入，保证全片视觉基调一致。
    </div>

    <div v-else class="list">
      <div v-for="p in items" :key="p.id" class="row panel" :class="{ off: !p.isActive }">
        <div class="ord" :title="`排序 ${p.sortOrder}`">{{ p.sortOrder }}</div>
        <div class="main">
          <div class="nm">
            {{ p.name }}
            <span v-if="!p.isActive" class="badge skip">已停用</span>
          </div>
          <div class="snip">{{ p.snippet }}</div>
          <div v-if="p.description" class="desc muted">{{ p.description }}</div>
        </div>
        <div class="ops">
          <button
            class="sw"
            :class="{ on: !!p.isActive }"
            role="switch"
            :aria-checked="!!p.isActive"
            :title="p.isActive ? '点击停用' : '点击启用'"
            :disabled="busy"
            @click="toggle(p)"
          >
            <span class="knob" />
          </button>
          <button class="btn tiny" @click="openEdit(p)"><Icon name="pencil" :size="12" /> 编辑</button>
          <button class="btn tiny danger" :disabled="busy" @click="removeItem(p)"><Icon name="trash" :size="12" /> 删除</button>
        </div>
      </div>
    </div>

    <Modal v-if="showForm" :title="form.id ? `编辑预设「${form.name}」` : '新建风格预设'" :width="640" @close="showForm = false">
      <div class="frow">
        <label class="fld">
          预设名 <span class="req">*</span>
          <input v-model="form.name" type="text" placeholder="如：3D 写实厚涂 · 冷蓝调" />
        </label>
        <label class="fld" style="max-width: 120px">
          排序号
          <input v-model.number="form.sortOrder" type="number" min="0" step="1" />
        </label>
      </div>
      <label class="fld">
        风格词块 snippet（出图时逐字拼入提示词尾缀：「视觉风格：{snippet}」）
        <textarea
          v-model="form.snippet"
          rows="3"
          placeholder="如：写实 3D 渲染厚涂画风，细腻光影与材质质感，电影级布光，冷蓝主色调"
        />
      </label>
      <label class="fld">
        描述 description（选填，说明适用题材）
        <input v-model="form.description" type="text" placeholder="如：适合科幻/悬疑向短剧" />
      </label>

      <div v-if="formErr" class="err-text">{{ formErr }}</div>
      <template #footer>
        <button class="btn" @click="showForm = false">取消</button>
        <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 13px 16px;
}

.row.off {
  opacity: 0.62;
}

.ord {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--chip-bg);
  color: var(--text-2);
  font-size: 12.5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nm {
  font-size: 14.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.snip {
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.desc {
  font-size: 11.5px;
}

.ops {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 2px;
}

.btn.tiny {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 7px;
}

.btn.tiny.danger:hover {
  border-color: rgb(248 113 113 / 60%);
  color: var(--bad);
}

/* 启用开关 */
.sw {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  cursor: pointer;
  padding: 0;
  transition: background 0.15s, border-color 0.15s;
}

.sw .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-3);
  transition: transform 0.15s, background 0.15s;
}

.sw.on {
  background: linear-gradient(135deg, rgb(139 92 246 / 40%), rgb(79 70 229 / 36%));
  border-color: rgb(139 92 246 / 55%);
}

.sw.on .knob {
  transform: translateX(16px);
  background: #fff;
}

.frow {
  display: flex;
  gap: 12px;
}

.frow .fld {
  flex: 1;
}
</style>
