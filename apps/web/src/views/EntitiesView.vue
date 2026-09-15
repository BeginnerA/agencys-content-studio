<script setup lang="ts">
/**
 * [M8] 素材库（实体素材页）：角色 / 场景 / 道具三 Tab。
 * 单表多态（kind）——切换 Tab 重拉 /entities?kind=；appearance 标签与空态文案按 kind 适配；
 * 声线仅角色 Tab；挑图选择器 + 全局/项目域约束与旧角色页一致。
 * [M13] 卡片多选批量润色（appearance，≤10 项/次）+ 参考图上传通道 + 状态变体 states（仅角色）。
 * [M19 P6] 多选批量生成参考图：弹窗选变体（≤10 素材 × 1-4）→ 无 run 异步队列 → 页内进度（socket 驱动 + 轮询兜底）
 *   → 服务端自动挂接 ref_asset_ids；行内可取消 / 失败重试（重新发起）。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import Modal from '../components/Modal.vue'
import Icon from '../components/Icon.vue'
import { entityApi, projectApi, uploadEntityRefImage, voiceCloneApi } from '../lib/api'
import { ApiError } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import { getSocket, studioOff, studioOn } from '../lib/socket'
import type { StudioEventMap } from '../lib/socket'
import type { Asset, EntityItem, EntityKind, EntityRefGenTask, Project, VoiceCloneItem } from '../lib/types'

interface KindCfg {
  kind: EntityKind
  label: string
  icon: string
  nameLabel: string
  namePh: string
  aliasPh: string
  apLabel: string
  apPh: string
  negPh: string
  summaryPh: string
  refLabel: string
  empty: string
}

const KINDS: KindCfg[] = [
  {
    kind: 'character',
    label: '角色',
    icon: 'users',
    nameLabel: '角色名',
    namePh: '如：萌宝',
    aliasPh: '如：小宝、团团',
    apLabel: '形象锚定 appearance（出图一致性核心，注入分镜提示词）',
    apPh: '如：三岁半男孩，圆脸大眼，虎头帽红袄，矮胖灵动',
    negPh: '如：成人化五官、替换服装配色',
    summaryPh: '一句话人物设定（可空）',
    refLabel: '定妆照',
    empty: '还没有角色。运行角色建档类模板（character_sync）自动入库，或手动新建；定妆照用于出图一致性锚定。',
  },
  {
    kind: 'scene',
    label: '场景',
    icon: 'map',
    nameLabel: '场景名',
    namePh: '如：村口老槐树',
    aliasPh: '如：村口、老树下',
    apLabel: '视觉短语 appearance（空间布局/陈设/色调，注入分镜提示词）',
    apPh: '如：北方村落土坯房，灰瓦屋顶，门口石磨，暖黄夕照',
    negPh: '如：布局改变、陈设增减、色调偏移',
    summaryPh: '一句话说明（地点类型 + 剧情作用，可空）',
    refLabel: '场景参考图',
    empty: '还没有场景。运行素材建档模板（entity_sync）自动入库，或手动新建；场景参考图用于空镜一致性锚定。',
  },
  {
    kind: 'prop',
    label: '道具',
    icon: 'cube',
    nameLabel: '道具名',
    namePh: '如：虎头帽',
    aliasPh: '如：小帽子',
    apLabel: '外观描述 appearance（外形/材质/颜色，注入分镜提示词）',
    apPh: '如：大红绸面虎头帽，金线刺绣，两只毛绒虎耳',
    negPh: '如：形状改变、颜色偏移、材质错误',
    summaryPh: '一句话说明（物件属性 + 剧情作用，可空）',
    refLabel: '道具参考图',
    empty: '还没有道具。运行素材建档模板（entity_sync）自动入库，或手动新建；道具参考图用于出图一致性锚定。',
  },
]

const kind = ref<EntityKind>('character')
const cfg = computed(() => KINDS.find((k) => k.kind === kind.value)!)

const items = ref<EntityItem[]>([])
const projects = ref<Project[]>([])
const loading = ref(true)
const busy = ref(false)
const err = ref('')

// 筛选：'' = 全部 | 'global' = 仅全局 | `${id}` = 项目（含全局继承）
const projectFilter = ref('')

// [M13] 批量选择（仅服务批量润色；切换 Tab / 筛选清空）
const selected = ref(new Set<number>())
const polishing = ref(false)
const notice = ref('')

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
  /** [M13] 状态变体（每行一条；仅角色保存） */
  states: '',
  projectId: 0,
  refIds: [] as number[],
})
const formErr = ref('')
const assetOptions = ref<Asset[]>([])
const assetsLoading = ref(false)
// [M13] 参考图上传（仅编辑态；全局实体无入口）
const uploadEl = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const upNote = ref('')

