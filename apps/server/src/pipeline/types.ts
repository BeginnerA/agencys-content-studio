/**
 * M1 流水线共享契约（对照设计规格 §5）。
 * 模板 = YAML 外置文件；引擎 = 状态机；action = 注册表执行器。
 */

// ---------- 模板定义（loader 解析产物） ----------

export interface TemplateInputDef {
  key: string
  label?: string
  kind: 'text' | 'files' | 'int' | 'bool'
  required: boolean
  accept?: string[]
  /** [M2] 启动时用户未传则回填（落库前完成；UI 表单预填同源） */
  default?: string | number | boolean
}

export interface TemplateGate {
  mode: 'required'
  /** 支持 {input.x} / {x:03d} 内插 */
  message: string
  /** [M2] 声明后挂起态显示「跳过」按钮（免审放行、产物保留） */
  skip_label?: string
  /** [M2] 条件门：不满足 → 步骤自动 succeeded（免审直过、不挂起） */
  when?: string | string[]
}

export interface TemplateBatch {
  /** 待批量字段（ctx.input 中的资产/JSON 字段） */
  field: string
  maxConcurrent?: number
  retry?: number
}

export interface TemplateStepDef {
  key: string
  action: string
  title: string
  /** 值可为字面量或引用串（input.x / steps.x.asset(s) / assets purpose=p） */
  inputs: Record<string, unknown>
  params?: Record<string, unknown>
  gate?: TemplateGate
  batch?: TemplateBatch
  output?: { purpose: string }
  /** [M2] 条件表达式（数组=AND）；不满足 → skipped */
  when?: string | string[]
  /** [M2] OR 组：与 when 并存时 = when 全满足 且 when_any 任一满足 */
  when_any?: string[]
  /** [M2] 显式前置依赖 keys；缺省=[前一步骤 key]；[] = 无依赖 */
  after?: string[]
}

export interface Template {
  key: string
  version: number
  name: string
  description?: string
  genre: string
  inputs: TemplateInputDef[]
  /** 模板级默认参数；project.settings 同名键覆盖 */
  defaults?: Record<string, unknown>
  steps: TemplateStepDef[]
}

export interface TemplateMeta {
  key: string
  name: string
  description?: string
  genre: string
  version: number
  stepCount: number
  updatedAt: number
  /** [M2] 引用体检：存在 params.prompt_tpl 指向的提示词文件缺失 */
  promptsDirty?: boolean
}

// ---------- 执行产物 ----------

/** action 统一返回：产物资产 id（顺序即下游消费顺序） */
export interface StepResult {
  assetIds: number[]
}

/** 步骤级错误：engine 捕获 → step failed + run failed */
export class StepError extends Error {}

/** action 未实现（ai_video 占位等） */
export class ActionNotImplemented extends StepError {
  constructor(actionKey: string) {
    super(`action「${actionKey}」尚未实现（占位注册）`)
    this.name = 'ActionNotImplemented'
  }
}

/** 引用解析失败：错误含引用路径（spec §5.2） */
export class RefResolveError extends StepError {
  constructor(ref: string, reason: string) {
    super(`引用解析失败 [${ref}]：${reason}`)
    this.name = 'RefResolveError'
  }
}

/** run 被取消：引擎在步骤边界抛出，用于中止执行链 */
export class RunCancelledError extends Error {
  constructor() {
    super('run 已取消')
    this.name = 'RunCancelledError'
  }
}
