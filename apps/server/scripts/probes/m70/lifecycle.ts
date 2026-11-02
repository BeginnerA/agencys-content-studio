/**
 * 探针（lifecycle 节）：普通资产隔离、保留素材生命周期与删除竞态。
 * - 普通资产隔离：保留素材（continuity_entry / continuity_use / continuity_context）对
 *   资产列表 / 导入 / 内容覆写 / 版本还原 / 软删 / 彻底删 / 回收站清空 / 剧与集内容资产 /
 *   自动摘要素材 / 版本组清理 / 段间 refs purpose 选择器 全量不可见、不可动；
 * - lifecycle 服务三守卫直测（项目可写 / purge 放行 / 集未被台账引用）+ 错误面（404 / 409）；
 * - 项目彻底删除：在途台账（extracting/dispatching）→ 409 拦截；成功路径同事务清零台账；
 *   影子项目删除（轻松创作会话）：已立项 session_only 不动台账；draft_purged 同事务清台账；在途拒绝；
 * - 剧集缩容 / 删剧 / 删集遇任一登记即拒绝（任意 rowType/status，draft 亦拦）；交错并发（第二连接）证明
 *   守卫与删除同事务、最终仲裁见已提交登记；归档软删（真实 DELETE /projects/:id）拒绝新写、读仍可解释；
 * - batch 目标步端到端禁用（建 run 与服务直测双 400）；failed-run 携批准冻结推进被拒（409 + blocked/state）；
 *   route 链取消投影不伪装待承接；route-bridge 集号边界 400/404；多 undecided 清算顺序=最新优先 + 精确同意放行；
 *   succeeded-无证据 off 分支（202 原样复制 + 零台账绑定）；端点级源缺失 404；目标步回写不复活已删项目（破坏性收尾）。
 * 隔离与红线：临时 SQLite（bootstrap 每次新建）、全 fixture 自建、全节零真实模型/媒体/外网；
 * 引擎 startRun 桩 try/finally 还原（真实 startRun 会异步触发全局 pump 污染共享 SQLite）；
 * fetch 全程桩死；canary 表节专属 _m70_probe_canary_lifecycle；不读取/复制任何真实配置与数据。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Checker } from '../../probe-lib'
import { ContinuityError, type Approval, type TargetRequest } from '../../../src/services/continuity/contract'
import type { Template } from '../../../src/pipeline/types'
import { withContinuityIO } from '../../../src/services/continuity/runtime'
import { initDatabase } from './bootstrap'
import { confirmation, confirmEpisode, fakeIO, insertLedgerRow, installTargetFixture, makeStepContext, persistEntry,
  chainDecision, templateDecisionEp, seedResumeRun, seedStory, seedUnknownUse, storyDocument } from './fixtures'
import { test } from './fold'

const empty = { content: JSON.stringify({ subjects: [], topics: [], items: [], warnings: [], noChanges: true }),
  usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 }, provider: 'fixture', model: 'fixture' }

/** 保留素材 purpose 集合（与 reserved.ts 真源对齐；探针内仅作断言用）。 */
const RESERVED = ['continuity_entry', 'continuity_use', 'continuity_context']

export async function runLifecycle(checker: Checker) {
  installTargetFixture()
  await initDatabase()
  await runLifecycleBody(checker)
}

