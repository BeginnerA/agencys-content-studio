import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { db } from '../../db'
import { contentContinuityRecords as records } from '../../db/schema'
import { ApprovalSchema, ContextDocSchema, ContinuityError, FreezeRequestSchema, PreviewRequestSchema, PreviewSchema,
  type Approval, type ContextDoc, type DuplicateCostAcceptance, type EntryDoc, type EntryRef, type Executor,
  type FreezeRequest, type Gap, type Preview, type PreviewRequest, type TargetRequest, type Unit } from './contract'
import { canonicalHash } from './fold'
import { currentConfirmed, documentRef, entryDocument } from './entries'
import { assertContinuityProjectWritable } from './lifecycle'
import { continuityIO } from './runtime'
import { RENDERER_VERSION, renderContinuity } from './render'
import { readContinuityVersion } from './sources'
import { TARGET_LIMITS, materializeTarget, resolveTarget } from './targets'
import { documentTransaction, writeDocument } from './store'
import { evaluateEntry } from './validity'

type Packed = { ref: EntryRef; doc: EntryDoc }[]

const gapOf = (unitOrdinal: number, kind: Gap['kind'], entryId: number | null, documentHash: string | null): Gap => {
  const key = `ep:${unitOrdinal}`
  return { key, unitOrdinal, kind, entryId,
    fingerprint: canonicalHash({ key, unitOrdinal, kind, entryId, documentHash }) }
}

/** Gaps are listed for every ordinal 1..N-1, even episodes that never existed; only current
 * confirmed valid entries join the pack, and history_unavailable is a separately accepted gap. */
async function collectPack(unit: Unit, ex: Executor): Promise<{ pack: Packed; gaps: Gap[] }> {
  const rows = await ex.select().from(records).where(and(eq(records.projectId, unit.projectId), eq(records.scopeId, unit.scopeId),
    eq(records.rowType, 'entry'), eq(records.status, 'confirmed'), lt(records.unitOrdinal, unit.unitOrdinal)))
  const byOrdinal = new Map<number, typeof records.$inferSelect>(rows.map(row => [row.unitOrdinal, row]))
  const pack: Packed = [], gaps: Gap[] = []
  for (let ordinal = 1; ordinal < unit.unitOrdinal; ordinal++) {
    const row = byOrdinal.get(ordinal)
    if (!row) { gaps.push(gapOf(ordinal, 'missing_entry', null, null)); continue }
    if ((await evaluateEntry(row.id, ex)).validity !== 'valid') {
      gaps.push(gapOf(ordinal, 'invalid_entry', row.id, row.documentHash)); continue
    }
    const doc = await entryDocument(row, ex)
    pack.push({ ref: { ...documentRef(row), entryId: row.id, unitOrdinal: ordinal }, doc })
    if (doc.history === 'history_unavailable') gaps.push(gapOf(ordinal, 'history_unavailable', row.id, row.documentHash))
  }
  return { pack, gaps }
}

/** Only a resume target can carry an undecided prior call; its id and status are part of the preview hash.
 *  undecided = unknown + dispatching（请求已发出但无回执）：resume 侧两类都要求精确同意，
 *  冻结侧必须同样呈现，否则 dispatching 遗留会变成「闸要求同意、确认面却给不出」的死路。 */
async function pendingUnknownUse(projectId: number, request: TargetRequest,
    ex: Executor): Promise<{ id: number; status: string } | null> {
  if (request.kind !== 'resume') return null
  const [row] = await ex.select().from(records).where(and(eq(records.projectId, projectId), eq(records.rowType, 'consumption'),
    eq(records.runId, request.runId), inArray(records.status, ['unknown', 'dispatching']))).orderBy(desc(records.id)).limit(1)
  return row ? { id: row.id, status: row.status } : null
}

