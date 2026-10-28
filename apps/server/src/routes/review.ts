import { Hono } from 'hono'
import type { Context } from 'hono'
import { HttpError, h, idParam } from './helpers'
import {
  createReviewFinding,
  dismissFinding,
  linkFinding,
  listReviewFindings,
  markReworkFinding,
  patchReviewFinding,
  recheckFinding,
  reopenFinding,
  ReviewError,
  verifyFinding,
} from '../services/review/service'

/**
 * M69 审片问题单与返修复检 API（design §4.7）。
 * 只做参数解析与领域码 → HTTP 映射；状态机/证据比对/视图投影全在服务层。
 * 失败请求零写库；不触发任何生成或付费调用。
 */
export const reviewRoutes = new Hono()

const STATUS: Record<string, number> = {
  run_not_found: 404,
  finding_not_found: 404,
  bad_scope: 400,
  scope_category_mismatch: 400,
  note_required: 400,
  bad_severity: 400,
  bad_result: 400,
  client_key_conflict: 400,
  run_active: 409,
  run_cancelled: 409,
  no_final: 409,
  no_timeline: 409,
  request_not_found: 409,
  request_not_applied: 409,
  request_run_mismatch: 409,
  final_unchanged: 409,
  stale_final: 409,
  stale_recheck: 409,
  bad_transition: 409,
}

function failed(err: unknown): never {
  if (err instanceof ReviewError) {
    throw new HttpError(STATUS[err.code] ?? 409, err.code, err.message)
  }
  throw err
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_scope', '请求体需为 JSON 对象')
  })
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad_scope', '请求体需为 JSON 对象')
  }
  return body as Record<string, unknown>
}

const fidParam = (c: Context): number => idParam(c, 'fid')

reviewRoutes.get('/runs/:id/findings', h(async (c) => {
  const runId = idParam(c)
  const stepKey = c.req.query('stepKey') || 'compose'
  try {
    return c.json(await listReviewFindings(runId, stepKey))
  } catch (err) {
    failed(err)
  }
}))

reviewRoutes.post('/runs/:id/findings', h(async (c) => {
  const runId = idParam(c)
  const body = await readJson(c)
  try {
    return c.json(await createReviewFinding(runId, body))
  } catch (err) {
    failed(err)
  }
}))

reviewRoutes.patch('/runs/:id/findings/:fid', h(async (c) => {
  const runId = idParam(c)
  const fid = fidParam(c)
  const body = await readJson(c)
  try {
    return c.json({ finding: await patchReviewFinding(runId, fid, body) })
  } catch (err) {
    failed(err)
  }
}))

reviewRoutes.post('/runs/:id/findings/:fid/link', h(async (c) => {
  const runId = idParam(c)
  const fid = fidParam(c)
  try {
    return c.json({ finding: await linkFinding(runId, fid, await readJson(c)) })
  } catch (err) {
    failed(err)
  }
}))

reviewRoutes.post('/runs/:id/findings/:fid/mark-rework', h(async (c) => {
  const runId = idParam(c)
  const fid = fidParam(c)
  try {
    return c.json({ finding: await markReworkFinding(runId, fid, await readJson(c)) })
  } catch (err) {
    failed(err)
  }
}))

reviewRoutes.post('/runs/:id/findings/:fid/recheck', h(async (c) => {
  const runId = idParam(c)
  const fid = fidParam(c)
  try {
    return c.json({ finding: await recheckFinding(runId, fid) })
  } catch (err) {
    failed(err)
  }
}))

reviewRoutes.post('/runs/:id/findings/:fid/verify', h(async (c) => {
  const runId = idParam(c)
  const fid = fidParam(c)
  const body = await readJson(c)
  try {
    return c.json({ finding: await verifyFinding(runId, fid, body) })
  } catch (err) {
    failed(err)
  }
}))

reviewRoutes.post('/runs/:id/findings/:fid/dismiss', h(async (c) => {
  const runId = idParam(c)
  const fid = fidParam(c)
  try {
    return c.json({ finding: await dismissFinding(runId, fid, await readJson(c)) })
  } catch (err) {
    failed(err)
  }
}))

reviewRoutes.post('/runs/:id/findings/:fid/reopen', h(async (c) => {
  const runId = idParam(c)
  const fid = fidParam(c)
  try {
    return c.json({ finding: await reopenFinding(runId, fid, await readJson(c)) })
  } catch (err) {
    failed(err)
  }
}))
