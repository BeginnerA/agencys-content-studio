/**
 * 流水线共享契约（对照设计规格 §5）。
 * 模板 = YAML 外置文件；引擎 = 状态机；action = 注册表执行器。
 */

// ---------- 模板定义（loader 解析产物） ----------

export interface TemplateInputDef {
  key: string
  label?: string
  kind: 'text' | 'files' | 'int' | 'bool' | 'publications'
  required: boolean
  accept?: string[]
  /** 启动时用户未传则回填（落库前完成；UI 表单预填同源） */
  default?: string | number | boolean
}

export interface TemplateGate {
  mode: 'required'
  /** 支持 {input.x} / {x:03d} 内插 */
  message: string
  /** 声明后挂起态显示「跳过」按钮（免审放行、产物保留） */
  skip_label?: string
  /** 拒绝后保留产物并停止；缺省仍沿用历史整步重跑语义。 */
  reject?: 'stop'
  /** 条件门：不满足 → 步骤自动 succeeded（免审直过、不挂起） */
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
  /** 条件表达式（数组=AND）；不满足 → skipped */
  when?: string | string[]
  /** OR 组：与 when 并存时 = when 全满足 且 when_any 任一满足 */
  when_any?: string[]
  /** 显式前置依赖 keys；缺省=[前一步骤 key]；[] = 无依赖 */
  after?: string[]
  /** 显式允许可选上游全部跳过后继续；缺省保留历史跳过传播。 */
  after_skipped?: 'continue'
}

export interface Template {
  key: string
  version: number
  name: string
  description?: string
  genre: string
  /** 展示元数据：场景分组（produce/plan/operate，仅 UI 分组用，不参与执行） */
  scene?: string
  /** 展示元数据：推荐下游模板 key 列表（完成态「下一步」建议） */
  next?: string[]
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
  /** 引用体检：存在 params.prompt_tpl 指向的提示词文件缺失 */
  promptsDirty?: boolean
  /** 展示元数据：场景分组（produce/plan/operate） */
  scene?: string
  /** 展示元数据：推荐下游模板 key 列表 */
  next?: string[]
  /** 轻松创作批准链专用（easy-*）：仅由对话页在方案确认后调度，手动启动/排程/建项目选它都无法运行。
   *  由 GET /templates 依 isCreationTemplate 真源注入（该判据派生自各 YAML 顶层 `visibility: conversation`，见 loader.templateFlags）；
   *  所有「选择器」按此过滤，展示反查方忽略。 */
  conversationOnly?: boolean
  /** [内置保护] 系统出厂内置模板：用户只读，不可修改/删除；真源 = 各出厂 YAML 顶层 `builtin: true` 标记（经 loader.templateFlags 派生）。
   *  由 GET /templates 注入，前端据此锁定编辑/删除入口，服务端 PUT/DELETE 据此拒绝。 */
  builtin?: boolean
}

// ---------- 执行产物 ----------

/** action 统一返回：产物资产 id（顺序即下游消费顺序） */
export interface StepResult {
  assetIds: number[]
}

/** 步骤级错误：engine 捕获 → step failed + run failed */
export class StepError extends Error {}

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