async function buildPreview(projectId: number, request: PreviewRequest, ex: Executor): Promise<Preview> {
  const material = await resolveTarget(projectId, request.target, ex)
  const { pack, gaps } = await collectPack(material.target.unit, ex)
  const rendered = renderContinuity(pack, request.includePlans)
  if (rendered.length > TARGET_LIMITS.render) throw new ContinuityError('continuity_context_too_large', 413)
  // Basis edges must land inside the pack; a missing or diverged dependency fails closed.
  const packRefs = new Map<number, EntryRef>(pack.map(entry => [entry.ref.entryId, entry.ref]))
  const dependencies = pack.flatMap(entry => entry.doc.basis.map(basisRef => {
    const target = packRefs.get(basisRef.entryId)
    if (!target || canonicalHash(target) !== canonicalHash(basisRef)) {
      throw new ContinuityError('continuity_dependency_invalid', 409)
    }
    return { from: entry.ref, to: basisRef }
  })).sort((a, b) => a.from.entryId - b.from.entryId || a.to.entryId - b.to.entryId)
  const renderedHash = createHash('sha256').update(rendered, 'utf8').digest('hex')
  const unknown = await pendingUnknownUse(projectId, material.target.request, ex)
  const unknownUse = unknown ? { useId: unknown.id, status: unknown.status } : null
  const entries = pack.map(entry => entry.ref)
  const previewHash = canonicalHash({ kind: 'context_preview', rendererVersion: RENDERER_VERSION,
    target: material.target, entries, dependencies, gaps, includePlans: request.includePlans, renderedHash, unknownUse })
  // Conservative Task-4 bound: rendered ledger plus the enabled input must fit the future call budget.
  const blockers = rendered.length > material.maxChars
    || rendered.length + JSON.stringify(material.input).length > TARGET_LIMITS.input
    ? ['continuity_context_too_large'] : []
  const doc: ContextDoc = { schemaVersion: 1, rendererVersion: RENDERER_VERSION, target: material.target, entries,
    dependencies, gaps, acceptedGaps: [], includePlans: request.includePlans, rendered, renderedHash, previewHash,
    duplicateCostAcceptance: null }
  return PreviewSchema.parse({ doc, chars: rendered.length, maxChars: material.maxChars,
    canFreeze: blockers.length === 0, blockers, unknownUseId: unknown ? unknown.id : null })
}

export async function previewContext(projectId: number, request: PreviewRequest): Promise<Preview> {
  const parsed = PreviewRequestSchema.safeParse(request)
  if (!parsed.success) throw new ContinuityError('continuity_evidence_invalid', 400)
  return buildPreview(projectId, parsed.data, db)
}

async function findContextOperation(projectId: number, key: string, requestHash: string, ex: Executor): Promise<Approval | null> {
  const [row] = await ex.select().from(records).where(and(eq(records.projectId, projectId), eq(records.rowType, 'context'),
    eq(records.operationKey, key))).limit(1)
  if (!row) return null
  if (row.requestHash !== requestHash) throw new ContinuityError('continuity_conflict', 409)
  return { contextId: row.id, document: documentRef(row), approvalHash: row.approvalHash! }
}

/** Replayed operation keys return the original approval; otherwise the pack is recomputed fresh and
 * every handle (previewHash, gap fingerprints, unknown use) is re-derived server-side, never trusted. */
