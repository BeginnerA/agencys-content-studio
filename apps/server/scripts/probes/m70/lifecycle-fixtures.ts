/**
 * 探针 lifecycle 节的复用型夹具工厂：计数 / 建项目 / 故事确认 / route·manual·resume 冻结包 / failed 源 run 带步骤行的构造。
 * 纯数据构造，零真实模型 / 媒体 / 外网；对 db 与 schema 等运行期单例按需动态 import（与 lifecycle 主体同源同实例），
 * 保证夹具的写入与主体断言的读取命中同一连接，语义与就近定义完全一致。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withContinuityIO } from '../../../src/services/continuity/runtime'
import type { Approval, TargetRequest } from '../../../src/services/continuity/contract'
import { confirmEpisode, fakeIO, seedResumeRun, seedStory } from './fixtures'

type Story = Awaited<ReturnType<typeof seedStory>>

export async function createLifecycleFixtures(empty: Parameters<typeof fakeIO>[0]) {
  const { db } = await import('../../../src/db')
  const { and, eq, isNull } = await import('drizzle-orm')
  const { assets, contentContinuityRecords: records, creationSessions, pipelineRuns, pipelineSteps, projects } =
    await import('../../../src/db/schema')
  const { previewContext, freezeContext } = await import('../../../src/services/continuity/context')
  const { createSession } = await import('../../../src/services/creation-chat/planning')
  const { agentDecisionSchema } = await import('../../../src/services/creation-chat/agent/decision-schema')
  const { hashJson } = await import('../../../src/services/creation-chat/contract')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { prepareRunInput } = await import('../../../src/services/run-create')

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

  return {
    countRecords, countRuns, countLiveAssets, livePurposes, freshProject, setupStory, makeRouteSession,
    routeTarget, freezeRoutePack, freezeManualPack, freezeResumePack, seedSourceWithStep,
  }
}
