import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { requestTimestampedTranscription } from '@agencys/ai-provider-kit'
import { db } from '../../db'
import { assets, genTasks, pipelineRuns, usageRecords } from '../../db/schema'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf, sha256Hex, writeTextAsset } from '../../services/storage'
import { recipeOf } from '../../services/creation-chat/recipe'
import { hashJson } from '../../services/creation-chat/contract'
import { dialogueSource, findDialogueResponse, validatedDialogueClip } from '../../services/creation-chat/dialogue-cache'
import { dialogueSrt, extractDialogueAudio } from '../../services/creation-chat/dialogue-media'
import { resolveStrictAsrEndpoint } from '../../services/strict-asr'
import { emitStudioEvent } from '../../services/events'
import { RunCancelledError, type StepResult } from '../types'
import type { StepContext } from '../context'

/** 逐镜原声转写：付费结果与计费同事务保存，校验失败也保留原始诊断，永不自动重发。 */
export async function dialogueSubtitle(ctx: StepContext): Promise<StepResult> {
  const recipe = recipeOf(ctx.run)
  if (!recipe?.asr || recipe.plan.performance !== 'dialogue') throw new Error('严格对白字幕缺少批准方案')
  const pin = recipe.asr
  await resolveStrictAsrEndpoint(pin)
  const ids = ctx.assetIdsOf('motion_clips')
  const rows = await ctx.assetsOf(ids)
  if (ids.length !== recipe.plan.shots.length || new Set(ids).size !== ids.length || rows.length !== ids.length) throw new Error('对白视频镜头数量不匹配')
  // 全部镜头先校验归属和批准指纹，避免发现错素材前已支付部分 ASR。
  const sources = recipe.plan.shots.map((shot) => {
    const matched = rows.filter((a) => JSON.parse(a.params ?? '{}').shotId === shot.id)
    if (matched.length !== 1) throw new Error(`镜头 ${shot.id} 缺少唯一原声视频`)
    return { asset: matched[0]!, source: dialogueSource(recipe, shot.id, matched[0]!, ctx.run.projectId) }
  })
  const verified: Array<Awaited<ReturnType<typeof validatedDialogueClip>>> = []
  for (const { asset, source } of sources) {
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, ctx.run.id))
    if (!run || run.status === 'cancelled') throw new RunCancelledError()
    const task = await db.transaction(async (tx) => {
      const existing = await tx.select().from(genTasks).where(and(eq(genTasks.stepId, ctx.step.id), eq(genTasks.kind, 'asr')))
      // 按镜 + 原声摘要 + 批准台词指纹精确匹配：候选改选到同镜的另一段已转写版本时复用其任务，
      // 不把「同镜不同版本」误判为输入被篡改（改选只走带缓存校验的候选通道，缓存缺失则新镜首次付费转写，符合语义）。
      const old = existing.find((t) => { const p = JSON.parse(t.params); return p.shotId === source.shotId && p.cacheKey === source.cacheKey && p.dialogueHash === source.dialogueHash })
      if (old) return old
      const [created] = await tx.insert(genTasks).values({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id,
        kind: 'asr', provider: pin.provider, model: pin.model, params: JSON.stringify({ ...source, configId: pin.configId, configHash: pin.configHash }),
        createdAt: Date.now(), updatedAt: Date.now() }).returning()
      return created!
    })
    try {
      let cached = await findDialogueResponse(ctx.run.projectId, source)
      if (!cached) {
        if (task.attempts > 0) throw new Error('此前 ASR 提交结果需核验，不能自动重发；可能已计费')
        const endpoint = await resolveStrictAsrEndpoint(pin)
        ensureProjectDirs(ctx.run.projectId)
        const relPath = relPathOf(ctx.run.projectId, 'dialogue_audio', `${randomUUID()}.wav`)
        const timing = extractDialogueAudio(absPathOf(asset.relPath!), absPathOf(relPath))
        if (dialogueSource(recipe, source.shotId, asset, ctx.run.projectId).sourceHash !== source.sourceHash) throw new Error('抽取过程中原声视频已变化')
        const audio = readFileSync(absPathOf(relPath))
        const audioAsset = await registerAsset(ctx.run.projectId, { name: `${source.shotId} 原声音轨`, kind: 'audio', purpose: 'dialogue_audio', relPath,
          mime: 'audio/wav', ext: 'wav', fileSize: audio.length, sha256: sha256Hex(audio), duration: timing.audioDuration,
          runId: ctx.run.id, stepId: ctx.step.id, taskId: task.id, params: { ...source, timing } })
        await db.transaction(async (tx) => {
          const prior = await tx.select().from(genTasks).where(and(eq(genTasks.projectId, ctx.run.projectId), eq(genTasks.kind, 'asr')))
          if (prior.some((t) => t.attempts > 0 && JSON.parse(t.params).cacheKey === source.cacheKey)) throw new Error('相同原声已有 ASR 提交记录，必须核验结果后恢复，禁止重复付费')
          const claimed = await tx.update(genTasks).set({ attempts: 1, status: 'processing', errorMsg: null, updatedAt: Date.now(),
            params: JSON.stringify({ ...JSON.parse(task.params), audioAssetId: audioAsset.id, submittedSeconds: timing.audioDuration }) }).where(and(eq(genTasks.id, task.id), eq(genTasks.attempts, 0))).returning()
          if (claimed.length !== 1) throw new Error('ASR 任务已被执行，禁止重复提交')
        })
        emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'processing' })
        const raw = await requestTimestampedTranscription({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, model: pin.model, audio })
        const data = { cacheKey: source.cacheKey, sourceHash: source.sourceHash, timing, raw }
        const responseAsset = await db.transaction(async (tx) => {
          const result = await writeTextAsset(ctx.run.projectId, { name: `${randomUUID()}-transcript`, content: JSON.stringify(data), purpose: 'dialogue_transcript', format: 'dialogue-transcript-json',
            runId: ctx.run.id, stepId: ctx.step.id, taskId: task.id, params: { ...source, audioAssetId: audioAsset.id } }, tx)
          await tx.insert(usageRecords).values({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id, taskId: task.id, assetId: result.id,
            kind: 'asr', provider: pin.provider, model: pin.model, quantity: timing.audioDuration, unit: 'second', unitPrice: pin.unitPrice,
            cost: pin.unitPrice === null ? null : Math.round(timing.audioDuration * pin.unitPrice * 1e6) / 1e6, createdAt: Date.now() })
          await tx.update(genTasks).set({ resultAssetId: result.id, updatedAt: Date.now() }).where(eq(genTasks.id, task.id))
          return result
        })
        cached = { asset: responseAsset, data }
      }
      verified.push(await validatedDialogueClip(recipe, source.shotId, asset, ctx.run.projectId))
      await db.update(genTasks).set({ status: 'succeeded', resultAssetId: cached.asset.id, errorMsg: null, completedAt: Date.now(), updatedAt: Date.now() }).where(eq(genTasks.id, task.id))
      emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'succeeded' })
    } catch (error) {
      const message = `镜头 ${source.shotId} 原声核验失败：${error instanceof Error ? error.message : '未知错误'}`
      await db.update(genTasks).set({ status: 'failed', errorMsg: message, updatedAt: Date.now() }).where(eq(genTasks.id, task.id))
      emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'failed', error: message })
      throw new Error(message)
    }
  }
  const content = dialogueSrt(verified)
  const validationHash = hashJson({ policy: pin.policy, clips: verified })
  const old = await db.select().from(assets).where(and(eq(assets.runId, ctx.run.id), eq(assets.purpose, 'subtitle'), isNull(assets.deletedAt)))
  for (const asset of old) {
    if (JSON.parse(asset.params ?? '{}').validationHash !== validationHash) continue
    if (!asset.relPath || sha256Hex(readFileSync(absPathOf(asset.relPath))) !== sha256Hex(Buffer.from(content))) throw new Error('实测字幕缓存内容已变化')
    return { assetIds: [asset.id] }
  }
  const subtitle = await writeTextAsset(ctx.run.projectId, { name: `${randomUUID()}-dialogue`, content, purpose: 'subtitle', format: 'srt', runId: ctx.run.id, stepId: ctx.step.id,
    params: { performance: 'dialogue', validationHash, clips: verified, durationMs: recipe.plan.duration * 1000 } })
  ctx.log('逐镜原声台词与时间戳校验通过；说话角色和口型仍需人工审阅')
  return { assetIds: [subtitle.id] }
}
