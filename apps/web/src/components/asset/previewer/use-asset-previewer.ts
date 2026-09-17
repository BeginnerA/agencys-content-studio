/**
 * [M28] 资产预览查看器状态与操作（自 AssetPreviewer.vue 逐字迁移）
 * —— 装配约定：函数体逐字保留；props/emit 经参数注入；包裹层缩进 +2（机械转换）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { assetApi } from '../../../lib/api'
import type { Asset } from '../../../lib/types'
import { KIND_TEXT, fmtDur, fmtSize, fmtTime, parseAssetCompliance, parseAssetQuality, purposeText, qualityText } from '../../../lib/format'
import { registerEscLayer } from '../../../lib/esc-layer'

// ---- 组件对外契约（自 AssetPreviewer.vue props/emit 定义迁移，字段与类型逐字）----
export interface PreviewerProps {
  assets: Asset[]
  index?: number
}

export interface PreviewerEmits { close: []; changed: [asset: Asset] }

/** emit 签名（与 defineEmits<PreviewerEmits>() 返回结构一致；供状态 composable 参数注入） */
export type PreviewerEmitFn = {
  <K extends keyof PreviewerEmits>(event: K, ...args: PreviewerEmits[K]): void
}

export function useAssetPreviewer(props: PreviewerProps, emit: PreviewerEmitFn) {
  // 嵌套覆盖层（如弹窗上开预览器）时仅最顶层响应 Esc：Esc 只关预览器，不误关下层弹窗
  const escLayer = registerEscLayer()

  const MAX_TEXT = 1.5 * 1024 * 1024 // 文本预览上限：超出只提供下载
  const JSON_PARSE_MAX = 512 * 1024 // 超过不做格式化/着色，防卡顿
  const MIN_SCALE = 1
  const MAX_SCALE = 8

  const idx = ref(Math.min(Math.max(props.index ?? 0, 0), Math.max(props.assets.length - 1, 0)))
  const cur = computed<Asset | null>(() => props.assets[idx.value] ?? null)
  const hasPrev = computed(() => idx.value > 0)
  const hasNext = computed(() => idx.value < props.assets.length - 1)

  // ===== 类型分派：ext 优先判文本子类型，其次按 kind =====
  type ViewKind = 'image' | 'video' | 'audio' | 'markdown' | 'json' | 'text' | 'file'

  function viewKindOf(a: Asset): ViewKind {
    const ext = (a.ext ?? '').toLowerCase()
    if (ext === 'md' || ext === 'markdown') return 'markdown'
    if (ext === 'json') return 'json'
    if (['txt', 'yaml', 'yml', 'csv', 'log', 'ini', 'toml'].includes(ext)) return 'text'
    if (a.kind === 'image') return 'image'
    if (a.kind === 'video') return 'video'
    if (a.kind === 'audio') return 'audio'
    if (a.kind === 'text') return 'text'
    return 'file'
  }

  const vkind = computed<ViewKind>(() => (cur.value ? viewKindOf(cur.value) : 'file'))
  const isTextLike = computed(() => ['markdown', 'json', 'text'].includes(vkind.value))
  const tooBig = computed(() => (cur.value?.fileSize ?? 0) > MAX_TEXT)

  const TYPE_ICON: Record<ViewKind, string> = {
    image: 'photo',
    video: 'video',
    audio: 'speaker-wave',
    markdown: 'doc',
    json: 'doc',
    text: 'doc',
    file: 'doc',
  }

  const kindLabel = computed(() => {
    const a = cur.value
    if (!a) return ''
    return KIND_TEXT[a.kind] ?? a.kind
  })

  // [M24] 合规审核徽章（spec §2.6 前端最小面：params.compliance → 状态 + 时间；无标记不渲染）
  const compliance = computed(() => (cur.value ? parseAssetCompliance(cur.value) : null))
  const COMPLIANCE_LABEL: Record<string, string> = { pass: '合规通过', warn: '合规风险', block: '合规拦截' }
  const complianceLabel = computed(() => (compliance.value ? COMPLIANCE_LABEL[compliance.value.status] ?? compliance.value.status : ''))
  const complianceTip = computed(() => {
    const c = compliance.value
    if (!c) return ''
    return `合规审核 ${c.status} · 词库命中 ${c.hits} 处 · ${c.checkedAt ? new Date(c.checkedAt).toLocaleString() : '时间未知'}`
  })

  const metaLine = computed(() => {
    const a = cur.value
    if (!a) return ''
    const parts: string[] = []
    if (a.purpose) parts.push(purposeText(a.purpose))
    if (a.ext) parts.push(a.ext.toUpperCase())
    parts.push(fmtSize(a.fileSize))
    // 尺寸优先取资产元数据；缺失时用图片实测值补显
    const dims = a.width && a.height
      ? `${a.width}×${a.height}`
      : naturalSize.value
        ? `${naturalSize.value.w}×${naturalSize.value.h}`
        : null
    if (dims) parts.push(dims)
    if (a.duration) parts.push(fmtDur(a.duration))
    parts.push(fmtTime(a.createdAt))
    return parts.join(' · ')
  })

  // ===== 文本类加载（md/json/txt/yaml/csv…） =====
  const text = ref('')
  const textLoading = ref(false)
  const textErr = ref('')
  const jsonHtml = ref('')
  const jsonBad = ref(false)

  async function loadText() {
    const a = cur.value
    if (!a || !isTextLike.value) return
    text.value = ''
    jsonHtml.value = ''
    jsonBad.value = false
    textErr.value = ''
    if ((a.fileSize ?? 0) > MAX_TEXT) return
    textLoading.value = true
    try {
      const res = await fetch(a.urls.file)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const raw = await res.text()
      text.value = raw
      if (vkind.value === 'json') buildJsonHtml(raw)
    } catch (e) {
      textErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      textLoading.value = false
    }
  }

  function buildJsonHtml(raw: string) {
    if (raw.length > JSON_PARSE_MAX) {
      jsonHtml.value = escapeHtml(raw)
      return
    }
    try {
      jsonHtml.value = highlightJson(JSON.stringify(JSON.parse(raw), null, 2))
    } catch {
      jsonBad.value = true
      jsonHtml.value = escapeHtml(raw)
    }
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  /** 轻量 JSON 着色：先转义后着色（键/字符串/数字/布尔/null 五类 token），不引额外依赖 */
  function highlightJson(src: string): string {
    return escapeHtml(src).replace(
      /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (m: string, str: string | undefined, colon: string | undefined) => {
        if (str !== undefined) {
          return colon ? `<span class="jk">${str}</span><span class="jp">${colon}</span>` : `<span class="js">${str}</span>`
        }
        if (m === 'true' || m === 'false') return `<span class="jb">${m}</span>`
        if (m === 'null') return `<span class="jn">${m}</span>`
        return `<span class="jnum">${m}</span>`
      },
    )
  }

  const copied = ref(false)
  let copyTimer: number | undefined

  async function copyText() {
    if (!text.value) return
    try {
      await navigator.clipboard.writeText(text.value)
      copied.value = true
      if (copyTimer) window.clearTimeout(copyTimer)
      copyTimer = window.setTimeout(() => (copied.value = false), 2000)
    } catch {
      textErr.value = '复制失败，请手动选择文本复制'
    }
  }

  // ===== 图片缩放 / 平移（transform 以舞台中心为原点） =====
  const scale = ref(1)
  const tx = ref(0)
  const ty = ref(0)
  const dragging = ref(false)
  const imgErr = ref(false)
  const naturalSize = ref<{ w: number; h: number } | null>(null)
  const stageEl = ref<HTMLElement | null>(null)
  let dragStart = { x: 0, y: 0, tx: 0, ty: 0 }

  function onImgLoad(e: Event) {
    const img = e.target as HTMLImageElement
    if (img.naturalWidth && img.naturalHeight) naturalSize.value = { w: img.naturalWidth, h: img.naturalHeight }
  }

  function resetImage() {
    scale.value = 1
    tx.value = 0
    ty.value = 0
    dragging.value = false
  }

  /** 以 (px,py)（相对舞台中心）为锚点缩放到 next */
  function zoomAt(next: number, px = 0, py = 0) {
    const s0 = scale.value
    const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
    if (s1 === s0) return
    if (s1 === MIN_SCALE) {
      tx.value = 0
      ty.value = 0
    } else {
      const k = s1 / s0
      tx.value = px - (px - tx.value) * k
      ty.value = py - (py - ty.value) * k
    }
    scale.value = s1
  }

  function onWheel(e: WheelEvent) {
    const rect = stageEl.value?.getBoundingClientRect()
    if (!rect) return
    const px = e.clientX - rect.left - rect.width / 2
    const py = e.clientY - rect.top - rect.height / 2
    zoomAt(scale.value * (e.deltaY < 0 ? 1.18 : 1 / 1.18), px, py)
  }

  function zoomBy(f: number) {
    zoomAt(scale.value * f)
  }

  function toggleDouble() {
    if (scale.value > 1) resetImage()
    else zoomAt(2)
  }

  function onPointerDown(e: PointerEvent) {
    if (scale.value <= 1) return
    dragging.value = true
    dragStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging.value) return
    tx.value = dragStart.tx + (e.clientX - dragStart.x)
    ty.value = dragStart.ty + (e.clientY - dragStart.y)
  }

  function onPointerUp() {
    dragging.value = false
  }

  // ===== [M12] 图像有效性重检（写回 params.quality；结果同步宿主） =====
  const checkBusy = ref(false)
  const checkMsg = ref('')

  async function doCheck() {
    const a = cur.value
    if (!a || a.kind !== 'image' || checkBusy.value) return
    checkBusy.value = true
    checkMsg.value = ''
    try {
      const r = await assetApi.check(a.id)
      checkMsg.value = `检测完成：${qualityText(parseAssetQuality(r.asset)?.reason)}`
      emit('changed', r.asset)
    } catch (e) {
      checkMsg.value = `检测失败：${e instanceof Error ? e.message : String(e)}`
    } finally {
      checkBusy.value = false
    }
  }

  // ===== [M21] 标签编辑（footer 内联；变更即存） =====
  const tagDraft = ref('')
  const tagBusy = ref(false)
  const tagErr = ref('')
  // 本地基准覆盖层：宿主 props 刷新滞后（或未接 @changed）期间，以最近一次成功保存为基准，
  // 避免基于陈旧快照回写「复活」已删标签；资产切换时因 id 不匹配自动失效
  const tagState = ref<{ id: number; tags: string[] } | null>(null)

  /** 当前资产标签（本地覆盖优先） */
  const curTags = computed<string[]>(() => {
    const a = cur.value
    if (!a) return []
    if (tagState.value && tagState.value.id === a.id) return tagState.value.tags
    return a.tags ?? []
  })

  /** 保存标签（覆盖式写入字符串数组）→ 同步本地基准 + 宿主 */
  async function saveTags(next: string[]) {
    const a = cur.value
    if (!a || tagBusy.value) return
    tagBusy.value = true
    tagErr.value = ''
    try {
      const r = await assetApi.updateTags(a.id, next)
      tagState.value = { id: r.asset.id, tags: r.asset.tags ?? next }
      emit('changed', r.asset)
    } catch (e) {
      tagErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      tagBusy.value = false
    }
  }

  /** 回车添加（去重；空白忽略；基准为本地覆盖后的最新值） */
  function addTag() {
    const t = tagDraft.value.trim()
    if (!cur.value || !t) return
    tagDraft.value = ''
    if (curTags.value.includes(t)) return
    void saveTags([...curTags.value, t])
  }

  function removeTag(t: string) {
    if (!cur.value) return
    void saveTags(curTags.value.filter((x) => x !== t))
  }

  // ===== 多资产切换 / 键盘 =====
  function prev() {
    if (hasPrev.value) idx.value -= 1
  }

  function next() {
    if (hasNext.value) idx.value += 1
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (escLayer.isTop()) emit('close')
      return
    }
    if (e.key === 'ArrowLeft') prev()
    if (e.key === 'ArrowRight') next()
  }

  /** 下载链接（?download=1 触发附件，见 assets 路由契约） */
  function downloadHref(a: Asset | null): string {
    if (!a) return '#'
    const u = a.urls.file
    return u + (u.includes('?') ? '&' : '?') + 'download=1'
  }

  watch(idx, () => {
    resetImage()
    imgErr.value = false
    naturalSize.value = null
    copied.value = false
    checkMsg.value = ''
    tagDraft.value = ''
    tagErr.value = ''
    void loadText()
  })

  let prevOverflow = ''
  onMounted(() => {
    escLayer.hold()
    window.addEventListener('keydown', onKey)
    prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    void loadText()
  })

  onBeforeUnmount(() => {
    escLayer.release()
    window.removeEventListener('keydown', onKey)
    document.body.style.overflow = prevOverflow
    if (copyTimer) window.clearTimeout(copyTimer)
  })

  return {
    MIN_SCALE,
    MAX_SCALE,
    idx,
    cur,
    hasPrev,
    hasNext,
    vkind,
    isTextLike,
    tooBig,
    TYPE_ICON,
    kindLabel,
    compliance,
    complianceLabel,
    complianceTip,
    metaLine,
    text,
    textLoading,
    textErr,
    jsonHtml,
    jsonBad,
    copied,
    copyText,
    scale,
    tx,
    ty,
    dragging,
    imgErr,
    stageEl,
    onImgLoad,
    resetImage,
    onWheel,
    zoomBy,
    toggleDouble,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    checkBusy,
    checkMsg,
    doCheck,
    tagDraft,
    tagBusy,
    tagErr,
    curTags,
    addTag,
    removeTag,
    prev,
    next,
    downloadHref,
  }
}
