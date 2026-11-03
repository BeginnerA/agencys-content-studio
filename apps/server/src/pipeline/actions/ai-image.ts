import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { genTasks, type CharacterRow, type GenTask } from '../../db/schema'
import { buildImageRequest, getImageAdapter, resolveEndpoint } from '../../adapters/provider'
import { assetToDataUri } from '../../services/asset-ref'
import { loadEntityIndex } from '../../services/character'
import { combineStyleSnippets, resolveProjectStyleSnippets } from '../../services/style-preset'
import { saveGeneratedMedia } from '../../services/net'
import { scheduleImageCheck } from '../../services/image-check'
import { emitStudioEvent } from '../../services/events'
import { shotDurationSec } from '../../services/shot'
import { recordUsage } from '../../services/usage'
import { assetInput, entityInput, safeRecordExecSnapshot, type ExecInputSpec } from '../../services/provenance'
import type { StepContext } from '../context'
import type { StepResult } from '../types'
import { RunCancelledError } from '../types'
import { runCancelled } from '../cancel'
import { pinOf, recipeOf, mediaFailure, recipeRefImageIds } from '../../services/creation-chat/recipe'
import { compileDialogueShot } from '../../services/creation-chat/dialogue'
import { buildIdentityRefMap, pickExistingRefs } from './reference-reuse'
import { matchStateEntry } from '../../services/state-match'
import { collectRefAssetIds, collectRefSelection, mergeRefIds, MAX_REFS_PER_SHOT } from '../../services/ref-selection'
import { loadRefIndex } from '../../services/entity-references'
import { resolveImageCaps, capsResolutionFailure } from '../../services/image-caps'

interface ShotSpec {
  id: string
  image_prompt: string
  duration?: number
  /** 角色名（含别名）列表：命中角色库 → 自动注入 appearance/negative 锚定 */
  characters?: string[]
  /** 场景名（与场景库对齐）：命中 → 注入场景锚定 + 参考图 */
  location?: string
  /** 道具名列表（与道具库对齐）：命中 → 注入道具锚定 + 参考图 */
  props?: string[]
  /** 素材参考图链分类（scene|prop；output_purpose_by_category 按此分派 purpose） */
  category?: string
  /** 场次号（storyboard-ep v7 的 scene）：states「第N场」定位词命中依据；缺失 → 场次档不命中 */
  scene?: number
  /** 画布直通参考图资产 id（前插注入，保序去重；与实体锚定参考共存） */
  ref_asset_ids?: number[]
}

const nowMs = (): number => Date.now()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 并入 ai_image 参考图通道的批准参考角色（风格/主体/首帧） */
const IMAGE_REF_ROLES = ['style', 'subject', 'first_frame'] as const

/**
 * ai_image：批量镜头出图。
 * 输入 batch.field（默认 shots）→ 分镜 JSON 资产 → 每镜头一条 gen_task；
 * 逐镜锚定注入（注入全文进 prompt 快照）：角色（shot.characters）→ 状态（ 角色 states 命中）→ 场景/道具（shot.location/props）→ 风格（项目绑定预设）；
 * 参考图（角色定妆照 + 场景/道具参考图）在供应商能力支持时转 data URI 注入（params.refUsed 记计划注入数）；
 * 并发上限 batch.max_concurrent（默认 2），失败按 batch.retry 重试。
 * 幂等：本 step 已 succeeded 的 task 跳过（断点续跑复用成功图）；
 * failed 且 attempts 未超上限的 task 在本步重跑时自动补跑；
 * 未成功任务的 prompt/参数执行时与当前分镜同步（修正分镜后续跑即生效），
 * failed 且有变化的任务归零重排队。
 */
