import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { genTasks, pipelineRuns, type CharacterRow, type GenTask } from '../../db/schema'
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
import { pinOf, recipeOf, mediaFailure, recipeRefImageIds } from '../../services/creation-chat/recipe'

interface ShotSpec {
  id: string
  image_prompt: string
  duration?: number
  /** 角色名（含别名）列表：命中角色库 → 自动注入 appearance/negative 锚定（E3） */
  characters?: string[]
  /** [M8] 场景名（与场景库对齐）：命中 → 注入场景锚定 + 参考图 */
  location?: string
  /** [M8] 道具名列表（与道具库对齐）：命中 → 注入道具锚定 + 参考图 */
  props?: string[]
  /** [M8] 素材参考图链分类（scene|prop；output_purpose_by_category 按此分派 purpose） */
  category?: string
  /** [M19 P7] 场次号（storyboard-ep v7 的 scene）：states「第N场」定位词命中依据；缺失 → 场次档不命中 */
  scene?: number
  /** [M22] 画布直通参考图资产 id（前插注入，保序去重；与实体锚定参考共存） */
  ref_asset_ids?: number[]
}

const nowMs = (): number => Date.now()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 单镜角色参考图上限（M6 语义：按角色出场顺序截断） */
const MAX_CHARACTER_REFS_PER_SHOT = 4

/** [M8] 单镜参考图总量上限（角色 ≤4 + 场景 ≤1 + 道具 ≤1） */
const MAX_REFS_PER_SHOT = 6

/** [M31] 并入 ai_image 参考图通道的批准参考角色（风格/主体/首帧） */
const IMAGE_REF_ROLES = ['style', 'subject', 'first_frame'] as const

/** [M31] 参考图 id 合并（M31 上传参考前置 → 实体/画布参考，保序去重，总量 ≤MAX_REFS_PER_SHOT） */
function mergeRefIds(primary: number[], secondary: number[]): number[] {
  const ids: number[] = []
  const seen = new Set<number>()
  for (const id of [...primary, ...secondary]) {
    if (!seen.has(id)) { seen.add(id); ids.push(id) }
  }
  return ids.slice(0, MAX_REFS_PER_SHOT)
}

