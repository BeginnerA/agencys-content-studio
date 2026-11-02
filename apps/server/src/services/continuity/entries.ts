import { randomUUID } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { db } from '../../db'
import { assets, contentContinuityRecords as records, type ContentContinuityRecord } from '../../db/schema'
import { ConfirmRequestSchema, ContinuityError, DocRefSchema, EntryDocSchema, EntryViewSchema, PatchRequestSchema, ReviewRequestSchema,
  validateEntryEvidence, type ConfirmRequest, type DocRef, type EntryDoc, type EntryRef, type EntryView, type Executor,
  type PatchRequest, type ReviewRequest, type Unit } from './contract'
import { canonicalHash, foldEntries } from './fold'
import { assertContinuityProjectWritable } from './lifecycle'
import { continuityIO } from './runtime'
import { resolveUnit, validateSubjects } from './scope'
import { assertCurrentSource, readContinuityVersion, readSource } from './sources'
import { documentTransaction, writeDocument } from './store'
import { evaluateEntry } from './validity'

const conflict = (): never => { throw new ContinuityError('continuity_conflict', 409) }
const invalid = (): never => { throw new ContinuityError('continuity_evidence_invalid', 400) }
export function documentRef(row: ContentContinuityRecord): DocRef {
  const parsed = DocRefSchema.safeParse({ assetId: row.documentAssetId, versionId: row.documentVersionId, hash: row.documentHash })
  if (!parsed.success) return invalid()
  return parsed.data
}
export async function entryRow(projectId: number, id: number, ex: Executor): Promise<ContentContinuityRecord> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new ContinuityError('continuity_source_invalid', 400)
  const [row] = await ex.select().from(records).where(and(eq(records.id, id), eq(records.projectId, projectId), eq(records.rowType, 'entry'))).limit(1)
  if (!row) throw new ContinuityError('continuity_source_invalid', 404)
  await resolveUnit(projectId, row.unitId, ex)
  return row
}
export async function entryDocument(row: ContentContinuityRecord, ex: Executor): Promise<EntryDoc> {
  const text = await readContinuityVersion(ex, row.projectId, documentRef(row))
  try { return EntryDocSchema.parse(JSON.parse(text)) } catch { return invalid() }
}
export async function currentConfirmed(unit: Unit, ex: Executor): Promise<number | null> {
  const [head] = await ex.select({ id: records.id }).from(records).where(and(eq(records.projectId, unit.projectId),
    eq(records.scopeKind, unit.scopeKind), eq(records.scopeId, unit.scopeId), eq(records.unitKind, unit.unitKind),
    eq(records.unitId, unit.unitId), eq(records.rowType, 'entry'), eq(records.status, 'confirmed'))).limit(1)
  return head?.id ?? null
}
export function entryWarnings(doc: EntryDoc | null, history: EntryView['history']): string[] {
  return [...new Set([...(doc?.warnings ?? []), ...(history === 'history_unavailable' ? ['history_unavailable'] : [])])].sort()
}
export async function entryView(row: ContentContinuityRecord, ex: Executor): Promise<EntryView> {
  const doc = row.documentAssetId === null ? null : await entryDocument(row, ex)
  const state = await evaluateEntry(row.id, ex)
  return EntryViewSchema.parse({ id: row.id, revision: row.revision, status: row.status, operationKey: row.operationKey,
    document: doc ? documentRef(row) : null, doc, validity: state.validity, history: state.history,
    warningsHash: canonicalHash(entryWarnings(doc, state.history)), currentConfirmedId: await currentConfirmed(row as Unit, ex), errorCode: row.errorCode })
}
export async function getEntry(projectId: number, id: number): Promise<EntryView> { return entryView(await entryRow(projectId, id, db), db) }
export async function listEntries(projectId: number, episodeId: number): Promise<EntryView[]> {
  await resolveUnit(projectId, episodeId, db)
  const found = await db.select().from(records).where(and(eq(records.projectId, projectId), eq(records.unitId, episodeId), eq(records.rowType, 'entry'))).orderBy(records.id)
  return Promise.all(found.map(r => entryView(r, db)))
}
/** Must run before rechecking a now-stale preview/revision: successful operations remain replayable. */
export async function findOperation(projectId: number, key: string, requestHash: string, ex: Executor): Promise<ContentContinuityRecord | null> {
  const [row] = await ex.select().from(records).where(and(eq(records.projectId, projectId), eq(records.rowType, 'entry'), eq(records.operationKey, key))).limit(1)
  if (!row) return null
  if (row.requestHash !== requestHash) return conflict()
  await entryRow(projectId, row.id, ex)
  return row
}
export async function currentBasis(unit: Unit, ex: Executor): Promise<{ ref: EntryRef; doc: EntryDoc }[]> {
  const found = await ex.select().from(records).where(and(eq(records.projectId, unit.projectId), eq(records.scopeId, unit.scopeId),
    eq(records.rowType, 'entry'), eq(records.status, 'confirmed'), lt(records.unitOrdinal, unit.unitOrdinal))).orderBy(records.unitOrdinal)
  const result: { ref: EntryRef; doc: EntryDoc }[] = []
  for (const row of found) {
    if ((await evaluateEntry(row.id, ex)).validity !== 'valid') continue
    result.push({ ref: { ...documentRef(row), entryId: row.id, unitOrdinal: row.unitOrdinal }, doc: await entryDocument(row, ex) })
  }
  return result
}

