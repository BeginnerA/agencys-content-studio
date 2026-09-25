// 字幕精确返修状态组合函数：加载读模型 → 行编辑 → diff 生成 changes →
// 结构化预览（幂等 ticket）→ 原子确认。费用/影响/过期判断全部以后端返回为准，
// 前端不重新实现（规格 §9）。msToClock/parseClock 为纯函数：字段整数毫秒，
// 显示 HH:MM:SS.mmm，不经过浮点字符串反复舍入（规格 §3.1）。
import { computed, ref, type Ref } from 'vue'
import { subtitleReworkApi, ReworkApiError } from '../../../lib/api/rework'
import { newRequestKey } from '../../../lib/api/creation-chat'
import { confirmDialog } from '../../../lib/confirm'
import type {
  ReworkErrorView,
  SubtitleChangeView,
  SubtitleCueView,
  SubtitlePreviewView,
  SubtitleReadModelView,
} from '../../../lib/types/rework'

/** 整数毫秒 → HH:MM:SS.mmm（负值截断为 0） */
export function msToClock(ms: number): string {
  const v = Math.max(0, Math.round(ms))
  const h = Math.floor(v / 3600000)
  const m = Math.floor((v % 3600000) / 60000)
  const s = Math.floor((v % 60000) / 1000)
  const milli = v % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(milli, 3)}`
}

/**
 * 时钟输入 → 整数毫秒。接受 `HH:MM:SS.mmm` / `MM:SS` / 纯秒数；
 * 非法返回 null（UI 就近提示，不擅自取整）。
 */
export function parseClock(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000)
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?$/.exec(t)
  if (!m) return null
  const [, a, b, c, frac] = m
  const hours = c === undefined ? 0 : Number(a)
  const minutes = c === undefined ? Number(a) : Number(b)
  const seconds = c === undefined ? Number(b) : Number(c)
  if (Number(minutes) > 59 || Number(seconds) > 59) return null
  const ms = ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number((frac ?? '0').padEnd(3, '0'))
  return Math.round(ms)
}

/** UI 可编辑行：以当前生效基线 cue 为原文，编辑态存整数毫秒 */
export interface SubtitleRow {
  cueId: string
  originalText: string
  text: string
  originalStartMs: number
  originalEndMs: number
  startMs: number
  endMs: number
}

/** 行编辑态 → 结构化变更（与 baseline 逐字段 diff；空文本不生成变更交由服务端裁决） */
export function buildSubtitleChanges(rows: SubtitleRow[], baseline: SubtitleCueView[]): SubtitleChangeView[] {
  const changes: SubtitleChangeView[] = []
  const baseById = new Map(baseline.map((c) => [c.id, c]))
  for (const row of rows) {
    const base = baseById.get(row.cueId)
    if (!base) continue
    if (row.text !== base.text) changes.push({ kind: 'subtitle-text', cueId: row.cueId, text: row.text })
    if (row.startMs !== base.startMs || row.endMs !== base.endMs) {
      changes.push({ kind: 'subtitle-time', cueId: row.cueId, startMs: row.startMs, endMs: row.endMs })
    }
  }
  return changes
}

/** 变更签名（幂等 ticket 判据：签名一致复用同 requestKey 连点不重复建请求） */
export function changesSignature(changes: SubtitleChangeView[]): string {
  return JSON.stringify(changes)
}

export interface SubtitleReworkHooks {
  /** 确认成功后（父级可刷新外部状态） */
  onApplied?: (requestId: string) => void
}

export function useSubtitleRework(runId: Ref<number>, stepKey: Ref<string | undefined>, hooks: SubtitleReworkHooks = {}) {
  const model = ref<SubtitleReadModelView | null>(null)
  const loading = ref(false)
  const submitting = ref(false)
  const applying = ref(false)
  const loadError = ref('')
  const previewError = ref('')
  const rowErrors = ref<Map<string, ReworkErrorView[]>>(new Map())
  const rows = ref<SubtitleRow[]>([])
  const selected = ref<Set<string>>(new Set())
  const preview = ref<SubtitlePreviewView | null>(null)
  const requestId = ref('')
  /** 幂等 ticket：{签名, requestKey}，签名变化即失效 */
  const ticket = ref<{ signature: string; key: string } | null>(null)
  /** 已展示预览对应的变更签名（行编辑中签名未变则保留预览） */
  const previewSignature = ref('')
  /** epoch：晚到响应保护（重新加载/编辑后旧预览响应一律丢弃） */
  let epoch = 0

  const baselineCues = computed<SubtitleCueView[]>(() => model.value?.baseline?.cues ?? [])
  const capability = computed(() => model.value?.capability ?? null)
  const supported = computed(() => capability.value?.supported === true)
  const changes = computed(() => buildSubtitleChanges(rows.value, baselineCues.value))
  const dirty = computed(() => changes.value.length > 0)
  const changeCount = computed(() => changes.value.length)

  async function load(): Promise<void> {
    if (!runId.value) return
    const token = ++epoch
    loading.value = true
    loadError.value = ''
    try {
      const res = await subtitleReworkApi.subtitles(runId.value, stepKey.value ?? 'compose')
      if (token !== epoch) return
      model.value = res
      rows.value = (res.baseline?.cues ?? []).map((c) => ({
        cueId: c.id,
        originalText: c.text,
        text: c.text,
        originalStartMs: c.startMs,
        originalEndMs: c.endMs,
        startMs: c.startMs,
        endMs: c.endMs,
      }))
      selected.value = new Set()
      resetPreview()
    } catch (err) {
      if (token !== epoch) return
      loadError.value = err instanceof Error ? err.message : '加载字幕返修状态失败'
      model.value = null
      rows.value = []
    } finally {
      if (token === epoch) loading.value = false
    }
  }

  function resetPreview(): void {
    preview.value = null
    previewError.value = ''
    rowErrors.value = new Map()
    requestId.value = ''
    ticket.value = null
    previewSignature.value = ''
  }

  /** 行编辑后签名变化即作废预览（同签名连续输入不回退已展示的预览） */
  function onRowEdited(): void {
    if (!preview.value && !previewError.value) return
    if (previewSignature.value && previewSignature.value === changesSignature(changes.value)) return
    resetPreview()
  }

  /** 批量平移选中行：逐行改数值（时间输入框同一通路），不直接下发 shift 契约 */
  function shiftSelected(deltaMs: number): void {
    const delta = Math.round(deltaMs)
    if (!Number.isFinite(delta) || delta === 0) return
    for (const row of rows.value) {
      if (!selected.value.has(row.cueId)) continue
      row.startMs = Math.max(0, row.startMs + delta)
      row.endMs = Math.max(0, row.endMs + delta)
    }
    onRowEdited()
  }

  function toggleSelect(cueId: string): void {
    const next = new Set(selected.value)
    if (next.has(cueId)) next.delete(cueId)
    else next.add(cueId)
    selected.value = next
  }

  function allSelected(): boolean {
    return rows.value.length > 0 && rows.value.every((r) => selected.value.has(r.cueId))
  }

  function toggleSelectAll(): void {
    selected.value = allSelected() ? new Set() : new Set(rows.value.map((r) => r.cueId))
  }

  /** 请求预览：同签名复用 ticket；blocked 时按 errors[].cueId 定位行 */
  async function requestPreview(): Promise<void> {
    if (!supported.value || submitting.value) return
    const list = changes.value
    if (list.length === 0) {
      previewError.value = '没有待确认的修改'
      return
    }
    const signature = changesSignature(list)
    if (!ticket.value || ticket.value.signature !== signature) {
      ticket.value = { signature, key: newRequestKey('subrw') }
    }
    const token = epoch
    const key = ticket.value.key
    submitting.value = true
    previewError.value = ''
    rowErrors.value = new Map()
    try {
      const res = await subtitleReworkApi.preview(runId.value, key, list, stepKey.value)
      if (token !== epoch) return
      requestId.value = res.request_id
      preview.value = res.preview
      previewSignature.value = signature
    } catch (err) {
      if (token !== epoch) return
      if (err instanceof ReworkApiError) {
        previewError.value = `${err.message}${err.requestId ? `（请求 ${err.requestId}）` : ''}`
        const map = new Map<string, ReworkErrorView[]>()
        for (const e of err.errors) {
          if (!e.cueId) continue
          const arr = map.get(e.cueId) ?? []
          arr.push(e)
          map.set(e.cueId, arr)
        }
        rowErrors.value = map
        // 基准漂移类错误：预览不再可信，清空并提示重载
        if (err.code === 'idempotency_conflict' || err.code === 'stale_preview' || err.code === 'fingerprint_drift') {
          preview.value = null
          ticket.value = null
        }
      } else {
        previewError.value = err instanceof Error ? err.message : '预览请求失败'
      }
    } finally {
      if (token === epoch) submitting.value = false
    }
  }

  /** 原子确认：逐字回传 previewHash；同 requestId 重复提交由服务端幂等回放 */
  async function applyConfirmed(): Promise<boolean> {
    const pv = preview.value
    if (!pv || !requestId.value || applying.value) return false
    applying.value = true
    previewError.value = ''
    try {
      const res = await subtitleReworkApi.apply(runId.value, requestId.value, pv.previewHash)
      preview.value = null
      ticket.value = null
      await load()
      hooks.onApplied?.(res.request_id)
      return true
    } catch (err) {
      previewError.value = err instanceof Error ? `${err.message}；未确认，可重新预览后重试` : '确认请求失败'
      if (err instanceof ReworkApiError && err.status === 409) preview.value = null
      return false
    } finally {
      applying.value = false
    }
  }

  /** 未保存离开提示（规格 §3.1 验收项） */
  async function guardClose(): Promise<boolean> {
    if (!dirty.value) return true
    return confirmDialog({
      title: '放弃未保存的字幕修改？',
      message: `当前有 ${changeCount.value} 项修改尚未预览确认，关闭后将丢失。`,
      confirmText: '放弃修改',
      cancelText: '继续编辑',
      danger: true,
    })
  }

  return {
    model,
    loading,
    submitting,
    applying,
    loadError,
    previewError,
    rowErrors,
    rows,
    selected,
    preview,
    requestId,
    baselineCues,
    capability,
    supported,
    changes,
    dirty,
    changeCount,
    load,
    onRowEdited,
    shiftSelected,
    toggleSelect,
    toggleSelectAll,
    allSelected,
    requestPreview,
    applyConfirmed,
    guardClose,
  }
}
