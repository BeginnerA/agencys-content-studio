import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../../db'
import { assets, canvasEdges, genTasks, projects } from '../../../db/schema'
import type { Canvas, CanvasNode, GenTask } from '../../../db/schema'
import { buildImageRequest, getImageAdapter, resolveEndpoint } from '../../../adapters/provider'
import { buildVideoRequest } from '../../../adapters/video'
import { resolveVoiceChain } from '../../../pipeline/actions/tts'
import { createLogger } from '../../../logger'
import { assetToDataUri } from '../../asset-ref'
import { loadInputPlan } from '../inputs'
import type { InputPlan, NodeSpec } from '../spec'
import { chatCompleteDetailed, resolveLlmEndpoint, type ChatContentPart } from '../../llm'
import { probeMediaDuration, resolveFfmpeg, resolveFfprobe } from '../../ffmpeg'
import { scheduleImageCheck } from '../../image-check'
import { saveGeneratedMedia } from '../../net'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf, writeTextAsset } from '../../storage'
import { combineStyleSnippets, resolveProjectStyleSnippets } from '../../style-preset'
import { assetInput, entityInput, safeRecordExecSnapshot, type ExecInputSpec } from '../../provenance'
import { resolveAudioEndpoint, resolveEmotionPayload, synthSpeech } from '../../tts'
import { cloneEndpoint, loadCloneIndex } from '../../tts-clone'
import { recordLlmUsage, recordUsage } from '../../usage'
import { buildComposeArgs, planAlignedSegments } from './compose-args'
import { buildSegmentSrt, parseSrtCues, retimeSrtCues } from './subtitle'
import { appendStyleSnippet, buildEditParams, parseResolution, type ComposeSize } from './params'
import { emitCanvasChanged, nowMs, pollCanvasVideoTask, taskCancelled } from './video'

const log = createLogger('creation-gen')

const COMPOSE_TIMEOUT_MS = 10 * 60 * 1000 // 合成子进程上限（对齐视频轮询）

