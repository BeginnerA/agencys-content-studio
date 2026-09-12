<script setup lang="ts">
/**
 * [M10] 分镜可视化大编辑器（spec §4.2）
 * 挂载：ShotBoard 头条「编辑分镜」（Modal）
 * 形态：两栏——左=镜头列表（拖拽排序 / 选中 / 删除标记 / 新增），右=字段表单
 * 保存：本地草稿 diff → ops（add* → patch* → remove* → reorder）→ shotApi.mutate（不触发执行）
 * 专用控件：id / image_prompt / motion_prompt / duration（duration ↔ duration_sec 双口径）/ characters（标签 + datalist）
 * 其余字段：动态键值行（string/number/boolean 原生控件；array/object JSON 文本编辑 + 保存时 parse）
 * 守卫：canOperate 为假只读；dirty 关闭需确认；「移除字段」以 null 置空（服务端浅合并无法真删键）
 */
import { computed, onMounted, ref } from 'vue'
import { entityApi, shotApi } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import type { RunStep, ShotBoardShot, ShotOp } from '../lib/types'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const props = defineProps<{
  runId: number
  step: RunStep
  /** 打开时的工作台快照（board.shots；含 raw 全量字段） */
  shots: ShotBoardShot[]
  /** 只读守卫（false 时全部控件禁用） */
  canOperate: boolean
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

// ---------- 草稿模型 ----------

interface DraftShot {
  uid: number
  id: string
  isNew: boolean
  deleted: boolean
  /** 字段全量（不含 id；保留 duration/duration_sec 双口径原始键） */
  fields: Record<string, unknown>
  /** array/object 值的 JSON 文本缓冲（键 → 文本） */
  jsonText: Record<string, string>
}

/** 专用控件字段（不进入动态键值行） */
const RESERVED = new Set(['id', 'image_prompt', 'motion_prompt', 'duration', 'duration_sec', 'characters'])

let uidSeq = 1
const drafts = ref<DraftShot[]>([])
const originalIds = ref<string[]>([])
const activeUid = ref<number | null>(null)
const busy = ref(false)
const err = ref('')
const charNames = ref<string[]>([])

function cloneDraft(shot: ShotBoardShot): DraftShot {
  const fields = JSON.parse(JSON.stringify(shot.raw ?? {})) as Record<string, unknown>
  delete fields.id
  const jsonText: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    // RESERVED 键（如 characters）由专用控件管理，不建 json 快照
    if (v !== null && typeof v === 'object' && !RESERVED.has(k)) jsonText[k] = JSON.stringify(v)
  }
  return { uid: uidSeq++, id: shot.shotId, isNew: false, deleted: false, fields, jsonText }
}

onMounted(() => {
  drafts.value = props.shots.map(cloneDraft)
  originalIds.value = props.shots.map((s) => s.shotId)
  activeUid.value = drafts.value.length ? drafts.value[0]!.uid : null
  void loadCharNames()
})

/** 角色名建议（entityApi；失败静默降级为无建议） */
async function loadCharNames() {
  try {
    const r = await entityApi.list('character')
    charNames.value = r.items.map((e) => e.name).filter((n) => n)
  } catch {
    // 建议降级：静默
  }
}

// ---------- 选中 ----------

const active = computed(() => drafts.value.find((d) => d.uid === activeUid.value) ?? null)
const aliveCount = computed(() => drafts.value.filter((d) => !d.deleted).length)

function selectDraft(d: DraftShot) {
  activeUid.value = d.uid
}

function promptPreview(d: DraftShot): string {
  const v = d.fields.image_prompt
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return '（未填写出图提示词）'
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

// ---------- 左栏拖拽（原生 HTML5 DnD；before/after 插入） ----------

const dragUid = ref<number | null>(null)
const dropUid = ref<{ uid: number; side: 'before' | 'after' } | null>(null)

function onDragStart(d: DraftShot, e: DragEvent) {
  if (!props.canOperate) return
  dragUid.value = d.uid
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(d.uid))
  }
}

