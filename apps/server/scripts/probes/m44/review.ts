import { eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'
import { seedDialogueRun } from './fixture'

export async function probeDialogueReview({ check }: Checker, plan: CreationPlan): Promise<void> {
  const { db } = await import('../../../src/db')
  const { assets, creationMessages, genTasks, pipelineRuns, pipelineSteps } = await import('../../../src/db/schema')
  const { registerAsset } = await import('../../../src/services/storage')
  const { loadCreationProjection } = await import('../../../src/services/creation-chat/projection')
  const { decideCreationGate } = await import('../../../src/services/creation-chat/gate')
  const { engine } = await import('../../../src/pipeline/engine')
  const f = await seedDialogueRun(plan)
  const now = Date.now()
  const steps = await db.insert(pipelineSteps).values(f.template.steps.map((s, seq) => ({ runId: f.run.id, seq, stepKey: s.key, actionKey: s.action,
    title: s.title, status: s.key === 'compose' ? 'waiting_input' : s.key === 'frames' ? 'skipped' : 'succeeded', createdAt: now, updatedAt: now }))).returning()
  const compose = steps.find((s) => s.stepKey === 'compose')!
  const captions = steps.find((s) => s.stepKey === 'captions')!
  const [src] = await db.select().from(assets).where(eq(assets.id, f.recipe.sources[0]!.id))
  // 投影单元夹具只检查资产关联/可读性；真实视频解码另由媒体探针覆盖。
  const final = await registerAsset(f.project.id, { name: '本轮成片', kind: 'video', purpose: 'final_video', relPath: src!.relPath!, runId: f.run.id, stepId: compose.id, params: { delivery_checked: true, performance: 'dialogue', dialogue_review_required: true } })
  const stale = await registerAsset(f.project.id, { name: '不能误选的新历史成片', kind: 'video', purpose: 'final_video', relPath: src!.relPath!, runId: f.run.id, stepId: compose.id, params: { delivery_checked: true } })
  await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [final.id] }) }).where(eq(pipelineSteps.id, compose.id))
  await db.update(pipelineRuns).set({ status: 'waiting_input', currentStepKey: 'compose' }).where(eq(pipelineRuns.id, f.run.id))
  await db.insert(genTasks).values(plan.shots.map((s) => ({ projectId: f.project.id, runId: f.run.id, stepId: captions.id, kind: 'asr', provider: 'openai_audio', model: 'whisper-1', prompt: '', params: JSON.stringify({ shotId: s.id }), status: 'succeeded', createdAt: now, updatedAt: now })))
  const projection = async () => {
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, f.run.id))
    return loadCreationProjection(f.session, run!, await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, f.run.id)), await db.select().from(genTasks).where(eq(genTasks.runId, f.run.id)))
  }
  const p = await projection()
  const review = p.progress.review as { videoId?: number; kind?: string } | null
  check(p.result === null && review?.videoId === final.id && review.kind === 'dialogue', '等待审阅阶段可预览本轮成片，不依赖 completed 的 result，也不误取历史成片')
  check(p.progress.stages.find((s) => s.key === 'captions')?.completed === 4 && p.progress.stages.find((s) => s.key === 'voice')?.applicable === false, '对白阶段计数使用逐镜 ASR，不展示虚假 TTS')
  const start = engine.startRun
  let starts = 0
  engine.startRun = () => { starts++; return 'started' }
  try {
    const request = { stepKey: 'compose', decision: 'reject', note: '口型不接受', idempotencyKey: 'm44-review-reject-1' }
    await decideCreationGate(f.session.id, request)
    await decideCreationGate(f.session.id, request)
    const messages = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, f.session.id))
    check(starts === 0 && messages.length === 1 && messages[0]!.content.includes('保留') && !messages[0]!.content.includes('再次调用'), '会话拒绝幂等且明确保留成果，不提示自动付费重做')
    await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, f.run.id))
    check((await projection()).result === null && (await projection()).progress.status === 'failed', '技术合格但未人工批准不能被投影为成功交付')
    await db.update(pipelineRuns).set({ status: 'waiting_input' }).where(eq(pipelineRuns.id, f.run.id))
    await db.update(pipelineSteps).set({ status: 'waiting_input', output: JSON.stringify({ asset_ids: [stale.id] }) }).where(eq(pipelineSteps.id, compose.id))
    let rejected = false
    try { await decideCreationGate(f.session.id, { ...request, decision: 'approve', idempotencyKey: 'm44-review-invalid-1' }) } catch { rejected = true }
    check(rejected && starts === 0, '缺少本轮对白技术检查的产物不能批准交付')
  } finally { engine.startRun = start }
}
