/** 自动编排链类型（与后端 toWorkflowView 对齐） */

export type WorkflowStatus =
  'draft' | 'active' | 'paused' | 'done' | 'cancelled'

/** 段定义：按序引用既有模板 key；inputSpec 为字段→取值语法映射 */
export interface WorkflowSegment {
  templateKey: string
  inputSpec?: Record<string, string>
}

export interface Workflow {
  id: number
  projectId: number
  name: string
  status: WorkflowStatus
  autoAdvance: number
  budgetCap: number | null
  segments: WorkflowSegment[]
  note: string | null
  createdAt: number
  updatedAt: number
}