function onItemDragOver(d: DraftShot, e: DragEvent) {
  if (!dragUid.value || dragUid.value === d.uid) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const side = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
  dropUid.value = { uid: d.uid, side }
}

function onItemDragLeave(d: DraftShot, e: DragEvent) {
  const el = e.currentTarget as HTMLElement
  if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
  if (dropUid.value?.uid === d.uid) dropUid.value = null
}

function clearDrag() {
  dragUid.value = null
  dropUid.value = null
}

function onDrop(d: DraftShot, e: DragEvent) {
  const src = dragUid.value
  let side: 'before' | 'after' = 'before'
  if (dropUid.value?.uid === d.uid) {
    side = dropUid.value.side
  } else {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    side = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
  }
  clearDrag()
  if (!src || src === d.uid) return
  const list = [...drafts.value]
  const from = list.findIndex((x) => x.uid === src)
  if (from < 0) return
  const [item] = list.splice(from, 1)
  const to = list.findIndex((x) => x.uid === d.uid)
  if (to < 0 || !item) return
  list.splice(side === 'before' ? to : to + 1, 0, item)
  drafts.value = list
}

// ---------- 增删 ----------

function suggestId(): string {
  let max = 0
  for (const d of drafts.value) {
    const m = /^s(\d+)$/i.exec(d.id.trim())
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `s${max + 1}`
}

function addShot() {
  if (!props.canOperate) return
  const d: DraftShot = { uid: uidSeq++, id: suggestId(), isNew: true, deleted: false, fields: { image_prompt: '' }, jsonText: {} }
  drafts.value = [...drafts.value, d]
  activeUid.value = d.uid
}

function toggleDeleted(d: DraftShot) {
  if (!props.canOperate) return
  d.deleted = !d.deleted
}

// ---------- 字段控件 ----------

function textField(d: DraftShot, k: string): string {
  const v = d.fields[k]
  if (typeof v === 'string') return v
  return v === undefined || v === null ? '' : String(v)
}

function setTextField(d: DraftShot, k: string, e: Event) {
  d.fields[k] = (e.target as HTMLInputElement | HTMLTextAreaElement).value
}

function numFieldText(v: unknown): string | number {
  return typeof v === 'number' ? v : String(v ?? '')
}

function setNumField(d: DraftShot, k: string, e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const n = Number(raw)
  // 输入中间态（空 / NaN）暂存字符串，保存时统一校验转数字
  d.fields[k] = raw.trim() === '' || Number.isNaN(n) ? raw : n
}

function setBoolField(d: DraftShot, k: string, e: Event) {
  d.fields[k] = (e.target as HTMLInputElement).checked
}

function setJsonField(d: DraftShot, k: string, e: Event) {
  d.jsonText[k] = (e.target as HTMLTextAreaElement).value
}

/** duration 双口径回显（duration 优先，退化 duration_sec） */
function durText(d: DraftShot): string {
  const v = d.fields.duration !== undefined ? d.fields.duration : d.fields.duration_sec
  return v === undefined || v === null ? '' : String(v)
}

function setDur(d: DraftShot, e: Event) {
  const raw = (e.target as HTMLInputElement).value
  if (raw.trim() === '') {
    // 清空 = 维持原值（对齐 M7 时长编辑惯例）
    delete d.fields.duration
    return
  }
  d.fields.duration = raw
}

function charList(d: DraftShot): string[] {
  const c = d.fields.characters
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : []
}

function addChar(d: DraftShot, e: Event) {
  const input = e.target as HTMLInputElement
  const name = input.value.trim()
  input.value = ''
  if (!name || !props.canOperate) return
  const list = charList(d)
  if (list.includes(name)) return
  d.fields.characters = [...list, name]
}

function removeChar(d: DraftShot, name: string) {
  d.fields.characters = charList(d).filter((x) => x !== name)
}

// ---------- 动态键值行 ----------

function extraKeys(d: DraftShot): string[] {
  return Object.keys(d.fields).filter((k) => !RESERVED.has(k))
}

function fieldKind(v: unknown): 'boolean' | 'number' | 'json' | 'text' {
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return 'number'
  if (v !== null && typeof v === 'object') return 'json'
  return 'text'
}

const addingKey = ref(false)
const newKey = ref('')

function startAddKey() {
  if (!props.canOperate) return
  addingKey.value = true
  newKey.value = ''
}

function commitAddKey(d: DraftShot) {
  const k = newKey.value.trim()
  addingKey.value = false
  newKey.value = ''
  if (!k) return
  if (RESERVED.has(k)) {
    err.value = `「${k}」由专用控件管理，不支持动态添加`
    return
  }
  if (k in d.fields) {
    err.value = `字段「${k}」已存在`
    return
  }
  d.fields[k] = ''
}

function removeKey(d: DraftShot, k: string) {
  if (!props.canOperate) return
  delete d.fields[k]
  delete d.jsonText[k]
}

// ---------- 规范化 / diff / ops ----------

/** 草稿字段规范化（parse JSON / duration 校验 / characters 归一 / image_prompt 必填） */
function normalizeDraft(d: DraftShot, raw: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d.fields)) {
    if (v === undefined) continue
    if (v !== null && typeof v === 'object') {
      // characters 由专用控件管理：直取实时值（jsonText 仅为动态 JSON 行的编辑缓冲）
      if (k === 'characters') {
        out[k] = v
        continue
      }
      const text = d.jsonText[k] ?? JSON.stringify(v)
      try {
        out[k] = JSON.parse(text)
      } catch {
        throw new Error(`镜头 ${d.id}：字段「${k}」的 JSON 无法解析`)
      }
      continue
    }
    // 数字字段的字符串缓冲 → 数字（原始类型为 number 的键）
    if (raw && typeof raw[k] === 'number' && typeof v === 'string') {
      const n = Number(v)
      if (v.trim() === '' || !Number.isFinite(n)) throw new Error(`镜头 ${d.id}：字段「${k}」需为数字`)
      out[k] = n
      continue
    }
    out[k] = v
  }
  const ip = out.image_prompt
  if (typeof ip !== 'string' || !ip.trim()) throw new Error(`镜头 ${d.id}：出图提示词不能为空`)
  out.image_prompt = ip.trim()
  if (typeof out.motion_prompt === 'string') out.motion_prompt = out.motion_prompt.trim()
  if (out.duration !== undefined) {
    const n = typeof out.duration === 'number' ? out.duration : Number(out.duration)
    if (!Number.isFinite(n) || n <= 0 || n > 60) throw new Error(`镜头 ${d.id}：时长需在 (0, 60] 秒内`)
    out.duration = Math.round(n * 10) / 10
  }
  if (out.characters !== undefined) {
    const arr = out.characters
    if (!Array.isArray(arr) || arr.some((c) => typeof c !== 'string' || !c.trim())) {
      throw new Error(`镜头 ${d.id}：角色列表需为非空字符串数组`)
    }
    const list = arr.map((c) => c.trim())
    if (!list.length) {
      if (raw && raw.characters !== undefined) throw new Error(`镜头 ${d.id}：角色列表不能清空（至少保留 1 个）`)
      delete out.characters
    } else {
      out.characters = list
    }
  }
  return out
}

