import { and, asc, eq, inArray, ne } from 'drizzle-orm'
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
import { loadTemplate } from './loader'
import { interpolate, loadStepOutputs, resolveInputs } from './refs'
import type { Template, TemplateStepDef, StepResult } from './types'
import { RunCancelledError, StepError } from './types'

const log = createLogger('engine')

const now = (): number => Date.now()

/** gate 决策记录挂在 step.output（保留审阅痕迹供 UI 展示） */
interface StepOutputDoc {
  asset_ids: number[]
  gate?: { decision: 'approve' | 'reject'; note?: string; at: number }
}

/**
 * M1 流水线引擎（spec §5.4 状态机语义）：
 *   run:  queued → running → { waiting_input | completed | failed | cancelled }
 *   step: pending → running → { waiting_input | succeeded | failed | cancelled }
 * 执行链为「单飞」：REST 层触发后异步推进，所有状态变更先落库；
 * 步骤间隙与 action 内部检查 cancelled 以尽快收敛。
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
  }

  // ---------- 内部执行链 ----------

  private async runChain(runId: number): Promise<void> {
    try {
      const run = await this.requireRun(runId)
      if (run.status === 'completed' || run.status === 'cancelled') return
      const template = loadTemplate(run.templateKey)
      const projectRow = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1)
      let projectSettings: Record<string, unknown> = {}
      if (projectRow[0]?.settings) {
        try {
          projectSettings = JSON.parse(projectRow[0].settings) as Record<string, unknown>
        } catch {
          projectSettings = {}
        }
      }
      const t0 = now()
      const wasQueued = run.status === 'queued'
      await db
        .update(pipelineRuns)
        .set({ status: 'running', startedAt: wasQueued ? t0 : run.startedAt, error: null, updatedAt: t0 })
        .where(eq(pipelineRuns.id, runId))
      if (wasQueued) {
        emitStudioEvent({ type: 'run.started', runId, projectId: run.projectId, stepCount: template.steps.length })
      }

      const rows = await db
        .select()
        .from(pipelineSteps)
        .where(eq(pipelineSteps.runId, runId))
        .orderBy(asc(pipelineSteps.seq))
      const rowsByKey = new Map(rows.map((r) => [r.stepKey, r]))

      for (const def of template.steps) {
        const fresh = await this.requireRun(runId)
        if (fresh.status === 'cancelled') return
        if (fresh.status === 'completed') return

        const existing = rowsByKey.get(def.key)
        if (existing?.status === 'succeeded') continue
        if (existing?.status === 'waiting_input') {
          // 其他人工闸未决 → 保持等待（approve/reject 后重新触发 startRun）
          await db
            .update(pipelineRuns)
            .set({ status: 'waiting_input', currentStepKey: def.key, updatedAt: now() })
            .where(eq(pipelineRuns.id, runId))
          emitStudioEvent({ type: 'run.gate', runId, stepKey: def.key, message: '' })
          return
        }

        const step =
          existing ??
          (
            await db
              .insert(pipelineSteps)
              .values({
                runId,
                seq: template.steps.indexOf(def),
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
        const outcome = await this.executeStep(run, step, def, template, projectSettings)
        if (outcome === 'failed') return
        if (outcome === 'waiting') {
          return
        }
        // succeeded → 继续下一 def（循环）；但若本步带 gate 且无 review（reject 直通标志）由 executeStep 决定挂起
      }

      const done = await this.requireRun(runId)
      if (done.status === 'cancelled') return
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
    }
  }

  /** 单步执行 → 'ok' | 'waiting' | 'failed' */
  private async executeStep(
    run: PipelineRun,
    step: PipelineStep,
    def: TemplateStepDef,
    template: Template,
    projectSettings: Record<string, unknown>,
  ): Promise<'ok' | 'waiting' | 'failed'> {
    const t = now()
    const runInput = JSON.parse(run.input) as Record<string, unknown>
    try {
      if ((await this.requireRun(run.id)).status === 'cancelled') throw new RunCancelledError()
      await db
        .update(pipelineSteps)
        .set({ status: 'running', startedAt: t, attempts: step.attempts + 1, error: null, updatedAt: t })
        .where(eq(pipelineSteps.id, step.id))
      // 上次 reject 的修改意见（存于 output.gate）→ 注入本次输入
      const doc = this.parseOutput(step.output)
      const review = doc.gate?.decision === 'reject' ? doc.gate : undefined

      const stepOutputs = await loadStepOutputs(run.id)
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
      const gateHang =
        def.gate?.mode === 'required' && !review
          ? true
          : false

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

  private parseOutput(output: string | null): StepOutputDoc {
    if (!output) return { asset_ids: [] }
    try {
      const parsed = JSON.parse(output) as StepOutputDoc
      return { asset_ids: Array.isArray(parsed.asset_ids) ? parsed.asset_ids : [], gate: parsed.gate }
    } catch {
      return { asset_ids: [] }
    }
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
  const queued = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.status, 'queued'))
  if (stuckTasks.length || runningRuns.length || queued.length) {
    log.info(
      `崩溃恢复: tasks=${stuckTasks.length} 置 failed, runs=${runningRuns.length} 置 failed(interrupted), queued=${queued.length}`,
    )
  }
  return { requeued: queued.map((r) => r.id) }
}