/** 单次执行：输入解析 → 分派（audio/compose/llm 独立径；编辑/图片/视频主径）→ 落盘 → succeeded + 用量 */
export async function executeOnce(taskId: number, task: GenTask, node: CanvasNode, canvas: Canvas, spec: NodeSpec): Promise<void> {
  const incoming = await db
    .select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port })
    .from(canvasEdges)
    .where(eq(canvasEdges.to, node.id))
  const plan = await loadInputPlan(node, incoming, spec)
  if (plan.problems.length > 0) throw new Error(`输入未就绪：${plan.problems.join('；')}`)
  // [M17] audio / compose 独立执行径（不展开风格与参考图 URI）
  if (spec.genKind === 'audio') return executeAudioOnce(taskId, canvas, node, spec, plan)
  if (spec.genKind === 'compose') return executeComposeOnce(taskId, canvas, node, spec, plan)
  if (spec.genKind === 'llm') return executeLlmOnce(taskId, canvas, node, spec, plan)
  const uriCache = new Map<number, string>()
  // [M29·R02] 执行真实输入快照：记录本次实际消费的资产/实体版本 + used/skipped（零行为变更，仅旁路采集）
  const execInputs: ExecInputSpec[] = []

  const styleSnippet =
    spec.genKind === 'image' && spec.useStylePreset !== false
      ? combineStyleSnippets((await resolveProjectStyleSnippets(canvas.projectId)).map((s) => s.snippet))
      : null
  let finalPrompt = (plan.promptText ?? spec.prompt).trim()
  let providerKey = ''
  let usedModel: string | null = null
  let source: { kind: 'url'; url: string } | { kind: 'base64'; data: string; mime: string } | null = null
  let width: number | undefined
  let height: number | undefined
  let thirdPartyTaskId: string | null = null

  if (spec.edit) {
    // 编辑通道：source → baseImage；mask（inpaint/erase）；adapter.edit（能力声明制）
    const sourceUri = plan.sourceAssetId != null ? await assetToDataUri(plan.sourceAssetId, uriCache) : null
    if (!sourceUri) throw new Error('编辑节点缺少源图产物')
    if (plan.sourceAssetId != null) execInputs.push(await assetInput('source', plan.sourceAssetId, { port: 'source' }))
    let maskUri: string | undefined
    if (spec.edit.mode === 'inpaint' || spec.edit.mode === 'erase') {
      maskUri = spec.edit.maskAssetId != null ? await assetToDataUri(spec.edit.maskAssetId, uriCache) : undefined
      if (!maskUri) throw new Error('缺少蒙版资产')
      if (spec.edit.maskAssetId != null) execInputs.push(await assetInput('mask', spec.edit.maskAssetId))
    }
    const endpoint = await resolveEndpoint('image', spec.provider)
    const adapter = getImageAdapter(endpoint.providerKey)
    if (!adapter.edit) throw new Error(`供应商「${endpoint.providerKey}」未实现图像编辑能力`)
    const editParams = buildEditParams(spec, { baseImage: sourceUri, mask: maskUri })
    // [M17] prompt 端口覆盖（text 节点内容优先于 spec.prompt；与图片/视频径一致）
    if (plan.promptText != null) editParams.prompt = plan.promptText
    const prompt = styleSnippet ? appendStyleSnippet(editParams.prompt ?? '', styleSnippet) : editParams.prompt
    const img = await adapter.edit({
      ...editParams,
      prompt,
      model: spec.model, // 缺省 → 适配器内置编辑模型（端点默认生成模型不适用于编辑）
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      extra: endpoint.extra,
    })
    providerKey = adapter.provider
    usedModel = spec.model ?? null
    source = img.kind === 'url' ? { kind: 'url', url: img.url } : { kind: 'base64', data: img.data, mime: img.mime }
    width = img.width
    height = img.height
  } else if (spec.genKind === 'image') {
    finalPrompt = styleSnippet ? appendStyleSnippet(finalPrompt, styleSnippet) : finalPrompt
    const refUris: string[] = []
    let ordinal = 0
    for (const id of plan.referenceAssetIds) {
      try {
        refUris.push(await assetToDataUri(id, uriCache))
        execInputs.push(await assetInput('reference', id, { port: 'reference', ordinal: ordinal++ }))
      } catch (err) {
        log.warn(`参考图 asset#${id} 跳过（${(err as Error).message}）`)
        execInputs.push(await assetInput('reference', id, { used: false, skipReason: (err as Error).message, port: 'reference', ordinal: ordinal++ }))
      }
    }
    const { adapter, request } = await buildImageRequest({
      prompt: finalPrompt,
      provider: spec.provider,
      model: spec.model,
      size: spec.size,
      referenceImages: refUris.length > 0 ? refUris : undefined,
    })
    const img = await adapter.generate(request)
    providerKey = adapter.provider
    usedModel = request.model ?? null
    source = img.kind === 'url' ? { kind: 'url', url: img.url } : { kind: 'base64', data: img.data, mime: img.mime }
    width = img.width
    height = img.height
  } else {
    // 视频通道：首帧优先（规避帧/参考互斥，镜像 ai_video planVideoRefs 语义）
    const refUris: string[] = []
    let ordinal = 0
    for (const id of plan.referenceAssetIds) {
      try {
        refUris.push(await assetToDataUri(id, uriCache))
        execInputs.push(await assetInput('reference', id, { port: 'reference', ordinal: ordinal++ }))
      } catch (err) {
        log.warn(`参考图 asset#${id} 跳过（${(err as Error).message}）`)
        execInputs.push(await assetInput('reference', id, { used: false, skipReason: (err as Error).message, port: 'reference', ordinal: ordinal++ }))
      }
    }
    let firstFrameUri: string | undefined
    if (plan.firstFrameAssetId != null) {
      try {
        firstFrameUri = await assetToDataUri(plan.firstFrameAssetId, uriCache)
        execInputs.push(await assetInput('first_frame', plan.firstFrameAssetId, { port: 'first_frame' }))
      } catch (err) {
        log.warn(`首帧 asset#${plan.firstFrameAssetId} 跳过（${(err as Error).message}）`)
        execInputs.push(await assetInput('first_frame', plan.firstFrameAssetId, { used: false, skipReason: (err as Error).message, port: 'first_frame' }))
      }
    }
    let lastFrameUri: string | undefined
    if (plan.lastFrameAssetId != null) {
      try {
        lastFrameUri = await assetToDataUri(plan.lastFrameAssetId, uriCache)
        execInputs.push(await assetInput('last_frame', plan.lastFrameAssetId, { port: 'last_frame' }))
      } catch (err) {
        log.warn(`尾帧 asset#${plan.lastFrameAssetId} 跳过（${(err as Error).message}）`)
        execInputs.push(await assetInput('last_frame', plan.lastFrameAssetId, { used: false, skipReason: (err as Error).message, port: 'last_frame' }))
      }
    }
    const { adapter, request } = await buildVideoRequest({
      prompt: finalPrompt,
      provider: spec.provider,
      model: spec.model,
      duration: spec.duration,
      resolution: spec.resolution,
      aspectRatio: spec.aspectRatio,
      firstFrameUrl: firstFrameUri,
      lastFrameUrl: lastFrameUri,
      ...(!firstFrameUri && refUris.length > 0 ? { extra: { referenceImageUrls: refUris } } : {}),
    })
    const gen = await adapter.generate(request)
    let videoUrl: string | null = gen.kind === 'url' ? gen.url : null
    if (gen.kind === 'poll') {
      thirdPartyTaskId = gen.taskId
      await db.update(genTasks).set({ taskId: gen.taskId, updatedAt: nowMs() }).where(eq(genTasks.id, taskId))
      log.info(`canvas task ${taskId} 已提交第三方（task_id=${gen.taskId}），开始轮询`)
      videoUrl = await pollCanvasVideoTask(taskId, adapter, request, gen.taskId)
    }
    providerKey = adapter.provider
    usedModel = request.model ?? null
    source =
      gen.kind === 'base64'
        ? { kind: 'base64', data: gen.data, mime: gen.mime }
        : videoUrl
          ? { kind: 'url', url: videoUrl }
          : null
    if (!source) throw new Error('第三方返回成功但缺少视频产物（url/base64）')
  }

  // 取消竞态：图片生成不可中断——生成完成后若已取消 → 弃存（视频轮询已在过程中中止）
  if (await taskCancelled(taskId)) return
  if (!source) throw new Error('生成结果为空')

  const asset = await saveGeneratedMedia({
    projectId: canvas.projectId,
    taskId,
    runId: null,
    kind: spec.genKind,
    purpose: spec.genKind === 'video' ? 'creation_video' : 'creation',
    prompt: finalPrompt || spec.prompt,
    params: {
      canvasId: canvas.id,
      nodeId: node.id,
      provider: providerKey,
      model: usedModel,
      taskId: thirdPartyTaskId,
      size: spec.size ?? null,
      duration: spec.duration ?? null,
      edit: spec.edit ? { mode: spec.edit.mode, maskAssetId: spec.edit.maskAssetId ?? null } : null,
    },
    source,
    width,
    height,
    duration: spec.duration,
  })
  scheduleImageCheck(asset)
  await db
    .update(genTasks)
    .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
    .where(eq(genTasks.id, taskId))
  emitCanvasChanged(canvas, node.id)

  // 用量记录（画布任务无 run；taskId 关联）
  if (spec.genKind === 'image') {
    await recordUsage({
      projectId: canvas.projectId,
      runId: null,
      taskId,
      assetId: asset.id,
      kind: 'image',
      unit: 'image',
      quantity: 1,
      provider: providerKey,
      model: usedModel,
    })
  } else if (typeof spec.duration === 'number' && spec.duration > 0) {
    await recordUsage({
      projectId: canvas.projectId,
      runId: null,
      taskId,
      assetId: asset.id,
      kind: 'video',
      unit: 'second',
      quantity: spec.duration,
      provider: providerKey,
      model: usedModel,
    })
  }
  // [M29·R02] 补齐 prompt/实体来源，冻结本次执行真实输入快照（旁路，失败不影响生成）
  if (plan.promptSource?.assetId != null) execInputs.push(await assetInput('text', plan.promptSource.assetId, { port: 'prompt' }))
  for (const eid of plan.entitySources) execInputs.push(await entityInput('reference', eid))
  await safeRecordExecSnapshot({
    projectId: canvas.projectId,
    execKind: 'canvas_task',
    runId: null,
    taskId,
    model: usedModel ?? spec.model ?? null,
    inputs: execInputs,
  })
  log.info(`canvas node #${node.id} 生成完成 → asset#${asset.id}`)
}

