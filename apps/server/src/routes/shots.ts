/**
 * [M7] 镜头级轻工作台路由（spec §3.2）
 * - 服务层只改 DB，engine.startRun 在此同步调用（对齐 tasks.ts retry 手法）
 * - WorkbenchError → HttpError（状态码透传）；不触发执行的端点（edit / select）不启动引擎
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { engine } from '../pipeline/engine'
import {
  WorkbenchError,
  applyShotSelection,
  applyStoryboardEdits,
  buildShotBoard,
  resetShotForRegenerate,
  resetStepForRecompose,
  type ShotEditItem,
  type ShotPick,
} from '../services/shot-workbench'
import { HttpError, h, idParam } from './helpers'

export const shotsRoutes = new Hono()

// GET /runs/:id/shot-board?step_key= —— 工作台聚合读（镜头 × 任务 × 版本 × 选中 × 合成新鲜度）
shotsRoutes.get('/runs/:id/shot-board', h(async (c) => {
  const runId = idParam(c)
  const stepKey = c.req.query('step_key')
  if (!stepKey) throw new HttpError(400, 'bad_step_key', '缺少 step_key 参数')
  const board = await wb(() => buildShotBoard(runId, stepKey))
  return c.json(board)
}))

// POST /runs/:id/shots/edit —— 分镜字段级编辑（写新分镜版本资产；不触发执行）
shotsRoutes.post('/runs/:id/shots/edit', h(async (c) => {
  const runId = idParam(c)
  const body = await bodyJson(c)
  const stepKey = requireStepKey(body['step_key'])
  const items = body['shots']
  if (!Array.isArray(items)) throw new HttpError(400, 'bad_shots', 'shots 需为非空数组')
  const result = await wb(() => applyStoryboardEdits(runId, stepKey, items as ShotEditItem[]))
  return c.json({ ok: true, asset_id: result.assetId, asset_ids: result.assetIds, edited: result.edited })
}))

// POST /runs/:id/shots/regenerate —— 单镜重生成（可选编辑字段先写分镜；重置后引擎只重跑目标镜）
shotsRoutes.post('/runs/:id/shots/regenerate', h(async (c) => {
  const runId = idParam(c)
  const body = await bodyJson(c)
  const stepKey = requireStepKey(body['step_key'])
  const shotId = body['shot_id']
  if (typeof shotId !== 'string' || !shotId) throw new HttpError(400, 'bad_shot', 'shot_id 非法')

  // 可选编辑字段：先走分镜编辑（失败则整体不动作），再重置执行状态
  const editItem: ShotEditItem = { shot_id: shotId }
  let hasEdit = false
  if (body['image_prompt'] !== undefined) { editItem.image_prompt = body['image_prompt'] as string; hasEdit = true }
  if (body['motion_prompt'] !== undefined) { editItem.motion_prompt = body['motion_prompt'] as string; hasEdit = true }
  if (body['duration'] !== undefined) { editItem.duration = body['duration'] as number; hasEdit = true }
  if (hasEdit) await wb(() => applyStoryboardEdits(runId, stepKey, [editItem]))

  const { taskId } = await wb(() => resetShotForRegenerate(runId, stepKey, shotId))
  engine.startRun(runId)
  return c.json({
    ok: true,
    edited: hasEdit,
    run_id: runId,
    task_id: taskId,
    note: '目标镜已重置入队；成功镜头将跳过，仅重跑该镜（执行进度见任务面板）',
  })
}))

// POST /runs/:id/shots/select —— 多版本选片 / 选镜剔除（改写 output.asset_ids；不触发执行）
shotsRoutes.post('/runs/:id/shots/select', h(async (c) => {
  const runId = idParam(c)
  const body = await bodyJson(c)
  const stepKey = requireStepKey(body['step_key'])
  const reset = body['reset'] === true
  const picks = body['picks']
  if (!reset && !Array.isArray(picks)) throw new HttpError(400, 'bad_picks', 'picks 需为非空数组（或 reset=true）')
  const { assetIds } = await wb(() =>
    applyShotSelection(runId, stepKey, { picks: picks as ShotPick[] | undefined, reset }),
  )
  return c.json({ ok: true, asset_ids: assetIds })
}))

// POST /runs/:id/recompose —— 重新合成（重置 ffmpeg_merge 步骤；succeeded 镜头步骤全跳过）
shotsRoutes.post('/runs/:id/recompose', h(async (c) => {
  const runId = idParam(c)
  const body = await bodyJson(c)
  const stepKey = requireStepKey(body['step_key'])
  await wb(() => resetStepForRecompose(runId, stepKey))
  engine.startRun(runId)
  return c.json({ ok: true, run_id: runId, note: '已重新入队合成（镜头选择/分镜最新值生效）' })
}))

/** WorkbenchError → HttpError（状态码透传） */
async function wb<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof WorkbenchError) throw new HttpError(err.status, err.code, err.message)
    throw err
  }
}

async function bodyJson(c: Context): Promise<Record<string, unknown>> {
  return await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  }) as Record<string, unknown>
}

function requireStepKey(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'bad_step_key', 'step_key 非法')
  return v
}
