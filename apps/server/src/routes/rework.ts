import { Hono } from 'hono'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { pipelineRuns } from '../db/schema'
import { buildSubtitlePreview, getReworkRequestView } from '../services/rework/preview'
import { parseSubtitleInstruction } from '../services/rework/parse'
import { applySubtitleRework } from '../services/rework/apply'
import { subtitleReadModel } from '../services/rework/readmodel'
import { getReworkRequest, ReworkLedgerError } from '../services/rework/ledger'
import { HttpError, h, idParam, notFound } from './helpers'

/**
 * 精确返修 · 统一运行级 API（precision-rework 规格 §7；P8 成果版本投影）。
 * 四入口（轻松创作/运行详情/ComposeBar/画布抽屉）都汇聚到这里，
 * 前端与会话层不得各自计算依赖、费用或过期——预览/确认/回放只转发服务层唯一实现。
 */
export const reworkRoutes = new Hono()

async function findRun(id: number) {
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).limit(1)
  return rows[0] ?? null
}

/** mapRework 领域错误 → HTTP 语义（not_found 404；其余按 code 表） */
function reworkStatus(code: string): number {
  if (code === 'not_found') return 404
  if (code === 'corrupt_receipt') return 500
  if (code === 'storage_failed') return 503
  return 409
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_json', '请求体需为 JSON 对象')
  return body as Record<string, unknown>
}

// GET /runs/:id/subtitles?stepKey=compose —— 字幕读模型投影：
// 能力与基准、当前修订指针（含过期标记）、固定版本的历史列表（每条带不可变文件下载引用）、审阅与合成交付状态
reworkRoutes.get('/runs/:id/subtitles', h(async (c) => {
  const runId = idParam(c)
  if (!(await findRun(runId))) return notFound(c, `run ${runId}`)
  const stepKey = c.req.query('stepKey') || 'compose'
  const model = await subtitleReadModel(runId, stepKey)
  return c.json(model)
}))

// POST /runs/:id/rework/preview —— 结构化变更预览（幂等：request_key 必填；同键同载荷回放，同键异载荷 409）
reworkRoutes.post('/runs/:id/rework/preview', h(async (c) => {
  const runId = idParam(c)
  if (!(await findRun(runId))) return notFound(c, `run ${runId}`)
  const body = await readJson(c)
  const requestKey = body['request_key']
  if (typeof requestKey !== 'string' || requestKey.length === 0 || requestKey.length > 100) {
    throw new HttpError(400, 'bad_request_key', 'request_key 需为 1-100 字符的字符串（幂等键）')
  }
  const stepKey = typeof body['step_key'] === 'string' ? body['step_key'] : undefined
  const res = await buildSubtitlePreview({ runId, stepKey, requestKey, changes: body['changes'] })
  if (res.outcome === 'conflict') {
    return c.json({ error: { code: res.code, message: res.message }, request_id: res.requestId }, 409)
  }
  if (res.outcome === 'blocked') {
    // 带 requestId 的 blocked 是载荷错误（可回放原因）；不带的是能力拦断（stale/付费链等按 409）
    const status = res.requestId ? 400 : 409
    return c.json({ error: { code: res.code, message: res.message }, request_id: res.requestId, ...(res.errors ? { errors: res.errors } : {}) }, status as 400 | 409)
  }
  return c.json({ outcome: res.outcome, request_id: res.requestId, preview: res.preview })
}))

