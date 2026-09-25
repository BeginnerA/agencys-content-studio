import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { assets, creationMessages, pipelineRuns, type PipelineRun, type CreationSession } from '../../db/schema'
import { engine } from '../../pipeline/engine'
import { buildShotBoard } from '../shot/board'
import { applyShotSelection } from '../shot/selection'
import { resetStepForRecompose, resetDialogueForRecompose } from '../shot/reset'
import { WorkbenchError } from '../shot/helpers'
import type { ShotBoard } from '../shot/board'
import { CreationError, candidateStepSchema, recomposeSchema, shotSelectionSchema } from './contract'
import { recipeOf, type CreationRecipe } from './recipe'
import { validatedDialogueClip } from './dialogue-cache'
import { creationWrite, sessionRow } from './store'

/**
 * 会话侧候选版本通路（轻松创作不开放专业工作台路由，但复用同一套镜头服务）：
 * 归属校验（session.runId → run.projectId）在 creation 层做，业务校验（资产/步骤/settled）留在 shot 服务层，
 * 不在这里重写一遍矩阵；shot 层的 WorkbenchError 原样翻译成 HTTP 状态，避免一律塌成 503 掩盖真实原因。
 */

/** 工作台领域错误 → 会话领域错误（保留 code/message/status，不吞真实原因）； 返修通道同用此翻译 */
export async function throughShotLayer<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof WorkbenchError) throw new CreationError(err.code, err.message, (err.status === 404 ? 404 : err.status === 409 ? 409 : 400) as CreationError['status'])
    throw err
  }
}

async function ownedRun(id: number): Promise<{ session: CreationSession; run: PipelineRun }> {
  const session = await sessionRow(id)
  if (!session.runId) throw new CreationError('no_run', '会话尚未开始制作，没有可选定的镜头版本', 409)
  const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, session.runId))
  if (!run || run.projectId !== session.projectId) throw new CreationError('bad_run', '制作记录归属异常，不能改选镜头版本', 409)
  return { session, run }
}

/**
 * 安全读取本 run 的对白方案：仅当方案确为对白时返回，供候选指纹/重合成失效判定使用。
 * 旁白旧方案（如 easy-video）run.input 可能没有 recipe 快照，recipeOf 解析会抛错；此处按旁白处理返回 null，
 * 保证新的对白通道绝不把既有的选片/重合成路径打断（历史兼容，非静默吞异常：非对白本就不走对白分支）。
 */
function dialogueRecipeOf(run: PipelineRun): CreationRecipe | null {
  try {
    const recipe = recipeOf(run)
    return recipe && recipe.plan.performance === 'dialogue' ? recipe : null
  } catch {
    return null
  }
}

/** 候选看板（只读聚合）：版本 × 任务 × 在用选中 × 合成新鲜度，直返工作台同一份投影 */
export async function creationShotBoard(id: number, rawStep: unknown): Promise<ShotBoard> {
  const parsed = candidateStepSchema.safeParse(rawStep)
  if (!parsed.success) throw new CreationError('bad_step', '该步骤没有镜头候选（仅图文画面 / 动态首帧 / 动态镜头可查）')
  const { run } = await ownedRun(id)
  return await throughShotLayer(() => buildShotBoard(run.id, parsed.data))
}

/**
 * 对白候选指纹：每段选中视频必须已有匹配当前批准台词与角色、且经严格校验的原声转写缓存；
 * 否则拒绝选入——本地重合成绝不暗中调用付费 ASR，也不能把无声/错台词/其他角色/未验证历史版本送进成片。
 */
export async function assertDialogueCandidates(recipe: CreationRecipe, picks: Array<{ shot_id: string; asset_id: number }>, projectId: number): Promise<void> {
  const rows = await db.select().from(assets).where(inArray(assets.id, picks.map((p) => p.asset_id)))
  const byId = new Map(rows.map((a) => [a.id, a] as const))
  for (const p of picks) {
    const asset = byId.get(p.asset_id)
    if (!asset) throw new CreationError('bad_asset', `资产 #${p.asset_id} 不存在`, 422)
    try { await validatedDialogueClip(recipe, p.shot_id, asset, projectId) }
    catch (error) {
      throw new CreationError('dialogue_candidate_invalid', `镜头 ${p.shot_id} 的候选没有匹配的已校验原声转写，不能选入无声、错台词、其他角色或未验证的历史版本，本地重合成也不会暗中调用付费 ASR：${error instanceof Error ? error.message : '未知原因'}`, 409)
    }
  }
}

