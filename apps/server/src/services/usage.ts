/**
 * M4 用量记录与定价服务（spec §4.3）
 * - 定价口径：settings.pricing JSON；四级查找 {provider}:{model} → {provider}:* → {provider} → {model}；
 *   基数 tokens=1e6、char=1e3、image/second=1。
 * - 快照语义：写入时定价并落列，后续改价只影响新记录。
 * - 纪律：成本记录绝不阻断流水线（recordUsage 异常仅 log.warn）。
 */
import { and, asc, desc, eq, gte, inArray, lte, sql, sum, type SQL } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs, pipelineRuns, settings, usageRecords } from '../db/schema'
import { createLogger } from '../logger'
import type { LlmUsage } from './llm'
import type { UsageUnit } from '@agencys/ai-provider-kit'

const log = createLogger('usage')

export type UsageKind = 'llm' | 'image' | 'video' | 'tts' | 'asr'
// 计价单位唯一事实源已上收至 kit（pricing-capabilities）；此处透传保持既有引用点零改动
export type { UsageUnit }
export type UsageGroupBy = 'kind' | 'provider' | 'model' | 'provider_model' | 'unit' | 'day' | 'project' | 'run'

export interface UsageInput {
  projectId: number
  runId?: number | null
  stepId?: number | null
  taskId?: number | null
  assetId?: number | null
  kind: UsageKind
  provider?: string | null
  model?: string | null
  quantity: number
  unit: UsageUnit
  meta?: Record<string, unknown>
  /** 已批准实例价格快照；null 明确表示未计价。 */
  unitPrice?: number | null
}

export interface UsageSummaryItem {
  key: string
  quantity: number
  cost: number
  unpriced: number
  count: number
}

export interface UsageSummaryResult {
  items: UsageSummaryItem[]
  totals: { quantity: number; cost: number; unpriced: number }
}

/** 配置基数：每「1 个计价单位」对应的原始数量 */
export function unitBase(unit: UsageUnit): number {
  if (unit === 'tokens_in' || unit === 'tokens_out') return 1_000_000
  if (unit === 'char') return 1_000
  return 1
}

/** 读取 settings.pricing（缺失/损坏 → {}） */
async function loadPricing(): Promise<Record<string, unknown>> {
  try {
    const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'pricing')).limit(1)
    const raw = rows[0]?.value
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch (e) {
    log.warn(`pricing 读取失败（按未计价处理）：${String(e)}`)
    return {}
  }
}

/**
 * 定价查找（返回元/单位，已含基数换算）
 * 四级：{provider}:{model} → {provider}:* → {provider} → {model}；未命中 null
 */
export function priceOf(
  pricing: Record<string, unknown>,
  kind: UsageKind,
  provider: string | null | undefined,
  model: string | null | undefined,
  unit: UsageUnit,
): number | null {
  const byKind = pricing[kind]
  if (typeof byKind !== 'object' || byKind === null) return null
  const table = byKind as Record<string, unknown>
  const candidates: Array<string | null> = [
    provider && model ? `${provider}:${model}` : null,
    provider ? `${provider}:*` : null,
    provider ?? null,
    model ?? null,
  ]
  for (const key of candidates) {
    if (!key) continue
    const entry = table[key]
    if (typeof entry !== 'object' || entry === null) continue
    const value = (entry as Record<string, unknown>)[unit]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value / unitBase(unit)
  }
  return null
}

/**
 * [M18] 定价解析（返回元/单位，已含基数换算）：实例级 apiConfigs.pricing → 全局 settings.pricing → null。
 * recordUsage（写入快照）与 run-preview（成本预估）共用，保证两条链路口径零漂移。
 */
export async function resolveUnitPrice(q: {
  configId?: number
  kind: UsageKind
  provider?: string | null
  model?: string | null
  unit: UsageUnit
}): Promise<number | null> {
  let unitPrice: number | null = null
  // 1) 实例级定价：按 providerKey + model 查找匹配的活跃实例
  if (q.provider && (q.kind !== 'asr' || q.configId)) {
    const cfgRows = await db
      .select({ pricing: apiConfigs.pricing })
      .from(apiConfigs)
      .where(and(
        eq(apiConfigs.providerKey, q.provider),
        eq(apiConfigs.isActive, 1),
        ...(q.configId ? [eq(apiConfigs.id, q.configId)] : []),
        ...(q.kind === 'asr' ? [eq(apiConfigs.serviceType, 'audio')] : q.model ? [eq(apiConfigs.model, q.model)] : []),
      ))
      .orderBy(desc(apiConfigs.isDefault), asc(apiConfigs.priority))
      .limit(1)
    if (cfgRows[0]?.pricing) {
      try {
        const instPricing = JSON.parse(cfgRows[0].pricing) as Record<string, unknown>
        // ASR 与宿主 TTS 共享实例但不共享单价，必须显式绑定实际转写模型。
        const asr = instPricing.asr as Record<string, unknown> | undefined
        const val = q.kind === 'asr'
          ? asr && asr.model === q.model && q.unit === 'second' ? asr.second : undefined
          : instPricing[q.unit]
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
          unitPrice = val / unitBase(q.unit)
        }
      } catch { /* pricing JSON 损坏，跳过 */ }
    }
  }
  // 2) 全局定价兜底
  if (unitPrice === null) {
    const pricing = await loadPricing()
    unitPrice = priceOf(pricing, q.kind, q.provider, q.model, q.unit)
  }
  return unitPrice
}

