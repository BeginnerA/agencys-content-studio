import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, type Checker } from '../../probe-lib'
import type { EntryDoc, EntryRef, FreezeRequest, Item, Preview, PreviewRequest, SourcePick, TargetRequest } from '../../../src/services/continuity/contract'
import { withContinuityIO } from '../../../src/services/continuity/runtime'
import { initDatabase, temporaryRoot } from './bootstrap'
import { confirmation, confirmEpisode, extractAndReview, fakeIO, installTargetFixture, seedResumeRun, seedSource, seedStory, seedUnknownUse } from './fixtures'
import { hash, reference, test } from './fold'

const empty = { content: JSON.stringify({ subjects: [], topics: [], items: [], warnings: [], noChanges: true }),
  usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 }, provider: 'fixture', model: 'fixture' }

const manual = (episodeId: number, episodeNumber: number, brief: string, extra: Record<string, unknown> = {}): TargetRequest =>
  ({ kind: 'manual', episodeId, templateKey: 'm70-fixture-episode', input: { episode_number: episodeNumber, brief, with_continuity: true, ...extra } })

const freezeOf = (req: PreviewRequest, previewHash: string, acceptedGaps: FreezeRequest['acceptedGaps'], operationKey: string,
  extra: Partial<FreezeRequest> = {}): FreezeRequest =>
  ({ target: req.target, includePlans: req.includePlans, previewHash, acceptedGaps, operationKey, ...extra })

const acceptAll = (p: Preview): FreezeRequest['acceptedGaps'] =>
  p.doc.gaps.map(g => ({ key: g.key, fingerprint: g.fingerprint, reason: '已核对该缺口' }))

// ---- pure renderer fixtures (fold-probe reference/hash reuse); foldEntries revalidates every doc ----
const item = (id: string, topicKey: string, value: string, extra: Partial<Item> = {}): Item =>
  ({ id, topicKey, channel: 'fact', type: 'state', operation: 'set', subjects: ['a'], value, previous: null,
    evidence: [], origin: 'manual', editNote: '探针构造', included: true, ...extra }) as Item

const rdoc = (n: number, items: Item[]): { ref: EntryRef; doc: EntryDoc } => {
  const unit = { projectId: 1, scopeKind: 'series' as const, scopeId: 1, unitKind: 'episode' as const, unitId: n, unitOrdinal: n }
  return { ref: reference(n), doc: { schemaVersion: 1, unit,
    source: { ...unit, runId: n, stepId: n, assetId: n, versionId: n, templateKey: 'm70-fixture-episode', templateSnapshotHash: hash,
      stepKey: 'write_script', hash, outputHash: hash, gateHash: hash, fingerprint: hash, history: 'known', inheritedViaRunId: null },
    basis: n > 1 ? [reference(n - 1)] : [], history: 'known',
    subjects: [{ key: 'a', label: '甲', entityId: null, aliases: [] }, { key: 'b', label: '乙', entityId: null, aliases: [] },
      { key: 'audience', label: '观众', entityId: null, aliases: [] }],
    topics: [...new Set(items.map(i => i.topicKey))].map(key => ({ key, label: key })),
    items, warnings: [], noChanges: false, releasedBasis: [] } }
}

const sectionOf = (text: string, title: string): string => text.split('【').find(s => s.startsWith(title)) ?? ''

export async function runContext(checker: Checker) {
  installTargetFixture()
  await initDatabase()
  // Direct preview/freeze calls below share this fake endpoint: configHash stays deterministic without env providers.
  await withContinuityIO(fakeIO(empty).io, () => runContextBody(checker))
}

