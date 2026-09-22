import { eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'
import { seedDialogueRun } from './fixture'

/**
 * 对白恢复闭环（服务层）：ASR 批准快照漂移即阻止、已存原始响应的失败转写不被当作结果不明、
 * 已成功任务零重做零重复计费。engine.startRun 打桩，只验恢复决策不跑媒体。
 */
async function setupDialogue({ db, pipelineSteps, genTasks }: {
  db: typeof import('../../../src/db').db
  pipelineSteps: typeof import('../../../src/db/schema').pipelineSteps
  genTasks: typeof import('../../../src/db/schema').genTasks
}, plan: CreationPlan, f: Awaited<ReturnType<typeof seedDialogueRun>>, asr: { status: string; attempts: number; resultAssetId: number | null }) {
  const now = Date.now()
  const steps = await db.insert(pipelineSteps).values(f.template.steps.map((s, seq) => ({
    runId: f.run.id, seq, stepKey: s.key, actionKey: s.action, title: s.title,
    status: s.key === 'frames' ? 'skipped' : s.key === 'motion' ? 'succeeded' : s.key === 'captions' ? 'failed' : 'pending',
    createdAt: now, updatedAt: now,
  }))).returning()
  const motion = steps.find((s) => s.stepKey === 'motion')!
  const captions = steps.find((s) => s.stepKey === 'captions')!
  const videoTaskId = f.recipe.sources[0]!.id
  await db.insert(genTasks).values([
    ...plan.shots.map((s) => ({ projectId: f.project.id, runId: f.run.id, stepId: motion.id, kind: 'video', provider: 'volcengine_video', model: 'doubao-seedance-2-0-260128', prompt: '', params: JSON.stringify({ shotId: s.id }), status: 'succeeded', attempts: 1, taskId: 'vid-' + s.id, resultAssetId: videoTaskId, createdAt: now, updatedAt: now })),
    { projectId: f.project.id, runId: f.run.id, stepId: captions.id, kind: 'asr', provider: 'openai_audio', model: 'whisper-1', prompt: '', params: JSON.stringify({ shotId: 's1' }), status: asr.status, attempts: asr.attempts, resultAssetId: asr.resultAssetId, createdAt: now, updatedAt: now },
  ])
  return { steps, captions }
}

export async function probeDialogueRecovery({ check }: Checker, plan: CreationPlan): Promise<void> {
  const { db } = await import('../../../src/db')
  const { apiConfigs, genTasks, pipelineRuns, pipelineSteps } = await import('../../../src/db/schema')
  const { retryCreation } = await import('../../../src/services/creation-chat/execution')
  const { CreationError } = await import('../../../src/services/creation-chat/contract')
  const { engine } = await import('../../../src/pipeline/engine')
  const startRun = engine.startRun
  let starts = 0
  engine.startRun = ((runId: number) => { void runId; starts++; return 'started' }) as typeof engine.startRun
  const fetch0 = globalThis.fetch
  let netCalls = 0
  globalThis.fetch = async (...a: Parameters<typeof fetch>) => { netCalls++; return fetch0(...a) }
  try {
    // 场景 A：严格 ASR 实例配置漂移 → 恢复前阻止，不进入复制。
    {
      const f = await seedDialogueRun(plan)
      await setupDialogue({ db, pipelineSteps, genTasks }, plan, f, { status: 'failed', attempts: 1, resultAssetId: f.recipe.sources[0]!.id })
      await db.update(apiConfigs).set({ pricing: JSON.stringify({ asr: { model: 'whisper-1', second: 0.09 } }) }).where(eq(apiConfigs.id, f.recipe.asr!.configId))
      let code = ''
      try { await retryCreation(f.session.id, { runId: f.run.id, planRevision: f.session.planRevision, planHash: f.session.planHash, idempotencyKey: 'm44-rec-a' }) }
      catch (err) { code = err instanceof CreationError ? err.code : '' }
      check(code === 'asr_configuration_changed', '恢复沿用批准的严格 ASR 快照，配置漂移时阻止而不是偷偷换实例')
    }
    // 场景 B：转写已落原始响应、仅校验未过 → 不被当作结果不明，恢复成功且零联网零重发。
    {
      const f = await seedDialogueRun(plan)
      await setupDialogue({ db, pipelineSteps, genTasks }, plan, f, { status: 'failed', attempts: 1, resultAssetId: f.recipe.sources[0]!.id })
      const before = netCalls
      const res = await retryCreation(f.session.id, { runId: f.run.id, planRevision: f.session.planRevision, planHash: f.session.planHash, idempotencyKey: 'm44-rec-b' })
      const copiedVideo = await db.select().from(genTasks).where(eq(genTasks.kind, 'video'))
      const copiedAsr = await db.select().from(genTasks).where(eq(genTasks.kind, 'asr'))
      const newRun = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, res.runId)))[0]!
      check(starts === 1 && netCalls === before, '已捕获原始响应的失败转写恢复不强制人工核验也不自动重发请求')
      check(newRun.status === 'queued' && copiedVideo.filter((t) => t.runId === res.runId && t.status === 'succeeded').length === 4 && copiedAsr.filter((t) => t.runId === res.runId && t.status === 'pending').length === 1, '恢复新 run 复用已成功视频、转写回待办且不重复计费')
    }
    // 场景 C：ASR 有提交次数但无已捕获产物（受理状态确实不明）→ 仍要求显式核验。
    {
      const f = await seedDialogueRun(plan)
      await setupDialogue({ db, pipelineSteps, genTasks }, plan, f, { status: 'failed', attempts: 1, resultAssetId: null })
      let code = ''
      try { await retryCreation(f.session.id, { runId: f.run.id, planRevision: f.session.planRevision, planHash: f.session.planHash, idempotencyKey: 'm44-rec-c' }) }
      catch (err) { code = err instanceof CreationError ? err.code : '' }
      check(code === 'needs_verification', '结果确实不明的 ASR 提交仍阻止自动重发，要求显式核验')
    }
  } finally { engine.startRun = startRun; globalThis.fetch = fetch0 }
}
