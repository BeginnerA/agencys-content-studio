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

/** 输入/模板非法（路由层转 400；与 HttpError 解耦，services 不依赖路由层） */
export class InvalidRunInputError extends Error {
  constructor(readonly code: 'bad_input' | 'bad_template', message: string) {
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

/** 归一化 + 校验（口径与 M1 runs.ts 完全一致；validateRunInput 内部含 defaults 应用） */
export function prepareRunInput(template: Template, input: Record<string, unknown>): Record<string, unknown> {
  const norm = normalizeInput(template.inputs, input)
  try {
    validateRunInput(template, norm)
  } catch (err) {
    throw new InvalidRunInputError('bad_input', (err as Error).message)
  }
  return norm
}

/** 建 run 行（queued；不启动执行）——runs.ts 与 batch.ts 共用 */
export async function createRunRow(p: {
  projectId: number
  templateKey: string
  input: Record<string, unknown>
  batchId?: number | null
  batchSeq?: number | null
}): Promise<PipelineRun> {
  const template = loadTemplateOrThrow(p.templateKey)
  const norm = prepareRunInput(template, p.input)
  const t = Date.now()
  const row = await db
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
    } else {
      out[def.key] = typeof v === 'string' ? v : JSON.stringify(v)
    }
  }
  return out
}
