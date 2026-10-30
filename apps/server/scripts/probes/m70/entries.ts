import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type { Checker } from '../../probe-lib'
import type { EntryDoc, EntryView, ExtractRequest, Item, SourcePick } from '../../../src/services/continuity/contract'
import { initDatabase } from './bootstrap'
import { confirmation, extractAndReview, fakeIO, seedSource, seedStory, storyDocument } from './fixtures'
import { test } from './fold'

const empty = { content: JSON.stringify({ subjects: [], topics: [], items: [], warnings: [], noChanges: true }),
  usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 }, provider: 'fixture', model: 'fixture' }

export async function runEntries(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const { db } = await import('../../../src/db')
  const { and, eq } = await import('drizzle-orm')
  const { assets, contentVersions, contentContinuityRecords: records, projects, usageRecords } = await import('../../../src/db/schema')
  const { absPathOf, projectAbsDir, writeTextAsset } = await import('../../../src/services/storage')
  await t('continuity-json stores real JSON MIME and extension in a transaction', async () => {
    const f = await seedStory()
    await db.transaction(async ex => {
      const a = await writeTextAsset(f.projectId, { name: randomUUID(), purpose: 'continuity_entry', format: 'continuity-json', content: '{}' }, ex)
      assert.equal(a.mime, 'application/json'); assert.equal(a.ext, 'json')
      assert.equal(readFileSync(absPathOf(a.relPath!), 'utf8'), '{}')
    })
  })
  const { getEntry, listEntries, patchEntry, confirmEntry, reviewEntry } = await import('../../../src/services/continuity/entries')
  const { previewExtraction, extractEntry } = await import('../../../src/services/continuity/extract')
  const { withContinuityIO } = await import('../../../src/services/continuity/runtime')
  const { writeDocument, documentTransaction } = await import('../../../src/services/continuity/store')
  const { readContinuityVersion } = await import('../../../src/services/continuity/sources')
  const { ContinuityError, EntryViewSchema } = await import('../../../src/services/continuity/contract')
  const code = (status: number, name?: string) => (e: unknown) => e instanceof ContinuityError && e.status === status && (!name || e.code === name)
  const arow = async (id: number) => (await db.select().from(assets).where(eq(assets.id, id)))[0]!
  const row = async (id: number) => (await db.select().from(records).where(eq(records.id, id)))[0]!
  const rows = (pid: number) => db.select().from(records).where(eq(records.projectId, pid))
  const files = (pid: number) => readdirSync(projectAbsDir(pid), { recursive: true }).map(String).sort()
  const usage = (pid: number) => db.select().from(usageRecords).where(eq(usageRecords.projectId, pid))
  const req = async (f: Awaited<ReturnType<typeof seedStory>>, index = 0): Promise<ExtractRequest> => ({ source: f.sources[index]!,
    previewHash: (await previewExtraction(f.projectId, f.episodes[index]!, f.sources[index]!)).previewHash,
    operationKey: randomUUID(), allowModelCall: true, acceptUnpriced: true })
  const reqFor = async (f: Awaited<ReturnType<typeof seedStory>>, episodeId: number, pick: SourcePick): Promise<ExtractRequest> => ({ source: pick,
    previewHash: (await previewExtraction(f.projectId, episodeId, pick)).previewHash,
    operationKey: randomUUID(), allowModelCall: true, acceptUnpriced: true })
  const draft = async (f: Awaited<ReturnType<typeof seedStory>>) => extractEntry(f.projectId, f.episodes[0], await req(f))
  const docOf = (v: EntryView) => { assert.ok(v.doc && v.document); return structuredClone(v.doc) }
  const confirmed = async (f: Awaited<ReturnType<typeof seedStory>>, io: ReturnType<typeof fakeIO>['io'], index = 0) => {
    const v = await extractAndReview(f, index, io)
    return confirmEntry(f.projectId, v.id, confirmation(v, randomUUID()))
  }

  await t('preview is read-only; scoped fake configuration and complete source input reach one call', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await withContinuityIO(fake.io, async () => {
      const before = files(f.projectId), count = (await db.select().from(contentVersions)).length
      const p = await previewExtraction(f.projectId, f.episodes[0], f.sources[0])
      assert.equal(fake.calls(), 0); assert.deepEqual(files(f.projectId), before); assert.equal((await rows(f.projectId)).length, 0)
      assert.equal((await db.select().from(contentVersions)).length, count)
      assert.ok(!JSON.stringify(p).includes('fixture-only'))
      const request = await req(f), a = await extractEntry(f.projectId, f.episodes[0], request), b = await extractEntry(f.projectId, f.episodes[0], request)
      assert.equal(a.id, b.id); assert.equal(a.status, 'draft'); assert.equal(fake.calls(), 1); EntryViewSchema.parse(a)
      assert.ok(JSON.stringify(fake.messages[0]).includes(f.texts[0])); assert.equal((await usage(f.projectId)).length, 2)
      await assert.rejects(extractEntry(f.projectId, f.episodes[0], { ...request, acceptUnpriced: false }), code(409))
      assert.equal(fake.calls(), 1)
    })
  })
  await t('concurrent same extraction key publishes one placeholder and invokes chat once', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(r => { release = r }), started = new Promise<void>(r => { entered = r })
    const chat = fake.io.chat
    fake.io.chat = async (...args) => { const result = await chat(...args); entered(); await gate; return result }
    await withContinuityIO(fake.io, async () => {
      const request = await req(f), first = extractEntry(f.projectId, f.episodes[0], request)
      await started
      const second = await extractEntry(f.projectId, f.episodes[0], request)
      assert.equal(second.status, 'extracting'); assert.equal((await rows(f.projectId)).length, 1)
      release(); const a = await first
      assert.equal(a.id, second.id); assert.equal(fake.calls(), 1); assert.equal((await row(a.id)).status, 'draft')
    })
  })
  await t('budget, consent and stale preview reject before placeholder or chat', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await withContinuityIO(fake.io, async () => {
      const request = await req(f)
      await assert.rejects(extractEntry(f.projectId, f.episodes[0], { ...request, allowModelCall: false } as never), code(400))
      await assert.rejects(extractEntry(f.projectId, f.episodes[0], { ...request, acceptUnpriced: false }), code(409))
      fake.io.budget = async () => ({ code: 'budget_total_exceeded', message: 'synthetic budget' })
      await assert.rejects(extractEntry(f.projectId, f.episodes[0], request), (e: unknown) => (e as { code: string }).code === 'budget_total_exceeded')
      fake.io.budget = async () => null
      await assert.rejects(extractEntry(f.projectId, f.episodes[0], { ...request, previewHash: 'a'.repeat(64) }), code(409))
      assert.equal(fake.calls(), 0); assert.equal((await rows(f.projectId)).length, 0); assert.equal((await usage(f.projectId)).length, 0)
    })
  })
  await t('save keeps asset identity but changes work file/version; rollback restores exact files and pointers', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await withContinuityIO(fake.io, async () => {
      const v = await draft(f), doc = docOf(v), old = await arow(v.document!.assetId), beforeText = readFileSync(absPathOf(old.relPath!), 'utf8')
      doc.warnings = ['人工提示']
      const saved = await patchEntry(f.projectId, v.id, { expectedRevision: v.revision, doc })
      assert.equal(saved.document!.assetId, old.id); assert.notEqual(saved.document!.versionId, v.document!.versionId)
      const work = await arow(old.id); assert.notEqual(work.relPath, old.relPath)
      assert.equal(readFileSync(absPathOf(old.relPath!), 'utf8'), beforeText)
      assert.equal(await readContinuityVersion(db, f.projectId, v.document!), beforeText)
      assert.equal(work.runId, null); assert.equal(work.stepId, null)
      const before = files(f.projectId), dbBefore = await row(v.id), versions = (await db.select().from(contentVersions)).length
      fake.io.fault = p => { if (p === 'before_publish') throw new Error('synthetic disk failure') }
      await assert.rejects(patchEntry(f.projectId, saved.id, { expectedRevision: saved.revision, doc: { ...doc, warnings: ['rollback'] } }))
      assert.deepEqual(await row(v.id), dbBefore); assert.deepEqual(await arow(old.id), work); assert.deepEqual(files(f.projectId), before)
      assert.equal((await db.select().from(contentVersions)).length, versions)
      assert.equal(await readContinuityVersion(db, f.projectId, saved.document!), readFileSync(absPathOf(work.relPath!), 'utf8'))
    })
  })
  await t('first document rollback removes only own files; same-ex immutable version readable before commit', async () => {
    const f = await seedStory(), doc = await storyDocument(f), before = files(f.projectId), count = (await db.select().from(assets)).length
    await assert.rejects(documentTransaction(async ex => {
      const ref = await writeDocument(ex, doc.unit, 'entry', doc)
      assert.equal(JSON.parse(await readContinuityVersion(ex, f.projectId, ref)).unit.unitId, f.episodes[0])
      throw new Error('rollback')
    }), /rollback/)
    assert.deepEqual(files(f.projectId), before); assert.equal((await db.select().from(assets)).length, count)
  })
  await t('human edits are marked edited; new IDs are server assigned; source/unit cannot be patched', async () => {
    const f = await seedStory(), original = await storyDocument(f)
    const fake = fakeIO({ ...empty, content: JSON.stringify({ subjects: original.subjects, topics: original.topics, items: original.items, warnings: [], noChanges: false }) })
    await withContinuityIO(fake.io, async () => {
      const v = await draft(f), doc = docOf(v)
      assert.notEqual(doc.items[0]!.id, original.items[0]!.id)
      doc.items[0]!.value = '甲受伤（人工纠正）'; doc.items[0]!.editNote = '核对伤势'
      const saved = await patchEntry(f.projectId, v.id, { expectedRevision: v.revision, doc })
      assert.equal(saved.doc!.items[0]!.origin, 'edited'); assert.equal(saved.doc!.items[0]!.id, doc.items[0]!.id)
      const addition = docOf(saved); addition.items.push({ ...addition.items[0]!, id: 'client-forged-id', topicKey: 'new' })
      addition.topics.push({ key: 'new', label: 'new' })
      const added = await patchEntry(f.projectId, v.id, { expectedRevision: saved.revision, doc: addition })
      assert.notEqual(added.doc!.items.at(-1)!.id, 'client-forged-id'); assert.equal(added.doc!.items.at(-1)!.origin, 'manual')
      const changed = docOf(added); changed.source.templateKey = 'forged'
      await assert.rejects(patchEntry(f.projectId, v.id, { expectedRevision: added.revision, doc: changed }), code(409))
      const changedUnit = docOf(added); changedUnit.unit.unitOrdinal++
      await assert.rejects(patchEntry(f.projectId, v.id, { expectedRevision: added.revision, doc: changedUnit }), code(400))
      assert.equal(fake.calls(), 1)
    })
  })
  for (const head of [false, true]) await t(`different drafts compete on ${head ? 'existing' : 'null'} confirmed head: exactly one succeeds`, async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await withContinuityIO(fake.io, async () => {
      const old = head ? await confirmed(f, fake.io) : null
      const a = await extractAndReview(f, 0, fake.io), b = await extractAndReview(f, 0, fake.io)
      const ca = confirmation(a, randomUUID()), cb = confirmation(b, randomUUID())
      const result = await Promise.allSettled([confirmEntry(f.projectId, a.id, ca), confirmEntry(f.projectId, b.id, cb)])
      assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
      const loser = result.find(r => r.status === 'rejected') as PromiseRejectedResult
      assert.ok(code(409)(loser.reason))
      const current = (await rows(f.projectId)).filter(r => r.status === 'confirmed'); assert.equal(current.length, 1)
      if (old) { assert.equal((await row(old.id)).status, 'superseded'); assert.equal((await row(old.id)).replacedById, current[0]!.id) }
      const winner = result.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<EntryView>
      const prior = winner.value.id === a.id ? a : b, approval = winner.value.id === a.id ? ca : cb
      assert.deepEqual(winner.value.document, prior.document)
      assert.equal((await confirmEntry(f.projectId, prior.id, approval)).id, prior.id)
      await assert.rejects(confirmEntry(f.projectId, prior.id, { ...approval, acceptedWarnings: ['not reviewed'] }), code(409))
      await assert.rejects(patchEntry(f.projectId, prior.id, { expectedRevision: winner.value.revision, doc: docOf(prior) }), code(409))
    })
  })
  await t('review clone uses zero endpoint/chat and requires human confirmation; repeated key is stable', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await withContinuityIO(fake.io, async () => {
      const old = await confirmed(f, fake.io), calls = fake.calls()
      fake.io.endpoint = async () => { throw new Error('review must not resolve credentials') }
      const request = { parentId: old.id, source: f.sources[0], operationKey: randomUUID() }
      const v = await reviewEntry(f.projectId, f.episodes[0], request)
      assert.equal(v.status, 'draft'); assert.notEqual(v.id, old.id); assert.notEqual(v.document!.assetId, old.document!.assetId)
      assert.equal((await reviewEntry(f.projectId, f.episodes[0], request)).id, v.id)
      assert.equal((await row(old.id)).status, 'confirmed')
      assert.equal((await confirmEntry(f.projectId, v.id, confirmation(v, randomUUID()))).status, 'confirmed')
      assert.equal(fake.calls(), calls)
    })
  })
  for (const point of ['before_dispatch', 'after_response', 'before_publish', 'chat', 'usage'] as const) await t(`${point} failure preserves old confirmation and same key never pays again`, async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await withContinuityIO(fake.io, async () => {
      const old = await confirmed(f, fake.io), request = await req(f), calls = fake.calls(), before = files(f.projectId)
      if (point === 'chat') { const chat = fake.io.chat; fake.io.chat = async (...args) => { await chat(...args); throw new Error('credential must not leak') } }
      else if (point === 'usage') fake.io.usage = async () => { throw new Error('usage failure') }
      else fake.io.fault = p => { if (p === point) throw new Error('credential must not leak') }
      let op = 0
      await assert.rejects(extractEntry(f.projectId, f.episodes[0], request), (e: unknown) => {
        assert.ok(e instanceof ContinuityError); op = e.operationId!; assert.ok(op > 0); assert.ok(!e.message.includes('credential')); return true
      })
      const failed = await getEntry(f.projectId, op)
      assert.equal(failed.status, point === 'before_dispatch' ? 'failed' : 'unknown')
      assert.equal((await row(old.id)).status, 'confirmed'); assert.equal((await getEntry(f.projectId, old.id)).validity, 'valid')
      assert.deepEqual(files(f.projectId), before)
      const replay = await extractEntry(f.projectId, f.episodes[0], request)
      assert.equal(replay.id, op); assert.equal(replay.status, failed.status)
      assert.equal(fake.calls(), calls + (point === 'before_dispatch' ? 0 : 1))
    })
  })
  await t('invalid JSON and forged evidence fail with known response usage, never repair-call', async () => {
    for (const variant of ['json', 'quote', 'unaware'] as const) {
      const f = await seedStory(), doc = await storyDocument(f)
      if (variant === 'quote') doc.items[0]!.evidence[0]!.quote = '甲没伤'
      if (variant === 'unaware') doc.items.find(i => i.channel === 'knowledge' && i.epistemic === 'unaware')!.evidence = []
      const fake = fakeIO({ ...empty, content: variant === 'json' ? '{bad' : JSON.stringify({ subjects: doc.subjects, topics: doc.topics, items: doc.items, warnings: [], noChanges: false }) })
      await withContinuityIO(fake.io, async () => {
        const request = await req(f)
        await assert.rejects(extractEntry(f.projectId, f.episodes[0], request), code(400))
        const [r] = await rows(f.projectId); assert.equal(r!.status, 'failed'); assert.equal(r!.documentAssetId, null)
        assert.equal((await usage(f.projectId)).length, 2)
        assert.equal((await extractEntry(f.projectId, f.episodes[0], request)).id, r!.id); assert.equal(fake.calls(), 1)
      })
    }
  })
  await t('drift during extraction keeps readable stale draft but cannot confirm', async () => {
    const f = await seedStory(), fake = fakeIO(empty), source = await arow(f.sources[0].assetId)
    const chat = fake.io.chat
    fake.io.chat = async (...args) => { const result = await chat(...args); writeFileSync(absPathOf(source.relPath!), 'new source'); return result }
    await withContinuityIO(fake.io, async () => {
      const v = await draft(f); assert.equal(v.status, 'draft'); assert.equal(v.validity, 'stale')
      await assert.rejects(confirmEntry(f.projectId, v.id, confirmation(v, randomUUID())), code(409))
      assert.equal(fake.calls(), 1); assert.equal((await row(v.id)).status, 'draft')
    })
  })
  await t('project deletion and cross-project lookups are guarded, not resurrected', async () => {
    const f = await seedStory(), other = await seedStory(), fake = fakeIO(empty)
    await withContinuityIO(fake.io, async () => {
      const v = await draft(f)
      await assert.rejects(getEntry(other.projectId, v.id), code(404))
      await db.update(projects).set({ deletedAt: 1 }).where(eq(projects.id, f.projectId))
      await assert.rejects(patchEntry(f.projectId, v.id, { expectedRevision: v.revision, doc: docOf(v) }), code(404))
      await assert.rejects(confirmEntry(f.projectId, v.id, confirmation(v, randomUUID())), code(404))
      assert.equal((await row(v.id)).status, 'draft'); assert.equal(fake.calls(), 1)
    })
  })
  await t('full three-episode flow depends on approved versions, never direct record seeding', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await withContinuityIO(fake.io, async () => {
      const one = await confirmed(f, fake.io), two = await confirmed(f, fake.io, 1), three = await confirmed(f, fake.io, 2)
      assert.equal(two.doc!.basis.length, 1); assert.equal(three.doc!.basis.length, 2)
      assert.equal(three.doc!.basis[0]!.entryId, one.id); assert.equal(three.doc!.basis[1]!.entryId, two.id)
      assert.equal((await listEntries(f.projectId, f.episodes[2])).length, 1); assert.equal(fake.calls(), 3)
      assert.equal((await getEntry(f.projectId, three.id)).validity, 'valid')
      assert.equal((await db.select().from(records).where(and(eq(records.projectId, f.projectId), eq(records.status, 'confirmed')))).length, 3)
    })
  })

  // ---- service-level size boundaries: 1000 value / 200 items / 120000 source / 160000 input / 200000 document ----
  await t('value 1000 is accepted and 1001 rejected without a new version', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await withContinuityIO(fake.io, async () => {
      const v = await draft(f), doc = docOf(v)
      const item = (value: string): Item => ({ id: 'v1', topicKey: 't', channel: 'fact', type: 'state', operation: 'set',
        subjects: ['a'], value, previous: null, evidence: [], origin: 'manual', editNote: '人工核对', included: true })
      doc.items = [item('x'.repeat(1000))]
      doc.topics = [{ key: 't', label: 't' }]
      doc.subjects = [{ key: 'a', label: 'a', entityId: null, aliases: [] }]
      doc.noChanges = false
      const saved = await patchEntry(f.projectId, v.id, { expectedRevision: v.revision, doc })
      assert.equal(saved.doc!.items[0]!.value.length, 1000)
      const before = await row(v.id), versions = (await db.select().from(contentVersions)).length
      await assert.rejects(patchEntry(f.projectId, v.id, { expectedRevision: saved.revision, doc: { ...doc, items: [item('x'.repeat(1001))] } }), code(400))
      assert.deepEqual(await row(v.id), before); assert.equal((await db.select().from(contentVersions)).length, versions)
      assert.equal(fake.calls(), 1)
    })
  })
  await t('item list 200 and document 200000 bounds are both enforced on patch', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    await withContinuityIO(fake.io, async () => {
      const v = await draft(f), doc = docOf(v)
      doc.topics = Array.from({ length: 201 }, (_, n) => ({ key: `t${n}`, label: `t${n}` }))
      doc.subjects = [{ key: 'a', label: 'a', entityId: null, aliases: [] }]
      doc.noChanges = false
      const item = (n: number, size: number): Item => ({ id: `b${n}`, topicKey: `t${n}`, channel: 'fact', type: 'state',
        operation: 'set', subjects: ['a'], value: 'x'.repeat(size), previous: null, evidence: [], origin: 'manual', editNote: '人工', included: true })
      doc.items = Array.from({ length: 200 }, (_, n) => item(n, 700))
      const saved = await patchEntry(f.projectId, v.id, { expectedRevision: v.revision, doc })
      assert.equal(saved.doc!.items.length, 200)
      const versions = (await db.select().from(contentVersions)).length
      const overDoc = { ...doc, items: Array.from({ length: 200 }, (_, n) => item(n, 1000)) }
      assert.ok(JSON.stringify(overDoc).length > 200_000)
      await assert.rejects(patchEntry(f.projectId, v.id, { expectedRevision: saved.revision, doc: overDoc }),
        (e: unknown) => e instanceof ContinuityError && e.status === 413 && e.code === 'continuity_context_too_large')
      await assert.rejects(patchEntry(f.projectId, v.id, { expectedRevision: saved.revision, doc: { ...doc, items: [...doc.items, item(200, 1)] } }), code(400))
      assert.equal((await getEntry(f.projectId, v.id)).revision, saved.revision)
      assert.equal((await db.select().from(contentVersions)).length, versions)
      assert.equal(fake.calls(), 1)
    })
  })
  await t('source 120000 extracts once; 120001 rejects before preview, calls or rows', async () => {
    const f = await seedStory(), fake = fakeIO(empty)
    const edge = await seedSource(f, 4, 'x'.repeat(120_000)), beyond = await seedSource(f, 5, 'x'.repeat(120_001))
    await withContinuityIO(fake.io, async () => {
      const ok = await extractEntry(f.projectId, edge.episodeId, await reqFor(f, edge.episodeId, edge.pick))
      assert.equal(ok.status, 'draft'); assert.equal(fake.calls(), 1); EntryViewSchema.parse(ok)
      await assert.rejects(previewExtraction(f.projectId, beyond.episodeId, beyond.pick), code(413))
      await assert.rejects(extractEntry(f.projectId, beyond.episodeId, { source: beyond.pick, previewHash: 'a'.repeat(64),
        operationKey: randomUUID(), allowModelCall: true, acceptUnpriced: true }), code(413))
      assert.equal(fake.calls(), 1)
      assert.equal((await rows(f.projectId)).filter(r => r.unitId === beyond.episodeId).length, 0)
      assert.equal((await usage(f.projectId)).length, 2)
    })
  })
  await t('input beyond 160000 rejects without a call; the same basis stays under the bound', async () => {
    const f = await seedStory()
    const big = await seedSource(f, 4, 'x'.repeat(120_000))
    const items = Array.from({ length: 20 }, (_, n) => ({ id: `i${n}`, topicKey: `t${n}`, channel: 'fact' as const, type: 'state' as const,
      operation: 'set' as const, subjects: ['a'], value: 'x'.repeat(1000), previous: null,
      evidence: [{ start: 0, end: 1000, quote: 'x'.repeat(1000) }], origin: 'extracted' as const, editNote: '', included: true }))
    const heavy = fakeIO({ ...empty, content: JSON.stringify({ subjects: [{ key: 'a', label: 'a', entityId: null, aliases: [] }],
      topics: items.map((_, n) => ({ key: `t${n}`, label: `t${n}` })), items, warnings: [], noChanges: false }) })
    await withContinuityIO(heavy.io, async () => {
      const head = await extractEntry(f.projectId, big.episodeId, await reqFor(f, big.episodeId, big.pick))
      assert.equal(head.status, 'draft')
      assert.equal((await confirmEntry(f.projectId, head.id, confirmation(head, randomUUID()))).status, 'confirmed')
      assert.equal(heavy.calls(), 1)
    })
    // A distinct scoped fake for the boundary phase; the heavy response must not leak into other episodes.
    const plain = fakeIO(empty)
    await withContinuityIO(plain.io, async () => {
      const over = await seedSource(f, 5, 'x'.repeat(120_000)), under = await seedSource(f, 6, 'x'.repeat(500))
      await assert.rejects(previewExtraction(f.projectId, over.episodeId, over.pick), code(413))
      await assert.rejects(extractEntry(f.projectId, over.episodeId, { source: over.pick, previewHash: 'a'.repeat(64),
        operationKey: randomUUID(), allowModelCall: true, acceptUnpriced: true }), code(413))
      assert.equal(plain.calls(), 0)
      assert.equal((await rows(f.projectId)).filter(r => r.unitId === over.episodeId).length, 0)
      const ok = await extractEntry(f.projectId, under.episodeId, await reqFor(f, under.episodeId, under.pick))
      assert.equal(ok.status, 'draft'); assert.equal(ok.doc!.basis.length, 1); assert.equal(plain.calls(), 1)
      assert.ok((await previewExtraction(f.projectId, under.episodeId, under.pick)).inputChars < 160_000)
      assert.equal((await usage(f.projectId)).length, 4)
    })
  })
  await t('model document beyond 200000 fails unpublished while a near-bound document drafts', async () => {
    const f = await seedStory(), source = await seedSource(f, 4, 'x'.repeat(120_000))
    const item = (n: number, size: number) => ({ id: `i${n}`, topicKey: `t${n}`, channel: 'fact' as const, type: 'state' as const,
      operation: 'set' as const, subjects: ['a'], value: 'x'.repeat(size), previous: null,
      evidence: [{ start: 0, end: size, quote: 'x'.repeat(size) }], origin: 'extracted' as const, editNote: '', included: true })
    const subjects = [{ key: 'a', label: 'a', entityId: null, aliases: [] }]
    const over = fakeIO({ ...empty, content: JSON.stringify({ subjects, topics: [{ key: 't0', label: 't0' }],
      items: [item(0, 1000)], warnings: ['w'.repeat(200_000)], noChanges: false }) })
    const near = fakeIO({ ...empty, content: JSON.stringify({ subjects, topics: Array.from({ length: 150 }, (_, n) => ({ key: `t${n}`, label: `t${n}` })),
      items: Array.from({ length: 150 }, (_, n) => item(n, 500)), warnings: [], noChanges: false }) })
    await withContinuityIO(over.io, async () => {
      await assert.rejects(extractEntry(f.projectId, source.episodeId, await reqFor(f, source.episodeId, source.pick)),
        (e: unknown) => e instanceof ContinuityError && e.status === 413 && e.code === 'continuity_context_too_large')
      const [r] = await rows(f.projectId); assert.equal(r!.status, 'failed'); assert.equal(r!.documentAssetId, null)
      assert.equal((await usage(f.projectId)).length, 2); assert.equal(over.calls(), 1)
    })
    await withContinuityIO(near.io, async () => {
      const ok = await extractEntry(f.projectId, source.episodeId, await reqFor(f, source.episodeId, source.pick))
      assert.equal(ok.status, 'draft'); assert.equal(ok.doc!.items.length, 150); assert.ok(ok.document); assert.equal(near.calls(), 1)
    })
  })
}