/** 草稿 diff → ops（add* → patch* → remove* → reorder；校验失败抛错） */
function buildOps(): ShotOp[] {
  const alive = drafts.value.filter((d) => !d.deleted)
  if (!alive.length) throw new Error('至少保留 1 个镜头')
  const seen = new Set<string>()
  for (const d of alive) {
    const id = d.id.trim()
    if (!id) throw new Error('镜头 id 不能为空')
    if (seen.has(id)) throw new Error(`镜头 id 重复：${id}`)
    seen.add(id)
  }
  const rawById = new Map(props.shots.map((s) => [s.shotId, s.raw]))
  const ops: ShotOp[] = []
  const newIds: string[] = []

  // add*（新镜追加；按草稿中新增项的相对顺序）
  for (const d of drafts.value) {
    if (d.deleted || !d.isNew) continue
    const shot = normalizeDraft(d, null)
    const id = d.id.trim()
    shot.id = id
    ops.push({ op: 'add', shot })
    newIds.push(id)
  }

  // patch*（既有镜头字段变化；duration 双口径归一，其余浅对比）
  for (const d of drafts.value) {
    if (d.deleted || d.isNew) continue
    const raw = rawById.get(d.id)
    if (!raw) throw new Error(`镜头 ${d.id} 不在当前分镜中`)
    const fields = normalizeDraft(d, raw)
    delete fields.id
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'duration' || k === 'duration_sec') continue
      if (JSON.stringify(v) !== JSON.stringify(raw[k])) patch[k] = v
    }
    // 草稿移除的键：原分镜存在 → null 置空（服务端浅合并无法真删键）
    for (const k of Object.keys(raw)) {
      if (k === 'id' || k === 'duration' || k === 'duration_sec' || k === 'characters') continue
      if (!(k in fields)) patch[k] = null
    }
    // duration 仅在有效值出现时 patch（清空 = 维持原值）
    if (fields.duration !== undefined) {
      const before = raw.duration ?? raw.duration_sec
      if (before !== fields.duration) patch.duration = fields.duration
    }
    if (Object.keys(patch).length) ops.push({ op: 'patch', shot_id: d.id, fields: patch })
  }

  // remove*（删除标记；新镜删除仅本地丢弃）
  for (const d of drafts.value) {
    if (d.deleted && !d.isNew) ops.push({ op: 'remove', shot_id: d.id })
  }

  // reorder（与「原始 - 删除 + 新增追加尾」的自然顺序不同才发）
  const removed = new Set(drafts.value.filter((d) => d.deleted && !d.isNew).map((d) => d.id))
  const natural = [...originalIds.value.filter((id) => !removed.has(id)), ...newIds]
  const order = alive.map((d) => d.id.trim())
  if (JSON.stringify(order) !== JSON.stringify(natural)) ops.push({ op: 'reorder', order })
  return ops
}

