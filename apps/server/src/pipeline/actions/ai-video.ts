import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { assets, genTasks, pipelineRuns, type CharacterRow, type GenTask } from '../../db/schema'
import { buildVideoRequest, getVideoAdapter } from '../../adapters/video'
import { resolveEndpoint } from '../../adapters/provider'
import type { VideoAdapter, VideoGenRequest } from '../../adapters/types'
import { assetToDataUri } from '../../services/asset-ref'
import { loadEntityIndex } from '../../services/character'
import { probeMediaDuration } from '../../services/ffmpeg'
import { absPathOf } from '../../services/storage'
import { saveGeneratedMedia } from '../../services/net'
import { emitStudioEvent } from '../../services/events'
import { shotDurationSec } from '../../services/shot'
import { parseShotLines, planAudioDrivenShotDurations } from './ffmpeg-merge/align'
import { lineIdOfVoiceAsset } from './ffmpeg-merge/segments'
import { recordUsage } from '../../services/usage'
import { normalizePositiveIds } from '../refs'
import type { StepContext } from '../context'
import type { StepResult } from '../types'
import { RunCancelledError } from '../types'
import { pinOf, recipeOf, mediaFailure, recipeFirstFrameId, isCreationTemplate } from '../../services/creation-chat/recipe'
import { compileDialogueShot, dialogueAudioOptions } from '../../services/creation-chat/dialogue'
import { dialogueSource } from '../../services/creation-chat/dialogue-cache'
import { inspectDialogueMedia } from '../../services/creation-chat/dialogue-media'

interface ShotSpec {
  id: string
  image_prompt: string
  duration?: number
  /** [M13] 场景名（与场景库对齐）：命中 → 注入场景参考图（无首帧时） */
  location?: string
  /** [M13] 道具名列表（与道具库对齐）：命中 → 注入道具参考图（无首帧时） */
  props?: string[]
  /** [M22] 画布/模板直通首帧资产（优先于 gen_frames 索引）；正整数 */
  first_frame_asset_id?: number
  /** [M22] 画布/模板直通参考资产（与场景/道具收集合并，保序去重）；正整数 */
  ref_asset_ids?: number[]
}

const nowMs = (): number => Date.now()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** 单镜头视频任务轮询上限（spec §5.1） */
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 10 * 60_000

/**
 * ai_video：批量镜头视频生成（spec §5.1，M2 启用）。
 * 输入 batch.field（默认 shots）→ 分镜 JSON 资产 → 每镜头一条 gen_task（kind=video）：
 * 适配器两形态——轮询型（提交拿 task_id → query 5s/次，超时 10min）与同步型（长请求直收
 * 字节，如 Pollinations）→ 均落盘为 video 资产（purpose=shot_video，params 溯源含 {taskId, provider}）。
 *
 * 提示词由 prompt_field 指定（缺省 shot.image_prompt；支持逗号回退链 'motion_prompt,image_prompt'）；
 * 首帧图（inputs.first_frame，M6）：gen_frames 产物按 params.shotId 匹配 → 供应商能力支持时转
 * data URI 驱动 i2v；能力不支持/缺图 → 降级纯文生（params.firstFrameAssetId 记快照）。
 * [M13] 场景/道具参考图（shot.location / shot.props 命中实体库）：无首帧图的镜头按 reference_image 注入
 * （首帧优先决策：有首帧则跳过，兼规避 Wan 帧/参考互斥）；params.setRefAssetIds 记快照。
 * [M22] 分镜直通字段（画布/模板写入）：first_frame_asset_id 优先于 gen_frames 索引；
 * ref_asset_ids 与场景/道具收集合并（保序去重），仍受首帧优先与 refCap 决策约束。
 * [以音定画] 接 inputs.voices（tts 逐句配音产物）时：逐镜视频时长 = 该镜台词句实测音频总长（planAudioDrivenShotDurations），
 * 优先于分镜 LLM 估长/兜底固定时长，使动效成片逐镜音画对齐；无 voices / 探测全失败 → 维持原分镜估长/兜底行为逐字不变。
 * 幂等：本 step 已 succeeded 的 task 跳过（断点续跑复用成功视频）；
 * failed 且 attempts 未超上限的 task 在本步重跑时自动补跑；
 * 未成功任务的 prompt/生成参数执行时与当前分镜/项目设置同步（修正分镜或调
 * 设置后续跑即生效），failed 且内容有变化的任务归零重排队。
 */
