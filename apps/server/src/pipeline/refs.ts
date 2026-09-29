import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, pipelineSteps } from '../db/schema'
import type { Template } from './types'
import { RefResolveError, isValidDateInput } from './types'

/**
 * 引用解析器（spec §5.2，engine 内置 ~100 行）。
 * 支持四种形态：
 *   input.<key>                        → run.input 对应键（原样透传）
 *   steps.<key>.asset(s)               → 上游 step 产物资产 id（.asset=首个 / .assets=全量；
 *                                     上游终态但零产物/被跳过时解析为 []）
 *   assets purpose=<purpose>           → 项目内该 purpose 资产 id（updated_at 升序）
 *   模板串内插 {input.x} / {x:03d}     → 替换为 run.input 值（format 可选 pad）
 */

export interface RefContext {
  projectId: number
  runInput: Record<string, unknown>
  /** 已成功步骤 key → 产物资产 id（按序） */
  stepOutputs: Map<string, number[]>
}

const FULL_REF = /^(input\.[\w-]+|steps\.[\w-]+\.(?:asset|assets)|assets purpose=[\w-]+)$/

/** 是否为「整串引用」（非普通文本） */
export function isRefString(v: unknown): v is string {
  return typeof v === 'string' && FULL_REF.test(v)
}

/** 解析单值：引用串 → 目标值；其余原样（数组/对象递归处理元素） */
export async function resolveValue(v: unknown, ctx: RefContext): Promise<unknown> {
  if (typeof v === 'string') {
    if (FULL_REF.test(v)) return resolveRefString(v, ctx)
    return v
  }
  if (Array.isArray(v)) {
    const out: unknown[] = []
    for (const item of v) out.push(await resolveValue(item, ctx))
    return out
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = await resolveValue(val, ctx)
    return out
  }
  return v
}

async function resolveRefString(ref: string, ctx: RefContext): Promise<unknown> {
  const inputM = /^input\.([\w-]+)$/.exec(ref)
  if (inputM) {
    const key = inputM[1]!
    // 选填输入未提供（必填缺失已由 validateRunInput 拦截）：宽容 undefined，下游 action 自行跳过
    // （与 steps 空产物宽容 [] 同哲学；interpolate 内插仍对缺失抛错，防残缺文件名/提示词）
    if (!(key in ctx.runInput)) return undefined
    return ctx.runInput[key]
  }
  const stepsM = /^steps\.([\w-]+)\.(asset|assets)$/.exec(ref)
  if (stepsM) {
    const stepKey = stepsM[1]!
    const ids = ctx.stepOutputs.get(stepKey)
    if (!ids) {
      throw new RefResolveError(ref, `上游步骤 ${stepKey} 尚未成功（无产物）`)
    }
    // 终态但零产物（when 分支跳过/空结果）：引用端宽容为 []，由下游 action 校验
    // （互斥分支模板如 compose 双字段 images/motion_clips 依赖此语义取非空分支）
    if (ids.length === 0) return []
    if (stepsM[2] === 'asset') {
      return [ids[0]!] // 下游以数组统一消费；.asset 语义=取首个
    }
    return ids
  }
  const purposeM = /^assets purpose=([\w-]+)$/.exec(ref)
  if (purposeM) {
    const purpose = purposeM[1]!
    const rows = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.projectId, ctx.projectId), eq(assets.purpose, purpose), isNull(assets.deletedAt)))
      .orderBy(asc(assets.updatedAt))
    return rows.map((r) => r.id)
  }
  throw new RefResolveError(ref, '无法识别的引用形态')
}

/** 整组 inputs 解析（action 执行前由 engine 调用） */
export async function resolveInputs(
  inputs: Record<string, unknown>,
  ctx: RefContext,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inputs)) out[k] = await resolveValue(v, ctx)
  return out
}

/**
 * 正整数资产 id 归一（纯函数）：递归展开嵌套数组 → 整数 >0 过滤 → 保序去重。
 * 用途：literal inputs.refs/first_frame（解析结果含 input.x 原样数组与 steps.x.asset 数组的嵌套）
 * 与 ai-video 直通参考合并（shot.ref_asset_ids）。
 */
export function normalizePositiveIds(raw: unknown): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const walk = (x: unknown): void => {
    if (typeof x === 'number' && Number.isInteger(x) && x > 0) {
      if (!seen.has(x)) {
        seen.add(x)
        out.push(x)
      }
    } else if (Array.isArray(x)) {
      for (const it of x) walk(it)
    }
  }
  walk(raw)
  return out
}

