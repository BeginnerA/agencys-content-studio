import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { genTasks, pipelineRuns, type CharacterRow, type GenTask } from '../../db/schema'
import { buildImageRequest, getImageAdapter, resolveEndpoint } from '../../adapters/provider'
import { assetToDataUri } from '../../services/asset-ref'
import { loadCharacterIndex } from '../../services/character'
import { saveGeneratedMedia } from '../../services/net'
import { emitStudioEvent } from '../../services/events'
import { shotDurationSec } from '../../services/shot-workbench'
import { recordUsage } from '../../services/usage'
import type { StepContext } from '../context'
import type { StepResult } from '../types'
import { RunCancelledError } from '../types'

interface ShotSpec {
  id: string
  image_prompt: string
  duration?: number
  /** 角色名（含别名）列表：命中角色库 → 自动注入 appearance/negative 锚定（E3） */
  characters?: string[]
}

const nowMs = (): number => Date.now()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 单镜参考图上限（按角色出场顺序截断；refAssetIdsOf 已保序去重） */
const MAX_CHARACTER_REFS_PER_SHOT = 4

/**
 * ai_image：批量镜头出图（spec §5.3）。
 * 输入 batch.field（默认 shots）→ 分镜 JSON 资产 → 每镜头一条 gen_task；
 * 逐镜按 shot.characters 从角色库注入 appearance/negative 锚定（E3，注入全文进 prompt 快照）；
 * 角色定妆照（refAssetIds）在供应商能力支持时转 data URI 注入参考图（M6，params.refUsed 记计划注入数）；
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

  // 角色锚定注入（E3）：命中角色库 → prompt 追加 appearance/negative 全文（快照即一致性硬证据）
  const charIndex = await loadCharacterIndex(ctx.run.projectId)
  const { shots: finalShots, injected, missing } = injectCharacterAnchors(shots, charIndex)
  ctx.log(`角色锚定注入 ${injected} 镜${missing.length > 0 ? `（未命中角色：${missing.join('、')}）` : ''}`)

  const imgCfg = (ctx.settings.image ?? {}) as Record<string, unknown>
  const provider = typeof imgCfg['provider'] === 'string' ? imgCfg['provider'] : undefined
  const model = typeof imgCfg['model'] === 'string' ? imgCfg['model'] : undefined
  const size = typeof imgCfg['size'] === 'string' ? imgCfg['size'] : '832x1248'
  const stepParams = (ctx.def.params ?? {}) as Record<string, unknown>
  const useCharacterRefs = stepParams['use_character_refs'] !== false
  const outputPurpose =
    typeof stepParams['output_purpose'] === 'string' && stepParams['output_purpose'] ? stepParams['output_purpose'] : 'shot_image'
  // 参考图能力判定：入队前 resolve 一次（失败视为 none，不阻断主线）；data URI 缓存 step 级（同图多镜只算一次）
  const refCap = await imageRefCapability(provider)
  const uriCache = new Map<number, string>()
  ctx.log(`批量出图：${finalShots.length} 镜头 × ${provider ?? '默认供应商'}（并发 ${concurrency}，失败重试 ${maxRetry} 次）`)
  // 降级警告（一次/step）：能力不支持但确有参考图可用（用户主动关闭时静默）
  if (useCharacterRefs && refCap !== 'base64' && finalShots.some((s) => refAssetIdsOf(s, charIndex).length > 0)) {
    ctx.log('当前图片供应商不支持参考图，已降级纯文本锚定（角色锚定注入仍生效）')
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
    const refAssetIds = refAssetIdsOf(shot, charIndex)
    // refUsed 口径：计划注入数（0=降级）；实际注入量以执行日志为准
    const refUsed = refCap === 'base64' && useCharacterRefs ? Math.min(refAssetIds.length, MAX_CHARACTER_REFS_PER_SHOT) : 0
    const paramsJson = JSON.stringify({ size, shotId: shot.id, duration: shotDurationSec(shot) ?? null, refAssetIds, refUsed, output_purpose: outputPurpose })
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
    const fail = await runOneTask(ctx, task, { provider, model, maxRetry, refCap, useCharacterRefs, uriCache })
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
    useCharacterRefs: boolean
    uriCache: Map<number, string>
  },
): Promise<{ shotId: string; error: string } | null> {
  const parsed = JSON.parse(task.params) as { size?: string; shotId?: string; refAssetIds?: number[]; output_purpose?: string }
  const shotId = parsed.shotId ?? '?'
  const maxAttempts = cfg.maxRetry + 1
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
      if (cfg.useCharacterRefs && cfg.refCap === 'base64' && parsed.refAssetIds?.length) {
        const uris: string[] = []
        for (const id of parsed.refAssetIds.slice(0, MAX_CHARACTER_REFS_PER_SHOT)) {
          try {
            uris.push(await assetToDataUri(id, cfg.uriCache))
          } catch (err) {
            ctx.log(`参考图 asset#${id} 跳过（${(err as Error).message}）`)
          }
        }
        if (uris.length > 0) {
          refs = uris
          ctx.log(`shot ${shotId} 注入参考图 ${uris.length} 张`)
        }
      }
      const { adapter, request } = await buildImageRequest({
        prompt: task.prompt ?? '',
        provider: cfg.provider,
        model: cfg.model,
        size: parsed.size,
        referenceImages: refs,
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
      })
      ctx.log(`shot ${shotId} 出图完成 → asset#${asset.id}`)
      return null
    } catch (err) {
      const msg = (err as Error).message
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

/** 本镜命中角色的 refAssetIds 并集（去重 → 任务 params 快照） */
function refAssetIdsOf(shot: ShotSpec, index: Map<string, CharacterRow>): number[] {
  const ids = new Set<number>()
  for (const raw of shot.characters ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const row = lookupCharacter(index, raw.trim())
    if (!row) continue
    for (const id of parseNumArr(row.refAssetIds)) ids.add(id)
  }
  return [...ids]
}

function parseNumArr(s: string): number[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}