/** 改动计数（= ops 条数；校验未过 -1 亦视为 dirty） */
const changeCount = computed(() => {
  try {
    return buildOps().length
  } catch {
    return -1
  }
})
const dirty = computed(() => changeCount.value !== 0)

// ---------- 保存 / 关闭 ----------

async function save() {
  if (!props.canOperate || busy.value) return
  err.value = ''
  let ops: ShotOp[]
  try {
    ops = buildOps()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    return
  }
  if (!ops.length) return
  busy.value = true
  try {
    await shotApi.mutate(props.runId, props.step.stepKey, ops)
    emit('saved')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function requestClose() {
  if (busy.value) return
  if (dirty.value) {
    const ok = await confirmDialog({
      title: '放弃未保存的修改',
      message: '分镜编辑器中还有未保存的修改，关闭后将丢弃。',
      confirmText: '放弃修改',
    })
    if (!ok) return
  }
  emit('close')
}
</script>

<template>
  <Modal :title="`分镜编辑器 · ${step.title || step.stepKey}`" :width="1000" @close="requestClose">
    <div class="se">
      <div class="se-hint">
        <Icon name="sliders" :size="12" />
        <span>增删 / 改字段 / 拖拽重排镜头：保存后仅改写分镜与镜头顺序，<b>不触发生成</b>，重新合成后生效。</span>
      </div>
      <div v-if="!canOperate" class="se-lock">
        <Icon name="alert" :size="12" /> 当前状态只读（run 执行中或不可返修）
      </div>
      <div v-if="err" class="err-text">{{ err }}</div>

      <div class="se-body">
        <!-- 左栏：镜头列表 -->
        <div class="se-list">
          <div
            v-for="(d, i) in drafts"
            :key="d.uid"
            class="se-item"
            :class="{
              active: d.uid === activeUid,
              dead: d.deleted,
              dragging: dragUid === d.uid,
              'drop-before': dropUid?.uid === d.uid && dropUid.side === 'before',
              'drop-after': dropUid?.uid === d.uid && dropUid.side === 'after',
            }"
            @click="selectDraft(d)"
            @dragover="onItemDragOver(d, $event)"
            @dragleave="onItemDragLeave(d, $event)"
            @drop.prevent="onDrop(d, $event)"
          >
            <span
              class="se-grip"
              :class="{ disabled: !canOperate }"
              :draggable="canOperate"
              title="拖拽调整顺序"
              @dragstart="onDragStart(d, $event)"
              @dragend="clearDrag"
            />
            <span class="se-seq mono">{{ i + 1 }}</span>
            <div class="se-item-main">
              <div class="se-item-top">
                <span class="se-item-id mono">{{ d.id || '（未命名）' }}</span>
                <span v-if="d.isNew" class="se-badge new">新增</span>
                <span v-if="d.deleted" class="se-badge dead">待删除</span>
              </div>
              <div class="se-item-sub">{{ promptPreview(d) }}</div>
            </div>
            <button
              class="se-item-del"
              :class="{ undo: d.deleted }"
              :disabled="!canOperate"
              :title="d.deleted ? '撤销删除' : '标记删除（保存后移除）'"
              @click.stop="toggleDeleted(d)"
            >
              <Icon :name="d.deleted ? 'arrow-path' : 'trash'" :size="12" />
            </button>
          </div>
          <div v-if="!drafts.length" class="muted se-empty">无镜头</div>
          <button class="btn sm se-add" :disabled="!canOperate" @click="addShot">
            <Icon name="plus" :size="12" /> 新增镜头
          </button>
        </div>

        <!-- 右栏：字段表单 -->
        <div class="se-form">
          <template v-if="active">
            <div v-if="active.deleted" class="se-dead-tip">
              <Icon name="alert" :size="12" />
              <span>该镜头已标记删除（保存后从分镜移除；任务 / 产物保留为历史）</span>
              <button class="btn sm" @click="toggleDeleted(active)">撤销删除</button>
            </div>

            <template v-else>
              <div class="se-field">
                <label>镜头 ID</label>
                <input
                  v-if="active.isNew"
                  v-model="active.id"
                  type="text"
                  class="mono"
                  spellcheck="false"
                  placeholder="如 s5（唯一）"
                  :disabled="!canOperate"
                />
                <div v-else class="se-ro mono">
                  {{ active.id }}<span class="muted">（不可修改）</span>
                </div>
              </div>

              <div class="se-field">
                <label>出图提示词 image_prompt（必填）</label>
                <textarea
                  rows="4"
                  spellcheck="false"
                  :value="textField(active, 'image_prompt')"
                  :disabled="!canOperate"
                  @input="setTextField(active, 'image_prompt', $event)"
                />
              </div>

              <div class="se-field">
                <label>动效提示词 motion_prompt</label>
                <textarea
                  rows="3"
                  spellcheck="false"
                  :value="textField(active, 'motion_prompt')"
                  :disabled="!canOperate"
                  @input="setTextField(active, 'motion_prompt', $event)"
                />
              </div>

              <div class="se-field se-inline">
                <label>时长（秒；空 = 用全局默认）</label>
                <input
                  type="number"
                  min="0.5"
                  max="60"
                  step="0.5"
                  class="se-num"
                  :value="durText(active)"
                  :disabled="!canOperate"
                  @input="setDur(active, $event)"
                />
              </div>

              <div class="se-field">
                <label>角色 characters（回车添加；建议来自实体库）</label>
                <div class="se-tags">
                  <span v-for="c in charList(active)" :key="c" class="se-tag">
                    {{ c }}
                    <button type="button" aria-label="移除角色" :disabled="!canOperate" @click="removeChar(active, c)">
                      <Icon name="x" :size="10" />
                    </button>
                  </span>
                  <input
                    type="text"
                    class="se-tag-input"
                    list="se-char-names"
                    placeholder="输入角色名回车"
                    :disabled="!canOperate"
                    @keydown.enter.prevent="addChar(active, $event)"
                  />
                  <datalist id="se-char-names">
                    <option v-for="n in charNames" :key="n" :value="n" />
                  </datalist>
                </div>
              </div>

              <div class="se-field">
                <label>其他字段（array/object 为 JSON 文本，保存时校验）</label>
                <div v-for="k in extraKeys(active)" :key="k" class="se-kv">
                  <span class="se-kv-key mono" :title="k">{{ k }}</span>
                  <template v-if="fieldKind(active.fields[k]) === 'boolean'">
                    <input
                      type="checkbox"
                      :checked="active.fields[k] === true"
                      :disabled="!canOperate"
                      @change="setBoolField(active, k, $event)"
                    />
                    <span class="muted se-kv-hint">{{ active.fields[k] === true ? 'true' : 'false' }}</span>
                  </template>
                  <input
                    v-else-if="fieldKind(active.fields[k]) === 'number'"
                    type="number"
                    class="se-num"
                    :value="numFieldText(active.fields[k])"
                    :disabled="!canOperate"
                    @input="setNumField(active, k, $event)"
                  />
                  <textarea
                    v-else-if="fieldKind(active.fields[k]) === 'json'"
                    class="se-json mono"
                    rows="2"
                    spellcheck="false"
                    :value="active.jsonText[k] ?? JSON.stringify(active.fields[k])"
                    :disabled="!canOperate"
                    @input="setJsonField(active, k, $event)"
                  />
                  <input
                    v-else
                    type="text"
                    :value="textField(active, k)"
                    :disabled="!canOperate"
                    @input="setTextField(active, k, $event)"
                  />
                  <button
                    class="se-item-del"
                    title="移除字段（原分镜存在该键时保存为 null 置空）"
                    :disabled="!canOperate"
                    @click="removeKey(active, k)"
                  >
                    <Icon name="trash" :size="12" />
                  </button>
                </div>
                <div v-if="addingKey" class="se-kv se-kv-add">
                  <input
                    v-model="newKey"
                    type="text"
                    class="mono"
                    placeholder="字段名（如 scene / lighting）"
                    spellcheck="false"
                    @keydown.enter.prevent="commitAddKey(active)"
                  />
                  <button class="btn sm" @click="commitAddKey(active)">添加</button>
                  <button class="btn sm" @click="addingKey = false">取消</button>
                </div>
                <button v-else class="btn sm se-add" :disabled="!canOperate" @click="startAddKey">
                  <Icon name="plus" :size="12" /> 添加字段
                </button>
              </div>
            </template>
          </template>
          <div v-else class="muted se-empty">选择左侧镜头以编辑字段</div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="se-foot">
        <span class="muted se-count">
          {{ aliveCount }} 镜{{ changeCount > 0 ? ` · ${changeCount} 项改动` : '' }}
        </span>
        <span class="grow" />
        <button class="btn" :disabled="busy" @click="requestClose">取消</button>
        <button class="btn primary" :disabled="!canOperate || busy || !dirty" @click="save">
          <Icon name="check" :size="12" /> {{ busy ? '保存中…' : '保存' }}
        </button>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.se-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  margin-bottom: 8px;
}

