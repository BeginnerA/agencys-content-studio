import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { db } from '../db'
import {
  assets,
  genTasks,
  pipelineRuns,
  pipelineSteps,
  projects,
  type GenTask,
  type PipelineRun,
  type PipelineStep,
} from '../db/schema'
import { createLogger } from '../logger'
import { emitStudioEvent } from '../services/events'
import { writeTextAsset } from '../services/storage'
import { getAction } from './actions'
import { createStepContext } from './context'
import { templateForRun } from './loader'
import { evaluateWhen, interpolate, loadStepOutputs, parseWhenExpr, resolveInputs, whenRefs } from './refs'
import type { Template, TemplateStepDef, StepResult } from './types'
import { RunCancelledError, StepError } from './types'

const log = createLogger('engine')

/** [M4] run 终态监听（batch pump 挂钩点）；listener 异常隔离，不影响引擎主流程 */
type SettledListener = (runId: number) => void
const settledListeners = new Set<SettledListener>()

export function onRunSettled(cb: SettledListener): void {
  settledListeners.add(cb)
}

function notifySettled(runId: number): void {
  for (const cb of settledListeners) {
    try {
      cb(runId)
    } catch (err) {
      log.warn(`run ${runId} settled listener 异常`, { error: (err as Error).message })
    }
  }
}

const now = (): number => Date.now()

/** gate 决策记录挂在 step.output（保留审阅痕迹供 UI 展示） */
interface StepOutputDoc {
  asset_ids: number[]
  gate?: { decision: 'approve' | 'reject'; note?: string; at: number }
  /** [M2] 跳过痕迹：user_skip=免审放行（产物保留）/ upstream_skipped=依赖全跳过 / when_condition=条件不满足 */
  skipped?: { reason: 'user_skip' | 'upstream_skipped' | 'when_condition'; note?: string; at: number }
}

/**
 * M2 流水线引擎（spec §3.2 DAG 调度语义）：
 *   run:  queued → running → { waiting_input | completed | failed | cancelled }
 *   step: pending → running → waiting_input | succeeded | skipped | failed | cancelled
 * 执行链为「单飞 + 就绪集并发（≤2）」：步骤默认依赖前一步（after 可改）；
 * 依赖全终态才就绪；依赖全 skipped → 自动 skipped（不占槽）；gate 挂起 = run 级暂停。
 * 模板来源优先 run 快照（templateForRun）。
 */
class PipelineEngine {
  private active = new Set<number>()

  isRunning(runId: number): boolean {
    return this.active.has(runId)
  }

  /**
   * 启动/续跑执行链（幂等）：
   * - 跳过 succeeded 步骤（断点续跑语义）
   * - 遇 waiting_input 步骤（他人工闸）→ 挂起等待
   * - 遇 pending/failed 步骤 → 从该处恢复执行
   */
  startRun(runId: number): void {
    if (this.active.has(runId)) return
    this.active.add(runId)
    void this.runChain(runId).catch((err) => {
      log.error(`run ${runId} 执行链异常`, { error: (err as Error).message })
    })
  }