export async function freezeContext(projectId: number, request: FreezeRequest): Promise<Approval> {
  const parsed = FreezeRequestSchema.safeParse(request)
  if (!parsed.success) throw new ContinuityError('continuity_evidence_invalid', 400)
  const req = parsed.data
  const requestHash = canonicalHash({ kind: 'context_freeze', projectId, request: req })
  const replay = await findContextOperation(projectId, req.operationKey, requestHash, db)
  if (replay) return replay
  const fresh = await buildPreview(projectId, { target: req.target, includePlans: req.includePlans }, db)
  if (fresh.doc.previewHash !== req.previewHash) throw new ContinuityError('continuity_context_changed', 409)
  // Acceptances must equal the expected gap set exactly: no missing, no extra, no duplicate, no stale key.
  const expected = fresh.doc.gaps.map(gap => `${gap.key}:${gap.fingerprint}`).sort()
  const accepted = req.acceptedGaps.map(item => `${item.key}:${item.fingerprint}`).sort()
  if (new Set(accepted).size !== accepted.length || JSON.stringify(expected) !== JSON.stringify(accepted)) {
    throw new ContinuityError('continuity_gaps_unaccepted', 409)
  }
  if (!fresh.canFreeze) throw new ContinuityError('continuity_context_too_large', 413)
  const pending = fresh.unknownUseId
  let consent: DuplicateCostAcceptance | null = null
  if (req.duplicateCostAcceptance !== undefined) {
    if (req.target.kind !== 'resume') throw new ContinuityError('continuity_unsupported', 400)
    if (pending === null || req.duplicateCostAcceptance.useId !== pending) throw new ContinuityError('continuity_conflict', 409)
    consent = { useId: pending, accepted: true }
  } else if (pending !== null) {
    throw new ContinuityError('continuity_outcome_unknown', 409)
  }
  // Acceptances and consent live only in the approval hash, never in the preview hash.
  const approvalHash = canonicalHash({ kind: 'context_approval', projectId, previewHash: req.previewHash,
    acceptedGaps: accepted, duplicateCostAcceptance: consent })
  const endpoint = await continuityIO().endpoint()
  return documentTransaction(async ex => {
    // 新冻结认领的最终仲裁：写事务内复查项目仍可写（并发 purge 与冻结只能有一个落定）。
    await assertContinuityProjectWritable(ex, projectId)
    const material = await materializeTarget(projectId, req.target, ex, endpoint)
    if (canonicalHash(material.target) !== canonicalHash(fresh.doc.target)) {
      throw new ContinuityError('continuity_context_changed', 409)
    }
    for (const ref of fresh.doc.entries) {
      const [row] = await ex.select().from(records).where(and(eq(records.id, ref.entryId), eq(records.projectId, projectId),
        eq(records.rowType, 'entry'))).limit(1)
      // Each packed entry must still be the confirmed head of its OWN prior episode, not the target unit.
      if (!row || row.status !== 'confirmed' || row.unitOrdinal !== ref.unitOrdinal
        || canonicalHash(documentRef(row)) !== canonicalHash({ assetId: ref.assetId, versionId: ref.versionId, hash: ref.hash })
        || (await currentConfirmed(row as Unit, ex)) !== row.id
        || (await evaluateEntry(row.id, ex)).validity !== 'valid') {
        throw new ContinuityError('continuity_source_changed', 409)
      }
    }
    const stillPending = await pendingUnknownUse(projectId, req.target, ex)
    if ((stillPending?.id ?? null) !== pending) throw new ContinuityError('continuity_context_changed', 409)
    // The stored document adds only what the user explicitly submitted on top of the reviewed preview.
    const doc: ContextDoc = { ...fresh.doc, acceptedGaps: req.acceptedGaps, duplicateCostAcceptance: consent }
    const ref = await writeDocument(ex, material.target.unit, 'context', doc)
    continuityIO().fault('before_publish')
    const [row] = await ex.insert(records).values({ ...material.target.unit, rowType: 'context', status: 'frozen',
      operationKey: req.operationKey, requestHash, approvalHash, documentAssetId: ref.assetId,
      documentVersionId: ref.versionId, documentHash: ref.hash, createdAt: continuityIO().now(), updatedAt: continuityIO().now() })
      .onConflictDoNothing({ target: [records.projectId, records.rowType, records.operationKey] }).returning()
    if (!row) {
      const winner = await findContextOperation(projectId, req.operationKey, requestHash, ex)
      if (!winner) throw new ContinuityError('continuity_conflict', 409)
      return winner
    }
    return { contextId: row.id, document: ref, approvalHash }
  })
}

/** The approval handle proves nothing by itself: ownership, status, hash and document must all match the row. */
export async function readContext(projectId: number, approval: Approval, ex: Executor): Promise<ContextDoc> {
  const parsed = ApprovalSchema.safeParse(approval)
  if (!parsed.success) throw new ContinuityError('continuity_evidence_invalid', 400)
  const [row] = await ex.select().from(records).where(and(eq(records.id, parsed.data.contextId),
    eq(records.projectId, projectId), eq(records.rowType, 'context'))).limit(1)
  if (!row || (row.status !== 'frozen' && row.status !== 'bound')) {
    throw new ContinuityError('continuity_source_invalid', 404)
  }
  if (row.approvalHash !== parsed.data.approvalHash || canonicalHash(documentRef(row)) !== canonicalHash(parsed.data.document)) {
    throw new ContinuityError('continuity_source_changed', 409)
  }
  const text = await readContinuityVersion(ex, projectId, parsed.data.document)
  try { return ContextDocSchema.parse(JSON.parse(text)) } catch {
    throw new ContinuityError('continuity_evidence_invalid', 400)
  }
}