export async function aiVideo(ctx: StepContext): Promise<StepResult> {
  const batch = ctx.def.batch ?? { field: 'shots', maxConcurrent: 2, retry: 1 }
  const field = batch.field ?? 'shots'
  const concurrency = Math.max(1, batch.maxConcurrent ?? 2)
  const maxRetry = Math.max(0, batch.retry ?? 1)

  const shotIds = ctx.assetIdsOf(field)
  if (shotIds.length === 0) throw new Error(`inputs.${field} 无分镜资产`)
  const raw = await ctx.readText(shotIds[0]!)
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch (err) {
    throw new Error(`分镜 JSON 解析失败: ${(err as Error).message}`)
  }
  const shots: ShotSpec[] = Array.isArray(obj)
    ? (obj as ShotSpec[])
    : ((obj as { shots?: ShotSpec[] }).shots ?? [])
  if (!Array.isArray(shots) || shots.length === 0) throw new Error('分镜内容缺 shots 数组')
  const promptField = (ctx.def.params?.prompt_field as string | undefined) ?? 'image_prompt'
  // prompt 回退链（M6）：'motion_prompt,image_prompt' 形态——老分镜无 motion_prompt 时回退 image_prompt
  const promptFields = promptField.split(',').map((s) => s.trim()).filter(Boolean)
  for (const s of shots) {
    if (!pickPromptText(s as unknown as Record<string, unknown>, promptFields)) {
      throw new Error(`shot ${String(s?.id ?? '?')} 缺 ${promptField}`)
    }
  }

  const vidCfg = (ctx.settings.video ?? {}) as Record<string, unknown>
  const provider = typeof vidCfg['provider'] === 'string' ? vidCfg['provider'] : undefined
  const model = typeof vidCfg['model'] === 'string' ? vidCfg['model'] : undefined
  const fallbackDuration = typeof vidCfg['duration'] === 'number' ? vidCfg['duration'] : undefined
  const resolution = typeof vidCfg['resolution'] === 'string' ? vidCfg['resolution'] : undefined
  const aspectRatio = typeof vidCfg['aspect_ratio'] === 'string' ? vidCfg['aspect_ratio'] : undefined
  const episode = ctx.run.input ? safeGet(ctx.run.input, 'episode_number') : undefined

  ctx.log(
    `批量生成视频：${shots.length} 镜头 × ${provider ?? '默认供应商'}（并发 ${concurrency}，失败重试 ${maxRetry} 次，prompt 字段 ${promptField}）`,
  )

  // [以音定画] 逐镜视频时长跟随配音实测音频时长：动效模式合成按 clip 时长累计成片，令每镜 clip 长 = 该镜台词音频和即逐镜对齐。
  // 仅当本步接了 voices 输入（mengbao gen_motion）时启用；无 voices / 探测全失败 → audioDurByShot=null，维持原时长决策链。
  let audioDurByShot: Map<string, number> | null = null
  const voiceIds = ctx.assetIdsOf('voices')
  if (voiceIds.length > 0) {
    const voiceDur = new Map<string, number>()
    try {
      const vRows = await ctx.assetsOf(voiceIds)
      for (const a of vRows) {
        const lineId = lineIdOfVoiceAsset(a)
        if (!lineId || !a.relPath) continue
        const sec = probeMediaDuration(absPathOf(a.relPath))
        if (sec && sec > 0) voiceDur.set(lineId, sec)
      }
    } catch (err) {
      ctx.log(`配音时长探测失败（以音定画回退分镜估长）：${(err as Error).message}`)
    }
    if (voiceDur.size > 0) {
      const map = planAudioDrivenShotDurations(parseShotLines(raw).shots, voiceDur)
      if (map.size > 0) {
        audioDurByShot = map
        ctx.log(`以音定画：${map.size}/${shots.length} 镜视频时长改为跟随配音实测时长`)
      }
    }
  }

  // 首帧注入（M6）：gen_frames 产物按 params.shotId 建索引；能力判定入队前 resolve 一次
  const frameIds = ctx.assetIdsOf('first_frame')
  const frameIndex = await buildFirstFrameIndex(frameIds)
  const recipe = recipeOf(ctx.run)
  const audioOptions = recipe?.plan.performance === 'dialogue' ? dialogueAudioOptions(provider!, model!) : null
  if (audioOptions && (voiceIds.length || JSON.stringify(shots) !== JSON.stringify(recipe!.plan.shots))) throw new Error('对白视频输入必须与批准分镜一致且不能混入 TTS')
  const frameCap = recipe ? getVideoAdapter(provider!).firstFrame ?? 'none' : await videoFirstFrameCapability(provider)
  // [M31] 首帧参考覆盖：用户上传 first_frame ref 优先于 gen_frames 产物；本镜“有首帧”= 分镜直传/ref/gen_frames 任一
  const shotHasFirstFrame = (s: ShotSpec): boolean => shotFirstFrameOf(s) !== null || recipeFirstFrameId(recipe, s.id) !== null || frameIndex.has(s.id)
  if (recipe?.videoMode === 'i2v' && (frameCap === 'none' || shots.some((s) => !shotHasFirstFrame(s)))) {
    throw new Error('已批准图生视频方案首帧不可用，禁止降级文生视频')
  }
  const uriCache = new Map<number, string>()
  if (frameIds.length > 0) {
    if (frameCap === 'none') {
      ctx.log('当前视频供应商不支持首帧注入，已降级纯文生')
    } else {
      const missing = shots.filter((s) => !frameIndex.has(s.id)).length
      if (missing > 0) ctx.log(`${missing} 镜无首帧图（降级纯文生）`)
    }
  }

  // [M13] 场景/道具参考图：实体索引 + 能力判定（入队前 resolve 一次；首帧优先决策在执行期）
  const sceneIndex = await loadEntityIndex(ctx.run.projectId, 'scene')
  const propIndex = await loadEntityIndex(ctx.run.projectId, 'prop')
  const refCap = recipe ? getVideoAdapter(provider!).referenceImages ?? 'none' : await videoReferenceCapability(provider)
  if (refCap === 'none' && shots.some((s) => collectSetRefAssetIds(s, sceneIndex, propIndex).length > 0)) {
    ctx.log('当前视频供应商不支持参考图注入（场景/道具参考图降级跳过）')
  }

  // 既有任务（幂等续跑）：shotId → task 行
  const existing = await db
    .select()
    .from(genTasks)
    .where(and(eq(genTasks.runId, ctx.run.id), eq(genTasks.stepId, ctx.step.id)))
  const taskByShotId = new Map<string, GenTask>()
  for (const t of existing) {
    try {
      const p = JSON.parse(t.params) as { shotId?: string }
      if (p.shotId) taskByShotId.set(p.shotId, t)
    } catch {
      // 参数损坏任务：跳过（不参与队列也不视为成功）
    }
  }

  for (const shot of shots) {
    const compiled = audioOptions ? compileDialogueShot(recipe!.plan, shot.id) : null
    const promptText = compiled?.prompt ?? pickPromptText(shot as unknown as Record<string, unknown>, promptFields)
    const paramsJson = JSON.stringify({
      shotId: shot.id,
      duration: recipe?.requestDurations[shot.id] ?? audioDurByShot?.get(shot.id) ?? shotDurationSec(shot) ?? fallbackDuration ?? null,
      resolution: resolution ?? null,
      aspectRatio: aspectRatio ?? null,
      episode: episode ?? null,
      firstFrameAssetId: shotFirstFrameOf(shot) ?? recipeFirstFrameId(recipe, shot.id) ?? frameIndex.get(shot.id) ?? null,
      setRefAssetIds: audioOptions ? [] : normalizePositiveIds([...(shot.ref_asset_ids ?? []), ...collectSetRefAssetIds(shot, sceneIndex, propIndex)]),
      ...(compiled ? { dialogueHash: compiled.dialogueHash, audioOptions } : {}),
    })
    const existingTask = taskByShotId.get(shot.id)
    if (!existingTask) {
      const t = nowMs()
      const row = await db
        .insert(genTasks)
        .values({
          projectId: ctx.run.projectId,
          runId: ctx.run.id,
          stepId: ctx.step.id,
          kind: 'video',
          provider: provider ?? null,
          model: model ?? null,
          prompt: promptText,
          params: paramsJson,
          status: 'pending',
          attempts: 0,
          createdAt: t,
          updatedAt: t,
        })
        .returning()
      taskByShotId.set(shot.id, row[0]!)
    } else if (existingTask.status !== 'succeeded' && existingTask.status !== 'cancelled') {
      // 未成功任务同步最新 prompt/参数：用户修正分镜（如内容审核改词）或调整
      // 项目 video 设置后，断点续跑/重跑即生效；failed 且有变化 → 归零重排队
      // （与 resume 迁移语义一致）；succeeded 保持产物溯源不动
      const changed = existingTask.prompt !== promptText || existingTask.params !== paramsJson
      if (changed) {
        if (recipe) throw new Error('已批准视频任务参数发生变化，请重新规划')
        const requeue = existingTask.status === 'failed'
        await db
          .update(genTasks)
          .set({
            prompt: promptText,
            params: paramsJson,
            ...(requeue ? { status: 'pending', attempts: 0, errorMsg: null } : {}),
            updatedAt: nowMs(),
          })
          .where(eq(genTasks.id, existingTask.id))
        existingTask.prompt = promptText
        existingTask.params = paramsJson
        if (requeue) {
          existingTask.status = 'pending'
          existingTask.attempts = 0
          existingTask.errorMsg = null
        }
      }
    }
  }

  // 执行队列：非 succeeded 且有重试余量；cancelled 不参与
  const queue = shots
    .map((s) => taskByShotId.get(s.id)!)
    .filter((t) => {
      if (t.status === 'succeeded' || t.status === 'cancelled') return false
      if (t.status === 'failed' && t.attempts > maxRetry) return false
      return true
    })
  const doneCount = shots.length - queue.length
  if (doneCount > 0) ctx.log(`跳过已有成功产物的 ${doneCount} 个镜头`)
  if (queue.length === 0) ctx.log('全部镜头已有成功产物，无新生成')

  const failures: Array<{ shotId: string; error: string }> = []
  await runPool(queue, concurrency, async (task) => {
    const fail = await runOneTask(ctx, task, { provider, model, maxRetry, frameCap, uriCache, refCap })
    if (fail) failures.push(fail)
  })

  if (failures.length > 0) {
    const sample = failures
      .slice(0, 3)
      .map((f) => `shot ${f.shotId}: ${f.error}`)
      .join('；')
    throw new Error(`视频生成失败 ${failures.length} 个镜头（可修正后断点续跑/重试任务）：${sample}`)
  }

  // 产物按 shots 顺序聚合
  const assetIds = shots
    .map((s) => taskByShotId.get(s.id)!.resultAssetId)
    .filter((id): id is number => typeof id === 'number')
  if (assetIds.length !== shots.length) {
    throw new Error(`产物与镜头数不符（${assetIds.length}/${shots.length}），请重试`)
  }
  if (audioOptions && recipe) {
    if (shots.some((s) => taskByShotId.get(s.id)?.status !== 'succeeded')) throw new Error('原声视频核验未通过，已有产物保留，请返修对应镜头')
    const outputs = await ctx.assetsOf(assetIds)
    for (const [i, asset] of outputs.entries()) {
      dialogueSource(recipe, shots[i]!.id, asset, ctx.run.projectId)
      inspectDialogueMedia(absPathOf(asset.relPath!))
    }
  }
  ctx.log(`视频生成完成：${assetIds.length} 段 → ${assetIds.join(', ')}`)
  return { assetIds }
}

