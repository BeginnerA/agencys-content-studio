import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { characters, genTasks, projects, type CharacterRow, type GenTask } from '../db/schema'
import { buildImageRequest, getImageAdapter, resolveEndpoint } from '../adapters/provider'
import { createLogger } from '../logger'
import { assetToDataUri } from './asset-ref'
import { attachRefAssetsById } from './character'
import { GLOBAL_POOL_ID } from './global-pool'
import { WorkbenchError } from './shot'
import { emitStudioEvent } from './events'
import { scheduleImageCheck } from './image-check'
import { saveGeneratedMedia } from './net'
import { combineStyleSnippets, resolveProjectStyleSnippets } from './style-preset'
import { recordUsage } from './usage'

/**
 * 素材页批量生成参考图（spec §2.4 ⑥）：
 * - 无 run 异步任务队列（gen_tasks：runId/stepId/canvasNodeId 均 null，params.source='entity_ref_gen' 标识域）；
 * - 执行器镜像 creation-gen 的 runCanvasTask 生命周期：进程内信号量 ≤2 / attempts 重试 1 次 / 取消检查点弃存；
 * - 提示词 = appearance + 项目风格词块 + 「必须剔除：negative」拼接直连（不做 LLM 预润色）；
 * - 成功后落资产（purpose=reference_{kind}）并并集去重挂回实体 ref_asset_ids，发 entity.ref_gen 事件（project room）。
 */

const log = createLogger('entity-refgen')

/** 单次发起实体上限（对齐批量润色 ≤10 先例） */
export const MAX_REFGEN_ITEMS = 10
/** 单实体变体数上限（对齐画布 variants 1-4） */
export const MAX_REFGEN_VARIANTS = 4
/** 参考图注入上限（对齐 ai-image MAX_REFS_PER_SHOT） */
export const REFGEN_MAX_REFS = 4
/** 任务域标识（gen_tasks.params.source） */
export const REFGEN_SOURCE = 'entity_ref_gen'
/** 进程内并发（图片生成重，画布同量级） */
export const REFGEN_MAX_CONCURRENCY = 2
/** 自动重试 1 次（镜像 ai-image maxRetry=1 / 画布 MAX_ATTEMPTS=2） */
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 1_500
/** 项目未配置 settings.image.size 时的兜底（对齐 ai-image 竖版人像默认） */
const DEFAULT_SIZE = '832x1248'

const nowMs = (): number => Date.now()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- 进程内信号量（≤REFGEN_MAX_CONCURRENCY） ----------

let active = 0
const waiters: Array<() => void> = []

async function acquireSlot(): Promise<void> {
  if (active < REFGEN_MAX_CONCURRENCY) {
    active += 1
    return
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
}

function releaseSlot(): void {
  const next = waiters.shift()
  if (next) next()
  else active -= 1
}

// ---------- 纯函数（供探针直接断言） ----------

/** 出图 purpose：character→reference_character / scene→reference_scene / prop→reference_prop（kind 未登记回退 reference_character） */
export function refGenPurpose(kind: string): string {
  return kind === 'scene' || kind === 'prop' ? `reference_${kind}` : 'reference_character'
}

/**
 * 参考图提示词组装（拼接直连，无 LLM 预润色）：appearance → 「视觉风格：{风格块}」→「必须剔除：{negative}」；
 * 段间以换行分隔（对齐 ai-image 锚定注入格式）；缺段跳过，全空 → 空串。
 */
export function composeEntityRefPrompt(
  entity: { appearance?: string | null; negative?: string | null },
  styleSnippets: string[],
): string {
  const parts: string[] = []
  const appearance = (entity.appearance ?? '').trim()
  if (appearance) parts.push(appearance)
  const style = combineStyleSnippets(styleSnippets)
  if (style) parts.push(`视觉风格：${style}`)
  const negative = (entity.negative ?? '').trim()
  if (negative) parts.push(`必须剔除：${negative}`)
  return parts.join('\n')
}

/** 任务 params 快照（gen_tasks.params JSON） */
export function buildRefGenParams(input: {
  entityId: number
  variantIndex: number
  size: string | null
  refsPlanned: number
}): Record<string, unknown> {
  return {
    entity_id: input.entityId,
    variant_index: input.variantIndex,
    source: REFGEN_SOURCE,
    size: input.size,
    refs_planned: input.refsPlanned,
  }
}

/** params JSON → 域内字段（非本域/损坏 → null） */
export function parseRefGenParams(raw: string): { entity_id: number; variant_index: number; size: string | null } | null {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    if (p['source'] !== REFGEN_SOURCE) return null
    const entityId = Number(p['entity_id'])
    if (!Number.isInteger(entityId) || entityId <= 0) return null
    const variantIndex = Number(p['variant_index'])
    return {
      entity_id: entityId,
      variant_index: Number.isInteger(variantIndex) && variantIndex >= 0 ? variantIndex : 0,
      size: typeof p['size'] === 'string' ? p['size'] : null,
    }
  } catch {
    return null
  }
}