// ---------- [M17/M18] audio / compose / llm 执行径 ----------

/** [M17/M18] compose 输入资产 → 本地路径 + 时长元数据（软删/无文件/缺文件即抛错，避免 ffmpeg 半途失败） */
interface ComposeInput {
  path: string
  duration: number | null
  /** [M22] 资产 prompt（tts 语音文本——字幕 'auto' 模式文本源） */
  prompt: string | null
}

async function composeInputsOf(assetIds: number[], label: string): Promise<ComposeInput[]> {
  if (assetIds.length === 0) return []
  const rows = await db.select().from(assets).where(inArray(assets.id, assetIds))
  const byId = new Map(rows.map((a) => [a.id, a]))
  const out: ComposeInput[] = []
  for (const id of assetIds) {
    const a = byId.get(id)
    if (!a || a.deletedAt != null) throw new Error(`${label}输入 asset#${id} 已删除`)
    if (!a.relPath) throw new Error(`${label}输入 asset#${id} 无本地文件`)
    const abs = absPathOf(a.relPath)
    if (!existsSync(abs)) throw new Error(`${label}输入 asset#${id} 文件缺失（${a.relPath}）`)
    out.push({ path: abs, duration: typeof a.duration === 'number' && a.duration > 0 ? a.duration : null, prompt: a.prompt })
  }
  return out
}