/**
 * gen_frames 产物 → shotId 索引（首帧匹配，M6，供探针直接断言）：
 * 逐行取 params.shotId 建 Map（同 shotId 重复 → 后到覆盖）；非图 / 参数损坏行跳过（不抛）。
 */
export async function buildFirstFrameIndex(assetIds: number[]): Promise<Map<string, number>> {
  const index = new Map<string, number>()
  if (assetIds.length === 0) return index
  const rows = await db.select().from(assets).where(inArray(assets.id, assetIds))
  for (const row of rows) {
    if (row.kind !== 'image') continue
    try {
      const p = JSON.parse(row.params ?? '') as { shotId?: unknown }
      if (typeof p.shotId === 'string' && p.shotId) index.set(p.shotId, row.id)
    } catch {
      // 参数损坏行：跳过（不参与匹配也不视为失败）
    }
  }
  return index
}

/** prompt 字段回退链：取首个非空字符串并 trim；全空 → ''（校验与入队共用，供探针直接断言） */
export function pickPromptText(shot: Record<string, unknown>, fields: string[]): string {
  for (const f of fields) {
    const v = shot[f]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/** 单任务执行：提交第三方 → 轮询 → 下载落盘；attempts 续增，达上限后不再重试 */
async function runOneTask(
  ctx: StepContext,
  task: GenTask,
  cfg: {
    provider?: string
    model?: string
    maxRetry: number
    frameCap: 'none' | 'base64' | 'as-reference'
    refCap: 'none' | 'base64'
    uriCache: Map<number, string>
  },
): Promise<{ shotId: string; error: string } | null> {
  const parsed = JSON.parse(task.params) as {
    shotId?: string
    duration?: number | null
    resolution?: string | null
    aspectRatio?: string | null
    firstFrameAssetId?: number | null
    setRefAssetIds?: unknown
  }
  const shotId = parsed.shotId ?? '?'
  const recipe = recipeOf(ctx.run)
  const maxAttempts = recipe ? 1 : cfg.maxRetry + 1
  if (recipe && task.attempts > 0 && !task.taskId && task.status !== 'succeeded') throw new Error('此前视频提交状态需核验，不能自动重发')
  let attempts = task.attempts
  for (;;) {
    if (await runCancelled(ctx.run.id)) {
      await db
        .update(genTasks)
        .set({ status: 'cancelled', errorMsg: 'run cancelled', updatedAt: nowMs() })
        .where(eq(genTasks.id, task.id))
      throw new RunCancelledError()
    }
    attempts += 1
    await db
      .update(genTasks)
      .set({ status: 'processing', attempts, errorMsg: null, updatedAt: nowMs() })
      .where(eq(genTasks.id, task.id))
    emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'processing' })
    let localValidationError: string | null = null
    try {
      // 首帧注入：能力支持且有图 → data URI（单图失败跳过 + 记日志，不使任务失败）
      let ffUri: string | undefined
      if (cfg.frameCap !== 'none' && typeof parsed.firstFrameAssetId === 'number') {
        try {
          ffUri = await assetToDataUri(parsed.firstFrameAssetId, cfg.uriCache)
          ctx.log(`shot ${shotId} 首帧注入完成`)
        } catch (err) {
          if (recipe) throw new Error('首帧读取失败，禁止降级文生视频')
          ctx.log(`shot ${shotId} 首帧图跳过（${(err as Error).message}）`)
        }
      }
      // [M13] 场景/道具参考图注入：首帧优先决策（frame_first 分支规避 Wan 帧/参考互斥）；单图失败跳过
      const setRefIds = Array.isArray(parsed.setRefAssetIds)
        ? parsed.setRefAssetIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : []
      const decision = planVideoRefs({ hasFirstFrame: !!ffUri, setRefIds, refCap: cfg.refCap })
      if (decision.reason === 'frame_first') ctx.log(`shot ${shotId} 首帧优先，跳过场景/道具参考图（${setRefIds.length} 张）`)
      const setRefUris: string[] = []
      for (const id of decision.inject) {
        try {
          setRefUris.push(await assetToDataUri(id, cfg.uriCache))
        } catch (err) {
          ctx.log(`shot ${shotId} 参考图 #${id} 跳过（${(err as Error).message}）`)
        }
      }
      if (setRefUris.length > 0) ctx.log(`shot ${shotId} 场景/道具参考图注入 ${setRefUris.length} 张`)
      const native = recipe?.plan.performance === 'dialogue' ? dialogueAudioOptions(cfg.provider!, cfg.model!) : null
      const { adapter, request } = await buildVideoRequest({
        prompt: task.prompt ?? '',
        provider: cfg.provider,
        model: cfg.model,
        duration: parsed.duration ?? undefined,
        resolution: parsed.resolution ?? undefined,
        aspectRatio: parsed.aspectRatio ?? undefined,
        firstFrameUrl: ffUri,
        pin: pinOf(ctx.settings.video),
        ...(native ? { extra: { ...native, referenceImageUrls: [], referenceVideoUrls: [], referenceAudioUrls: [] } }
          : setRefUris.length > 0 ? { extra: { referenceImageUrls: setRefUris } } : {}),
      })
      const gen = recipe && task.taskId ? { kind: 'poll' as const, taskId: task.taskId } : await adapter.generate(request)
      let videoUrl: string | null = gen.kind === 'url' ? gen.url : null
      let thirdPartyTaskId: string | null = gen.kind === 'poll' ? gen.taskId : null
      if (gen.kind === 'poll') {
        await db
          .update(genTasks)
          .set({ taskId: gen.taskId, updatedAt: nowMs() })
          .where(eq(genTasks.id, task.id))
        ctx.log(`shot ${shotId} 已提交第三方（task_id=${gen.taskId}），开始轮询`)
        videoUrl = await pollVideoTask(ctx, task, adapter, request, gen.taskId)
      }
      // 产物形态：poll/url 型 → 远程 URL 下载；base64 型（同步长请求适配器）→ 字节直存
      const source =
        gen.kind === 'base64'
          ? ({ kind: 'base64', data: gen.data, mime: gen.mime } as const)
          : videoUrl
            ? ({ kind: 'url', url: videoUrl } as const)
            : null
      if (!source) throw new Error('第三方返回成功但缺少视频产物（url/base64）')
      const asset = await saveGeneratedMedia({
        projectId: ctx.run.projectId,
        stepId: ctx.step.id,
        taskId: task.id,
        runId: ctx.run.id,
        kind: 'video',
        purpose: 'shot_video',
        prompt: task.prompt ?? '',
        params: {
          shotId,
          provider: adapter.provider,
          model: request.model ?? null,
          taskId: thirdPartyTaskId,
          duration: parsed.duration ?? null,
          resolution: parsed.resolution ?? null,
          ...(native ? { dialogueHash: compileDialogueShot(recipe!.plan, shotId).dialogueHash, audioOptions: native } : {}),
        },
        source,
        duration: parsed.duration ?? undefined,
      })
      await db.update(genTasks).set({ resultAssetId: asset.id, ...(native ? {} : { status: 'succeeded', completedAt: nowMs() }), updatedAt: nowMs() }).where(eq(genTasks.id, task.id))
      task.resultAssetId = asset.id
      if (!native) {
        task.status = 'succeeded'
        emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'succeeded' })
      }
      // [M4] 用量记录：视频按请求时长（秒）计；duration 缺省不记录
      const secs = typeof parsed.duration === 'number' && parsed.duration > 0 ? parsed.duration : null
      if (secs)
        await recordUsage({
          projectId: ctx.run.projectId,
          runId: ctx.run.id,
          stepId: ctx.step.id,
          taskId: task.id,
          assetId: asset.id,
          kind: 'video',
          unit: 'second',
          quantity: secs,
          provider: adapter.provider,
          model: request.model ?? null,
          ...(recipe ? { unitPrice: recipe.endpoints.video!.unitPrice } : {}),
        })
      // 原视频与费用先留存，原声缺失/损坏不能用成功状态掩盖。
      if (native) {
        try { inspectDialogueMedia(absPathOf(asset.relPath!)) }
        catch (error) {
          localValidationError = error instanceof Error ? error.message : '原声音轨核验失败'
          throw error
        }
        await db.update(genTasks).set({ status: 'succeeded', completedAt: nowMs(), updatedAt: nowMs() }).where(eq(genTasks.id, task.id))
        task.status = 'succeeded'
        emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'succeeded' })
      }
      ctx.log(`shot ${shotId} 视频生成完成 → asset#${asset.id}`)
      return null
    } catch (err) {
      const msg = localValidationError ?? mediaFailure(err, !!recipe)
      if (attempts >= maxAttempts) {
        await db
          .update(genTasks)
          .set({ status: 'failed', errorMsg: msg, completedAt: nowMs(), updatedAt: nowMs() })
          .where(eq(genTasks.id, task.id))
        emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'failed', error: msg })
        ctx.log(`shot ${shotId} 视频生成失败（已尝试 ${maxAttempts} 次）：${msg}`)
        return { shotId, error: msg }
      }
      ctx.log(`shot ${shotId} 第 ${attempts}/${maxAttempts} 次失败，1.5s 后重试：${msg}`)
      await sleep(1500)
    }
  }
}

