import { and, eq, isNull } from 'drizzle-orm'
import { assets, contentContinuityRecords as records } from '../../db/schema'
import { ContinuityError, DocRefSchema, EntryDocSchema, validateEntryEvidence, type EntryDoc,
  type Executor, type History, type Validity } from './contract'
import { resolveUnit, validateSubjects } from './scope'
import { assertCurrentSource, readContinuityVersion, readSource } from './sources'

/** Lifecycle (draft/confirmed/superseded) is separate; only actual basis edges propagate staleness. */
export async function evaluateEntry(id: number, ex: Executor): Promise<{ validity: Validity; history: History; reasons: string[] }> {
  const visited = new Set<number>()
  // Completed results belong only to this call and its executor, never to a later evaluation.
  const completed = new Map<number, Awaited<ReturnType<typeof evaluateEntry>>>()
  async function evaluate(entryId: number): ReturnType<typeof evaluateEntry> {
    if (visited.has(entryId)) return { validity: 'corrupt', history: 'history_unavailable', reasons: ['basis_cycle', 'history_unavailable'] }
    const cached = completed.get(entryId)
    if (cached) return cached
    const state = await evaluateUncached(entryId)
    completed.set(entryId, state)
    return state
  }
  async function evaluateUncached(entryId: number): ReturnType<typeof evaluateEntry> {
    let history: History = 'history_unavailable'
    const reasons: string[] = []
    const result = (validity: Validity, reason?: string) => ({ validity, history,
      reasons: [...new Set([...reasons, ...(reason ? [reason] : []), ...(history === 'history_unavailable' ? ['history_unavailable'] : [])])] })
    visited.add(entryId)
    try {
      const [row] = await ex.select().from(records).where(and(eq(records.id, entryId), eq(records.rowType, 'entry'))).limit(1)
      if (!row) return result('missing', 'entry_missing')
      const ref = DocRefSchema.safeParse({ assetId: row.documentAssetId, versionId: row.documentVersionId, hash: row.documentHash })
      if (!ref.success) return result(row.documentAssetId === null ? 'missing' : 'corrupt', 'document_missing')
      let doc: EntryDoc
      try {
        const text = await readContinuityVersion(ex, row.projectId, ref.data)
        const parsed = EntryDocSchema.safeParse(JSON.parse(text))
        if (!parsed.success) return result('corrupt', 'document_invalid')
        doc = parsed.data
        history = doc.history
      } catch (e) {
        if (e instanceof ContinuityError) return result(e.status === 404 ? 'missing' : 'corrupt', 'document_unavailable')
        if (e instanceof SyntaxError) return result('corrupt', 'document_invalid')
        throw e
      }
      const [asset] = await ex.select({ id: assets.id }).from(assets).where(and(eq(assets.id, ref.data.assetId),
        eq(assets.projectId, row.projectId), eq(assets.kind, 'text'), isNull(assets.deletedAt))).limit(1)
      if (!asset) return result('missing', 'document_asset_missing')
      for (const field of ['projectId', 'scopeKind', 'scopeId', 'unitKind', 'unitId', 'unitOrdinal'] as const) {
        if (doc.unit[field] !== row[field]) return result('corrupt', 'unit_mismatch')
      }
      if (row.sourceRunId !== doc.source.runId || row.sourceStepId !== doc.source.stepId || row.sourceAssetId !== doc.source.assetId
        || row.sourceVersionId !== doc.source.versionId || row.sourceHash !== doc.source.hash) return result('corrupt', 'source_mismatch')
      try {
        const unit = await resolveUnit(row.projectId, row.unitId, ex)
        if (unit.scopeId !== row.scopeId || unit.unitOrdinal !== row.unitOrdinal) return result('stale', 'unit_changed')
      } catch (e) {
        if (e instanceof ContinuityError) return result(e.status === 404 ? 'missing' : 'corrupt', 'unit_unavailable')
        throw e
      }
      try { await validateSubjects(row.projectId, doc.subjects, ex) }
      catch (e) {
        if (e instanceof ContinuityError) return result('corrupt', 'entity_invalid')
        throw e
      }
      try {
        const { runId, stepId, assetId, versionId } = doc.source
        const selected = await readSource(row.projectId, row.unitId, { runId, stepId, assetId, versionId }, ex)
        if (selected.source.history === 'history_unavailable') history = 'history_unavailable'
        validateEntryEvidence(doc, selected.text)
        await assertCurrentSource(doc.source, ex)
      } catch (e) {
        if (!(e instanceof ContinuityError)) throw e
        if (e.code === 'continuity_evidence_invalid') return result('corrupt', 'evidence_invalid')
        return result(e.status === 404 ? 'missing' : e.status === 409 ? 'stale' : 'corrupt', e.status === 404 ? 'source_missing' : e.code)
      }
      for (const basis of doc.basis) {
        const [prior] = await ex.select().from(records).where(eq(records.id, basis.entryId)).limit(1)
        if (!prior || prior.rowType !== 'entry' || prior.projectId !== row.projectId || prior.scopeKind !== row.scopeKind
          || prior.scopeId !== row.scopeId || prior.unitKind !== row.unitKind || prior.unitOrdinal >= row.unitOrdinal
          || prior.unitOrdinal !== basis.unitOrdinal || prior.documentAssetId !== basis.assetId
          || prior.documentVersionId !== basis.versionId || prior.documentHash !== basis.hash) return result('stale', 'basis_changed')
        const [head] = await ex.select({ id: records.id }).from(records).where(and(eq(records.projectId, row.projectId),
          eq(records.scopeKind, row.scopeKind), eq(records.scopeId, row.scopeId), eq(records.unitKind, row.unitKind),
          eq(records.unitId, prior.unitId), eq(records.rowType, 'entry'), eq(records.status, 'confirmed'))).limit(1)
        if (head?.id !== basis.entryId) return result('stale', 'basis_not_current')
        const state = await evaluate(basis.entryId)
        if (state.history === 'history_unavailable') history = 'history_unavailable'
        if (state.validity !== 'valid') return result('stale', 'basis_invalid')
      }
      return result('valid')
    } finally { visited.delete(entryId) }
  }
  return evaluate(id)
}