.se-hint b {
  color: var(--text);
}

.se-lock {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-weak);
  border: 1px solid rgb(245 158 11 / 20%);
  border-radius: 8px;
  padding: 5px 10px;
  margin-bottom: 8px;
}

.se-body {
  display: grid;
  grid-template-columns: 290px 1fr;
  gap: 12px;
  height: min(62vh, 600px);
  min-height: 360px;
}

/* ---------- 左栏 ---------- */

.se-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
}

.se-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 7px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  cursor: pointer;
  transition: border-color 0.15s, opacity 0.2s;
}

.se-item:hover {
  border-color: var(--border-strong);
}

.se-item.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgb(99 102 241 / 18%);
}

.se-item.dead {
  opacity: 0.55;
  border-style: dashed;
}

.se-item.dead .se-item-id {
  text-decoration: line-through;
}

.se-item.dragging {
  opacity: 0.4;
}

.se-item.drop-before {
  box-shadow: 0 -3px 0 var(--accent);
}

.se-item.drop-after {
  box-shadow: 0 3px 0 var(--accent);
}

.se-grip {
  flex: none;
  width: 13px;
  height: 18px;
  cursor: grab;
  background-image: radial-gradient(circle, var(--text-3) 1px, transparent 1.1px);
  background-size: 5px 5px;
  background-position: 1px 1px;
  opacity: 0.75;
}

