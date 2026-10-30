import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import type { EntryDoc, EntryRef, Item } from '../../../src/services/continuity/contract'

export const hash = 'a'.repeat(64)
export const first: Item = {
  id: 'i1', topicKey: 'key.owner', channel: 'fact', type: 'possession', operation: 'set',
  subjects: ['a'], value: '钥匙在甲手中', previous: null,
  evidence: [{ start: 0, end: 7, quote: '钥匙在甲手中。' }],
  origin: 'extracted', editNote: '', included: true,
}
export const reference = (n: number): EntryRef => ({ entryId: n, assetId: n, versionId: n, hash, unitOrdinal: n })
export function document(n = 1, items: Item[] = [first], basis: EntryRef[] = []): EntryDoc {
  const unit = { projectId: 1, scopeKind: 'series' as const, scopeId: 1, unitKind: 'episode' as const, unitId: n, unitOrdinal: n }
  return {
    schemaVersion: 1, unit, source: { ...unit, runId: n, stepId: n, assetId: n, versionId: n,
      templateKey: 'example', templateSnapshotHash: hash, stepKey: 'write', hash, outputHash: hash,
      gateHash: hash, fingerprint: hash, history: 'known', inheritedViaRunId: null },
    basis, history: 'known', subjects: [
      { key: 'a', label: '甲', entityId: null, aliases: ['甲某'] },
      { key: 'audience', label: '观众', entityId: null, aliases: [] },
    ], topics: [{ key: 'key.owner', label: '钥匙归属' }], items, warnings: [], noChanges: !items.some(i => i.included), releasedBasis: [],
  }
}
export async function test(checker: Checker, name: string, body: () => void | Promise<void>) {
  try { await body(); checker.check(true, name) }
  catch (e) { checker.check(false, `${name}: ${(e as Error).message}`) }
}