/** [M17] 项目 settings.audio.voice（声线链第 4 级；缺失/损坏 → undefined） */
async function projectAudioVoice(projectId: number): Promise<string | undefined> {
  const rows = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1)
  try {
    const settings = JSON.parse(rows[0]?.settings ?? '{}') as Record<string, unknown>
    const audio = settings['audio'] as Record<string, unknown> | undefined
    const voice = audio?.['voice']
    return typeof voice === 'string' && voice.trim() ? voice.trim() : undefined
  } catch {
    return undefined
  }
}

/** [M17] ffprobe 探测视频宽高（失败 → null；宽高向下取偶） */
function probeVideoSize(file: string): ComposeSize | null {
  const ffprobe = resolveFfprobe()
  if (!ffprobe) return null
  try {
    const r = spawnSync(
      ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', file],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
    )
    if (r.error || r.status !== 0) return null
    const m = /^(\d+)x(\d+)/.exec(String(r.stdout ?? '').trim())
    if (!m) return null
    const width = Number(m[1])
    const height = Number(m[2])
    if (width <= 0 || height <= 0) return null
    return { width: width - (width % 2), height: height - (height % 2) }
  } catch {
    return null
  }
}

/** [M17] ffmpeg 执行（异步 spawn；超时 10min；stderr 尾部保留并在失败时附上） */
function runComposeFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let tail = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`ffmpeg 合成超时（>${COMPOSE_TIMEOUT_MS / 60_000} 分钟）`))
    }, COMPOSE_TIMEOUT_MS)
    child.stderr?.on('data', (buf: Buffer) => {
      tail = (tail + buf.toString('utf8')).slice(-2000)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 合成失败（exit=${code}）：${tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ') || '(无输出)'}`))
    })
  })
}

/** [M17] 音频执行径：声线链（params → settings → 实例 → alloy）→ synthSpeech → 落盘 → succeeded + 用量(tts/char)
 * [M19 P8] 任一级写 clone:{id} 且音色库命中 → 换 provider 端点 + 克隆绑定模型（无效引用降级同声线链口径） */
