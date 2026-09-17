/**
 * 进程内事件总线：pipeline/actions 发布，index.ts 桥接 Socket.IO。
 * 事件仅作增量提示；客户端以 REST 全量对账（与前端流式共享规范一致）。
 */
export type StudioEvent =
  | { type: 'run.started'; runId: number; projectId: number; stepCount: number }
  | { type: 'run.step'; runId: number; step: { id: number; key: string; action: string; status: string } }
  | { type: 'step.log'; runId: number; stepId: number; seq: number; chunk: string }
  | { type: 'run.gate'; runId: number; stepKey: string; message: string }
  | { type: 'run.completed'; runId: number }
  | { type: 'run.failed'; runId: number; stepKey: string; error: string }
  | { type: 'task.updated'; runId: number | null; taskId: number; status: string; error?: string }
  | { type: 'batch.updated'; runId: number | null; batchId: number; projectId: number
      status: string; finished: number; total: number }
  | { type: 'canvas.changed'; canvasId: number; projectId: number; nodeId?: number }
  | { type: 'entity.ref_gen'; projectId: number; taskId: number; entityId: number; status: string; error?: string }
  | { type: 'workflow.segment_done'; workflowId: number; projectId: number; runId: number; seq: number }
  | { type: 'workflow.advanced'; workflowId: number; projectId: number; fromRunId: number; toRunId: number; seq: number }
  | { type: 'workflow.blocked'; workflowId: number; projectId: number; runId: number | null; reason: 'failed' | 'budget' | 'input' }
  | { type: 'workflow.completed'; workflowId: number; projectId: number }

type Handler = (e: StudioEvent) => void

const handlers = new Set<Handler>()

export function onStudioEvent(h: Handler): () => void {
  handlers.add(h)
  return () => handlers.delete(h)
}

export function emitStudioEvent(e: StudioEvent): void {
  for (const h of handlers) h(e)
}