export async function aiImage(ctx: StepContext): Promise<StepResult> {
  const batch = ctx.def.batch ?? { field: 'shots', maxConcurrent: 2, retry: 1 }
  const field = batch.field ?? 'shots'
  const concurrency = Math.max(1, batch.maxConcurrent ?? 2)
  const maxRetry = Math.max(0, batch.retry ?? 1)

  const sbIds = ctx.assetIdsOf(field)
  if (sbIds.length === 0) throw new Error(`inputs.${field} 无分镜资产`)
  const raw = await ctx.readText(sbIds[0]!)
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
  for (const s of shots) {
    if (typeof s?.image_prompt !== 'string' || !s.image_prompt.trim()) {
      throw new Error(`shot ${String(s?.id ?? '?')} 缺 image_prompt`)
    }
  }

  // 锚定注入（快照即一致性硬证据）：角色→ 场景/道具→ 风格，逐段叠加
  const recipe = recipeOf(ctx.run)
  const dialogue = recipe?.plan.performance === 'dialogue'
  if (dialogue && JSON.stringify(shots) !== JSON.stringify(recipe.plan.shots)) throw new Error('对白首帧输入必须与批准分镜一致')
  // 对白只消费批准角色与参考，不从同名项目实体补入未批准外貌。
  const charIndex = dialogue ? new Map<string, CharacterRow>() : await loadEntityIndex(ctx.run.projectId, 'character')
  const sceneIndex = dialogue ? new Map<string, CharacterRow>() : await loadEntityIndex(ctx.run.projectId, 'scene')
  const propIndex = dialogue ? new Map<string, CharacterRow>() : await loadEntityIndex(ctx.run.projectId, 'prop')
  const indexes = { characters: charIndex, scenes: sceneIndex, props: propIndex }
  // 分层参考登记索引：三索引命中实体并集一次性载入其 enabled 分层行（dialogue 分支三索引为空 → 自然得空索引，选择策略自动回落隐式基准）
  const refEntityIds = [...new Set([...charIndex.values(), ...sceneIndex.values(), ...propIndex.values()].map((r) => r.id))]
  const refIndex = await loadRefIndex(refEntityIds)
  const { shots: charShots, injected, missing } = injectCharacterAnchors(shots, charIndex)
  ctx.log(`角色锚定注入 ${injected} 镜${missing.length > 0 ? `（未命中角色：${missing.join('、')}）` : ''}`)
  // 角色状态锚定：逐镜命中角色 states（场次/集/文本三级）→ 追加状态短语；无 states / 无命中 → 零注入
  const episode = ctx.run.input ? inputEpisode(ctx.run.input) : undefined
  const stateRes = injectStateAnchors(charShots, charIndex, episode)
  if (stateRes.injected > 0) {
    const brief = stateRes.details.length > 6 ? ` / …共 ${stateRes.details.length} 条` : ''
    ctx.log(`状态锚定注入 ${stateRes.injected} 镜：${stateRes.details.slice(0, 6).join(' / ')}${brief}`)
  }
  const { shots: setShots, sceneInjected, propInjected, missing: setMissing } = injectSetAnchors(stateRes.shots, sceneIndex, propIndex)
  ctx.log(`场景锚定 ${sceneInjected} 镜 / 道具锚定 ${propInjected} 镜${setMissing.length > 0 ? `（未命中：${setMissing.join('、')}）` : ''}`)

  const imgCfg = (ctx.settings.image ?? {}) as Record<string, unknown>
  const provider = typeof imgCfg['provider'] === 'string' ? imgCfg['provider'] : undefined
  const model = typeof imgCfg['model'] === 'string' ? imgCfg['model'] : undefined
  const stepParams = (ctx.def.params ?? {}) as Record<string, unknown>
  // 步级画幅覆盖（定妆照等多视角设定图需横画幅，独立于项目竖幅默认）：无 params.image_size 时与旧行为逐字等价
  const size = typeof stepParams['image_size'] === 'string' && stepParams['image_size']
    ? stepParams['image_size']
    : (typeof imgCfg['size'] === 'string' ? imgCfg['size'] : '832x1248')
  const useRefs = dialogue || stepParams['use_character_refs'] !== false // 语义：参考图注入总开关（角色 + 场景/道具；参数名保持兼容）
  const outputPurpose =
    typeof stepParams['output_purpose'] === 'string' && stepParams['output_purpose'] ? stepParams['output_purpose'] : 'shot_image'
  // 风格锚定注入（支持多预设叠加）：项目绑定预设（可多个）→ 运行时解析→ 逐块拼接尾追「视觉风格：…」；未绑定/停用→ 零注入 + 日志
  const useStylePreset = !dialogue && stepParams['use_style_preset'] !== false
  const styleResolved = useStylePreset ? await resolveProjectStyleSnippets(ctx.run.projectId) : []
  if (useStylePreset && styleResolved.length === 0) ctx.log('项目未绑定风格预设 / 预设已停用，跳过风格注入')
  const finalShots = injectStyleAnchor(setShots, combineStyleSnippets(styleResolved.map((s) => s.snippet)))
  if (styleResolved.length > 0) {
    ctx.log(`风格注入：${styleResolved.map((s) => s.name).join(' + ')}（预设 ${styleResolved.map((s) => `#${s.id}`).join(',')}）`)
  }
  // 风格负向锚定注入：随风格预设透传的 negative（免漂移负向词）逐镜尾追「必须剔除：」段（无 negative → refReadyShots 即 finalShots，零 diff）
  const styleNegatives = styleResolved.map((s) => s.negative).filter((x): x is string => !!x && x.trim().length > 0)
  const refReadyShots = styleNegatives.length > 0
    ? finalShots.map((s) => ({ ...s, image_prompt: `${s.image_prompt.trim()}\n必须剔除：${styleNegatives.join('；')}` }))
    : finalShots
  if (styleNegatives.length > 0) ctx.log(`风格负向锚定注入 ${styleNegatives.length} 条`)
  // 参考图能力判定：入队前 resolve 一次（失败视为 none，不阻断主线）；data URI 缓存 step 级（同图多镜只算一次）
  // 批准的参考图片（风格/主体/首帧）并入本镜参考图通道（确定性、可幂等：recipe 固定 → params 稳定）
  const refCap = pinOf(imgCfg) ? getImageAdapter(provider!).referenceImages ?? 'none' : await imageRefCapability(provider)
  if (dialogue && shots.some((s) => {
    const count = recipeRefImageIds(recipe, s.id, IMAGE_REF_ROLES).length
    return count > MAX_REFS_PER_SHOT || (count > 0 && refCap !== 'base64')
  })) throw new Error('对白批准参考图无法完整传递，请调整参考数量或图像实例')
  // 宿主侧模型能力并入：参考图上限在总量内按登记的 caps 收紧（能力判定容错，解析失败即缺省保守值，绝不抛穿）
  const caps = await resolveImageCaps(provider, model)
  // 能力解析失败的留痕：端点未配置/适配器未注册 与 该模型确实不支持参考图 都会落到 supportsRefs:false，
  // 但只有前者会在 caps.notes 里带出失败原因——单独记一行日志，运行日志与参数快照才能区分两种成因
  const capsFailure = capsResolutionFailure(caps)
  if (capsFailure) ctx.log(`图像模型参考图能力未能判定（属宿主配置问题，非供应商声明不支持）：${capsFailure}`)
  const effectiveRefLimit = Math.min(MAX_REFS_PER_SHOT, caps.maxRefs)
  if (caps.supportsRefs && caps.maxRefs < MAX_REFS_PER_SHOT) {
    ctx.log(`模型参考图上限 ${caps.maxRefs}（宿主总量 ${MAX_REFS_PER_SHOT} 内收紧），超出部分按分层优先级裁剪`)
  }
  const uriCache = new Map<number, string>()
  ctx.log(`批量出图：${refReadyShots.length} 镜头 × ${provider ?? '默认供应商'}（并发 ${concurrency}，失败重试 ${maxRetry} 次）`)
  // 降级警告（一次/step）：能力不支持但确有参考图可用（用户主动关闭时静默）
  if (useRefs && refCap !== 'base64' && refReadyShots.some((s) => collectRefAssetIds(s, indexes, refIndex, { episode }).length > 0 || recipeRefImageIds(recipe, s.id, IMAGE_REF_ROLES).length > 0)) {
    ctx.log('当前图片供应商不支持参考图，已降级纯文本锚定（锚定注入仍生效）')
  }
  // 定妆照身份锚定（identity-lock）：步级 inputs.ref_images 指向用户按「文件名=角色名」上传的参考图资产，
  // 命中的镜头以该图作身份锚定（复刻「严格参考图片1的五官/发型/脸型」的参考图发送生成），未命中镜头零影响。
  const refImageIds = ctx.assetIdsOf('ref_images')
  const identityRefByShot = new Map<string, number>()
  if (useRefs && refImageIds.length > 0) {
    const refAssets = await ctx.assetsOf(refImageIds)
    for (const [shotId, assetId] of buildIdentityRefMap(refAssets, refReadyShots)) identityRefByShot.set(shotId, assetId)
    ctx.log(`定妆照身份参考图 ${refAssets.length} 张入料（按角色文件名匹配，命中 ${identityRefByShot.size}/${refReadyShots.length} 镜头）`)
  }
  // 智能复用（auto）：定妆照 / 场景 / 道具参考图步在 params.reuse_existing_refs=true 且步级输入 ref_mode=auto 时，
  // 逐镜查角色/场景/道具库内已有参考图→命中即复用（不建任务、不计费），仅缺图的新对象才出图（与出图能力 refCap 解耦）。
  const refMode = typeof ctx.input['ref_mode'] === 'string' ? ctx.input['ref_mode'].trim() : ''
  const reuseByShot = stepParams['reuse_existing_refs'] === true && refMode === 'auto'
    ? pickExistingRefs(refReadyShots, indexes)
    : new Map<string, number>()
  if (reuseByShot.size > 0) ctx.log(`智能复用：${reuseByShot.size}/${refReadyShots.length} 个对象库内已有参考图，直接复用不重画`)

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

  for (const shot of refReadyShots) {
    if (reuseByShot.has(shot.id)) continue // 库内已有参考图（auto 复用）：不建任务、不计费
    const existingTask = taskByShotId.get(shot.id)
    // 存量兼容：旧行（未写模型能力快照）续跑时按未收紧的总量上限取参考、且不补写快照字段，
    // 保持本能力上线前已批准 run 的发送口径不变（详见参数漂移守卫）
    const legacyRow =
      existingTask != null && existingTask.status !== 'succeeded' && existingTask.status !== 'cancelled' && !paramsHasCaps(existingTask.params)
    const shotRefLimit = legacyRow ? MAX_REFS_PER_SHOT : effectiveRefLimit
    const identityId = identityRefByShot.get(shot.id)
    let promptText = dialogue ? compileDialogueShot(recipe.plan, shot.id).imagePrompt : shot.image_prompt.trim()
    if (identityId !== undefined) promptText = `严格保持参考图中人物的五官、发型、脸型与所有识别特征完全一致，仅改变视角与姿态。${promptText}`
    // 分层参考选择：以登记索引 + 集上下文逐实体取用，产出入列 id 与逐镜语义快照（超 shotRefLimit 的量在合并处按优先级裁剪）
    const sel = collectRefSelection(shot, indexes, refIndex, { episode })
    const refAssetIds = mergeRefIds(
      identityId !== undefined ? [identityId] : [],
      mergeRefIds(recipeRefImageIds(recipe, shot.id, IMAGE_REF_ROLES), sel.ids, shotRefLimit),
      shotRefLimit,
    )
    // refUsed 口径：计划注入数（0=降级）；实际注入量以执行日志为准
    const refUsed = refCap === 'base64' && useRefs ? Math.min(refAssetIds.length, shotRefLimit) : 0
    const purpose = purposeOf(shot, stepParams, outputPurpose)
    const paramsJson = JSON.stringify({
      size,
      shotId: shot.id,
      duration: shotDurationSec(shot) ?? null,
      refAssetIds,
      refUsed,
      // 模型能力 + 逐镜分层选择快照：新建任务一律登记，存量旧行不补写（保持旧 schema 形态）
      ...(legacyRow
        ? {}
        : {
            caps: { supportsRefs: caps.supportsRefs, maxRefs: caps.maxRefs, supportsNegativePrompt: caps.supportsNegativePrompt, notes: caps.notes },
            refSelection: sel.perEntity, // 逐实体 { entityId, name, refs:[{assetId, role, reason}] }——每镜参考分层语义可追溯
            ...(sel.dropped.length > 0 ? { refDropped: sel.dropped } : {}),
          }),
      output_purpose: purpose,
      stylePresetId: styleResolved[0]?.id ?? null,
      stylePresetIds: styleResolved.map((s) => s.id),
      // 本镜命中实体 id（快照记录用；succeeded 任务不回写，不影响既有溯源）
      entityIds: matchedEntityIds(shot, indexes),
    })
    if (!existingTask) {
      const t = nowMs()
      const row = await db
        .insert(genTasks)
        .values({
          projectId: ctx.run.projectId,
          runId: ctx.run.id,
          stepId: ctx.step.id,
          kind: 'image',
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
      // 未成功任务同步最新 prompt/参数（修正分镜或调设置后续跑即生效）；
      // failed 且有变化 → 归零重排队；succeeded 保持产物溯源不动
      // 参数漂移判定按「旧行已有的键」逐项比对：仅新增可选快照字段不算漂移（详见参数漂移守卫）
      const changed = existingTask.prompt !== promptText || paramsDrifted(existingTask.params, paramsJson)
      if (changed) {
        if (recipeOf(ctx.run)) throw new Error('已批准图像任务参数发生变化，请重新规划')
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

  // 执行队列：非复用镜头中，非 succeeded 且有重试余量；cancelled 不参与
  const genShots = refReadyShots.filter((s) => !reuseByShot.has(s.id))
  const queue = genShots
    .map((s) => taskByShotId.get(s.id)!)
    .filter((t) => {
      if (t.status === 'succeeded' || t.status === 'cancelled') return false
      if (t.status === 'failed' && t.attempts > maxRetry) return false
      return true
    })
  const doneCount = genShots.length - queue.length
  if (doneCount > 0) ctx.log(`跳过已有成功产物的 ${doneCount} 个镜头`)
  if (queue.length === 0) ctx.log(reuseByShot.size > 0 ? '无待生成镜头（库内已有 / 已成功覆盖全部）' : '全部镜头已有成功产物，无新生成')

  const failures: Array<{ shotId: string; error: string }> = []
  await runPool(queue, concurrency, async (task) => {
    const fail = await runOneTask(ctx, task, { provider, model, maxRetry, refCap, useRefs, uriCache, sbAssetId: sbIds[0]! })
    if (fail) failures.push(fail)
  })

  if (failures.length > 0) {
    const sample = failures
      .slice(0, 3)
      .map((f) => `shot ${f.shotId}: ${f.error}`)
      .join('；')
    throw new Error(`出图失败 ${failures.length} 个镜头（可修正后断点续跑/重试任务）：${sample}`)
  }

  // 产物按 shots 顺序聚合：复用镜头取库内已有 asset id，其余取本步任务产物（保序、总量不变）
  const assetIds = refReadyShots
    .map((s) => reuseByShot.get(s.id) ?? taskByShotId.get(s.id)?.resultAssetId)
    .filter((id): id is number => typeof id === 'number')
  if (assetIds.length !== refReadyShots.length) {
    throw new Error(`产物与镜头数不符（${assetIds.length}/${refReadyShots.length}），请重试`)
  }
  ctx.log(`出图完成：${assetIds.length} 张 → ${assetIds.join(', ')}`)
  return { assetIds }
}

/** 单任务执行：attempts 续增，达上限后不再重试 */
async function runOneTask(
  ctx: StepContext,
  task: GenTask,
  cfg: {
    provider?: string
    model?: string
    maxRetry: number
    refCap: 'none' | 'base64'
    useRefs: boolean
    uriCache: Map<number, string>
    /** 分镜 JSON 文本资产 id（本步所有镜共用的文本来料，携版本指针） */
    sbAssetId?: number
  },
): Promise<{ shotId: string; error: string } | null> {
  const parsed = JSON.parse(task.params) as {
    size?: string
    shotId?: string
    refAssetIds?: number[]
    output_purpose?: string
    entityIds?: number[]
    caps?: { maxRefs?: number }
    refSelection?: { entityId: number; name: string; refs: { assetId: number; role: string; reason: string }[] }[]
  }
  const shotId = parsed.shotId ?? '?'
  // 发送切片口径与入队一致：登记了能力快照的按 min(总量, 快照上限) 收紧；
  // 未写能力快照的存量旧行按总量上限发送，保持本能力上线前的发送口径不变
  const taskRefLimit = Math.min(MAX_REFS_PER_SHOT, parsed.caps?.maxRefs ?? MAX_REFS_PER_SHOT)
  const recipe = recipeOf(ctx.run)
  const maxAttempts = recipe ? 1 : cfg.maxRetry + 1
  if (recipe && task.attempts > 0 && task.status !== 'succeeded') throw new Error('此前媒体提交状态需核验，不能自动重发')
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
    try {
      // 参考图注入：能力支持且未关闭 → 逐 id 转 data URI（单图失败跳过该图 + 记日志，不使任务失败）
      let refs: string[] | undefined
      // 本镜实际参考图 used/skipped（以 assetToDataUri 构建后最终集合为准）
      const refInputs: ExecInputSpec[] = []
      if (cfg.useRefs && cfg.refCap === 'base64' && parsed.refAssetIds?.length) {
        const uris: string[] = []
        let ordinal = 0
        for (const id of parsed.refAssetIds.slice(0, taskRefLimit)) {
          try {
            uris.push(await assetToDataUri(id, ctx.run.projectId, cfg.uriCache))
            refInputs.push(await assetInput('reference', id, { shotId, port: 'reference', ordinal: ordinal++ }))
          } catch (err) {
            if (recipe?.plan.performance === 'dialogue') throw new Error('对白批准参考图读取失败，禁止静默跳过')
            ctx.log(`参考图 asset#${id} 跳过（${(err as Error).message}）`)
            refInputs.push(await assetInput('reference', id, { used: false, skipReason: (err as Error).message, shotId, port: 'reference', ordinal: ordinal++ }))
          }
        }
        if (uris.length > 0) {
          refs = uris
          ctx.log(`shot ${shotId} 注入参考图 ${uris.length} 张`)
        }
      } else if (parsed.refAssetIds?.length) {
        // 能力不支持/已关闭参考注入：计划参考图未实际消费 → 记 skipped（区分「计划」与「实际」）
        let ordinal = 0
        for (const id of parsed.refAssetIds.slice(0, taskRefLimit)) {
          refInputs.push(await assetInput('reference', id, { used: false, skipReason: cfg.useRefs ? '供应商不支持参考图' : '参考注入已关闭', shotId, port: 'reference', ordinal: ordinal++ }))
        }
      }
      const { adapter, request } = await buildImageRequest({
        prompt: task.prompt ?? '',
        provider: cfg.provider,
        model: cfg.model,
        size: parsed.size,
        referenceImages: refs,
        pin: pinOf(ctx.settings.image),
      })
      const img = await adapter.generate(request)
      const asset = await saveGeneratedMedia({
        projectId: ctx.run.projectId,
        stepId: ctx.step.id,
        taskId: task.id,
        runId: ctx.run.id,
        kind: 'image',
        purpose: parsed.output_purpose ?? 'shot_image',
        prompt: task.prompt ?? '',
        params: { shotId, size: parsed.size, provider: adapter.provider },
        source: img.kind === 'url' ? { kind: 'url', url: img.url } : { kind: 'base64', data: img.data, mime: img.mime },
        width: img.width,
        height: img.height,
      })
      // 写时图像有效性检测（黑/纯色/损坏 → params.quality；fire-and-forget 不阻断）
      scheduleImageCheck(asset)
      await db
        .update(genTasks)
        .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
        .where(eq(genTasks.id, task.id))
      task.status = 'succeeded'
      task.resultAssetId = asset.id
      emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'succeeded' })
      // 用量记录：每成功图 1 行（元/张）
      await recordUsage({
        projectId: ctx.run.projectId,
        runId: ctx.run.id,
        stepId: ctx.step.id,
        taskId: task.id,
        assetId: asset.id,
        kind: 'image',
        unit: 'image',
        quantity: 1,
        provider: adapter.provider,
        model: request.model ?? cfg.model ?? null,
        ...(recipe ? { unitPrice: recipe.endpoints.image!.unitPrice } : {}),
      })
      ctx.log(`shot ${shotId} 出图完成 → asset#${asset.id}`)
      // 冻结本镜真实输入：分镜文本资产 + 参考图 used/skipped + 命中实体（版本指针），按 shotId 定位
      {
        const execInputs: ExecInputSpec[] = [...refInputs]
        if (cfg.sbAssetId != null) execInputs.push(await assetInput('text', cfg.sbAssetId, { shotId }))
        for (const eid of parsed.entityIds ?? []) execInputs.push(await entityInput('reference', eid, { shotId }))
        await safeRecordExecSnapshot({
          projectId: ctx.run.projectId,
          execKind: 'pipeline_step',
          runId: ctx.run.id,
          stepId: ctx.step.id,
          taskId: task.id,
          templateKey: ctx.run.templateKey,
          model: request.model ?? cfg.model ?? null,
          inputs: execInputs,
        })
      }
      return null
    } catch (err) {
      const msg = mediaFailure(err, !!recipe)
      if (attempts >= maxAttempts) {
        await db
          .update(genTasks)
          .set({ status: 'failed', errorMsg: msg, completedAt: nowMs(), updatedAt: nowMs() })
          .where(eq(genTasks.id, task.id))
        emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'failed', error: msg })
        ctx.log(`shot ${shotId} 出图失败（已尝试 ${maxAttempts} 次）：${msg}`)
        return { shotId, error: msg }
      }
      ctx.log(`shot ${shotId} 第 ${attempts}/${maxAttempts} 次失败，1.5s 后重试：${msg}`)
      await sleep(1500)
    }
  }
}

/** 参考图能力判定（入队前 resolve 一次）：端点/适配器不可用 → 'none'（不阻断主线） */
async function imageRefCapability(provider?: string): Promise<'none' | 'base64'> {
  try {
    const endpoint = await resolveEndpoint('image', provider)
    return getImageAdapter(endpoint.providerKey).referenceImages ?? 'none'
  } catch {
    return 'none'
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

/** 角色索引查询：原样 → 小写兜底（与 character 服务的索引键一致） */
function lookupCharacter(index: Map<string, CharacterRow>, name: string): CharacterRow | undefined {
  return index.get(name) ?? index.get(name.toLowerCase())
}

/**
 * 角色锚定注入（纯函数，供探针直接 import 断言）：
 * 逐镜按 shot.characters 命中角色库 → prompt 追加「角色锚定（{name}）：{appearance}」
 * 与（有 negative 时）「必须剔除：{negative}」；未命中角色名 → missing；
 * 返回新数组（不修改入参）；injected = 实际被注入的镜数。
 */
export function injectCharacterAnchors(
  shots: ShotSpec[],
  index: Map<string, CharacterRow>,
): { shots: ShotSpec[]; injected: number; missing: string[] } {
  const missing: string[] = []
  let injected = 0
  const out = shots.map((shot) => {
    const names = Array.isArray(shot.characters)
      ? shot.characters.filter((n) => typeof n === 'string' && !!n.trim())
      : []
    if (names.length === 0) return shot
    const bits: string[] = []
    for (const raw of names) {
      const row = lookupCharacter(index, raw.trim())
      if (!row) {
        missing.push(raw.trim())
        continue
      }
      if (row.appearance) bits.push(`角色锚定（${row.name}）：${row.appearance}`)
      if (row.negative) bits.push(`必须剔除：${row.negative}`)
    }
    if (bits.length === 0) return shot
    injected += 1
    return { ...shot, image_prompt: `${shot.image_prompt.trim()}\n${bits.join('\n')}` }
  })
  return { shots: out, injected, missing }
}

/**
 * 角色状态锚定注入（纯函数，供探针直接 import 断言）：
 * 逐镜按 shot.characters 命中角色库 → 取该行 states 中命中条目（**多条命中取数组最后一条**：数组序即时间序，后覆盖前）
 * → 追加「状态锚定（{角色名}·{节点}）：{状态短语}」到 image_prompt；details = 逐条注入明细（供日志）。
 * 无 characters / 实体无 states / 无命中 / 短语为空 → 该镜原样返回；全零注入 → 返回入参数组引用（零 diff）。
 */
export function injectStateAnchors(
  shots: ShotSpec[],
  index: Map<string, CharacterRow>,
  episode?: number,
): { shots: ShotSpec[]; injected: number; details: string[] } {
  const details: string[] = []
  let injected = 0
  const out = shots.map((shot) => {
    const names = Array.isArray(shot.characters)
      ? shot.characters.filter((n) => typeof n === 'string' && !!n.trim())
      : []
    if (names.length === 0) return shot
    const scene = typeof shot.scene === 'number' && Number.isFinite(shot.scene) ? shot.scene : undefined
    const text = [shot.id, shot.location ?? '', shot.image_prompt].join(' ')
    const bits: string[] = []
    for (const raw of names) {
      const row = lookupCharacter(index, raw.trim())
      if (!row) continue // 未命中角色由角色锚定段报告，此处静默
      let best: { node: string; phrase: string } | null = null
      for (const entry of parseStrArr(row.states)) {
        const m = matchStateEntry(entry, { scene, episode, text })
        if (m.hit && m.phrase) best = { node: m.node, phrase: m.phrase } // 后覆盖前
      }
      if (!best) continue
      bits.push(`状态锚定（${row.name}·${best.node}）：${best.phrase}`)
      details.push(`${shot.id} ${row.name}「${best.node}」→ ${best.phrase}`)
    }
    if (bits.length === 0) return shot
    injected += 1
    return { ...shot, image_prompt: `${shot.image_prompt.trim()}\n${bits.join('\n')}` }
  })
  if (injected === 0) return { shots, injected: 0, details: [] }
  return { shots: out, injected, details }
}

/**
 * 场景/道具锚定注入（纯函数，供探针直接 import 断言）：
 * shot.location 命中场景库 → 追加「场景锚定（{name}）：{appearance}」（+「必须剔除：{negative}」）；
 * shot.props[] 逐项命中道具库 → 追加「道具锚定（{name}）：{appearance}」（+ 必须剔除）；
 * 未命中名进 missing；返回新数组（不修改入参）。
 */
export function injectSetAnchors(
  shots: ShotSpec[],
  sceneIndex: Map<string, CharacterRow>,
  propIndex: Map<string, CharacterRow>,
): { shots: ShotSpec[]; sceneInjected: number; propInjected: number; missing: string[] } {
  const missing: string[] = []
  let sceneInjected = 0
  let propInjected = 0
  const out = shots.map((shot) => {
    const bits: string[] = []
    let sceneHit = false
    const loc = typeof shot.location === 'string' ? shot.location.trim() : ''
    if (loc) {
      const row = lookupCharacter(sceneIndex, loc)
      if (row) {
        const before = bits.length
        if (row.appearance) bits.push(`场景锚定（${row.name}）：${row.appearance}`)
        if (row.negative) bits.push(`必须剔除：${row.negative}`)
        sceneHit = bits.length > before
      } else {
        missing.push(loc)
      }
    }
    let propHit = false
    for (const raw of shot.props ?? []) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const row = lookupCharacter(propIndex, raw.trim())
      if (!row) {
        missing.push(raw.trim())
        continue
      }
      const before = bits.length
      if (row.appearance) bits.push(`道具锚定（${row.name}）：${row.appearance}`)
      if (row.negative) bits.push(`必须剔除：${row.negative}`)
      if (bits.length > before) propHit = true
    }
    if (bits.length === 0) return shot
    if (sceneHit) sceneInjected += 1
    if (propHit) propInjected += 1
    return { ...shot, image_prompt: `${shot.image_prompt.trim()}\n${bits.join('\n')}` }
  })
  return { shots: out, sceneInjected, propInjected, missing }
}

/**
 * 本镜命中实体 id（不改纯函数派生）：characters 命中 + location 命中 + props 命中 → characters.id 集（去重）。
 * 供快照记录实体版本指针（编辑角色/场景/道具外观 → 下游命中的镜可报）。
 */
function matchedEntityIds(
  shot: ShotSpec,
  indexes: { characters: Map<string, CharacterRow>; scenes: Map<string, CharacterRow>; props: Map<string, CharacterRow> },
): number[] {
  const ids: number[] = []
  const add = (row: CharacterRow | undefined): void => {
    if (row && !ids.includes(row.id)) ids.push(row.id)
  }
  for (const raw of shot.characters ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    add(lookupCharacter(indexes.characters, raw.trim()))
  }
  const loc = typeof shot.location === 'string' ? shot.location.trim() : ''
  if (loc) add(lookupCharacter(indexes.scenes, loc))
  for (const raw of shot.props ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    add(lookupCharacter(indexes.props, raw.trim()))
  }
  return ids
}

/**
 * 风格锚定注入（纯函数）：snippet 非空 → 逐镜 image_prompt 尾追「视觉风格：{snippet}」；
 * 空/未绑定 → 原样返回（同一引用，零注入）。
 */
export function injectStyleAnchor(shots: ShotSpec[], snippet: string | null): ShotSpec[] {
  const s = typeof snippet === 'string' ? snippet.trim() : ''
  if (!s) return shots
  return shots.map((shot) => ({ ...shot, image_prompt: `${shot.image_prompt.trim()}\n视觉风格：${s}` }))
}

/** 出图 purpose 分派：output_purpose_by_category[shot.category] → 步骤 output_purpose（默认 shot_image） */
function purposeOf(shot: ShotSpec, params: Record<string, unknown>, fallback: string): string {
  const map = params['output_purpose_by_category']
  if (map && typeof map === 'object' && !Array.isArray(map) && typeof shot.category === 'string' && shot.category.trim()) {
    const v = (map as Record<string, unknown>)[shot.category.trim()]
    if (typeof v === 'string' && v) return v
  }
  return fallback
}

/** 字符串数组列（states/aliases 等 JSON 文本）宽容解析：非数组/坏 JSON → []；剔空白项 */
function parseStrArr(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
  } catch {
    return []
  }
}

/** run.input 的 episode_number（整数且 ≥1 才算；缺失/非法 → undefined：「第N集」档降级不命中） */
function inputEpisode(inputJson: string): number | undefined {
  try {
    const v = (JSON.parse(inputJson) as Record<string, unknown>)['episode_number']
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
    return Number.isInteger(n) && n >= 1 ? n : undefined
  } catch {
    return undefined
  }
}

/** 任务参数是否登记了模型能力快照（用于识别「新入队即写快照」的任务 vs 更早形态的存量任务行） */
function paramsHasCaps(paramsJson: string): boolean {
  try {
    const obj = JSON.parse(paramsJson) as unknown
    return !!obj && typeof obj === 'object' && 'caps' in obj
  } catch {
    return false
  }
}

/**
 * 参数漂移守卫：断点续跑时，对已存在且未成功的任务重算出新的 params 快照，需判断「参数是否真的变了」。
 * 判定只按旧行本就存在的键逐项比对——旧行没有的键（后续能力新增的可选快照字段，如模型能力快照、逐镜分层选择快照、
 * 被裁剪参考记录等）一律忽略，不计入漂移、也不触发重排队。
 * 这保护的是「存量已批准运行在新能力上线后继续断点续跑」的场景：若直接整串比较，仅因新增可选快照键就会被误判为
 * 「已批准图像任务参数发生变化」而强制重新规划；同时保留既有语义——旧行已有的任一键值发生变化（或被删除）仍判为漂移，
 * 走原有的同步 / 重排队 / 已批准链报错分支。
 * 任一参数无法解析为对象时按最严处理（判为漂移），沿用既有防护路径。
 */
function paramsDrifted(oldParams: string, newParams: string): boolean {
  if (oldParams === newParams) return false
  let oldObj: unknown
  let newObj: unknown
  try {
    oldObj = JSON.parse(oldParams)
    newObj = JSON.parse(newParams)
  } catch {
    return true
  }
  if (!oldObj || typeof oldObj !== 'object' || Array.isArray(oldObj)) return true
  if (!newObj || typeof newObj !== 'object' || Array.isArray(newObj)) return true
  const oldRecord = oldObj as Record<string, unknown>
  const newRecord = newObj as Record<string, unknown>
  for (const key of Object.keys(oldRecord)) {
    if (JSON.stringify(oldRecord[key]) !== JSON.stringify(newRecord[key])) return true
  }
  return false
}
