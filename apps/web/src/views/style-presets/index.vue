<script setup lang="ts">
/**
 * 风格预设库：平台级通用画风词块（CRUD + 启用开关 + 排序）。
 * 从参考图提取画风词（视觉 LLM → 预填新建表单，不落库）；项目多选绑定在项目「编辑」弹窗
 * （settings.style_preset_ids）；出图时由 ai_image 运行时解析拼接注入。
 */
import { onMounted, reactive, ref } from 'vue'
import Modal from '../../components/common/Modal.vue'
import Icon from '../../components/common/Icon.vue'
import { projectApi, stylePresetApi } from '../../lib/api'
import { ApiError } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { Asset, Project, StylePresetItem } from '../../lib/types'

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

// 从参考图提取（项目 → 图片多选 ≤4 → 视觉 LLM → 预填 snippet；不落库）
const projects = ref<Project[]>([])
const extractPid = ref(0)
const extractAssets = ref<Asset[]>([])
const extractIds = ref<number[]>([])
const assetsLoading = ref(false)
const extracting = ref(false)
const extractErr = ref('')
const extractNote = ref('')

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

onMounted(() => {
  void load()
  projectApi
    .list()
    .then((d) => (projects.value = d.items))
    .catch(() => (projects.value = []))
})

function openNew() {
  form.id = 0
  form.name = ''
  form.snippet = ''
  form.description = ''
  form.sortOrder = (items.value[items.value.length - 1]?.sortOrder ?? 0) + 1
  formErr.value = ''
  extractErr.value = ''
  extractNote.value = ''
  showForm.value = true
}