// [M19 P8] 克隆音色（角色声线写 clone:{id}；下拉选中即回填，可清除）
const clones = ref<VoiceCloneItem[]>([])
const cloneSel = ref('')

/** 音色库拉取（失败静默：不阻断其余字段编辑） */
async function loadClones() {
  try {
    clones.value = (await voiceCloneApi.list()).items
  } catch {
    clones.value = []
  }
}

/** voice → 下拉选中态（仅 clone:{id} 且音色仍在库中时回显） */
function syncCloneSel() {
  const id = /^clone:(\d+)$/.exec(form.voice.trim())?.[1] ?? ''
  cloneSel.value = id && clones.value.some((c) => c.id === Number(id)) ? id : ''
}

/** 下拉变更：选中 → voice 填 clone:{id}；清除 → 仅移除克隆令牌（手工声线文本不动） */
function onCloneSelChange() {
  if (!cloneSel.value) {
    if (/^clone:\d+$/.test(form.voice.trim())) form.voice = ''
    return
  }
  form.voice = `clone:${cloneSel.value}`
}

/** 声线展示：clone:{id} → 「音色名（克隆）」；库中无此行 → 标注失效（运行时该级自动降级） */
function voiceLabel(v: string | null | undefined): string {
  const s = (v ?? '').trim()
  const m = /^clone:(\d+)$/.exec(s)
  if (!m) return s
  const c = clones.value.find((x) => x.id === Number(m[1]))
  return c ? `${c.name}（克隆）` : `${s}（音色库无此条目，运行时降级）`
}

