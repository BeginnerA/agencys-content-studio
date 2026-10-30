/**
 * run 创建共享链路（runs.ts 单发与 batch.ts 批量共用）
 * - 归一化/校验口径与 runs.ts 完全一致（normalizeInput 逐字迁入）
 * - 错误类型与 HttpError 解耦：路由层转 400（services 不依赖路由层）
 * - M70 连续性闸门：原始两键先判不支持 → 归一化 → 批准/槽位一致性 →
 *   批准句柄校验 + 目标比对 → 幂等复用 → 插 queued + CAS 认领（同一事务，失败整体回滚）
 */
import { desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { creationSessions, pipelineRuns, type PipelineRun } from '../db/schema'
import { loadTemplate } from '../pipeline/loader'
import { validateRunInput } from '../pipeline/refs'
import type { Template, TemplateInputDef } from '../pipeline/types'
import { isValidDateInput } from '../pipeline/types'
import { isCreationTemplate } from './creation-chat/recipe'
import { SUBTITLE_EDITS_KEY } from './rework/ledger'
import { RunParamsError, normalizeRunParamsOrThrow, type RunParams } from './run-params'
import { ContinuityError, type Approval, type ContextDoc, type Executor } from './continuity/contract'
import { assertRawContinuityIntent, claimContext, findBoundRun, verifyClaimTarget } from './continuity/run-binding'
import { effectiveInput } from './continuity/targets'
import { canonicalHash } from './continuity/fold'
import { documentTransaction } from './continuity/store'

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
 * 归一化 + 校验（口径与 runs.ts 完全一致；validateRunInput 内部含 defaults 应用）。
 * 集级参数覆盖：input._params（内部键）先校验后附回快照（normalizeInput 仅保留模板声明键）。
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

export interface CreateRunParams {
  projectId: number
  templateKey: string
  input: Record<string, unknown>
  batchId?: number | null
  batchSeq?: number | null
  workflowId?: number | null
  workflowSeq?: number | null
  /** 断点续跑派生自哪个源 run（NULL = 非续跑）；对话式「恢复制作」retryCreation 传入，令运行列表可折叠续跑链 */
  resumedFromRunId?: number | null
  /** 仅会话确认服务传入；普通 run/batch/workflow 不得启动批准模板。 */
  creationSessionId?: number
  /** 运行链种类显式标记：'easy'=轻松创作批准链，'route'=对话调度执行；缺省 NULL（非对话来源，执行层回退旧的可见性判定）。 */
  chainKind?: 'easy' | 'route' | null
  /** 已冻结承接包批准（M70）：启用跨集剧情连续性时必传，且与 input 槽位严格一致。 */
  continuityApproval?: Approval
}

/**
 * 建 run 行（queued；不启动执行）——runs.ts 与 batch.ts 共用。
 * 连续性启用时走 documentTransaction（无外层事务则自包一层的 BUSY 重试事务）：
 * 复用既有 bound run 幂等返回；新建失败（并发认领输家）随事务回滚，不留孤儿 run。
 */
export async function createRunRow(p: CreateRunParams, executor: Executor = db): Promise<PipelineRun> {
  if (isCreationTemplate(p.templateKey) && !p.creationSessionId) throw new InvalidRunInputError('bad_input', '请从轻松创作确认方案后启动制作')
  const template = loadTemplateOrThrow(p.templateKey)
  // 原始两键闸（normalize 前先判不支持，不许静默丢键当「关闭」）；拒绝统一按 bad_input 呈现
  try {
    assertRawContinuityIntent(template, p.input)
  } catch (err) {
    if (err instanceof ContinuityError) {
      throw new InvalidRunInputError('bad_input', `连续性输入被拒绝（${err.message}）：请核对 with_continuity / continuity_context 与模板声明`)
    }
    throw err
  }
  const norm = prepareRunInput(template, p.input)
  const approval = p.continuityApproval
  const enabled = norm['with_continuity'] === true
  if (approval && !enabled) throw new InvalidRunInputError('bad_input', '携带剧情承接包批准但未启用 with_continuity（不允许静默降级为普通运行）')
  if (enabled && !approval) throw new InvalidRunInputError('bad_input', '启用跨集剧情连续性必须携带已冻结承接包的批准（continuityApproval）')
  if (enabled) {
    const slot = norm['continuity_context']
    if (!Array.isArray(slot) || slot.length !== 1 || slot[0] !== approval!.document.assetId) {
      throw new InvalidRunInputError('bad_input', 'continuity_context 槽位必须恰为批准包资产（单元素数组且与批准一致）')
    }
    const flow = (ex: Executor): Promise<PipelineRun> => createContinuityRun(ex, p, template, norm, approval!)
    return executor === db ? documentTransaction(flow) : flow(executor)
  }
  return insertRun(executor, p, template, norm)
}

/**
 * 连续性建 run 主体（brief 6.3 skeleton）：全部读取/写入使用同一 ex；
 * 已绑定结果按目标与入口归属逐项比较后复用或拒绝，绝不偷复用另一入口的 run。
 */
async function createContinuityRun(ex: Executor, p: CreateRunParams, template: Template,
    norm: Record<string, unknown>, approval: Approval): Promise<PipelineRun> {
  const doc = await verifyClaimTarget(ex, p.projectId, p.templateKey, approval, norm)
  const existing = await findBoundRun(ex, approval, doc.target)
  if (existing) {
    const reusable = await reusableBoundRun(ex, existing, p, template, doc)
    if (reusable) return reusable
    // 相同正文但不同入口归属（batch/workflow/session/续跑不一致）不得复用
    throw new ContinuityError('continuity_context_claimed', 409)
  }
  const run = await insertRun(ex, p, template, norm)
  await claimContext(ex, approval, run)
  return run
}

/** 既有 bound run 复用裁决：模板/输入一致 + 入口归属一致 → 复用；正文漂移 → changed(409)；归属漂移 → claimed(409)。 */
async function reusableBoundRun(ex: Executor, existing: PipelineRun, p: CreateRunParams,
    template: Template, doc: ContextDoc): Promise<PipelineRun | null> {
  let inputOk: boolean
  try {
    inputOk = existing.templateKey === doc.target.templateKey
      && canonicalHash(effectiveInput(template, doc.target.unit, JSON.parse(existing.input))) === doc.target.inputHash
  } catch {
    inputOk = false
  }
  if (!inputOk) throw new ContinuityError('continuity_context_changed', 409)
  // pipeline_runs 无 creation_session_id 列：经 creation_sessions.run_id 反查最新归属比对
  const [session] = await ex.select({ id: creationSessions.id }).from(creationSessions)
    .where(eq(creationSessions.runId, existing.id)).orderBy(desc(creationSessions.id)).limit(1)
  const attributionOk = existing.batchId === (p.batchId ?? null)
    && existing.batchSeq === (p.batchSeq ?? null)
    && existing.workflowId === (p.workflowId ?? null)
    && existing.workflowSeq === (p.workflowSeq ?? null)
    && existing.resumedFromRunId === (p.resumedFromRunId ?? null)
    && (session?.id ?? null) === (p.creationSessionId ?? null)
  return attributionOk ? existing : null
}

/** 插入 run 行（queued；模板快照固化）；不启动执行。 */
async function insertRun(ex: Executor, p: CreateRunParams, template: Template, norm: Record<string, unknown>): Promise<PipelineRun> {
  const t = Date.now()
  const row = await ex
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
      // 编排链归属（NULL = 非编排 run）
      workflowId: p.workflowId ?? null,
      workflowSeq: p.workflowSeq ?? null,
      // 续跑来源（NULL = 非续跑派生）：与 /runs/:id/resume 路由同口径，供运行列表折叠续跑链
      resumedFromRunId: p.resumedFromRunId ?? null,
      // 运行链种类显式标记（执行/投影层据此判模式，不靠模板名反推）
      chainKind: p.chainKind ?? null,
      createdAt: t,
      updatedAt: t,
    })
    .returning()
  return row[0]!
}

