import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, genTasks, pipelineSteps, type Asset, type GenTask, type PipelineRun, type PipelineStep } from '../../db/schema'
import { WORKBENCH_ACTIONS, getRunOrThrow, getStepOrThrow, outputIdsOf, sameIds, selectedMapOf, shotIdOfAsset, type ShotSpec } from './helpers'
import { isCreationTemplate } from '../creation-chat/recipe'
import { checkRepairable, isGateReviewStep, resolveStoryboardSource } from './inspect'

/** 分镜时长双口径读取：duration 优先，回退 duration_sec（LLM 原始分镜字段）；非法值 → null */
export function shotDurationSec(shot: object): number | null {
  const o = shot as { duration?: unknown; duration_sec?: unknown }
  for (const key of ['duration', 'duration_sec'] as const) {
    const v = o[key]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return null
}

export interface BoardVersion {
  id: number
  name: string
  createdAt: number
  width: number | null
  height: number | null
  duration: number | null
  prompt: string | null
  /** 版本来源：task=步骤任务产物 / upload=本地上传入库 */
  source: 'task' | 'upload'
  /** 收藏标记（1=已收藏；版本清理保留豁免） */
  isFavorite: number
  /** 图像检测摘要（无/坏数据 → null，前端不显示徽标） */
  quality: { ok: boolean | null; reason: string } | null
  urls: { file: string; thumb: string | null }
}

export interface BoardTask {
  id: number
  status: string
  attempts: number
  errorMsg: string | null
  prompt: string | null
}

export interface BoardShot {
  shotId: string
  order: number
  imagePrompt: string
  motionPrompt: string
  duration: number | null
  task: BoardTask | null
  selectedAssetId: number | null
  versions: BoardVersion[]
  /** 分镜对象全量（大编辑器字段回显/动态键值行） */
  raw: Record<string, unknown>
}

export interface ShotBoard {
  step: { id: number; key: string; title: string | null; action: string; status: string }
  shots: BoardShot[]
  compose: { stepKey: string; composedAt: number | null; stale: boolean | null } | null
  repairable: { ok: boolean; reason: string | null }
  /** 审阅闸门暂停：本步正持有 waiting_input 人工闸→允许逐镜重出（其余工作台操作仍锁） */
  gateRegenerate: boolean
  /** 闸门暂停且非轻松创作：开放逐镜改词+保存并重生成（轻松创作批准链冻结 prompt，仍只可同词重出） */
  gateEdit: boolean
}

// ---------- 聚合读 ----------

/** 工作台聚合读：shots × tasks × 版本组 × 当前选中 × 合成新鲜度 五合一 */
export async function buildShotBoard(runId: number, stepKey: string): Promise<ShotBoard> {
  const run = await getRunOrThrow(runId)
  const step = await getStepOrThrow(runId, stepKey)
  const repairable = await checkRepairable(runId, stepKey, WORKBENCH_ACTIONS)

  // 分镜源（解析失败 → shots=[] + repairable.reason 说明）
  let shots: ShotSpec[] = []
  let parseError: string | null = null
  try {
    shots = (await resolveStoryboardSource(run, step)).shots
  } catch (err) {
    parseError = err instanceof Error ? err.message : '分镜解析失败'
  }

  // 该步骤全部任务 → 每镜任务（参数损坏行跳过，与 action 一致）
  const tasks = await db
    .select()
    .from(genTasks)
    .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, step.id)))
  const taskByShotId = new Map<string, GenTask>()
  for (const t of tasks) {
    try {
      const p = JSON.parse(t.params) as { shotId?: string }
      if (p.shotId && !taskByShotId.has(p.shotId)) taskByShotId.set(p.shotId, t)
    } catch {
      // 参数损坏任务：不参与
    }
  }

  // 版本组：该步骤任务的全部产物（assets.task_id = gen_tasks.id；created_at 升序 = 版本序列）
  const taskIds = tasks.map((t) => t.id)
  const versionRows = taskIds.length
    ? await db
        .select()
        .from(assets)
        .where(and(inArray(assets.taskId, taskIds), isNull(assets.deletedAt)))
        .orderBy(asc(assets.createdAt))
    : []
  const versionsByTaskId = new Map<number, Asset[]>()
  for (const a of versionRows) {
    if (a.taskId == null) continue
    const list = versionsByTaskId.get(a.taskId) ?? []
    list.push(a)
    versionsByTaskId.set(a.taskId, list)
  }

  // 续跑继承：succeeded 任务的 resultAssetId 可能指向被取代旧 run 的产物（其 assets.task_id 仍属旧任务，
  // 按 taskId 分组查不到）→ 显式把「任务当前产物」并入其版本组，保证续跑工作台仍展示旧 run 已出图（按引用零成本）。
  // 正常任务其产物已按 taskId 命中 versionRows，会被 knownIds 跳过，无副作用。
  const knownIds = new Set(versionRows.map((a) => a.id))
  const carriedIds = tasks
    .map((t) => t.resultAssetId)
    .filter((id): id is number => id != null && !knownIds.has(id))
  if (carriedIds.length) {
    const carried = await db
      .select()
      .from(assets)
      .where(and(inArray(assets.id, carriedIds), isNull(assets.deletedAt)))
    const carriedById = new Map(carried.map((a) => [a.id, a]))
    for (const t of tasks) {
      const rid = t.resultAssetId
      if (rid == null || knownIds.has(rid)) continue
      const a = carriedById.get(rid)
      if (!a) continue
      const list = versionsByTaskId.get(t.id) ?? []
      list.push(a)
      versionsByTaskId.set(t.id, list)
    }
  }

  // 上传资产版本组：本步骤 + taskId=null（外来图入镜；与任务版本按 createdAt 升序合并）
  const uploadRows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.stepId, step.id), isNull(assets.taskId), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt))
  const uploadsByShotId = new Map<string, Asset[]>()
  for (const a of uploadRows) {
    const sid = shotIdOfAsset(a)
    if (!sid) continue
    const list = uploadsByShotId.get(sid) ?? []
    list.push(a)
    uploadsByShotId.set(sid, list)
  }

  // 当前选中：output 保序，同镜取首个命中
  const { selected: selectedByShotId } = await selectedMapOf(step)

  const boardShots: BoardShot[] = shots.map((s, order) => {
    const task = taskByShotId.get(s.id) ?? null
    const merged = [...(task ? (versionsByTaskId.get(task.id) ?? []) : []), ...(uploadsByShotId.get(s.id) ?? [])]
    merged.sort((x, y) => x.createdAt - y.createdAt)
    return {
      shotId: s.id,
      order,
      imagePrompt: typeof s.image_prompt === 'string' ? s.image_prompt : '',
      motionPrompt: typeof s.motion_prompt === 'string' ? s.motion_prompt : '',
      duration: shotDurationSec(s),
      task: task
        ? { id: task.id, status: task.status, attempts: task.attempts, errorMsg: task.errorMsg, prompt: task.prompt }
        : null,
      selectedAssetId: selectedByShotId.get(s.id) ?? null,
      versions: merged.map(toVersionView),
      raw: s as Record<string, unknown>,
    }
  })

  const compose = await buildComposeInfo(run)
  // 审阅闸门暂停：整块工作台仍锁（repairable.ok=false），但单镜重出可用；把默认「正在执行/排队」
  // 误导语换成与闸门语义一致的提示（避免用户误以为引擎在跑而干等）。
  const gateRegenerate = isGateReviewStep(run, step)
  // 改词能力分层：非轻松创作（drama 等）分镜是提示词唯一事实源，闸门期可改词重生成；
  // 轻松创作批准链冻结 prompt，提示引导驳回回会话重批。
  const gateEdit = gateRegenerate && !isCreationTemplate(run.templateKey)
  const gateReason = gateEdit
    ? '审阅暂停中：可逐镜重出或修改提示词后重生成（均重新计费），其余操作待收敛后进行'
    : '审阅暂停中：可逐镜重出不满意的首帧（重新计费）；提示词由批准方案冻结，需改词请驳回后回轻松创作会话重新批准'
  const shownRepairable =
    gateRegenerate && !repairable.ok
      ? { ok: false, reason: gateReason }
      : repairable
  const finalRepairable =
    shownRepairable.ok && parseError ? { ok: false, reason: `分镜解析失败：${parseError}` } : shownRepairable

  return {
    step: { id: step.id, key: step.stepKey, title: step.title, action: step.actionKey, status: step.status },
    shots: boardShots,
    compose,
    repairable: finalRepairable,
    gateRegenerate,
    gateEdit,
  }
}