export async function runFold(checker: Checker) {
  const { canonicalHash, foldEntries } = await import('../../../src/services/continuity/fold')
  const { ContinuityError, validateEntryEvidence } = await import('../../../src/services/continuity/contract')
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const e1 = { ref: reference(1), doc: document() }
  const previous = { ...reference(1), itemId: 'i1' }
  const e2 = { ref: reference(2), doc: document(2, [{ ...first, id: 'i2', operation: 'retract', previous }], [reference(1)]) }
  const code = (want: string) => (error: unknown) => error instanceof ContinuityError && error.code === want && error.status === 409
  await t('canonical hash recursively sorts object keys and preserves array order', () => {
    assert.equal(canonicalHash({ b: { z: 2, a: 1 }, a: 0 }), canonicalHash({ a: 0, b: { a: 1, z: 2 } }))
    assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]))
    assert.equal(canonicalHash({ a: 1 }), '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862')
    assert.notEqual(canonicalHash({ channel: 'fact', topicKey: first.topicKey }), canonicalHash({ channel: 'knowledge', topicKey: first.topicKey, knower: 'audience' }))
  })
  await t('canonical hash rejects every non-JSON category rather than silently dropping it', () => {
    const cycle: { self?: object } = {}; cycle.self = cycle
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('getter executed') } })
    for (const value of [undefined, NaN, Infinity, 1n, Symbol('x'), () => 1, new Date(), new Map(), { x: undefined }, [undefined], Array(1), cycle, accessor, { [Symbol('x')]: 1 }]) {
      assert.throws(() => canonicalHash(value), ContinuityError)
    }
  })
  await t('fold keeps fact, plan and each explicit knower in separate slots', () => {
    const items: Item[] = [first, { ...first, id: 'plan', channel: 'plan' },
      { ...first, id: 'aud', channel: 'knowledge', knower: 'audience', epistemic: 'knows' },
      { ...first, id: 'a', channel: 'knowledge', knower: 'a', epistemic: 'unaware' }]
    assert.deepEqual(foldEntries([{ ref: reference(1), doc: document(1, items) }]), {
      current: ['i1', 'plan', 'aud', 'a'].map(itemId => ({ ...reference(1), itemId })), closed: [], retracted: [],
    })
  })
  await t('fold sorts episodes without mutation; retract never resurrects older value', () => {
    const input = [e2, e1]; const before = JSON.stringify(input)
    assert.deepEqual(foldEntries(input), { current: [], closed: [], retracted: [{ ...reference(2), itemId: 'i2' }] })
    assert.equal(JSON.stringify(input), before)
  })
  await t('close preserves exact final reference; set may explicitly replace a retraction', () => {
    assert.deepEqual(foldEntries([e1, { ...e2, doc: document(2, [{ ...e2.doc.items[0]!, operation: 'close' }], [reference(1)]) }]),
      { current: [], closed: [{ ...reference(2), itemId: 'i2' }], retracted: [] })
    const e3 = { ref: reference(3), doc: document(3, [{ ...first, id: 'i3', previous: { ...reference(2), itemId: 'i2' } }], [reference(2)]) }
    assert.deepEqual(foldEntries([e3, e2, e1]).current, [{ ...reference(3), itemId: 'i3' }])
  })
  await t('wrong previous exact version/hash/item and stale heads conflict', () => {
    for (const prev of [null, { ...previous, versionId: 91 }, { ...previous, hash: 'b'.repeat(64) }, { ...previous, itemId: 'wrong' }]) {
      assert.throws(() => foldEntries([e1, { ...e2, doc: document(2, [{ ...first, previous: prev }], prev ? [{ ...prev, itemId: undefined }].map(({ itemId: _, ...r }) => r) : []) }]), ContinuityError)
    }
    const e3 = { ref: reference(3), doc: document(3, [{ ...first, previous }], [reference(1)]) }
    assert.throws(() => foldEntries([e1, e2, e3]), code('continuity_conflict'))
  })
  await t('same episode same slot cannot silently last-write-win', () => {
    assert.throws(() => foldEntries([{ ref: reference(1), doc: document(1, [first, { ...first, id: 'i2' }]) }]), code('continuity_conflict'))
    assert.throws(() => foldEntries([e1, e1]), code('continuity_conflict'))
  })
  await t('orphan close/retract and a missing earlier entry fail closed', () => {
    for (const operation of ['close', 'retract'] as const) {
      assert.throws(() => foldEntries([{ ref: reference(1), doc: document(1, [{ ...first, operation }]) }]), code('continuity_dependency_invalid'))
    }
    assert.throws(() => foldEntries([e2]), code('continuity_dependency_invalid'))
  })
  await t('excluded items never establish a head; empty explicit episode is valid', () => {
    const excluded = { ref: reference(1), doc: document(1, [{ ...first, included: false }]) }
    assert.deepEqual(foldEntries([excluded]), { current: [], closed: [], retracted: [] })
    assert.throws(() => foldEntries([excluded, e2]), code('continuity_dependency_invalid'))
    assert.deepEqual(foldEntries([{ ref: reference(1), doc: document(1, []) }]), { current: [], closed: [], retracted: [] })
  })
  await t('fold rejects cross-series/project inputs and mismatched ordinals', () => {
    for (const patch of [{ scopeId: 2 }, { projectId: 2 }]) {
      const doc = document(2, [{ ...first, previous }], [reference(1)])
      Object.assign(doc.unit, patch); Object.assign(doc.source, patch)
      assert.throws(() => foldEntries([e1, { ref: reference(2), doc }]), ContinuityError)
    }
    assert.throws(() => foldEntries([{ ref: reference(2), doc: document() }]), ContinuityError)
  })
  await t('evidence validates selected UTF-16 slice, not quote length alone', () => {
    assert.equal(first.evidence[0]!.quote.length, 7)
    validateEntryEvidence(document(), '钥匙在甲手中。')
    assert.throws(() => validateEntryEvidence(document(), '钥匙在乙手中。'), (e: unknown) => e instanceof ContinuityError && e.code === 'continuity_evidence_invalid')
    const doc = document(1, [{ ...first, evidence: [{ start: 2, end: 9, quote: '钥匙在甲手中。' }] }])
    validateEntryEvidence(doc, '😀钥匙在甲手中。')
    assert.throws(() => validateEntryEvidence(doc, '钥匙在甲手中。'), ContinuityError)
    assert.throws(() => validateEntryEvidence(document(), 'x'.repeat(120001)), (e: unknown) => e instanceof ContinuityError && e.status === 413)
  })
}