/** Exact dependency identity and previous item semantics; stale drafts are repairable but never confirmable. */
export async function validateDependencies(doc: EntryDoc, ex: Executor, requireCurrent: boolean): Promise<void> {
  for (const ref of doc.basis) {
    const row = await entryRow(doc.unit.projectId, ref.entryId, ex)
    if (row.scopeId !== doc.unit.scopeId || row.unitOrdinal !== ref.unitOrdinal || row.unitOrdinal >= doc.unit.unitOrdinal
      || canonicalHash(documentRef(row)) !== canonicalHash({ assetId: ref.assetId, versionId: ref.versionId, hash: ref.hash })) {
      throw new ContinuityError('continuity_dependency_invalid', 409)
    }
    if (requireCurrent && (row.status !== 'confirmed' || (await evaluateEntry(row.id, ex)).validity !== 'valid')) {
      throw new ContinuityError('continuity_dependency_invalid', 409)
    }
    const previousDoc = await entryDocument(row, ex)
    for (const item of doc.items.filter(i => i.previous?.entryId === row.id)) {
      const previous = previousDoc.items.find(i => i.id === item.previous!.itemId && i.included)
      if (!previous || previous.topicKey !== item.topicKey || previous.channel !== item.channel
        || (previous.channel === 'knowledge' && (item.channel !== 'knowledge' || previous.knower !== item.knower))) {
        throw new ContinuityError('continuity_dependency_invalid', 409)
      }
    }
  }
}
function parseDoc(raw: unknown): EntryDoc {
  if (JSON.stringify(raw).length > 200_000) throw new ContinuityError('continuity_context_too_large', 413)
  const parsed = EntryDocSchema.safeParse(raw)
  return parsed.success ? parsed.data : invalid()
}
function normalizePatch(old: EntryDoc, raw: EntryDoc): EntryDoc {
  if (!raw || !Array.isArray(raw.items) || !Array.isArray(raw.basis) || !Array.isArray(raw.releasedBasis)) return invalid()
  // Full validation below catches unknown fields; identity/source are never client-editable.
  if (canonicalHash(raw.unit) !== canonicalHash(old.unit) || canonicalHash(raw.source) !== canonicalHash(old.source) || raw.history !== old.history) {
    if (!EntryDocSchema.safeParse(raw).success) return invalid()
    return conflict()
  }
  const doc = structuredClone(raw)
  if (new Set(doc.items.map(i => i.id)).size !== doc.items.length) return invalid()
  for (const item of doc.items) {
    const prior = old.items.find(i => i.id === item.id)
    if (!prior) { item.id = randomUUID(); item.origin = 'manual' }
    else item.origin = canonicalHash({ ...item, origin: prior.origin }) === canonicalHash(prior) ? prior.origin : 'edited'
    if (item.previous && !doc.basis.some(r => r.entryId === item.previous!.entryId)) {
      const { itemId: _id, ...ref } = item.previous
      // Explicitly released edges cannot be silently reintroduced by a dangling previous.
      if (doc.releasedBasis.some(r => r.ref.entryId === ref.entryId)) throw new ContinuityError('continuity_dependency_invalid', 409)
      doc.basis.push(ref)
    }
  }
  for (const ref of old.basis) {
    const next = doc.basis.find(r => r.entryId === ref.entryId)
    if (next && canonicalHash(ref) !== canonicalHash(next)) return conflict()
    if (!next && !doc.releasedBasis.some(r => canonicalHash(r.ref) === canonicalHash(ref) && r.reason.trim())) return conflict()
  }
  for (const release of doc.releasedBasis) {
    if (![...old.basis, ...old.releasedBasis.map(r => r.ref)].some(ref => canonicalHash(ref) === canonicalHash(release.ref))) return conflict()
  }
  // Release audit cannot be erased by a later edit.
  for (const release of old.releasedBasis) {
    if (!doc.releasedBasis.some(r => canonicalHash(r) === canonicalHash(release))) return conflict()
  }
  return parseDoc(doc)
}
export async function patchEntry(projectId: number, id: number, request: PatchRequest): Promise<EntryView> {
  return documentTransaction(async ex => {
    await assertContinuityProjectWritable(ex, projectId)
    const row = await entryRow(projectId, id, ex)
    if (row.status !== 'draft' || row.revision !== request.expectedRevision) return conflict()
    const old = await entryDocument(row, ex), doc = normalizePatch(old, request.doc)
    if (!PatchRequestSchema.safeParse({ ...request, doc }).success) return invalid()
    // SourcePick is a strict 4-field schema; the stored Source carries extra identity fields.
    const { runId, stepId, assetId, versionId } = doc.source
    const selected = await readSource(projectId, row.unitId, { runId, stepId, assetId, versionId }, ex)
    validateEntryEvidence(doc, selected.text)
    await validateSubjects(projectId, doc.subjects, ex)
    await validateDependencies(doc, ex, false)
    const ref = await writeDocument(ex, doc.unit, 'entry', doc, row.documentAssetId!)
    continuityIO().fault('before_publish')
    const updated = await ex.update(records).set({ revision: row.revision + 1, documentAssetId: ref.assetId,
      documentVersionId: ref.versionId, documentHash: ref.hash, updatedAt: continuityIO().now() })
      .where(and(eq(records.id, id), eq(records.status, 'draft'), eq(records.revision, request.expectedRevision), eq(records.documentVersionId, row.documentVersionId!))).returning()
    if (updated.length !== 1) return conflict()
    return entryView(updated[0]!, ex)
  })
}
export async function confirmEntry(projectId: number, id: number, request: ConfirmRequest): Promise<EntryView> {
  const parsed = ConfirmRequestSchema.safeParse(request)
  if (!parsed.success) return invalid()
  const hash = canonicalHash({ projectId, id, request: parsed.data })
  return documentTransaction(async ex => {
    const row = await entryRow(projectId, id, ex)
    const [approved] = await ex.select().from(records).where(and(eq(records.projectId, projectId), eq(records.rowType, 'entry'), eq(records.approvalKey, request.approvalKey))).limit(1)
    if (approved) {
      if (approved.id !== id || approved.approvalHash !== hash) return conflict()
      return entryView(approved, ex)
    }
    // 回放先返回、再拦新写（与 extract 同律）：归档/软删项目只拒绝新的确认，不改历史幂等语义。
    await assertContinuityProjectWritable(ex, projectId)
    if (row.status !== 'draft' || row.revision !== request.expectedRevision || canonicalHash(documentRef(row)) !== canonicalHash(request.document)) return conflict()
    const view = await entryView(row, ex), doc = view.doc!
    if (view.currentConfirmedId !== request.expectedCurrentConfirmedId || view.warningsHash !== request.warningsHash
      || doc.source.fingerprint !== request.sourceFingerprint || canonicalHash(entryWarnings(doc, view.history)) !== canonicalHash([...new Set(request.acceptedWarnings)].sort())) return conflict()
    await assertCurrentSource(doc.source, ex)
    if (view.validity !== 'valid') throw new ContinuityError('continuity_dependency_invalid', 409)
    await validateDependencies(doc, ex, true)
    const basis = await currentBasis(doc.unit, ex)
    foldEntries([...basis, { ref: { ...request.document, entryId: id, unitOrdinal: row.unitOrdinal }, doc }])
    const oldId = request.expectedCurrentConfirmedId
    if (oldId !== null) {
      const changed = await ex.update(records).set({ status: 'superseded', replacedById: id, updatedAt: continuityIO().now() })
        .where(and(eq(records.id, oldId), eq(records.projectId, projectId), eq(records.status, 'confirmed'))).returning()
      if (changed.length !== 1) return conflict()
    }
    continuityIO().fault('before_publish')
    const updated = await ex.update(records).set({ status: 'confirmed', revision: row.revision + 1,
      approvalKey: request.approvalKey, approvalHash: hash, confirmedAt: continuityIO().now(), updatedAt: continuityIO().now() })
      .where(and(eq(records.id, id), eq(records.status, 'draft'), eq(records.revision, request.expectedRevision),
        eq(records.documentAssetId, request.document.assetId), eq(records.documentVersionId, request.document.versionId), eq(records.documentHash, request.document.hash))).returning()
    if (updated.length !== 1) return conflict()
    return entryView(updated[0]!, ex)
  })
}
/**
 * 删除草稿登记：仅 draft 态允许删除（confirmed / superseded 受生命周期保护，不可直接删除）。
 * 前置条件：无子记录以 parentId 引用本条（复核草稿须先删），项目可写。
 * 删除后关联文档资产一并软删，避免悬空文件。
 */
