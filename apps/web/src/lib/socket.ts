import { io, type Socket } from 'socket.io-client'
import type { RunStep } from './types'

/** /studio 命名空间单例（lazy 连接） */
let socket: Socket | null = null
export function getSocket(): Socket {
  if (!socket) socket = io('/studio', { autoConnect: true, transports: ['websocket'] })
  return socket
}

export interface RunStepEvent {
  run_id: number
  step: Partial<RunStep> & { id: number; key?: string }
  ts: number
}

export interface StudioEventMap {
  'run.started': { run_id: number; project_id: number; step_count: number }
  'run.step': RunStepEvent
  'step.log': { step_id: number; seq: number; chunk: string }
  'run.gate': { run_id: number; step_key: string; message: string }
  'run.completed': { run_id: number; summary: unknown }
  'run.failed': { run_id: number; step_key: string; error: string }
  'task.updated': { task_id: number; status: string }
}

type Handler<K extends keyof StudioEventMap> = (payload: StudioEventMap[K]) => void

/**
 * 订阅某 run 的实时事件：join run:{id} 与 project:{pid} room。
 * 组件卸载自动 leave 并取消订阅。返回当前 run 状态的重置回调。
 */
export function useStudio(runId: number, projectId?: number) {
  const s = getSocket()

  function join() {
    s.emit('join', `run:${runId}`)
    if (projectId) s.emit('join', `project:${projectId}`)
  }
  function leave() {
    s.emit('leave', `run:${runId}`)
    if (projectId) s.emit('leave', `project:${projectId}`)
  }

  function on<K extends keyof StudioEventMap>(event: K, handler: Handler<K>) {
    s.on(event, handler as never)
  }
  function off<K extends keyof StudioEventMap>(event: K, handler: Handler<K>) {
    s.off(event, handler as never)
  }

  return { join, leave, on, off }
}