/**
 * ai_image：批量镜头出图（spec §5.3）。
 * 输入 batch.field（默认 shots）→ 分镜 JSON 资产 → 每镜头一条 gen_task；
 * 逐镜锚定注入（注入全文进 prompt 快照）：角色（shot.characters）→ 状态（[M19 P7] 角色 states 命中）→ 场景/道具（shot.location/props）→ 风格（项目绑定预设）；
 * 参考图（角色定妆照 + 场景/道具参考图）在供应商能力支持时转 data URI 注入（M6/M8，params.refUsed 记计划注入数）；
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

  // 锚定注入（E3/M8，快照即一致性硬证据）：角色 → 场景/道具 → 风格，逐段叠加
  const charIndex = await loadEntityIndex(ctx.run.projectId, 'character')
  const sceneIndex = await loadEntityIndex(ctx.run.projectId, 'scene')
  const propIndex = await loadEntityIndex(ctx.run.projectId, 'prop')
  const indexes = { characters: charIndex, scenes: sceneIndex, props: propIndex }
  const { shots: charShots, injected, missing } = injectCharacterAnchors(shots, charIndex)
  ctx.log(`角色锚定注入 ${injected} 镜${missing.length > 0 ? `（未命中角色：${missing.join('、')}）` : ''}`)
  // [M19 P7] 角色状态锚定：逐镜命中角色 states（场次/集/文本三级）→ 追加状态短语；无 states / 无命中 → 零注入
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
  const size = typeof imgCfg['size'] === 'string' ? imgCfg['size'] : '832x1248'
  const stepParams = (ctx.def.params ?? {}) as Record<string, unknown>
  const useRefs = stepParams['use_character_refs'] !== false // M8 语义：参考图注入总开关（角色 + 场景/道具；参数名保持兼容）
  const outputPurpose =
    typeof stepParams['output_purpose'] === 'string' && stepParams['output_purpose'] ? stepParams['output_purpose'] : 'shot_image'
  // 风格锚定注入（M8；[M13] 多预设叠加）：项目绑定预设（可多个）→ 运行时解析 → 逐块拼接尾追「视觉风格：…」；未绑定/停用 → 零注入 + 日志
  const useStylePreset = stepParams['use_style_preset'] !== false
  const styleResolved = useStylePreset ? await resolveProjectStyleSnippets(ctx.run.projectId) : []
  if (useStylePreset && styleResolved.length === 0) ctx.log('项目未绑定风格预设 / 预设已停用，跳过风格注入')
  const finalShots = injectStyleAnchor(setShots, combineStyleSnippets(styleResolved.map((s) => s.snippet)))
  if (styleResolved.length > 0) {
    ctx.log(`风格注入：${styleResolved.map((s) => s.name).join(' + ')}（预设 ${styleResolved.map((s) => `#${s.id}`).join(',')}）`)
  }
  // 参考图能力判定：入队前 resolve 一次（失败视为 none，不阻断主线）；data URI 缓存 step 级（同图多镜只算一次）
  // [M31] 批准的参考图片（风格/主体/首帧）并入本镜参考图通道（确定性、可幂等：recipe 固定 → params 稳定）
  const recipe = recipeOf(ctx.run)
  const refCap = pinOf(imgCfg) ? getImageAdapter(provider!).referenceImages ?? 'none' : await imageRefCapability(provider)
  const uriCache = new Map<number, string>()
  ctx.log(`批量出图：${finalShots.length} 镜头 × ${provider ?? '默认供应商'}（并发 ${concurrency}，失败重试 ${maxRetry} 次）`)
  // 降级警告（一次/step）：能力不支持但确有参考图可用（用户主动关闭时静默）
  if (useRefs && refCap !== 'base64' && finalShots.some((s) => collectRefAssetIds(s, indexes).length > 0 || recipeRefImageIds(recipe, s.id, IMAGE_REF_ROLES).length > 0)) {
    ctx.log('当前图片供应商不支持参考图，已降级纯文本锚定（锚定注入仍生效）')
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

  for (const shot of finalShots) {
    const promptText = shot.image_prompt.trim()
    const refAssetIds = mergeRefIds(recipeRefImageIds(recipe, shot.id, IMAGE_REF_ROLES), collectRefAssetIds(shot, indexes))
    // refUsed 口径：计划注入数（0=降级）；实际注入量以执行日志为准
    const refUsed = refCap === 'base64' && useRefs ? Math.min(refAssetIds.length, MAX_REFS_PER_SHOT) : 0
    const purpose = purposeOf(shot, stepParams, outputPurpose)
    const paramsJson = JSON.stringify({
      size,
      shotId: shot.id,
      duration: shotDurationSec(shot) ?? null,
      refAssetIds,
      refUsed,
      output_purpose: purpose,
      stylePresetId: styleResolved[0]?.id ?? null,
      stylePresetIds: styleResolved.map((s) => s.id),
      // [M29·R02] 本镜命中实体 id（快照记录用；succeeded 任务不回写，不影响既有溯源）
      entityIds: matchedEntityIds(shot, indexes),
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
      const changed = existingTask.prompt !== promptText || existingTask.params !== paramsJson
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

  // 执行队列：非 succeeded 且有重试余量；cancelled 不参与
  const queue = finalShots
    .map((s) => taskByShotId.get(s.id)!)
    .filter((t) => {
      if (t.status === 'succeeded' || t.status === 'cancelled') return false
      if (t.status === 'failed' && t.attempts > maxRetry) return false
      return true
    })
  const doneCount = finalShots.length - queue.length
  if (doneCount > 0) ctx.log(`跳过已有成功产物的 ${doneCount} 个镜头`)
  if (queue.length === 0) ctx.log('全部镜头已有成功产物，无新生成')

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

  // 产物按 shots 顺序聚合
  const assetIds = finalShots
    .map((s) => taskByShotId.get(s.id)!.resultAssetId)
    .filter((id): id is number => typeof id === 'number')
  if (assetIds.length !== finalShots.length) {
    throw new Error(`产物与镜头数不符（${assetIds.length}/${finalShots.length}），请重试`)
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
    /** [M29·R02] 分镜 JSON 文本资产 id（本步所有镜共用的文本来料，携版本指针） */
    sbAssetId?: number
  },
): Promise<{ shotId: string; error: string } | null> {
  const parsed = JSON.parse(task.params) as {
    size?: string
    shotId?: string
    refAssetIds?: number[]
    output_purpose?: string
    entityIds?: number[]
  }
  const shotId = parsed.shotId ?? '?'
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
      // [M29·R02] 本镜实际参考图 used/skipped（以 assetToDataUri 构建后最终集合为准）
      const refInputs: ExecInputSpec[] = []
      if (cfg.useRefs && cfg.refCap === 'base64' && parsed.refAssetIds?.length) {
        const uris: string[] = []
        let ordinal = 0
        for (const id of parsed.refAssetIds.slice(0, MAX_REFS_PER_SHOT)) {
          try {
            uris.push(await assetToDataUri(id, cfg.uriCache))
            refInputs.push(await assetInput('reference', id, { shotId, port: 'reference', ordinal: ordinal++ }))
          } catch (err) {
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
        for (const id of parsed.refAssetIds.slice(0, MAX_REFS_PER_SHOT)) {
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
      // [M12] 写时图像有效性检测（黑/纯色/损坏 → params.quality；fire-and-forget 不阻断）
      scheduleImageCheck(asset)
      await db
        .update(genTasks)
        .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
        .where(eq(genTasks.id, task.id))
      task.status = 'succeeded'
      task.resultAssetId = asset.id
      emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'succeeded' })
      // [M4] 用量记录：每成功图 1 行（元/张）
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
      // [M29·R02] 冻结本镜真实输入：分镜文本资产 + 参考图 used/skipped + 命中实体（版本指针），按 shotId 定位
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
          templateKey: ctx.def.key,
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

async function runCancelled(runId: number): Promise<boolean> {
  const rows = await db
    .select({ status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1)
  return rows[0]?.status === 'cancelled'
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
 * states 条目解析（纯函数）：首个「：」/「:」分割为 { node, phrase }；
 * 无分隔符 → node=全串、phrase=''（两侧空白剔除；非字符串入参视为空条目）。
 */
export function parseStateEntry(s: unknown): { node: string; phrase: string } {
  const raw = typeof s === 'string' ? s.trim() : ''
  if (!raw) return { node: '', phrase: '' }
  const i = raw.search(/[：:]/)
  if (i < 0) return { node: raw, phrase: '' }
  return { node: raw.slice(0, i).trim(), phrase: raw.slice(i + 1).trim() }
}

/** 定位词数值解析：阿拉伯数字或中文数字（一~九十九，含十/二十/三十五）；不可解析 → null */
function numFromToken(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const m = /^(?:([一二三四五六七八九])?十)([一二三四五六七八九])?$/.exec(s)
  if (m) return (m[1] ? cn[m[1]]! : 1) * 10 + (m[2] ? cn[m[2]]! : 0)
  return cn[s] ?? null
}

/** states 命中档位：scene=场次定位词 / episode=集数定位词 / text=无定位词按文本包含 */
export type StateMatchMode = 'scene' | 'episode' | 'text'

/** states 定位词：第N场 / 第N场次 / 第N集（N = 阿拉伯数字或中文数字一至九十九） */
const STATE_SCENE_RE = /第\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*场(?:次)?/
const STATE_EPISODE_RE = /第\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*集/

/**
 * 单条 states 命中判定（纯函数，供探针直接 import 断言）：
 * 1) 节点含「第N场/第N场次」（阿拉伯或中文数字）→ 与 ctx.scene 数值相等判命中（scene 缺失 → 不命中，**不做文本兜底**）；
 * 2) 否则节点含「第N集」→ 与 ctx.episode 相等判命中（episode 缺失 → 不命中）；
 * 3) 否则（无定位词）→ 节点串包含于 ctx.text 判命中。
 * 恒返回 { hit, mode, node, phrase }，mode = 实际生效档位。
 */
export function matchStateEntry(
  entry: string,
  ctx: { scene?: number; episode?: number; text?: string },
): { hit: boolean; mode: StateMatchMode; node: string; phrase: string } {
  const { node, phrase } = parseStateEntry(entry)
  const sceneHit = STATE_SCENE_RE.exec(node)
  if (sceneHit) {
    const n = numFromToken(sceneHit[1]!)
    return { hit: n !== null && typeof ctx.scene === 'number' && ctx.scene === n, mode: 'scene', node, phrase }
  }
  const epHit = STATE_EPISODE_RE.exec(node)
  if (epHit) {
    const n = numFromToken(epHit[1]!)
    return { hit: n !== null && typeof ctx.episode === 'number' && ctx.episode === n, mode: 'episode', node, phrase }
  }
  const text = typeof ctx.text === 'string' ? ctx.text : ''
  return { hit: !!node && text.includes(node), mode: 'text', node, phrase }
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
 * 本镜参考图收集（纯函数，任务 params.refAssetIds 快照源）：
 * [M22] shot.ref_asset_ids 直通（前插）→ 角色（shot.characters，≤MAX_CHARACTER_REFS_PER_SHOT）→ 场景（shot.location 命中行，≤1）→ 道具（shot.props 命中行并集，≤1）；
 * 保序去重；总量 ≤MAX_REFS_PER_SHOT。
 */
export function collectRefAssetIds(
  shot: ShotSpec,
  indexes: { characters: Map<string, CharacterRow>; scenes: Map<string, CharacterRow>; props: Map<string, CharacterRow> },
): number[] {
  const ids: number[] = []
  const seen = new Set<number>()
  const push = (id: number): boolean => {
    if (seen.has(id)) return false
    seen.add(id)
    ids.push(id)
    return true
  }
  // 0) [M22] 画布直通（shots.ref_asset_ids 前插——画布连线比实体锚定更显式）
  for (const raw of shot.ref_asset_ids ?? []) {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) push(raw)
  }
  // 1) 角色（M6 语义：按出场顺序截断至 4）
  let charAdded = 0
  for (const raw of shot.characters ?? []) {
    if (charAdded >= MAX_CHARACTER_REFS_PER_SHOT) break
    if (typeof raw !== 'string' || !raw.trim()) continue
    const row = lookupCharacter(indexes.characters, raw.trim())
    if (!row) continue
    for (const id of parseNumArr(row.refAssetIds)) {
      if (charAdded >= MAX_CHARACTER_REFS_PER_SHOT) break
      if (push(id)) charAdded += 1
    }
  }
  // 2) 场景（location 命中行，≤1）
  const loc = typeof shot.location === 'string' ? shot.location.trim() : ''
  if (loc) {
    const row = lookupCharacter(indexes.scenes, loc)
    const id = row ? parseNumArr(row.refAssetIds)[0] : undefined
    if (id !== undefined) push(id)
  }
  // 3) 道具（props 命中行并集，≤1）
  for (const raw of shot.props ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const row = lookupCharacter(indexes.props, raw.trim())
    const id = row ? parseNumArr(row.refAssetIds)[0] : undefined
    if (id !== undefined) {
      push(id)
      break
    }
  }
  return ids.slice(0, MAX_REFS_PER_SHOT)
}

/**
 * [M29·R02] 本镜命中实体 id（不改纯函数派生）：characters 命中 + location 命中 + props 命中 → characters.id 集（去重）。
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

function parseNumArr(s: string): number[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}