const INTERP = /\{((?:input\.)?[\w-]+)(?::(0\d+)d)?\}/g

/**
 * 模板串内插：{input.episode_number} 或 {episode_number:03d}。
 * 值缺失 → 抛错（防止文件名/提示词带残缺占位）。
 */
export function interpolate(tpl: string, runInput: Record<string, unknown>): string {
  return tpl.replace(INTERP, (whole, keyRaw: string, padRaw?: string) => {
    const key = keyRaw.replace(/^input\./, '')
    const v = runInput[key]
    if (v === undefined || v === null) {
      throw new RefResolveError(whole, `run.input 无键 ${key}，无法内插`)
    }
    const s = String(v)
    if (padRaw) return s.padStart(Number(padRaw), '0')
    return s
  })
}

// ---------- when 条件表达式（spec §3.3 最小集） ----------

export type WhenOp =
  | { t: 'const'; v: boolean }
  | { t: 'input_exists'; key: string; neg: boolean }
  | { t: 'input_cmp'; key: string; op: '==' | '!='; lit: string | number | boolean }
  | { t: 'step_count'; key: string; op: '==' | '!=' | '>=' | '<=' | '>' | '<'; n: number }

export interface WhenContext {
  runInput: Record<string, unknown>
  /** 已终态步骤产物（succeeded/skipped）；未收录步骤视为空 → count 0 */
  stepOutputs: Map<string, number[]>
}

/** 单条 when 表达式 → 操作结构（解析失败抛错含原文） */
export function parseWhenExpr(exprRaw: string): WhenOp {
  const expr = exprRaw.trim()
  if (expr === 'true') return { t: 'const', v: true }
  if (expr === 'false') return { t: 'const', v: false }
  let m = /^input\.([\w-]+)\s+(exists|empty)$/.exec(expr)
  if (m) return { t: 'input_exists', key: m[1]!, neg: m[2] === 'empty' }
  m = /^input\.([\w-]+)\s*(==|!=)\s*(\S+)$/.exec(expr)
  if (m) {
    return { t: 'input_cmp', key: m[1]!, op: m[2] as '==' | '!=', lit: parseWhenLiteral(m[3]!) }
  }
  m = /^steps\.([\w-]+)\.count\s*(==|!=|>=|<=|>|<)\s*(\d+)$/.exec(expr)
  if (m) {
    const op = m[2] as '==' | '!=' | '>=' | '<=' | '>' | '<'
    return { t: 'step_count', key: m[1]!, op, n: Number(m[3]!) }
  }
  throw new Error(`无法识别的 when 表达式「${exprRaw}」（支持 input.x exists/empty/==/!=、steps.x.count 比较、true/false）`)
}

function parseWhenLiteral(s: string): string | number | boolean {
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (/^[\w-]+$/.test(s)) return s
  throw new Error(`when 字面量「${s}」非法（支持 数字/true/false/裸词）`)
}

/** 单条操作求值（ctx 缺键的 input 视为空、缺步骤视为 0） */
export function evalWhenOp(op: WhenOp, ctx: WhenContext): boolean {
  switch (op.t) {
    case 'const':
      return op.v
    case 'input_exists': {
      const v = ctx.runInput[op.key]
      const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
      return op.neg ? empty : !empty
    }
    case 'input_cmp': {
      const eq = ctx.runInput[op.key] === op.lit
      return op.op === '==' ? eq : !eq
    }
    case 'step_count': {
      const count = ctx.stepOutputs.get(op.key)?.length ?? 0
      switch (op.op) {
        case '==': return count === op.n
        case '!=': return count !== op.n
        case '>=': return count >= op.n
        case '<=': return count <= op.n
        case '>': return count > op.n
        case '<': return count < op.n
        default: return false
      }
    }
    default:
      return false
  }
}

/**
 * when（数组=AND）与 when_any（OR 组）联合求值：when 全满足 且 when_any 任一满足。
 * 未提供条件 → true。
 */
export function evaluateWhen(
  when: string | string[] | undefined,
  whenAny: string[] | undefined,
  ctx: WhenContext,
): boolean {
  const andExprs = when === undefined ? [] : Array.isArray(when) ? when : [when]
  const orExprs = whenAny ?? []
  if (andExprs.length === 0 && orExprs.length === 0) return true
  for (const raw of andExprs) {
    if (!evalWhenOp(parseWhenExpr(raw), ctx)) return false
  }
  if (orExprs.length === 0) return true
  return orExprs.some((raw) => evalWhenOp(parseWhenExpr(raw), ctx))
}

