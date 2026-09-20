import { writeFileSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { genTasks, pipelineRuns } from '../../db/schema'
import { recipeOf, mediaFailure } from '../../services/creation-chat/recipe'
import { resolveAudioEndpoint, resolveEmotionPayload, synthSpeech } from '../../services/tts'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf } from '../../services/storage'
import { recordUsage } from '../../services/usage'
import { emitStudioEvent } from '../../services/events'
import { strictVoicePlan } from './ffmpeg-merge/strict'
import { RunCancelledError, type StepResult } from '../types'
import type { StepContext } from '../context'

/** M30 单次付费提交＋台词级成功复用，不改变旧 TTS 的声线/重试链。 */
export async function strictTts(ctx: StepContext): Promise<StepResult> {
  const recipe = recipeOf(ctx.run)
  if (!recipe) throw new Error('严格配音缺少批准方案')
  const pin = recipe.endpoints.audio
  const assetIds: number[] = []
  const existing = await db.select().from(genTasks).where(and(eq(genTasks.runId, ctx.run.id), eq(genTasks.stepId, ctx.step.id)))
  for (const line of recipe.plan.lines) {
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, ctx.run.id))
    if (run?.status === 'cancelled') throw new RunCancelledError()
    let task = existing.find((t) => JSON.parse(t.params).lineId === line.id)
    if (task?.status === 'succeeded' && task.resultAssetId) {
      assetIds.push(task.resultAssetId)
      continue
    }
    if (task && task.attempts > 0) throw new Error('配音提交状态需核验，不能自动重发')
    const endpoint = await resolveAudioEndpoint(pin.provider, pin)
    if (!task) {
      [task] = await db.insert(genTasks).values({
        projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id,
        kind: 'audio', provider: pin.provider, model: pin.model, prompt: line.text,
        params: JSON.stringify({ lineId: line.id, configId: pin.configId }),
        status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
      }).returning()
    }
    await db.update(genTasks).set({ status: 'processing', attempts: 1, updatedAt: Date.now() }).where(eq(genTasks.id, task!.id))
    emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task!.id, status: 'processing' })
    try {
      // 情绪透传（同 tts.ts 模式）：仅当 audio 实例 extra 声明 emotion_param 才生效；透传完整 emotion_hint
      const emotionPayload = resolveEmotionPayload(line.emotion_hint ?? '', endpoint.emotion)
      const data = await synthSpeech(line.text, endpoint, { voice: recipe.voice, emotion: emotionPayload ?? undefined })
      ensureProjectDirs(ctx.run.projectId)
      const name = `${Date.now()}-voice-${line.id}.mp3`
      const relPath = relPathOf(ctx.run.projectId, 'voice', name)
      writeFileSync(absPathOf(relPath), data)
      const asset = await registerAsset(ctx.run.projectId, {
        runId: ctx.run.id, stepId: ctx.step.id, taskId: task!.id, kind: 'audio', purpose: 'voice',
        name, relPath, mime: 'audio/mpeg', ext: 'mp3', fileSize: data.byteLength,
        prompt: line.text, params: { lineId: line.id, voice: recipe.voice, provider: pin.provider, model: pin.model, emotionHint: line.emotion_hint ?? null, emotionSent: emotionPayload?.value ?? null },
      })
      await db.update(genTasks).set({ status: 'succeeded', resultAssetId: asset.id, updatedAt: Date.now(), completedAt: Date.now() }).where(eq(genTasks.id, task!.id))
      await recordUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id, taskId: task!.id, assetId: asset.id,
        kind: 'tts', provider: pin.provider, model: pin.model, quantity: line.text.length, unit: 'char', unitPrice: pin.unitPrice })
      assetIds.push(asset.id)
      emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task!.id, status: 'succeeded' })
    } catch (error) {
      const message = mediaFailure(error, true)
      await db.update(genTasks).set({ status: 'failed', errorMsg: message, updatedAt: Date.now() }).where(eq(genTasks.id, task!.id))
      throw new Error(message)
    }
  }
  strictVoicePlan(recipe.plan, await ctx.assetsOf(assetIds), ctx.run.projectId)
  ctx.log('逐镜旁白时长检查通过，允许开始生成镜头')
  return { assetIds }
}
