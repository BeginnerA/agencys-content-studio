/**
 * 探针：专用 API 端点（http 节）
 * - createContinuityRoutes(io) 挂十条端点逐条真实 HTTP 请求；
 * - 成功响应体形状（设计只定路径/用途，字段名为本任务决策，已在 task-10-report.md 登记）：
 *   ①GET .../episodes/:eid/continuity/sources → {items: SourceCandidate[]}
 *   ②POST .../sources/snapshot → {source: Source}
 *   ③GET .../continuity（无参 {items: EntryView[]}；带 sourceRunId&sourceStepId&sourceAssetId&sourceVersionId
 *     → {extractionPreview: ExtractPreview}，纯读预检）
 *   ④POST .../continuity/extract → {entry: EntryView}（幂等；缺 allowModelCall → 400）
 *   ⑤POST .../continuity/review → {entry}；⑥PATCH /projects/:pid/continuity/:id → {entry}
 *   ⑦POST /projects/:pid/continuity/:id/confirm → {entry}；⑧POST /projects/:pid/continuity/preview → {preview}
 *   ⑨POST /projects/:pid/continuity/contexts → {approval}；⑩GET /projects/:pid/continuity/:id/impact → 三区视图直出
 * - 错误面：{error:{code,message[,operationId]}}；ContinuityError 保真 400/404/409/413；
 *   非 ContinuityError（zod strict 多余键 / 缺 allowModelCall 等）→ 400 bad_request；
 * - 免费操作（snapshot/preview/contexts/impact/review）零模型调用；extract 幂等回放零二次调用；
 * - 跨项目/不存在归属统一 404 continuity_source_invalid；>120_000 字符源 → 413 continuity_context_too_large；
 * - 末测：完整 app.ts 挂载核验（默认 continuityRoutes 已入 /api/v1，错误映射一致）。
 * 隔离：临时 SQLite（bootstrap 每次新建），fixtures 模板仅写临时目录；fetch 全程桩死；
 * 零真实模型（fakeIO）；engine.startRun 节级桩 finally 还原；canary 表节专属 _m70_probe_canary_http。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Checker } from '../../probe-lib'
import type { LlmResult } from '../../../src/services/llm'
import { ContinuityError } from '../../../src/services/continuity/contract'
import type { EntryDoc } from '../../../src/services/continuity/contract'
import { withContinuityIO } from '../../../src/services/continuity/runtime'
import { initDatabase } from './bootstrap'
import { confirmEpisode, fakeIO, installTargetFixture, seedStory, storyDocument } from './fixtures'
import { test } from './fold'

const empty = { content: JSON.stringify({ subjects: [], topics: [], items: [], warnings: [], noChanges: true }),
  usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 }, provider: 'fixture', model: 'fixture' }

export async function runHttp(checker: Checker) {
  installTargetFixture()
  await initDatabase()
  await runHttpBody(checker)
}

async function runHttpBody(checker: Checker) {
  // libsql 0.18 连接池快照自愈（与 route/resume 节同款探针基建，不涉产品代码）。
  // 表名用本节专属 `_m70_probe_canary_http`：全量回归共用一库，复用他节同名表会因高位水位假阳性。
  const { db: rawDb, sqlite } = await import('../../../src/db')
  const { sql } = await import('drizzle-orm')
  await rawDb.run(sql`CREATE TABLE IF NOT EXISTS _m70_probe_canary_http (v integer NOT NULL)`)
  let canarySeq = 0
  const reopenPool = async () => { await (sqlite as unknown as { reconnect(): Promise<void> }).reconnect() }
  const healIfStale = async (tag: string): Promise<void> => {
    const probe = async (v: number): Promise<boolean> => {
      await rawDb.run(sql`INSERT INTO _m70_probe_canary_http (v) VALUES (${v})`)
      const row = await rawDb.get(sql`SELECT MAX(v) AS m FROM _m70_probe_canary_http`) as { m?: number } | undefined
      return row?.m === v
    }
    canarySeq++
    let ok: boolean
    try { ok = await probe(canarySeq) } catch { ok = false }
    if (ok) return
    console.error(`[m70-probe] 池化连接快照过期（${tag}）→ sqlite.reconnect() 自愈`)
    await reopenPool()
    canarySeq++
    assert.equal(await probe(canarySeq), true, `连接池 reopen 后金丝雀仍不一致（${tag}）`)
  }
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, async () => {
    await healIfStale(name.slice(0, 30))
    await body()
  })

  const { db } = await import('../../../src/db')
  const { eq } = await import('drizzle-orm')
  const { contentContinuityRecords: records } = await import('../../../src/db/schema')
  const { previewExtraction } = await import('../../../src/services/continuity/extract')
  const { listEntries } = await import('../../../src/services/continuity/entries')
  const { engine } = await import('../../../src/pipeline/engine')
  const { prepareRunInput } = await import('../../../src/services/run-create')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { Hono } = await import('hono')
  // 被测路由模块：缺失即真实 RED（动态导入失败逐测试记录，不让整节崩溃）。
  const routesModule = () => import('../../../src/routes/continuity')

  const patchStartRun = (): { calls: number[]; restore: () => void } => {
    const calls: number[] = []
    const original = engine.startRun.bind(engine)
    ;(engine as unknown as { startRun: unknown }).startRun = (id: number): string => { calls.push(id); return 'started' }
    return { calls, restore: () => { delete (engine as unknown as { startRun?: unknown }).startRun; void original } }
  }
  // 节级引擎桩（红线）：本节全程不得真实执行 run；finally 还原。
  const engineGuard = patchStartRun()

  const codeOf = (status: number, name?: string) => (e: unknown) =>
    e instanceof ContinuityError && e.status === status && (!name || e.code === name)

  // 主 fixture：三集故事 + 前两集已确认（第三集留给 extract/review/confirm 链路）。
  const f = await seedStory()
  const setupFake = fakeIO(empty)
  await withContinuityIO(setupFake.io, async () => {
    for (let i = 0; i < 2; i++) await confirmEpisode(f, i, setupFake.io)
  })
  // 挂载路由注入的 fake IO：extract 的模型返回 = 第三集故事的逐句抽取稿（ModelDoc 形状）。
  const modelDoc = await storyDocument(f, 2)
  // 第三集收束第二集的「红信封」线索：更新既有槽位必须精确指向当前前值，
  // 模型能看到 basis 文档里的条目 ID，因此抽取稿要带 previous 而不是凭空覆盖。
  const priorEntry = (await listEntries(f.projectId, f.episodes[1]!)).find(e => e.status === 'confirmed' && e.doc && e.document)
  const priorItem = priorEntry?.doc?.items.find(i => i.included && i.topicKey === 'envelope')
  const thread = modelDoc.items.find(i => i.included && i.topicKey === 'envelope')
  if (thread && priorEntry && priorItem) thread.previous = { ...priorEntry.document!, entryId: priorEntry.id,
    unitOrdinal: priorEntry.doc!.unit.unitOrdinal, itemId: priorItem.id }
  const extractResult: LlmResult = { content: JSON.stringify({ subjects: modelDoc.subjects, topics: modelDoc.topics,
    items: modelDoc.items, warnings: [], noChanges: false }),
    usage: { promptTokens: 120, completionTokens: 60, totalTokens: 180 }, provider: 'fixture', model: 'fixture' }
  const ef = fakeIO(extractResult)

  let mounted: import('hono').Hono | null = null
  const mount = async (): Promise<import('hono').Hono> => {
    if (mounted) return mounted
    const mod = await routesModule()
    const app = new (Hono as typeof import('hono').Hono)()
    app.route('/api/v1', mod.createContinuityRoutes(ef.io))
    mounted = app
    return app
  }
  type Method = 'GET' | 'POST' | 'PATCH'
  const req = async (method: Method, path: string, body?: unknown): Promise<Response> => {
    const app = await mount()
    const res = await app.request(path, { method, ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    await healIfStale(`${method} ${path}`)
    return res
  }
  const get = (path: string) => req('GET', path)
  const post = (path: string, body?: unknown) => req('POST', path, body ?? {})
  const errBody = async (res: Response) => (await res.json()) as { error?: { code?: string; message?: string; operationId?: number } }
  const epUrl = (episodeId: number) => `/api/v1/projects/${f.projectId}/episodes/${episodeId}/continuity`
  const sourceQuery = (pick: { runId: number; stepId: number; assetId: number; versionId: number }) =>
    `?sourceRunId=${pick.runId}&sourceStepId=${pick.stepId}&sourceAssetId=${pick.assetId}&sourceVersionId=${pick.versionId}`
  const recordsOf = async (projectId: number) =>
    (await db.select({ id: records.id }).from(records).where(eq(records.projectId, projectId))).length
  // 测试间传续（同节内闭包变量，不落全局）
  type HttpEntryView = { id: number; revision: number; currentConfirmedId: number | null; status: string;
    document: { assetId: number; versionId: number; hash: string }; warningsHash: string;
    doc: { source: { fingerprint: string }; history: typeof modelDoc.history; warnings: string[] } } | null
  let extractView: HttpEntryView = null
  let patchedView: HttpEntryView = null
  let confirmedView: { id: number } | null = null
  let previewCache: { target: unknown; preview: { doc: { previewHash: string; gaps: Array<{ key: string; fingerprint: string }> } } } | null = null
  let frozenContextId = 0

  try {
  await t('10.0 错误面：未归属 → 404 continuity_source_invalid，{error:{code,message}} 信封', async () => {
    const res = await get('/api/v1/projects/999999/episodes/1/continuity/sources')
    assert.equal(res.status, 404)
    const body = await errBody(res)
    assert.equal(body.error?.code, 'continuity_source_invalid')
    assert.equal(typeof body.error?.message, 'string')
    assert.deepEqual(Object.keys(body), ['error'])
  })

  await t('10.① GET sources：同集候选确认面（目标步可确认 / 审查步不可确认）', async () => {
    const res = await get(`${epUrl(f.episodes[0]!)}/sources`)
    assert.equal(res.status, 200)
    const body = await res.json() as { items: Array<{ runId: number; stepId: number; assetId: number; versionId: number | null;
      versions: unknown[]; currentHash: string; confirmable: boolean; declaredRole: boolean; reasons: string[] }> }
    assert.ok(Array.isArray(body.items) && body.items.length >= 2)
    const target = body.items.find(i => i.assetId === f.sources[0]!.assetId)
    assert.ok(target, '目标步产物必须在候选中')
    assert.equal(target.confirmable, true)
    assert.equal(target.declaredRole, true)
    assert.equal(target.versionId, f.sources[0]!.versionId)
    assert.match(target.currentHash, /^[a-f0-9]{64}$/)
    assert.ok(body.items.some(i => i.assetId !== f.sources[0]!.assetId && !i.confirmable), '审查报告步必须不可确认')
  })

  await t('10.② POST sources/snapshot：免费定格基线版本 {source}，零模型调用', async () => {
    const list = await (await get(`${epUrl(f.episodes[0]!)}/sources`)).json() as { items: Array<{ assetId: number; currentHash: string; runId: number; stepId: number }> }
    const candidate = list.items.find(i => i.assetId === f.sources[0]!.assetId)!
    const callsBefore = ef.calls()
    const res = await post(`${epUrl(f.episodes[0]!)}/sources/snapshot`,
      { runId: candidate.runId, stepId: candidate.stepId, assetId: candidate.assetId, seenHash: candidate.currentHash })
    assert.equal(res.status, 200)
    const body = await res.json() as { source: { assetId: number; versionId: number; fingerprint: string; unitId: number } }
    assert.equal(body.source.assetId, f.sources[0]!.assetId)
    assert.equal(typeof body.source.versionId, 'number')
    assert.equal(body.source.unitId, f.episodes[0])
    assert.match(body.source.fingerprint, /^[a-f0-9]{64}$/)
    assert.equal(ef.calls(), callsBefore)
    // seenHash 漂移 → 409 continuity_source_changed
    const drift = await post(`${epUrl(f.episodes[0]!)}/sources/snapshot`,
      { runId: candidate.runId, stepId: candidate.stepId, assetId: candidate.assetId, seenHash: 'b'.repeat(64) })
    assert.equal(drift.status, 409)
    assert.equal((await errBody(drift)).error?.code, 'continuity_source_changed')
  })

  await t('10.③ GET continuity：无参 {items}；带源参数 → {extractionPreview}（免费预检）', async () => {
    const listed = await get(epUrl(f.episodes[0]!))
    assert.equal(listed.status, 200)
    const items = (await listed.json() as { items: Array<{ id: number; status: string }> }).items
    assert.equal(items.length, 1)
    assert.equal(items[0]!.status, 'confirmed')
    const callsBefore = ef.calls()
    const preview = await get(epUrl(f.episodes[2]!) + sourceQuery(f.sources[2]!))
    assert.equal(preview.status, 200)
    const body = await preview.json() as { extractionPreview: { previewHash: string;
      basis: Array<{ entryId: number; unitOrdinal: number; hash: string }>; inputChars: number; warnings: string[] } }
    assert.match(body.extractionPreview.previewHash, /^[a-f0-9]{64}$/)
    assert.ok(body.extractionPreview.inputChars > 0)
    // 基础依赖 = 同系列已确认的前集条目（与 entries 节的三集链一致）。
    assert.deepEqual(body.extractionPreview.basis.map(ref => ref.unitOrdinal), [1, 2])
    assert.ok(body.extractionPreview.basis.every(ref => typeof ref.entryId === 'number' && /^[a-f0-9]{64}$/.test(ref.hash)))
    assert.equal(ef.calls(), callsBefore)
  })

  await t('10.③b GET continuity 源版本缺失 → 404 continuity_source_invalid', async () => {
    const res = await get(epUrl(f.episodes[2]!) + sourceQuery({ ...f.sources[2]!, versionId: 9_999_999 }))
    assert.equal(res.status, 404)
    assert.equal((await errBody(res)).error?.code, 'continuity_source_invalid')
  })

  await t('10.④ POST extract 缺 allowModelCall → 400 bad_request，零模型零落库', async () => {
    const pv = await previewExtraction(f.projectId, f.episodes[2]!, f.sources[2]!)
    const before = await recordsOf(f.projectId)
    const callsBefore = ef.calls()
    const res = await post(`${epUrl(f.episodes[2]!)}/extract`,
      { source: f.sources[2], previewHash: pv.previewHash, operationKey: randomUUID(), acceptUnpriced: true })
    assert.equal(res.status, 400)
    assert.equal((await errBody(res)).error?.code, 'bad_request')
    assert.equal(ef.calls(), callsBefore)
    assert.equal(await recordsOf(f.projectId), before)
  })

  await t('10.④ POST extract：真实执行 {entry} 草稿；同 operationKey 幂等回放同 entry 零二次调用', async () => {
    // previewHash 绑定端点/价格配置（「配置指纹」）：客户端必须用与提取同一作用域取回的预览哈希，
    // 不能拿进程默认配置下的 previewExtraction 结果去核验注入 fake IO 的端点。
    const previewRes = await get(epUrl(f.episodes[2]!) + sourceQuery(f.sources[2]!))
    assert.equal(previewRes.status, 200)
    const pv = (await previewRes.json() as { extractionPreview: { previewHash: string } }).extractionPreview
    const request = { source: f.sources[2], previewHash: pv.previewHash, operationKey: `extract_${randomUUID()}`, allowModelCall: true as const, acceptUnpriced: true }
    const callsBefore = ef.calls()
    const res = await post(`${epUrl(f.episodes[2]!)}/extract`, request)
    assert.equal(res.status, 200)
    const body = await res.json() as { entry: { id: number; status: string; doc: { unit: { unitId: number } } | null } }
    assert.equal(typeof body.entry.id, 'number')
    assert.equal(body.entry.status, 'draft')
    assert.ok(body.entry.doc)
    assert.equal(body.entry.doc!.unit.unitId, f.episodes[2])
    assert.equal(ef.calls(), callsBefore + 1)
    const replay = await post(`${epUrl(f.episodes[2]!)}/extract`, request)
    assert.equal(replay.status, 200)
    assert.equal(((await replay.json()) as { entry: { id: number } }).entry.id, body.entry.id)
    assert.equal(ef.calls(), callsBefore + 1)
    extractView = body.entry as unknown as typeof extractView
  })

  await t('10.④b POST extract operationKey 非法格式 → 400', async () => {
    const res = await post(`${epUrl(f.episodes[2]!)}/extract`,
      { source: f.sources[2], previewHash: 'a'.repeat(64), operationKey: 'short', allowModelCall: true, acceptUnpriced: true })
    assert.equal(res.status, 400)
  })

  await t('10.⑥ PATCH continuity/:id：人工复核落稿；strictObject 多余键 → 400', async () => {
    assert.ok(extractView?.doc)
    // 人工复核保留提取稿的 basis/previous（既有依赖不能无理由消失），只把结论来源改为人工。
    const reviewed = structuredClone(extractView.doc) as unknown as EntryDoc
    for (const item of reviewed.items) { item.origin = 'manual'; item.editNote = '人工逐句复核合成原文' }
    const callsBefore = ef.calls()
    const rogue = await req('PATCH', `/api/v1/projects/${f.projectId}/continuity/${extractView.id}`,
      { expectedRevision: extractView.revision, doc: reviewed, rogue: 1 })
    assert.equal(rogue.status, 400)
    assert.equal((await errBody(rogue)).error?.code, 'bad_request')
    const res = await req('PATCH', `/api/v1/projects/${f.projectId}/continuity/${extractView.id}`,
      { expectedRevision: extractView.revision, doc: reviewed })
    assert.equal(res.status, 200)
    const body = await res.json() as { entry: { id: number; revision: number; status: string } }
    assert.equal(body.entry.id, extractView.id)
    assert.equal(body.entry.revision, extractView.revision + 1)
    assert.equal(body.entry.status, 'draft')
    assert.equal(ef.calls(), callsBefore)
    patchedView = body.entry as unknown as typeof extractView
  })

  await t('10.⑦ POST confirm：确认落定 {entry}；stale expectedRevision 重放 → 409 continuity_conflict', async () => {
    assert.ok(patchedView?.doc && patchedView.document)
    const request = { expectedRevision: patchedView.revision, document: patchedView.document,
      sourceFingerprint: patchedView.doc.source.fingerprint, warningsHash: patchedView.warningsHash,
      expectedCurrentConfirmedId: patchedView.currentConfirmedId,
      acceptedWarnings: [...new Set(patchedView.doc.warnings)].sort(), approvalKey: `confirm_${randomUUID()}` }
    const callsBefore = ef.calls()
    const res = await post(`/api/v1/projects/${f.projectId}/continuity/${patchedView.id}/confirm`, request)
    assert.equal(res.status, 200)
    const body = await res.json() as { entry: { id: number; status: string } }
    assert.equal(body.entry.id, patchedView.id)
    assert.equal(body.entry.status, 'confirmed')
    assert.equal(ef.calls(), callsBefore)
    const stale = await post(`/api/v1/projects/${f.projectId}/continuity/${patchedView.id}/confirm`,
      { ...request, approvalKey: `confirm_${randomUUID()}` })
    assert.equal(stale.status, 409)
    assert.equal((await errBody(stale)).error?.code, 'continuity_conflict')
    confirmedView = { id: body.entry.id }
  })

  await t('10.⑤ POST review：确认条目派生复核草稿 {entry}（免费）', async () => {
    assert.ok(confirmedView)
    const callsBefore = ef.calls()
    const res = await post(`${epUrl(f.episodes[2]!)}/review`,
      { parentId: confirmedView.id, source: f.sources[2], operationKey: `review_${randomUUID()}` })
    assert.equal(res.status, 200)
    const body = await res.json() as { entry: { id: number; status: string; doc: { source: { fingerprint: string } } | null } }
    assert.notEqual(body.entry.id, confirmedView.id)
    assert.equal(body.entry.status, 'draft')
    assert.ok(body.entry.doc)
    assert.equal(ef.calls(), callsBefore)
  })

  await t('10.⑧ POST continuity/preview：manual 目标 {preview}（免费，零模型）', async () => {
    const tpl = loadTemplate('m70-fixture-episode')
    const norm = prepareRunInput(tpl, { brief: '端点预览简报', episode_number: 2, with_continuity: true })
    const target = { kind: 'manual' as const, episodeId: f.episodes[1]!, templateKey: 'm70-fixture-episode', input: norm }
    const callsBefore = ef.calls()
    const res = await post(`/api/v1/projects/${f.projectId}/continuity/preview`, { target, includePlans: false })
    assert.equal(res.status, 200)
    const body = await res.json() as { preview: { canFreeze: boolean; blockers: string[]; chars: number; unknownUseId: number | null;
      doc: { previewHash: string; gaps: Array<{ key: string; fingerprint: string }> } } }
    assert.equal(body.preview.canFreeze, true)
    assert.deepEqual(body.preview.blockers, [])
    assert.ok(body.preview.chars > 0)
    assert.match(body.preview.doc.previewHash, /^[a-f0-9]{64}$/)
    assert.equal(ef.calls(), callsBefore)
    previewCache = { target, preview: body.preview }
  })

  await t('10.⑨ POST continuity/contexts：冻结 {approval}（免费；同 operationKey 幂等回放同包）', async () => {
    assert.ok(previewCache)
    const request = { ...(previewCache.target as object), includePlans: false, previewHash: previewCache.preview.doc.previewHash,
      acceptedGaps: previewCache.preview.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: `ctx_http_${randomUUID()}` }
    const callsBefore = ef.calls()
    const res = await post(`/api/v1/projects/${f.projectId}/continuity/contexts`, request)
    assert.equal(res.status, 200)
    const body = await res.json() as { approval: { contextId: number; document: { assetId: number; versionId: number; hash: string }; approvalHash: string } }
    assert.equal(typeof body.approval.contextId, 'number')
    frozenContextId = body.approval.contextId
    assert.match(body.approval.approvalHash, /^[a-f0-9]{64}$/)
    assert.equal(ef.calls(), callsBefore)
    const replay = await post(`/api/v1/projects/${f.projectId}/continuity/contexts`, request)
    assert.equal(replay.status, 200)
    const again = (await replay.json()) as { approval: { contextId: number; document: { assetId: number } } }
    assert.equal(again.approval.contextId, body.approval.contextId)
    assert.equal(again.approval.document.assetId, body.approval.document.assetId)
    assert.equal(ef.calls(), callsBefore)
  })

  await t('10.⑩ GET continuity/:id/impact：消费行 / 登记行均可作锚点；不存在 → 404', async () => {
    const { seedUnknownUse } = await import('./fixtures')
    const unknownId = await seedUnknownUse(f, f.sources[2]!.runId, f.episodes[2]!)
    const res = await get(`/api/v1/projects/${f.projectId}/continuity/${unknownId}/impact`)
    assert.equal(res.status, 200)
    const body = await res.json() as { direct: unknown[]; indirect: unknown[]; unknown: Array<{ recordId: number; kind: string }> }
    assert.deepEqual(body.direct, [])
    assert.deepEqual(body.indirect, [])
    assert.ok(body.unknown.length >= 1 && body.unknown.some(r => r.recordId === unknownId))
    const onEntry = await get(`/api/v1/projects/${f.projectId}/continuity/${confirmedView!.id}/impact`)
    assert.equal(onEntry.status, 200)
    const entryBody = await onEntry.json() as { direct: Array<{ recordId: number; kind: string }>; indirect: Array<{ recordId: number; kind: string }> }
    assert.ok(![...entryBody.direct, ...entryBody.indirect].some(r => r.kind === 'entry' && r.recordId === confirmedView!.id))
    const onContext = await get(`/api/v1/projects/${f.projectId}/continuity/${frozenContextId}/impact`)
    assert.equal(onContext.status, 404)
    assert.equal((await errBody(onContext)).error?.code, 'continuity_source_invalid')
    const missing = await get(`/api/v1/projects/${f.projectId}/continuity/999999/impact`)
    assert.equal(missing.status, 404)
  })

  await t('10.错误面 413：>120_000 字符源 → continuity_context_too_large', async () => {
    const { seedSource } = await import('./fixtures')
    const big = await seedSource(f, 9, 'x'.repeat(125_000))
    const res = await get(epUrl(big.episodeId) + sourceQuery(big.pick))
    assert.equal(res.status, 413)
    assert.equal((await errBody(res)).error?.code, 'continuity_context_too_large')
  })

  await t('10.完整 app 挂载：默认 continuityRoutes 已入 /api/v1，错误映射一致', async () => {
    const { app } = await import('../../../src/app')
    const ok = await app.request(`${epUrl(f.episodes[0]!)}/sources`)
    assert.equal(ok.status, 200)
    assert.ok(Array.isArray(((await ok.json()) as { items: unknown[] }).items))
    const miss = await app.request('/api/v1/projects/999999/episodes/1/continuity/sources')
    assert.equal(miss.status, 404)
    assert.equal((await errBody(miss)).error?.code, 'continuity_source_invalid')
  })

  } finally { engineGuard.restore() }
}
