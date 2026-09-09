import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, pipelineSteps } from '../db/schema'
import type { Template } from './types'
import { RefResolveError } from './types'

/**
 * 引用解析器（spec §5.2，engine 内置 ~100 行）。
 * 支持四种形态：
 *   input.<key>                        → run.input 对应键（原样透传）
 *   steps.<key>.asset(s)               → 上游 step 产物资产 id（.asset=首个 / .assets=全量）
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
    if (!(key in ctx.runInput)) {
      throw new RefResolveError(ref, `run.input 无键 ${key}`)
    }
    return ctx.runInput[key]
  }
  const stepsM = /^steps\.([\w-]+)\.(asset|assets)$/.exec(ref)
  if (stepsM) {
    const stepKey = stepsM[1]!
    const ids = ctx.stepOutputs.get(stepKey)
    if (!ids) {
      throw new RefResolveError(ref, `上游步骤 ${stepKey} 尚未成功（无产物）`)
    }
    if (ids.length === 0) {
      throw new RefResolveError(ref, `上游步骤 ${stepKey} 产物为空`)
    }
    if (stepsM[2] === 'asset') {
      const first = ids[0]
      if (!first) throw new RefResolveError(ref, `上游步骤 ${stepKey} 产物为空`)
      return [first] // 下游以数组统一消费；.asset 语义=取首个
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

/** 收集 run 已成功步骤的产物（engine 每步执行前调用） */
export async function loadStepOutputs(runId: number): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>()
  const rows = await db
    .select({ key: pipelineSteps.stepKey, output: pipelineSteps.output })
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.status, 'succeeded')))
    .orderBy(asc(pipelineSteps.seq))
  for (const r of rows) {
    if (!r.output) continue
    try {
      const parsed = JSON.parse(r.output) as { asset_ids?: number[] }
      if (Array.isArray(parsed.asset_ids)) map.set(r.key, parsed.asset_ids)
    } catch {
      // 输出损坏时忽略（引用该步骤会得到空）
    }
  }
  return map
}

/** 校验启动输入满足模板 inputs 声明（run 启动前调用，抛错含模板约束） */
export function validateRunInput(tpl: Template, input: Record<string, unknown>): void {
  for (const def of tpl.inputs) {
    const v = input[def.key]
    if (v === undefined || v === null || v === '') {
      if (def.required) throw new Error(`输入「${def.label ?? def.key}」为必填`)
      continue
    }
    if (def.kind === 'int' && !Number.isInteger(v)) {
      throw new Error(`输入「${def.label ?? def.key}」需为整数`)
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