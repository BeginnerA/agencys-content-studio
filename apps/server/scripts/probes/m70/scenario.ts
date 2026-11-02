/**
 * M70 Task 13 探针：离线三集主场景（scenario 节）
 * 设计 §13.1：确认 1/2 集 → 预览/生成第 3 集 → 改第 1 集剧本；断言实际发送消息字节不变、
 * 确切依赖逐项失效、影响面区分实际消费/未引用旁支/缺证未知。
 * 另测：零模型复核 0 次、未开启控制组零登记、unknown 不重发、prepared 证据不标已使用。
 * 隔离：bootstrap 临时 ROOT/DATA/WORKSPACE + 临时 SQLite；fetch 全程桩死；不启动任何媒体生成。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import { ContinuityError, UseDocSchema, type Approval, type EntryRef, type PreviewRequest,
  type TargetRequest, type UseDoc } from '../../../src/services/continuity/contract'
import { canonicalHash } from '../../../src/services/continuity/fold'
import { withContinuityIO } from '../../../src/services/continuity/runtime'
import { initDatabase } from './bootstrap'
import { confirmation, confirmEpisode, extractAndReview, fakeIO, installTargetFixture,
  makeStepContext, persistEntry, seedSource, seedStory, seedUnknownUse, storyDocument } from './fixtures'
import { test } from './fold'

const empty = { content: JSON.stringify({ subjects: [], topics: [], items: [], warnings: [], noChanges: true }),
  usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 }, provider: 'fixture', model: 'fixture' }
const generated = { content: '第三集：红信封揭晓，甲离开。乙按下未问。',
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, provider: 'fixture', model: 'fixture' }

type Story = Awaited<ReturnType<typeof seedStory>>
type Unit = { projectId: number; scopeKind: 'series'; scopeId: number; unitKind: 'episode'; unitId: number; unitOrdinal: number }

export async function runScenario(checker: Checker) {
  installTargetFixture()
  await initDatabase()
  await runScenarioBody(checker)
}

async function runScenarioBody(checker: Checker) {
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { contentContinuityRecords: records, pipelineRuns, pipelineSteps } = await import('../../../src/db/schema')
  const { previewContext, freezeContext, readContext } = await import('../../../src/services/continuity/context')
  const { readContinuityVersion } = await import('../../../src/services/continuity/sources')
  const { evaluateEntry } = await import('../../../src/services/continuity/validity')
  const { getImpact } = await import('../../../src/services/continuity/impact')
  const { confirmEntry, reviewEntry } = await import('../../../src/services/continuity/entries')
  const { updateAssetContent } = await import('../../../src/services/asset-content')
  const { documentTransaction, writeDocument } = await import('../../../src/services/continuity/store')
  const { aiText } = await import('../../../src/pipeline/actions/ai-text')
  const { createStepContext } = await import('../../../src/pipeline/context')
  const { loadTemplate } = await import('../../../src/pipeline/loader')

  const manualTarget = (episodeId: number, episode: number, brief: string): TargetRequest =>
    ({ kind: 'manual', episodeId, templateKey: 'm70-fixture-episode',
      input: { episode_number: episode, brief, with_continuity: true } })
  /** 预览 → 逐项接受缺口 → 冻结（与客户端同一公共服务链，零模型调用）。 */
  const freezePack = async (f: Story, io: ReturnType<typeof fakeIO>['io'], target: TargetRequest): Promise<Approval> => {
    const req: PreviewRequest = { target, includePlans: false }
    return withContinuityIO(io, async () => {
      const p = await previewContext(f.projectId, req)
      assert.deepEqual(p.blockers, [])
      return freezeContext(f.projectId, { target, includePlans: false, previewHash: p.doc.previewHash,
        acceptedGaps: p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对' })), operationKey: randomUUID() })
    })
  }
  const readUse = async (row: { projectId: number; documentAssetId: number | null; documentVersionId: number | null; documentHash: string | null }): Promise<UseDoc> =>
    UseDocSchema.parse(JSON.parse(await readContinuityVersion(db, row.projectId,
      { assetId: row.documentAssetId!, versionId: row.documentVersionId!, hash: row.documentHash! })))
  const useRowOf = async (projectId: number, runId: number, stepId: number) => {
    const rows = await db.select().from(records).where(eq(records.projectId, projectId))
    const uses = rows.filter(r => r.rowType === 'consumption' && r.runId === runId && r.stepId === stepId)
    return uses.sort((a, b) => a.id - b.id)
  }
  const countRecords = async (projectId: number) =>
    (await db.select({ id: records.id }).from(records).where(eq(records.projectId, projectId))).length
  const msgs = () => [{ role: 'system' as const, content: 'fixture' }, { role: 'user' as const, content: 'fixture' }]
  /** 测试专用持久证据注入：prepared 只能在进程崩溃窗口内存在，completed/unknown 由服务状态机产出。 */
  const seedUse = async (unit: Unit, entries: EntryRef[], runId: number, state: 'completed' | 'prepared'): Promise<number> => {
    const base = { schemaVersion: 1 as const, context: { assetId: 1, versionId: 1, hash: 'a'.repeat(64) }, entries,
      runId, stepId: runId, round: 'initial', messages: msgs(), messagesHash: canonicalHash(msgs()),
      provider: 'fixture', model: 'fixture', configHash: 'a'.repeat(64), sourceChangedAfterDispatch: false as const }
    const doc: UseDoc = state === 'completed'
      ? { ...base, state, submitted: true, billing: 'recorded', startedAt: 1, completedAt: 2,
        output: { assetId: 1, versionId: 1, hash: 'a'.repeat(64) },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, errorCode: null }
      : { ...base, state, submitted: false, billing: 'not_submitted', startedAt: null, completedAt: null,
        output: null, usage: null, errorCode: null }
    let rowId = 0
    await documentTransaction(async ex => {
      const ref = await writeDocument(ex, unit, 'consumption', doc)
      const [row] = await ex.insert(records).values({ ...unit, rowType: 'consumption', status: state,
        runId, stepId: runId, operationKey: randomUUID(), requestHash: 'e'.repeat(64), documentAssetId: ref.assetId,
        documentVersionId: ref.versionId, documentHash: ref.hash, createdAt: 1, updatedAt: 1 }).returning()
      rowId = row!.id
    })
    return rowId
  }

  await t('13.1 三集主场景：确认1/2→生成3→改1；消息不变、依赖逐项失效、旁支与未知分列', async () => {
    const f = await seedStory(), ef = fakeIO(empty)
    // 1/2 集：提取（各一次模型）→ 人工逐句复核 → 确认；复核走零模型路径。
    const e1 = await confirmEpisode(f, 0, ef.io)
    const e2 = await confirmEpisode(f, 1, ef.io)
    assert.equal(ef.calls(), 2)
    const callsBeforeReview = ef.calls()
    const reviewed = await withContinuityIO(ef.io, () => reviewEntry(f.projectId, f.episodes[0]!,
      { parentId: e1.id, source: f.sources[0]!, operationKey: randomUUID() }))
    assert.equal(ef.calls(), callsBeforeReview, '零模型复核不得调用模型')
    assert.equal(reviewed.status, 'draft')

    // 第 3 集承接包：只含第 1/2 集（排除自身与未来），计划默认关闭。
    const target = manualTarget(f.episodes[2]!, 3, '第三集：红信封揭晓')
    const p3 = await withContinuityIO(ef.io, () => previewContext(f.projectId, { target, includePlans: false }))
    assert.deepEqual(p3.blockers, [])
    assert.deepEqual(p3.doc.entries.map(e => e.unitOrdinal).sort((a, b) => a - b), [1, 2])
    assert.deepEqual(p3.doc.gaps, [])
    const approval = await freezePack(f, ef.io, target)

    // 生成第 3 集：走真实 ai_text 动作 → 冻结承接包 → executeContinuityText 状态机。
    const genFake = fakeIO(generated)
    const ctx = await makeStepContext(f, approval)
    const result = await withContinuityIO(genFake.io, () => aiText(ctx))
    assert.equal(genFake.calls(), 1)
    assert.equal(result.assetIds.length, 1)
    const sentBeforeEdit = JSON.stringify(genFake.messages)
    const sentText = JSON.parse(sentBeforeEdit) as Array<Array<{ role: string; content: string }>>
    assert.ok(sentText[0]![1]!.content.includes('甲受伤') && sentText[0]![1]!.content.includes('钥匙交乙'), '实际消息必须含已确认前集事实')
    const [use] = await useRowOf(f.projectId, ctx.run.id, ctx.step.id)
    assert.equal(use!.status, 'completed')
    const useDoc = await readUse(use!)
    assert.deepEqual(useDoc.entries.map(e => e.unitOrdinal).sort((a, b) => a - b), [1, 2])
    assert.deepEqual(useDoc.messages, genFake.messages[0], '冻结版本与派发消息逐字一致')
    // 复用输出：同 ctx 重入不再 chat。
    const replayFake = fakeIO(generated)
    const replay = await withContinuityIO(replayFake.io, () => aiText(ctx))
    assert.equal(replayFake.calls(), 0)
    assert.deepEqual(replay.assetIds, result.assetIds)

    // 第 3 集人审确认（basis=1/2）→ 影响面出现间接支（第 3 集条目经第 2 集传播）。
    const draft3 = await extractAndReview(f, 2, ef.io)
    const e3 = await withContinuityIO(ef.io, () => confirmEntry(f.projectId, draft3.id, confirmation(draft3, randomUUID())))

    // 未引用旁支：第 8 集来源缺执行历史（history_unavailable），人审确认后不被伪称已引用。
    const sideText = '旁支第八集：红信封揭晓：甲是卧底。未来计划：乙明天去车站。'
    const side = await seedSource(f, 8, sideText, { snapshot: false })
    const sideStory = { ...f, episodes: [...f.episodes, side.episodeId], sources: [...f.sources, side.pick],
      texts: [...f.texts, sideText] } as unknown as Story
    const sideDraft = await extractAndReview(sideStory, 3, ef.io)
    const sideEntry = await withContinuityIO(ef.io, () => confirmEntry(f.projectId, sideDraft.id, confirmation(sideDraft, randomUUID())))
    const sideState = await evaluateEntry(sideEntry.id, db)
    assert.equal(sideState.validity, 'valid')
    assert.equal(sideState.history, 'history_unavailable')
    const contextDoc = await readContext(f.projectId, approval, db)
    const sideRun = 9_000_001
    const sideUse = await seedUse(contextDoc.target.unit, [], sideRun, 'completed')
    const sideUnknown = await seedUnknownUse(f, 9_000_002, side.episodeId)
    const preparedUse = await seedUse(contextDoc.target.unit, contextDoc.entries, 9_000_003, 'prepared')
    // 真·未引用旁支：无 basis 的独立条目 + 零条目消费，不得被影响面伪称已引用。
    const unreferencedText = '旁支第九集：红信封揭晓：甲是卧底。未来计划：乙明天去车站。'
    const unreferenced = await seedSource(f, 9, unreferencedText)
    const unrefStory = { ...sideStory, episodes: [...sideStory.episodes, unreferenced.episodeId],
      sources: [...sideStory.sources, unreferenced.pick], texts: [...sideStory.texts, unreferencedText] } as unknown as Story
    const unrefDoc = await storyDocument(unrefStory, 4)
    unrefDoc.basis = []
    const unrefEntry = await persistEntry(unrefDoc, 'confirmed')
    const unrefUse = await seedUse(unrefDoc.unit, [], 9_000_004, 'completed')

    // unknown 不重发：另一次冻结/生成在响应后被故障打断 → unknown；重入必须零 chat。
    const secondApproval = await freezePack(f, ef.io, manualTarget(f.episodes[2]!, 3, '第三集：再次尝试'))
    const unknownCtx = await makeStepContext(f, secondApproval)
    const faultFake = fakeIO(generated)
    faultFake.io.fault = point => { if (point === 'after_response') throw new Error('fault') }
    await assert.rejects(withContinuityIO(faultFake.io, () => aiText(unknownCtx)),
      (e: unknown) => e instanceof ContinuityError && e.code === 'continuity_outcome_unknown')
    assert.equal(faultFake.calls(), 1)
    const [unknownUse] = await useRowOf(f.projectId, unknownCtx.run.id, unknownCtx.step.id)
    assert.equal(unknownUse!.status, 'unknown')
    const retryFake = fakeIO(generated)
    await assert.rejects(withContinuityIO(retryFake.io, () => aiText(unknownCtx)),
      (e: unknown) => e instanceof ContinuityError && e.code === 'continuity_outcome_unknown')
    assert.equal(retryFake.calls(), 0, 'unknown 结果不得自动重发')

    // 影响面：实际消费/间接传播/缺证未知分列；未引用旁支与 prepared 证据都不算已使用。
    const impact = await getImpact(f.projectId, use!.id)
    assert.ok(impact.direct.some(r => r.kind === 'use' && r.recordId === use!.id && r.state === 'completed'))
    assert.ok(impact.direct.some(r => r.kind === 'entry' && r.recordId === e1.id && r.reason === 'entry_basis'))
    assert.ok(impact.direct.some(r => r.kind === 'entry' && r.recordId === e2.id && r.reason === 'entry_basis'))
    assert.ok(impact.indirect.some(r => r.kind === 'entry' && r.recordId === e3.id && r.state === 'confirmed'))
    assert.ok(impact.unknown.some(r => r.kind === 'use' && r.recordId === unknownUse!.id && r.reason === 'outcome_unknown'))
    assert.ok(impact.unknown.some(r => r.kind === 'use' && r.recordId === sideUnknown && r.reason === 'use_document_unavailable'),
      '缺证旁支进入 unknown，不能宣称确定没用过')
    for (const zone of [impact.direct, impact.indirect]) {
      assert.ok(!zone.some(r => r.recordId === sideUse), '未引用旁支不得被伪称已引用')
    }
    for (const zone of [impact.direct, impact.indirect, impact.unknown]) {
      assert.ok(!zone.some(r => r.recordId === unrefEntry.entryId), '无 basis 旁支条目不得进入影响面')
      assert.ok(!zone.some(r => r.recordId === unrefUse), '无引用旁支消费不得进入影响面')
      assert.ok(!zone.some(r => r.recordId === preparedUse), 'prepared 证据从未派发，不算已使用')
    }

    // 普通文本编辑 API 改第 1 集当前剧本（不触碰台账/步骤状态）。
    await updateAssetContent(f.sources[0]!.assetId, '重写第一集。甲受伤。钥匙归甲。观众知道甲是卧底。乙尚不知甲是卧底。红信封未开。')

    assert.equal(JSON.stringify(genFake.messages), sentBeforeEdit, '改源后已发送消息字节不变')
    assert.equal(genFake.calls(), 1, '改源不重发模型')
    assert.equal(replayFake.calls(), 0)
    assert.deepEqual((await readUse(use!)).messages, genFake.messages[0])

    const s1 = await evaluateEntry(e1.id, db), s2 = await evaluateEntry(e2.id, db), s3 = await evaluateEntry(e3.id, db)
    assert.equal(s1.validity, 'stale')
    assert.ok(s1.reasons.includes('continuity_source_changed'))
    assert.equal(s2.validity, 'stale')
    assert.ok(s2.reasons.includes('basis_invalid'))
    assert.equal(s3.validity, 'stale')

    // 旧批准不静默继续：重新预览把失效前集列为缺口，承接包为空。
    const after = await withContinuityIO(ef.io, () => previewContext(f.projectId, { target, includePlans: false }))
    assert.equal(after.doc.entries.length, 0)
    const gapKinds = after.doc.gaps.filter(g => g.unitOrdinal <= 2).map(g => g.kind).sort()
    assert.deepEqual(gapKinds, ['invalid_entry', 'invalid_entry'])
    // 影响面仍如实保留历史消费事实（不因失效而从"用过"变"没用过"）。
    const impactAfter = await getImpact(f.projectId, use!.id)
    assert.ok(impactAfter.direct.some(r => r.kind === 'entry' && r.recordId === e1.id && r.state === 'confirmed'))
    assert.ok(impactAfter.direct.some(r => r.kind === 'entry' && r.recordId === e2.id))
  })

  await t('13.1 未开启控制组：with_continuity=false 走普通路径，零连续性登记', async () => {
    const f = await seedStory()
    const template = loadTemplate('m70-fixture-episode')
    const [run] = await db.insert(pipelineRuns).values({ projectId: f.projectId, templateKey: template.key,
      templateSnapshot: JSON.stringify(template), input: JSON.stringify({ brief: '无连续性控制组', episode_number: 3, with_continuity: false }),
      status: 'running', createdAt: 1, updatedAt: 1 }).returning()
    const def = template.steps[0]!
    const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 1, stepKey: def.key, actionKey: def.action,
      title: def.title, status: 'running', createdAt: 1, updatedAt: 1 }).returning()
    const input = JSON.parse(run!.input) as Record<string, unknown>
    assert.equal(input['with_continuity'], false)
    assert.equal('continuity_context' in input, false)
    const ctx = await createStepContext({ run: run!, step: step!, template, def, input })
    const before = await countRecords(f.projectId)
    // 普通路径在隔离环境无供应商凭证 → 端点在 chat 前即失败；关键断言是它从未写连续性台账。
    await assert.rejects(async () => aiText(ctx), (e: unknown) => !(e instanceof ContinuityError))
    assert.equal(await countRecords(f.projectId), before)
    const [freshRun] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run!.id))
    assert.equal(freshRun!.status, 'running')
  })
}
