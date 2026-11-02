/**
 * 专用连续性 API（十一条端点，全部转公共服务，零业务逻辑复刻）。
 *
 * 约定：
 * - 错误信封与全站一致：`{error:{code,message}}`；ContinuityError 保真 status/code，
 *   提取类错误额外回传 operationId（稳定操作 ID，便于客户端按幂等键复查）；
 *   非 ContinuityError（schema strict 多余键、缺 allowModelCall、JSON 非法）→ 400 bad_request。
 * - 所有请求体都是 strictObject：不接受外部 project/unit/status 归属字段，归属只来自路径。
 * - 免费操作（sources / snapshot / continuity GET / review / preview / contexts / impact）
 *   不产生模型调用；extract 是唯一付费端点，幂等键回放不再调用。
 * - createContinuityRoutes(io) 只把 IO 注入到本次请求的 AsyncLocalStorage 作用域，
 *   不安装进程级全局覆盖；默认导出 continuityRoutes 使用生产 IO。
 * - contexts 请求体沿用「目标字段平铺 + 冻结字段」形态（与预览返回的 target 可直接展开回传），
 *   逐 kind 白名单校验，多余键一律 400。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { BudgetBlockedError } from '../services/budget'
import {
  ConfirmRequestSchema, ContinuityError, ExtractRequestSchema, FreezeRequestSchema, PatchRequestSchema,
  PreviewRequestSchema, ReviewRequestSchema, TargetRequestSchema, type ContinuityIO, type FreezeRequest,
} from '../services/continuity/contract'
import { previewContext, freezeContext } from '../services/continuity/context'
import { confirmEntry, deleteDraftEntry, listEntries, patchEntry, reviewEntry } from '../services/continuity/entries'
import { extractEntry, previewExtraction } from '../services/continuity/extract'
import { getImpact } from '../services/continuity/impact'
import { withContinuityIO } from '../services/continuity/runtime'
import { captureSource, listSources } from '../services/continuity/sources'
import { HttpError, idParam } from './helpers'

const SOURCE_PARAMS = ['sourceRunId', 'sourceStepId', 'sourceAssetId', 'sourceVersionId'] as const
const id = z.number().int().positive()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
/** 快照请求在路由层先做形态检查；真正的来源一致性仍由 captureSource 在同一事务内裁决。 */
const SnapshotRequestSchema = z.strictObject({ runId: id, stepId: id, assetId: id, seenHash: hash })

const badRequest = (message: string): never => { throw new HttpError(400, 'bad_request', message) }