/** 参考图候选：实体 ref_asset_ids 去重后截断至 REFGEN_MAX_REFS */
export function pickRefAssetIds(refAssetIds: number[]): number[] {
  return [...new Set(refAssetIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, REFGEN_MAX_REFS)
}

// ---------- 发起 / 列表 / 取消 ----------

export interface RefGenIssueResult {
  tasks: Array<{ id: number; entityId: number }>
  count: number
}

/**
 * 批量发起（校验全在前，任何一项不合法整单拒绝——前端据此提示）：
 * project 存在 / entityIds 1..10 / appearance 必填（缺 → 列出名称）/ variants 1..4。
 * 归属口径：项目行须全属该项目（现状不变）；全局行放开——以请求 projectId 为出图配置宿主
 * （settings/风格词/用量记账），产物落全局素材池并挂回全局行；全局与项目不得混选。
 */
export async function startEntityRefGen(
  projectId: number,
  entityIds: unknown,
  variantsRaw: unknown = 1,
): Promise<RefGenIssueResult> {
  if (!Number.isInteger(projectId) || projectId <= 0) throw new WorkbenchError('bad_project_id', 'project_id 需为正整数')
  if (!Array.isArray(entityIds)) throw new WorkbenchError('bad_entity_ids', 'entity_ids 需为正整数数组')
  const ids = [...new Set(entityIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  if (ids.length === 0) throw new WorkbenchError('bad_entity_ids', 'entity_ids 需为正整数数组')
  if (ids.length > MAX_REFGEN_ITEMS) {
    throw new WorkbenchError('too_many_entities', `单次最多 ${MAX_REFGEN_ITEMS} 个实体（当前 ${ids.length} 个）`)
  }
  let variants = 1
  if (variantsRaw !== undefined && variantsRaw !== null) {
    variants = Number(variantsRaw)
    if (!Number.isInteger(variants) || variants < 1 || variants > MAX_REFGEN_VARIANTS) {
      throw new WorkbenchError('bad_variants', `variants 需为 1-${MAX_REFGEN_VARIANTS} 的整数`)
    }
  }
  const projRows = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!projRows[0]) throw new WorkbenchError('not_found', `项目 ${projectId} 不存在`, 404)

  const rows = await db.select().from(characters).where(inArray(characters.id, ids))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) throw new WorkbenchError('bad_entity_ids', `素材不存在：${missing.map((m) => `#${m}`).join('、')}`)
  // 全局行以本项目为宿主；但不得与项目行混选（产物归属歧义）；非本项目项目行依旧拒
  const globals = rows.filter((r) => r.projectId === null)
  const foreign = rows.filter((r) => r.projectId !== null && r.projectId !== projectId)
  if (globals.length > 0 && (foreign.length > 0 || globals.length < rows.length)) {
    throw new WorkbenchError(
      'bad_entity_scope',
      `全局素材须单独发起（不得与项目素材混选；全局批次以当前项目为出图配置宿主，产物入全局素材池）：${globals.map((r) => r.name).join('、')}`,
    )
  }
  if (foreign.length > 0) {
    throw new WorkbenchError(
      'bad_entity_scope',
      `素材须属本项目（其他项目素材不参与批量生成）：${foreign.map((r) => r.name).join('、')}`,
    )
  }
  const noAppearance = rows.filter((r) => !(r.appearance ?? '').trim())
  if (noAppearance.length > 0) {
    throw new WorkbenchError(
      'no_appearance',
      `以下素材缺 appearance（出图锚定为空）：${noAppearance.map((r) => r.name).join('、')}——请先补全或批量润色`,
    )
  }

  const cfg = await readImageConfig(projectId)
  const now = nowMs()
  const tasks: Array<{ id: number; entityId: number }> = []
  for (const row of rows) {
    const refs = pickRefAssetIds(safeNums(row.refAssetIds))
    for (let v = 0; v < variants; v += 1) {
      const inserted = await db
        .insert(genTasks)
        .values({
          projectId,
          runId: null,
          stepId: null,
          canvasNodeId: null,
          kind: 'image',
          provider: cfg.provider ?? null,
          model: cfg.model ?? null,
          prompt: composeEntityRefPrompt({ appearance: row.appearance, negative: row.negative }, []),
          params: JSON.stringify(buildRefGenParams({ entityId: row.id, variantIndex: v, size: cfg.size, refsPlanned: refs.length })),
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: genTasks.id })
      const taskId = inserted[0]!.id
      tasks.push({ id: taskId, entityId: row.id })
    }
  }
  for (const t of tasks) {
    void runEntityRefTask(t.id).catch((err) => log.error(`ref-gen task ${t.id} crashed: ${(err as Error).message}`))
  }
  log.info(`项目 #${projectId} 批量生成参考图：${rows.length} 实体 × ${variants} 变体 = ${tasks.length} 任务`)
  return { tasks, count: tasks.length }
}

export interface RefGenTaskView {
  id: number
  entityId: number
  entityName: string
  variantIndex: number
  status: string
  errorMsg: string | null
  resultAssetId: number | null
  updatedAt: number
}

/** 任务列表：全部进行中 + 近 20 条终态（按 id 倒序；供素材页进度初始化与失败重试入口） */
export async function listEntityRefTasks(projectId: number): Promise<{ items: RefGenTaskView[]; counts: Record<string, number> }> {
  if (!Number.isInteger(projectId) || projectId <= 0) throw new WorkbenchError('bad_project_id', 'project_id 需为正整数')
  const rows = await db
    .select()
    .from(genTasks)
    .where(and(eq(genTasks.projectId, projectId), isNull(genTasks.runId), isNull(genTasks.canvasNodeId)))
    .orderBy(desc(genTasks.id))
    .limit(200)
  const mine = rows.filter((t) => parseRefGenParams(t.params) !== null)
  const isLive = (t: GenTask): boolean => t.status === 'pending' || t.status === 'processing'
  const live = mine.filter(isLive)
  const settled = mine.filter((t) => !isLive(t)).slice(0, 20)
  const entityIds = [...new Set(mine.map((t) => parseRefGenParams(t.params)!.entity_id))]
  const names = new Map<number, string>()
  if (entityIds.length > 0) {
    const es = await db.select({ id: characters.id, name: characters.name }).from(characters).where(inArray(characters.id, entityIds))
    for (const e of es) names.set(e.id, e.name)
  }
  const items: RefGenTaskView[] = [...live, ...settled].map((t) => {
    const p = parseRefGenParams(t.params)!
    return {
      id: t.id,
      entityId: p.entity_id,
      entityName: names.get(p.entity_id) ?? `素材#${p.entity_id}`,
      variantIndex: p.variant_index,
      status: t.status,
      errorMsg: t.errorMsg,
      resultAssetId: t.resultAssetId,
      updatedAt: t.updatedAt,
    }
  })
  const counts: Record<string, number> = { total: items.length }
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1
  return { items, counts }
}

/** 取消（复刻 tasks.ts 语义：仅 pending/processing；errorMsg='user cancelled' + completedAt） */
export async function cancelEntityRefTask(taskId: number): Promise<{ ok: true }> {
  const rows = await db.select().from(genTasks).where(eq(genTasks.id, taskId)).limit(1)
  const t = rows[0]
  if (!t) throw new WorkbenchError('not_found', `任务 ${taskId} 不存在`, 404)
  if (parseRefGenParams(t.params) === null) throw new WorkbenchError('not_ref_gen', `任务 ${taskId} 非批量生成任务`)
  if (!['pending', 'processing'].includes(t.status)) {
    throw new WorkbenchError('bad_status', `仅 pending/processing 可取消（当前 ${t.status}）`)
  }
  const now = nowMs()
  await db
    .update(genTasks)
    .set({ status: 'cancelled', errorMsg: 'user cancelled', completedAt: now, updatedAt: now })
    .where(eq(genTasks.id, taskId))
  emitRefGen(t.projectId, taskId, parseRefGenParams(t.params)!.entity_id, 'cancelled')
  return { ok: true }
}

// ---------- 执行器 ----------

/** 单任务执行（入队即调用；信号量排队 + 重试 + 取消检查点） */
export async function runEntityRefTask(taskId: number): Promise<void> {
  await acquireSlot()
  try {
    const task = await reloadTask(taskId)
    if (!task || task.status !== 'pending') return // 排队期间被取消 / 已被领取
    const parsed = parseRefGenParams(task.params)
    if (!parsed) {
      await failTask(task, 0, '任务 params 非批量生成域')
      return
    }
    const entityRows = await db.select().from(characters).where(eq(characters.id, parsed.entity_id)).limit(1)
    const entity = entityRows[0]
    if (!entity) {
      await failTask(task, parsed.entity_id, '素材已删除')
      return
    }
    let attempts = task.attempts
    for (;;) {
      if (await taskCancelled(taskId)) return
      attempts += 1
      await db.update(genTasks).set({ status: 'processing', attempts, errorMsg: null, updatedAt: nowMs() }).where(eq(genTasks.id, taskId))
      emitRefGen(task.projectId, taskId, parsed.entity_id, 'processing')
      try {
        await executeOnce(taskId, task, entity, parsed.variant_index)
        return
      } catch (err) {
        if (err instanceof RefGenCancelled) return
        const msg = (err as Error).message
        if (attempts >= MAX_ATTEMPTS) {
          await failTask(task, parsed.entity_id, msg)
          log.warn(`ref-gen task ${taskId} failed: ${msg}`)
          return
        }
        log.warn(`ref-gen task ${taskId} attempt ${attempts}/${MAX_ATTEMPTS} failed（${RETRY_DELAY_MS}ms 后重试）：${msg}`)
        await sleep(RETRY_DELAY_MS)
      }
    }
  } finally {
    releaseSlot()
  }
}

/** 生成不可中断——完成后若已取消则弃存 */
class RefGenCancelled extends Error {}

async function executeOnce(
  taskId: number,
  task: GenTask,
  entity: CharacterRow,
  variantIndex: number,
): Promise<void> {
  if (!(entity.appearance ?? '').trim()) throw new Error('素材 appearance 为空，无法出图')
  const snippets = (await resolveProjectStyleSnippets(task.projectId)).map((s) => s.snippet)
  const prompt = composeEntityRefPrompt({ appearance: entity.appearance, negative: entity.negative }, snippets)
  const cfg = await readImageConfig(task.projectId)
  const refIds = pickRefAssetIds(safeNums(entity.refAssetIds))
  const endpoint = await resolveEndpoint('image', cfg.provider)
  const adapter = getImageAdapter(endpoint.providerKey)
  const canRefs = (adapter.referenceImages ?? 'none') === 'base64'
  const referenceImages: string[] = []
  if (canRefs && refIds.length > 0) {
    const cache = new Map<number, string>()
    for (const id of refIds) {
      try {
        referenceImages.push(await assetToDataUri(id, task.projectId, cache))
      } catch (err) {
        log.warn(`参考图 asset#${id} 跳过（${(err as Error).message}）`)
      }
    }
  } else if (refIds.length > 0) {
    log.info(`供应商「${endpoint.providerKey}」不支持参考图注入，纯文本锚定出图（asset 候选 ${refIds.length} 张）`)
  }
  const { adapter: used, request } = await buildImageRequest({
    prompt,
    provider: cfg.provider,
    model: cfg.model,
    size: cfg.size,
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
  })
  const img = await used.generate(request)
  if (await taskCancelled(taskId)) throw new RefGenCancelled()
  const source = img.kind === 'url' ? { kind: 'url' as const, url: img.url } : { kind: 'base64' as const, data: img.data, mime: img.mime }
  // 全局实体产物落全局素材池（而非宿主项目）；项目实体照旧落本项目
  const ownerProjectId = entity.projectId ?? GLOBAL_POOL_ID
  const asset = await saveGeneratedMedia({
    projectId: ownerProjectId,
    taskId,
    runId: null,
    kind: 'image',
    purpose: refGenPurpose(entity.kind),
    prompt,
    params: {
      source: REFGEN_SOURCE,
      entity_id: entity.id,
      task_id: taskId,
      variant_index: variantIndex,
      provider: used.provider,
      model: request.model ?? null,
      refs_used: referenceImages.length,
    },
    source,
    width: img.width,
    height: img.height,
  })
  scheduleImageCheck(asset)
  await db
    .update(genTasks)
    .set({ status: 'succeeded', resultAssetId: asset.id, prompt, completedAt: nowMs(), updatedAt: nowMs() })
    .where(eq(genTasks.id, taskId))
  // 自动挂接：并集去重追加至实体 ref_asset_ids（按行 id 挂接，免同名项目行遮蔽；产物归属随实体域）
  const added = await attachRefAssetsById(entity.id, [asset.id], 'ref-gen', entity.projectId)
  await recordUsage({
    projectId: task.projectId,
    runId: null,
    taskId,
    assetId: asset.id,
    kind: 'image',
    unit: 'image',
    quantity: 1,
    provider: used.provider,
    model: request.model ?? null,
  })
  emitRefGen(task.projectId, taskId, entity.id, 'succeeded')
  log.info(`素材「${entity.name}」参考图生成完成 → asset#${asset.id}（挂接新增 ${added}）`)
}

// ---------- 状态工具 ----------

function emitRefGen(projectId: number, taskId: number, entityId: number, status: string, error?: string): void {
  emitStudioEvent({ type: 'entity.ref_gen', projectId, taskId, entityId, status, error })
}

async function reloadTask(taskId: number): Promise<GenTask | null> {
  const rows = await db.select().from(genTasks).where(eq(genTasks.id, taskId)).limit(1)
  return rows[0] ?? null
}

async function taskCancelled(taskId: number): Promise<boolean> {
  const rows = await db.select({ status: genTasks.status }).from(genTasks).where(eq(genTasks.id, taskId)).limit(1)
  return rows[0]?.status === 'cancelled'
}

async function failTask(task: GenTask, entityId: number, msg: string): Promise<void> {
  const now = nowMs()
  await db
    .update(genTasks)
    .set({ status: 'failed', errorMsg: msg, completedAt: now, updatedAt: now })
    .where(eq(genTasks.id, task.id))
  emitRefGen(task.projectId, task.id, entityId, 'failed', msg)
}

/** 启动恢复：本域 pending/processing 任务 → failed「服务重启中断」（不自动重排队，镜像 recoverCanvasTasks） */
export async function recoverEntityRefTasks(): Promise<{ failed: number }> {
  const now = nowMs()
  const rows = await db
    .select({ id: genTasks.id, params: genTasks.params })
    .from(genTasks)
    .where(
      and(
        isNull(genTasks.runId),
        isNull(genTasks.canvasNodeId),
        isNull(genTasks.stepId),
        inArray(genTasks.status, ['pending', 'processing']),
      ),
    )
    .limit(500)
  const targets = rows.filter((r) => parseRefGenParams(r.params) !== null)
  for (const r of targets) {
    await db
      .update(genTasks)
      .set({ status: 'failed', errorMsg: '服务重启中断', completedAt: now, updatedAt: now })
      .where(eq(genTasks.id, r.id))
  }
  const failed = targets.length
  if (failed > 0) log.warn(`启动恢复：${failed} 个批量生成任务置为失败（服务重启中断）`)
  return { failed }
}

/** 项目 settings.image 配置链（provider/model/size；缺失/损坏 → 未定义 + 默认尺寸） */
async function readImageConfig(projectId: number): Promise<{ provider?: string; model?: string; size: string }> {
  const rows = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1)
  let image: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(rows[0]?.settings ?? '{}') as Record<string, unknown>
    if (parsed['image'] && typeof parsed['image'] === 'object' && !Array.isArray(parsed['image'])) {
      image = parsed['image'] as Record<string, unknown>
    }
  } catch {
    image = {}
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  return { provider: str(image['provider']), model: str(image['model']), size: str(image['size']) ?? DEFAULT_SIZE }
}

/** JSON 数组读取（坏 JSON/非数组 → []；仅留正整数） */
function safeNums(s: string): number[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}