async function executeAudioOnce(taskId: number, canvas: Canvas, node: CanvasNode, spec: NodeSpec, plan: InputPlan): Promise<void> {
  const text = (plan.promptText ?? spec.prompt).trim()
  if (!text) throw new Error('音频文本为空（请在 prompt 填写内容或连线提示词节点）')
  const endpoint = await resolveAudioEndpoint(spec.provider)
  const settingsVoice = await projectAudioVoice(canvas.projectId)
  const { voice, source: voiceSource, clone, cloneSkipped } = resolveVoiceChain({
    paramVoice: spec.voice,
    settingsVoice,
    instanceVoice: endpoint.voice,
    cloneIndex: await loadCloneIndex(),
  })
  if (cloneSkipped.length > 0) log.warn(`canvas node #${node.id} 克隆音色引用未命中（${cloneSkipped.join('、')}）→ 跳过该级继续降级`)
  const ep = clone ? await cloneEndpoint(clone) : endpoint
  log.info(
    `canvas node #${node.id} 音频合成：${ep.providerKey}/${ep.model} voice=${voice}（${
      clone ? `clone:${clone.id} ${clone.name}` : voiceSource
    }）${text.length} 字`,
  )
  const emotionPayload = resolveEmotionPayload(spec.emotion ?? '', ep.emotion)
  const data = await synthSpeech(text, ep, { voice, speed: spec.speed, emotion: emotionPayload ?? undefined })
  if (await taskCancelled(taskId)) return // 生成不可中断——完成后若已取消 → 弃存

  const fileName = `${Date.now()}-voice-node${node.id}.mp3`
  const relPath = relPathOf(canvas.projectId, 'creation_audio', fileName)
  ensureProjectDirs(canvas.projectId)
  writeFileSync(absPathOf(relPath), data)
  const asset = await registerAsset(canvas.projectId, {
    taskId,
    runId: null,
    kind: 'audio',
    purpose: 'creation_audio',
    relPath,
    name: fileName,
    mime: 'audio/mpeg',
    ext: 'mp3',
    fileSize: data.byteLength,
    prompt: text.slice(0, 4000),
    params: {
      canvasId: canvas.id,
      nodeId: node.id,
      provider: ep.providerKey,
      model: ep.model,
      voice,
      voiceSource: clone ? 'clone' : voiceSource,
      emotionHint: spec.emotion ?? null,
      emotionSent: emotionPayload?.value ?? null,
      clone_id: clone?.id ?? null,
      clone_name: clone?.name ?? null,
      speed: spec.speed ?? null,
      chars: text.length,
    },
    tags: ['voice'],
  })
  await db
    .update(genTasks)
    .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
    .where(eq(genTasks.id, taskId))
  emitCanvasChanged(canvas, node.id)
  // [M29·R02] audio 执行真实输入快照：prompt 端口来源文本资产（版本指针）
  if (plan.promptSource?.assetId != null) {
    await safeRecordExecSnapshot({
      projectId: canvas.projectId,
      execKind: 'canvas_task',
      runId: null,
      taskId,
      model: ep.model,
      inputs: [await assetInput('text', plan.promptSource.assetId, { port: 'prompt' })],
    })
  }
  await recordUsage({
    projectId: canvas.projectId,
    runId: null,
    taskId,
    assetId: asset.id,
    kind: 'tts',
    unit: 'char',
    quantity: text.length,
    provider: ep.providerKey,
    model: ep.model,
  })
  log.info(`canvas node #${node.id} 音频完成 → asset#${asset.id}`)
}

/**
 * [M18] LLM 文本执行径：指令（prompt 端口文本 > spec.prompt）+ 文本素材（text 端口 ≤4 段拼接）+
 * 参考图（≤4 多模态 ChatContentPart，镜像 style-preset 先例）→ chatCompleteDetailed →
 * writeTextAsset(purpose='creation_llm') → succeeded + recordLlmUsage（tokens_in/out）。
 */