/** loader 静态校验用：提取单条表达式引用的 input 键 / 步骤键 */
export function whenRefs(op: WhenOp): { inputKey?: string; stepKey?: string } {
  if (op.t === 'input_exists' || op.t === 'input_cmp') return { inputKey: op.key }
  if (op.t === 'step_count') return { stepKey: op.key }
  return {}
}

/** 收集 run 已终态步骤的产物（engine 每步执行前调用；succeeded/skipped 均收录，skipped 记空数组） */
export async function loadStepOutputs(runId: number): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>()
  const rows = await db
    .select({ key: pipelineSteps.stepKey, output: pipelineSteps.output })
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, runId), inArray(pipelineSteps.status, ['succeeded', 'skipped'])))
    .orderBy(asc(pipelineSteps.seq))
  for (const r of rows) {
    if (!r.output) {
      // skipped 无 output 也入 map（引用解析为空数组而非「未成功」）
      if (!map.has(r.key)) map.set(r.key, [])
      continue
    }
    try {
      const parsed = JSON.parse(r.output) as { asset_ids?: number[] }
      if (Array.isArray(parsed.asset_ids)) map.set(r.key, parsed.asset_ids)
      else if (!map.has(r.key)) map.set(r.key, [])
    } catch {
      if (!map.has(r.key)) map.set(r.key, [])
    }
  }
  return map
}

/** 启动输入归一：模板 default 在用户未传时回填（就地修改 input；落库前完成） */
export function applyInputDefaults(tpl: Template, input: Record<string, unknown>): void {
  for (const def of tpl.inputs) {
    if (def.default === undefined) continue
    const v = input[def.key]
    if (v === undefined || v === null || v === '') input[def.key] = def.default
  }
}

/** 校验启动输入满足模板 inputs 声明（run 启动前调用，抛错含模板约束） */
export function validateRunInput(tpl: Template, input: Record<string, unknown>): void {
  applyInputDefaults(tpl, input)
  for (const def of tpl.inputs) {
    const v = input[def.key]
    if (v === undefined || v === null || v === '') {
      if (def.required) throw new Error(`输入「${def.label ?? def.key}」为必填`)
      continue
    }
    if (def.kind === 'int' && !Number.isInteger(v)) {
      throw new Error(`输入「${def.label ?? def.key}」需为整数`)
    }
    if (def.kind === 'float' && !(typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`输入「${def.label ?? def.key}」需为数字`)
    }
    if (def.kind === 'bool' && typeof v !== 'boolean') {
      throw new Error(`输入「${def.label ?? def.key}」需为布尔（true/false）`)
    }
    if (def.kind === 'date' && !isValidDateInput(v)) {
      throw new Error(`输入「${def.label ?? def.key}」需为日期（YYYY-MM-DD）`)
    }
    // 候选项收敛（fail-fast 不 clamp）：非 options 内的值属非法输入，与 int/bool 同口径拒绝
    if (def.kind === 'select' && (typeof v !== 'string' || !def.options?.includes(v))) {
      throw new Error(`输入「${def.label ?? def.key}」取值需在候选项内（${def.options?.join(' / ')}）`)
    }
    if (def.kind === 'multi_select' && (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && def.options?.includes(x)))) {
      throw new Error(`输入「${def.label ?? def.key}」需为候选项数组（可选：${def.options?.join(' / ')}）`)
    }
  }
  // 防未知键注入
  const allowed = new Set(tpl.inputs.map((i) => i.key))
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) throw new Error(`未知输入键 ${k}（模板允许: ${[...allowed].join(', ')}）`)
  }
}

/** 资产 id 数组合法性：全部属于该项目且存在 → 原样；否则抛错 */
export async function assertProjectAssets(
  projectId: number,
  ids: unknown[],
  what: string,
): Promise<number[]> {
  const nums = ids.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new RefResolveError(what, '包含非法资产 id')
  }
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(inArray(assets.id, nums), eq(assets.projectId, projectId), isNull(assets.deletedAt)))
  const found = new Set(rows.map((r) => r.id))
  const missing = nums.filter((n) => !found.has(n))
  if (missing.length > 0) {
    throw new RefResolveError(what, `资产不存在或不属于本项目: ${missing.join(', ')}`)
  }
  return nums
}