  /** 闸门批准：可选文本覆盖产物 → 本步 succeeded → 自动续跑 */
  async approveGate(
    runId: number,
    stepKey: string,
    opts: { note?: string; textOverride?: string } = {},
  ): Promise<void> {
    const run = await this.requireRun(runId)
    if (run.status !== 'waiting_input') {
      throw new Error(`run ${runId} 不在等待状态（当前 ${run.status}）`)
    }
    const step = await this.requireStep(runId, stepKey)
    if (step.status !== 'waiting_input') {
      throw new Error(`步骤 ${stepKey} 不在等待状态（当前 ${step.status}）`)
    }
    const doc = this.parseOutput(step.output)
    let assetIds = doc.asset_ids
    if (opts.textOverride?.trim()) {
      const first = assetIds[0]
      if (first) {
        const rows = await db.select().from(assets).where(eq(assets.id, first)).limit(1)
        const origin = rows[0]
        if (origin) {
          const asset = await writeTextAsset(run.projectId, {
            name: `${origin.name.replace(/\.[^.]+$/, '')}-审阅定稿.md`,
            content: opts.textOverride,
            purpose: origin.purpose ?? 'script',
            stepId: step.id,
            tags: ['reviewed'],
          })
          assetIds = [asset.id]
        }
      }
    }
    const output: StepOutputDoc = {
      asset_ids: assetIds,
      gate: { decision: 'approve', note: opts.note, at: now() },
    }
    await db
      .update(pipelineSteps)
      .set({ status: 'succeeded', output: JSON.stringify(output), completedAt: now(), updatedAt: now() })
      .where(eq(pipelineSteps.id, step.id))
    this.startRun(runId)
  }

  /** 闸门驳回：本步置回 pending（携带修改意见重跑，attempts+1） */
  async rejectGate(runId: number, stepKey: string, opts: { note?: string } = {}): Promise<void> {
    const run = await this.requireRun(runId)
    if (run.status !== 'waiting_input') {
      throw new Error(`run ${runId} 不在等待状态（当前 ${run.status}）`)
    }
    const step = await this.requireStep(runId, stepKey)
    if (step.status !== 'waiting_input') {
      throw new Error(`步骤 ${stepKey} 不在等待状态（当前 ${step.status}）`)
    }
    const doc = this.parseOutput(step.output)
    const output: StepOutputDoc = {
      asset_ids: doc.asset_ids,
      gate: { decision: 'reject', note: opts.note, at: now() },
    }
    await db
      .update(pipelineSteps)
      .set({ status: 'pending', output: JSON.stringify(output), error: null, updatedAt: now() })
      .where(eq(pipelineSteps.id, step.id))
    this.startRun(runId)
  }

  /** 闸门跳过（免审放行，仅模板声明 skip_label 时可调用）：置 succeeded、产物保留、output 记 user_skip */
  async skipGate(runId: number, stepKey: string, opts: { note?: string } = {}): Promise<void> {
    const run = await this.requireRun(runId)
    if (run.status !== 'waiting_input') {
      throw new Error(`run ${runId} 不在等待状态（当前 ${run.status}）`)
    }
    const step = await this.requireStep(runId, stepKey)
    if (step.status !== 'waiting_input') {
      throw new Error(`步骤 ${stepKey} 不在等待状态（当前 ${step.status}）`)
    }
    const doc = this.parseOutput(step.output)
    const output: StepOutputDoc = {
      asset_ids: doc.asset_ids,
      skipped: { reason: 'user_skip', note: opts.note, at: now() },
    }
    await db
      .update(pipelineSteps)
      .set({ status: 'succeeded', output: JSON.stringify(output), completedAt: now(), updatedAt: now() })
      .where(eq(pipelineSteps.id, step.id))
    this.startRun(runId)
  }

  /** 取消（幂等）：run + 未完成 steps + pending/processing tasks 一并置 cancelled */
  async cancelRun(runId: number): Promise<void> {
    const run = await this.requireRun(runId)
    if (['completed', 'cancelled'].includes(run.status)) return
    const t = now()
    await db
      .update(pipelineRuns)
      .set({ status: 'cancelled', completedAt: t, updatedAt: t })
      .where(eq(pipelineRuns.id, runId))
    await db
      .update(pipelineSteps)
      .set({ status: 'cancelled', updatedAt: t })
      .where(and(eq(pipelineSteps.runId, runId), inArray(pipelineSteps.status, ['pending', 'running', 'waiting_input'])))
    await db
      .update(genTasks)
      .set({ status: 'cancelled', errorMsg: 'run cancelled', completedAt: t, updatedAt: t })
      .where(and(eq(genTasks.runId, runId), inArray(genTasks.status, ['pending', 'processing'])))
    // [M4] 取消即终态：直接通知（覆盖 queued 等无活跃执行链的 run；与 runChain finally 的
    // 重复通知幂等无害——pump 每轮重算）
    notifySettled(runId)
  }

