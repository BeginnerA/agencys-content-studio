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
import { assetApi, entityApi, runApi, shotApi } from '../../../lib/api'
import { confirmDialog } from '../../../lib/confirm'
import type { RunStep, ShotBoardShot, ShotOp } from '../../../lib/types'

// ---------- 草稿模型 ----------

export interface DraftShot {
  uid: number
  id: string
  isNew: boolean
  deleted: boolean
  /** 字段全量（不含 id；保留 duration/duration_sec 双口径原始键） */
  fields: Record<string, unknown>
  /** array/object 值的 JSON 文本缓冲（键 → 文本） */
  jsonText: Record<string, string>
}

export function useStoryboardEditor(deps: {
  props: { runId: number; step: RunStep; shots: ShotBoardShot[]; canOperate: boolean }
  emit: { (e: 'saved'): void; (e: 'close'): void }
}) {
  const { props, emit } = deps


  /** 专用控件字段（不进入动态键值行） */
  const RESERVED = new Set(['id', 'image_prompt', 'motion_prompt', 'duration', 'duration_sec', 'characters', 'lines'])

  let uidSeq = 1
  const drafts = ref<DraftShot[]>([])
  const originalIds = ref<string[]>([])
  const activeUid = ref<number | null>(null)
  const busy = ref(false)
  const err = ref('')
  const charNames = ref<string[]>([])
  /** [M11] 台词 id 建议（本 run cast_lines 产物解析；失败降级为空 = 纯标签输入） */
  const lineSuggest = ref<Array<{ id: string; label: string }>>([])

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
    void loadLineSuggest()
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

  /** [M11] 台词 id 建议：run 内 cast_lines 产物 JSON（{ lines: [{id, speaker, text}] }）；失败静默降级 */
  async function loadLineSuggest() {
    try {
      const detail = await runApi.detail(props.runId)
      const step = detail.steps.find((s) => s.stepKey === 'cast_lines')
      const assetId = (step?.output?.['asset_ids'] as number[] | undefined)?.[0]
      if (!assetId) return
      const { asset } = await assetApi.detail(assetId)
      const res = await fetch(asset.urls.file)
      if (!res.ok) return
      const doc = (await res.json()) as { lines?: Array<Record<string, unknown>> }
      const rows = Array.isArray(doc.lines) ? doc.lines : []
      lineSuggest.value = rows
        .map((r) => {
          const id = typeof r.id === 'string' ? r.id : typeof r.id === 'number' ? String(r.id) : ''
          const speaker = typeof r.speaker === 'string' ? r.speaker : ''
          const text = typeof r.text === 'string' ? r.text : ''
          const label = [speaker, text.length > 16 ? text.slice(0, 16) + '…' : text].filter(Boolean).join('：')
          return { id, label }
        })
        .filter((x) => x.id)
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

  // ---------- [M11] 台词标签控件（lines；空数组 = 无台词镜） ----------

  function lineList(d: DraftShot): string[] {
    const l = d.fields.lines
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string') : []
  }

  function addLine(d: DraftShot, e: Event) {
    const input = e.target as HTMLInputElement
    const id = input.value.trim()
    input.value = ''
    if (!id || !props.canOperate) return
    const list = lineList(d)
    if (list.includes(id)) return
    d.fields.lines = [...list, id]
  }

  function removeLine(d: DraftShot, id: string) {
    d.fields.lines = lineList(d).filter((x) => x !== id)
  }

  /** 标签 title：台词摘要（建议表命中时） */
  function lineLabelOf(id: string): string {
    const s = lineSuggest.value.find((x) => x.id === id)
    return s ? s.label : ''
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
        // characters / lines 由专用控件管理：直取实时值（jsonText 仅为动态 JSON 行的编辑缓冲）
        if (k === 'characters' || k === 'lines') {
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
    // [M11] lines 归一（字符串数组；空数组合法 = 无台词镜）
    if (out.lines !== undefined) {
      const arr = out.lines
      if (!Array.isArray(arr) || arr.some((c) => typeof c !== 'string' || !c.trim())) {
        throw new Error(`镜头 ${d.id}：台词列表需为字符串数组`)
      }
      out.lines = arr.map((c) => c.trim())
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
        if (k === 'id' || k === 'duration' || k === 'duration_sec' || k === 'characters' || k === 'lines') continue
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

  return {
    RESERVED,
    drafts,
    originalIds,
    activeUid,
    busy,
    err,
    charNames,
    lineSuggest,
    cloneDraft,
    loadCharNames,
    loadLineSuggest,
    active,
    aliveCount,
    selectDraft,
    promptPreview,
    dragUid,
    dropUid,
    onDragStart,
    onItemDragOver,
    onItemDragLeave,
    clearDrag,
    onDrop,
    suggestId,
    addShot,
    toggleDeleted,
    textField,
    setTextField,
    numFieldText,
    setNumField,
    setBoolField,
    setJsonField,
    durText,
    setDur,
    charList,
    addChar,
    removeChar,
    lineList,
    addLine,
    removeLine,
    lineLabelOf,
    extraKeys,
    fieldKind,
    addingKey,
    newKey,
    startAddKey,
    commitAddKey,
    removeKey,
    normalizeDraft,
    buildOps,
    changeCount,
    dirty,
    save,
    requestClose,
  }
}

export type EditorApi = ReturnType<typeof useStoryboardEditor>
