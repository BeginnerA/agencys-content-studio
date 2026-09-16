/**
 * [M28] 创作画布交互组合式（自 CreationBoard.vue 逐字迁移：模式机 / 键盘 / 连线 / 框选 / fit）
 * —— 装配约定：函数体逐字保留；props/emit/依赖经参数注入；包裹层缩进 +2（机械转换）
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { CanvasDocNode, CanvasGroup } from '../../../lib/types'
import type { ContentBounds } from '../../../lib/board-viewport'
import type { useBoardViewport } from '../../../lib/board-viewport'
import { ARROW, NODE_W, bezier, isEditable } from './internals'
import type { BoardEmitFn, BoardProps } from './internals'

type BoardViewport = ReturnType<typeof useBoardViewport>

interface BoardInteractionsDeps {
  vp: BoardViewport
  viewportEl: Ref<HTMLElement | null>
  nodeById: ComputedRef<Map<number, CanvasDocNode>>
  nodeXY: (n: CanvasDocNode) => { x: number; y: number }
  nodeH: (n: CanvasDocNode) => number
  /** [M22] 组子树递归成员节点 id（含全部后代组） */
  descNodeIds: (gid: number) => number[]
  /** [M22] 组子树后代组 id（不含自身；锚点平移用） */
  descGroupIds: (gid: number) => number[]
  editingGroupId: Ref<number | null>
  openGroupMenu: Ref<number | null>
}