async function load() {
  loading.value = true
  err.value = ''
  try {
    const params = projectFilter.value && projectFilter.value !== 'global' ? `&project_id=${projectFilter.value}` : ''
    const data = await entityApi.list(kind.value, params)
    items.value = projectFilter.value === 'global' ? data.items.filter((c) => c.scope === 'global') : data.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function switchKind(k: EntityKind) {
  if (kind.value === k) return
  kind.value = k
  selected.value = new Set()
  notice.value = ''
  resetRefPanel()
  void load()
}

/** [M13] 筛选变更 → 清空批量选择（跨范围选择易误操作） */
function onFilterChange() {
  selected.value = new Set()
  // [M19 P6] 进度面板按项目归属展示，切筛选后不得继续展示上一个项目的任务
  resetRefPanel()
  void load()
}

onMounted(() => {
  void load()
  void loadClones()
  projectApi
    .list()
    .then((d) => (projects.value = d.items))
    .catch(() => (projects.value = []))
  studioOn('entity.ref_gen', onRefGenEvent)
})

onBeforeUnmount(() => {
  studioOff('entity.ref_gen', onRefGenEvent)
  stopRefPolling()
  if (refSyncAt != null) clearTimeout(refSyncAt)
  if (joinedRefPid) getSocket().emit('leave', `project:${joinedRefPid}`)
})

/** 参考图候选：仅项目域可行（全局素材库不接受项目资产引用） */
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
  form.states = ''
  form.projectId = projectFilter.value && projectFilter.value !== 'global' ? Number(projectFilter.value) : 0
  form.refIds = []
  formErr.value = ''
  upNote.value = ''
  showForm.value = true
  cloneSel.value = ''
  void loadAssets(form.projectId)
}

function openEdit(it: EntityItem) {
  form.id = it.id
  form.name = it.name
  form.aliases = it.aliases.join('、')
  form.summary = it.summary ?? ''
  form.appearance = it.appearance ?? ''
  form.negative = it.negative ?? ''
  form.voice = it.voice ?? ''
  form.states = (it.states ?? []).join('\n')
  form.projectId = it.projectId ?? 0
  form.refIds = [...it.refAssetIds]
  formErr.value = ''
  upNote.value = ''
  showForm.value = true
  void loadAssets(form.projectId)
  // [M19 P8] 已存 clone:{id} 回显到下拉（音色库未就绪时先拉一次）
  if (!clones.value.length) void loadClones().then(syncCloneSel)
  else syncCloneSel()
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
    formErr.value = `请填写${cfg.value.nameLabel}`
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
    }
    if (kind.value === 'character') {
      body.voice = form.voice.trim() || null
      // [M13] 状态变体：每行一条（空数组 = 清空；scene/prop 不传）
      body.states = form.states
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    if (form.id) {
      if (form.projectId) body.ref_asset_ids = form.refIds
      await entityApi.update(form.id, body)
    } else {
      body.kind = kind.value
      if (form.projectId) body.project_id = form.projectId
      if (form.refIds.length) body.ref_asset_ids = form.refIds
      await entityApi.create(body)
    }
    showForm.value = false
    await load()
  } catch (e) {
    formErr.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function removeItem(it: EntityItem) {
  const ok = await confirmDialog({
    title: `删除${cfg.value.label}`,
    message: `确认删除${cfg.value.label}「${it.name}」？参考图资产会保留，仅删除档案。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await entityApi.remove(it.id)
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

/** [M13] 批量选择切换 */
function toggleSel(id: number) {
  if (selected.value.has(id)) selected.value.delete(id)
  else selected.value.add(id)
}

/** [M13] 批量润色 appearance（≤10 项；逐项串行；失败项保留选中可重试） */
async function polishSelected() {
  const ids = [...selected.value]
  if (ids.length === 0 || polishing.value) return
  if (ids.length > 10) {
    err.value = `单次最多润色 10 项（当前已选 ${ids.length} 项）`
    return
  }
  const ok = await confirmDialog({
    title: '批量润色',
    message: `将对所选 ${ids.length} 项的「形象锚定 appearance」调用 LLM 润色规范化，并覆盖原描述（summary / negative / 声线不动）；失败项不改动。继续？`,
    confirmText: '开始润色',
  })
  if (!ok) return
  polishing.value = true
  err.value = ''
  notice.value = ''
  try {
    const r = await entityApi.polish(ids)
    selected.value = new Set(r.failed.map((f) => f.id))
    const detail = r.failed
      .slice(0, 2)
      .map((f) => `#${f.id}：${f.error}`)
      .join('；')
    notice.value =
      `润色完成：成功 ${r.polished.length} 项` +
      (r.failed.length ? `，失败 ${r.failed.length} 项（失败项已保留选中，可重试）` : '') +
      (detail ? `\n${detail}` : '')
    await load()
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    polishing.value = false
  }
}

// ===== [M19 P6] 批量生成参考图（无 run 异步队列 + 页内进度）=====
const REFGEN_MAX_ITEMS = 10
const REFGEN_POLL_MS = 5_000
const REFGEN_STATUS_TEXT: Record<EntityRefGenTask['status'], string> = {
  pending: '排队中',
  processing: '出图中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const showRefGen = ref(false)
const refVariants = ref(1)
const refSubmitting = ref(false)
const refBusyTask = ref(0)
const refErr = ref('')
/** 本批次归属项目（打开弹窗时由所选素材推导；服务端要求同项目且非全局） */
const refPid = ref(0)
/** 已认领任务 id（发起结果 + 服务端在途任务）：事件与轮询只更新这批 */
const refBatch = ref(new Set<number>())
const refTasks = ref<EntityRefGenTask[]>([])
let refPoll: number | null = null
let refSyncAt: number | null = null
/** 本轮进度面板是否见过在途任务（只对「看着跑完」的批次弹提示 / 刷卡片，不抢他处发起的功劳） */
let refWasLive = false
let joinedRefPid = 0

const selItems = computed(() => items.value.filter((c) => selected.value.has(c.id)))
/** 所选素材的唯一项目 id（0 = 跨项目或含全局素材，服务端会整单拒绝 → 客户端先拦） */
const selProjectId = computed(() => {
  const pids = [...new Set(selItems.value.map((c) => c.projectId ?? 0))]
  return pids.length === 1 ? pids[0]! : 0
})
const selNoAppearance = computed(() => selItems.value.filter((c) => !(c.appearance ?? '').trim()).map((c) => c.name))
const refPlanned = computed(() => selItems.value.length * refVariants.value)
const refLive = computed(() => refTasks.value.filter((t) => t.status === 'pending' || t.status === 'processing'))
const refPct = computed(() => {
  const n = refTasks.value.length
  return n ? Math.round(((n - refLive.value.length) / n) * 100) : 0
})

/** join project:{pid} room：服务端仅向 run/canvas/project room 投递事件 */
function joinProjectRoom(pid: number) {
  if (joinedRefPid === pid) return
  const s = getSocket()
  if (joinedRefPid) s.emit('leave', `project:${joinedRefPid}`)
  s.emit('join', `project:${pid}`)
  joinedRefPid = pid
}

/** 服务端快照 → 合并进本页批次（按 id 覆盖，保持发起顺序） */
function mergeRefTasks(rows: EntityRefGenTask[]) {
  const byId = new Map(refTasks.value.map((t) => [t.id, t]))
  for (const r of rows) byId.set(r.id, r)
  refTasks.value = [...byId.values()].sort((a, b) => a.id - b.id)
}

/** 拉一次任务快照：认领在途任务（刷新页面 / 多标签下不重复发起），并收敛批次 */
async function refreshRefTasks() {
  if (!refPid.value) return
  try {
    const d = await entityApi.refGenTasks(refPid.value)
    const rows = d.items.filter((t) => refBatch.value.has(t.id) || t.status === 'pending' || t.status === 'processing')
    for (const t of rows) if (t.status === 'pending' || t.status === 'processing') refBatch.value.add(t.id)
    mergeRefTasks(rows)
    settleRefBatch()
  } catch {
    /* 静默：轮询下一轮再试（网络抖动不打断进度） */
  }
}

/** 进度收敛：仍有在途 → 保活轮询；全部终态 → 停轮询 + 结果提示 + 刷卡片（新参考图已由服务端挂接） */
function settleRefBatch() {
  if (refLive.value.length) {
    refWasLive = true
    ensureRefPolling()
    return
  }
  if (!refWasLive || !refTasks.value.length) return
  refWasLive = false
  stopRefPolling()
  const ok = refTasks.value.filter((t) => t.status === 'succeeded').length
  const bad = refTasks.value.filter((t) => t.status === 'failed')
  notice.value =
    `参考图生成完成：成功 ${ok} 张 / 共 ${refTasks.value.length} 个任务` +
    (bad.length ? `，失败 ${bad.length} 项（行内可重试，原因见进度行）` : '') +
    (bad.length ? `\n${bad[0]!.entityName}：${bad[0]!.errorMsg ?? '未知原因'}` : '') +
    '\n新图已自动挂接到对应素材参考图。'
  void load()
}

function ensureRefPolling() {
  if (refPoll != null) return
  refPoll = window.setInterval(() => {
    if (refLive.value.length) void refreshRefTasks()
    else stopRefPolling()
  }, REFGEN_POLL_MS)
}

function stopRefPolling() {
  if (refPoll != null) {
    clearInterval(refPoll)
    refPoll = null
  }
}

/** socket 事件驱动：同一任务的高频事件合并后 400ms 拉一次快照（轮询仅作兜底） */
function onRefGenEvent(p: StudioEventMap['entity.ref_gen']) {
  if (!refBatch.value.has(p.taskId) || refSyncAt != null) return
  refSyncAt = window.setTimeout(() => {
    refSyncAt = null
    void refreshRefTasks()
  }, 400)
}

/** 收起 / 切换筛选：清空批次认领并停表（避免展示他项目任务或后台空转） */
function resetRefPanel() {
  stopRefPolling()
  if (refSyncAt != null) {
    clearTimeout(refSyncAt)
    refSyncAt = null
  }
  refTasks.value = []
  refBatch.value = new Set()
  refWasLive = false
}

async function openRefGen() {
  refErr.value = ''
  const list = selItems.value
  if (!list.length) {
    refErr.value = '先勾选素材卡片（左上角复选框）'
    return
  }
  if (list.length > REFGEN_MAX_ITEMS) {
    refErr.value = `单次最多 ${REFGEN_MAX_ITEMS} 个素材（当前已选 ${list.length} 个）`
    return
  }
  const pid = selProjectId.value
  if (!pid) {
    refErr.value = '所选素材须同属一个项目（全局素材不参与批量生成）'
    return
  }
  refPid.value = pid
  refVariants.value = 1
  showRefGen.value = true
  joinProjectRoom(pid)
  await refreshRefTasks()
}

async function submitRefGen() {
  if (refSubmitting.value) return
  const ids = selItems.value.map((c) => c.id)
  refErr.value = ''
  if (!ids.length) {
    refErr.value = '请先勾选素材'
    return
  }
  refSubmitting.value = true
  try {
    const r = await entityApi.refGen(refPid.value, ids, refVariants.value)
    for (const t of r.tasks) refBatch.value.add(t.id)
    showRefGen.value = false
    selected.value = new Set()
    notice.value = `已入队 ${r.count} 个出图任务（项目#${refPid.value}），完成后自动挂接参考图。`
    ensureRefPolling()
    await refreshRefTasks()
  } catch (e) {
    refErr.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    refSubmitting.value = false
  }
}

/** 取消单任务（服务端仅 pending/processing 可取消；已发出的出图请求完成后弃存） */
async function cancelRefTask(t: EntityRefGenTask) {
  if (refBusyTask.value) return
  refBusyTask.value = t.id
  try {
    await entityApi.cancelRefGenTask(t.id)
    await refreshRefTasks()
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    refBusyTask.value = 0
  }
}

/** 失败重试 = 对该实体重新发起一轮入队（旧任务保留终态留痕） */
async function retryRefTask(t: EntityRefGenTask) {
  if (refBusyTask.value) return
  refBusyTask.value = t.id
  try {
    const r = await entityApi.refGen(refPid.value, [t.entityId], 1)
    for (const nt of r.tasks) refBatch.value.add(nt.id)
    notice.value = ''
    ensureRefPolling()
    await refreshRefTasks()
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    refBusyTask.value = 0
  }
}

/** [M13] 触发上传参考图文件选择（编辑态可用） */
function pickUpload() {
  uploadEl.value?.click()
}

/** [M13] 上传参考图 → 入库 + 挂接（form.refIds 同步最新；失败不关闭弹窗） */
async function onUploadPick(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !form.id) return
  uploading.value = true
  formErr.value = ''
  upNote.value = ''
  try {
    const r = await uploadEntityRefImage(form.id, file)
    form.refIds = [...r.entity.refAssetIds]
    upNote.value = `已上传「${r.asset.name}」并挂接（当前共 ${form.refIds.length} 张）`
    await loadAssets(form.projectId)
    void load()
  } catch (ex) {
    formErr.value = ex instanceof ApiError ? ex.message : String(ex)
  } finally {
    uploading.value = false
  }
}

function photoOf(it: EntityItem): string | null {
  const a = it.refAssets[0]
  return a ? (a.urls.thumb ?? a.urls.file) : null
}

/** 卡片图比例按 kind：角色竖版 / 场景横版 / 道具方版 */
const ratioCls = computed(() => ({ character: 'pc', scene: 'ps', prop: 'pp' })[kind.value])
</script>

<template>
  <div>
    <div class="page-h">
      <h1>素材</h1>
      <div class="tabs" role="tablist" aria-label="素材类型">
        <button
          v-for="k in KINDS"
          :key="k.kind"
          class="tab"
          :class="{ on: kind === k.kind }"
          role="tab"
          :aria-selected="kind === k.kind"
          @click="switchKind(k.kind)"
        >
          <Icon :name="k.icon" :size="14" /> {{ k.label }}
        </button>
      </div>
      <span class="sub">{{ items.length }} 项</span>
      <select v-model="projectFilter" style="width: 180px" aria-label="按归属筛选" @change="onFilterChange">
        <option value="">全部归属</option>
        <option value="global">仅全局</option>
        <option v-for="p in projects" :key="p.id" :value="String(p.id)">项目#{{ p.id }} {{ p.name }}</option>
      </select>
      <button
        class="btn"
        style="margin-left: auto"
        :disabled="polishing || !selected.size"
        :title="selected.size ? `已选素材批量出参考图（≤${REFGEN_MAX_ITEMS} 项，完成后自动挂接）` : '先勾选素材卡片'"
        @click="openRefGen"
      >
        <Icon name="imageplus" :size="14" /> 生成参考图（{{ selected.size }}）
      </button>
      <button
        class="btn"
        :disabled="polishing || !selected.size"
        :title="selected.size ? `对已选 ${selected.size} 项润色 appearance（≤10 项/次）` : '先勾选素材卡片'"
        @click="polishSelected"
      >
        <Icon name="sparkles" :size="14" /> {{ polishing ? '润色中…' : `批量润色（${selected.size}）` }}
      </button>
      <button class="btn primary" @click="openNew">
        <Icon name="plus" :size="14" :stroke-width="2.2" /> 新建{{ cfg.label }}
      </button>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="notice" class="notice-box">{{ notice }}</div>

    <!-- [M19 P6] 批量生成进度（socket 驱动 + 轮询兜底；行内可取消 / 失败重试） -->
    <div v-if="refTasks.length" class="refgen panel">
      <div class="rg-head">
        <span class="rg-t"><Icon name="imageplus" :size="13" /> 参考图生成进度（项目#{{ refPid }}）</span>
        <span class="muted">{{ refTasks.length - refLive.length }}/{{ refTasks.length }} · {{ refPct }}%</span>
        <button class="btn tiny" type="button" @click="resetRefPanel">收起</button>
      </div>
      <div class="bar"><span class="fill" :style="{ width: refPct + '%' }" /></div>
      <div class="rg-rows">
        <div v-for="t in refTasks" :key="t.id" class="rg-row">
          <span class="badge" :class="t.status">{{ REFGEN_STATUS_TEXT[t.status] }}</span>
          <span class="rg-nm">{{ t.entityName }}</span>
          <span class="muted rg-v">变体 {{ t.variantIndex + 1 }}</span>
          <span class="muted rg-msg">
            <template v-if="t.errorMsg">{{ t.errorMsg }}</template>
            <template v-else-if="t.status === 'succeeded' && t.resultAssetId">已挂接 asset#{{ t.resultAssetId }}</template>
          </span>
          <span class="rg-ops">
            <button
              v-if="t.status === 'pending' || t.status === 'processing'"
              class="btn tiny"
              :disabled="refBusyTask !== 0"
              @click="cancelRefTask(t)"
            >
              <Icon name="stop" :size="11" /> 取消
            </button>
            <button v-else-if="t.status === 'failed'" class="btn tiny" :disabled="refBusyTask !== 0" @click="retryRefTask(t)">
              <Icon name="refresh" :size="11" /> 重试
            </button>
          </span>
        </div>
      </div>
      <div v-if="refLive.length" class="muted rg-tip">并发上限 2，其余排队中；完成后本页自动刷新卡片参考图张数。</div>
    </div>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!items.length" class="empty">{{ cfg.empty }}</div>

    <div v-else class="grid">
      <div v-for="c in items" :key="c.id" class="card panel" :class="{ picked: selected.has(c.id) }">
        <div class="photo" :class="ratioCls">
          <label class="pick" :title="selected.has(c.id) ? '取消选择' : '加入批量选择'">
            <input type="checkbox" :checked="selected.has(c.id)" @change="toggleSel(c.id)" />
          </label>
          <img v-if="photoOf(c)" :src="photoOf(c)!" :alt="`${c.name} 参考图`" loading="lazy" />
          <div v-else class="ph"><Icon :name="cfg.icon" :size="30" /></div>
        </div>
        <div class="body">
          <div class="top">
            <span class="nm">{{ c.name }}</span>
            <span class="badge" :class="{ skip: c.scope === 'global' }">{{ c.scope === 'global' ? '全局' : `项目#${c.projectId}` }}</span>
          </div>
          <div v-if="c.aliases.length" class="aliases muted">别名：{{ c.aliases.join('、') }}</div>
          <div class="summary">{{ c.appearance || c.summary || '—' }}</div>
          <div v-if="c.states.length" class="states">
            <span v-for="s in c.states.slice(0, 2)" :key="s" class="chip state" :title="s">{{ s }}</span>
            <span v-if="c.states.length > 2" class="chip">+{{ c.states.length - 2 }}</span>
          </div>
          <div class="meta muted">
            <span v-if="c.voice"><Icon name="speaker-wave" :size="12" /> {{ voiceLabel(c.voice) }}</span>
            <span v-if="c.refAssetIds.length" class="chip">{{ c.refAssetIds.length }} 张{{ cfg.refLabel }}</span>
          </div>
          <div class="ops">
            <button class="btn tiny" @click="openEdit(c)"><Icon name="pencil" :size="12" /> 编辑</button>
            <button class="btn tiny danger" :disabled="busy" @click="removeItem(c)"><Icon name="trash" :size="12" /> 删除</button>
          </div>
        </div>
      </div>
    </div>

    <Modal
      v-if="showForm"
      :title="form.id ? `编辑${cfg.label}「${form.name}」` : `新建${cfg.label}`"
      :width="640"
      @close="showForm = false"
    >
      <div class="frow">
        <label class="fld">
          {{ cfg.nameLabel }} <span class="req">*</span>
          <input v-model="form.name" type="text" :placeholder="cfg.namePh" />
        </label>
        <label class="fld">
          别名（逗号 / 顿号分隔）
          <input v-model="form.aliases" type="text" :placeholder="cfg.aliasPh" />
        </label>
      </div>
      <label class="fld">
        {{ cfg.apLabel }}
        <textarea v-model="form.appearance" rows="3" :placeholder="cfg.apPh" />
      </label>
      <div class="frow">
        <label class="fld">
          必须剔除 negative
          <textarea v-model="form.negative" rows="2" :placeholder="cfg.negPh" />
        </label>
        <label v-if="kind === 'character'" class="fld">
          声线 voice（TTS 声线链 L2）
          <textarea v-model="form.voice" rows="2" placeholder="如：软糯童声（或网关 模型:音色 格式）" />
          <!-- [M19 P8] 选克隆音色：选中写入 clone:{id}（服务端换克隆端点并覆盖为克隆绑定模型）；选首项仅清除克隆令牌 -->
          <select v-model="cloneSel" @change="onCloneSelChange">
            <option value="">{{ clones.length ? '选克隆音色（clone:{id}）…' : '选克隆音色——音色库为空（先到 Settings → 音色库复刻）' }}</option>
            <option v-for="c in clones" :key="c.id" :value="String(c.id)">{{ c.name }}（{{ c.providerKey }} / {{ c.model }}）</option>
          </select>
        </label>
      </div>
      <label v-if="kind === 'character'" class="fld">
        状态变体 states（每行一条；格式「剧情节点：状态短语」；节点优先用「第N场 / 第N集」定位词，出图逐镜自动命中）
        <textarea v-model="form.states" rows="2" placeholder="如：第5场受伤：额头绷带" />
      </label>
      <label class="fld">
        简介 summary
        <input v-model="form.summary" type="text" :placeholder="cfg.summaryPh" />
      </label>

      <div class="refbox">
        <div class="rhead">
          <span>{{ cfg.refLabel }}</span>
          <span v-if="!form.id" class="muted">
            归属：
            <select v-model.number="form.projectId" style="width: 200px" @change="onPickProject">
              <option :value="0">全局（不挂参考图）</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">项目#{{ p.id }} {{ p.name }}</option>
            </select>
          </span>
          <span v-else class="muted">归属：{{ form.projectId ? `项目#${form.projectId}（不可改）` : '全局（不可挂图）' }}</span>
          <button
            v-if="form.id && form.projectId"
            class="btn tiny"
            type="button"
            style="margin-left: auto"
            :disabled="uploading"
            @click="pickUpload"
          >
            <Icon name="plus" :size="12" /> {{ uploading ? '上传中…' : '上传新图' }}
          </button>
          <input ref="uploadEl" type="file" accept="image/*" class="hidden-file" @change="onUploadPick" />
        </div>
        <div v-if="upNote" class="up-note">{{ upNote }}</div>
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
          <div class="muted" style="font-size: 11.5px">已选 {{ form.refIds.length }} 张（点击切换；建议覆盖主要角度/光线）</div>
        </template>
        <div v-else class="muted" style="font-size: 12px">先选项目再挑图（全局素材库不接受项目资产引用）</div>
      </div>

      <div v-if="formErr" class="err-text">{{ formErr }}</div>
      <template #footer>
        <button class="btn" @click="showForm = false">取消</button>
        <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
      </template>
    </Modal>

    <!-- [M19 P6] 批量生成参考图弹窗：变体数 + 预估张数（实际校验与入队在服务端） -->
    <Modal v-if="showRefGen" title="批量生成参考图" :width="560" @close="showRefGen = false">
      <div class="rgbox">
        <div class="rg-lbl">所选素材（{{ selItems.length }} 项 · 项目#{{ refPid }}）</div>
        <div class="rg-chips">
          <span v-for="c in selItems" :key="c.id" class="chip">{{ c.name }}</span>
        </div>
        <div v-if="selNoAppearance.length" class="rg-warn">
          <Icon name="alert" :size="12" /> 缺 appearance 锚定：{{ selNoAppearance.join('、') }}——服务端会整单拒绝，请先补全或批量润色。
        </div>
        <label class="fld">
          每个素材生成变体数
          <select v-model.number="refVariants">
            <option :value="1">1 张</option>
            <option :value="2">2 张</option>
            <option :value="3">3 张</option>
            <option :value="4">4 张</option>
          </select>
        </label>
        <div class="rg-note">
          将生成 <b>{{ refPlanned }}</b> 张：出图配置取项目设置里的图像端点/模型/尺寸，提示词 = appearance + 项目画风词块 +
          negative；已有参考图会作为锚定输入（最多 4 张），完成后自动追加挂接，可进编辑弹窗挑拣。
        </div>
        <div v-if="refLive.length" class="muted rg-note2">该项目另有 {{ refLive.length }} 个任务正在出图，本次将一并排队。</div>
        <div v-if="refErr" class="err-text">{{ refErr }}</div>
      </div>
      <template #footer>
        <button class="btn" @click="showRefGen = false">取消</button>
        <button class="btn primary" :disabled="refSubmitting || !refPlanned" @click="submitRefGen">
          {{ refSubmitting ? '入队中…' : `开始生成（${refPlanned} 张）` }}
        </button>
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

/* [M13] 卡片多选态 */
.card.picked {
  border-color: var(--accent);
}

.photo {
  position: relative;
  background: rgb(148 163 184 / 8%);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.pick {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 1;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: rgb(8 11 20 / 55%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.pick input {
  width: 15px;
  height: 15px;
  cursor: pointer;
}

.photo.pc {
  aspect-ratio: 3 / 4;
}

.photo.ps {
  aspect-ratio: 16 / 9;
}

.photo.pp {
  aspect-ratio: 4 / 3;
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

/* [M13] 状态变体 chips */
.states {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.states .state {
  font-size: 11px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

/* [M13] 批量润色结果 notice */
.notice-box {
  margin-bottom: 12px;
  padding: 9px 12px;
  border: 1px solid rgb(34 197 94 / 35%);
  border-radius: 9px;
  background: var(--ok-weak);
  color: var(--ok);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-line;
}

.up-note {
  color: var(--ok);
  font-size: 12px;
}

.hidden-file {
  display: none;
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

/* ===== [M19 P6] 批量生成参考图：页内进度面板 + 弹窗 ===== */
.refgen {
  margin-bottom: 14px;
  padding: 11px 13px 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.rg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}

.rg-t {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-right: auto;
  font-weight: 600;
}

.bar {
  height: 5px;
  border-radius: 999px;
  background: rgb(148 163 184 / 14%);
  overflow: hidden;
}

.bar .fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--indigo-deep), var(--run));
  transition: width 0.3s ease;
}

.rg-rows {
  display: flex;
  flex-direction: column;
  max-height: 246px;
  overflow-y: auto;
}

.rg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  border-top: 1px solid rgb(148 163 184 / 8%);
}

.rg-row:first-child {
  border-top: none;
}

.rg-row .badge {
  flex: none;
  font-size: 11px;
}

.rg-nm {
  flex: none;
  max-width: 150px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rg-v {
  flex: none;
  font-size: 11px;
}

.rg-msg {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rg-ops {
  flex: none;
  display: flex;
  gap: 6px;
}

.rg-tip {
  font-size: 11.5px;
}

.rgbox {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rg-lbl {
  font-size: 12.5px;
  color: var(--text-2);
}

.rg-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.rg-warn {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid rgb(245 158 11 / 20%);
  border-radius: 8px;
  background: var(--warn-weak);
  color: var(--warn);
  font-size: 12px;
  line-height: 1.5;
}

.rg-note,
.rg-note2 {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-2);
}

.rg-note2 {
  color: var(--text-3);
}

.rgbox b {
  color: var(--accent);
}
</style>