async function executeLlmOnce(taskId: number, canvas: Canvas, node: CanvasNode, spec: NodeSpec, plan: InputPlan): Promise<void> {
  const instruction = (plan.promptText ?? spec.prompt).trim()
  if (!instruction) throw new Error('LLM 指令为空（请在 prompt 填写指令或连线文本节点）')
  const uriCache = new Map<number, string>()
  const imageParts: ChatContentPart[] = []
  // [M29·R02] llm 执行真实输入快照（参考图 used/skipped + 文本素材版本指针）
  const execInputs: ExecInputSpec[] = []
  for (const id of plan.referenceAssetIds) {
    try {
      imageParts.push({ type: 'image_url', image_url: { url: await assetToDataUri(id, uriCache) } })
      execInputs.push(await assetInput('reference', id, { port: 'reference' }))
    } catch (err) {
      log.warn(`LLM 参考图 asset#${id} 跳过（${(err as Error).message}）`)
      execInputs.push(await assetInput('reference', id, { used: false, skipReason: (err as Error).message, port: 'reference' }))
    }
  }
  for (const src of plan.textSources) {
    if (src.assetId != null) execInputs.push(await assetInput('text', src.assetId, { port: 'text' }))
  }
  let body = instruction
  if (plan.textInputs.length > 0) {
    const sections = plan.textInputs.map((t, i) => `--- 素材 ${i + 1} ---\n${t}`).join('\n\n')
    body = `${sections}\n\n---\n\n指令：${instruction}`
  }
  const endpoint = await resolveLlmEndpoint()
  log.info(
    `canvas node #${node.id} LLM 开始：${endpoint.providerKey}/${endpoint.model}（素材 ${plan.textInputs.length} 段，参考图 ${imageParts.length} 张）`,
  )
  const res = await chatCompleteDetailed(
    [
      {
        role: 'system',
        content:
          '你是创作画布的文本处理引擎。按用户指令处理提供的资料（文本素材与图片）：结合资料内容完成任务；' +
          '只输出任务要求的结果本体，不输出任何解释性前言或后记。',
      },
      { role: 'user', content: imageParts.length > 0 ? [{ type: 'text', text: body }, ...imageParts] : body },
    ],
    endpoint,
    { temperature: spec.temperature ?? 0.8, maxTokens: spec.maxTokens ?? 12000, timeoutMs: 600_000 },
  )
  if (await taskCancelled(taskId)) return // 生成不可中断——完成后若已取消 → 弃存
  const text = res.content.trim()
  if (!text) throw new Error('LLM 返回为空')
  const asset = await writeTextAsset(canvas.projectId, {
    name: `LLM 文本 #${node.id}.md`,
    content: text,
    purpose: 'creation_llm',
    taskId,
    runId: null,
    prompt: instruction.slice(0, 4000),
    params: {
      canvasId: canvas.id,
      nodeId: node.id,
      provider: res.provider,
      model: res.model,
      temperature: spec.temperature ?? null,
      materials: plan.textInputs.length,
      images: imageParts.length,
      chars: text.length,
    },
    tags: ['llm'],
  })
  await db
    .update(genTasks)
    .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
    .where(eq(genTasks.id, taskId))
  emitCanvasChanged(canvas, node.id)
  await recordLlmUsage({ projectId: canvas.projectId, runId: null, provider: res.provider, model: res.model, usage: res.usage })
  await safeRecordExecSnapshot({
    projectId: canvas.projectId,
    execKind: 'canvas_task',
    runId: null,
    taskId,
    model: res.model,
    inputs: execInputs,
  })
  log.info(`canvas node #${node.id} LLM 完成 → asset#${asset.id}（${text.length} 字符）`)
}