// POST /runs/:id/rework/parse —— 显式字幕自然语言解析（规格 §3.1/§4/§7）：一次文本模型调用产出同构
// changes → 转同一预览编译器；parse-once 领用（同键仅一次、超时/未知不重发）、未知价须先确认、歧义/混合整单阻断。
reworkRoutes.post('/runs/:id/rework/parse', h(async (c) => {
  const runId = idParam(c)
  if (!(await findRun(runId))) return notFound(c, `run ${runId}`)
  const body = await readJson(c)
  const requestKey = body['request_key']
  if (typeof requestKey !== 'string' || requestKey.length === 0 || requestKey.length > 100) {
    throw new HttpError(400, 'bad_request_key', 'request_key 需为 1-100 字符的字符串（幂等键）')
  }
  const instruction = body['instruction']
  if (typeof instruction !== 'string') throw new HttpError(400, 'bad_instruction', 'instruction 需为字符串')
  const stepKey = typeof body['step_key'] === 'string' ? body['step_key'] : undefined
  const acceptUnpriced = body['accept_unpriced'] === true
  const res = await parseSubtitleInstruction({ runId, stepKey, requestKey, instruction, acceptUnpriced })
  if (res.outcome === 'unpriced') {
    return c.json({ outcome: res.outcome, code: 'unpriced', message: res.message, estimate: res.estimate }, 409)
  }
  if (res.outcome === 'conflict') {
    return c.json({ error: { code: 'idempotency_conflict', message: res.message }, request_id: res.parseRequestId }, 409)
  }
  if (res.outcome === 'blocked') {
    const status = res.parseRequestId ? 400 : 409
    return c.json({ outcome: res.outcome, code: res.code, message: res.message, request_id: res.parseRequestId, ...(res.errors ? { errors: res.errors } : {}) }, status as 400 | 409)
  }
  if (res.outcome === 'uncertain') {
    // 待澄清：整单不执行（无预览），成本若已产生据实回执，交前端展示 unclear
    return c.json({ outcome: res.outcome, message: res.message, unclear: res.unclear, request_id: res.parseRequestId, estimate: res.estimate })
  }
  return c.json({ outcome: res.outcome, request_id: res.requestId, parse_request_id: res.parseRequestId, preview: res.preview, changes: res.changes, estimate: res.estimate })
}))

// GET /runs/:id/rework/:requestId —— 请求状态回放（纯读取零副作用；响应丢失/页面刷新后可完整恢复）
reworkRoutes.get('/runs/:id/rework/:requestId', h(async (c) => {
  const runId = idParam(c)
  const requestId = c.req.param('requestId')
  if (!requestId) return notFound(c, '返修请求')
  try {
    const row = await getReworkRequest(requestId)
    if (row.runId !== runId) return notFound(c, `run ${runId} 的返修请求 ${requestId}`) // 不泄漏他 run 存在性
    const view = await getReworkRequestView(requestId)
    return c.json(view)
  } catch (err) {
    if (err instanceof ReworkLedgerError && err.code === 'not_found') return notFound(c, `返修请求 ${requestId}`)
    throw err
  }
}))

// POST /runs/:id/rework/:requestId/apply —— 确认应用（只接 preview_hash，不接任意新 changes；成功即入队本地续跑）
reworkRoutes.post('/runs/:id/rework/:requestId/apply', h(async (c) => {
  const runId = idParam(c)
  const requestId = c.req.param('requestId')
  if (!requestId) return notFound(c, '返修请求')
  const body = await readJson(c)
  const previewHash = body['preview_hash']
  if (typeof previewHash !== 'string' || previewHash.length === 0) {
    throw new HttpError(400, 'bad_preview_hash', 'preview_hash 必填：确认必须携带与服务端固定预览逐字一致的回执')
  }
  const res = await applySubtitleRework({ requestId, previewHash })
  if (res.outcome === 'rejected') {
    // 行不归属本 run 时按不存在处理（防跨 run 携带 requestId）
    if (res.requestId) {
      try {
        const row = await getReworkRequest(res.requestId)
        if (row.runId !== runId) return notFound(c, `run ${runId} 的返修请求 ${requestId}`)
      } catch {
        /* not_found 由下方 code 映射 */
      }
    }
    return c.json({ error: { code: res.code, message: res.message } }, reworkStatus(res.code) as 404)
  }
  return c.json({ outcome: res.outcome, request_id: res.requestId, result: res.result })
}))
