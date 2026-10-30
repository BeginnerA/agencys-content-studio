import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Checker } from '../../probe-lib'
import { initDatabase, migrationsDir, temporaryRoot } from './bootstrap'
import { document, first, hash, reference, test } from './fold'

export async function runContract(checker: Checker) {
  const { sqlite, initDb } = await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  await t('real initDb must install continuity table (migration warnings cannot pass)', async () => {
    assert.equal((await sqlite.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='content_continuity_records'")).rows.length, 1)
  })
  await t('0002 upgrade and repeated initDb preserve old project, source run and immutable version', async () => {
    const queries = ['SELECT * FROM projects WHERE id=7001', 'SELECT * FROM pipeline_runs WHERE id=7001', 'SELECT * FROM content_versions WHERE id=7001']
    const before = await Promise.all(queries.map(q => sqlite.execute(q)))
    assert.equal(before[0]!.rows[0]!.name, 'M70 old project')
    assert.equal(before[1]!.rows[0]!.template_key, 'old-template')
    assert.equal(before[2]!.rows[0]!.doc, 'old immutable text')
    await Promise.all([initDb(), initDb()])
    assert.deepEqual(await Promise.all(queries.map(q => sqlite.execute(q))), before)
  })
  // First RED is a real SQLite assertion, before any new module exists.
  if (!(await sqlite.execute("SELECT name FROM sqlite_master WHERE name='content_continuity_records'")).rows.length) return
  await t('fresh database migrates; successor snapshot changes only the new table', async () => {
    const { createClient } = await import('@libsql/client')
    const { drizzle } = await import('drizzle-orm/libsql')
    const { migrate } = await import('drizzle-orm/libsql/migrator')
    const fresh = createClient({ url: `file:${join(temporaryRoot, 'fresh.db')}` })
    try {
      await migrate(drizzle(fresh), { migrationsFolder: migrationsDir })
      assert.equal((await fresh.execute("SELECT name FROM sqlite_master WHERE name='content_continuity_records'")).rows.length, 1)
      const before = await fresh.execute('SELECT * FROM __drizzle_migrations')
      await migrate(drizzle(fresh), { migrationsFolder: migrationsDir })
      assert.deepEqual(await fresh.execute('SELECT * FROM __drizzle_migrations'), before)
    } finally { fresh.close() }
    const old = JSON.parse(readFileSync(join(migrationsDir, 'meta/0002_snapshot.json'), 'utf8'))
    const next = JSON.parse(readFileSync(join(migrationsDir, 'meta/0003_snapshot.json'), 'utf8'))
    const { content_continuity_records: added, ...unchanged } = next.tables
    assert.ok(added)
    assert.deepEqual(unchanged, old.tables)
    assert.equal(next.prevId, old.id)
  })
  const c = await import('../../../src/services/continuity/contract')
  const { contentContinuityRecords } = await import('../../../src/db/schema')
  await t('schema re-export exposes the real queryable table with all 30 design fields', async () => {
    const { db } = await import('../../../src/db')
    assert.deepEqual(await db.select().from(contentContinuityRecords), [])
    const columns = (await sqlite.execute("PRAGMA table_info('content_continuity_records')")).rows.map(r => r.name)
    assert.deepEqual(columns, ['id', 'project_id', 'scope_kind', 'scope_id', 'unit_kind', 'unit_id', 'unit_ordinal',
      'row_type', 'status', 'revision', 'document_asset_id', 'document_version_id', 'document_hash', 'source_run_id',
      'source_step_id', 'source_asset_id', 'source_version_id', 'source_hash', 'run_id', 'step_id', 'parent_id',
      'operation_key', 'request_hash', 'approval_key', 'approval_hash', 'replaced_by_id', 'error_code', 'created_at', 'updated_at', 'confirmed_at'])
  })
  let seq = 0
  const insert = (rowType: string, status: string, opts: { key?: string; unit?: number; project?: number; pointer?: 'full' | 'partial' | 'none' } = {}) => sqlite.execute({
    sql: `INSERT INTO content_continuity_records(project_id,scope_kind,scope_id,unit_kind,unit_id,unit_ordinal,
      row_type,status,operation_key,request_hash,document_asset_id,document_version_id,document_hash,created_at,updated_at)
      VALUES(?,'series',1,'episode',?,1,?,?,?,?,?,?,?,1,1)`,
    args: [opts.project ?? 1, opts.unit ?? 1, rowType, status, opts.key ?? `operation_${++seq}`, hash,
      opts.pointer === 'none' ? null : 100, opts.pointer === 'full' || opts.pointer === undefined ? 100 : null,
      opts.pointer === 'full' || opts.pointer === undefined ? hash : null],
  })
  await t('SQLite enforces every rowType/status pairing, not only TypeScript enums', async () => {
    const allowed = { entry: ['extracting', 'draft', 'failed', 'unknown', 'confirmed', 'superseded'], context: ['frozen', 'bound'], consumption: ['prepared', 'dispatching', 'completed', 'failed', 'unknown'] }
    const statuses = [...new Set(Object.values(allowed).flat()), 'invalid']
    for (const [kind, valid] of Object.entries(allowed)) {
      for (const status of statuses) {
        if (valid.includes(status)) await insert(kind, status, { unit: ++seq })
        else await assert.rejects(insert(kind, status), /CHECK constraint failed/)
      }
    }
    await assert.rejects(insert('invalid', 'failed'), /CHECK constraint failed/)
  })
  await t('nullable pointer is all-or-none and only permitted for entry placeholders', async () => {
    for (const status of ['extracting', 'failed', 'unknown']) await insert('entry', status, { pointer: 'none' })
    for (const [kind, status] of [['entry', 'draft'], ['entry', 'confirmed'], ['entry', 'superseded'], ['context', 'frozen'], ['consumption', 'prepared']]) {
      await assert.rejects(insert(kind!, status!, { pointer: 'none' }), /CHECK constraint failed/)
    }
    await assert.rejects(insert('entry', 'failed', { pointer: 'partial' }), /CHECK constraint failed/)
  })
  await t('operation key uniqueness is scoped by project and rowType', async () => {
    await insert('entry', 'draft', { key: 'same_key' })
    await assert.rejects(insert('entry', 'draft', { key: 'same_key' }), /UNIQUE constraint failed/)
    await insert('context', 'frozen', { key: 'same_key' })
    await insert('entry', 'draft', { key: 'same_key', project: 2 })
  })
  await t('partial unique confirmed index really permits drafts/context but rejects a second confirmed head', async () => {
    await insert('entry', 'confirmed', { key: 'confirmed_1', unit: 800 })
    await assert.rejects(insert('entry', 'confirmed', { key: 'confirmed_2', unit: 800 }), /UNIQUE constraint failed/)
    await insert('entry', 'draft', { unit: 800 }); await insert('entry', 'draft', { unit: 800 })
    await insert('context', 'frozen', { unit: 800 })
    await insert('entry', 'confirmed', { unit: 800, project: 2 })
    await sqlite.execute("UPDATE content_continuity_records SET status='superseded' WHERE operation_key='confirmed_1'")
    await insert('entry', 'confirmed', { key: 'confirmed_2', unit: 800 })
  })
  await t('source/parent/run indexes exist; deleting a source does not cascade away history', async () => {
    const indexes = await sqlite.execute("PRAGMA index_list('content_continuity_records')")
    for (const name of ['idx_continuity_source', 'idx_continuity_parent', 'idx_continuity_run']) assert.ok(indexes.rows.some(r => r.name === name))
    await sqlite.execute("UPDATE content_continuity_records SET source_run_id=7001 WHERE operation_key='same_key' AND project_id=1 AND row_type='entry'")
    await sqlite.execute('DELETE FROM pipeline_runs WHERE id=7001')
    assert.equal((await sqlite.execute('SELECT source_run_id FROM content_continuity_records WHERE source_run_id=7001')).rows.length, 1)
    const fks = await sqlite.execute("PRAGMA foreign_key_list('content_continuity_records')")
    assert.ok(fks.rows.every(r => r.on_delete !== 'CASCADE'))
  })
  await t('strict scalar contracts reject invalid IDs, hashes and operation keys', () => {
    for (const n of [0, -1, 1.5, Infinity]) assert.equal(c.DocRefSchema.safeParse({ assetId: n, versionId: 1, hash }).success, false)
    for (const h of [hash.toUpperCase(), 'abc']) assert.equal(c.DocRefSchema.safeParse({ assetId: 1, versionId: 1, hash: h }).success, false)
    assert.equal(c.DocRefSchema.safeParse({ ...reference(1) }).success, false)
    for (const operationKey of ['short', 'a'.repeat(121), 'bad key!']) assert.equal(c.ReviewRequestSchema.safeParse({ parentId: 1, source: { runId: 1, stepId: 1, assetId: 1, versionId: 1 }, operationKey }).success, false)
  })
  await t('knowledge is a strict discriminated union and manual/edited items require reasons', () => {
    assert.ok(c.ItemSchema.safeParse(first).success)
    assert.equal(c.ItemSchema.safeParse({ ...first, channel: 'knowledge' }).success, false)
    for (const channel of ['fact', 'plan']) assert.equal(c.ItemSchema.safeParse({ ...first, channel, knower: 'a', epistemic: 'knows' }).success, false)
    for (const epistemic of ['knows', 'believes', 'unaware', 'unknown']) assert.ok(c.ItemSchema.safeParse({ ...first, channel: 'knowledge', knower: 'audience', epistemic }).success)
    for (const origin of ['manual', 'edited']) {
      assert.equal(c.ItemSchema.safeParse({ ...first, origin, editNote: '  ' }).success, false)
      assert.ok(c.ItemSchema.safeParse({ ...first, origin, editNote: '人工明确补充', evidence: [] }).success)
    }
    assert.equal(c.ItemSchema.safeParse({ ...first, evidence: [] }).success, false)
    for (const evidence of [[{ start: -1, end: 7, quote: '钥匙在甲手中。' }], [{ start: 0, end: 6, quote: '钥匙在甲手中。' }], [{ start: 1, end: 1, quote: '' }]]) {
      assert.equal(c.ItemSchema.safeParse({ ...first, evidence }).success, false)
    }
  })
  await t('entry dictionaries, explicit aliases, source identity, previous/basis and noChanges are structural boundaries', () => {
    assert.ok(c.EntryDocSchema.safeParse(document()).success)
    const cases = [
      { topics: [] }, { subjects: [] }, { subjects: [...document().subjects, document().subjects[0]] },
      { items: [first, first] }, { items: [{ ...first, topicKey: 'other' }] },
      { items: [{ ...first, subjects: ['甲某'] }] },
      { items: [{ ...first, channel: 'knowledge', knower: 'unlisted', epistemic: 'knows' }] },
      { source: { ...document().source, projectId: 2 } }, { noChanges: true },
      { items: [], noChanges: false }, { basis: [reference(1)] },
      { items: [{ ...first, previous: { ...reference(1), itemId: 'i0' } }] },
      { releasedBasis: [{ ref: reference(1), reason: '' }] },
    ]
    for (const patch of cases) assert.equal(c.EntryDocSchema.safeParse({ ...document(), ...patch }).success, false, JSON.stringify(patch))
    assert.equal(c.EntryDocSchema.safeParse(document(2, [{ ...first, previous: { ...reference(1), itemId: 'i1' } }])).success, false)
    assert.ok(c.EntryDocSchema.safeParse(document(2, [{ ...first, previous: { ...reference(1), itemId: 'i1' } }], [reference(1)])).success)
  })
  await t('item/list/document limits reject oversized input without truncation', () => {
    assert.equal(c.ItemSchema.safeParse({ ...first, value: 'x'.repeat(1001) }).success, false)
    assert.ok(c.ItemSchema.safeParse({ ...first, value: 'x'.repeat(1000) }).success)
    assert.equal(c.EntryDocSchema.safeParse(document(1, Array.from({ length: 201 }, (_, i) => ({ ...first, id: `i${i}` })))).success, false)
    assert.equal(c.EntryDocSchema.safeParse({ ...document(), warnings: ['x'.repeat(200001)] }).success, false)
  })
  await t('EntryView permits missing documents only for unsuccessful placeholders', () => {
    const base = { id: 1, revision: 1, operationKey: 'operation_1', document: null, doc: null, validity: 'missing', history: 'known', warningsHash: hash, currentConfirmedId: null, errorCode: null }
    for (const status of ['extracting', 'failed', 'unknown']) assert.ok(c.EntryViewSchema.safeParse({ ...base, status }).success)
    for (const status of ['draft', 'confirmed', 'superseded']) assert.equal(c.EntryViewSchema.safeParse({ ...base, status }).success, false)
    const pointer = { assetId: 1, versionId: 1, hash }
    assert.ok(c.EntryViewSchema.safeParse({ ...base, status: 'confirmed', document: pointer, doc: document(), validity: 'valid' }).success)
    assert.equal(c.EntryViewSchema.safeParse({ ...base, status: 'confirmed', document: pointer }).success, false)
  })
  await t('UseDoc each state constrains submission, billing, times, output, errors and real message/usage shape', () => {
    const pointer = { assetId: 1, versionId: 1, hash }
    const base = { schemaVersion: 1, context: pointer, entries: [reference(1)], runId: 1, stepId: 1, round: 'first', messages: [{ role: 'user', content: 'hello' }], messagesHash: hash, provider: 'fake', model: 'fake', configHash: hash, sourceChangedAfterDispatch: false }
    const states = [
      { state: 'prepared', submitted: false, billing: 'not_submitted', startedAt: null, completedAt: null, output: null, usage: null, errorCode: null },
      { state: 'dispatching', submitted: null, billing: 'unknown', startedAt: 10, completedAt: null, output: null, usage: null, errorCode: null },
      { state: 'completed', submitted: true, billing: 'recorded', startedAt: 10, completedAt: 20, output: pointer, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, errorCode: null },
      { state: 'failed', submitted: false, billing: 'not_submitted', startedAt: null, completedAt: 20, output: null, usage: null, errorCode: 'local_failure' },
      { state: 'unknown', submitted: null, billing: 'unknown', startedAt: 10, completedAt: null, output: null, usage: null, errorCode: 'continuity_outcome_unknown' },
    ]
    for (const state of states) {
      assert.ok(c.UseDocSchema.safeParse({ ...base, ...state }).success, state.state)
      assert.equal(c.UseDocSchema.safeParse({ ...base, ...state, injected: true }).success, false)
    }
    for (const [index, patch] of [[0, { submitted: true }], [0, { startedAt: 10 }], [1, { billing: 'not_submitted' }], [1, { output: pointer }], [2, { output: null }], [2, { submitted: null }], [2, { completedAt: 9 }], [3, { submitted: true }], [4, { submitted: false }], [4, { billing: 'not_submitted' }], [4, { output: pointer }]] as const) {
      assert.equal(c.UseDocSchema.safeParse({ ...base, ...states[index], ...patch }).success, false)
    }
    // M70 任务5：用量服务旁路失败时 completed 不得宣称已结算 —— billing 'unknown' 是合法完成态。
    assert.ok(c.UseDocSchema.safeParse({ ...base, ...states[2], billing: 'unknown' }).success)
    for (const messages of [[{ role: 'bogus', content: 'x' }], [{ role: 'user', content: { arbitrary: 1 } }], [{ role: 'user', content: 'x', secret: 'not allowed' }]]) {
      assert.equal(c.UseDocSchema.safeParse({ ...base, ...states[0], messages }).success, false)
    }
    assert.equal(c.UseDocSchema.safeParse({ ...base, ...states[2], usage: { arbitrary: 1 } }).success, false)
    assert.equal(c.UseDocSchema.safeParse({ ...base, ...states[0], messages: [{ role: 'user', content: 'x'.repeat(160001) }] }).success, false)
    assert.ok(c.UseDocSchema.safeParse({ ...base, ...states[4], submitted: true, billing: 'recorded', usage: states[2]!.usage }).success)
    assert.ok(c.UseDocSchema.safeParse({ ...base, ...states[0], messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'https://invalid.example/image' } }] }] }).success)
  })
  await t('all shared request/document schemas are strict and accept their declared branch only', () => {
    const request = { kind: 'manual', episodeId: 1, templateKey: 'example', input: { with_continuity: true, _params: { size: 1 } } }
    assert.ok(c.TargetRequestSchema.safeParse(request).success)
    for (const req of [{ kind: 'route', sessionId: 1, decisionRevision: 0, decisionHash: hash }, { kind: 'workflow', workflowId: 1, nextSeq: 0, previousRunId: null }, { kind: 'resume', runId: 1 }]) assert.ok(c.TargetRequestSchema.safeParse(req).success)
    assert.equal(c.TargetRequestSchema.safeParse({ ...request, sessionId: 1 }).success, false)
    assert.equal(c.TargetRequestSchema.safeParse({ ...request, input: { x: undefined } }).success, false)
    const target = { unit: document().unit, request, templateKey: 'example', templateSnapshotHash: hash, stepKey: 'write', inputHash: hash, configHash: hash }
    const doc = { schemaVersion: 1, rendererVersion: 1, target, entries: [], dependencies: [], gaps: [], acceptedGaps: [], includePlans: false, rendered: 'context', renderedHash: hash, previewHash: hash, duplicateCostAcceptance: null }
    const cases: [import('zod').ZodType, object][] = [
      [c.SourceSchema, document().source], [c.UnitSchema, document().unit], [c.EntryRefSchema, reference(1)],
      [c.ItemRefSchema, { ...reference(1), itemId: 'i1' }], [c.SubjectSchema, document().subjects[0]!], [c.TopicSchema, document().topics[0]!],
      [c.GapSchema, { key: 'gap', unitOrdinal: 1, kind: 'missing_entry', entryId: null, fingerprint: hash }],
      [c.AcceptanceSchema, { key: 'gap', fingerprint: hash, reason: 'reviewed' }], [c.TargetSchema, target], [c.ContextDocSchema, doc],
      [c.PreviewRequestSchema, { target: request, includePlans: false }],
      [c.PreviewSchema, { doc, chars: 7, maxChars: 24000, canFreeze: true, blockers: [], unknownUseId: null }],
      [c.ApprovalSchema, { contextId: 1, document: { assetId: 1, versionId: 1, hash }, approvalHash: hash }],
      [c.FreezeRequestSchema, { target: request, includePlans: false, previewHash: hash, acceptedGaps: [], operationKey: 'operation_1' }],
      [c.ConfirmRequestSchema, { expectedRevision: 1, document: { assetId: 1, versionId: 1, hash }, sourceFingerprint: hash, warningsHash: hash, expectedCurrentConfirmedId: null, acceptedWarnings: [], approvalKey: 'approval_1' }],
      [c.ExtractPreviewSchema, { source: document().source, basis: [], previewHash: hash, inputChars: 7, warnings: [], estimatedCost: null }],
      [c.ExtractRequestSchema, { source: { runId: 1, stepId: 1, assetId: 1, versionId: 1 }, previewHash: hash, operationKey: 'operation_1', allowModelCall: true, acceptUnpriced: false }],
      [c.ReviewRequestSchema, { parentId: 1, source: { runId: 1, stepId: 1, assetId: 1, versionId: 1 }, operationKey: 'operation_1' }],
      [c.PatchRequestSchema, { expectedRevision: 1, doc: document() }],
      [c.SourceCandidateSchema, { runId: 1, stepId: 1, stepKey: 'write', title: 'test', assetId: 1, versionId: null, versions: [], currentHash: hash, confirmable: false, reasons: [], declaredRole: false, inheritedViaRunId: null }],
    ]
    for (const [schema, value] of cases) {
      assert.ok(schema.safeParse(value).success, JSON.stringify(value))
      assert.equal(schema.safeParse({ ...value, unexpected: 1 }).success, false)
    }
    assert.equal(c.ContextDocSchema.safeParse({ ...doc, rendered: 'x'.repeat(24001) }).success, false)
    assert.ok(c.ContextDocSchema.safeParse({ ...doc, rendered: 'x'.repeat(24000) }).success)
    assert.equal(c.ExtractRequestSchema.safeParse({ ...cases[16]![1], allowModelCall: false }).success, false)
    assert.ok(c.ExtractPreviewSchema.safeParse({ ...cases[15]![1], inputChars: 160000 }).success)
    assert.equal(c.ExtractPreviewSchema.safeParse({ ...cases[15]![1], inputChars: 160001 }).success, false)
  })
  await t('template material and duplicate cost approval use real strict nested schemas', () => {
    const material = { unit: document().unit, templateKey: 'example', input: {}, template: {
      key: 'example', version: 1, name: 'example', genre: 'drama_short', inputs: [],
      steps: [{ key: 'write', action: 'ai_text', title: 'write', inputs: {}, gate: { mode: 'required', message: 'review' } }],
    } }
    assert.ok(c.TargetMaterialSchema.safeParse(material).success)
    assert.equal(c.TargetMaterialSchema.safeParse({ ...material, template: { ...material.template, unexpected: 1 } }).success, false)
    assert.equal(c.TargetMaterialSchema.safeParse({ ...material, template: { ...material.template, steps: [{ ...material.template.steps[0], gate: { mode: 'skip', message: 'review' } }] } }).success, false)
    assert.ok(c.DuplicateCostAcceptanceSchema.safeParse({ useId: 1, accepted: true }).success)
    for (const value of [{ useId: 0, accepted: true }, { useId: 1, accepted: false }, { useId: 1, accepted: true, allUses: true }]) {
      assert.equal(c.DuplicateCostAcceptanceSchema.safeParse(value).success, false)
    }
    assert.equal(c.SourcePickSchema.safeParse({ runId: 1, stepId: 1, assetId: 1, versionId: 1, text: 'not a source pointer' }).success, false)
  })
  await t('released dependencies cannot hide a remaining previous reference', () => {
    const previous = { ...reference(1), itemId: 'i1' }
    const doc = document(2, [{ ...first, previous }], [reference(1)])
    assert.equal(c.EntryDocSchema.safeParse({ ...doc, releasedBasis: [{ ref: reference(1), reason: 'released' }] }).success, false)
    assert.equal(c.EntryDocSchema.safeParse({ ...doc, basis: [], releasedBasis: [{ ref: reference(1), reason: 'released' }] }).success, false)
    assert.ok(c.EntryDocSchema.safeParse({ ...document(2), releasedBasis: [{ ref: reference(1), reason: 'explicit independent review' }] }).success)
    assert.ok(c.EntryDocSchema.safeParse(document(1, Array.from({ length: 200 }, (_, i) => ({ ...first, id: `i${i}` })))).success)
  })
  await t('reserved purposes classify only exact names; error keeps stable code/status/operationId', async () => {
    const { isContinuityPurpose } = await import('../../../src/services/continuity/reserved')
    for (const purpose of ['continuity_entry', 'continuity_context', 'continuity_use']) assert.equal(isContinuityPurpose(purpose), true)
    for (const purpose of [null, 'script', 'continuity_entry_other', 'CONTINUITY_USE']) assert.equal(isContinuityPurpose(purpose), false)
    const error = new c.ContinuityError('continuity_conflict', 409, 7)
    assert.equal(error.code, 'continuity_conflict'); assert.equal(error.status, 409); assert.equal(error.operationId, 7)
  })
}