/**
 * 选定版本：把前端提交的改动子集与「未提及镜头的当前在用值」合并成全量后落库。
 * 不触发执行、零计费；改完要生效到成片需再走 recompose。
 */
export async function selectCreationShots(id: number, raw: unknown): Promise<{ runId: number; stepKey: string; assetIds: number[] }> {
  const request = shotSelectionSchema.parse(raw)
  return await creationWrite(async () => {
    const { run } = await ownedRun(id)
    const board = await throughShotLayer(() => buildShotBoard(run.id, request.stepKey))
    const wanted = new Map(request.picks.map((p) => [p.shot_id, p.asset_id]))
    const known = new Set(board.shots.map((s) => s.shotId))
    for (const shotId of wanted.keys()) {
      if (!known.has(shotId)) throw new CreationError('unknown_shot', `镜头 ${shotId} 不在当前分镜中，请刷新后重试`, 409)
    }
    const picks = board.shots
      .filter((s) => wanted.has(s.shotId) || s.selectedAssetId != null)
      .map((s) => ({ shot_id: s.shotId, asset_id: wanted.get(s.shotId) ?? s.selectedAssetId! }))
    if (!picks.length) throw new CreationError('empty_selection', '该步骤还没有可用版本，请等待画面生成完成后再选', 409)
    // 对白交付视频改选先过指纹缓存校验（写入前），避免选中陈旧版本后重合成暗改字幕或暗中付费 ASR；
    // 免核验（estimated）路线本就无 ASR 转写缓存（validatedDialogueClip 依赖 recipe.asr），其诚实门在合成步估算同源重算 + 强制人工审阅，改选阶段不走此校验。
    const dialogueRecipe = dialogueRecipeOf(run)
    if (dialogueRecipe && !dialogueRecipe.estimatedDialogue && request.stepKey === 'motion') await assertDialogueCandidates(dialogueRecipe, picks, run.projectId)
    const result = await throughShotLayer(() => applyShotSelection(run.id, request.stepKey, { picks }))
    return { runId: run.id, stepKey: request.stepKey, assetIds: result.assetIds }
  })
}

/**
 * 本地重新合成：只重置 ffmpeg_merge 步（succeeded 镜头步被引擎跳过）→ 不调用任何付费模型。
 * 同 idempotencyKey 重放不再二次重置（决策消息即去重锚点），与 gate 同一先例。
 */
export async function recomposeCreation(id: number, raw: unknown): Promise<{ runId: number | null }> {
  const request = recomposeSchema.parse(raw)
  const prepared = await creationWrite(async () => {
    const { run } = await ownedRun(id)
    const prior = await db.select().from(creationMessages)
      .where(and(eq(creationMessages.sessionId, id), eq(creationMessages.requestKey, request.idempotencyKey)))
    if (prior.length) return null
    // 字幕烧录开关：重新合成也能逐次改写（confirm 卡之外的入口，覆盖「已有成果 → 重新合成」路径）。
    // 仅显式传入时落 _compose.subtitleBurn（与 confirm 同内部键，合成期 ffmpeg-merge 读取；不传=不改，沿用 run 既有值）。
    if (request.subtitleBurn !== undefined) {
      const cur = JSON.parse(run.input) as Record<string, unknown>
      const prevCompose = cur['_compose']
      const base = prevCompose && typeof prevCompose === 'object' && !Array.isArray(prevCompose) ? (prevCompose as Record<string, unknown>) : {}
      await db.update(pipelineRuns).set({ input: JSON.stringify({ ...cur, _compose: { ...base, subtitleBurn: request.subtitleBurn } }), updatedAt: Date.now() }).where(eq(pipelineRuns.id, run.id))
    }
    // 对白重合成同时失效逐镜转写与合成（从选中版本的已校验缓存重建全片字幕、旧审阅作废），仍零模型调用
    const dialogue = dialogueRecipeOf(run) !== null
    await throughShotLayer(() => (dialogue ? resetDialogueForRecompose(run.id) : resetStepForRecompose(run.id, 'compose')))
    return { runId: run.id }
  })
  if (!prepared) return { runId: null }
  engine.startRun(prepared.runId)
  await creationWrite(() => db.insert(creationMessages).values({
    sessionId: id, role: 'system', content: '已按你选定的镜头版本重新合成成片（本地合成，不调用付费生成模型）。',
    requestKey: request.idempotencyKey, payload: JSON.stringify({ kind: 'recompose', runId: prepared.runId }), createdAt: Date.now(),
  }))
  return prepared
}