function openEdit(p: StylePresetItem) {
  form.id = p.id
  form.name = p.name
  form.snippet = p.snippet
  form.description = p.description ?? ''
  form.sortOrder = p.sortOrder
  formErr.value = ''
  extractErr.value = ''
  extractNote.value = ''
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

/** 提取用项目切换 → 拉取该项目图片候选（清空已选） */
async function onExtractProject() {
  extractIds.value = []
  extractAssets.value = []
  extractErr.value = ''
  extractNote.value = ''
  if (!extractPid.value) return
  assetsLoading.value = true
  try {
    const d = await projectApi.assets(extractPid.value)
    extractAssets.value = d.items.filter((a) => a.kind === 'image')
  } catch {
    extractAssets.value = []
  } finally {
    assetsLoading.value = false
  }
}

/** 参考图勾选（上限 4 张：多图仅取共同风格，过多会稀释特征） */
function toggleExtractAsset(aid: number) {
  const i = extractIds.value.indexOf(aid)
  if (i >= 0) {
    extractIds.value.splice(i, 1)
    return
  }
  if (extractIds.value.length >= 4) {
    extractErr.value = '最多选择 4 张（多图仅提取共同风格特征）'
    return
  }
  extractErr.value = ''
  extractIds.value.push(aid)
}

/** 提取风格词 → 预填 snippet（确认后随表单保存落库，不自动建预设） */
async function doExtract() {
  if (!extractPid.value) {
    extractErr.value = '请先选择项目'
    return
  }
  if (!extractIds.value.length) {
    extractErr.value = '请勾选 1~4 张参考图'
    return
  }
  extracting.value = true
  extractErr.value = ''
  extractNote.value = ''
  try {
    const r = await stylePresetApi.extract(extractPid.value, extractIds.value)
    form.snippet = r.snippet
    extractNote.value = `已提取并预填下方「风格词块」（来源 ${r.provider} / ${r.model}），确认无误后点保存入库`
  } catch (e) {
    extractErr.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    extracting.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-h">
      <h1>风格预设</h1>
      <span class="sub"
        >{{ items.length }} 条 · 启用
        {{ items.filter((p) => p.isActive).length }} 条</span
      >
      <button class="btn primary" style="margin-left: auto" @click="openNew">
        <Icon name="plus" :size="14" :stroke-width="2.2" /> 新建预设
      </button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!items.length" class="empty">
      还没有风格预设。新建画风词块（如「3D 写实厚涂」）后，在项目「编辑」里绑定
      → 分镜图/首帧图/参考图出图时统一注入，保证全片视觉基调一致。
    </div>

    <div v-else class="list">
      <div
        v-for="p in items"
        :key="p.id"
        class="row panel"
        :class="{ off: !p.isActive }"
      >
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
          <button class="btn tiny" @click="openEdit(p)">
            <Icon name="pencil" :size="12" /> 编辑
          </button>
          <button
            class="btn tiny danger"
            :disabled="busy"
            @click="removeItem(p)"
          >
            <Icon name="trash" :size="12" /> 删除
          </button>
        </div>
      </div>
    </div>

    <Modal
      v-if="showForm"
      :title="form.id ? `编辑预设「${form.name}」` : '新建风格预设'"
      :width="640"
      @close="showForm = false"
    >
      <div class="frow">
        <label class="fld">
          预设名 <span class="req">*</span>
          <input
            v-model="form.name"
            type="text"
            placeholder="如：3D 写实厚涂 · 冷蓝调"
          />
        </label>
        <label class="fld" style="max-width: 120px">
          排序号
          <input
            v-model.number="form.sortOrder"
            type="number"
            min="0"
            step="1"
          />
        </label>
      </div>
      <div class="extract-box">
        <div class="eb-head">
          <span
            ><Icon name="sparkles" :size="13" />
            从参考图提取画风词（可选）</span
          >
          <span class="muted" style="font-size: 11.5px"
            >1~4 张同基调参考图 → 视觉模型提取 → 预填下方词块</span
          >
        </div>
        <div class="frow">
          <label class="fld" style="max-width: 220px">
            项目
            <select v-model.number="extractPid" @change="onExtractProject">
              <option :value="0">选择项目…</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">
                项目#{{ p.id }} {{ p.name }}
              </option>
            </select>
          </label>
          <div class="eb-imgs">
            <span>参考图（已选 {{ extractIds.length }}/4）</span>
            <span v-if="!extractPid" class="muted" style="font-size: 12px"
              >先选项目</span
            >
            <span
              v-else-if="assetsLoading"
              class="muted"
              style="font-size: 12px"
              >图片加载中…</span
            >
            <span
              v-else-if="!extractAssets.length"
              class="muted"
              style="font-size: 12px"
              >该项目暂无图片资产（先出图或导入素材）</span
            >
            <div v-else class="thumbs">
              <button
                v-for="a in extractAssets"
                :key="a.id"
                type="button"
                class="thumb"
                :class="{ on: extractIds.includes(a.id) }"
                :title="a.name"
                @click="toggleExtractAsset(a.id)"
              >
                <img
                  :src="a.urls.thumb ?? a.urls.file"
                  :alt="a.name"
                  loading="lazy"
                />
                <span v-if="extractIds.includes(a.id)" class="ck"
                  ><Icon name="check" :size="11" :stroke-width="2.6"
                /></span>
              </button>
            </div>
          </div>
        </div>
        <div class="eb-ops">
          <button
            class="btn tiny"
            type="button"
            :disabled="extracting || !extractPid || !extractIds.length"
            @click="doExtract"
          >
            <Icon name="sparkles" :size="12" />
            {{ extracting ? '提取中…' : '提取风格词' }}
          </button>
          <span v-if="extractErr" class="eb-err">{{ extractErr }}</span>
          <span v-else-if="extractNote" class="eb-ok">{{ extractNote }}</span>
          <span v-else class="muted" style="font-size: 11.5px"
            >提取依赖支持图片输入的 LLM 视觉模型（设置 → AI 配置）</span
          >
        </div>
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
        <input
          v-model="form.description"
          type="text"
          placeholder="如：适合科幻/悬疑向短剧"
        />
      </label>

      <div v-if="formErr" class="err-text">{{ formErr }}</div>
      <template #footer>
        <button class="btn" @click="showForm = false">取消</button>
        <button class="btn primary" :disabled="busy" @click="save">
          {{ busy ? '保存中…' : '保存' }}
        </button>
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
  transition:
    background 0.15s,
    border-color 0.15s;
}

.sw .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-3);
  transition:
    transform 0.15s,
    background 0.15s;
}

.sw.on {
  background: linear-gradient(
    135deg,
    rgb(139 92 246 / 40%),
    rgb(79 70 229 / 36%)
  );
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

/* 从参考图提取 */
.extract-box {
  margin: 2px 0 12px;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.eb-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  font-weight: 600;
}

.eb-imgs {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--text-2);
}

.eb-ops {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.eb-err {
  color: var(--bad);
  font-size: 12px;
}

.eb-ok {
  color: var(--ok);
  font-size: 12px;
}

.thumbs {
  display: flex;
  gap: 7px;
  overflow-x: auto;
  padding: 3px 2px 7px;
}

.thumb {
  position: relative;
  flex: none;
  width: 58px;
  height: 74px;
  padding: 0;
  border-radius: 7px;
  overflow: hidden;
  border: 2px solid var(--border);
  background: var(--panel-2);
  cursor: pointer;
  transition: border-color 0.15s;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.thumb:hover {
  border-color: rgb(99 102 241 / 55%);
}

.thumb.on {
  border-color: var(--accent);
}

.thumb .ck {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