export async function deleteDraftEntry(projectId: number, id: number): Promise<void> {
  return documentTransaction(async ex => {
    await assertContinuityProjectWritable(ex, projectId)
    const row = await entryRow(projectId, id, ex)
    if (row.status !== 'draft') throw new ContinuityError('continuity_conflict', 409)
    // 有子记录引用本条作为复核父级时拒绝删除，避免悬空 parentId
    const [child] = await ex.select({ id: records.id }).from(records)
      .where(and(eq(records.parentId, id), eq(records.projectId, projectId))).limit(1)
    if (child) throw new ContinuityError('continuity_entry_referenced', 409)
    // 删除登记行
    await ex.delete(records).where(and(eq(records.id, id), eq(records.projectId, projectId), eq(records.rowType, 'entry')))
    // 关联文档资产软删（documentAssetId 存在时标记 deletedAt）
    if (row.documentAssetId != null) {
      await ex.update(assets).set({ deletedAt: continuityIO().now() })
        .where(and(eq(assets.id, row.documentAssetId), eq(assets.projectId, projectId)))
    }
  })
}

export async function reviewEntry(projectId: number, episodeId: number, request: ReviewRequest): Promise<EntryView> {
  const parsed = ReviewRequestSchema.safeParse(request)
  if (!parsed.success) return invalid()
  const hash = canonicalHash({ kind: 'review', projectId, episodeId, request: parsed.data })
  return documentTransaction(async ex => {
    const unit = await resolveUnit(projectId, episodeId, ex)
    const existing = await findOperation(projectId, request.operationKey, hash, ex)
    if (existing) return entryView(existing, ex)
    // 回放命中先返回；新复核草稿才受项目可写守卫约束。
    await assertContinuityProjectWritable(ex, projectId)
    const parent = await entryRow(projectId, request.parentId, ex)
    if (parent.unitId !== episodeId || !['draft', 'confirmed', 'superseded'].includes(parent.status)) return conflict()
    const selected = await readSource(projectId, episodeId, request.source, ex)
    await assertCurrentSource(selected.source, ex)
    const old = await entryDocument(parent, ex)
    const doc = parseDoc({ ...old, unit, source: selected.source, history: selected.source.history })
    validateEntryEvidence(doc, selected.text)
    await validateSubjects(projectId, doc.subjects, ex)
    await validateDependencies(doc, ex, false)
    const ref = await writeDocument(ex, unit, 'entry', doc)
    continuityIO().fault('before_publish')
    const [row] = await ex.insert(records).values({ ...unit, rowType: 'entry', status: 'draft', parentId: parent.id,
      operationKey: request.operationKey, requestHash: hash, documentAssetId: ref.assetId, documentVersionId: ref.versionId, documentHash: ref.hash,
      sourceRunId: doc.source.runId, sourceStepId: doc.source.stepId, sourceAssetId: doc.source.assetId,
      sourceVersionId: doc.source.versionId, sourceHash: doc.source.hash, createdAt: continuityIO().now(), updatedAt: continuityIO().now() }).returning()
    return entryView(row!, ex)
  })
}
