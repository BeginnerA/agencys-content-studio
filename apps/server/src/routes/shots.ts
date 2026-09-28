/**
 * 镜头级轻工作台路由（spec §3.2）
 * - 服务层只改 DB，engine.startRun 在此同步调用（对齐 tasks.ts retry 手法）
 * - WorkbenchError → HttpError（状态码透传）；不触发执行的端点（edit / select / mutate / upload）不启动引擎
 * +mutate（结构性编辑：reorder/add/remove/patch）/ +upload（上传替换：multipart）
 * wb 提取至 helpers 共用（compose/runs 路由接入；行为零变化）
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { engine } from '../pipeline/engine'
import {
  applyShotSelection,
  applyStoryboardEdits,
  applyStoryboardOps,
  buildShotBoard,
  cleanupShotVersions,
  resetShotForRegenerate,
  resetStepForRecompose,
  uploadAndBindShotAsset,
  type ShotEditItem,
  type ShotOp,
  type ShotPick,
} from '../services/shot'
import { HttpError, h, idParam, wb } from './helpers'
import { toAssetView } from './assets'

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
// 审阅闸门暂停期放行提示词编辑（服务层双门禁：轻松创作硬拒 / duration 拒）；结构编辑 mutate 仍锁
shotsRoutes.post('/runs/:id/shots/edit', h(async (c) => {
  const runId = idParam(c)
  const body = await bodyJson(c)
  const stepKey = requireStepKey(body['step_key'])
  const items = body['shots']
  if (!Array.isArray(items)) throw new HttpError(400, 'bad_shots', 'shots 需为非空数组')
  const result = await wb(() => applyStoryboardEdits(runId, stepKey, items as ShotEditItem[], { allowGatePause: true }))
  return c.json({ ok: true, asset_id: result.assetId, asset_ids: result.assetIds, edited: result.edited })
}))

// POST /runs/:id/shots/mutate —— 结构性编辑（reorder/add/remove/patch；写新分镜版本，不触发执行）
shotsRoutes.post('/runs/:id/shots/mutate', h(async (c) => {
  const runId = idParam(c)
  const body = await bodyJson(c)
  const stepKey = requireStepKey(body['step_key'])
  const ops = body['ops']
  if (!Array.isArray(ops) || ops.length === 0) throw new HttpError(400, 'bad_ops', 'ops 需为非空数组')
  const result = await wb(() => applyStoryboardOps(runId, stepKey, ops as ShotOp[]))
  return c.json({
    ok: true,
    asset_id: result.assetId,
    asset_ids: result.assetIds,
    shots: result.shots,
    note: '分镜已更新（写新版本资产）；重新合成后生效',
  }, 201)
}))

// POST /runs/:id/shots/regenerate —— 单镜重生成（可选编辑字段先写分镜；重置后引擎只重跑目标镜）
shotsRoutes.post('/runs/:id/shots/regenerate', h(async (c) => {
  const runId = idParam(c)
  const body = await bodyJson(c)
  const stepKey = requireStepKey(body['step_key'])
  const shotId = body['shot_id']
  if (typeof shotId !== 'string' || !shotId) throw new HttpError(400, 'bad_shot', 'shot_id 非法')

  // 可选编辑字段：提示词改动移交服务层统一入口（含闸门期权限/轻松创作批准链/字段校验，
  // 失败则整体不动作）；duration 仅收敛后路径可用，仍先走独立分镜编辑（失败则整体不动作）。
  const editItem: ShotEditItem = { shot_id: shotId }
  let hasEdit = false
  const promptEdits: Pick<ShotEditItem, 'image_prompt' | 'motion_prompt'> = {}
  if (body['image_prompt'] !== undefined) {
    editItem.image_prompt = body['image_prompt'] as string
    promptEdits.image_prompt = body['image_prompt'] as string
    hasEdit = true
  }
  if (body['motion_prompt'] !== undefined) {
    editItem.motion_prompt = body['motion_prompt'] as string
    promptEdits.motion_prompt = body['motion_prompt'] as string
    hasEdit = true
  }
  if (body['duration'] !== undefined) {
    editItem.duration = body['duration'] as number
    hasEdit = true
  }
  const hasPromptEdit = promptEdits.image_prompt !== undefined || promptEdits.motion_prompt !== undefined
  if (hasEdit && !hasPromptEdit && editItem.duration !== undefined) {
    await wb(() => applyStoryboardEdits(runId, stepKey, [editItem]))
  }

  const { taskId } = await wb(() =>
    resetShotForRegenerate(runId, stepKey, shotId, hasPromptEdit ? promptEdits : undefined),
  )
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

// POST /runs/:id/shots/upload —— 上传替换镜头（multipart：file + step_key + shot_id；入库 + 绑定选中）
shotsRoutes.post('/runs/:id/shots/upload', h(async (c) => {
  const runId = idParam(c)
  const form = await c.req.formData().catch(() => { throw new HttpError(400, 'bad_form', '非 multipart/form-data 请求') })
  const stepKey = requireStepKey(form.get('step_key'))
  const shotId = form.get('shot_id')
  if (typeof shotId !== 'string' || !shotId) throw new HttpError(400, 'bad_shot', 'shot_id 非法')
  const fileRaw = form.get('file')
  if (!fileRaw || typeof fileRaw === 'string') throw new HttpError(400, 'no_file', '未收到文件（字段名 file）')
  const file = fileRaw as File
  if (file.size > 200 * 1024 * 1024) throw new HttpError(413, 'too_large', '单文件超过 200MB 上限')
  const buf = new Uint8Array(await file.arrayBuffer())
  if (buf.byteLength === 0) throw new HttpError(400, 'no_file', '文件内容为空')
  const { asset, assetIds } = await wb(() =>
    uploadAndBindShotAsset(runId, stepKey, shotId, { name: file.name || `upload-${Date.now()}`, data: buf }),
  )
  return c.json({
    ok: true,
    asset: toAssetView(asset),
    asset_ids: assetIds,
    note: '已上传并绑定为该镜头选中产物（重新合成后生效）',
  }, 201)
}))

// POST /runs/:id/shots/cleanup —— 版本组批量清理（保留最新/收藏/在用；软删可回溯；不触发执行）
shotsRoutes.post('/runs/:id/shots/cleanup', h(async (c) => {
  const runId = idParam(c)
  const body = await bodyJson(c)
  const stepKey = requireStepKey(body['step_key'])
  const result = await wb(() => cleanupShotVersions(runId, stepKey))
  return c.json({
    ok: true,
    run_id: result.runId,
    step_key: result.stepKey,
    groups: result.groups,
    cleaned: result.cleaned,
    kept: result.kept,
    note: `已清理 ${result.cleaned} 个历史版本，保留 ${result.kept} 个（最新 / 收藏 / 在用）`,
  })
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

async function bodyJson(c: Context): Promise<Record<string, unknown>> {
  return await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  }) as Record<string, unknown>
}

function requireStepKey(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'bad_step_key', 'step_key 非法')
  return v
}