/** 轮询第三方任务至完成；run cancelled / 超时 10min / failed → 抛错 */
async function pollVideoTask(
  ctx: StepContext,
  task: GenTask,
  adapter: VideoAdapter,
  request: VideoGenRequest,
  taskId: string,
): Promise<string | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    if (await runCancelled(ctx.run.id)) {
      await db
        .update(genTasks)
        .set({ status: 'cancelled', errorMsg: 'run cancelled', updatedAt: nowMs() })
        .where(eq(genTasks.id, task.id))
      throw new RunCancelledError()
    }
    let res: { status: 'pending' | 'processing' | 'completed' | 'failed'; url?: string; error?: string }
    try {
      res = await adapter.query(taskId, { baseUrl: request.baseUrl, apiKey: request.apiKey })
    } catch (err) {
      // 单次查询网络抖动：记日志继续轮询，累计超时兜底
      ctx.log(`shot 轮询查询异常（继续等待）: ${mediaFailure(err, isCreationTemplate(ctx.run.templateKey))}`)
      res = { status: 'processing' }
    }
    if (res.status === 'completed') return res.url ?? null
    if (res.status === 'failed') throw new Error(res.error ?? '第三方任务失败')
    if (Date.now() > deadline) throw new Error(`视频任务轮询超时（>10 分钟，task_id=${taskId}）`)
    await sleep(POLL_INTERVAL_MS)
  }
}

