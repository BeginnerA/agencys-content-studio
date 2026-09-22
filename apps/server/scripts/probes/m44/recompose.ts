import { and, eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'
import { seedDialogueRun } from './fixture'

/**
 * 对白本地重合成（服务层）：改选已校验候选后重合成必须同时失效逐镜转写与合成、
 * 清空陈旧字幕与旧最终审阅，且绝不归零/删除 ASR 任务（保持缓存复用 → 零模型零付费）。
 * engine.startRun 打桩，只验重置决策不跑媒体。
 */
async function seedDeliveredDialogue(plan: CreationPlan) {
  const { db } = await import('../../../src/db')
  const { genTasks, pipelineSteps } = await import('../../../src/db/schema')
  const f = await seedDialogueRun(plan)
  const now = Date.now()
  const rows = await db.insert(pipelineSteps).values(f.template.steps.map((s, seq) => ({
    runId: f.run.id, seq, stepKey: s.key, actionKey: s.action, title: s.title,
    status: s.key === 'frames' ? 'skipped' : 'succeeded', createdAt: now, updatedAt: now,
  }))).returning()
  const byKey = new Map(rows.map((r) => [r.stepKey, r] as const))
  const captions = byKey.get('captions')!
  const compose = byKey.get('compose')!
  const clip = f.recipe.sources[0]!.id
  // 转写步与合成步都产出过成片资产（output 非空），最终审阅已完成
  await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [clip], gate: 'approved' }) }).where(eq(pipelineSteps.id, captions.id))
  await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [clip], gate: 'approved' }) }).where(eq(pipelineSteps.id, compose.id))
  await db.insert(genTasks).values(plan.shots.map((s) => ({
    projectId: f.project.id, runId: f.run.id, stepId: captions.id, kind: 'asr', provider: 'openai_audio', model: 'whisper-1',
    prompt: '', params: JSON.stringify({ shotId: s.id }), status: 'succeeded', attempts: 1, resultAssetId: clip, createdAt: now, updatedAt: now,
  })))
  return { f, db, genTasks, pipelineSteps, captions, compose }
}

export async function probeDialogueRecompose({ check }: Checker, plan: CreationPlan): Promise<void> {
  const { recomposeCreation } = await import('../../../src/services/creation-chat/candidates')
  const { engine } = await import('../../../src/pipeline/engine')
  const { db } = await import('../../../src/db')
  const { pipelineRuns, genTasks, pipelineSteps } = await import('../../../src/db/schema')
  const startRun = engine.startRun
  let starts = 0
  engine.startRun = ((runId: number) => { void runId; starts++; return 'started' }) as typeof engine.startRun
  const fetch0 = globalThis.fetch
  let netCalls = 0
  globalThis.fetch = async (...a: Parameters<typeof fetch>) => { netCalls++; return fetch0(...a) }
  try {
    const { f, captions, compose } = await seedDeliveredDialogue(plan)
    await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, f.run.id))
    const before = netCalls
    await recomposeCreation(f.session.id, { idempotencyKey: 'm44-rc-1' })
    const capStep = (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, f.run.id), eq(pipelineSteps.stepKey, 'captions'))))[0]!
    const compStep = (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, f.run.id), eq(pipelineSteps.stepKey, 'compose'))))[0]!
    const asr = await db.select().from(genTasks).where(and(eq(genTasks.runId, f.run.id), eq(genTasks.kind, 'asr')))
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, f.run.id))
    // 转写与合成同时失效、陈旧字幕与旧审阅产出清空
    check(!!captions && !!compose && capStep.status === 'pending' && capStep.output === null && compStep.status === 'pending' && compStep.output === null, '对白重合成同时失效逐镜转写与合成，清空陈旧字幕产出与旧最终审阅')
    // 零模型：ASR 任务保持成功未归零/未删除，供缓存复用
    check(asr.length === plan.shots.length && asr.every((t) => t.status === 'succeeded' && t.attempts === 1), '重合成不归零或删除 ASR 任务，确保复用缓存零重付费')
    check(run!.status === 'queued' && starts === 1, '重合成触发达一次续跑并置 run 排队')
    // 幂等：同 idempotencyKey 重放不再二次重置/续跑
    const replay = await recomposeCreation(f.session.id, { idempotencyKey: 'm44-rc-1' })
    check(replay.runId === null && starts === 1, '同幂等键重放不重复重置或续跑')
    check(netCalls === before, '重合成决策阶段零联网')
  } finally { engine.startRun = startRun; globalThis.fetch = fetch0 }
}