/** 记录一条用量（写入时定价快照；异常仅 log.warn，不抛） */
export async function recordUsage(input: UsageInput): Promise<void> {
  try {
    // 定价查找优先级：实例级 pricing → 全局 settings.pricing → null（[M18] 抽取 resolveUnitPrice 与 run-preview 共用）
    const unitPrice = input.unitPrice !== undefined ? input.unitPrice : await resolveUnitPrice({
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      unit: input.unit,
    })
    const cost = unitPrice === null ? null : Math.round(input.quantity * unitPrice * 1e6) / 1e6
    await db.insert(usageRecords).values({
      projectId: input.projectId,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      taskId: input.taskId ?? null,
      assetId: input.assetId ?? null,
      kind: input.kind,
      provider: input.provider ?? null,
      model: input.model ?? null,
      quantity: input.quantity,
      unit: input.unit,
      unitPrice,
      cost,
      currency: 'CNY',
      meta: JSON.stringify(input.meta ?? {}),
      createdAt: Date.now(),
    })
  } catch (e) {
    log.warn(`用量记录失败（不影响流水线）：${String(e)}`)
  }
}

/** LLM 用量落库（usage 为空或 total=0 → 不写；否则 tokens_in/out 两行） */
export async function recordLlmUsage(p: {
  projectId: number
  runId?: number | null
  stepId?: number | null
  provider: string
  model: string
  usage: LlmUsage | null
}): Promise<void> {
  if (!p.usage || p.usage.totalTokens === 0) return
  const meta = { total_tokens: p.usage.totalTokens, raw: p.usage }
  await recordUsage({
    projectId: p.projectId,
    runId: p.runId,
    stepId: p.stepId,
    kind: 'llm',
    provider: p.provider,
    model: p.model,
    quantity: p.usage.promptTokens,
    unit: 'tokens_in',
    meta,
  })
  await recordUsage({
    projectId: p.projectId,
    runId: p.runId,
    stepId: p.stepId,
    kind: 'llm',
    provider: p.provider,
    model: p.model,
    quantity: p.usage.completionTokens,
    unit: 'tokens_out',
    meta,
  })
}

/**
 * 用量聚合（八种分组）
 * - 过滤：projectId / runId / from(createdAt>=) / to(<=) / batchId（先查 runs 再 inArray）
 * - 指标：quantity 合计、cost 合计（null 记 0）、unpriced 计数（cost is null 行数）、count 行数
 * - totals 对 items 求和（与库内总量等价）
 */
export async function usageSummary(q: {
  projectId?: number
  runId?: number
  batchId?: number
  from?: number
  to?: number
  groupBy: UsageGroupBy
}): Promise<UsageSummaryResult> {
  const keyExpr = {
    kind: usageRecords.kind,
    provider: usageRecords.provider,
    model: usageRecords.model,
    provider_model: sql<string>`coalesce(${usageRecords.provider}, '') || ':' || coalesce(${usageRecords.model}, '')`,
    unit: usageRecords.unit,
    project: usageRecords.projectId,
    run: usageRecords.runId,
    day: sql<string>`strftime('%Y-%m-%d', ${usageRecords.createdAt} / 1000, 'unixepoch', 'localtime')`,
  }[q.groupBy]

  const conds: SQL[] = []
  if (q.projectId !== undefined) conds.push(eq(usageRecords.projectId, q.projectId))
  if (q.runId !== undefined) conds.push(eq(usageRecords.runId, q.runId))
  if (q.from !== undefined) conds.push(gte(usageRecords.createdAt, q.from))
  if (q.to !== undefined) conds.push(lte(usageRecords.createdAt, q.to))
  if (q.batchId !== undefined) {
    const batchRuns = await db
      .select({ id: pipelineRuns.id })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.batchId, q.batchId))
    if (batchRuns.length === 0) return { items: [], totals: { quantity: 0, cost: 0, unpriced: 0 } }
    conds.push(inArray(usageRecords.runId, batchRuns.map((r) => r.id)))
  }

  const base = db
    .select({
      key: keyExpr,
      quantity: sum(usageRecords.quantity),
      cost: sql<number>`sum(coalesce(${usageRecords.cost}, 0))`,
      unpriced: sql<number>`sum(case when ${usageRecords.cost} is null then 1 else 0 end)`,
      count: sql<number>`count(*)`,
    })
    .from(usageRecords)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .groupBy(keyExpr)
  const rows = await (q.groupBy === 'day' ? base.orderBy(asc(keyExpr)) : base)

  const items: UsageSummaryItem[] = rows.map((r) => ({
    key: r.key === null || r.key === undefined ? '' : String(r.key),
    quantity: Number(r.quantity ?? 0),
    cost: Number(r.cost ?? 0),
    unpriced: Number(r.unpriced ?? 0),
    count: Number(r.count ?? 0),
  }))
  const totals = items.reduce(
    (acc, it) => {
      acc.quantity += it.quantity
      acc.cost += it.cost
      acc.unpriced += it.unpriced
      return acc
    },
    { quantity: 0, cost: 0, unpriced: 0 },
  )
  return { items, totals }
}
