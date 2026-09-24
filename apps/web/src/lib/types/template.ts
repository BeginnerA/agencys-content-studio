export interface TemplateInputDef {
  key: string
  label: string
  kind: 'text' | 'int' | 'bool' | 'files' | 'publications'
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
  /** 引用体检：存在 params.prompt_tpl 指向的提示词文件缺失 */
  promptsDirty?: boolean
  /** 展示元数据：场景分组（produce/plan/operate） */
  scene?: string
  /** 展示元数据：推荐下游模板 key 列表 */
  next?: string[]
  /** 轻松创作批准链专用（easy-*）：选择器应过滤掉，展示反查方忽略（服务端 isCreationTemplate 真源注入） */
  conversationOnly?: boolean
  /** [内置保护] 系统出厂内置模板：用户只读，不可修改/删除（服务端 isBuiltinTemplate 真源注入）；前端据此锁定编辑/删除 */
  builtin?: boolean
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
  /** [内置保护] 系统出厂内置提示词：用户只读，不可修改/删除（服务端 isBuiltinPrompt 真源注入） */
  builtin?: boolean
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

// ===== 设计态编辑补丁（POST /templates/:key/edit-draft · edit-save 契约） =====

/** 单步骤编辑（对齐服务端 applyTemplateEdits 白名单；after null = 回落缺省语义，数组 = 显式） */
export interface TemplateEditStep {
  key: string
  after?: string[] | null
  title?: string
  texts?: Record<string, string>
}

export interface TemplateEdits {
  steps: TemplateEditStep[]
}
