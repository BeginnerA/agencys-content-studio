/**
 * [M20] 成本预算熔断与告警服务（B4）
 * - 预算存储：settings 表 key='budgets'，JSON { project?: { monthly, total }, global: { monthly, total } }
 * - 预检：run 创建前调用 checkBudget，超阈返回拦截码（应用层 409）
 * - 告警：用量记录后调用 checkAlerts，超阈写入 budget_alerts 并 emit 事件
 * - 红线：不引重型编排引擎；预算仅做读取+比对+告警，不改执行语义
 */
import { and, eq, gte, sum } from 'drizzle-orm'
import { db } from '../db'
import { budgetAlerts, settings, usageRecords } from '../db/schema'
import { createLogger } from '../logger'
import { emitStudioEvent } from './events'

const log = createLogger('budget')

export interface BudgetConfig {
  /** 项目级预算（projectId → 配置） */
  projects?: Record<string, { monthly?: number; total?: number }>
  /** 全局预算（无 projectId 时的兜底） */
  global?: { monthly?: number; total?: number }
  /** 告警阈值比例（0-1），默认 0.8 = 80% 时告警 */
  alertRatio?: number
}

export interface BudgetAlert {
  id: number
  scope: string // project|global
  scopeId: number | null // projectId（global 为 null）
  kind: string // monthly|total
  budget: number
  spent: number
  ratio: number
  createdAt: number
}

const DAY = 86_400_000

/** 读取预算配置（缺失/损坏 → 空配置 = 不限制） */
export async function loadBudget(): Promise<BudgetConfig> {
  try {
    const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'budgets')).limit(1)
    const raw = rows[0]?.value
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as BudgetConfig) : {}
  } catch {
    return {}
  }
}

/** 保存预算配置 */
export async function saveBudget(cfg: BudgetConfig): Promise<void> {
  const t = Date.now()
  const existing = await db.select({ id: settings.id }).from(settings).where(eq(settings.key, 'budgets')).limit(1)
  if (existing[0]) {
    await db.update(settings).set({ value: JSON.stringify(cfg), updatedAt: t }).where(eq(settings.key, 'budgets'))
  } else {
    await db.insert(settings).values({ key: 'budgets', value: JSON.stringify(cfg), updatedAt: t })
  }
}

/** 查询指定范围已花费成本 */
async function getSpent(q: { projectId?: number; monthly: boolean }): Promise<number> {
  const conds = []
  if (q.projectId !== undefined) conds.push(eq(usageRecords.projectId, q.projectId))
  if (q.monthly) {
    const d = new Date()
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    conds.push(gte(usageRecords.createdAt, d.getTime()))
  }
  const rows = await db
    .select({ v: sum(usageRecords.cost) })
    .from(usageRecords)
    .where(conds.length ? and(...conds) : undefined)
  return Number(rows[0]?.v ?? 0)
}

/**
 * 预算预检（run 创建前调用）
 * - 返回 null = 通过；返回 { code, message } = 拦截
 */
export async function checkBudget(q: { projectId: number; estimatedCost?: number }): Promise<{
  code: string
  message: string
} | null> {
  const cfg = await loadBudget()
  const est = Math.max(0, q.estimatedCost ?? 0)
  const scopes = [
    { projectId: q.projectId, budget: cfg.projects?.[String(q.projectId)], prefix: '', label: '项目' },
    { projectId: undefined, budget: cfg.global, prefix: 'global_', label: '全局' },
  ]
  for (const scope of scopes) {
    for (const kind of ['monthly', 'total'] as const) {
      const limit = scope.budget?.[kind]
      if (limit === undefined) continue
      const spent = await getSpent({ projectId: scope.projectId, monthly: kind === 'monthly' })
      // 预检独立于告警阈值；低用量的大任务同样可能超预算。
      if (spent + est > limit) return {
        code: `budget_${scope.prefix}${kind}_exceeded`,
        message: `${scope.label}${kind === 'monthly' ? '月度' : '总'}预算 ${limit} 元，已用 ${spent.toFixed(2)} 元，本次已知预计 ${est.toFixed(2)} 元将超限`,
      }
    }
  }
  return null
}

/**
 * 用量记录后告警检查（异步，不阻断流水线）
 * - 检查当前花费是否超过告警阈值
 * - 同一 scope+kind 24h 内不重复告警（去抖）
 */