/** 合成新鲜度信息（run 无 ffmpeg_merge 步骤 → null） */
async function buildComposeInfo(run: PipelineRun): Promise<ShotBoard['compose']> {
  const steps = await db
    .select()
    .from(pipelineSteps)
    .where(eq(pipelineSteps.runId, run.id))
    .orderBy(asc(pipelineSteps.seq))
  const composeStep = steps.find((s) => s.actionKey === 'ffmpeg_merge')
  if (!composeStep) return null
  const outIds = outputIdsOf(composeStep)
  if (outIds.length === 0) return { stepKey: composeStep.stepKey, composedAt: null, stale: null }
  const rows = await db.select().from(assets).where(inArray(assets.id, outIds)).orderBy(asc(assets.createdAt))
  const finalAsset = rows[0] ?? null
  if (!finalAsset) return { stepKey: composeStep.stepKey, composedAt: null, stale: null }
  const stale = await computeStale(finalAsset, steps)
  return { stepKey: composeStep.stepKey, composedAt: finalAsset.createdAt, stale }
}

/**
 * stale 判定：成片产物 params.inputs 快照 vs 当前上游真实输出（任一不等 → true）。
 * - images / motion_clips：快照 id 数组 vs 「其产出步骤」当前 output.asset_ids（同口径全序对比）；
 * - shots_source：快照分镜资产是否仍在产出步骤当前 output 中（分镜被工作台编辑替换 → 不在 → stale）；
 * - 兜底：shots_source 缺失/断链（存量快照、跨 run 资产引用）时，分镜资产晚于成片 → stale=true；
 * - 旧产物无 inputs 快照 / 全部对比项不可用 → null（无法判定，前端降级为常态提示）。
 */