async function runContextBody(checker: Checker) {
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { and, eq } = await import('drizzle-orm')
  const { assets, contentVersions, contentContinuityRecords: records } = await import('../../../src/db/schema')
  const { absPathOf } = await import('../../../src/services/storage')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { previewContext, freezeContext, readContext } = await import('../../../src/services/continuity/context')
  const { renderContinuity } = await import('../../../src/services/continuity/render')
  const { ContinuityError } = await import('../../../src/services/continuity/contract')
  const { withContinuityIO } = await import('../../../src/services/continuity/runtime')
  const { previewExtraction, extractEntry } = await import('../../../src/services/continuity/extract')
  const { confirmEntry } = await import('../../../src/services/continuity/entries')
  const code = (status: number, name?: string) => (e: unknown) =>
    e instanceof ContinuityError && e.status === status && (!name || e.code === name)
  const counts = async () => ({ assets: (await db.select().from(assets)).length,
    versions: (await db.select().from(contentVersions)).length, records: (await db.select().from(records)).length })
  // Test-only manipulation: removes a confirmed registration to form a missing ledger row.
  const dropConfirmed = async (projectId: number, ordinal: number) => {
    await db.delete(records).where(and(eq(records.projectId, projectId), eq(records.rowType, 'entry'),
      eq(records.status, 'confirmed'), eq(records.unitOrdinal, ordinal)))
  }
  const preview = (projectId: number, req: PreviewRequest) => previewContext(projectId, req)
  const extract = async (projectId: number, episodeId: number, pick: { source: Parameters<typeof extractEntry>[2]['source'] }) => {
    const pv = await previewExtraction(projectId, episodeId, pick.source)
    return extractEntry(projectId, episodeId, { source: pick.source, previewHash: pv.previewHash,
      operationKey: randomUUID(), allowModelCall: true, acceptUnpriced: true })
  }

  await t('target fixtures land only in the temporary workspace and pass the template loader', () => {
    for (const key of ['m70-fixture-episode', 'm70-fixture-small', 'm70-fixture-noin', 'm70-fixture-dup']) {
      assert.ok(existsSync(join(temporaryRoot, 'workspace/templates', `${key}.yaml`)), key)
      assert.ok(!existsSync(join(REPO_ROOT, 'workspace/templates', `${key}.yaml`)), `real workspace keeps no ${key}`)
      assert.equal(loadTemplate(key).steps[0]!.params!['continuity_role'], 'episode_script')
    }
  })

  await t('preview is read-only and packs prior confirmed valid entries with a rendered hash', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await confirmEpisode(f, 0, fake.io)
    await confirmEpisode(f, 1, fake.io)
    const before = await counts()
    const req: PreviewRequest = { target: manual(f.episodes[2]!, 3, '继续寻找红信封'), includePlans: false }
    const p = await preview(f.projectId, req)
    assert.deepEqual(await counts(), before)
    assert.ok(p.doc.entries.every(e => e.unitOrdinal < 3))
    assert.deepEqual(p.doc.entries.map(e => e.unitOrdinal), [1, 2])
    assert.equal(p.doc.includePlans, false)
    assert.equal(p.doc.renderedHash, createHash('sha256').update(p.doc.rendered).digest('hex'))
    assert.ok(p.doc.rendered.includes('甲受伤'))
    assert.ok(p.doc.rendered.includes('钥匙交乙'))
    assert.ok(!p.doc.rendered.includes('钥匙归甲'))
    assert.ok(sectionOf(p.doc.rendered, '观众认知').includes('观众知道甲是卧底'))
    assert.ok(!sectionOf(p.doc.rendered, '人物认知').includes('观众知道甲是卧底'))
    assert.ok(!p.doc.rendered.includes('乙尚不知甲是卧底'))
    assert.ok(sectionOf(p.doc.rendered, '伏笔').includes('红信封未开'))
    assert.ok(!p.doc.rendered.includes('未来计划'))
    assert.deepEqual(p.doc.gaps, [])
    assert.deepEqual(p.doc.acceptedGaps, [])
    assert.deepEqual(p.blockers, [])
    assert.ok(p.canFreeze)
    assert.equal(p.maxChars, 24_000)
    assert.equal(p.chars, p.doc.rendered.length)
    assert.equal(p.doc.previewHash.length, 64)
    assert.ok(!JSON.stringify(p).includes('fixture-only'))
  })

  await t('unconfirmed drafts and future plan items never enter the pack; preview is deterministic', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await confirmEpisode(f, 0, fake.io)
    await confirmEpisode(f, 1, fake.io)
    const req: PreviewRequest = { target: manual(f.episodes[2]!, 3, '继续寻找红信封'), includePlans: false }
    const first = await preview(f.projectId, req)
    const draft = await extractAndReview(f, 2, fake.io)
    const second = await preview(f.projectId, req)
    assert.deepEqual(second.doc.entries.map(e => e.unitOrdinal), [1, 2])
    assert.equal(second.doc.previewHash, first.doc.previewHash)
    assert.ok(!second.doc.rendered.includes('车站'))
    assert.ok(!second.doc.rendered.includes('揭晓'))
    assert.ok((await db.select().from(records)).some(r => r.id === draft.id && r.status === 'draft'))
  })

  await t('deleted registration becomes a missing_entry gap; stale facts are excluded as invalid', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await confirmEpisode(f, 0, fake.io)
    await confirmEpisode(f, 1, fake.io)
    await dropConfirmed(f.projectId, 2)
    const p = await preview(f.projectId, { target: manual(f.episodes[2]!, 3, '继续寻找红信封'), includePlans: false })
    assert.deepEqual(p.doc.gaps.map(g => [g.key, g.kind, g.entryId]), [['ep:2', 'missing_entry', null]])
    assert.deepEqual(p.doc.entries.map(e => e.unitOrdinal), [1])
    const g = await seedStory(), fake2 = fakeIO(empty)
    await confirmEpisode(g, 0, fake2.io)
    await confirmEpisode(g, 1, fake2.io)
    const asset = (await db.select().from(assets).where(eq(assets.id, g.sources[0]!.assetId)))[0]!
    writeFileSync(absPathOf(asset.relPath!), '漂移后的正文')
    const stale = await preview(g.projectId, { target: manual(g.episodes[2]!, 3, '继续寻找红信封'), includePlans: false })
    assert.deepEqual(stale.doc.entries, [])
    assert.deepEqual(stale.doc.gaps.map(x => [x.unitOrdinal, x.kind, x.entryId !== null]),
      [[1, 'invalid_entry', true], [2, 'invalid_entry', true]])
    assert.ok(!stale.doc.rendered.includes('钥匙交乙'))
  })

  await t('history_unavailable is a separately accepted gap and nonexistent ordinals are still listed', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    const fourth = await seedSource(f, 4, '第4集正文。', { snapshot: false })
    const seventh = await seedSource(f, 7, '第7集正文。')
    await withContinuityIO(fake.io, async () => {
      const v4 = await extract(f.projectId, fourth.episodeId, { source: fourth.pick })
      const done = await confirmEntry(f.projectId, v4.id, confirmation(v4, randomUUID()))
      assert.equal(done.status, 'confirmed')
    })
    const p = await preview(f.projectId, { target: manual(seventh.episodeId, 7, '第7集简报'), includePlans: false })
    assert.deepEqual(p.doc.entries.map(e => e.unitOrdinal), [4])
    assert.deepEqual(p.doc.gaps.map(g => [g.unitOrdinal, g.kind]), [
      [1, 'missing_entry'], [2, 'missing_entry'], [3, 'missing_entry'],
      [4, 'history_unavailable'], [5, 'missing_entry'], [6, 'missing_entry']])
    const unavailable = p.doc.gaps.find(g => g.kind === 'history_unavailable')!
    assert.equal(unavailable.entryId, p.doc.entries[0]!.entryId)
    assert.notEqual(unavailable.fingerprint, p.doc.gaps.find(g => g.kind === 'missing_entry')!.fingerprint)
  })

  await t('gap acceptance must match the expected set exactly and old acceptances cannot approve a changed pack', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await confirmEpisode(f, 0, fake.io)
    await confirmEpisode(f, 1, fake.io)
    await dropConfirmed(f.projectId, 2)
    const req: PreviewRequest = { target: manual(f.episodes[2]!, 3, '继续寻找红信封'), includePlans: false }
    const p = await preview(f.projectId, req)
    const gap = p.doc.gaps[0]!
    const accept = [{ key: gap.key, fingerprint: gap.fingerprint, reason: '第2集登记缺失，剧情已知' }]
    await assert.rejects(freezeContext(f.projectId, freezeOf(req, p.doc.previewHash, [], randomUUID())),
      code(409, 'continuity_gaps_unaccepted'))
    await assert.rejects(freezeContext(f.projectId, freezeOf(req, p.doc.previewHash,
      [{ key: gap.key, fingerprint: 'b'.repeat(64), reason: '指纹不符' }], randomUUID())),
      code(409, 'continuity_gaps_unaccepted'))
    await assert.rejects(freezeContext(f.projectId, freezeOf(req, p.doc.previewHash, [accept[0]!, accept[0]!], randomUUID())),
      code(409, 'continuity_gaps_unaccepted'))
    await assert.rejects(freezeContext(f.projectId, freezeOf(req, p.doc.previewHash,
      [{ key: gap.key, fingerprint: gap.fingerprint, reason: '   ' }], randomUUID())), code(400))
    const approval = await freezeContext(f.projectId, freezeOf(req, p.doc.previewHash, accept, randomUUID()))
    assert.ok(approval.contextId > 0)
    const redraft = await extractAndReview(f, 1, fake.io)
    await confirmEntry(f.projectId, redraft.id, confirmation(redraft, randomUUID()))
    const p2 = await preview(f.projectId, req)
    assert.deepEqual(p2.doc.gaps, [])
    await assert.rejects(freezeContext(f.projectId, freezeOf(req, p.doc.previewHash, accept, randomUUID())),
      code(409, 'continuity_context_changed'))
    await assert.rejects(freezeContext(f.projectId, freezeOf(req, p2.doc.previewHash, accept, randomUUID())),
      code(409, 'continuity_gaps_unaccepted'))
  })

  await t('freeze is idempotent, body immutable, and the approval handle is not a bearer token', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await confirmEpisode(f, 0, fake.io)
    const req: PreviewRequest = { target: manual(f.episodes[1]!, 2, '第二集简报'), includePlans: false }
    const p = await preview(f.projectId, req)
    assert.deepEqual(p.doc.gaps, [])
    const request = freezeOf(req, p.doc.previewHash, [], randomUUID())
    const a1 = await freezeContext(f.projectId, request)
    assert.deepEqual(await freezeContext(f.projectId, request), a1)
    await assert.rejects(freezeContext(f.projectId, { ...request, previewHash: 'c'.repeat(64) }), code(409, 'continuity_conflict'))
    const doc = await readContext(f.projectId, a1, db)
    assert.deepEqual(await readContext(f.projectId, a1, db), doc)
    assert.equal(doc.previewHash, p.doc.previewHash)
    assert.deepEqual(doc.acceptedGaps, [])
    assert.equal(doc.renderedHash, createHash('sha256').update(doc.rendered).digest('hex'))
    await confirmEpisode(f, 1, fake.io)
    assert.deepEqual(await readContext(f.projectId, a1, db), doc)
    await assert.rejects(readContext(f.projectId, { ...a1, approvalHash: 'd'.repeat(64) }, db), code(409))
    await assert.rejects(readContext(f.projectId, { ...a1, document: { ...a1.document, versionId: a1.document.versionId + 1 } }, db), code(409))
    const other = await seedStory()
    await assert.rejects(readContext(other.projectId, a1, db), code(404))
    const fresh = await preview(f.projectId, req)
    assert.deepEqual(fresh.doc.acceptedGaps, [])
  })

  await t('24000 hard cap, template-lowered cap and 160000 enabled-input bound all block freezing', async () => {
    const fact = (n: number, size: number, letter: string) => ({ id: `i${n}`, topicKey: `t${n}`, channel: 'fact' as const,
      type: 'state' as const, operation: 'set' as const, subjects: ['a'], value: letter.repeat(size), previous: null,
      evidence: [{ start: n * size, end: (n + 1) * size, quote: letter.repeat(size) }], origin: 'extracted' as const,
      editNote: '', included: true })
    const subject = { key: 'a', label: 'a', entityId: null, aliases: [] }
    const confirmWith = async (story: Awaited<ReturnType<typeof seedStory>>, seed: { pick: SourcePick; episodeId: number },
      response: ReturnType<typeof fakeIO>) => {
      await withContinuityIO(response.io, async () => {
        const v = await extract(story.projectId, seed.episodeId, { source: seed.pick })
        assert.equal(v.status, 'draft')
        await confirmEntry(story.projectId, v.id, confirmation(v, randomUUID()))
        assert.equal(response.calls(), 1)
      })
    }
    const f = await seedStory()
    const heavy = Array.from({ length: 30 }, (_, n) => fact(n, 1000, 'x'))
    const heavyFake = fakeIO({ ...empty, content: JSON.stringify({ subjects: [subject],
      topics: heavy.map((_, n) => ({ key: `t${n}`, label: `t${n}` })), items: heavy, warnings: [], noChanges: false }) })
    const big = await seedSource(f, 4, 'x'.repeat(120_000)), next = await seedSource(f, 5, '第5集正文。')
    await confirmWith(f, big, heavyFake)
    await assert.rejects(preview(f.projectId, { target: manual(next.episodeId, 5, '第5集简报'), includePlans: false }),
      code(413, 'continuity_context_too_large'))

    const g = await seedStory()
    const mid = Array.from({ length: 5 }, (_, n) => fact(n, 500, 'y'))
    const midFake = fakeIO({ ...empty, content: JSON.stringify({ subjects: [subject],
      topics: mid.map((_, n) => ({ key: `t${n}`, label: `t${n}` })), items: mid, warnings: [], noChanges: false }) })
    const midSource = await seedSource(g, 4, 'y'.repeat(120_000)), fifth = await seedSource(g, 5, '第5集正文。')
    await confirmWith(g, midSource, midFake)
    const defaultReq: PreviewRequest = { target: manual(fifth.episodeId, 5, '第5集简报'), includePlans: false }
    const fits = await preview(g.projectId, defaultReq)
    assert.equal(fits.maxChars, 24_000)
    assert.ok(fits.chars > 2000)
    assert.ok(fits.canFreeze)
    const smallReq: PreviewRequest = { target: { kind: 'manual', episodeId: fifth.episodeId, templateKey: 'm70-fixture-small',
      input: { episode_number: 5, brief: '第5集简报', with_continuity: true } }, includePlans: false }
    const low = await preview(g.projectId, smallReq)
    assert.equal(low.maxChars, 2000)
    assert.deepEqual(low.blockers, ['continuity_context_too_large'])
    assert.ok(!low.canFreeze)
    await assert.rejects(freezeContext(g.projectId, freezeOf(smallReq, low.doc.previewHash, acceptAll(low), randomUUID())), code(413))

    const h = await seedStory(), hFake = fakeIO(empty)
    await confirmEpisode(h, 0, hFake.io)
    const fitsInput = await preview(h.projectId, { target: manual(h.episodes[1]!, 2, 'b'.repeat(100_000)), includePlans: false })
    assert.ok(fitsInput.canFreeze)
    const overInput = await preview(h.projectId, { target: manual(h.episodes[1]!, 2, 'c'.repeat(165_000)), includePlans: false })
    assert.deepEqual(overInput.blockers, ['continuity_context_too_large'])
    assert.ok(!overInput.canFreeze)
    await assert.rejects(freezeContext(h.projectId,
      freezeOf({ target: manual(h.episodes[1]!, 2, 'c'.repeat(165_000)), includePlans: false }, overInput.doc.previewHash,
        acceptAll(overInput), randomUUID())), code(413))
    const tweaked = await preview(h.projectId, { target: manual(h.episodes[1]!, 2, 'b'.repeat(100_000) + '!'), includePlans: false })
    assert.notEqual(tweaked.doc.previewHash, fitsInput.doc.previewHash)
  })

  await t('new confirmation, changed input/episode/template/model config or source drift all invalidate the preview', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await confirmEpisode(f, 0, fake.io)
    await confirmEpisode(f, 1, fake.io)
    const req: PreviewRequest = { target: manual(f.episodes[2]!, 3, '继续寻找红信封'), includePlans: false }
    const p = await preview(f.projectId, req)
    const attempt = (target: PreviewRequest['target']) =>
      freezeContext(f.projectId, freezeOf({ target, includePlans: req.includePlans }, p.doc.previewHash, acceptAll(p), randomUUID()))
    const redraft = await extractAndReview(f, 1, fake.io)
    await confirmEntry(f.projectId, redraft.id, confirmation(redraft, randomUUID()))
    await assert.rejects(attempt(req.target), code(409, 'continuity_context_changed'))
    await assert.rejects(attempt(manual(f.episodes[2]!, 3, '换一个简报')), code(409, 'continuity_context_changed'))
    await assert.rejects(attempt(manual(f.episodes[1]!, 2, '继续寻找红信封')), code(409, 'continuity_context_changed'))
    await assert.rejects(attempt({ ...req.target, kind: 'manual', templateKey: 'm70-fixture-small' } as TargetRequest),
      code(409, 'continuity_context_changed'))
    const other = fakeIO(empty)
    other.io.endpoint = async () => ({ baseUrl: 'https://m70.invalid/v1', apiKey: 'fixture-only', providerKey: 'fixture', model: 'other-model' })
    await assert.rejects(withContinuityIO(other.io, () => freezeContext(f.projectId,
      freezeOf(req, p.doc.previewHash, acceptAll(p), randomUUID()))), code(409, 'continuity_context_changed'))
    const asset = (await db.select().from(assets).where(eq(assets.id, f.sources[1]!.assetId)))[0]!
    writeFileSync(absPathOf(asset.relPath!), '漂移后的第二集正文')
    await assert.rejects(attempt(req.target), code(409, 'continuity_context_changed'))
  })

  await t('episode 1 yields an explicit empty pack that freezes and reads back', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    const req: PreviewRequest = { target: manual(f.episodes[0]!, 1, '第一集简报'), includePlans: false }
    const p = await preview(f.projectId, req)
    assert.deepEqual(p.doc.entries, [])
    assert.deepEqual(p.doc.dependencies, [])
    assert.deepEqual(p.doc.gaps, [])
    assert.ok(p.doc.rendered.length > 0)
    assert.ok(p.canFreeze)
    const approval = await freezeContext(f.projectId, freezeOf(req, p.doc.previewHash, [], randomUUID()))
    const doc = await readContext(f.projectId, approval, db)
    assert.deepEqual(doc.entries, [])
    assert.equal(doc.includePlans, false)
    assert.equal(doc.renderedHash, createHash('sha256').update(doc.rendered).digest('hex'))
  })

  await t('plan section stays off by default and renders only when explicitly included', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await confirmEpisode(f, 0, fake.io)
    await confirmEpisode(f, 1, fake.io)
    await confirmEpisode(f, 2, fake.io)
    const fifth = await seedSource(f, 5, '第5集正文。')
    const off: PreviewRequest = { target: manual(fifth.episodeId, 5, '第5集简报'), includePlans: false }
    const onReq: PreviewRequest = { target: manual(fifth.episodeId, 5, '第5集简报'), includePlans: true }
    const offPack = await preview(f.projectId, off)
    assert.equal(offPack.doc.includePlans, false)
    assert.ok(offPack.doc.entries.some(e => e.unitOrdinal === 3))
    assert.ok(!offPack.doc.rendered.includes('乙明天去车站'))
    assert.ok(!offPack.doc.rendered.includes('编剧计划'))
    const onPack = await preview(f.projectId, onReq)
    assert.equal(onPack.doc.includePlans, true)
    assert.ok(sectionOf(onPack.doc.rendered, '编剧计划').includes('乙明天去车站'))
    assert.notEqual(onPack.doc.previewHash, offPack.doc.previewHash)
    const approval = await freezeContext(f.projectId, freezeOf(onReq, onPack.doc.previewHash, acceptAll(onPack), randomUUID()))
    const doc = await readContext(f.projectId, approval, db)
    assert.equal(doc.includePlans, true)
    assert.ok(doc.rendered.includes('乙明天去车站'))
    assert.deepEqual(doc.acceptedGaps.map(a => a.key), ['ep:4'])
  })

  await t('resume targets resolve from the original snapshot and share input/config identity with manual', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await confirmEpisode(f, 0, fake.io)
    await confirmEpisode(f, 1, fake.io)
    const runId = await seedResumeRun(f, 3, { episode_number: 3, brief: '续写第三集', with_continuity: false })
    const resumeReq: PreviewRequest = { target: { kind: 'resume', runId }, includePlans: false }
    const p = await preview(f.projectId, resumeReq)
    assert.equal(p.doc.target.request.kind, 'resume')
    assert.equal(p.doc.target.templateKey, 'm70-fixture-episode')
    assert.equal(p.doc.target.stepKey, 'write_script')
    const manualReq: PreviewRequest = { target: manual(f.episodes[2]!, 3, '续写第三集'), includePlans: false }
    const m = await preview(f.projectId, manualReq)
    assert.equal(p.doc.target.inputHash, m.doc.target.inputHash)
    assert.equal(p.doc.target.configHash, m.doc.target.configHash)
    assert.notEqual(p.doc.previewHash, m.doc.previewHash)
    const approval = await freezeContext(f.projectId, freezeOf(resumeReq, p.doc.previewHash, [], randomUUID()))
    assert.equal((await readContext(f.projectId, approval, db)).target.request.kind, 'resume')
    await assert.rejects(preview(f.projectId, { target: { kind: 'resume', runId: 4_999_999 }, includePlans: false }), code(404))
    const noSnapshot = await seedResumeRun(f, 3, { episode_number: 3, brief: '续写第三集' }, { snapshot: false })
    await assert.rejects(preview(f.projectId, { target: { kind: 'resume', runId: noSnapshot }, includePlans: false }),
      code(400, 'continuity_unsupported'))
    // mengbao v19 wires its target step now; a snapshot without a non-batch target step stays unsupported.
    const noRole = await seedResumeRun(f, 3, { episode_number: 3, brief: '续写第三集' }, { template: 'm70-fixture-batchrole' })
    await assert.rejects(preview(f.projectId, { target: { kind: 'resume', runId: noRole }, includePlans: false }),
      code(400, 'continuity_unsupported'))
  })

  await t('duplicate cost acceptance is exact, resume-only and hashed into the approval', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await confirmEpisode(f, 0, fake.io)
    await confirmEpisode(f, 1, fake.io)
    const runId = await seedResumeRun(f, 3, { episode_number: 3, brief: '续写第三集' })
    const resumeReq: PreviewRequest = { target: { kind: 'resume', runId }, includePlans: false }
    const before = await preview(f.projectId, resumeReq)
    assert.equal(before.unknownUseId, null)
    const useId = await seedUnknownUse(f, runId, f.episodes[2]!)
    const p = await preview(f.projectId, resumeReq)
    assert.equal(p.unknownUseId, useId)
    assert.notEqual(p.doc.previewHash, before.doc.previewHash)
    assert.equal((await preview(f.projectId, resumeReq)).doc.previewHash, p.doc.previewHash)
    await assert.rejects(freezeContext(f.projectId, freezeOf(resumeReq, p.doc.previewHash, [], randomUUID())), code(409))
    await assert.rejects(freezeContext(f.projectId,
      freezeOf(resumeReq, p.doc.previewHash, [], randomUUID(), { duplicateCostAcceptance: { useId: useId + 999, accepted: true } })), code(409))
    const approval = await freezeContext(f.projectId,
      freezeOf(resumeReq, p.doc.previewHash, [], randomUUID(), { duplicateCostAcceptance: { useId, accepted: true } }))
    assert.deepEqual((await readContext(f.projectId, approval, db)).duplicateCostAcceptance, { useId, accepted: true })
    const manualReq: PreviewRequest = { target: manual(f.episodes[2]!, 3, '续写第三集'), includePlans: false }
    const mp = await preview(f.projectId, manualReq)
    await assert.rejects(freezeContext(f.projectId,
      freezeOf(manualReq, mp.doc.previewHash, [], randomUUID(), { duplicateCostAcceptance: { useId, accepted: true } })),
      code(400, 'continuity_unsupported'))
    const ok = await freezeContext(f.projectId, freezeOf(manualReq, mp.doc.previewHash, [], randomUUID()))
    assert.deepEqual((await readContext(f.projectId, ok, db)).duplicateCostAcceptance, null)
  })

  await t('route targets resolve via会话定位 (M70 Task 8: missing session → 404); workflow targets resolve via定位 (M70 Task 7: unknown chain → 404)', async () => {
    const f = await seedStory()
    // M70 Task 8 起 route 目标经 route-bridge 实际定位解析：会话不存在/跨项目 → continuity_source_invalid 404
    // （原 Task 7 的「route 一律 unsupported」已被接线取代；会话 id 取现存最大值 +1 保证必然不存在，两种运行方式下都确定）。
    const { db } = await import('../../../src/db')
    const { creationSessions } = await import('../../../src/db/schema')
    const { max } = await import('drizzle-orm')
    const missingSessionId = ((await db.select({ m: max(creationSessions.id) }).from(creationSessions))[0]?.m ?? 0) + 1
    await assert.rejects(preview(f.projectId,
      { target: { kind: 'route', sessionId: missingSessionId, decisionRevision: 1, decisionHash: hash }, includePlans: false }),
      code(404, 'continuity_source_invalid'))
    // Task 7 起 workflow 目标经 workflow-bridge 实际定位解析：链不存在/跨项目 → continuity_source_invalid 404。
    await assert.rejects(preview(f.projectId,
      { target: { kind: 'workflow', workflowId: 1, nextSeq: 2, previousRunId: null }, includePlans: false }),
      code(404, 'continuity_source_invalid'))
  })

  await t('configHash sanitizes credentials and URL user info while covering model identity', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await confirmEpisode(f, 0, fake.io)
    const req: PreviewRequest = { target: manual(f.episodes[1]!, 2, '第二集简报'), includePlans: false }
    const a = await preview(f.projectId, req)
    const leak = fakeIO(empty)
    leak.io.endpoint = async () => ({ baseUrl: 'https://user:secret@m70.invalid/v1?token=abc', apiKey: 'another-key', providerKey: 'fixture', model: 'fixture' })
    const b = await withContinuityIO(leak.io, () => previewContext(f.projectId, req))
    assert.equal(a.doc.target.configHash, b.doc.target.configHash)
    assert.equal(a.doc.previewHash, b.doc.previewHash)
    const dumped = JSON.stringify(b)
    assert.ok(!dumped.includes('another-key') && !dumped.includes('user:secret') && !dumped.includes('token=abc'))
    const other = fakeIO(empty)
    other.io.endpoint = async () => ({ baseUrl: 'https://m70.invalid/v1', apiKey: 'fixture-only', providerKey: 'fixture', model: 'other-model' })
    const c = await withContinuityIO(other.io, () => previewContext(f.projectId, req))
    assert.notEqual(c.doc.target.configHash, a.doc.target.configHash)
    const paramsReq: PreviewRequest = { target: manual(f.episodes[1]!, 2, '第二集简报', { _params: { llm: { temperature: 0.1 } } }), includePlans: false }
    const d = await preview(f.projectId, paramsReq)
    assert.notEqual(d.doc.target.configHash, a.doc.target.configHash)
    assert.notEqual(d.doc.target.inputHash, a.doc.target.inputHash)
  })

  await t('manual targets require declared brief/episode_number inputs and one non-batch episode_script step', async () => {
    const f = await seedStory()
    const episodeId = f.episodes[2]!
    const asPreview = (templateKey: string, input: Record<string, unknown>): PreviewRequest =>
      ({ target: { kind: 'manual', episodeId, templateKey, input } as TargetRequest, includePlans: false })
    // mengbao v19 is a wired target; the role+batch fixture is the non-batch-step rejection case.
    await assert.rejects(preview(f.projectId, asPreview('m70-fixture-batchrole', { episode_number: 3, brief: '简报' })),
      code(400, 'continuity_unsupported'))
    await assert.rejects(preview(f.projectId, asPreview('m70-fixture-noin', { episode_number: 3, brief: '简报' })),
      code(400, 'continuity_unsupported'))
    await assert.rejects(preview(f.projectId, asPreview('m70-fixture-dup', { episode_number: 3, brief: '简报' })),
      code(400, 'continuity_unsupported'))
    await assert.rejects(preview(f.projectId, asPreview('m70-fixture-episode', { episode_number: 2, brief: '简报' })),
      code(400, 'continuity_source_invalid'))
    await assert.rejects(preview(f.projectId, asPreview('m70-fixture-episode', { episode_number: 3 })), code(400, 'continuity_source_invalid'))
    await assert.rejects(preview(f.projectId, asPreview('no-such-template', { episode_number: 3, brief: '简报' })), code(404))
  })

  await t('renderer keeps five isolated sections with provenance and never rolls back retracts', () => {
    const e1 = rdoc(1, [
      item('f1', 'key.owner', '钥匙在甲手中'),
      item('k1', 'secret', '乙知道钥匙在甲手中', { channel: 'knowledge', knower: 'b', epistemic: 'knows' }),
      item('k2', 'secret', '观众知道甲是卧底', { channel: 'knowledge', knower: 'audience', epistemic: 'knows' }),
      item('t1', 'envelope', '红信封未开', { type: 'thread' }),
    ])
    const e2 = rdoc(2, [
      item('f2', 'key.owner', '钥匙交乙', { previous: { ...reference(1), itemId: 'f1' } }),
      item('k3', 'secret', '乙怀疑甲是卧底', { channel: 'knowledge', knower: 'b', epistemic: 'believes', previous: { ...reference(1), itemId: 'k1' } }),
      item('t2', 'envelope', '红信封已回收', { type: 'thread', operation: 'close', previous: { ...reference(1), itemId: 't1' } }),
    ])
    const e3 = rdoc(3, [item('r1', 'key.owner', '撤回钥匙归属', { operation: 'retract', previous: { ...reference(2), itemId: 'f2' } })])
    const packed = [e1, e2, e3]
    const off = renderContinuity(packed, false)
    for (const head of ['事实', '人物认知', '观众认知', '伏笔']) assert.ok(sectionOf(off, head).length > 0, head)
    assert.ok(!off.includes('编剧计划'))
    for (const gone of ['钥匙在甲手中', '钥匙交乙', '撤回钥匙归属', '红信封未开', '乙知道钥匙在甲手中']) assert.ok(!off.includes(gone), gone)
    assert.ok(sectionOf(off, '事实').length === 0 || !sectionOf(off, '事实').includes('钥匙'))
    assert.ok(sectionOf(off, '人物认知').includes('乙怀疑甲是卧底'))
    assert.ok(!sectionOf(off, '人物认知').includes('观众知道甲是卧底'))
    assert.ok(sectionOf(off, '观众认知').includes('观众知道甲是卧底'))
    assert.ok(sectionOf(off, '伏笔').includes('红信封已回收（已回收）'))
    assert.ok(off.includes('entry:2 item:k3'))
    assert.ok(!off.includes('item:f2') && !off.includes('item:f1'))
    const on = renderContinuity(packed, true)
    assert.ok(sectionOf(on, '编剧计划').length > 0)
    assert.notEqual(on, off)
    assert.ok(renderContinuity([], true).includes('编剧计划'))
    assert.ok(renderContinuity([], false).includes('（无）'))
  })
}
