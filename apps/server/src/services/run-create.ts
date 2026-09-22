/**
 * [M4] run 创建共享链路（runs.ts 单发与 batch.ts 批量共用）
 * - 归一化/校验口径与 M1 runs.ts 完全一致（normalizeInput 逐字迁入）
 * - 错误类型与 HttpError 解耦：路由层转 400（services 不依赖路由层）
 */
import { db } from '../db'
import { pipelineRuns, type PipelineRun } from '../db/schema'
import { loadTemplate } from '../pipeline/loader'
import { validateRunInput } from '../pipeline/refs'
import type { Template, TemplateInputDef } from '../pipeline/types'
import { isCreationTemplate } from './creation-chat/recipe'
import { RunParamsError, normalizeRunParamsOrThrow, type RunParams } from './run-params'

/** 输入/模板非法（路由层转 400；与 HttpError 解耦，services 不依赖路由层） */
export class InvalidRunInputError extends Error {
  constructor(readonly code: 'bad_input' | 'bad_template' | 'bad_params', message: string) {
    super(message)
    this.name = 'InvalidRunInputError'
  }
}

export function loadTemplateOrThrow(templateKey: string): Template {
  try {
    return loadTemplate(templateKey)
  } catch (err) {
    throw new InvalidRunInputError('bad_template', (err as Error).message)
  }
}

/**
 * 归一化 + 校验（口径与 M1 runs.ts 完全一致；validateRunInput 内部含 defaults 应用）。
 * [M14] 集级参数覆盖：input._params（内部键）先校验后附回快照（normalizeInput 仅保留模板声明键）。
 */
export function prepareRunInput(template: Template, input: Record<string, unknown>): Record<string, unknown> {
  let params: RunParams
  try {
    params = normalizeRunParamsOrThrow(input['_params'])
  } catch (err) {
    if (err instanceof RunParamsError) throw new InvalidRunInputError('bad_params', err.message)
    throw err
  }
  const norm = normalizeInput(template.inputs, input)
  try {
    validateRunInput(template, norm)
  } catch (err) {
    throw new InvalidRunInputError('bad_input', (err as Error).message)
  }
  if (Object.keys(params).length > 0) norm['_params'] = params
  return norm
}

/** 建 run 行（queued；不启动执行）——runs.ts 与 batch.ts 共用 */
export async function createRunRow(p: {
  projectId: number
  templateKey: string
  input: Record<string, unknown>
  batchId?: number | null
  batchSeq?: number | null
  workflowId?: number | null
  workflowSeq?: number | null
  /** 仅会话确认服务传入；普通 run/batch/workflow 不得启动批准模板。 */
  creationSessionId?: number
}, executor: Pick<typeof db, 'insert'> = db): Promise<PipelineRun> {
  if (isCreationTemplate(p.templateKey) && !p.creationSessionId) throw new InvalidRunInputError('bad_input', '请从轻松创作确认方案后启动制作')
  const template = loadTemplateOrThrow(p.templateKey)
  const norm = prepareRunInput(template, p.input)
  const t = Date.now()
  const row = await executor
    .insert(pipelineRuns)
    .values({
      projectId: p.projectId,
      templateKey: p.templateKey,
      status: 'queued',
      input: JSON.stringify(norm),
      // 模板快照：run 创建时固化（引擎/续跑/审阅一律读快照，模板改动不影响运行中 run）
      templateSnapshot: JSON.stringify(template),
      batchId: p.batchId ?? null,
      batchSeq: p.batchSeq ?? null,
      // [M27] 编排链归属（NULL = 非编排 run）
      workflowId: p.workflowId ?? null,
      workflowSeq: p.workflowSeq ?? null,
      createdAt: t,
      updatedAt: t,
    })
    .returning()
  return row[0]!
}

/** 按模板 inputs 声明归一化：int 转 number、bool 转 boolean、files 保持 id 数组、text 收 string */
function normalizeInput(defs: TemplateInputDef[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of defs) {
    const v = raw[def.key]
    if (v === undefined || v === null || v === '') continue
    if (def.kind === 'int') {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isInteger(n)) throw new InvalidRunInputError('bad_input', `input.${def.key} 需为整数`)
      out[def.key] = n
    } else if (def.kind === 'bool') {
      if (typeof v === 'boolean') out[def.key] = v
      else if (v === 'true' || v === 1 || v === '1') out[def.key] = true
      else if (v === 'false' || v === 0 || v === '0') out[def.key] = false
      else throw new InvalidRunInputError('bad_input', `input.${def.key} 需为布尔（true/false）`)
    } else if (def.kind === 'files') {
      const ids = Array.isArray(v) ? v.map(Number) : [Number(v)]
      if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
        throw new InvalidRunInputError('bad_input', `input.${def.key} 需为资产 id 数组`)
      }
      out[def.key] = ids
    } else if (def.kind === 'publications') {
      // [整改] 发布记录选择器：保持为正整数 publication id 数组（与 files 同处理，但不做资产归属校验）
      const ids = Array.isArray(v) ? v.map(Number) : [Number(v)]
      if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
        throw new InvalidRunInputError('bad_input', `input.${def.key} 需为发布记录 id 数组`)
      }
      out[def.key] = ids
    } else {
      out[def.key] = typeof v === 'string' ? v : JSON.stringify(v)
    }
  }
  return out
}
