/**
 * 规划进度登记（内存旁信道，零计费、不进幂等指纹）：
 * 规划是同步一次性模型调用（推理模型整段思考期无任何可见输出），等待期间
 * detail 经 session.planning 透出「当前阶段 + 已进行秒数」，前端把转圈升级为阶段式进度。
 * 刻意不落库：进度是易失的在途状态，随进程起止自然收敛；
 * 服务重启由 reconcileCreationSessions 把 planning 会话复位 draft，不会遗留幽灵进度。
 */
export type PlanningPhase =
  | 'analyzing' // 接收请求，理解需求中
  | 'refs' // 参考素材核验与理解（有参考才经过）
  | 'caps' // 探测模型能力与执行预检条件
  | 'model' // 调用模型生成方案（最长阶段）
  | 'validating' // 方案校验、能力钳制与制作预检

const entries = new Map<number, { phase: PlanningPhase; startedAt: number; updatedAt: number }>()

export function beginPlanningProgress(id: number): void {
  const now = Date.now()
  entries.set(id, { phase: 'analyzing', startedAt: now, updatedAt: now })
}

export function setPlanningPhase(id: number, phase: PlanningPhase): void {
  const e = entries.get(id)
  if (e) { e.phase = phase; e.updatedAt = Date.now() }
}

export function endPlanningProgress(id: number): void {
  entries.delete(id)
}

/** 详情投影用：仅规划在途时有值；elapsedSec 由服务端时钟计算（前端同秒轮询刷新） */
export function planningProgress(id: number): { phase: PlanningPhase; elapsedSec: number } | null {
  const e = entries.get(id)
  if (!e) return null
  return { phase: e.phase, elapsedSec: Math.max(0, Math.floor((Date.now() - e.startedAt) / 1000)) }
}
