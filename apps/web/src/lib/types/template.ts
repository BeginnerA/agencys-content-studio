export interface TemplateInputDef {
  key: string
  label: string
  kind: 'text' | 'int' | 'bool' | 'files'
  required: boolean
  accept?: string[]
  default?: string | number | boolean
}

export interface TemplateGate {
  mode: string
  message: string
  /** 声明后挂起态显示「跳过」按钮（免审放行、产物保留） */
  skip_label?: string
  /** 条件门：不满足 → 步骤自动 succeeded（免审直过不挂起） */
  when?: string | string[]
}

export interface TemplateBatch {
  field: string
  maxConcurrent?: number
  retry?: number
}

export interface TemplateStepDef {
  key: string
  action: string
  title: string
  inputs: Record<string, string>
  params: Record<string, unknown>
  gate?: TemplateGate
  batch?: TemplateBatch
  output?: { purpose?: string }
  when?: string | string[]
  when_any?: string[]
  after?: string[]
}

export interface TemplateMeta {
  key: string
  name: string
  description: string
  genre: string
  version: number
  stepCount: number
  updatedAt: number
  /** [M2] 引用体检：存在 params.prompt_tpl 指向的提示词文件缺失 */
  promptsDirty?: boolean
  /** 展示元数据：场景分组（produce/plan/operate） */
  scene?: string
  /** 展示元数据：推荐下游模板 key 列表 */
  next?: string[]
}

/** POST /templates/validate 响应（纯校验不落盘） */
export interface TemplateValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  template?: TemplateDetail
}

/** GET /prompts 清单项 */
export interface PromptItem {
  name: string
  size: number
  updatedAt: number
}

export interface TemplateDetail {
  key: string
  version: number
  name: string
  description: string
  genre: string
  /** 展示元数据：场景分组（produce/plan/operate） */
  scene?: string
  /** 展示元数据：推荐下游模板 key 列表 */
  next?: string[]
  inputs: TemplateInputDef[]
  defaults: Record<string, unknown>
  steps: TemplateStepDef[]
}
