import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Checker } from '../../probe-lib'
import type { SourcePick } from '../../../src/services/continuity/contract'
import { initDatabase } from './bootstrap'
import { persistEntry, seedStory, storyDocument } from './fixtures'
import { test } from './fold'

export async function runSources(checker: Checker) {
  await initDatabase()
  const { db } = await import('../../../src/db')
  const { and, eq } = await import('drizzle-orm')
  const { assets, characters, contentVersions, contentContinuityRecords: records, episodes, execSnapshots, pipelineRuns, pipelineSteps, projects, series } = await import('../../../src/db/schema')
  const { absPathOf, writeTextAsset } = await import('../../../src/services/storage')
  const { recordAssetTextVersion } = await import('../../../src/services/provenance')
  const { ContinuityError, SourceSchema, SourceCandidateSchema, validateEntryEvidence } = await import('../../../src/services/continuity/contract')
  const { resolveUnit, validateSubjects } = await import('../../../src/services/continuity/scope')
  const { listSources, captureSource, readSource, readContinuityVersion, assertCurrentSource } = await import('../../../src/services/continuity/sources')
  const { evaluateEntry } = await import('../../../src/services/continuity/validity')
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
  const code = (status: number, want = 'continuity_source_invalid') => (e: unknown) => e instanceof ContinuityError && e.status === status && e.code === want && e.message === want
  const assetOf = async (id: number) => (await db.select().from(assets).where(eq(assets.id, id)))[0]!
  const versionOf = async (id: number) => (await db.select().from(contentVersions).where(eq(contentVersions.id, id)))[0]!
  const raw = (pick: SourcePick, text: string) => ({ runId: pick.runId, stepId: pick.stepId, assetId: pick.assetId, seenHash: hash(text) })
  const count = async () => (await db.select().from(contentVersions)).length
  const changeOutput = (pick: SourcePick, output: object) => db.update(pipelineSteps).set({ output: JSON.stringify(output) }).where(eq(pipelineSteps.id, pick.stepId))

  await t('scope resolves real series/episode, rejects wrong project and deleted project', async () => {
    const a = await seedStory(), b = await seedStory()
    assert.deepEqual(await resolveUnit(a.projectId, a.episodes[0], db), { projectId: a.projectId, scopeKind: 'series', scopeId: a.seriesId, unitKind: 'episode', unitId: a.episodes[0], unitOrdinal: 1 })
    await assert.rejects(resolveUnit(b.projectId, a.episodes[0], db), code(404))
    await assert.rejects(resolveUnit(a.projectId, 0, db), code(400))
    await db.update(projects).set({ deletedAt: 1 }).where(eq(projects.id, a.projectId))
    await assert.rejects(resolveUnit(a.projectId, a.episodes[0], db), code(404))
  })
  await t('scope rejects series reassigned to another project', async () => {
    const a = await seedStory(), b = await seedStory()
    await db.update(series).set({ projectId: b.projectId }).where(eq(series.id, a.seriesId))
    await assert.rejects(resolveUnit(a.projectId, a.episodes[0], db), code(404))
  })
  await t('GET lists precise write_script and same-purpose review without writing versions', async () => {
    const s = await seedStory(), before = await count()
    const candidates = await listSources(s.projectId, s.episodes[0])
    assert.equal(candidates.length, 2)
    candidates.forEach(c => SourceCandidateSchema.parse(c))
    const script = candidates.find(c => c.stepKey === 'write_script')!, review = candidates.find(c => c.stepKey === 'script_review')!
    assert.equal(script.assetId, s.sources[0].assetId); assert.equal(script.confirmable, true); assert.equal(script.declaredRole, true)
    assert.equal(review.declaredRole, false); assert.ok(review.reasons.includes('undeclared_role'))
    assert.notEqual(script.title, review.title)
    assert.equal(script.versionId, s.sources[0].versionId)
    assert.equal(await count(), before)
  })
  await t('GET leaves uncaptured version null; only explicit seenHash snapshot captures one baseline', async () => {
    const s = await seedStory(), pick = s.sources[0]
    await db.delete(contentVersions).where(eq(contentVersions.id, pick.versionId))
    const before = await count()
    const candidate = (await listSources(s.projectId, s.episodes[0])).find(c => c.assetId === pick.assetId)!
    assert.equal(candidate.versionId, null); assert.deepEqual(candidate.versions, []); assert.equal(candidate.confirmable, false)
    assert.equal(await count(), before)
    await assert.rejects(captureSource(s.projectId, s.episodes[0], raw(pick, 'wrong')), code(409, 'continuity_source_changed'))
    assert.equal(await count(), before)
    const source = await captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0]))
    SourceSchema.parse(source); assert.equal(source.hash, hash(s.texts[0])); assert.ok(source.versionId > 0)
    assert.equal(await count(), before + 1)
    assert.equal((await captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0]))).versionId, source.versionId)
    assert.equal(await count(), before + 1)
  })
  await t('snapshot raw is strict, no omitted seenHash or version masquerading as baseline', async () => {
    const s = await seedStory()
    for (const value of [s.sources[0], { ...raw(s.sources[0], s.texts[0]), extra: true }, { ...raw(s.sources[0], s.texts[0]), seenHash: 'bad' }]) {
      await assert.rejects(captureSource(s.projectId, s.episodes[0], value), code(400))
    }
  })
  await t('source rejects wrong project, episode, run, step and version ownership', async () => {
    const a = await seedStory(), b = await seedStory(), pick = a.sources[0]
    for (const [projectId, episodeId, selection] of [
      [b.projectId, a.episodes[0], pick], [a.projectId, a.episodes[1], pick],
      [a.projectId, a.episodes[0], { ...pick, stepId: a.sources[1].stepId }],
      [a.projectId, a.episodes[0], { ...pick, runId: b.sources[0].runId }],
      [a.projectId, a.episodes[0], { ...pick, versionId: b.sources[0].versionId }],
    ] as [number, number, SourcePick][]) await assert.rejects(readSource(projectId, episodeId, selection, db), code(404))
  })
  await t('history reads selected immutable bytes, but cannot confirm after a registered edit', async () => {
    const s = await seedStory(), pick = s.sources[0], asset = await assetOf(pick.assetId)
    const old = (await readSource(s.projectId, s.episodes[0], pick, db)).source
    const content = s.texts[0] + '改稿。'
    writeFileSync(absPathOf(asset.relPath!), content)
    const v = await recordAssetTextVersion({ asset, content, source: 'edit' })
    assert.equal((await readSource(s.projectId, s.episodes[0], pick, db)).text, s.texts[0])
    await assert.rejects(assertCurrentSource(old, db), code(409, 'continuity_source_changed'))
    const candidate = (await listSources(s.projectId, s.episodes[0])).find(c => c.assetId === pick.assetId)!
    assert.equal(candidate.versionId, v.id); assert.equal(candidate.versions.length, 2)
    const current = (await readSource(s.projectId, s.episodes[0], { ...pick, versionId: v.id }, db)).source
    await assertCurrentSource(current, db)
  })
  await t('unregistered byte drift cannot be disguised by an existing baseline', async () => {
    const s = await seedStory(), pick = s.sources[0], asset = await assetOf(pick.assetId), content = '未登记改稿'
    writeFileSync(absPathOf(asset.relPath!), content)
    const before = await count()
    await assert.rejects(captureSource(s.projectId, s.episodes[0], raw(pick, content)), code(409, 'continuity_source_changed'))
    assert.equal(await count(), before)
    assert.equal((await listSources(s.projectId, s.episodes[0])).find(c => c.assetId === pick.assetId)!.confirmable, false)
  })
  for (const decision of ['skip', 'reject', null]) await t(`gate ${decision} is not current approval`, async () => {
    const s = await seedStory(), pick = s.sources[0]
    await changeOutput(pick, { asset_ids: [pick.assetId], gate: decision ? { decision, at: 1 } : null })
    assert.equal((await listSources(s.projectId, s.episodes[0])).find(c => c.assetId === pick.assetId)!.confirmable, false)
    await assert.rejects(captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0])), code(409))
  })
  for (const status of ['skipped', 'failed', 'waiting_input']) await t(`step ${status} is not a succeeded source`, async () => {
    const s = await seedStory(), pick = s.sources[0]
    await db.update(pipelineSteps).set({ status }).where(eq(pipelineSteps.id, pick.stepId))
    await assert.rejects(captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0])), code(409))
  })
  for (const [templateKey, stepKey] of [['legacy-ungated', 'write_script'], ['mengbao-episode', 'legacy_script']]) {
    await t(`explicit ungated ${templateKey}/${stepKey} without history is not presumed gated`, async () => {
      const s = await seedStory(), pick = s.sources[0]
      await db.update(pipelineRuns).set({ templateKey, templateSnapshot: null }).where(eq(pipelineRuns.id, pick.runId))
      await db.update(pipelineSteps).set({ stepKey }).where(eq(pipelineSteps.id, pick.stepId))
      await changeOutput(pick, { asset_ids: [pick.assetId] })
      const doc = await storyDocument(s), entry = await persistEntry(doc)
      const state = await evaluateEntry(entry.entryId, db)
      assert.equal(state.validity, 'valid'); assert.equal(state.history, 'history_unavailable')
      assert.ok(state.reasons.includes('history_unavailable'))
      const candidate = (await listSources(s.projectId, s.episodes[0])).find(c => c.assetId === pick.assetId)!
      assert.equal(candidate.confirmable, true); assert.equal(candidate.declaredRole, false)
      assert.ok(candidate.reasons.includes('undeclared_role')); assert.ok(candidate.reasons.includes('history_unavailable'))
      assert.ok(!candidate.reasons.includes('gate_not_approved'))
      const source = await captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0]))
      assert.equal(source.history, 'history_unavailable'); await assertCurrentSource(source, db)
      const [step] = await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, pick.stepId))
      assert.equal(JSON.parse(step!.output!).gate, undefined, 'selection must not invent approval')
    })
  }
  for (const knownGate of ['definition', 'historical-mapping']) await t(`${knownGate} still requires approval when output has no gate`, async () => {
    const s = await seedStory(), pick = s.sources[0]
    if (knownGate === 'definition') {
      const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, pick.runId))
      const template = JSON.parse(run!.templateSnapshot!)
      template.key = 'legacy-gated'
      assert.equal(template.steps.find((step: { key: string }) => step.key === 'write_script').gate.mode, 'required')
      await db.update(pipelineRuns).set({ templateKey: template.key, templateSnapshot: JSON.stringify(template) }).where(eq(pipelineRuns.id, pick.runId))
    } else await db.update(pipelineRuns).set({ templateSnapshot: null }).where(eq(pipelineRuns.id, pick.runId))
    await changeOutput(pick, { asset_ids: [pick.assetId] })
    const doc = await storyDocument(s), entry = await persistEntry(doc)
    assert.equal((await evaluateEntry(entry.entryId, db)).validity, 'stale')
    await assert.rejects(assertCurrentSource(doc.source, db), code(409))
    await assert.rejects(captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0])), code(409))
    const candidate = (await listSources(s.projectId, s.episodes[0])).find(c => c.assetId === pick.assetId)!
    assert.equal(candidate.confirmable, false); assert.ok(candidate.reasons.includes('gate_not_approved'))
  })
  for (const decision of ['approve', 'skip', 'reject', null]) await t(`actual legacy gate ${decision} without template retains approval checks`, async () => {
    const s = await seedStory(), pick = s.sources[0]
    await db.update(pipelineRuns).set({ templateKey: 'legacy-ungated', templateSnapshot: null }).where(eq(pipelineRuns.id, pick.runId))
    await changeOutput(pick, { asset_ids: [pick.assetId], gate: decision ? { decision, at: 1 } : {} })
    const doc = await storyDocument(s), entry = await persistEntry(doc)
    const state = await evaluateEntry(entry.entryId, db)
    assert.equal(state.validity, decision === 'approve' ? 'valid' : 'stale')
    assert.equal(state.history, 'history_unavailable')
    if (decision === 'approve') await captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0]))
    else {
      await assert.rejects(assertCurrentSource(doc.source, db), code(409))
      await assert.rejects(captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0])), code(409))
    }
  })
  await t('output set and gate document are fingerprinted, not only asset bytes', async () => {
    const s = await seedStory(), pick = s.sources[0], original = (await readSource(s.projectId, s.episodes[0], pick, db)).source
    await changeOutput(pick, { asset_ids: [pick.assetId, s.sources[1].assetId], gate: { decision: 'approve', at: 1 } })
    await assert.rejects(assertCurrentSource(original, db), code(409, 'continuity_source_changed'))
    const extra = (await readSource(s.projectId, s.episodes[0], pick, db)).source
    assert.notEqual(extra.outputHash, original.outputHash)
    await changeOutput(pick, { asset_ids: [pick.assetId], gate: { decision: 'approve', at: 2 } })
    await assert.rejects(assertCurrentSource(original, db), code(409, 'continuity_source_changed'))
    assert.notEqual((await readSource(s.projectId, s.episodes[0], pick, db)).source.gateHash, original.gateHash)
  })
  await t('version reader uses project/object/kind/hash and actual file, never JSON or current bytes', async () => {
    const s = await seedStory(), pick = s.sources[0], ref = { assetId: pick.assetId, versionId: pick.versionId, hash: hash(s.texts[0]) }
    assert.equal(await readContinuityVersion(db, s.projectId, ref), s.texts[0])
    await assert.rejects(readContinuityVersion(db, s.projectId, { ...ref, assetId: s.sources[1].assetId }), code(404))
    await assert.rejects(readContinuityVersion(db, s.projectId, { ...ref, hash: hash('other') }), code(409, 'continuity_source_changed'))
    const v = await versionOf(ref.versionId)
    writeFileSync(absPathOf(v.relPath!), 'corrupt version')
    await assert.rejects(readContinuityVersion(db, s.projectId, ref), code(409, 'continuity_source_changed'))
    unlinkSync(absPathOf(v.relPath!))
    await assert.rejects(readContinuityVersion(db, s.projectId, ref), code(404))
    await db.update(contentVersions).set({ objKind: 'entity' }).where(eq(contentVersions.id, ref.versionId))
    await assert.rejects(readContinuityVersion(db, s.projectId, ref), code(404))
  })
  await t('readVersion and resolveUnit observe uncommitted rows through the supplied executor', async () => {
    const s = await seedStory(), rollback = new Error('synthetic rollback')
    let versionId = 0
    await assert.rejects(db.transaction(async tx => {
      const [episode] = await tx.insert(episodes).values({ projectId: s.projectId, seriesId: s.seriesId, number: 4, createdAt: 1, updatedAt: 1 }).returning()
      assert.equal((await resolveUnit(s.projectId, episode!.id, tx)).unitOrdinal, 4)
      const asset = await writeTextAsset(s.projectId, { name: `${randomUUID()}.md`, purpose: 'script', content: '同事务文本' }, tx)
      const v = await recordAssetTextVersion({ asset, content: '同事务文本', source: 'baseline', executor: tx }); versionId = v.id
      assert.equal(await readContinuityVersion(tx, s.projectId, { assetId: asset.id, versionId: v.id, hash: v.sha256! }), '同事务文本')
      throw rollback
    }), e => e === rollback)
    assert.equal(await versionOf(versionId), undefined)
  })
  await t('source limits UTF-16 text without truncating evidence', async () => {
    const s = await seedStory(), asset = await assetOf(s.sources[0].assetId), text = '甲'.repeat(120_001)
    writeFileSync(absPathOf(asset.relPath!), text)
    await assert.rejects(captureSource(s.projectId, s.episodes[0], raw(s.sources[0], text)), code(413, 'continuity_context_too_large'))
    const doc = await storyDocument(s)
    validateEntryEvidence(doc, s.texts[0]); assert.equal(doc.items[0]!.evidence[0]!.start, s.texts[0].indexOf('甲受伤'))
  })
  await t('entity subjects require this exact project, not foreign or global entity IDs', async () => {
    const a = await seedStory(), b = await seedStory()
    const entities = await db.insert(characters).values([a.projectId, b.projectId, null].map(projectId => ({ projectId, name: '甲', createdAt: 1, updatedAt: 1 }))).returning()
    const subject = { key: 'a', label: '甲', aliases: [], entityId: entities[0]!.id }
    await validateSubjects(a.projectId, [subject, { ...subject, key: 'b', entityId: null }], db)
    for (const entityId of [entities[1]!.id, entities[2]!.id, 987654321]) await assert.rejects(validateSubjects(a.projectId, [{ ...subject, entityId }], db), code(404))
  })

  async function inherit(s: Awaited<ReturnType<typeof seedStory>>, pick: SourcePick): Promise<SourcePick> {
    const run = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, pick.runId)))[0]!
    const step = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, pick.stepId)))[0]!
    const [r] = await db.insert(pipelineRuns).values({ projectId: s.projectId, templateKey: run.templateKey, templateSnapshot: run.templateSnapshot,
      input: run.input, resumedFromRunId: run.id, status: 'failed', createdAt: 2, updatedAt: 2 }).returning()
    const [st] = await db.insert(pipelineSteps).values({ runId: r!.id, stepKey: step.stepKey, actionKey: step.actionKey, seq: 1,
      title: step.title, status: step.status, output: step.output, createdAt: 2, updatedAt: 2 }).returning()
    return { ...pick, runId: r!.id, stepId: st!.id }
  }
  await t('multi-hop resume follows original generation, not latestRun; missing original stays missing', async () => {
    const s = await seedStory(), pick = s.sources[0], first = await inherit(s, pick), next = await inherit(s, first)
    await db.update(episodes).set({ latestRunId: next.runId }).where(eq(episodes.id, s.episodes[0]))
    const { source } = await readSource(s.projectId, s.episodes[0], next, db)
    assert.equal(source.runId, pick.runId); assert.equal(source.stepId, pick.stepId); assert.equal(source.inheritedViaRunId, next.runId)
    assert.equal(source.history, 'known'); await assertCurrentSource(source, db)
    const inherited = (await listSources(s.projectId, s.episodes[0])).find(c => c.inheritedViaRunId === next.runId)!
    assert.equal(inherited.runId, pick.runId); assert.equal(inherited.stepId, pick.stepId)
    await db.delete(pipelineRuns).where(eq(pipelineRuns.id, pick.runId))
    await assert.rejects(readSource(s.projectId, s.episodes[0], next, db), code(404))
  })
  await t('unrelated asset/run and cyclic resume chain cannot masquerade as inheritance', async () => {
    const s = await seedStory(), pick = s.sources[0], next = await inherit(s, pick)
    await db.update(pipelineRuns).set({ resumedFromRunId: next.runId }).where(eq(pipelineRuns.id, next.runId))
    await assert.rejects(readSource(s.projectId, s.episodes[0], next, db), code(409))
    await db.update(pipelineRuns).set({ resumedFromRunId: null }).where(eq(pipelineRuns.id, next.runId))
    await assert.rejects(readSource(s.projectId, s.episodes[0], next, db), code(404))
  })
  for (const absent of ['execution', 'template']) await t(`missing ${absent} snapshot before first selection is history_unavailable, not stale`, async () => {
    const s = await seedStory(), pick = s.sources[0]
    if (absent === 'execution') await db.delete(execSnapshots).where(eq(execSnapshots.stepId, pick.stepId))
    else await db.update(pipelineRuns).set({ templateSnapshot: null }).where(eq(pipelineRuns.id, pick.runId))
    const source = await captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0]))
    assert.equal(source.history, 'history_unavailable')
    const doc = await storyDocument(s), ref = await persistEntry(doc)
    assert.equal(doc.history, 'history_unavailable'); await assertCurrentSource(doc.source, db)
    const result = await evaluateEntry(ref.entryId, db)
    assert.equal(result.validity, 'valid'); assert.equal(result.history, 'history_unavailable')
    assert.ok(result.reasons.includes('history_unavailable'))
  })
  await t('R13 losing only execution history after confirmation stays valid with a warning', async () => {
    const s = await seedStory(), pick = s.sources[0], doc = await storyDocument(s), entry = await persistEntry(doc)
    const dependent = await persistEntry(await storyDocument(s, 1, [entry]))
    assert.equal(doc.history, 'known'); assert.equal((await evaluateEntry(entry.entryId, db)).validity, 'valid')
    await db.delete(execSnapshots).where(eq(execSnapshots.stepId, pick.stepId))
    const selected = await readSource(s.projectId, s.episodes[0], pick, db)
    assert.equal(selected.source.fingerprint, doc.source.fingerprint)
    await assertCurrentSource(doc.source, db)
    for (const ref of [entry, dependent]) {
      const state = await evaluateEntry(ref.entryId, db)
      assert.equal(state.validity, 'valid'); assert.equal(state.history, 'history_unavailable')
      assert.ok(state.reasons.includes('history_unavailable'))
    }
  })
  for (const drift of ['loss', 'change']) await t(`R13 known template ${drift} after confirmation remains stale`, async () => {
    const s = await seedStory(), pick = s.sources[0], doc = await storyDocument(s), entry = await persistEntry(doc)
    const dependent = await persistEntry(await storyDocument(s, 1, [entry]))
    assert.equal(doc.history, 'known'); assert.equal((await evaluateEntry(entry.entryId, db)).validity, 'valid')
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, pick.runId))
    const template = JSON.parse(run!.templateSnapshot!)
    template.description = 'synthetic changed template history'
    await db.update(pipelineRuns).set({ templateSnapshot: drift === 'loss' ? null : JSON.stringify(template) }).where(eq(pipelineRuns.id, pick.runId))
    const selected = await readSource(s.projectId, s.episodes[0], pick, db)
    assert.equal(selected.text, s.texts[0]); assert.equal(selected.source.gateHash, doc.source.gateHash)
    assert.equal(selected.source.outputHash, doc.source.outputHash)
    assert.notEqual(selected.source.templateSnapshotHash, doc.source.templateSnapshotHash)
    assert.notEqual(selected.source.fingerprint, doc.source.fingerprint)
    await assert.rejects(assertCurrentSource(doc.source, db), code(409, 'continuity_source_changed'))
    const state = await evaluateEntry(entry.entryId, db)
    assert.equal(state.validity, 'stale'); assert.equal(state.history, drift === 'loss' ? 'history_unavailable' : 'known')
    assert.ok(state.reasons.includes('continuity_source_changed'))
    const next = await evaluateEntry(dependent.entryId, db)
    assert.equal(next.validity, 'stale'); assert.ok(next.reasons.includes('basis_invalid'))
  })
  await t('fixture evidence and independent later episode remain valid when another source changes', async () => {
    const s = await seedStory(), d1 = await storyDocument(s), e1 = await persistEntry(d1)
    const d2 = await storyDocument(s, 1, [e1]), e2 = await persistEntry(d2)
    const d3 = await storyDocument(s, 2), e3 = await persistEntry(d3)
    for (const [i, d] of [d1, d2, d3].entries()) validateEntryEvidence(d, s.texts[i]!)
    for (const ref of [e1, e2, e3]) assert.equal((await evaluateEntry(ref.entryId, db)).validity, 'valid')
    await changeOutput(s.sources[0], { asset_ids: [s.sources[0].assetId], gate: { decision: 'reject', at: 2 } })
    assert.equal((await evaluateEntry(e1.entryId, db)).validity, 'stale')
    assert.equal((await evaluateEntry(e2.entryId, db)).validity, 'stale')
    assert.equal((await evaluateEntry(e3.entryId, db)).validity, 'valid')
  })
  await t('basis follows exact current confirmed head and actual transitive dependencies', async () => {
    const s = await seedStory(), doc = await storyDocument(s), e1 = await persistEntry(doc)
    const e2 = await persistEntry(await storyDocument(s, 1, [e1])), e3 = await persistEntry(await storyDocument(s, 2, [e2]))
    await db.update(records).set({ status: 'superseded' }).where(eq(records.id, e1.entryId))
    await persistEntry(doc)
    assert.equal((await evaluateEntry(e2.entryId, db)).validity, 'stale')
    assert.equal((await evaluateEntry(e3.entryId, db)).validity, 'stale')
  })
  await t('newer run and latestRun pointer do not invalidate the old confirmed source', async () => {
    const s = await seedStory(), e1 = await persistEntry(await storyDocument(s)), newer = await inherit(s, s.sources[0])
    await db.update(episodes).set({ latestRunId: newer.runId }).where(eq(episodes.id, s.episodes[0]))
    assert.equal((await evaluateEntry(e1.entryId, db)).validity, 'valid')
  })
  for (const missing of ['asset', 'run', 'step', 'source-version', 'document-version', 'document-file']) await t(`missing ${missing} preserves stored history and explanation`, async () => {
    const s = await seedStory(), ref = await persistEntry(await storyDocument(s)), pick = s.sources[0]
    if (missing === 'asset') await db.update(assets).set({ deletedAt: 1 }).where(eq(assets.id, pick.assetId))
    if (missing === 'run') await db.delete(pipelineRuns).where(eq(pipelineRuns.id, pick.runId))
    if (missing === 'step') await db.delete(pipelineSteps).where(eq(pipelineSteps.id, pick.stepId))
    if (missing === 'source-version') await db.delete(contentVersions).where(eq(contentVersions.id, pick.versionId))
    if (missing === 'document-version') await db.delete(contentVersions).where(eq(contentVersions.id, ref.versionId))
    if (missing === 'document-file') unlinkSync(absPathOf((await versionOf(ref.versionId)).relPath!))
    const result = await evaluateEntry(ref.entryId, db)
    assert.equal(result.validity, 'missing'); assert.ok(result.reasons.length)
    if (!missing.startsWith('document')) assert.equal(result.history, 'known')
    assert.equal((await db.select().from(records).where(eq(records.id, ref.entryId)))[0]!.sourceRunId, pick.runId)
  })
  await t('document hash/structure/evidence and row/source identity corruption are rejected', async () => {
    for (const corruption of ['file', 'evidence', 'identity', 'entity']) {
      const s = await seedStory(), doc = await storyDocument(s)
      if (corruption === 'evidence') doc.items[0]!.evidence[0]!.quote = '乙受伤'
      if (corruption === 'entity') doc.subjects[0]!.entityId = 987654321
      const ref = await persistEntry(doc)
      if (corruption === 'file') writeFileSync(absPathOf((await versionOf(ref.versionId)).relPath!), '{}')
      if (corruption === 'identity') await db.update(records).set({ sourceAssetId: s.sources[1].assetId }).where(eq(records.id, ref.entryId))
      assert.equal((await evaluateEntry(ref.entryId, db)).validity, 'corrupt', corruption)
    }
  })
  await t('basis rejects foreign scope, draft and forged ordinal; cycles cannot be followed', async () => {
    const s = await seedStory(), other = await seedStory(), foreign = await persistEntry(await storyDocument(other))
    const draft = await persistEntry(await storyDocument(s), 'draft')
    for (const ref of [foreign, draft, { ...draft, unitOrdinal: 2 }]) {
      const doc = await storyDocument(s, 2, [ref]), entry = await persistEntry(doc, 'draft')
      assert.equal((await evaluateEntry(entry.entryId, db)).validity, 'stale')
    }
    const doc = await storyDocument(s, 1)
    doc.basis = [{ ...draft, unitOrdinal: 2 }]
    const invalid = await persistEntry(doc, 'draft')
    assert.equal((await evaluateEntry(invalid.entryId, db)).validity, 'corrupt')
  })
  await t('evaluateEntry uses the transaction view, including current-head replacement', async () => {
    const s = await seedStory(), e1 = await persistEntry(await storyDocument(s)), e2 = await persistEntry(await storyDocument(s, 1, [e1]))
    const rollback = new Error('synthetic rollback')
    await assert.rejects(db.transaction(async tx => {
      await tx.update(records).set({ status: 'superseded' }).where(eq(records.id, e1.entryId))
      assert.equal((await evaluateEntry(e2.entryId, tx)).validity, 'stale')
      throw rollback
    }), e => e === rollback)
    assert.equal((await evaluateEntry(e2.entryId, db)).validity, 'valid')
  })
  await t('missing entry is missing, not an exception or silently valid', async () => {
    assert.equal((await evaluateEntry(987654321, db)).validity, 'missing')
  })
  await t('diamond ancestor is fully read once per evaluation, not cached across calls or executors', async () => {
    const s = await seedStory(), e1 = await persistEntry(await storyDocument(s))
    const e2 = await persistEntry(await storyDocument(s, 1, [e1]))
    const e3 = await persistEntry(await storyDocument(s, 2, [e1, e2]))
    const rollback = new Error('synthetic diamond rollback')
    await assert.rejects(db.transaction(async tx => {
      let ancestorDocumentReads = 0
      // Observe actual executor results without replacing SQLite queries or version-file reads.
      const observed = new Proxy(tx, {
        get(target, key, receiver) {
          if (key !== 'select') return Reflect.get(target, key, receiver)
          return (...args: Parameters<typeof tx.select>) => {
            const builder = target.select(...args), from = builder.from.bind(builder)
            builder.from = ((...fromArgs: Parameters<typeof from>) => {
              const query = from(...fromArgs), execute = query.execute.bind(query)
              query.execute = async (...executeArgs: Parameters<typeof execute>) => {
                const rows = await execute(...executeArgs)
                if (fromArgs[0] === contentVersions && rows.some(row => (row as { id?: number }).id === e1.versionId)) ancestorDocumentReads++
                return rows
              }
              return query
            }) as typeof builder.from
            return builder
          }
        },
      })
      const first = await evaluateEntry(e3.entryId, observed)
      assert.equal(first.validity, 'valid'); assert.equal(first.history, 'known')
      assert.equal(ancestorDocumentReads, 1, 'shared ancestor document must be fully evaluated only once')
      await tx.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [s.sources[0].assetId], gate: { decision: 'reject', at: 2 } }) })
        .where(eq(pipelineSteps.id, s.sources[0].stepId))
      ancestorDocumentReads = 0
      const changed = await evaluateEntry(e3.entryId, observed)
      assert.equal(changed.validity, 'stale'); assert.ok(changed.reasons.includes('basis_invalid'))
      assert.equal(ancestorDocumentReads, 1, 'a new call must reread the ancestor and see transaction-local source changes')
      throw rollback
    }), e => e === rollback)
    assert.equal((await evaluateEntry(e3.entryId, db)).validity, 'valid', 'rolled-back source changes must not leak into another executor')
  })
  await t('source fingerprint must also authenticate its own stored descriptive fields', async () => {
    const s = await seedStory(), doc = await storyDocument(s)
    for (const patch of [{ outputHash: hash('forged') }, { gateHash: hash('forged') }, { templateKey: 'forged' }, { stepKey: 'script_review' }]) {
      await assert.rejects(assertCurrentSource({ ...doc.source, ...patch }, db), code(409, 'continuity_source_changed'))
    }
  })
  await t('history warning does not conceal drift and propagates only along actual basis', async () => {
    const s = await seedStory()
    await db.delete(execSnapshots).where(eq(execSnapshots.stepId, s.sources[0].stepId))
    const e1 = await persistEntry(await storyDocument(s)), e2 = await persistEntry(await storyDocument(s, 1, [e1]))
    const independent = await storyDocument(s, 2)
    independent.releasedBasis = [{ ref: e1, reason: '人工明确解除依赖' }]
    const e3 = await persistEntry(independent)
    assert.equal((await evaluateEntry(e2.entryId, db)).history, 'history_unavailable')
    assert.equal((await evaluateEntry(e3.entryId, db)).history, 'known')
    const a = await assetOf(s.sources[0].assetId)
    writeFileSync(absPathOf(a.relPath!), '未登记改动')
    const state = await evaluateEntry(e1.entryId, db)
    assert.equal(state.validity, 'stale'); assert.equal(state.history, 'history_unavailable')
    assert.equal((await evaluateEntry(e2.entryId, db)).validity, 'stale')
    assert.equal((await evaluateEntry(e3.entryId, db)).validity, 'valid')
  })
  await t('source and entity reads see transaction-local changes without using global DB', async () => {
    const s = await seedStory(), rollback = new Error('synthetic rollback')
    await assert.rejects(db.transaction(async tx => {
      const [entity] = await tx.insert(characters).values({ projectId: s.projectId, name: '甲', createdAt: 1, updatedAt: 1 }).returning()
      await validateSubjects(s.projectId, [{ key: 'a', label: '甲', aliases: [], entityId: entity!.id }], tx)
      const asset = await assetOf(s.sources[0].assetId)
      const version = await recordAssetTextVersion({ asset, content: '事务内历史文本', source: 'edit', executor: tx })
      const selected = await readSource(s.projectId, s.episodes[0], { ...s.sources[0], versionId: version.id }, tx)
      assert.equal(selected.text, '事务内历史文本')
      throw rollback
    }), e => e === rollback)
  })
  await t('snapshot transaction rechecks changed source and rolls back an unpublished baseline', async () => {
    const s = await seedStory(), pick = s.sources[0], before = await count()
    const original = db.transaction.bind(db)
    // Schedule a real source mutation after the preliminary read, before the transaction starts.
    db.transaction = (async (callback, config) => {
      await changeOutput(pick, { asset_ids: [pick.assetId], gate: { decision: 'approve', at: 99 } })
      return original(callback, config)
    }) as typeof db.transaction
    try { await assert.rejects(captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0])), code(409, 'continuity_source_changed')) }
    finally { db.transaction = original }
    assert.equal(await count(), before)
    await db.delete(contentVersions).where(eq(contentVersions.id, pick.versionId))
    const rollback = new Error('synthetic rollback'), withoutBaseline = await count()
    db.transaction = (async (callback, config) => original(async tx => {
      await callback(tx)
      throw rollback
    }, config)) as typeof db.transaction
    try { await assert.rejects(captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0])), e => e === rollback) }
    finally { db.transaction = original }
    assert.equal(await count(), withoutBaseline)
  })
  await t('undeclared legacy steps need explicit selection; new declared role comes from frozen params', async () => {
    const s = await seedStory(), pick = s.sources[0]
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, pick.runId))
    const template = JSON.parse(run!.templateSnapshot!)
    template.key = 'other-template'
    // mengbao v19 declares the target role; strip it to recreate the undeclared-legacy premise.
    const legacy = template.steps.find((step: { key: string }) => step.key === 'write_script')
    if (legacy?.params) delete legacy.params['continuity_role']
    await db.update(pipelineRuns).set({ templateKey: template.key, templateSnapshot: JSON.stringify(template) }).where(eq(pipelineRuns.id, pick.runId))
    let candidate = (await listSources(s.projectId, s.episodes[0])).find(c => c.assetId === pick.assetId)!
    assert.equal(candidate.declaredRole, false); assert.ok(candidate.reasons.includes('undeclared_role'))
    await captureSource(s.projectId, s.episodes[0], raw(pick, s.texts[0]))
    template.steps.find((step: { key: string }) => step.key === 'write_script').params.continuity_role = 'episode_script'
    await db.update(pipelineRuns).set({ templateSnapshot: JSON.stringify(template) }).where(eq(pipelineRuns.id, pick.runId))
    candidate = (await listSources(s.projectId, s.episodes[0])).find(c => c.assetId === pick.assetId)!
    assert.equal(candidate.declaredRole, true)
  })
  await t('source replacement, same-byte new version, and missing current file invalidate entries', async () => {
    for (const mode of ['replacement', 'version', 'file']) {
      const s = await seedStory(), entry = await persistEntry(await storyDocument(s)), asset = await assetOf(s.sources[0].assetId)
      if (mode === 'replacement') await changeOutput(s.sources[0], { asset_ids: [s.sources[1].assetId], gate: { decision: 'approve', at: 1 } })
      if (mode === 'version') await recordAssetTextVersion({ asset, content: s.texts[0], source: 'restore' })
      if (mode === 'file') unlinkSync(absPathOf(asset.relPath!))
      assert.equal((await evaluateEntry(entry.entryId, db)).validity, mode === 'file' ? 'missing' : 'stale')
    }
  })
}