.se-grip:hover {
  opacity: 1;
}

.se-grip:active {
  cursor: grabbing;
}

.se-grip.disabled {
  cursor: not-allowed;
  opacity: 0.3;
}

.se-seq {
  flex: none;
  font-size: 10.5px;
  color: var(--text-3);
  min-width: 14px;
  text-align: right;
}

.se-item-main {
  flex: 1;
  min-width: 0;
}

.se-item-top {
  display: flex;
  align-items: center;
  gap: 5px;
}

.se-item-id {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.se-badge {
  flex: none;
  font-size: 10px;
  line-height: 15px;
  border-radius: 999px;
  padding: 0 6px;
}

.se-badge.new {
  color: var(--ok);
  background: var(--ok-weak);
}

.se-badge.dead {
  color: var(--bad);
  background: var(--bad-weak);
}

.se-item-sub {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.se-item-del {
  flex: none;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  border-radius: 6px;
}

.se-item-del:hover:not(:disabled) {
  color: var(--bad);
}

.se-item-del.undo {
  color: var(--accent-h);
}

.se-item-del:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.se-empty {
  font-size: 12px;
  padding: 10px 4px;
  text-align: center;
}

.se-add {
  align-self: flex-start;
}

/* ---------- 右栏 ---------- */

.se-form {
  overflow-y: auto;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.se-dead-tip {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-weak);
  border: 1px solid rgb(245 158 11 / 20%);
  border-radius: 8px;
  padding: 8px 10px;
}

.se-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.se-field > label {
  font-size: 11.5px;
  color: var(--text-2);
}

.se-field input[type='text'],
.se-field textarea,
.se-kv input[type='text'],
.se-kv textarea {
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  resize: vertical;
  width: 100%;
}

.se-field input:disabled,
.se-field textarea:disabled,
.se-kv input:disabled,
.se-kv textarea:disabled {
  opacity: 0.5;
}

.se-inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.se-num {
  width: 88px;
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 12px;
  font-family: inherit;
}

.se-ro {
  font-size: 12px;
  color: var(--text);
  padding: 3px 0;
}

.se-ro .muted {
  font-size: 11px;
  margin-left: 6px;
}

/* 角色标签 */

.se-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  border: 1px solid var(--border-strong);
  background: var(--code-bg);
  border-radius: 8px;
  padding: 5px 8px;
  min-height: 34px;
}

.se-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text);
  background: rgb(99 102 241 / 16%);
  border: 1px solid rgb(99 102 241 / 28%);
  border-radius: 999px;
  padding: 1px 8px;
}

.se-tag button {
  border: none;
  background: none;
  color: var(--text-2);
  cursor: pointer;
  padding: 0;
  display: inline-flex;
}

.se-tag button:hover:not(:disabled) {
  color: var(--bad);
}

.se-tag-input {
  flex: 1;
  min-width: 120px;
  background: none !important;
  border: none !important;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  padding: 2px 0 !important;
}

/* 动态键值行 */

.se-kv {
  display: grid;
  grid-template-columns: 120px 1fr 26px;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
}

.se-kv-key {
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.se-kv-hint {
  font-size: 11px;
}

.se-json {
  font-size: 11.5px;
}

.se-kv-add {
  grid-template-columns: 1fr auto auto;
}

.se-kv input[type='checkbox'] {
  accent-color: var(--accent);
  justify-self: start;
  cursor: pointer;
}

/* ---------- 底栏 ---------- */

.se-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.se-count {
  font-size: 12px;
}

@media (max-width: 860px) {
  .se-body {
    grid-template-columns: 1fr;
    height: auto;
  }

  .se-list {
    max-height: 200px;
  }
}
</style>