/**
 * 断点续跑派生新 run 时剥除字幕修订指针（precision-rework 规格 §6.2：不得盲目跨 run 复制
 * _subtitleEdits；新 run 无成片基准，需重新基准确认）。源 run 指针保留为历史，不删除。
 * 解析失败/无该键 → 原样返回（不改变既有续跑语义）。retryCreation 无需此函数：
 * 其经 createRunRow→prepareRunInput→normalizeInput 只保留模板声明键与 _params，内部指针键天然不随行（_compose 在建好后显式克隆）。
 */
export function stripResumeSubtitleEdits(inputJson: string): string {
  try {
    const o = JSON.parse(inputJson) as Record<string, unknown>
    if (!o || typeof o !== 'object' || o[SUBTITLE_EDITS_KEY] === undefined) return inputJson
    delete o[SUBTITLE_EDITS_KEY]
    return JSON.stringify(o)
  } catch {
    return inputJson
  }
}

/** 按模板 inputs 声明归一化：int/float 转 number、bool 转 boolean、files 保持 id 数组、multi_select 收敛字符串数组、text/select/date 收 string */
function normalizeInput(defs: TemplateInputDef[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of defs) {
    const v = raw[def.key]
    if (v === undefined || v === null || v === '') continue
    if (def.kind === 'int') {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isInteger(n)) throw new InvalidRunInputError('bad_input', `input.${def.key} 需为整数`)
      out[def.key] = n
    } else if (def.kind === 'float') {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n)) throw new InvalidRunInputError('bad_input', `input.${def.key} 需为数字`)
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
      // 发布记录选择器：保持为正整数 publication id 数组（与 files 同处理，但不做资产归属校验）
      const ids = Array.isArray(v) ? v.map(Number) : [Number(v)]
      if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
        throw new InvalidRunInputError('bad_input', `input.${def.key} 需为发布记录 id 数组`)
      }
      out[def.key] = ids
    } else if (def.kind === 'multi_select') {
      // 候选项多选：数组直取；兼容批量 JSON 粘贴/排产表单的逗号分隔字符串写法
      const opts = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，]/) : null)
      if (!opts) throw new InvalidRunInputError('bad_input', `input.${def.key} 需为选项字符串数组`)
      out[def.key] = opts.map((s) => String(s).trim()).filter(Boolean)
    } else if (def.kind === 'date') {
      const s = typeof v === 'string' ? v.trim() : String(v)
      if (!isValidDateInput(s)) throw new InvalidRunInputError('bad_input', `input.${def.key} 需为日期（YYYY-MM-DD）`)
      out[def.key] = s
    } else {
      out[def.key] = typeof v === 'string' ? v : JSON.stringify(v)
    }
  }
  return out
}