/** [M17/M18] 合成执行径：输入路径解析（+时长元数据）→ ffmpeg（resolution 优先；多段缺省探测第一段；[M18] 转场/BGM）→ 落盘 → succeeded（无外部用量） */
async function executeComposeOnce(taskId: number, canvas: Canvas, node: CanvasNode, spec: NodeSpec, plan: InputPlan): Promise<void> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    throw new Error('未找到可用 ffmpeg：内置二进制与系统 PATH 均不可用；请先在仓库根 pnpm install（重新下载内置二进制），或在 .env 设 CSTUDIO_FFMPEG_PATH 指向 ffmpeg.exe')
  }
  const videoIns = await composeInputsOf(plan.videoAssetIds, '视频')
  const audioIns = await composeInputsOf(plan.audioAssetIds, '音频')
  const videoPaths = videoIns.map((v) => v.path)
  const audioPaths = audioIns.map((a) => a.path)
  // [M18] 段时长：资产元数据优先，缺失 ffprobe 兜底；任一未知 → durations=null → 转场/BGM 宽容降级
  const resolvedDurs = videoIns.map((v) => v.duration ?? probeMediaDuration(v.path))
  const durations = resolvedDurs.every((d): d is number => typeof d === 'number' && d > 0) ? resolvedDurs : null
  // [M22] 音字对齐：段级配对计划（video[i]↔audio[i]，段时长 max）；段数不匹配/任一段时长未知 → 宽容降级为现状
  const resolvedADurs = audioIns.map((a) => a.duration ?? probeMediaDuration(a.path))
  const alignPlan = spec.align ? planAlignedSegments(resolvedDurs, resolvedADurs) : null
  if (spec.align && !alignPlan) log.warn(`canvas node #${node.id} 音字对齐已降级（视频/音频段数不匹配或时长未知）`)
  if (alignPlan && spec.transition && spec.transition !== 'none') log.warn(`canvas node #${node.id} 对齐模式与转场互斥，已禁用转场`)
  // [M22] 字幕链：'auto'=音频段 prompt 文本生成 / 'asset'=已有 SRT 按段重钉 → 先落库（烧录引用文件绝对路径，不删留档）
  let subtitleAssetId: number | null = null
  let burnSubPath: string | null = null
  if (alignPlan && spec.subtitle && spec.subtitle !== 'none') {
    const segStarts: Array<{ startSec: number; segDur: number }> = []
    let segCursor = 0
    for (const d of alignPlan.segDurs) {
      segStarts.push({ startSec: segCursor, segDur: d })
      segCursor = Math.round((segCursor + d) * 1000) / 1000
    }
    let srtText: string | null = null
    if (spec.subtitle === 'asset') {
      if (spec.subtitleAssetId != null) {
        try {
          const [subInput] = await composeInputsOf([spec.subtitleAssetId], '字幕')
          if (!subInput) throw new Error('字幕资产缺失')
          srtText = retimeSrtCues(parseSrtCues(readFileSync(subInput.path, 'utf8')), segStarts)
          if (!srtText) log.warn(`canvas node #${node.id} 已有字幕 cue 数与段数不符，降级不生成字幕`)
        } catch (err) {
          log.warn(`canvas node #${node.id} 已有字幕读取失败，降级不生成字幕：${(err as Error).message}`)
        }
      } else {
        log.warn(`canvas node #${node.id} 字幕模式 asset 但未指定 subtitleAssetId，跳过`)
      }
    } else if (spec.subtitle === 'auto') {
      srtText = buildSegmentSrt(
        audioIns.map((a, i) => ({
          startSec: segStarts[i]!.startSec,
          voiceDur: resolvedADurs[i] ?? 0,
          segDur: alignPlan.segDurs[i]!,
          text: a.prompt ?? '',
        })),
      )
      if (!srtText) log.warn(`canvas node #${node.id} 音频段无文本，字幕未生成`)
    }
    if (srtText) {
      const subAsset = await writeTextAsset(canvas.projectId, {
        name: `合成字幕 #${node.id}.srt`,
        content: srtText,
        purpose: 'creation_subtitle',
        format: 'srt',
        taskId,
        runId: null,
        params: { canvasId: canvas.id, nodeId: node.id, subtitle: spec.subtitle ?? null, segs: alignPlan.segDurs.length },
        tags: ['subtitle'],
      })
      subtitleAssetId = subAsset.id
      if (spec.burnSubtitles && subAsset.relPath) burnSubPath = absPathOf(subAsset.relPath)
      log.info(`canvas node #${node.id} 字幕生成 → asset#${subAsset.id}（${alignPlan.segDurs.length} 段${burnSubPath ? '，烧录' : ''}）`)
    }
  }
  let bgmPath: string | null = null
  if (spec.bgmAssetId != null) {
    const [b] = await composeInputsOf([spec.bgmAssetId], '背景音乐')
    bgmPath = b?.path ?? null
    if (bgmPath && !durations) log.warn(`画布节点 #${node.id} 已设置 BGM/转场但视频段时长未知（宽容降级跳过）`)
  }
  let size: ComposeSize | null = null
  if (spec.resolution) {
    size = parseResolution(spec.resolution)
  } else if (videoPaths.length >= 2) {
    size = probeVideoSize(videoPaths[0]!)
    if (!size) throw new Error('合成尺寸未知：请设置 resolution（WxH 如 1080x1920），或确保 ffprobe 可用（自动探测第一段视频尺寸）')
  }
  const fileName = `${Date.now()}-compose-node${node.id}.mp4`
  const relPath = relPathOf(canvas.projectId, 'creation_compose', fileName)
  const outAbs = absPathOf(relPath)
  ensureProjectDirs(canvas.projectId)
  const args = buildComposeArgs({
    videoPaths,
    audioPaths,
    outPath: outAbs,
    fps: spec.fps,
    size,
    durations,
    transition: spec.transition ?? null,
    transitionDuration: spec.transitionDuration ?? null,
    bgmPath,
    bgmVolume: spec.bgmVolume ?? null,
    bgmFade: spec.bgmFade ?? null,
    align: alignPlan ? { videoDurs: resolvedDurs as number[], audioDurs: resolvedADurs as number[] } : null,
    subtitlePath: burnSubPath,
    fit: spec.fit ?? null,
  })
  if (await taskCancelled(taskId)) return
  const transDesc = spec.transition && spec.transition !== 'none' && durations && !alignPlan ? `转场=${spec.transition}` : ''
  const bgmDesc = bgmPath && durations ? 'BGM=有' : ''
  const alignDesc = alignPlan ? `对齐=${alignPlan.segDurs.length}段` : ''
  const subDesc = subtitleAssetId != null ? `字幕#${subtitleAssetId}` : ''
  const fitDesc = spec.fit === 'crop' ? '裁切=满幅' : ''
  log.info(
    `canvas node #${node.id} 合成开始：${videoPaths.length} 视频 + ${audioPaths.length} 音频${size ? ` → ${size.width}x${size.height}` : ''}${spec.fps ? ` @${spec.fps}fps` : ''}${transDesc ? ` ${transDesc}` : ''}${bgmDesc ? ` ${bgmDesc}` : ''}${alignDesc ? ` ${alignDesc}` : ''}${subDesc ? ` ${subDesc}` : ''}${fitDesc ? ` ${fitDesc}` : ''}`,
  )
  await runComposeFfmpeg(ffmpeg, args)
  if (await taskCancelled(taskId)) {
    rmSync(outAbs, { force: true }) // 本地进程不可中断——完成后若已取消 → 弃存
    return
  }
  const stat = statSync(outAbs, { throwIfNoEntry: false })
  if (!stat) throw new Error('合成完成但未生成输出文件')
  const duration = probeMediaDuration(outAbs)
  const asset = await registerAsset(canvas.projectId, {
    taskId,
    runId: null,
    kind: 'video',
    purpose: 'creation_compose',
    relPath,
    name: fileName,
    mime: 'video/mp4',
    ext: 'mp4',
    fileSize: stat.size,
    width: size?.width,
    height: size?.height,
    duration: duration ?? undefined,
    params: {
      canvasId: canvas.id,
      nodeId: node.id,
      resolution: spec.resolution ?? (size ? `${size.width}x${size.height}` : null),
      fps: spec.fps ?? null,
      videos: plan.videoAssetIds,
      audios: plan.audioAssetIds,
      duration: duration ?? null,
      transition: spec.transition ?? null,
      transitionDuration: spec.transitionDuration ?? null,
      bgmAssetId: spec.bgmAssetId ?? null,
      // [M22] 对齐/字幕快照
      align: alignPlan != null,
      segDurs: alignPlan?.segDurs ?? null,
      subtitle: spec.subtitle ?? null,
      subtitleAssetId,
      burnSubtitles: !!spec.burnSubtitles,
    },
    tags: ['compose'],
  })
  await db
    .update(genTasks)
    .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
    .where(eq(genTasks.id, taskId))
  emitCanvasChanged(canvas, node.id)
  // [M29·R02] compose 执行真实输入快照：镜头视频/配音/字幕/BGM 均入边（媒体资产 versionId=null，身份即资产 id）
  {
    const execInputs: ExecInputSpec[] = []
    for (let i = 0; i < plan.videoAssetIds.length; i++) execInputs.push(await assetInput('source', plan.videoAssetIds[i]!, { port: 'video', ordinal: i }))
    for (let i = 0; i < plan.audioAssetIds.length; i++) execInputs.push(await assetInput('voice', plan.audioAssetIds[i]!, { port: 'audio', ordinal: i }))
    if (spec.bgmAssetId != null) execInputs.push(await assetInput('bgm', spec.bgmAssetId))
    if (subtitleAssetId != null) execInputs.push(await assetInput('subtitle', subtitleAssetId))
    else if (spec.subtitle === 'asset' && spec.subtitleAssetId != null) execInputs.push(await assetInput('subtitle', spec.subtitleAssetId))
    await safeRecordExecSnapshot({ projectId: canvas.projectId, execKind: 'canvas_task', runId: null, taskId, inputs: execInputs })
  }
  log.info(`canvas node #${node.id} 合成完成 → asset#${asset.id}（${Math.round(stat.size / 1024)} KB${duration ? `, ${Math.round(duration * 10) / 10}s` : ''}）`)
}