async function runLifecycleBody(checker: Checker) {
  // libsql 0.18 连接池自愈（仅探针基础设施，不涉产品代码）：节专属金丝雀表探测池化连接
  // 快照过期，命中即 sqlite.reconnect()；reopen 后仍不一致才算真故障（不掩盖产品缺陷）。
  const { db: rawDb, sqlite } = await import('../../../src/db')
  const { sql } = await import('drizzle-orm')
  await rawDb.run(sql`CREATE TABLE IF NOT EXISTS _m70_probe_canary_lifecycle (v integer NOT NULL)`)
  let canarySeq = 0
  const reopenPool = async () => { await (sqlite as unknown as { reconnect(): Promise<void> }).reconnect() }
  const healIfStale = async (tag: string): Promise<void> => {
    const probe = async (v: number): Promise<boolean> => {
      await rawDb.run(sql`INSERT INTO _m70_probe_canary_lifecycle (v) VALUES (${v})`)
      const row = await rawDb.get(sql`SELECT MAX(v) AS m FROM _m70_probe_canary_lifecycle`) as { m?: number } | undefined
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
  const { and, eq, inArray, isNull, notInArray } = await import('drizzle-orm')
  const {
    assets, contentContinuityRecords: records, contentVersions, creationSessions, episodes, execInputs,
    execSnapshots, genTasks, pipelineRuns, pipelineSteps, projects, series, settings, usageRecords,
  } = await import('../../../src/db/schema')
  const { previewContext, freezeContext, readContext } = await import('../../../src/services/continuity/context')
  const { getEntry } = await import('../../../src/services/continuity/entries')
  const { previewExtraction, extractEntry } = await import('../../../src/services/continuity/extract')
  const { requestNextSegment, resolveSegmentInput } = await import('../../../src/services/workflow')
  const { updateAssetContent, ContentEditError } = await import('../../../src/services/asset-content')
  const { restoreAssetTextVersion, recordAssetTextVersion } = await import('../../../src/services/provenance')
  const { emptyTrash, cleanupVersions } = await import('../../../src/services/version-cleanup')
  const { gatherEpisodeContext } = await import('../../../src/services/memory-autosummary')
  const { deleteCreationSession } = await import('../../../src/services/creation-chat/session-delete')
  const { CreationError } = await import('../../../src/services/creation-chat/contract')
  const { createSession } = await import('../../../src/services/creation-chat/planning')
  const { agentDecisionSchema } = await import('../../../src/services/creation-chat/agent/decision-schema')
  const { hashJson } = await import('../../../src/services/creation-chat/contract')
  const { createRunRow } = await import('../../../src/services/run-create')
  const { writeTextAsset } = await import('../../../src/services/storage')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { prepareRunInput } = await import('../../../src/services/run-create')
  const { engine } = await import('../../../src/pipeline/engine')
  const { RUN_LOGS_DIR } = await import('../../../src/env')
  const { Hono } = await import('hono')
  const { assetsRoutes } = await import('../../../src/routes/assets')
  const { projectsRoutes } = await import('../../../src/routes/projects')
  const { runsRoutes } = await import('../../../src/routes/runs')
  const { creationChatRoutes } = await import('../../../src/routes/creation-chat')
  const { seriesRoutes } = await import('../../../src/routes/series')
  const { versionsRoutes } = await import('../../../src/routes/versions')
  const { continuityRoutes } = await import('../../../src/routes/continuity')
  // 被测 lifecycle 模块：缺失即真实 RED（动态导入失败逐测试记录，不让整节崩溃）。
  const lifecycleModule = () => import('../../../src/services/continuity/lifecycle')

  mkdirSync(RUN_LOGS_DIR, { recursive: true })
  type Story = Awaited<ReturnType<typeof seedStory>>
  const codeOf = (status: number, name?: string) => (e: unknown) =>
    e instanceof ContinuityError && e.status === status && (!name || e.code === name)

  const patchStartRun = (): { calls: number[]; restore: () => void } => {
    const calls: number[] = []
    const original = engine.startRun.bind(engine)
    ;(engine as unknown as { startRun: unknown }).startRun = (id: number): string => { calls.push(id); return 'started' }
    return { calls, restore: () => { delete (engine as unknown as { startRun?: unknown }).startRun; void original } }
  }
  // 节级引擎桩（红线）：本节全程不得真实执行 run；finally 还原。
  const engineGuard = patchStartRun()

  // 路由挂载：资产 / 项目 / 运行 / 轻松创作 / 剧集 / 版本六组（端点级生命周期语义全程走真实端点）。
  const app = new (Hono as typeof import('hono').Hono)()
  app.route('/api/v1', assetsRoutes)
  app.route('/api/v1', projectsRoutes)
  app.route('/api/v1', runsRoutes)
  app.route('/api/v1', creationChatRoutes)
  app.route('/api/v1', seriesRoutes)
  app.route('/api/v1', versionsRoutes)
  app.route('/api/v1', continuityRoutes)
  type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
  const req = async (method: Method, path: string, body?: unknown, raw?: FormData): Promise<Response> => {
    const res = await app.request(path, {
      method,
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    await healIfStale(`${method} ${path}`)
    return res
  }
  const get = (path: string) => req('GET', path)
  const post = (path: string, body?: unknown) => req('POST', path, body ?? {})
  const patch = (path: string, body: unknown) => req('PATCH', path, body)
  const del = (path: string) => req('DELETE', path)
  const errCode = async (res: Response): Promise<string> =>
    ((await res.json()) as { error?: { code?: string } }).error?.code ?? ''

  // ---------- 复用型 fixture ----------
  const countRecords = async (projectId: number) =>
    (await db.select({ id: records.id }).from(records).where(eq(records.projectId, projectId))).length
  const countRuns = async (projectId: number) =>
    (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId))).length
  const countLiveAssets = async (projectId: number) =>
    (await db.select({ id: assets.id }).from(assets)
      .where(and(eq(assets.projectId, projectId), isNull(assets.deletedAt)))).length
  const livePurposes = async (projectId: number) =>
    (await db.select({ purpose: assets.purpose }).from(assets)
      .where(and(eq(assets.projectId, projectId), isNull(assets.deletedAt)))).map(r => r.purpose)
  const freshProject = async (name: string): Promise<number> => {
    const [p] = await db.insert(projects).values({ name, createdAt: 1, updatedAt: 1 }).returning()
    return p!.id
  }
  /** 最小台账行：见 fixtures.insertLedgerRow（生命周期守卫的探针直插面，供多节复用）。 */
  const setupStory = async () => {
    const f = await seedStory(), ef = fakeIO(empty)
    await withContinuityIO(ef.io, async () => {
      for (let i = 0; i < 2; i++) await confirmEpisode(f, i, ef.io)
    })
    return { f, ef }
  }
  /** route 会话（复刻 route 节同款）：既有建会话服务（deferPlanning 零 LLM）→ 重指项目 → 冻结 decision（rev1/ready）。 */
  const makeRouteSession = async (story: Story, decisionInput: unknown): Promise<{ sessionId: number; decisionHash: string; revision: number }> => {
    const detail = await createSession({ content: 'M70 lifecycle 探针：链式生命周期', requestKey: `lc_route_${randomUUID()}`, deferPlanning: true })
    const sessionId = detail.session.id
    const decision = agentDecisionSchema.parse(decisionInput)
    const decisionHash = hashJson(decision)
    await db.update(creationSessions).set({ projectId: story.projectId, status: 'ready', decision: JSON.stringify(decision),
      decisionHash, planRevision: 1, preflight: JSON.stringify({ ready: true, issues: [], summary: { mode: decision.mode, templateKeys: [] } }),
      error: null, updatedAt: Date.now() }).where(eq(creationSessions.id, sessionId))
    return { sessionId, decisionHash, revision: 1 }
  }
  const routeTarget = (sessionId: number, decisionRevision: number, decisionHash: string): Extract<TargetRequest, { kind: 'route' }> =>
    ({ kind: 'route', sessionId, decisionRevision, decisionHash })
  /** route 目标包冻结（re-preview → re-approve 同源）：预览/freeze 零模型调用。 */
  const freezeRoutePack = async (story: Story, ef: ReturnType<typeof fakeIO>, sessionId: number,
    decisionRevision: number, decisionHash: string): Promise<Approval> => {
    const target = routeTarget(sessionId, decisionRevision, decisionHash)
    const p = await withContinuityIO(ef.io, () => previewContext(story.projectId, { target, includePlans: false }))
    assert.deepEqual(p.blockers, [])
    return withContinuityIO(ef.io, () => freezeContext(story.projectId, { target, includePlans: false,
      previewHash: p.doc.previewHash,
      acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID() }))
  }
  /** 手工异种包冻结（kind=manual），供 run 删除处置探针建 bound 台账行。 */
  const freezeManualPack = async (story: Story, ef: ReturnType<typeof fakeIO>, episodeId: number, brief: string): Promise<Approval> => {
    const tpl = loadTemplate('m70-fixture-episode')
    const norm = prepareRunInput(tpl, { brief, episode_number: 3, with_continuity: true })
    const target = { kind: 'manual' as const, episodeId, templateKey: 'm70-fixture-episode',
      input: norm as Extract<TargetRequest, { kind: 'manual' }>['input'] }
    const p = await withContinuityIO(ef.io, () => previewContext(story.projectId, { target, includePlans: false }))
    assert.deepEqual(p.blockers, [])
    return withContinuityIO(ef.io, () => freezeContext(story.projectId, { target, includePlans: false,
      previewHash: p.doc.previewHash,
      acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID() }))
  }
  /** resume 批准包冻结，可选携精确未知费用同意。 */
  const freezeResumePack = async (story: Story, ef: ReturnType<typeof fakeIO>, srcRunId: number,
    opts: { consentUseId?: number } = {}): Promise<Approval> => {
    const target: TargetRequest = { kind: 'resume', runId: srcRunId }
    const p = await withContinuityIO(ef.io, () => previewContext(story.projectId, { target, includePlans: false }))
    return withContinuityIO(ef.io, () => freezeContext(story.projectId, { target, includePlans: false,
      previewHash: p.doc.previewHash,
      acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID(),
      ...(opts.consentUseId !== undefined
        ? { duplicateCostAcceptance: { useId: opts.consentUseId, accepted: true as const } } : {}) }))
  }
  /** failed 源 run + 真实目标步行（resume 面探针用）。 */
  const seedSourceWithStep = async (story: Story, input: Record<string, unknown>): Promise<{ runId: number; stepId: number }> => {
    const runId = await seedResumeRun(story, 3, input)
    const tpl = loadTemplate('m70-fixture-episode')
    const def = tpl.steps[0]!
    const [step] = await db.insert(pipelineSteps).values({ runId, seq: 1, stepKey: def.key, actionKey: def.action,
      title: def.title, status: 'failed', attempts: 1, createdAt: 1, updatedAt: 1 }).returning()
    return { runId, stepId: step!.id }
  }

  // ===== 测试主体（节级引擎桩全程生效，任何路径都不得真实执行 run）=====
  try {

  // ---------- A. 普通资产隔离（10.4） ----------

  await t('L01 默认列表排除保留 purpose；?purpose=continuity_entry 恒空', async () => {
    const A = await seedStory()
    for (const purpose of RESERVED) {
      await writeTextAsset(A.projectId, { name: `${randomUUID()}.json`, purpose, content: '保留素材' })
    }
    const res = await get(`/api/v1/projects/${A.projectId}/assets`)
    assert.equal(res.status, 200)
    const body = await res.json() as { items: Array<{ purpose: string | null }>; total: number }
    for (const item of body.items) assert.ok(!RESERVED.includes(item.purpose ?? ''), `列表泄漏保留 purpose：${item.purpose}`)
    const dbNonReserved = (await db.select({ id: assets.id }).from(assets)
      .where(and(eq(assets.projectId, A.projectId), isNull(assets.deletedAt), notInArray(assets.purpose, RESERVED)))).length
    assert.equal(body.total, dbNonReserved)
    const filtered = await get(`/api/v1/projects/${A.projectId}/assets?purpose=continuity_entry`)
    assert.equal(filtered.status, 200)
    const fbody = await filtered.json() as { items: unknown[]; total: number }
    assert.equal(fbody.total, 0)
    assert.deepEqual(fbody.items, [])
  })

  await t('L02 imports 拒绝保留 purpose（400 reserved_purpose，零落库）', async () => {
    const pid = await freshProject('生命周期-导入')
    const fileCtor = (globalThis as unknown as { File: new (parts: Uint8Array[], name: string, opts?: { type?: string }) => File }).File
    const fd = new FormData()
    fd.set('purpose', 'continuity_entry')
    fd.set('file', new fileCtor([new TextEncoder().encode('保留素材上传内容')], 'a.txt', { type: 'text/plain' }))
    const res = await req('POST', `/api/v1/projects/${pid}/imports`, undefined, fd)
    assert.equal(res.status, 400)
    assert.equal(await errCode(res), 'reserved_purpose')
    assert.equal(await countLiveAssets(pid), 0)
  })

  await t('L03 内容覆写拒绝保留 purpose（守卫：可编辑白名单不含保留素材）', async () => {
    const pid = await freshProject('生命周期-覆写')
    const a = await writeTextAsset(pid, { name: `${randomUUID()}.json`, purpose: 'continuity_entry', content: '{}' })
    await assert.rejects(updateAssetContent(a.id, '试图覆写保留素材'), (e: unknown) =>
      e instanceof ContentEditError && e.code === 'bad_purpose')
  })

  await t('L04 版本还原拒绝保留 purpose（服务 reserved_purpose + HTTP 400）', async () => {
    const pid = await freshProject('生命周期-还原')
    const a = await writeTextAsset(pid, { name: `${randomUUID()}.json`, purpose: 'continuity_use', content: '{}' })
    const v = await recordAssetTextVersion({ asset: a, content: '{}', source: 'generate' })
    await assert.rejects(restoreAssetTextVersion(a.id, v.id), (e: unknown) =>
      e instanceof Error && (e as { code?: string }).code === 'reserved_purpose')
    const res = await post(`/api/v1/assets/${a.id}/versions/${v.id}/restore`)
    assert.equal(res.status, 400)
    assert.equal(await errCode(res), 'reserved_purpose')
  })

  await t('L05 软删拒绝保留 purpose（409 reserved_purpose）', async () => {
    const pid = await freshProject('生命周期-软删')
    const a = await writeTextAsset(pid, { name: `${randomUUID()}.json`, purpose: 'continuity_entry', content: '{}' })
    const res = await del(`/api/v1/assets/${a.id}`)
    assert.equal(res.status, 409)
    assert.equal(await errCode(res), 'reserved_purpose')
    const [row] = await db.select().from(assets).where(eq(assets.id, a.id))
    assert.equal(row!.deletedAt, null)
  })

  await t('L06 回收站彻底删拒绝保留 purpose（409 reserved_purpose）', async () => {
    const pid = await freshProject('生命周期-彻底删')
    const a = await writeTextAsset(pid, { name: `${randomUUID()}.json`, purpose: 'continuity_context', content: '承接包' })
    const res = await del(`/api/v1/assets/${a.id}/purge`)
    assert.equal(res.status, 409)
    assert.equal(await errCode(res), 'reserved_purpose')
    const [row] = await db.select().from(assets).where(eq(assets.id, a.id))
    assert.ok(row)
  })

  await t('L07 emptyTrash 跳过保留 purpose（skipped 计数 + 行保留）', async () => {
    const pid = await freshProject('生命周期-清空')
    const reserved = await writeTextAsset(pid, { name: `${randomUUID()}.json`, purpose: 'continuity_entry', content: '{}' })
    const normal = await writeTextAsset(pid, { name: `${randomUUID()}.md`, purpose: 'script', content: '普通剧本' })
    await db.update(assets).set({ deletedAt: 1, updatedAt: 1 }).where(inArray(assets.id, [reserved.id, normal.id]))
    const r = await emptyTrash(pid)
    assert.equal(r.purged, 1)
    assert.equal(r.skipped, 1)
    const kept = await db.select().from(assets).where(eq(assets.id, reserved.id))
    assert.equal(kept.length, 1)
  })

  await t('L08 剧与集内容资产拒绝保留 purpose（400 reserved_purpose；正例 script 不受影响）', async () => {
    const pid = await freshProject('生命周期-剧')
    const reservedA = await writeTextAsset(pid, { name: `${randomUUID()}.json`, purpose: 'continuity_entry', content: '{}' })
    const scriptA = await writeTextAsset(pid, { name: `${randomUUID()}.md`, purpose: 'script', content: '剧本内容' })
    const bad = await post(`/api/v1/projects/${pid}/series`, { name: '剧', total_episodes: 2, content_asset_id: reservedA.id })
    assert.equal(bad.status, 400)
    assert.equal(await errCode(bad), 'reserved_purpose')
    const ok = await post(`/api/v1/projects/${pid}/series`, { name: '剧二', total_episodes: 2, content_asset_id: scriptA.id })
    assert.equal(ok.status, 201)
    const okBody = await ok.json() as { series: { id: number }; episodes: Array<{ id: number }> }
    assert.equal(okBody.episodes.length, 2)
    const rebad = await patch(`/api/v1/episodes/${okBody.episodes[0]!.id}`, { content_asset_id: reservedA.id })
    assert.equal(rebad.status, 400)
    assert.equal(await errCode(rebad), 'reserved_purpose')
    const regood = await patch(`/api/v1/episodes/${okBody.episodes[0]!.id}`, { content_asset_id: scriptA.id })
    assert.equal(regood.status, 200)
  })

  await t('L09 自动摘要排除保留 purpose（contentAsset 路径 + run 文本 top3 路径）', async () => {
    const S = await seedStory()
    await db.insert(settings).values({ key: 'memory.auto_summary', value: 'true', updatedAt: 1 }).onConflictDoNothing()
    // 路径一：集 contentAssetId 是保留素材 → 整体跳过（宁可漏摘要也不把保留素材当正文）
    const reserved = await writeTextAsset(S.projectId, { name: `${randomUUID()}.json`, purpose: 'continuity_entry', content: '保留素材标记-内容资产路径' })
    const runA = await seedResumeRun(S, 3, { episode_number: 3 })
    await db.update(pipelineRuns).set({ status: 'completed', updatedAt: 1 }).where(eq(pipelineRuns.id, runA))
    await db.update(episodes).set({ latestRunId: runA, contentAssetId: reserved.id, updatedAt: 1 }).where(eq(episodes.id, S.episodes[2]!))
    assert.equal(await gatherEpisodeContext(runA), null)
    // 路径二：run 文本 top3 装配排除 continuity_use
    const runB = await seedResumeRun(S, 2, { episode_number: 2 })
    await db.update(pipelineRuns).set({ status: 'completed', updatedAt: 1 }).where(eq(pipelineRuns.id, runB))
    await writeTextAsset(S.projectId, { name: `${randomUUID()}.json`, purpose: 'continuity_use', content: '消费遗留标记-top3', runId: runB })
    await writeTextAsset(S.projectId, { name: `${randomUUID()}.md`, purpose: 'script', content: '正常产物标记-top3', runId: runB })
    await db.update(episodes).set({ latestRunId: runB, contentAssetId: null, updatedAt: 1 }).where(eq(episodes.id, S.episodes[1]!))
    const ctx = await gatherEpisodeContext(runB)
    assert.ok(ctx)
    assert.ok(ctx!.sourceText.includes('正常产物标记-top3'))
    assert.ok(!ctx!.sourceText.includes('消费遗留标记-top3'))
  })

  await t('L10 版本组清理不触保留素材（守卫：清理范围仅 image/video）', async () => {
    const pid = await freshProject('生命周期-版本清理')
    const reserved = await writeTextAsset(pid, { name: `${randomUUID()}.json`, purpose: 'continuity_entry', content: '{}' })
    await recordAssetTextVersion({ asset: reserved, content: '{}', source: 'generate' })
    const r = await cleanupVersions({ projectId: pid })
    assert.equal(r.groups, 0)
    assert.equal(r.cleaned, 0)
    const [row] = await db.select().from(assets).where(eq(assets.id, reserved.id))
    assert.equal(row!.deletedAt, null)
  })

  // ---------- B. lifecycle 守卫与项目 purge（10.5） ----------

  await t('L11 lifecycle 三守卫直测（可写/purge/units + 404/409 错误面）', async () => {
    const { isContinuityPurpose, assertContinuityProjectWritable, assertContinuityPurgeAllowed, assertUnitsUnreferenced } =
      await lifecycleModule()
    for (const p of RESERVED) assert.equal(isContinuityPurpose(p), true)
    for (const p of ['script', 'source', 'final_video', '', null, undefined]) assert.equal(isContinuityPurpose(p as string), false)
    const pid = await freshProject('生命周期-直测')
    await assertContinuityProjectWritable(db, pid)
    await assert.rejects(assertContinuityProjectWritable(db, 9_999_999), codeOf(404, 'continuity_source_invalid'))
    const [gone] = await db.insert(projects).values({ name: '已删项目', createdAt: 1, updatedAt: 1, deletedAt: 1 }).returning()
    await assert.rejects(assertContinuityProjectWritable(db, gone!.id), codeOf(404))
    await assertContinuityPurgeAllowed(db, pid)
    await insertLedgerRow(pid, { rowType: 'entry', status: 'extracting' })
    await assert.rejects(assertContinuityPurgeAllowed(db, pid), codeOf(409, 'continuity_in_flight'))
    const pid2 = await freshProject('生命周期-直测二')
    await insertLedgerRow(pid2, { rowType: 'consumption', status: 'dispatching' })
    await assert.rejects(assertContinuityPurgeAllowed(db, pid2), codeOf(409, 'continuity_in_flight'))
    const S = await seedStory()
    await persistEntry(await storyDocument(S, 1), 'draft')
    // R19：任一登记即拦（draft 亦拦）；正例（清零后放行）由 L17 端点级缩容覆盖。
    await assert.rejects(assertUnitsUnreferenced(db, S.projectId, [S.episodes[1]!]), codeOf(409, 'continuity_entry_referenced'))
    await persistEntry(await storyDocument(S, 0), 'confirmed')
    await assert.rejects(assertUnitsUnreferenced(db, S.projectId, [S.episodes[0]!]), codeOf(409, 'continuity_entry_referenced'))
  })

  await t('L12 项目 purge 拦截在途台账（extracting/dispatching → 409，项目原样）', async () => {
    const pid = await freshProject('生命周期-purge拦截')
    await insertLedgerRow(pid, { rowType: 'entry', status: 'extracting' })
    await insertLedgerRow(pid, { rowType: 'consumption', status: 'dispatching' })
    const res = await del(`/api/v1/projects/${pid}?purge=1`)
    assert.equal(res.status, 409)
    assert.equal(await errCode(res), 'continuity_in_flight')
    const [p] = await db.select().from(projects).where(eq(projects.id, pid))
    assert.ok(p, '在途台账在册时项目行必须原样保留')
  })

  await t('L13 项目 purge 成功路径同事务清零台账', async () => {
    const pid = await freshProject('生命周期-purge成功')
    const asset = await writeTextAsset(pid, { name: `${randomUUID()}.md`, purpose: 'script', content: '产物' })
    const version = await recordAssetTextVersion({ asset, content: '产物', source: 'generate' })
    const [run] = await db.insert(pipelineRuns).values({ projectId: pid, templateKey: 'm70-fixture-episode',
      input: '{}', status: 'completed', createdAt: 1, updatedAt: 1 }).returning()
    const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 1, stepKey: 'write_script',
      actionKey: 'ai_text', title: '步', status: 'succeeded', createdAt: 1, updatedAt: 1 }).returning()
    await db.insert(genTasks).values({ projectId: pid, runId: run!.id, stepId: step!.id, kind: 'text', params: '{}',
      status: 'succeeded', createdAt: 1, updatedAt: 1 })
    const [snap] = await db.insert(execSnapshots).values({ projectId: pid, execKind: 'pipeline_step', runId: run!.id,
      stepId: step!.id, templateKey: 'm70-fixture-episode', inputHash: 'a'.repeat(64), frozenAt: 1, createdAt: 1 }).returning()
    await db.insert(execInputs).values({ projectId: pid, snapshotId: snap!.id, role: 'fixture', srcKind: 'asset',
      srcId: asset.id, versionId: version.id, ordinal: 0, createdAt: 1 })
    await db.insert(usageRecords).values({ projectId: pid, kind: 'llm', quantity: 1, unit: 'tokens_in', unitPrice: 1, cost: 1, createdAt: 1 })
    await insertLedgerRow(pid, { rowType: 'entry', status: 'confirmed', unitId: 1 })
    await insertLedgerRow(pid, { rowType: 'consumption', status: 'unknown', unitId: 1 })
    const res = await del(`/api/v1/projects/${pid}?purge=1`)
    assert.equal(res.status, 200)
    // 计数辅助：以上表均含 id/projectId 列（运行期同构；类型侧以 records 形状收窄）。
    // pipeline_steps 无 project_id（仅 run_id），由本用例唯一 run 反查，避免向不存在列发 SQL。
    const cntOf = async (table: typeof records | typeof assets | typeof pipelineRuns |
        typeof execInputs | typeof execSnapshots | typeof genTasks | typeof usageRecords | typeof contentVersions) => {
      const t = table as typeof records
      return (await db.select({ id: t.id }).from(t).where(eq(t.projectId, pid))).length
    }
    assert.equal(await cntOf(records), 0)
    assert.equal(await cntOf(execInputs), 0)
    assert.equal(await cntOf(execSnapshots), 0)
    assert.equal(await cntOf(usageRecords), 0)
    assert.equal(await cntOf(assets), 0)
    assert.equal(await cntOf(pipelineRuns), 0)
    assert.equal((await db.select({ id: pipelineSteps.id }).from(pipelineSteps)
      .where(eq(pipelineSteps.runId, run!.id))).length, 0)
    assert.equal(await cntOf(genTasks), 0)
    assert.equal(await cntOf(contentVersions), 0)
    const [gone] = await db.select().from(projects).where(eq(projects.id, pid))
    assert.ok(!gone)
  })

  await t('L14 已立项会话删除不动台账（守卫：session_only，项目保留）', async () => {
    const d = await createSession({ content: 'M70 lifecycle 探针：已立项守卫', requestKey: `lc_s14_${randomUUID()}`, deferPlanning: true })
    const pid = d.session.projectId
    await db.update(creationSessions).set({ status: 'ready', updatedAt: Date.now() }).where(eq(creationSessions.id, d.session.id))
    await insertLedgerRow(pid, { rowType: 'entry', status: 'confirmed' })
    await db.update(projects).set({ status: 'active', updatedAt: Date.now() }).where(eq(projects.id, pid))
    const r = await deleteCreationSession(d.session.id)
    assert.equal(r.mode, 'session_only')
    const [p] = await db.select().from(projects).where(eq(projects.id, pid))
    assert.ok(p, '已立项项目必须保留')
    assert.equal(await countRecords(pid), 1)
  })

  await t('L15 影子项目删除 draft_purged 且台账同事务清零', async () => {
    const d = await createSession({ content: 'M70 lifecycle 探针：影子清台账', requestKey: `lc_s15_${randomUUID()}`, deferPlanning: true })
    const pid = d.session.projectId
    await db.update(creationSessions).set({ status: 'ready', updatedAt: Date.now() }).where(eq(creationSessions.id, d.session.id))
    await insertLedgerRow(pid, { rowType: 'entry', status: 'confirmed' })
    const r = await deleteCreationSession(d.session.id)
    assert.equal(r.mode, 'draft_purged')
    assert.equal(await countRecords(pid), 0)
    const [p] = await db.select().from(projects).where(eq(projects.id, pid))
    assert.ok(!p)
  })

  await t('L16 影子项目在途台账拒绝删除（409 continuity_in_flight，会话/项目/行原样）', async () => {
    const d = await createSession({ content: 'M70 lifecycle 探针：影子在途', requestKey: `lc_s16_${randomUUID()}`, deferPlanning: true })
    const pid = d.session.projectId
    await db.update(creationSessions).set({ status: 'ready', updatedAt: Date.now() }).where(eq(creationSessions.id, d.session.id))
    const rid = await insertLedgerRow(pid, { rowType: 'entry', status: 'extracting' })
    await assert.rejects(deleteCreationSession(d.session.id), (e: unknown) =>
      e instanceof CreationError && e.status === 409 && e.code === 'continuity_in_flight')
    const [p] = await db.select().from(projects).where(eq(projects.id, pid))
    assert.ok(p)
    const [row] = await db.select().from(records).where(eq(records.id, rid))
    assert.ok(row)
    const [s] = await db.select().from(creationSessions).where(eq(creationSessions.id, d.session.id))
    assert.ok(s)
  })

  // ---------- C. 删生命周期与强制承接补测义务（story 各自隔离） ----------

  await t('L17 剧集缩容/删剧遇任一登记即拦（409 continuity_entry_referenced；draft 亦拦）', async () => {
    const B = await seedStory()
    const confirmed = await persistEntry(await storyDocument(B, 2), 'confirmed')
    const countEps = async () => (await db.select().from(episodes).where(eq(episodes.seriesId, B.seriesId))).length
    const res = await patch(`/api/v1/series/${B.seriesId}`, { total_episodes: 2 })
    assert.equal(res.status, 409)
    assert.equal(await errCode(res), 'continuity_entry_referenced')
    assert.equal(await countEps(), 3)
    const res2 = await del(`/api/v1/series/${B.seriesId}`)
    assert.equal(res2.status, 409)
    assert.equal(await errCode(res2), 'continuity_entry_referenced')
    assert.equal((await db.select().from(series).where(eq(series.id, B.seriesId))).length, 1)
    assert.equal(await countEps(), 3, '删剧被拒后集行必须原样保留')
    // R19：判据是「任一登记」（任意 rowType/status）。降为 draft 仍拦——API 无删除草稿入口，不能删成悬空。
    await db.update(records).set({ status: 'draft', updatedAt: 1 }).where(eq(records.id, confirmed.entryId))
    const res3 = await patch(`/api/v1/series/${B.seriesId}`, { total_episodes: 2 })
    assert.equal(res3.status, 409)
    assert.equal(await errCode(res3), 'continuity_entry_referenced')
    assert.equal(await countEps(), 3)
    // 清零登记后缩容才放行：尾部集删除、只剩 2 集。
    await db.delete(records).where(eq(records.id, confirmed.entryId))
    const res4 = await patch(`/api/v1/series/${B.seriesId}`, { total_episodes: 2 })
    assert.equal(res4.status, 200)
    const body = await res4.json() as { episodes: Array<{ number: number }> }
    assert.deepEqual(body.episodes.map(e => e.number), [1, 2])
    assert.equal(await countEps(), 2)
  })

  await t('L18 段间 refs purpose 选择器过滤保留素材（$prev.assets/text/asset 同过滤）', async () => {
    const E = await seedStory()
    const prevRun = await seedResumeRun(E, 3, { episode_number: 2 })
    await writeTextAsset(E.projectId, { name: `${randomUUID()}.json`, purpose: 'continuity_context', content: '承接包内容', runId: prevRun })
    await writeTextAsset(E.projectId, { name: `${randomUUID()}.json`, purpose: 'continuity_entry', content: '{}', runId: prevRun })
    const scriptA = await writeTextAsset(E.projectId, { name: `${randomUUID()}.md`, purpose: 'script', content: '上一段剧本', runId: prevRun })
    const refsTemplate: Template = {
      key: 'm70-lifecycle-refs', version: 1, name: 'refs 选择器过滤', genre: 'drama_short',
      inputs: [
        { key: 'brief', label: '简报', kind: 'text', required: true },
        { key: 'continuity_context', label: '承接包', kind: 'files', required: false },
        { key: 'script', label: '剧本', kind: 'files', required: false },
        { key: 'use_text', label: '来料文本', kind: 'text', required: false },
        { key: 'use_asset', label: '来料资产', kind: 'files', required: false },
      ],
      steps: [{ key: 'notes', action: 'ai_text', title: '普通步', inputs: {}, params: { prompt_inline: '不消费承接包。' } }],
    }
    const r = await resolveSegmentInput({ template: refsTemplate, prevRunId: prevRun, inputSpec: {
      brief: '常量简报',
      continuity_context: '$prev.assets:continuity_context',
      script: '$prev.assets:script',
      use_text: '$prev.text:continuity_context',
      use_asset: '$prev.asset:continuity_entry',
    } })
    assert.equal(r.inputs['continuity_context'], undefined)
    assert.deepEqual(r.inputs['script'], [scriptA.id])
    assert.equal(r.inputs['use_text'], undefined)
    assert.equal(r.inputs['use_asset'], undefined)
    assert.deepEqual(r.prevSources, [scriptA.id])
  })

  await t('L19 run 删除后 bound 台账行保留历史（守卫：行在可读 + 同批准再绑 409）', async () => {
    const { f, ef } = await setupStory()
    const approval = await freezeManualPack(f, ef, f.episodes[2]!, 'F 手工包')
    const ctx = await makeStepContext(f, approval)
    await db.update(pipelineRuns).set({ status: 'failed', updatedAt: Date.now() }).where(eq(pipelineRuns.id, ctx.run.id))
    const before = await countRecords(f.projectId)
    const res = await del(`/api/v1/runs/${ctx.run.id}`)
    assert.equal(res.status, 200)
    assert.equal((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, ctx.run.id))).length, 0)
    const [row] = await db.select().from(records).where(eq(records.id, approval.contextId))
    assert.equal(row!.status, 'bound')
    assert.equal(row!.runId, ctx.run.id)
    assert.equal(await countRecords(f.projectId), before)
    await readContext(f.projectId, approval, db)
    const tpl = loadTemplate('m70-fixture-episode')
    const norm = prepareRunInput(tpl, { brief: 'F 手工包', episode_number: 3, with_continuity: true })
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: f.projectId, templateKey: 'm70-fixture-episode',
      input: { ...norm, continuity_context: [approval.document.assetId] }, continuityApproval: approval })), codeOf(409))
  })

  await t('L20 batch 目标步端到端禁用（守卫：建 run 400 bad_input + 服务直测拒绝）', async () => {
    const G = await seedStory()
    const ef = fakeIO(empty)
    const runs0 = await countRuns(G.projectId)
    const res = await post(`/api/v1/projects/${G.projectId}/runs`,
      { template_key: 'm70-fixture-batchrole', input: { brief: 'G批量', episode_number: 1, with_continuity: true } })
    assert.equal(res.status, 400)
    assert.equal(await errCode(res), 'bad_input')
    assert.equal(await countRuns(G.projectId), runs0)
    assert.equal((await db.select({ id: genTasks.id }).from(genTasks).where(eq(genTasks.projectId, G.projectId))).length, 0)
    assert.equal((await db.select({ id: usageRecords.id }).from(usageRecords).where(eq(usageRecords.projectId, G.projectId))).length, 0)
    await assert.rejects(withContinuityIO(ef.io, () => createRunRow({ projectId: G.projectId, templateKey: 'm70-fixture-batchrole',
      input: { brief: 'x', episode_number: 1, with_continuity: true } })), (e: unknown) =>
      e instanceof Error && (e as { code?: string }).code === 'bad_input')
  })

  await t('L21 failed-run 携批准冻结推进被拒（守卫：409 continuity_conflict + blocked/state 零新 run）', async () => {
    const { f, ef } = await setupStory()
    const s = await makeRouteSession(f, chainDecision('C失败一段', 'C失败二段'))
    const approval = await freezeRoutePack(f, ef, s.sessionId, s.revision, s.decisionHash)
    const runs0 = await countRuns(f.projectId)
    const ok = await withContinuityIO(ef.io, () => post('/api/v1/creation-sessions/' + s.sessionId + '/confirm',
      { decisionRevision: s.revision, decisionHash: s.decisionHash, idempotencyKey: 'lc_confirm_21', acceptUnpriced: true, continuityApproval: approval }))
    assert.equal(ok.status, 202)
    const okBody = await ok.json() as { runId: number; workflowId: number }
    await db.update(pipelineRuns).set({ status: 'failed', updatedAt: Date.now() }).where(eq(pipelineRuns.id, okBody.runId))
    const target: TargetRequest = { kind: 'workflow', workflowId: okBody.workflowId, nextSeq: 1, previousRunId: okBody.runId }
    await assert.rejects(withContinuityIO(ef.io, () => previewContext(f.projectId, { target, includePlans: false })),
      codeOf(409, 'continuity_conflict'))
    await assert.rejects(withContinuityIO(ef.io, () => freezeContext(f.projectId, { target, includePlans: false,
      previewHash: 'a'.repeat(64), acceptedGaps: [], operationKey: randomUUID() })), codeOf(409, 'continuity_conflict'))
    assert.deepEqual(await requestNextSegment(okBody.workflowId), { kind: 'blocked', reason: 'state' })
    assert.equal(await countRuns(f.projectId), runs0 + 1)
  })

  await t('L22 route 链取消投影不伪装待承接（守卫：awaiting=false/block=null/台账原样）', async () => {
    const { f, ef } = await setupStory()
    const s = await makeRouteSession(f, chainDecision('C取消一段', 'C取消二段'))
    const approval = await freezeRoutePack(f, ef, s.sessionId, s.revision, s.decisionHash)
    const ok = await withContinuityIO(ef.io, () => post('/api/v1/creation-sessions/' + s.sessionId + '/confirm',
      { decisionRevision: s.revision, decisionHash: s.decisionHash, idempotencyKey: 'lc_confirm_22', acceptUnpriced: true, continuityApproval: approval }))
    assert.equal(ok.status, 202)
    const okBody = await ok.json() as { runId: number }
    const before = await countRecords(f.projectId)
    const res = await post('/api/v1/creation-sessions/' + s.sessionId + '/cancel')
    assert.equal(res.status, 200)
    const body = await res.json() as { session?: { chainAwaiting?: boolean; chainContinuityBlock?: unknown } }
    assert.equal(body.session?.chainAwaiting, false)
    assert.equal(body.session?.chainContinuityBlock, null)
    assert.equal(await countRecords(f.projectId), before)
    const [row] = await db.select().from(records).where(eq(records.id, approval.contextId))
    assert.equal(row!.status, 'bound')
    assert.equal(row!.runId, okBody.runId)
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, okBody.runId))
    assert.equal(run!.status, 'cancelled')
  })

  await t('L23 route-bridge 集号边界（守卫：非整数集号 → 400；episode 0/99 → 404 continuity_source_invalid）', async () => {
    const { f, ef } = await setupStory()
    // 非法形态（非整数）：prepareRouteInput 归一失败 → 400
    const s15 = await makeRouteSession(f, templateDecisionEp('I集号半', 1.5))
    await assert.rejects(withContinuityIO(ef.io, () => previewContext(f.projectId,
      { target: routeTarget(s15.sessionId, s15.revision, s15.decisionHash), includePlans: false })), codeOf(400, 'continuity_source_invalid'))
    // 形态合法但不存在的集号 → 404
    const s0 = await makeRouteSession(f, templateDecisionEp('I集号零', 0))
    await assert.rejects(withContinuityIO(ef.io, () => previewContext(f.projectId,
      { target: routeTarget(s0.sessionId, s0.revision, s0.decisionHash), includePlans: false })), codeOf(404, 'continuity_source_invalid'))
    const s99 = await makeRouteSession(f, templateDecisionEp('I集号越界', 99))
    await assert.rejects(withContinuityIO(ef.io, () => previewContext(f.projectId,
      { target: routeTarget(s99.sessionId, s99.revision, s99.decisionHash), includePlans: false })), codeOf(404, 'continuity_source_invalid'))
  })

  await t('L24 多 undecided 清算顺序=最新优先（守卫：preview 指最新 + 精确同意放行 rerun）', async () => {
    const D = await seedStory()
    const ef = fakeIO(empty)
    const { runId, stepId } = await seedSourceWithStep(D, { brief: 'D续跑', episode_number: 3, with_continuity: true })
    void stepId
    const r1 = await seedUnknownUse(D, runId, D.episodes[2]!)
    const r2 = await seedUnknownUse(D, runId, D.episodes[2]!)
    assert.ok(r2 > r1)
    const p = await withContinuityIO(ef.io, () => previewContext(D.projectId, { target: { kind: 'resume', runId }, includePlans: false }))
    assert.equal(p.unknownUseId, r2, '多条 undecided 待清算必须取最新一条（旧者保持 fail-closed）')
    await assert.rejects(withContinuityIO(ef.io, () => freezeContext(D.projectId, { target: { kind: 'resume', runId },
      includePlans: false, previewHash: p.doc.previewHash,
      acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })),
      operationKey: randomUUID(), duplicateCostAcceptance: { useId: r1, accepted: true } })), codeOf(409))
    const approval = await freezeResumePack(D, ef, runId, { consentUseId: r2 })
    const res = await post(`/api/v1/runs/${runId}/resume`,
      { continuity_approval: approval, unknown_use_id: r2, accept_possible_duplicate_cost: true })
    assert.equal(res.status, 202)
    const body = await res.json() as { run: { id: number; resumedFromRunId: number | null } }
    assert.equal(body.run.resumedFromRunId, runId)
    for (const rid of [r1, r2]) {
      const [row] = await db.select().from(records).where(eq(records.id, rid))
      assert.equal(row!.status, 'unknown', '同意只放行本次续跑，遗留台账行不得被顺带翻转')
    }
    assert.ok(engineGuard.calls.includes(body.run.id))
  })

  await t('L25 succeeded-无证据 off 分支（守卫：202 原样复制 + 零台账绑定）', async () => {
    const J = await seedStory()
    const { runId } = await seedSourceWithStep(J, { brief: 'J续跑', episode_number: 3, with_continuity: true })
    await db.update(pipelineSteps).set({ status: 'succeeded', output: JSON.stringify({ asset_ids: [] }), updatedAt: 1 })
      .where(eq(pipelineSteps.runId, runId))
    const res = await post(`/api/v1/runs/${runId}/resume`, {})
    assert.equal(res.status, 202)
    const body = await res.json() as { run: { id: number; resumedFromRunId: number | null; input: Record<string, unknown> } }
    assert.equal(body.run.resumedFromRunId, runId)
    assert.equal(body.run.input['with_continuity'], true)
    assert.equal((await db.select({ id: records.id }).from(records).where(eq(records.runId, body.run.id))).length, 0)
    const [newStep] = await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, body.run.id), eq(pipelineSteps.stepKey, 'write_script')))
    assert.equal(newStep!.status, 'succeeded')
  })

  await t('L26 端点级源缺失 404（守卫：路由存在性前置 not_found；服务级 continuity_source_invalid 由 resume 节覆盖）', async () => {
    const res = await post('/api/v1/runs/9999999/resume', {})
    assert.equal(res.status, 404)
    const code = await errCode(res)
    assert.ok(['not_found', 'continuity_source_invalid'].includes(code), `源缺失 404 错误码不符口径：${code}`)
  })

  await t('L27 目标步回写不复活已删项目（守卫；破坏性用例固定收尾）', async () => {
    const K = await seedStory()
    const modelDoc = await storyDocument(K, 2)
    const custom = fakeIO({ content: JSON.stringify({ subjects: modelDoc.subjects, topics: modelDoc.topics,
      items: modelDoc.items, warnings: [], noChanges: false }),
      usage: { promptTokens: 120, completionTokens: 60, totalTokens: 180 }, provider: 'fixture', model: 'fixture' })
    const baseChat = custom.io.chat
    type ChatFn = typeof baseChat
    // 模型响应间隙项目行被删（保留台账占位行）：终局回写 entryRow → resolveUnit 必须拒绝，绝不复活
    custom.io.chat = async (...args: Parameters<ChatFn>): ReturnType<ChatFn> => {
      await db.delete(projects).where(eq(projects.id, K.projectId))
      return baseChat(...args)
    }
    // preview 与 extract 必须同一 IO 注入：previewHash 含 endpoint 配置（baseUrl/model 等），
    // 跨 IO 计算会在 extract.ts 的 previewHash 比对处误判 continuity_context_changed。
    const pv = await withContinuityIO(custom.io, () => previewExtraction(K.projectId, K.episodes[2]!, K.sources[2]!))
    await assert.rejects(withContinuityIO(custom.io, () => extractEntry(K.projectId, K.episodes[2]!, {
      source: K.sources[2], previewHash: pv.previewHash, operationKey: `lc_${randomUUID()}`,
      allowModelCall: true, acceptUnpriced: true })), codeOf(409, 'continuity_outcome_unknown'))
    assert.equal(await countRecords(K.projectId), 1, '终局回写失败只留占位行，不得新增任何台账行')
    // Minor 5：占位行终态必须可解释（项目/单元已不可达 → 失败簿记被吞，停留在 extracting，永不自愈为成功）。
    const [placeholder] = await db.select().from(records).where(eq(records.projectId, K.projectId))
    assert.ok(placeholder, '占位台账行必须保留（不得被失败簿记删除）')
    assert.ok(['extracting', 'unknown'].includes(placeholder!.status), `占位行终态不可解释：${placeholder!.status}`)
    const [gone] = await db.select().from(projects).where(eq(projects.id, K.projectId))
    assert.ok(!gone)
  })

  await t('L28 归档软删项目写守卫（真实 DELETE 归档 → 写 404/读可解释/恢复后可确认）', async () => {
    const L = await seedStory()
    const ef = fakeIO(empty)
    const eid = L.episodes[2]!, pid = L.projectId
    const draft = await persistEntry(await storyDocument(L, 2), 'draft')
    const arch = await del(`/api/v1/projects/${pid}`)
    assert.equal(arch.status, 200)
    assert.equal((await arch.json() as { mode?: string }).mode, 'archived')
    // 读路径保持可解释：归档项目仍能列出既有登记（不把历史删成不可读）。
    const listed = await get(`/api/v1/projects/${pid}/episodes/${eid}/continuity`)
    assert.equal(listed.status, 200)
    const items = (await listed.json() as { items: Array<{ id: number; status: string }> }).items
    assert.ok(items.some(item => item.id === draft.entryId && item.status === 'draft'), '归档后既有登记必须仍可列出')
    // 写路径一律 404：extract（付费）不得发出模型调用。
    const pv = await withContinuityIO(ef.io, () => previewExtraction(pid, eid, L.sources[2]!))
    const extracted = await withContinuityIO(ef.io, () => post(`/api/v1/projects/${pid}/episodes/${eid}/continuity/extract`,
      { source: L.sources[2], previewHash: pv.previewHash, operationKey: `lc_${randomUUID()}`, allowModelCall: true, acceptUnpriced: true }))
    assert.equal(extracted.status, 404)
    assert.equal(await errCode(extracted), 'continuity_source_invalid')
    assert.equal(ef.calls(), 0, '归档项目必须零模型调用')
    // confirm 在幂等回放分支之后被守卫拦下（不回放、不落状态）。
    const view = await getEntry(pid, draft.entryId)
    const confirmed = await withContinuityIO(ef.io, () => post(`/api/v1/projects/${pid}/continuity/${draft.entryId}/confirm`,
      confirmation(view, `lc_${randomUUID()}`)))
    assert.equal(confirmed.status, 404)
    assert.equal(await errCode(confirmed), 'continuity_source_invalid')
    // preview + freeze：预览允许成功（只读、可解释），freeze 必须 404；若 preview 本身 404 亦可接受。
    const tpl = loadTemplate('m70-fixture-episode')
    const norm = prepareRunInput(tpl, { brief: 'R18 归档', episode_number: 3, with_continuity: true })
    const target = { kind: 'manual' as const, episodeId: eid, templateKey: 'm70-fixture-episode',
      input: norm as Extract<TargetRequest, { kind: 'manual' }>['input'] }
    const preview = await withContinuityIO(ef.io, () => post(`/api/v1/projects/${pid}/continuity/preview`, { target, includePlans: false }))
    assert.equal(preview.status, 200, '归档项目的只读 preview 仍应可解释（R18 只拦写路径）')
    let previewHash = 'a'.repeat(64)
    let acceptedGaps: Array<{ key: string; fingerprint: string; reason: string }> = []
    if (preview.status === 200) {
      const p = (await preview.json() as { preview: { doc: { previewHash: string; gaps: Array<{ key: string; fingerprint: string }> } } }).preview
      previewHash = p.doc.previewHash
      acceptedGaps = p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' }))
    }
    const frozen = await withContinuityIO(ef.io, () => post(`/api/v1/projects/${pid}/continuity/contexts`,
      { kind: 'manual', episodeId: eid, templateKey: 'm70-fixture-episode', input: norm, includePlans: false,
        previewHash, acceptedGaps, operationKey: `lc_${randomUUID()}` }))
    assert.equal(frozen.status, 404)
    assert.equal(await errCode(frozen), 'continuity_source_invalid')
    // 归档可恢复：状态回 active 后守卫动态放行，同一草稿可确认。
    const restore = await patch(`/api/v1/projects/${pid}`, { status: 'active' })
    assert.equal(restore.status, 200)
    const confirmed2 = await withContinuityIO(ef.io, () => post(`/api/v1/projects/${pid}/continuity/${draft.entryId}/confirm`,
      confirmation(view, `lc_${randomUUID()}`)))
    assert.equal(confirmed2.status, 200)
    assert.equal((await confirmed2.json() as { entry: { status: string } }).entry.status, 'confirmed')
  })

  await t('L29 交错并发：第二连接持写锁插入尾部集台账 → 缩容最终 409 且无悬空', async () => {
    const R = await seedStory()
    const { createClient } = await import('@libsql/client')
    const { DATA_DIR } = await import('../../../src/env'), client2 = createClient({ url: `file:${join(DATA_DIR, 'studio.db')}` })
    // libsql 的 transaction('write') 即 BEGIN IMMEDIATE：写锁持有到 commit，主连接只能等锁/BUSY 重试。
    const tx2 = await client2.transaction('write')
    try {
      // bare 台账行：entry/failed 允许文档三字段全空（ck_continuity_document），指向将被缩掉的尾部集。
      await tx2.execute({
        sql: `INSERT INTO content_continuity_records
          (project_id, scope_kind, scope_id, unit_kind, unit_id, unit_ordinal, row_type, status, revision,
           operation_key, request_hash, created_at, updated_at)
          VALUES (?, 'series', ?, 'episode', ?, 3, 'entry', 'failed', 1, ?, ?, 1, 1)`,
        args: [R.projectId, R.seriesId, R.episodes[2]!, `lc_${randomUUID()}`, 'a'.repeat(64)],
      })
      // 未提交：PATCH 的写事务会等锁/BUSY 重试；100ms 后提交，最终仲裁必须看到这条登记并拒绝。
      const pending = patch(`/api/v1/series/${R.seriesId}`, { total_episodes: 2 })
      await new Promise(resolve => setTimeout(resolve, 100))
      await tx2.commit()
      const res = await pending
      assert.equal(res.status, 409)
      assert.equal(await errCode(res), 'continuity_entry_referenced')
    } finally { await tx2.rollback().catch(() => {}); client2.close() }
    const eps = await db.select().from(episodes).where(eq(episodes.seriesId, R.seriesId))
    assert.deepEqual(eps.map(e => e.number).sort(), [1, 2, 3])
    const ledgers = await db.select().from(records).where(and(eq(records.projectId, R.projectId), eq(records.unitId, R.episodes[2]!)))
    assert.equal(ledgers.length, 1, '并发插入的台账行必须保留（不得被缩容顺带删除）')
    // 无悬空：本项目每条台账的 unitId 都必须仍指向存活的集行。
    const live = new Set(eps.map(e => e.id))
    const all = await db.select().from(records).where(eq(records.projectId, R.projectId))
    for (const row of all) assert.ok(live.has(row.unitId), `悬空台账：record ${row.id} → episode ${row.unitId}`)
  })

  } finally { engineGuard.restore() }
}
