/** [M28] 创作画布：CanvasSocket；依赖显式注入，原函数体保持不变。 */
import { watch } from 'vue'
import { getSocket, studioOff } from '../../lib/socket'
import type { StudioEventMap } from '../../lib/socket'
import type { CanvasState } from './use-canvas-state'
import type { CanvasDocument } from './use-canvas-doc'

type Dependencies = Pick<CanvasState, 'canvasId'>
  & Pick<CanvasDocument, 'scheduleRefresh'>

export function useCanvasSocket(deps: Dependencies) {
  const { canvasId, scheduleRefresh } = deps

  // ===== socket（canvas room；手动 join/leave）=====
  const socket = getSocket()
  let joinedCanvas: number | null = null

  function joinCanvasRoom(id: number): void {
    if (joinedCanvas === id) return
    if (joinedCanvas != null) socket.emit('leave', `canvas:${joinedCanvas}`)
    socket.emit('join', `canvas:${id}`)
    joinedCanvas = id
  }
  function leaveCanvasRoom(): void {
    if (joinedCanvas != null) {
      socket.emit('leave', `canvas:${joinedCanvas}`)
      joinedCanvas = null
    }
  }
  watch(
    canvasId,
    (id) => {
      if (id != null) joinCanvasRoom(id)
      else leaveCanvasRoom()
    },
    // immediate：URL 同步 watch（更早注册）已在 setup 期设置 canvasId，
    // 若不立即执行，首次进入/刷新（带 ?canvas=）会错失 null→id 变化而漏 join 房间
    { immediate: true },
  )

  function onCanvasEvent(p: StudioEventMap['canvas.changed']): void {
    if (canvasId.value != null && p.canvasId === canvasId.value) scheduleRefresh()
  }

  function disposeSocket(): void {
    studioOff('canvas.changed', onCanvasEvent)
    leaveCanvasRoom()
  }

  return {
    socket,
    joinCanvasRoom,
    leaveCanvasRoom,
    onCanvasEvent,
    disposeSocket,
  }
}

export type CanvasSocket = ReturnType<typeof useCanvasSocket>