  // ---------- 内部执行链 ----------

  /**
   * DAG 调度主循环（spec §3.2）：
   * 每轮：补齐步骤行 → 依赖跳过传播 → 失败收敛 → 就绪集（≤2 并发）→ 批收敛后重算。
   * gate 挂起 = run 级暂停：不启动新就绪步，已启动并行步自然收敛。
   */
  private async runChain(runId: number): Promise<void> {
    try {
      const run0 = await this.requireRun(runId)
      if (['completed', 'cancelled', 'failed'].includes(run0.status)) return
      // [M2] 模板来源优先 run 快照（模板在线修改不影响续跑语义；存量 run 回退文件加载）
      const template = templateForRun(run0)
      const orderByKey = new Map(template.steps.map((s, i) => [s.key, i] as const))
      const projectSettings = await this.loadProjectSettings(run0.projectId)
      const t0 = now()
      const wasQueued = run0.status === 'queued'
      await db
        .update(pipelineRuns)
        .set({ status: 'running', startedAt: wasQueued ? t0 : run0.startedAt, error: null, updatedAt: t0 })
        .where(eq(pipelineRuns.id, runId))
      if (wasQueued) {
        emitStudioEvent({ type: 'run.started', runId, projectId: run0.projectId, stepCount: template.steps.length })
      }
      const inflight = new Set<Promise<void>>()
      while (true) {
        const run = await this.requireRun(runId)
        if (['cancelled', 'failed', 'completed'].includes(run.status)) break
        // run 级暂停（gate 挂起）：并行步收敛后让出，等待人工闸门决策（放行后经 startRun 重进）
        if (run.status === 'waiting_input') {
          if (inflight.size === 0) return
          await Promise.allSettled([...inflight])
          inflight.clear()
          continue
        }
        const rows = await db
          .select()
          .from(pipelineSteps)
          .where(eq(pipelineSteps.runId, runId))
          .orderBy(asc(pipelineSteps.seq))
        const rowsByKey = new Map(rows.map((r) => [r.stepKey, r]))
        // 补齐模板步骤行（一次建全量 pending 行：就绪判定与 UI 展示依赖全量状态）
        for (const def of template.steps) {
          if (rowsByKey.has(def.key)) continue
          const inserted = (
            await db
              .insert(pipelineSteps)
              .values({
                runId,
                seq: orderByKey.get(def.key) ?? 0,
                stepKey: def.key,
                actionKey: def.action,
                title: def.title,
                status: 'pending',
                attempts: 0,
                createdAt: now(),
                updatedAt: now(),
              })
              .returning()
          )[0]!
          rowsByKey.set(def.key, inserted)
        }
        // ① 依赖跳过传播（确定性规则）：依赖全终态且无任何 succeeded（全部 skipped）→ 自动 skipped
        let propagated = true
        while (propagated) {
          propagated = false
          for (const def of template.steps) {
            const row = rowsByKey.get(def.key)
            if (!row || row.status !== 'pending') continue
            const depKeys = this.depsFor(def, template, orderByKey)
            if (depKeys.length === 0) continue
            const depRows = depKeys.map((k) => rowsByKey.get(k))
            if (depRows.some((r) => !r || ['pending', 'running', 'waiting_input'].includes(r.status))) continue
            if (!depRows.every((r) => r?.status === 'skipped')) continue
            await this.markStepSkipped(row, 'upstream_skipped')
            rowsByKey.set(def.key, { ...row, status: 'skipped' })
            propagated = true
          }
        }
        // ② 失败收敛：任一模板步骤 failed → run failed（并行兄弟步产物保留，resume 时跳过）
        const failedRow = [...rowsByKey.values()].find((r) => r.status === 'failed' && orderByKey.has(r.stepKey))
        if (failedRow) {
          const msg = `步骤 ${failedRow.stepKey} 失败: ${failedRow.error ?? '未知错误'}`
          await db
            .update(pipelineRuns)
            .set({ status: 'failed', currentStepKey: failedRow.stepKey, error: msg, completedAt: now(), updatedAt: now() })
            .where(eq(pipelineRuns.id, runId))
          emitStudioEvent({ type: 'run.failed', runId, stepKey: failedRow.stepKey, error: failedRow.error ?? '' })
          break
        }
        // ③ 就绪集：依赖全终态（含 succeeded 即就绪；全 skipped 已在①收敛）
        const ready: Array<{ def: TemplateStepDef; row: PipelineStep }> = []
        for (const def of template.steps) {
          const row = rowsByKey.get(def.key)
          if (!row || row.status !== 'pending') continue
          const depRows = this.depsFor(def, template, orderByKey).map((k) => rowsByKey.get(k))
          if (depRows.some((r) => !r || !['succeeded', 'skipped'].includes(r.status))) continue
          ready.push({ def, row })
        }
        // ④ 无可推进步骤 → 收敛判定
        if (ready.length === 0) {
          if (inflight.size > 0) {
            await Promise.allSettled([...inflight])
            inflight.clear()
            continue
          }
          const waitingKey = template.steps.find((s) => rowsByKey.get(s.key)?.status === 'waiting_input')?.key
          if (waitingKey) {
            // 多 gate 收敛：run 维持 waiting_input，currentStepKey 指向模板序首个等待步
            const wdef = template.steps.find((s) => s.key === waitingKey)
            const runInput = JSON.parse(run.input) as Record<string, unknown>
            const message = wdef?.gate?.message ? interpolate(wdef.gate.message, runInput) : '请审阅'
            await db
              .update(pipelineRuns)
              .set({ status: 'waiting_input', currentStepKey: waitingKey, updatedAt: now() })
              .where(eq(pipelineRuns.id, runId))
            emitStudioEvent({ type: 'run.gate', runId, stepKey: waitingKey, message })
            return
          }
          const allDone = template.steps.every((s) => {
            const r = rowsByKey.get(s.key)
            return r && ['succeeded', 'skipped'].includes(r.status)
          })
          if (allDone) {
            await db
              .update(pipelineRuns)
              .set({
                status: 'completed',
                currentStepKey: null,
                summary: JSON.stringify({ stepCount: template.steps.length, durationMs: now() - t0 }),
                completedAt: now(),
                updatedAt: now(),
              })
              .where(eq(pipelineRuns.id, runId))
            emitStudioEvent({ type: 'run.completed', runId })
            log.info(`run ${runId} completed`)
            break
          }
          // 防御：遗留 pending 且无活动步/等待步 → 终止避免死循环
          log.warn(`run ${runId} 调度停滞（无就绪步也无活动步），终止以避免死循环`)
          await db
            .update(pipelineRuns)
            .set({ status: 'failed', error: '引擎调度停滞（内部错误）', completedAt: now(), updatedAt: now() })
            .where(eq(pipelineRuns.id, runId))
          break
        }
        // ⑤ 启动就绪集（并发硬上限 2；整批收敛后回到循环顶部重算就绪集）
        const batch = ready.slice(0, 2 - inflight.size)
        for (const { def, row } of batch) {
          const p = this.executeStep(run, row, def, template, projectSettings)
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => {
              inflight.delete(p)
            })
          inflight.add(p)
        }
        if (inflight.size === 0) {
          log.warn(`run ${runId} 就绪集启动失败`)
          break
        }
        await Promise.allSettled([...inflight])
        inflight.clear()
      }
    } catch (err) {
      if (err instanceof RunCancelledError) return
      // 链级兜底：未在步骤内捕获的异常 → run failed
      const msg = (err as Error).message
      log.error(`run ${runId} failed: ${msg}`)
      await db
        .update(pipelineRuns)
        .set({ status: 'failed', error: msg, completedAt: now(), updatedAt: now() })
        .where(and(eq(pipelineRuns.id, runId), ne(pipelineRuns.status, 'cancelled')))
      emitStudioEvent({ type: 'run.failed', runId, stepKey: '', error: msg })
    } finally {
      this.active.delete(runId)
      // [M4] 终态通知（单点）：覆盖全部收敛出口——allDone 完成、失败收敛、链级兜底 catch、
      // executeStep 失败（置 run failed 后循环顶部 break）、调度停滞防御、RunCancelledError。
      // 查库判定而非按分支埋点：waiting_input（gate 挂起）不是终态，不通知。
      void this.settleIfTerminal(runId).catch((err) =>
        log.warn(`run ${runId} settle 通知失败`, { error: (err as Error).message }),
      )
    }
  }

  /** 步骤实际依赖：显式 after（缺省 = 前一步骤）+ when 表达式中 steps.x.count 的隐式依赖 */
  private depsFor(def: TemplateStepDef, template: Template, orderByKey: Map<string, number>): string[] {
    const depKeys: string[] = []
    const push = (k: string): void => {
      if (k && k !== def.key && !depKeys.includes(k)) depKeys.push(k)
    }
    if (def.after !== undefined) {
      for (const k of def.after) push(k)
    } else {
      const idx = orderByKey.get(def.key) ?? 0
      if (idx > 0) {
        const prev = template.steps[idx - 1]
        if (prev) push(prev.key)
      }
    }
    for (const raw of this.whenExprs(def)) {
      try {
        const ref = whenRefs(parseWhenExpr(raw))
        if (ref.stepKey) push(ref.stepKey)
      } catch {
        // loader 已静态校验；快照损坏由执行期求值兜底报错
      }
    }
    return depKeys
  }

  /** 平铺步骤全部条件表达式（when/when_any/gate.when） */
  private whenExprs(def: TemplateStepDef): string[] {
    const out: string[] = []
    const add = (v: string | string[] | undefined): void => {
      if (v) out.push(...(Array.isArray(v) ? v : [v]))
    }
    add(def.when)
    add(def.when_any)
    add(def.gate?.when)
    return out
  }

  /** 步骤置 skipped（落库 + 事件；output 记原因痕迹） */
  private async markStepSkipped(step: PipelineStep, reason: 'upstream_skipped' | 'when_condition'): Promise<void> {
    const t = now()
    const output: StepOutputDoc = { asset_ids: [], skipped: { reason, at: t } }
    await db
      .update(pipelineSteps)
      .set({ status: 'skipped', output: JSON.stringify(output), completedAt: t, updatedAt: t })
      .where(eq(pipelineSteps.id, step.id))
    emitStudioEvent({
      type: 'run.step',
      runId: step.runId,
      step: { id: step.id, key: step.stepKey, action: step.actionKey, status: 'skipped' },
    })
  }

  /** 项目级 settings（JSON 解析失败兜底空对象） */
  private async loadProjectSettings(projectId: number): Promise<Record<string, unknown>> {
    const projectRow = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
    if (projectRow[0]?.settings) {
      try {
        return JSON.parse(projectRow[0].settings) as Record<string, unknown>
      } catch {
        return {}
      }
    }
    return {}
  }

  /** 单步执行 → 'ok' | 'waiting' | 'failed' | 'skipped'（skipped = when 条件不满足） */
  private async executeStep(
    run: PipelineRun,
    step: PipelineStep,
    def: TemplateStepDef,
    template: Template,
    projectSettings: Record<string, unknown>,
  ): Promise<'ok' | 'waiting' | 'failed' | 'skipped'> {
    const t = now()
    const runInput = JSON.parse(run.input) as Record<string, unknown>
    try {
      if ((await this.requireRun(run.id)).status === 'cancelled') throw new RunCancelledError()
      // [M2] 依赖产物快照（when 求值与 input 引用解析共用；依赖已由调度器保证终态）
      const stepOutputs = await loadStepOutputs(run.id)
      // [M2] when/when_any 条件：不满足 → skipped（不占重试、不触发 gate）
      if (!evaluateWhen(def.when, def.when_any, { runInput, stepOutputs })) {
        await this.markStepSkipped(step, 'when_condition')
        log.info(`run ${run.id} step ${def.key} 条件不满足，已跳过`)
        return 'skipped'
      }
      await db
        .update(pipelineSteps)
        .set({ status: 'running', startedAt: t, attempts: step.attempts + 1, error: null, updatedAt: t })
        .where(eq(pipelineSteps.id, step.id))
      // 上次 reject 的修改意见（存于 output.gate）→ 注入本次输入
      const doc = this.parseOutput(step.output)
      const review = doc.gate?.decision === 'reject' ? doc.gate : undefined

      const input = await resolveInputs(def.inputs, {
        projectId: run.projectId,
        runInput,
        stepOutputs,
      })
      if (review?.note) input['_review'] = { decision: 'reject', note: review.note }
      await db
        .update(pipelineSteps)
        .set({ input: JSON.stringify(input), updatedAt: now() })
        .where(eq(pipelineSteps.id, step.id))
      emitStudioEvent({
        type: 'run.step',
        runId: run.id,
        step: { id: step.id, key: def.key, action: def.action, status: 'running' },
      })

      const ctx = await createStepContext({ run, step, template, def, input, projectSettings })
      const action = getAction(def.action)
      const result: StepResult = await action(ctx)
      ctx.log(`步骤完成，产物资产 ${result.assetIds.length} 个`)

      const output: StepOutputDoc = { asset_ids: result.assetIds }
      // [M2] gate 条件门：gate.when 不满足 → 免审直过（正常 succeeded 不挂起）
      const gateHang = !!def.gate && !review && this.gateShouldHang(def, runInput, stepOutputs)

      if (gateHang) {
        await db
          .update(pipelineSteps)
          .set({ status: 'waiting_input', output: JSON.stringify(output), updatedAt: now() })
          .where(eq(pipelineSteps.id, step.id))
        await db
          .update(pipelineRuns)
          .set({ status: 'waiting_input', currentStepKey: def.key, updatedAt: now() })
          .where(eq(pipelineRuns.id, run.id))
        const message = def.gate?.message ? interpolate(def.gate.message, runInput) : '请审阅'
        emitStudioEvent({ type: 'run.gate', runId: run.id, stepKey: def.key, message })
        log.info(`run ${run.id} 于 ${def.key} 挂起等待人工闸门`)
        return 'waiting'
      }

      await db
        .update(pipelineSteps)
        .set({ status: 'succeeded', output: JSON.stringify(output), completedAt: now(), updatedAt: now() })
        .where(eq(pipelineSteps.id, step.id))
      emitStudioEvent({
        type: 'run.step',
        runId: run.id,
        step: { id: step.id, key: def.key, action: def.action, status: 'succeeded' },
      })
      return 'ok'
    } catch (err) {
      if (err instanceof RunCancelledError) {
        await db
          .update(pipelineSteps)
          .set({ status: 'cancelled', updatedAt: now() })
          .where(eq(pipelineSteps.id, step.id))
        throw err
      }
      const msg = err instanceof StepError ? err.message : `执行异常: ${(err as Error).message}`
      await db
        .update(pipelineSteps)
        .set({ status: 'failed', error: msg, completedAt: now(), updatedAt: now() })
        .where(eq(pipelineSteps.id, step.id))
      await db
        .update(pipelineRuns)
        .set({ status: 'failed', currentStepKey: def.key, error: `${def.key}: ${msg}`, completedAt: now(), updatedAt: now() })
        .where(eq(pipelineRuns.id, run.id))
      emitStudioEvent({ type: 'run.failed', runId: run.id, stepKey: def.key, error: msg })
      log.error(`run ${run.id} step ${def.key} failed: ${msg}`)
      return 'failed'
    }
  }

  /** [M4] run 已终态（completed/failed/cancelled）→ 通知监听者；其余状态静默 */
  private async settleIfTerminal(runId: number): Promise<void> {
    const rows = await db
      .select({ status: pipelineRuns.status })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId))
      .limit(1)
    const status = rows[0]?.status
    if (status === 'completed' || status === 'failed' || status === 'cancelled') notifySettled(runId)
  }

  private parseOutput(output: string | null): StepOutputDoc {
    if (!output) return { asset_ids: [] }
    try {
      const parsed = JSON.parse(output) as StepOutputDoc
      return {
        asset_ids: Array.isArray(parsed.asset_ids) ? parsed.asset_ids : [],
        gate: parsed.gate,
        skipped: parsed.skipped,
      }
    } catch {
      return { asset_ids: [] }
    }
  }

  /** [M2] gate 是否应挂起审阅：gate.when 未声明或满足 → 挂起；不满足 → 免审直过 */
  private gateShouldHang(
    def: TemplateStepDef,
    runInput: Record<string, unknown>,
    stepOutputs: Map<string, number[]>,
  ): boolean {
    return evaluateWhen(def.gate?.when, undefined, { runInput, stepOutputs })
  }

  private async requireRun(runId: number): Promise<PipelineRun> {
    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
    const run = rows[0]
    if (!run) throw new Error(`run ${runId} 不存在`)
    return run
  }

  private async requireStep(runId: number, stepKey: string): Promise<PipelineStep> {
    const rows = await db
      .select()
      .from(pipelineSteps)
      .where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, stepKey)))
      .limit(1)
    const step = rows[0]
    if (!step) throw new Error(`run ${runId} 无步骤 ${stepKey}`)
    return step
  }
}