async function computeStale(finalAsset: Asset, runSteps: PipelineStep[]): Promise<boolean | null> {
  let inputs: Record<string, unknown> | null = null
  if (finalAsset.params) {
    try {
      const p = JSON.parse(finalAsset.params) as { inputs?: unknown }
      if (p.inputs && typeof p.inputs === 'object') inputs = p.inputs as Record<string, unknown>
    } catch {
      inputs = null
    }
  }
  if (!inputs) return null

  const stepById = new Map(runSteps.map((s) => [s.id, s]))
  const producerCache = new Map<number, PipelineStep | null>()
  const producerOf = async (assetId: number): Promise<PipelineStep | null> => {
    const cached = producerCache.get(assetId)
    if (cached !== undefined) return cached
    const rows = await db.select({ stepId: assets.stepId }).from(assets).where(eq(assets.id, assetId)).limit(1)
    const sid = rows[0]?.stepId
    const step = sid != null ? (stepById.get(sid) ?? null) : null
    producerCache.set(assetId, step)
    return step
  }

  let compared = 0
  for (const key of ['images', 'motion_clips']) {
    const snap = inputs[key]
    if (!Array.isArray(snap) || snap.length === 0) continue
    const first = Number(snap[0])
    if (!Number.isInteger(first) || first <= 0) continue
    const producer = await producerOf(first)
    if (!producer) continue
    compared += 1
    if (!sameIds(snap.map(Number), outputIdsOf(producer))) return true
  }
  const src = inputs['shots_source']
  if (typeof src === 'number' && Number.isInteger(src) && src > 0) {
    const producer = await producerOf(src)
    if (producer) {
      compared += 1
      if (!outputIdsOf(producer).includes(src)) return true
    }
  }
  // 分镜编辑兜底：shots_source 缺失/断链（存量快照、跨 run 资产引用）时，
  // 以「分镜资产晚于成片」判定分镜已被编辑（保守：不参与 compared，null 语义不变）
  const sbStep = runSteps.find((s) => s.stepKey === 'make_storyboard')
  if (sbStep) {
    const sbIds = outputIdsOf(sbStep)
    if (sbIds.length > 0) {
      const sbRows = await db.select({ createdAt: assets.createdAt }).from(assets).where(eq(assets.id, sbIds[0]!)).limit(1)
      const sbAt = sbRows[0]?.createdAt
      if (sbAt != null && sbAt > finalAsset.createdAt) return true
    }
  }
  return compared > 0 ? false : null
}

/** 版本视图组装（导出供 probe-m12 直测 quality 摘要过滤与容错） */
export function toVersionView(a: Asset): BoardVersion {
  return {
    id: a.id,
    name: a.name,
    createdAt: a.createdAt,
    width: a.width,
    height: a.height,
    duration: a.duration,
    prompt: a.prompt,
    source: a.taskId == null ? 'upload' : 'task',
    isFavorite: a.isFavorite,
    quality: parseQualityBrief(a.params),
    urls: {
      file: `/api/v1/assets/${a.id}/file`,
      // v=2：早期缩略图端点直接回原图（客户端可能缓存 24h），版本参数强制失效旧缓存
      thumb: a.kind === 'image' || a.kind === 'video' ? `/api/v1/assets/${a.id}/thumb?v=2` : null,
    },
  }
}

/** params.quality 摘要（board 下发 ok/reason；stats/checkedAt 不下发） */
function parseQualityBrief(params: string | null): BoardVersion['quality'] {
  if (!params) return null
  try {
    const q = (JSON.parse(params) as { quality?: unknown }).quality
    if (!q || typeof q !== 'object') return null
    const o = q as { ok?: unknown; reason?: unknown }
    if (typeof o.reason !== 'string') return null
    return { ok: typeof o.ok === 'boolean' ? o.ok : null, reason: o.reason }
  } catch {
    return null
  }
}