export function useBoardInteractions(props: BoardProps, emit: BoardEmitFn, deps: BoardInteractionsDeps) {
  const { vp, viewportEl, nodeById, nodeXY, nodeH, descNodeIds, descGroupIds, editingGroupId, openGroupMenu } = deps
  const { pan, zoom } = vp

  /** 拖拽中的整组本地即时偏移（优先于渲染）；抬起 emit 后由父级乐观更新替换
   *  [M22] gids：组条拖拽时的「自身+后代组」锚点平移集（空组包围盒跟随） */
  const dragGroup = ref<{ ids: number[]; dx: number; dy: number; moved: boolean; gids?: number[] } | null>(null)

  function onGroupBarPointerDown(ev: PointerEvent, g: CanvasGroup): void {
    if (ev.button !== 0 || spaceDown.value) return
    if (editingGroupId.value === g.id) return
    ev.stopPropagation()
    // [M22] 递归：选中/拖拽全部后代节点；后代组（含自身）锚点同步平移
    const ids = descNodeIds(g.id)
    emit('select', ids)
    openGroupMenu.value = null
    mode.value = 'node'
    drag = { ids, gids: [g.id, ...descGroupIds(g.id)] }
    dragPx = { cx: ev.clientX, cy: ev.clientY }
    dragGroup.value = null
    viewportEl.value?.setPointerCapture(ev.pointerId)
  }


  // ---- 连线中（临时贝塞尔跟随光标；世界坐标）----
  const linkFrom = ref<number | null>(null)
  const linkCur = ref<{ x: number; y: number } | null>(null)
  /** hover 的输入端口（`nodeId:port`） */
  const hotPort = ref<string | null>(null)
  const linkPath = computed<string | null>(() => {
    if (linkFrom.value == null || !linkCur.value) return null
    const n = nodeById.value.get(linkFrom.value)
    if (!n) return null
    const p = nodeXY(n)
    return bezier(p.x + NODE_W, p.y + nodeH(n) / 2, linkCur.value.x, linkCur.value.y)
  })
  function cancelLink(): void {
    linkFrom.value = null
    linkCur.value = null
    hotPort.value = null
  }

  // ---- 模式机（pointer 统一在视口捕获：box / pan / node / link）----
  type Mode = 'idle' | 'pan' | 'node' | 'link' | 'box'
  const mode = ref<Mode>('idle')
  const spaceDown = ref(false)
  let panMoved = false
  let drag: { ids: number[]; gids?: number[] } | null = null
  let dragPx: { cx: number; cy: number } | null = null
  let boxStart: { x: number; y: number } | null = null
  let boxMoved = false
  const boxRect = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

  function onViewportPointerDown(ev: PointerEvent): void {
    if (ev.button === 1 || (ev.button === 0 && spaceDown.value)) {
      // 平移：中键 / 空格+左键（spec §2.4）
      ev.preventDefault()
      mode.value = 'pan'
      panMoved = false
      vp.beginPan(ev)
      ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
      return
    }
    if (ev.button !== 0) return
    // 空白左键 = 框选（M17 破坏性变更：原为平移）
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    mode.value = 'box'
    boxMoved = false
    boxStart = { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
    boxRect.value = null
    ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
  }

  function onNodePointerDown(ev: PointerEvent, n: CanvasDocNode): void {
    if (ev.button !== 0 || spaceDown.value) return // 空格按住 = 平移（不拦截，冒泡到视口）
    ev.stopPropagation()
    mode.value = 'node'
    const cur = props.selectedIds
    const inSel = cur.includes(n.id)
    if (ev.shiftKey && !inSel) {
      emit('select', [...cur, n.id])
      drag = { ids: [n.id] } // 加选并单拖新节点
    } else if (ev.shiftKey && inSel) {
      emit('select', cur.filter((id) => id !== n.id)) // 减选
      drag = { ids: cur.filter((id) => id !== n.id) }
    } else if (inSel) {
      drag = { ids: [...cur] } // 多拖：拖动任一选中 = 整组
    } else {
      emit('select', [n.id])
      drag = { ids: [n.id] }
    }
    dragPx = { cx: ev.clientX, cy: ev.clientY }
    dragGroup.value = null
    viewportEl.value?.setPointerCapture(ev.pointerId)
  }

  function onOutPortPointerDown(ev: PointerEvent, n: CanvasDocNode): void {
    if (ev.button !== 0) return
    ev.stopPropagation()
    mode.value = 'link'
    linkFrom.value = n.id
    linkCur.value = vp.screenToWorld(ev.clientX, ev.clientY)
    hotPort.value = null
    viewportEl.value?.setPointerCapture(ev.pointerId)
  }

  function onViewportPointerMove(ev: PointerEvent): void {
    if (mode.value === 'pan') {
      if (vp.movePan(ev)) panMoved = true
    } else if (mode.value === 'node' && drag && dragPx) {
      const px = ev.clientX - dragPx.cx
      const py = ev.clientY - dragPx.cy
      if (!dragGroup.value?.moved && Math.abs(px) + Math.abs(py) < 4) return
      dragGroup.value = { ids: drag.ids, dx: px / zoom.value, dy: py / zoom.value, moved: true }
    } else if (mode.value === 'link') {
      linkCur.value = vp.screenToWorld(ev.clientX, ev.clientY)
      const t = (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-in-port]') as HTMLElement | null) ?? null
      hotPort.value = t ? `${t.dataset.nodeId}:${t.dataset.port}` : null
    } else if (mode.value === 'box' && boxStart) {
      const el = viewportEl.value
      if (!el) return
      const rect = el.getBoundingClientRect()
      const x = ev.clientX - rect.left
      const y = ev.clientY - rect.top
      if (!boxMoved && Math.abs(x - boxStart.x) + Math.abs(y - boxStart.y) < 4) return
      boxMoved = true
      boxRect.value = { x1: boxStart.x, y1: boxStart.y, x2: x, y2: y }
    }
  }

  function onViewportPointerUp(ev: PointerEvent): void {
    const el = ev.currentTarget as HTMLElement
    if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
    if (mode.value === 'link') {
      const t = (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-in-port]') as HTMLElement | null) ?? null
      const from = linkFrom.value
      if (t && from != null) {
        const to = Number(t.dataset.nodeId)
        const port = t.dataset.port ?? ''
        if (Number.isInteger(to) && to !== from && port) emit('connect', { from, to, port })
      }
      cancelLink()
    } else if (mode.value === 'node' && drag) {
      const d = dragGroup.value
      if (d?.moved) {
        const sel = new Set(d.ids)
        const moves = props.nodes
          .filter((n) => sel.has(n.id))
          .map((n) => ({ id: n.id, x: Math.round(n.x + d.dx), y: Math.round(n.y + d.dy) }))
        if (moves.length) emit('moved', moves)
        // [M22] 组条拖拽：后代组锚点跟随平移（空组包围盒用锚点）
        if (d.gids?.length) {
          const gsel = new Set(d.gids)
          const gmoves = props.groups
            .filter((g) => gsel.has(g.id))
            .map((g) => ({ id: g.id, x: Math.round(g.x + d.dx), y: Math.round(g.y + d.dy) }))
          if (gmoves.length) emit('groups-moved', gmoves)
        }
      }
      drag = null
      dragPx = null
      dragGroup.value = null
    } else if (mode.value === 'pan') {
      if (!panMoved) {
        emit('select', [])
        emit('selectEdge', null)
      }
    } else if (mode.value === 'box') {
      if (boxMoved && boxRect.value) {
        const el2 = viewportEl.value
        const br = boxRect.value
        if (el2) {
          const rect = el2.getBoundingClientRect()
          const w1 = vp.screenToWorld(rect.left + Math.min(br.x1, br.x2), rect.top + Math.min(br.y1, br.y2))
          const w2 = vp.screenToWorld(rect.left + Math.max(br.x1, br.x2), rect.top + Math.max(br.y1, br.y2))
          const hits = props.nodes
            .filter((n) => {
              const p = nodeXY(n)
              return p.x >= w1.x && p.y >= w1.y && p.x + NODE_W <= w2.x && p.y + nodeH(n) <= w2.y
            })
            .map((n) => n.id)
          emit('select', ev.shiftKey ? [...new Set([...props.selectedIds, ...hits])] : hits)
        }
      } else {
        emit('select', [])
        emit('selectEdge', null)
      }
      boxRect.value = null
      boxStart = null
      boxMoved = false
    }
    mode.value = 'idle'
  }

  const boxStyle = computed(() => {
    const b = boxRect.value
    if (!b) return undefined
    return {
      left: `${Math.min(b.x1, b.x2)}px`,
      top: `${Math.min(b.y1, b.y2)}px`,
      width: `${Math.abs(b.x2 - b.x1)}px`,
      height: `${Math.abs(b.y2 - b.y1)}px`,
    }
  })


  // ---- 键盘（快捷键全集；输入框聚焦时除 Esc 全部让行）----
  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      // Esc 不被输入框吞：取消连线/框选，否则清空选中
      if (mode.value === 'link') {
        cancelLink()
        return
      }
      if (mode.value === 'box') {
        boxRect.value = null
        boxStart = null
        boxMoved = false
        return
      }
      if (props.selectedIds.length) emit('select', [])
      return
    }
    if (isEditable(ev.target)) return
    if (ev.code === 'Space') {
      if (!ev.repeat) spaceDown.value = true
      ev.preventDefault()
      return
    }
    const mod = ev.ctrlKey || ev.metaKey
    const key = ev.key.toLowerCase()
    if (mod && key === 'z' && !ev.shiftKey) {
      ev.preventDefault()
      emit('undo')
      return
    }
    if ((mod && key === 'z' && ev.shiftKey) || (mod && key === 'y')) {
      ev.preventDefault()
      emit('redo')
      return
    }
    if (mod && key === 'd') {
      ev.preventDefault()
      emit('copy-selected')
      return
    }
    if (mod && key === 'g') {
      // [M18] Ctrl+G 成组（须 ≥2 选中；解组走组条菜单）
      ev.preventDefault()
      if (props.selectedIds.length >= 2) emit('group-create')
      return
    }
    if (mod && key === 'a') {
      ev.preventDefault()
      emit('select', props.nodes.map((n) => n.id))
      return
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (props.selectedIds.length) {
        ev.preventDefault()
        emit('delete-selected')
      }
      return
    }
    if (key === 'f' && !mod) {
      fitView()
      return
    }
    const dir = ARROW[ev.key]
    if (dir && props.selectedIds.length) {
      ev.preventDefault()
      const step = ev.shiftKey ? 1 : 10
      const sel = new Set(props.selectedIds)
      const moves = props.nodes
        .filter((n) => sel.has(n.id))
        .map((n) => ({ id: n.id, x: n.x + dir[0] * step, y: n.y + dir[1] * step }))
      if (moves.length) emit('nudge', moves)
    }
  }
  function onKeyUp(ev: KeyboardEvent): void {
    if (ev.code === 'Space') spaceDown.value = false
  }
  onMounted(() => {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
  })


  // ---- 双击空白建生成节点 / drop 文件 ----
  function onDblClick(ev: MouseEvent): void {
    if (spaceDown.value) return
    const p = vp.screenToWorld(ev.clientX, ev.clientY)
    emit('create-node', { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - 60) })
  }
  function onDragOver(ev: DragEvent): void {
    ev.preventDefault()
  }
  function onDrop(ev: DragEvent): void {
    ev.preventDefault()
    const p = vp.screenToWorld(ev.clientX, ev.clientY)
    const x = Math.round(p.x - NODE_W / 2)
    const y = Math.round(p.y - 60)
    // 素材面板拖入（assetId / entityId）优先；否则按本地文件处理（由父级上传后建节点）
    const assetRaw = ev.dataTransfer?.getData('text/acs-asset-id')
    if (assetRaw) {
      const assetId = Number(assetRaw)
      if (Number.isInteger(assetId) && assetId > 0) emit('drop-asset', { assetId, x, y })
      return
    }
    const entityRaw = ev.dataTransfer?.getData('text/acs-entity-id')
    if (entityRaw) {
      const entityId = Number(entityRaw)
      if (Number.isInteger(entityId) && entityId > 0) emit('drop-entity', { entityId, x, y })
      return
    }
    const files = Array.from(ev.dataTransfer?.files ?? [])
    if (!files.length) return
    emit('drop-files', { files, x, y })
  }

  // ---- fit / 暴露 ----
  function contentBounds(): ContentBounds | null {
    if (!props.nodes.length) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of props.nodes) {
      const p = nodeXY(n)
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + NODE_W)
      maxY = Math.max(maxY, p.y + nodeH(n))
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }
  function fitView(): void {
    vp.fit(contentBounds())
  }
  /** 视口中心的世界坐标（拖入素材的「视口中心」落点） */
  function centerWorld(): { x: number; y: number } {
    const el = viewportEl.value
    if (!el) return { x: 200, y: 160 }
    const rect = el.getBoundingClientRect()
    const p = vp.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - 60) }
  }
  /** [M17] 使世界坐标 (x,y) 居中（总览聚焦 / 定位；不改缩放） */
  function centerOn(x: number, y: number): void {
    const el = viewportEl.value
    if (!el) return
    pan.value = { x: el.clientWidth / 2 - x * zoom.value, y: el.clientHeight / 2 - y * zoom.value }
  }

  return {
    mode, spaceDown, dragGroup, boxRect, boxStyle,
    linkFrom, hotPort, linkPath,
    onViewportPointerDown, onNodePointerDown, onOutPortPointerDown, onViewportPointerMove, onViewportPointerUp,
    onGroupBarPointerDown, onDblClick, onDragOver, onDrop,
    fitView, centerWorld, centerOn,
  }
}
