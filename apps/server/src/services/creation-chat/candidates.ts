import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { creationMessages, pipelineRuns, type PipelineRun, type CreationSession } from '../../db/schema'
import { engine } from '../../pipeline/engine'
import { buildShotBoard } from '../shot/board'
import { applyShotSelection } from '../shot/selection'
import { resetStepForRecompose } from '../shot/reset'
import { WorkbenchError } from '../shot/helpers'
import type { ShotBoard } from '../shot/board'
import { CreationError, candidateStepSchema, recomposeSchema, shotSelectionSchema } from './contract'
import { creationWrite, sessionRow } from './store'

/**
 * [M42] 会话侧候选版本通路（轻松创作不开放专业工作台路由，但复用同一套镜头服务）：
 * 归属校验（session.runId → run.projectId）在 creation 层做，业务校验（资产/步骤/settled）留在 shot 服务层，
 * 不在这里重写一遍矩阵；shot 层的 WorkbenchError 原样翻译成 HTTP 状态，避免一律塌成 503 掩盖真实原因。
 */

/** 工作台领域错误 → 会话领域错误（保留 code/message/status，不吞真实原因）；[M42] 返修通道同用此翻译 */
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

/** 候选看板（只读聚合）：版本 × 任务 × 在用选中 × 合成新鲜度，直返工作台同一份投影 */
export async function creationShotBoard(id: number, rawStep: unknown): Promise<ShotBoard> {
  const parsed = candidateStepSchema.safeParse(rawStep)
  if (!parsed.success) throw new CreationError('bad_step', '该步骤没有镜头候选（仅图文画面 / 动态首帧 / 动态镜头可查）')
  const { run } = await ownedRun(id)
  return await throughShotLayer(() => buildShotBoard(run.id, parsed.data))
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
    await throughShotLayer(() => resetStepForRecompose(run.id, 'compose'))
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
