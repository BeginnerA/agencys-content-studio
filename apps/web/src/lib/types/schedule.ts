/** [M20] 排产计划 + 预算类型 */

export type ScheduleStatus =
  'pending' | 'triggered' | 'completed' | 'cancelled' | 'failed'

export interface Schedule {
  id: number
  projectId: number
  name: string
  templateKey: string
  cronExpr: string
  scheduledAt: number
  status: ScheduleStatus
  lastTriggeredAt: number | null
  lastBatchId: number | null
  inputTemplate: unknown
  note: string | null
  isActive: number
  createdAt: number
  updatedAt: number
}

export interface ScheduleCalendarItem {
  id: number
  projectId: number
  name: string
  templateKey: string
  scheduledAt: number
  status: string
  lastBatchId: number | null
  batchStatus: string | null
  note: string | null
}

export interface BudgetConfig {
  projects?: Record<string, { monthly?: number; total?: number }>
  global?: { monthly?: number; total?: number }
  alertRatio?: number
}

export interface BudgetUsage {
  budget: number
  spent: number
  ratio: number
}

export interface BudgetProjectOverview {
  projectId: number
  monthly: BudgetUsage
  total: BudgetUsage
}

export interface BudgetOverviewResult {
  config: BudgetConfig
  projects: BudgetProjectOverview[]
  global: { monthly: BudgetUsage | null }
}

export interface BudgetAlert {
  id: number
  scope: string
  scopeId: number | null
  kind: string
  budget: number
  spent: number
  ratio: number
  createdAt: number
}
