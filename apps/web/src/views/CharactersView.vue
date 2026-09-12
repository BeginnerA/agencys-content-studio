<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import Modal from '../components/Modal.vue'
import Icon from '../components/Icon.vue'
import { characterApi, projectApi } from '../lib/api'
import { ApiError } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import type { Asset, CharacterItem, Project } from '../lib/types'

const items = ref<CharacterItem[]>([])
const projects = ref<Project[]>([])
const loading = ref(true)
const busy = ref(false)
const err = ref('')

// 筛选：'' = 全部 | 'global' = 仅全局 | `${id}` = 项目（含全局继承）
const projectFilter = ref('')

// 新建 / 编辑表单
const showForm = ref(false)
const form = reactive({
  id: 0,
  name: '',
  aliases: '',
  summary: '',
  appearance: '',
  negative: '',
  voice: '',
  projectId: 0,
  refIds: [] as number[],
})
const formErr = ref('')
const assetOptions = ref<Asset[]>([])
const assetsLoading = ref(false)

async function load() {
  loading.value = true
  err.value = ''
  try {
    const params = projectFilter.value && projectFilter.value !== 'global' ? `?project_id=${projectFilter.value}` : ''
    const data = await characterApi.list(params)
    items.value = projectFilter.value === 'global' ? data.items.filter((c) => c.scope === 'global') : data.items
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

/** 定妆照候选：仅项目域可行（全局角色库不接受项目资产引用） */
async function loadAssets(pid: number) {
  if (!pid) {
    assetOptions.value = []
    return
  }
  assetsLoading.value = true
  try {
    const d = await projectApi.assets(pid)
    assetOptions.value = d.items.filter((a) => a.kind === 'image')
  } catch {
    assetOptions.value = []
  } finally {
    assetsLoading.value = false
  }
}

function openNew() {
  form.id = 0
  form.name = ''
  form.aliases = ''
  form.summary = ''
  form.appearance = ''
  form.negative = ''
  form.voice = ''
  form.projectId = projectFilter.value && projectFilter.value !== 'global' ? Number(projectFilter.value) : 0
  form.refIds = []
  formErr.value = ''
  showForm.value = true
  void loadAssets(form.projectId)
}

function openEdit(it: CharacterItem) {
  form.id = it.id
  form.name = it.name
  form.aliases = it.aliases.join('、')
  form.summary = it.summary ?? ''
  form.appearance = it.appearance ?? ''
  form.negative = it.negative ?? ''
  form.voice = it.voice ?? ''
  form.projectId = it.projectId ?? 0
  form.refIds = [...it.refAssetIds]
  formErr.value = ''
  showForm.value = true
  void loadAssets(form.projectId)
}

function onPickProject() {
  // 切换归属项目 → 清空已选图（引用须属该项目）
  form.refIds = []
  void loadAssets(form.projectId)
}

function toggleRef(aid: number) {
  const i = form.refIds.indexOf(aid)
  if (i >= 0) form.refIds.splice(i, 1)
  else form.refIds.push(aid)
}

async function save() {
  if (!form.name.trim()) {
    formErr.value = '请填写角色名'
    return
  }
  busy.value = true
  formErr.value = ''
  try {
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      aliases: form.aliases
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
      summary: form.summary.trim() || null,
      appearance: form.appearance.trim() || null,
      negative: form.negative.trim() || null,
      voice: form.voice.trim() || null,
    }
    if (form.id) {
      if (form.projectId) body.ref_asset_ids = form.refIds
      await characterApi.update(form.id, body)
    } else {
      if (form.projectId) body.project_id = form.projectId
      if (form.refIds.length) body.ref_asset_ids = form.refIds
      await characterApi.create(body)
    }
    showForm.value = false
    await load()
  } catch (e) {
    formErr.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function removeItem(it: CharacterItem) {
  const ok = await confirmDialog({
    title: '删除角色',
    message: `确认删除角色「${it.name}」？定妆照资产会保留，仅删除档案。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await characterApi.remove(it.id)
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function photoOf(it: CharacterItem): string | null {
  const a = it.refAssets[0]
  return a ? (a.urls.thumb ?? a.urls.file) : null
}
</script>

<template>
  <div>
    <div class="page-h">
      <h1>角色</h1>
      <span class="sub">{{ items.length }} 名</span>
      <select v-model="projectFilter" style="width: 180px" aria-label="按归属筛选" @change="load()">
        <option value="">全部归属</option>
        <option value="global">仅全局</option>
        <option v-for="p in projects" :key="p.id" :value="String(p.id)">项目#{{ p.id }} {{ p.name }}</option>
      </select>
      <button class="btn primary" style="margin-left: auto" @click="openNew">
        <Icon name="plus" :size="14" :stroke-width="2.2" /> 新建角色
      </button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!items.length" class="empty">
      还没有角色。运行角色建档类模板（char_sync）自动入库，或手动新建；定妆照用于出图一致性锚定。
    </div>

    <div v-else class="grid">
      <div v-for="c in items" :key="c.id" class="card panel">
        <div class="photo">
          <img v-if="photoOf(c)" :src="photoOf(c)!" :alt="`${c.name} 定妆照`" loading="lazy" />
          <div v-else class="ph"><Icon name="users" :size="30" /></div>
        </div>
        <div class="body">
          <div class="top">
            <span class="nm">{{ c.name }}</span>
            <span class="badge" :class="{ skip: c.scope === 'global' }">{{ c.scope === 'global' ? '全局' : `项目#${c.projectId}` }}</span>
          </div>
          <div v-if="c.aliases.length" class="aliases muted">别名：{{ c.aliases.join('、') }}</div>
          <div class="summary">{{ c.appearance || c.summary || '—' }}</div>
          <div class="meta muted">
            <span v-if="c.voice"><Icon name="speaker-wave" :size="12" /> {{ c.voice }}</span>
            <span v-if="c.refAssetIds.length" class="chip">{{ c.refAssetIds.length }} 张定妆照</span>
          </div>
          <div class="ops">
            <button class="btn tiny" @click="openEdit(c)"><Icon name="pencil" :size="12" /> 编辑</button>
            <button class="btn tiny danger" :disabled="busy" @click="removeItem(c)"><Icon name="trash" :size="12" /> 删除</button>
          </div>
        </div>
      </div>
    </div>

    <Modal v-if="showForm" :title="form.id ? `编辑角色「${form.name}」` : '新建角色'" :width="640" @close="showForm = false">
      <div class="frow">
        <label class="fld">
          角色名 <span class="req">*</span>
          <input v-model="form.name" type="text" placeholder="如：萌宝" />
        </label>
        <label class="fld">
          别名（逗号 / 顿号分隔）
          <input v-model="form.aliases" type="text" placeholder="如：小宝、团团" />
        </label>
      </div>
      <label class="fld">
        形象锚定 appearance（出图一致性核心，注入分镜提示词）
        <textarea v-model="form.appearance" rows="3" placeholder="如：三岁半男孩，圆脸大眼，虎头帽红袄，矮胖灵动" />
      </label>
      <div class="frow">
        <label class="fld">
          必须剔除 negative
          <textarea v-model="form.negative" rows="2" placeholder="如：成人化五官、替换服装配色" />
        </label>
        <label class="fld">
          声线 voice（TTS 声线链 L2）
          <textarea v-model="form.voice" rows="2" placeholder="如：软糯童声（或网关 模型:音色 格式）" />
        </label>
      </div>
      <label class="fld">
        简介 summary
        <input v-model="form.summary" type="text" placeholder="一句话人物设定（可空）" />
      </label>

      <div class="refbox">
        <div class="rhead">
          <span>定妆照</span>
          <span v-if="!form.id" class="muted">
            归属：
            <select v-model.number="form.projectId" style="width: 200px" @change="onPickProject">
              <option :value="0">全局（不挂定妆照）</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">项目#{{ p.id }} {{ p.name }}</option>
            </select>
          </span>
          <span v-else class="muted">归属：{{ form.projectId ? `项目#${form.projectId}（不可改）` : '全局（不可挂图）' }}</span>
        </div>
        <template v-if="form.projectId">
          <div v-if="assetsLoading" class="muted" style="font-size: 12px">图片加载中…</div>
          <div v-else-if="!assetOptions.length" class="muted" style="font-size: 12px">该项目暂无图片资产（先出图或导入素材）</div>
          <div v-else class="thumbs">
            <button
              v-for="a in assetOptions"
              :key="a.id"
              class="thumb"
              :class="{ on: form.refIds.includes(a.id) }"
              :title="a.name"
              @click="toggleRef(a.id)"
            >
              <img :src="a.urls.thumb ?? a.urls.file" :alt="a.name" loading="lazy" />
              <span v-if="form.refIds.includes(a.id)" class="ck"><Icon name="check" :size="11" :stroke-width="2.6" /></span>
            </button>
          </div>
          <div class="muted" style="font-size: 11.5px">已选 {{ form.refIds.length }} 张（点击切换；建议正面/侧面/表情各一张）</div>
        </template>
        <div v-else class="muted" style="font-size: 12px">先选项目再挑图（全局角色库不接受项目资产引用）</div>
      </div>

      <div v-if="formErr" class="err-text">{{ formErr }}</div>
      <template #footer>
        <button class="btn" @click="showForm = false">取消</button>
        <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}

.card {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.photo {
  aspect-ratio: 3 / 4;
  background: rgb(148 163 184 / 8%);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.photo .ph {
  color: var(--text-3);
  opacity: 0.6;
}

.body {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.nm {
  font-size: 15px;
  font-weight: 600;
}

.aliases {
  font-size: 11.5px;
}

.summary {
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.5;
  min-height: 37px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.meta .chip {
  font-size: 11px;
}

.ops {
  display: flex;
  gap: 6px;
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

.frow {
  display: flex;
  gap: 12px;
}

.frow .fld {
  flex: 1;
}

.refbox {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.rhead {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--text-2);
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