/** 进程内单例（REST 与恢复流程共用） */
export const engine = new PipelineEngine()

/**
 * 崩溃恢复（启动时调用一次，spec §5.4）：
 * - pending/processing 的 gen_tasks → failed（可手动 retry）
 * - running 的 run → failed(interrupted)，UI 以「从断点续跑」重建
 * - waiting_input 保留（人工闸是持久状态）；queued 的 run 返回待重新执行
 */
export async function recoverInterruptedState(): Promise<{ requeued: number[] }> {
  const t = now()
  const stuckTasks = await db
    .select()
    .from(genTasks)
    .where(inArray(genTasks.status, ['pending', 'processing']))
  for (const task of stuckTasks) {
    await db
      .update(genTasks)
      .set({ status: 'failed', errorMsg: '服务重启导致任务中断，可手动重试', completedAt: t, updatedAt: t })
      .where(eq(genTasks.id, task.id))
  }
  const runningRuns = await db.select().from(pipelineRuns).where(eq(pipelineRuns.status, 'running'))
  for (const run of runningRuns) {
    await db
      .update(pipelineRuns)
      .set({
        status: 'failed',
        error: 'interrupted：服务重启。可在运行详情页「从断点续跑」（已完成步骤将跳过）',
        completedAt: t,
        updatedAt: t,
      })
      .where(eq(pipelineRuns.id, run.id))
  }
  // [M4] 批内 queued run 不在此 requeue——由 reconcileBatches 按槽位约束推进（防恢复瞬间绕过批内并发限制）
  const queued = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.status, 'queued'), isNull(pipelineRuns.batchId)))
  if (stuckTasks.length || runningRuns.length || queued.length) {
    log.info(
      `崩溃恢复: tasks=${stuckTasks.length} 置 failed, runs=${runningRuns.length} 置 failed(interrupted), queued=${queued.length}`,
    )
  }
  return { requeued: queued.map((r) => r.id) }
}
