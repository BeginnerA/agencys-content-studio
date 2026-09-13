import { io, type Socket } from 'socket.io-client'

/** /studio 命名空间单例（lazy 连接） */
let socket: Socket | null = null
export function getSocket(): Socket {
  if (!socket) socket = io('/studio', { autoConnect: true, transports: ['websocket'] })
  return socket
}

/** 与 server services/events.ts 的 StudioEvent 逐字段对齐（camelCase；server 单通道 'studio.event'） */
export interface StudioEventMap {
  'run.started': { runId: number; projectId: number; stepCount: number }
  'run.step': { runId: number; step: { id: number; key: string; action: string; status: string } }
  'step.log': { runId: number; stepId: number; seq: number; chunk: string }
  'run.gate': { runId: number; stepKey: string; message: string }
  'run.completed': { runId: number }
  'run.failed': { runId: number; stepKey: string; error: string }
  'task.updated': { runId: number | null; taskId: number; status: string; error?: string }
  'batch.updated': { runId: number | null; batchId: number; projectId: number; status: string; finished: number; total: number }
  'canvas.changed': { canvasId: number; projectId: number; nodeId?: number }
}

export type StudioEventName = keyof StudioEventMap
type Handler<K extends StudioEventName> = (payload: StudioEventMap[K]) => void

// ---- 按 type 分发表（修复断链：此前前端 s.on('run.step')，server 只发 'studio.event' 单通道）----
const byType = new Map<StudioEventName, Set<(payload: unknown) => void>>()

function subscribe<K extends StudioEventName>(event: K, handler: Handler<K>): void {
  if (!byType.has(event)) byType.set(event, new Set())
  byType.get(event)!.add(handler as (payload: unknown) => void)
}
function unsubscribe<K extends StudioEventName>(event: K, handler: Handler<K>): void {
  byType.get(event)?.delete(handler as (payload: unknown) => void)
}

let wired = false
function wire(): void {
  if (wired) return
  wired = true
  // 单次接线：整事件（含 type）直接分发给同 type 的订阅者（handler 内以 camelCase 字段取用）
  getSocket().on('studio.event', (e: { type?: string }) => {
    const set = e?.type ? byType.get(e.type as StudioEventName) : undefined
    if (!set) return
    for (const h of set) {
      try {
        h(e)
      } catch (err) {
        console.warn(`studio event handler 异常（${e.type}）`, err)
      }
    }
  })
}

/** 全局订阅/退订（无需 room 语义；TaskPanel 等「已由父级 join」场景用） */
export function studioOn<K extends StudioEventName>(event: K, handler: Handler<K>): void {
  wire()
  subscribe(event, handler)
}
export function studioOff<K extends StudioEventName>(event: K, handler: Handler<K>): void {
  unsubscribe(event, handler)
}

/**
 * 订阅某 run 的实时事件：join run:{id} 与 project:{pid} room。
 * 组件卸载自动 leave 并取消订阅。返回当前 run 状态的重置回调。
 */
export function useStudio(runId: number, projectId?: number) {
  const s = getSocket()
  wire()

  function join() {
    s.emit('join', `run:${runId}`)
    if (projectId) s.emit('join', `project:${projectId}`)
  }
  function leave() {
    s.emit('leave', `run:${runId}`)
    if (projectId) s.emit('leave', `project:${projectId}`)
  }

  function on<K extends StudioEventName>(event: K, handler: Handler<K>) {
    subscribe(event, handler)
  }
  function off<K extends StudioEventName>(event: K, handler: Handler<K>) {
    unsubscribe(event, handler)
  }

  return { join, leave, on, off }
}