function parseBody(schema: z.ZodType<unknown>, raw: unknown): unknown {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || '-'}: ${issue.message}`).join('; ')
    return badRequest(detail)
  }
  return parsed.data
}

async function jsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
}

function intQuery(c: Context, key: string): number {
  const raw = c.req.query(key)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) badRequest(`查询参数 ${key} 非法: ${raw ?? '(缺省)'}`)
  return value
}

/** 冻结请求体：目标字段平铺 + 冻结字段；逐 kind 白名单，绝不把外部 status/归属收进请求。 */
const TARGET_FIELDS = {
  manual: ['episodeId', 'templateKey', 'input'],
  route: ['sessionId', 'decisionRevision', 'decisionHash'],
  workflow: ['workflowId', 'nextSeq', 'previousRunId'],
  resume: ['runId'],
} as const
const FREEZE_FIELDS = ['kind', 'includePlans', 'previewHash', 'acceptedGaps', 'operationKey', 'duplicateCostAcceptance'] as const

function parseFreezeBody(raw: unknown): FreezeRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return badRequest('请求体需为对象')
  const body = raw as Record<string, unknown>
  const kind = body['kind']
  if (typeof kind !== 'string' || !Object.hasOwn(TARGET_FIELDS, kind)) badRequest('目标 kind 非法')
  const allowed = new Set<string>([...FREEZE_FIELDS, ...TARGET_FIELDS[kind as keyof typeof TARGET_FIELDS]])
  for (const key of Object.keys(body)) if (!allowed.has(key)) badRequest(`不允许的字段: ${key}`)
  const target: Record<string, unknown> = { kind }
  for (const key of TARGET_FIELDS[kind as keyof typeof TARGET_FIELDS]) target[key] = body[key]
  const parsedTarget = TargetRequestSchema.safeParse(target)
  if (!parsedTarget.success) badRequest('目标定义非法')
  const request: Record<string, unknown> = {
    target: parsedTarget.data, includePlans: body['includePlans'], previewHash: body['previewHash'],
    acceptedGaps: body['acceptedGaps'], operationKey: body['operationKey'],
  }
  if (body['duplicateCostAcceptance'] !== undefined) request['duplicateCostAcceptance'] = body['duplicateCostAcceptance']
  return parseBody(FreezeRequestSchema, request) as FreezeRequest
}

/** 错误映射：ContinuityError 保真；预算拦截透传既有 code；其余一律 400 bad_request（不泄露内部细节）。 */
function fail(c: Context, err: unknown): Response {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode)
  }
  if (err instanceof ContinuityError) {
    return c.json({
      error: { code: err.code, message: err.message, ...(err.operationId === undefined ? {} : { operationId: err.operationId }) },
    }, err.status)
  }
  if (err instanceof BudgetBlockedError) {
    return c.json({ error: { code: err.code, message: err.message } }, 409)
  }
  // 未识别异常不把内部错误文本（路径/SQL/供应商细节）回给客户端。
  return c.json({ error: { code: 'bad_request', message: '请求处理失败' } }, 400)
}

export function createContinuityRoutes(io?: ContinuityIO): Hono {
  const routes = new Hono()
  /** 每个请求一个有明确边界的 IO 作用域；无注入时直接走生产默认（端点/预算在调用时解析）。 */
  const handle = (fn: (c: Context) => Promise<Response>) => async (c: Context): Promise<Response> => {
    try {
      return io ? await withContinuityIO(io, () => fn(c)) : await fn(c)
    } catch (err) {
      return fail(c, err)
    }
  }
  const episodeUrl = (c: Context): { projectId: number; episodeId: number } => ({
    projectId: idParam(c, 'pid'), episodeId: idParam(c, 'eid'),
  })

  // ① GET .../episodes/:eid/continuity/sources —— 同项目同集候选（可确认面 + 不可确认原因）
  routes.get('/projects/:pid/episodes/:eid/continuity/sources', handle(async (c) => {
    const { projectId, episodeId } = episodeUrl(c)
    return c.json({ items: await listSources(projectId, episodeId) })
  }))

  // ② POST .../sources/snapshot —— 免费捕获缺失 baseline，精确返回版本（不作批准）
  routes.post('/projects/:pid/episodes/:eid/continuity/sources/snapshot', handle(async (c) => {
    const { projectId, episodeId } = episodeUrl(c)
    const raw = parseBody(SnapshotRequestSchema, await jsonBody(c))
    return c.json({ source: await captureSource(projectId, episodeId, raw) })
  }))

  // ③ GET .../episodes/:eid/continuity —— 无参列登记；带完整源参数返回纯读提取预检
  routes.get('/projects/:pid/episodes/:eid/continuity', handle(async (c) => {
    const { projectId, episodeId } = episodeUrl(c)
    const present = SOURCE_PARAMS.filter(key => c.req.query(key) !== undefined)
    if (present.length === 0) return c.json({ items: await listEntries(projectId, episodeId) })
    if (present.length !== SOURCE_PARAMS.length) badRequest(`源参数需同时提供 ${SOURCE_PARAMS.join('/')}`)
    const pick = { runId: intQuery(c, 'sourceRunId'), stepId: intQuery(c, 'sourceStepId'),
      assetId: intQuery(c, 'sourceAssetId'), versionId: intQuery(c, 'sourceVersionId') }
    return c.json({ extractionPreview: await previewExtraction(projectId, episodeId, pick) })
  }))

  // ④ POST .../continuity/extract —— 唯一付费端点；缺 allowModelCall 或 schema 不合法一律 400
  routes.post('/projects/:pid/episodes/:eid/continuity/extract', handle(async (c) => {
    const { projectId, episodeId } = episodeUrl(c)
    const request = parseBody(ExtractRequestSchema, await jsonBody(c))
    return c.json({ entry: await extractEntry(projectId, episodeId, request as never) })
  }))

  // ⑤ POST .../continuity/review —— 从现存登记克隆零模型复核草稿
  routes.post('/projects/:pid/episodes/:eid/continuity/review', handle(async (c) => {
    const { projectId, episodeId } = episodeUrl(c)
    const request = parseBody(ReviewRequestSchema, await jsonBody(c))
    return c.json({ entry: await reviewEntry(projectId, episodeId, request as never) })
  }))

  // ⑥ PATCH /projects/:pid/continuity/:id —— 仅草稿结构化编辑（必填 expectedRevision，strict）
  routes.patch('/projects/:pid/continuity/:id', handle(async (c) => {
    const projectId = idParam(c, 'pid'), entryId = idParam(c)
    const request = parseBody(PatchRequestSchema, await jsonBody(c))
    return c.json({ entry: await patchEntry(projectId, entryId, request as never) })
  }))

  // ⑥-b DELETE /projects/:pid/continuity/:id —— 仅草稿可删（confirmed/superseded 受生命周期保护；有子复核 → 409）
  routes.delete('/projects/:pid/continuity/:id', handle(async (c) => {
    const projectId = idParam(c, 'pid'), entryId = idParam(c)
    await deleteDraftEntry(projectId, entryId)
    return c.json({ ok: true })
  }))

  // ⑦ POST /projects/:pid/continuity/:id/confirm —— 整集确认 CAS
  routes.post('/projects/:pid/continuity/:id/confirm', handle(async (c) => {
    const projectId = idParam(c, 'pid'), entryId = idParam(c)
    const request = parseBody(ConfirmRequestSchema, await jsonBody(c))
    return c.json({ entry: await confirmEntry(projectId, entryId, request as never) })
  }))

  // ⑧ POST /projects/:pid/continuity/preview —— 只读目标集预览（POST 仅因需传完整待运行输入）
  routes.post('/projects/:pid/continuity/preview', handle(async (c) => {
    const projectId = idParam(c, 'pid')
    const request = parseBody(PreviewRequestSchema, await jsonBody(c))
    return c.json({ preview: await previewContext(projectId, request as never) })
  }))

  // ⑨ POST /projects/:pid/continuity/contexts —— 批准后冻结承接包（幂等，零模型调用）
  routes.post('/projects/:pid/continuity/contexts', handle(async (c) => {
    const projectId = idParam(c, 'pid')
    return c.json({ approval: await freezeContext(projectId, parseFreezeBody(await jsonBody(c))) })
  }))

  // ⑩ GET /projects/:pid/continuity/:id/impact —— 直接 / 间接 / 缺证三区影响视图
  routes.get('/projects/:pid/continuity/:id/impact', handle(async (c) => {
    const projectId = idParam(c, 'pid')
    return c.json(await getImpact(projectId, idParam(c)))
  }))

  return routes
}

/** 生产挂载用默认实例（app.ts 挂 /api/v1，不另开服务）。 */
export const continuityRoutes = createContinuityRoutes()