export async function checkAlerts(q: { projectId: number }): Promise<void> {
  const cfg = await loadBudget()
  const alertRatio = cfg.alertRatio ?? 0.8

  const checks: Array<{ scope: 'project' | 'global'; scopeId: number | null; kind: 'monthly' | 'total'; budget: number }> = []

  // 项目级
  const projBudget = cfg.projects?.[String(q.projectId)]
  if (projBudget?.monthly !== undefined) checks.push({ scope: 'project', scopeId: q.projectId, kind: 'monthly', budget: projBudget.monthly })
  if (projBudget?.total !== undefined) checks.push({ scope: 'project', scopeId: q.projectId, kind: 'total', budget: projBudget.total })

  // 全局
  if (cfg.global?.monthly !== undefined) checks.push({ scope: 'global', scopeId: null, kind: 'monthly', budget: cfg.global.monthly })

  for (const c of checks) {
    const spent = await getSpent({ projectId: c.scopeId ?? undefined, monthly: c.kind === 'monthly' })
    const ratio = c.budget > 0 ? spent / c.budget : 0
    if (ratio >= alertRatio) {
      // 去抖：24h 内同 scope+kind 已告警则跳过
      const recentAlert = await db
        .select({ id: budgetAlerts.id })
        .from(budgetAlerts)
        .where(
          and(
            eq(budgetAlerts.scope, c.scope),
            eq(budgetAlerts.kind, c.kind),
            gte(budgetAlerts.createdAt, Date.now() - DAY),
            c.scopeId !== null ? eq(budgetAlerts.scopeId, c.scopeId) : undefined,
          ),
        )
        .limit(1)
      if (recentAlert[0]) continue

      const alert = (
        await db
          .insert(budgetAlerts)
          .values({
            scope: c.scope,
            scopeId: c.scopeId,
            kind: c.kind,
            budget: c.budget,
            spent: Math.round(spent * 1e4) / 1e4,
            ratio: Math.round(ratio * 1e4) / 1e4,
            createdAt: Date.now(),
          })
          .returning()
      )[0]!
      log.warn(`budget alert: ${c.scope} ${c.kind} ${Math.round(ratio * 100)}% (spent ${spent.toFixed(2)}/${c.budget})`)
      emitStudioEvent({
        type: 'budget.alert',
        runId: null,
        alertId: alert.id,
        projectId: c.scopeId,
        scope: c.scope,
        kind: c.kind,
        ratio: alert.ratio,
      } as never)
    }
  }
}

/** 获取告警历史（最近 50 条） */
export async function listAlerts(q: { projectId?: number }): Promise<BudgetAlert[]> {
  const conds = []
  if (q.projectId !== undefined) {
    conds.push(eq(budgetAlerts.scopeId, q.projectId))
  }
  return db
    .select()
    .from(budgetAlerts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(budgetAlerts.createdAt)
    .limit(50)
}

/** 获取预算状态概览（前端预算面板用） */
export async function budgetOverview(): Promise<{
  config: BudgetConfig
  projects: Array<{
    projectId: number
    monthly: { budget: number; spent: number; ratio: number }
    total: { budget: number; spent: number; ratio: number }
  }>
  global: {
    monthly: { budget: number; spent: number; ratio: number } | null
  }
}> {
  const cfg = await loadBudget()
  const result: {
    config: BudgetConfig
    projects: Array<{
      projectId: number
      monthly: { budget: number; spent: number; ratio: number }
      total: { budget: number; spent: number; ratio: number }
    }>
    global: { monthly: { budget: number; spent: number; ratio: number } | null }
  } = { config: cfg, projects: [], global: { monthly: null } }

  // 项目级
  if (cfg.projects) {
    for (const [pidStr, b] of Object.entries(cfg.projects)) {
      const pid = Number(pidStr)
      const monthlySpent = b.monthly !== undefined ? await getSpent({ projectId: pid, monthly: true }) : 0
      const totalSpent = b.total !== undefined ? await getSpent({ projectId: pid, monthly: false }) : 0
      result.projects.push({
        projectId: pid,
        monthly: { budget: b.monthly ?? 0, spent: monthlySpent, ratio: b.monthly ? monthlySpent / b.monthly : 0 },
        total: { budget: b.total ?? 0, spent: totalSpent, ratio: b.total ? totalSpent / b.total : 0 },
      })
    }
  }

  // 全局
  if (cfg.global?.monthly !== undefined) {
    const spent = await getSpent({ monthly: true })
    result.global.monthly = { budget: cfg.global.monthly, spent, ratio: spent / cfg.global.monthly }
  }

  return result
}
