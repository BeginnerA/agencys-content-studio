/**
 * [M16] 创作画布视口组合式（pan / zoom / fit / 坐标换算；M15 CanvasBoard 模式移植，M15 零改动）
 * - pan = 视口 pointer capture（组件模式机调用 begin/move）；缩放 = 滚轮光标锚定 [0.2, 2.5]（spec §2.5）
 * - 坐标换算：screenToWorld（drop / 双击落点）；fit 按内容包围盒（自由摆放）
 * - 视口持久化：onSettled 500ms 防抖回调（调用方 PATCH /canvases/:id { viewport }；与基线相同跳过
 *   ——避免挂载 / 程序化应用时无谓写库）
 * - [M23] 视口尺寸跟踪（viewW / viewH）：ResizeObserver 监听；无实现环境退化为挂载时快照；
 *   渲染虚拟化依赖（spec §2.2；0 = 未实测 → 调用方全量渲染兜底）
 */
import { onBeforeUnmount, ref, watch } from 'vue'

export interface ViewportState {
  x: number
  y: number
  zoom: number
}

export interface ContentBounds {
  x: number
  y: number
  width: number
  height: number
}

export function useBoardViewport(
  opts: {
    /** 缩放区间（默认 [0.2, 2.5]） */
    min?: number
    max?: number
    /** 初始视口（画布持久化值；null → 默认 {40,40,1}） */
    initial?: ViewportState | null
    /** pan/zoom 稳定后回调（防抖 500ms；与基线相同则跳过） */
    onSettled?: (v: ViewportState) => void
  } = {},
) {
  const ZOOM_MIN = opts.min ?? 0.2
  const ZOOM_MAX = opts.max ?? 2.5
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, v))

  const viewportEl = ref<HTMLElement | null>(null)
  const pan = ref({ x: opts.initial?.x ?? 40, y: opts.initial?.y ?? 40 })
  const zoom = ref(
    opts.initial ? clamp(opts.initial.zoom, ZOOM_MIN, ZOOM_MAX) : 1,
  )

  // ---- [M23] 视口尺寸（虚拟化可见区；未实测 0 → 全量渲染兜底）----
  const viewW = ref(0)
  const viewH = ref(0)
  let sizeObserver: ResizeObserver | null = null

  watch(
    viewportEl,
    (el) => {
      sizeObserver?.disconnect()
      sizeObserver = null
      if (!el) return
      viewW.value = el.clientWidth
      viewH.value = el.clientHeight
      if (typeof ResizeObserver === 'undefined') return
      sizeObserver = new ResizeObserver(() => {
        viewW.value = el.clientWidth
        viewH.value = el.clientHeight
      })
      sizeObserver.observe(el)
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    sizeObserver?.disconnect()
    sizeObserver = null
  })

  // 基线：相等 → 不回写（挂载 / setViewport 程序化应用不触发 PATCH）
  let baseJson = JSON.stringify({
    x: pan.value.x,
    y: pan.value.y,
    zoom: zoom.value,
  })
  let settleTimer: number | null = null

  watch([pan, zoom], () => {
    if (!opts.onSettled) return
    const json = JSON.stringify({
      x: pan.value.x,
      y: pan.value.y,
      zoom: zoom.value,
    })
    if (json === baseJson) return
    if (settleTimer != null) window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      settleTimer = null
      const cur = { x: pan.value.x, y: pan.value.y, zoom: zoom.value }
      baseJson = JSON.stringify(cur)
      opts.onSettled?.(cur)
    }, 500)
  })

  /** 程序化应用视口（初始 / 服务端回填）；同步更新基线防误报 */
  function setViewport(v: ViewportState): void {
    pan.value = { x: v.x, y: v.y }
    zoom.value = clamp(v.zoom, ZOOM_MIN, ZOOM_MAX)
    baseJson = JSON.stringify({
      x: pan.value.x,
      y: pan.value.y,
      zoom: zoom.value,
    })
  }

  function currentViewport(): ViewportState {
    return { x: pan.value.x, y: pan.value.y, zoom: zoom.value }
  }

  // ---- pan（由组件模式机在 pointerdown/move 中调用）----
  let lastX = 0
  let lastY = 0
  function beginPan(ev: PointerEvent): void {
    lastX = ev.clientX
    lastY = ev.clientY
  }
  /** 返回是否发生了位移（组件用于区分「点空白取消选中」与拖拽） */
  function movePan(ev: PointerEvent): boolean {
    const dx = ev.clientX - lastX
    const dy = ev.clientY - lastY
    lastX = ev.clientX
    lastY = ev.clientY
    if (!dx && !dy) return false
    pan.value = { x: pan.value.x + dx, y: pan.value.y + dy }
    return true
  }

  // ---- zoom ----
  function applyZoom(nz: number, cx: number, cy: number): void {
    const z = clamp(nz, ZOOM_MIN, ZOOM_MAX)
    if (Math.abs(z - zoom.value) < 1e-4) return
    const k = z / zoom.value
    pan.value = {
      x: cx - (cx - pan.value.x) * k,
      y: cy - (cy - pan.value.y) * k,
    }
    zoom.value = z
  }
  function onWheel(ev: WheelEvent): void {
    ev.preventDefault()
    const el = viewportEl.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    applyZoom(
      zoom.value * Math.exp(-ev.deltaY * 0.0012),
      ev.clientX - rect.left,
      ev.clientY - rect.top,
    )
  }
  function zoomBy(f: number): void {
    const el = viewportEl.value
    if (!el) return
    applyZoom(zoom.value * f, el.clientWidth / 2, el.clientHeight / 2)
  }

  /** 内容适应（bounds = 世界坐标包围盒；空 → 不动作；缩放收敛上限 1） */
  function fit(bounds: ContentBounds | null, pad = 70): void {
    const el = viewportEl.value
    if (!el || !bounds) return
    const vw = el.clientWidth
    const vh = el.clientHeight
    if (!vw || !vh) return
    const w = bounds.width + pad * 2
    const h = bounds.height + pad * 2
    const z = clamp(Math.min(vw / w, vh / h), ZOOM_MIN, 1)
    zoom.value = z
    pan.value = {
      x: (vw - w * z) / 2 - (bounds.x - pad) * z,
      y: (vh - h * z) / 2 - (bounds.y - pad) * z,
    }
  }

  /** 屏幕（client）坐标 → 世界坐标（drop / 双击落点） */
  function screenToWorld(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } {
    const el = viewportEl.value
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    return {
      x: (clientX - rect.left - pan.value.x) / zoom.value,
      y: (clientY - rect.top - pan.value.y) / zoom.value,
    }
  }

  return {
    viewportEl,
    pan,
    zoom,
    viewW,
    viewH,
    setViewport,
    currentViewport,
    beginPan,
    movePan,
    applyZoom,
    onWheel,
    zoomBy,
    fit,
    screenToWorld,
  }
}
