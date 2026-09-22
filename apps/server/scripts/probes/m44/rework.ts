import { and, eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'
import { seedDialogueRun } from './fixture'

const NEW_MOTION = '镜头缓推，两人转向书架，神情焦急地翻找'

/**
 * 对白局部返修（服务层）：改一镜动态提示词 → 重编译该镜完整请求（非裸提示词）、
 * 只失效该镜转写/全片字幕/合成/最终审阅、返修预算含该镜视频与 ASR，未受影响镜一律不重做。
 * engine.startRun 打桩，只验返修后的任务/步骤状态与费用，不跑媒体。
 */
async function seedCompletedDialogue(plan: CreationPlan) {
  const { db } = await import('../../../src/db')
  const { genTasks, pipelineSteps } = await import('../../../src/db/schema')
  const { compileDialogueShot } = await import('../../../src/services/creation-chat/dialogue')
  const f = await seedDialogueRun(plan)
  const now = Date.now()
  const rows = await db.insert(pipelineSteps).values(f.template.steps.map((s, seq) => ({
    runId: f.run.id, seq, stepKey: s.key, actionKey: s.action, title: s.title,
    status: s.key === 'frames' ? 'skipped' : 'succeeded',
    createdAt: now, updatedAt: now,
  }))).returning()
  const byKey = new Map(rows.map((r) => [r.stepKey, r] as const))
  const motion = byKey.get('motion')!
  const captions = byKey.get('captions')!
  const clipAsset = f.recipe.sources[0]!.id
  const videoTasks = plan.shots.map((s) => ({
    projectId: f.project.id, runId: f.run.id, stepId: motion.id, kind: 'video', provider: 'volcengine_video',
    model: 'doubao-seedance-2-0-260128', prompt: compileDialogueShot(plan, s.id).prompt,
    params: JSON.stringify({ shotId: s.id, dialogueHash: compileDialogueShot(plan, s.id).dialogueHash }),
    status: 'succeeded', attempts: 1, taskId: 'vid-' + s.id, resultAssetId: clipAsset, createdAt: now, updatedAt: now,
  }))
  const asrTasks = plan.shots.map((s) => ({
    projectId: f.project.id, runId: f.run.id, stepId: captions.id, kind: 'asr', provider: 'openai_audio', model: 'whisper-1',
    prompt: '', params: JSON.stringify({ shotId: s.id }), status: 'succeeded', attempts: 1, resultAssetId: clipAsset, createdAt: now, updatedAt: now,
  }))
  await db.insert(genTasks).values([...videoTasks, ...asrTasks])
  return { f, db, genTasks, pipelineSteps, compileDialogueShot }
}

export async function probeDialogueRework({ check }: Checker, plan: CreationPlan): Promise<void> {
  const { applyRework } = await import('../../../src/services/creation-chat/rework')
  const { engine } = await import('../../../src/pipeline/engine')
  const startRun = engine.startRun
  let starts = 0
  engine.startRun = ((runId: number) => { void runId; starts++; return 'started' }) as typeof engine.startRun
  try {
    const { f, db, genTasks, pipelineSteps, compileDialogueShot } = await seedCompletedDialogue(plan)
    const reworked = { ...plan, shots: plan.shots.map((s) => (s.id === 's2' ? { ...s, motion_prompt: NEW_MOTION } : s)) }
    await applyRework(f.session.id, {
      planRevision: f.session.planRevision, planHash: f.session.planHash, idempotencyKey: 'm44-rw-1', acceptUnpriced: false,
      ops: [{ shot_id: 's2', motion_prompt: NEW_MOTION }],
    })
    // 目标镜：重置为待办、重编译完整请求（含逐字台词与角色外貌）、清外部任务号以便重新生成
    const s2 = (await db.select().from(genTasks).where(and(eq(genTasks.kind, 'video'), eq(genTasks.runId, f.run.id)))
      .then((rs) => rs.find((t) => JSON.parse(String(t.params)).shotId === 's2')))!
    check(!!s2 && s2.status === 'pending' && s2.attempts === 0 && s2.taskId === null, '返修目标镜视频归零待办并清空外部任务号（重新提交而非轮询旧任务）')
    check(!!s2 && s2.prompt === compileDialogueShot(reworked as CreationPlan, 's2').prompt, '返修重编译该镜完整批准请求，而不是把裸运动提示词写回任务')
    check(!!s2 && s2.prompt!.includes(plan.lines.find((l) => l.id === 'l2')!.text) && s2.prompt!.includes(plan.cast?.[0]?.appearance ?? '\u0000'), '重编译请求仍包含逐字台词与角色外貌，台词送错镜或漏角色会在此暴露')
    // 未受影响镜：视频仍成功，转写仍成功
    const videos = await db.select().from(genTasks).where(and(eq(genTasks.kind, 'video'), eq(genTasks.runId, f.run.id)))
    const untouchedSucceeded = ['s1', 's3', 's4'].every((id) => videos.find((t) => JSON.parse(String(t.params)).shotId === id)?.status === 'succeeded')
    check(untouchedSucceeded, '未受影响的镜头视频保持成功，不被重做')
    // 目标镜转写失效（删除以按新原声重转写），其余镜转写保留（复用零重付费）
    const asr = await db.select().from(genTasks).where(and(eq(genTasks.kind, 'asr'), eq(genTasks.runId, f.run.id)))
    const asrShots = asr.map((t) => JSON.parse(String(t.params)).shotId as string)
    const keptAsrSucceeded = ['s1', 's3', 's4'].every((id) => asr.find((t) => JSON.parse(String(t.params)).shotId === id)?.status === 'succeeded')
    check(!asrShots.includes('s2') && keptAsrSucceeded && asr.length === 3, '只失效返修镜的转写任务，其余镜转写保留可复用缓存')
    // 全片字幕与合成/最终审阅失效
    const capStep = (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, f.run.id), eq(pipelineSteps.stepKey, 'captions'))))[0]!
    const compStep = (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, f.run.id), eq(pipelineSteps.stepKey, 'compose'))))[0]!
    check(capStep.status === 'pending' && capStep.output === null && compStep.status === 'pending', '失效该镜转写并重做全片字幕与合成，旧最终审阅作废')
    // 预算含该镜视频与 ASR
    const { creationMessages } = await import('../../../src/db/schema')
    const msg = (await db.select().from(creationMessages).where(and(eq(creationMessages.sessionId, f.session.id), eq(creationMessages.requestKey, 'm44-rw-1'))))[0]!
    const estimate = JSON.parse(String(msg.payload)).estimate as { knownCost: number; unpriced: string[] }
    const secs = f.recipe.requestDurations.s2 ?? 8
    const expected = (f.recipe.endpoints.video!.unitPrice ?? 0) * secs + (f.recipe.asr!.unitPrice ?? 0) * secs
    check(estimate.unpriced.length === 0 && Math.abs(estimate.knownCost - expected) < 1e-6 && expected > (f.recipe.endpoints.video!.unitPrice ?? 0) * secs, '对白返修费用同时计入该镜视频与 ASR，不只报视频价')
    check(starts === 1, '返修确认后触发达一次续跑')
  } finally { engine.startRun = startRun }
}