async function runCancelled(runId: number): Promise<boolean> {
  const rows = await db
    .select({ status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1)
  return rows[0]?.status === 'cancelled'
}

/** 首帧能力判定（入队前 resolve 一次）：端点/适配器不可用 → 'none'（不阻断主线） */
async function videoFirstFrameCapability(provider?: string): Promise<'none' | 'base64' | 'as-reference'> {
  try {
    const endpoint = await resolveEndpoint('video', provider)
    return getVideoAdapter(endpoint.providerKey).firstFrame ?? 'none'
  } catch {
    return 'none'
  }
}

/** [M13] 参考图能力判定（入队前 resolve 一次）：端点/适配器不可用 → 'none' */
async function videoReferenceCapability(provider?: string): Promise<'none' | 'base64'> {
  try {
    const endpoint = await resolveEndpoint('video', provider)
    return getVideoAdapter(endpoint.providerKey).referenceImages ?? 'none'
  } catch {
    return 'none'
  }
}

/** [M22] 分镜直通首帧资产读取（正整数校验；无效 → null，回退 gen_frames 索引） */
export function shotFirstFrameOf(shot: ShotSpec): number | null {
  const v = shot.first_frame_asset_id
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

/**
 * [M13] 本镜场景/道具参考图收集（纯函数，任务 params.setRefAssetIds 快照源）：
 * 场景（location 命中行 → refAssetIds[0]，≤1）→ 道具（props 顺序首个命中行 → refAssetIds[0]，≤1）；
 * 保序去重，总量 ≤2（镜像 ai_image 场景/道具段；角色参考图不参与——视频侧由首帧承载）。
 */
export function collectSetRefAssetIds(
  shot: ShotSpec,
  sceneIndex: Map<string, CharacterRow>,
  propIndex: Map<string, CharacterRow>,
): number[] {
  const ids: number[] = []
  const loc = typeof shot.location === 'string' ? shot.location.trim() : ''
  if (loc) {
    const row = lookupEntity(sceneIndex, loc)
    const id = row ? parseNumArr(row.refAssetIds)[0] : undefined
    if (id !== undefined) ids.push(id)
  }
  for (const raw of shot.props ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const row = lookupEntity(propIndex, raw.trim())
    const id = row ? parseNumArr(row.refAssetIds)[0] : undefined
    if (id !== undefined) {
      if (!ids.includes(id)) ids.push(id)
      break
    }
  }
  return ids
}

/**
 * [M13] 视频参考图注入决策（纯函数，供探针断言；首帧优先为产品决策——规避 Wan 帧/参考互斥）：
 * - refCap 非 base64 或 setRefIds 空 → 不注入；
 * - 有首帧图 → 不注入（frame_first：首帧已承载视觉一致性）；
 * - 无首帧图 → 注入全部（ok）。
 */
export function planVideoRefs(p: {
  hasFirstFrame: boolean
  setRefIds: number[]
  refCap: 'none' | 'base64'
}): { inject: number[]; reason: 'ok' | 'frame_first' | 'no_cap' | 'none' } {
  if (p.setRefIds.length === 0) return { inject: [], reason: 'none' }
  if (p.refCap !== 'base64') return { inject: [], reason: 'no_cap' }
  if (p.hasFirstFrame) return { inject: [], reason: 'frame_first' }
  return { inject: p.setRefIds, reason: 'ok' }
}

/** 名称/别名命中（原样精确 + 小写兜底；与 ai_image lookupCharacter 同口径） */
function lookupEntity(index: Map<string, CharacterRow>, name: string): CharacterRow | null {
  return index.get(name) ?? index.get(name.toLowerCase()) ?? null
}

function parseNumArr(s: string): number[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}

/** run.input JSON 快照安全取值（episode 溯源用） */
function safeGet(inputJson: string, key: string): string | number | undefined {
  try {
    const v = (JSON.parse(inputJson) as Record<string, unknown>)[key]
    return typeof v === 'string' || typeof v === 'number' ? v : undefined
  } catch {
    return undefined
  }
}

/** 简易并发池：all 结束后统一返回（任务内部已捕获失败） */
async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      await fn(items[idx]!)
    }
  })
  await Promise.all(workers)
}
