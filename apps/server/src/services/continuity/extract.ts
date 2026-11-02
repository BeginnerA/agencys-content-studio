import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { contentContinuityRecords as records } from '../../db/schema'
import { BudgetBlockedError } from '../budget'
import { loadPromptTemplate, type ChatMessage, type LlmEndpoint } from '../llm'
import { resolveUnitPrice } from '../usage'
import { ContinuityError, EntryDocSchema, ExtractRequestSchema, ItemSchema, SourcePickSchema, SubjectSchema, TopicSchema, UseDocSchema,
  validateEntryEvidence, type ContinuityIO, type EntryDoc, type EntryRef, type EntryView, type Executor, type ExtractPreview,
  type ExtractRequest, type SourcePick } from './contract'
import { currentBasis, entryRow, entryView, findOperation, getEntry, validateDependencies } from './entries'
import { canonicalHash } from './fold'
import { assertContinuityProjectWritable } from './lifecycle'
import { continuityIO, withContinuityIO } from './runtime'
import { resolveUnit, validateSubjects } from './scope'
import { assertCurrentSource, readContinuityVersion, readSource } from './sources'
import { documentTransaction, writeDocument } from './store'
export { reviewEntry } from './entries'

export const EXTRACTION_LIMITS = { source: 120_000, input: 160_000, items: 200, value: 1_000, document: 200_000 } as const
const options = { temperature: 0, maxTokens: 24_000, timeoutMs: 600_000 }
const ModelDoc = z.strictObject({ subjects: z.array(SubjectSchema), topics: z.array(TopicSchema), items: z.array(ItemSchema).max(EXTRACTION_LIMITS.items),
  warnings: z.array(z.string()), noChanges: z.boolean() })
const invalid = (): never => { throw new ContinuityError('continuity_evidence_invalid', 400) }
const changed = (): never => { throw new ContinuityError('continuity_context_changed', 409) }
const tooLarge = (): never => { throw new ContinuityError('continuity_context_too_large', 413) }

async function material(projectId: number, episodeId: number, pick: SourcePick, ex: Executor) {
  const unit = await resolveUnit(projectId, episodeId, ex)
  const selected = await readSource(projectId, episodeId, pick, ex)
  const basis = await currentBasis(unit, ex)
  // A source may have been generated using recorded continuity. Preserve that full dependency set,
  // not merely the subset an extraction response mentions. No historical dependency is invented.
  const uses = await ex.select().from(records).where(and(eq(records.projectId, projectId), eq(records.rowType, 'consumption'),
    eq(records.runId, selected.source.runId), eq(records.stepId, selected.source.stepId), eq(records.status, 'completed'))).orderBy(records.id)
  for (const row of uses) {
    if (row.documentAssetId === null || row.documentVersionId === null || row.documentHash === null) throw new ContinuityError('continuity_dependency_invalid', 409)
    const text = await readContinuityVersion(ex, projectId, { assetId: row.documentAssetId, versionId: row.documentVersionId, hash: row.documentHash })
    let refs: EntryRef[]
    try { refs = UseDocSchema.parse(JSON.parse(text)).entries } catch { throw new ContinuityError('continuity_dependency_invalid', 409) }
    for (const ref of refs) {
      const found = basis.find(b => b.ref.entryId === ref.entryId)
      if (found) {
        if (canonicalHash(found.ref) !== canonicalHash(ref)) throw new ContinuityError('continuity_dependency_invalid', 409)
        continue
      }
      const previous = await entryRow(projectId, ref.entryId, ex)
      if (previous.scopeId !== unit.scopeId || ref.unitOrdinal >= unit.unitOrdinal) throw new ContinuityError('continuity_dependency_invalid', 409)
      const doc = EntryDocSchema.parse(JSON.parse(await readContinuityVersion(ex, projectId, ref)))
      basis.push({ ref, doc })
    }
  }
  basis.sort((a, b) => a.ref.unitOrdinal - b.ref.unitOrdinal)
  const warnings = selected.source.history === 'history_unavailable' ? ['history_unavailable'] : []
  for (let n = 1; n < unit.unitOrdinal; n++) if (!basis.some(b => b.ref.unitOrdinal === n)) warnings.push(`missing_or_invalid_entry:${n}`)
  return { unit, ...selected, basis, warnings }
}
type Material = Awaited<ReturnType<typeof material>>
function input(m: Material, prompt: string): ChatMessage[] {
  if (m.text.length > EXTRACTION_LIMITS.source) return tooLarge()
  const messages: ChatMessage[] = [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ source: m.source,
    sourceText: m.text, basis: m.basis, warnings: m.warnings }) }]
  if (JSON.stringify(messages).length > EXTRACTION_LIMITS.input) return tooLarge()
  return messages
}
function previewHash(m: Material, messages: ChatMessage[], endpoint: LlmEndpoint, prices: (number | null)[]) {
  return canonicalHash({ source: m.source, basis: m.basis, messages, promptVersion: 1,
    config: { baseUrl: endpoint.baseUrl, model: endpoint.model, provider: endpoint.providerKey, options, prices } })
}
async function prepare(projectId: number, episodeId: number, pick: SourcePick, io: ContinuityIO) {
  if (!SourcePickSchema.safeParse(pick).success) throw new ContinuityError('continuity_source_invalid', 400)
  const m = await material(projectId, episodeId, pick, db)
  const prompt = loadPromptTemplate('continuity-extract.md'), messages = input(m, prompt)
  const endpoint = await io.endpoint()
  const prices = await Promise.all((['tokens_in', 'tokens_out'] as const).map(unit => resolveUnitPrice({ kind: 'llm', provider: endpoint.providerKey, model: endpoint.model, unit })))
  const inputChars = JSON.stringify(messages).length
  const estimatedCost = prices.some(p => p === null) ? null : Math.ceil(inputChars / 4) * prices[0]! + options.maxTokens * prices[1]!
  const preview: ExtractPreview = { source: m.source, basis: m.basis.map(b => b.ref), warnings: m.warnings, inputChars, estimatedCost,
    previewHash: previewHash(m, messages, endpoint, prices) }
  return { m, prompt, messages, endpoint, prices, preview }
}
export async function previewExtraction(projectId: number, episodeId: number, pick: SourcePick): Promise<ExtractPreview> {
  return (await prepare(projectId, episodeId, pick, continuityIO())).preview
}
function parseResponse(content: string, m: Material): EntryDoc {
  if (content.length > EXTRACTION_LIMITS.document) return tooLarge()
  let data: z.infer<typeof ModelDoc>
  try { data = ModelDoc.parse(JSON.parse(content)) } catch { return invalid() }
  // AI cannot declare its output human-authored to evade citation requirements.
  if (data.items.some(i => i.origin !== 'extracted' || !i.evidence.length)) return invalid()
  const doc: EntryDoc = { schemaVersion: 1, unit: m.unit, source: m.source, history: m.source.history,
    basis: m.basis.map(b => b.ref), releasedBasis: [], ...data, warnings: [...new Set([...m.warnings, ...data.warnings])],
    items: data.items.map(i => ({ ...i, id: randomUUID() })) }
  if (JSON.stringify(doc).length > EXTRACTION_LIMITS.document) return tooLarge()
  validateEntryEvidence(doc, m.text)
  return doc
}

/** One logical request, one chat invocation. Never retry after a dispatch or unknown outcome. */
export async function extractEntry(projectId: number, episodeId: number, request: ExtractRequest, io?: ContinuityIO): Promise<EntryView> {
  if (io) return withContinuityIO(io, () => extractEntry(projectId, episodeId, request))
  const active = continuityIO(), parsed = ExtractRequestSchema.safeParse(request)
  if (!parsed.success) return invalid()
  request = parsed.data
  const requestHash = canonicalHash({ kind: 'extract', projectId, episodeId, request })
  await resolveUnit(projectId, episodeId, db)
  const previous = await findOperation(projectId, request.operationKey, requestHash, db)
  if (previous) return entryView(previous, db)
  const prepared = await prepare(projectId, episodeId, request.source, active)
  if (prepared.preview.previewHash !== request.previewHash) return changed()
  if (prepared.preview.estimatedCost === null && !request.acceptUnpriced) throw new ContinuityError('continuity_conflict', 409)
  if (!prepared.endpoint.baseUrl || !prepared.endpoint.apiKey || !prepared.endpoint.model) throw new ContinuityError('continuity_unsupported', 400)
  const blocked = await active.budget({ projectId, ...(prepared.preview.estimatedCost === null ? {} : { estimatedCost: prepared.preview.estimatedCost }) })
  if (blocked) throw new BudgetBlockedError(blocked.code, blocked.message)
  const occupied = await documentTransaction(async ex => {
    const winner = await findOperation(projectId, request.operationKey, requestHash, ex)
    if (winner) return { row: winner, owner: false }
    // 新认领的最终仲裁：写事务内复查项目仍可写，避免「预检后项目被 purge」仍落一条 extracting 台账。
    await assertContinuityProjectWritable(ex, projectId)
    const m = await material(projectId, episodeId, request.source, ex)
    if (previewHash(m, input(m, prepared.prompt), prepared.endpoint, prepared.prices) !== request.previewHash) return changed()
    await assertCurrentSource(m.source, ex)
    const [row] = await ex.insert(records).values({ ...m.unit, rowType: 'entry', status: 'extracting', operationKey: request.operationKey,
      requestHash, sourceRunId: m.source.runId, sourceStepId: m.source.stepId, sourceAssetId: m.source.assetId,
      sourceVersionId: m.source.versionId, sourceHash: m.source.hash, createdAt: active.now(), updatedAt: active.now() })
      .onConflictDoNothing({ target: [records.projectId, records.rowType, records.operationKey] }).returning()
    if (!row) {
      const winner = await findOperation(projectId, request.operationKey, requestHash, ex)
      if (!winner) throw new ContinuityError('continuity_conflict', 409)
      return { row: winner, owner: false }
    }
    return { row, owner: true }
  })
  if (!occupied.owner) return entryView(occupied.row, db)
  const id = occupied.row.id
  let dispatched = false, invalidResponse = false
  try {
    active.fault('before_dispatch')
    // Short transaction verifies the project is still writable and the original operation still exists,
    // immediately before dispatch: a purge committed between claim and dispatch must never send a request.
    await documentTransaction(async ex => {
      await assertContinuityProjectWritable(ex, projectId)
      const row = await entryRow(projectId, id, ex)
      if (row.status !== 'extracting') throw new ContinuityError('continuity_conflict', 409)
    })
    dispatched = true
    const result = await active.chat(prepared.messages, prepared.endpoint, options)
    active.fault('after_response')
    await active.usage({ projectId, provider: result.provider, model: result.model, usage: result.usage })
    let doc: EntryDoc
    try { doc = parseResponse(result.content, prepared.m) } catch (e) { invalidResponse = true; throw e }
    await documentTransaction(async ex => {
      // 响应回写：项目仍可写 + 原 record 仍存在且可写，两者缺一都不发布（不复活已删项目下的资产）。
      await assertContinuityProjectWritable(ex, projectId)
      const row = await entryRow(projectId, id, ex)
      if (row.status !== 'extracting') throw new ContinuityError('continuity_conflict', 409)
      await validateSubjects(projectId, doc.subjects, ex)
      await validateDependencies(doc, ex, false)
      // Preserve dispatched provenance even if the source changed; evaluateEntry exposes stale and
      // confirmation rechecks assertCurrentSource. Never silently rebind the result to newer text.
      const ref = await writeDocument(ex, doc.unit, 'entry', doc)
      active.fault('before_publish')
      const updated = await ex.update(records).set({ status: 'draft', revision: row.revision + 1, documentAssetId: ref.assetId,
        documentVersionId: ref.versionId, documentHash: ref.hash, updatedAt: active.now() })
        .where(and(eq(records.id, id), eq(records.status, 'extracting'), eq(records.revision, row.revision))).returning()
      if (updated.length !== 1) throw new ContinuityError('continuity_conflict', 409)
    })
    return await getEntry(projectId, id)
  } catch (e) {
    const status = !dispatched || invalidResponse ? 'failed' : 'unknown'
    const code = e instanceof ContinuityError && status === 'failed' ? e.code : status === 'unknown' ? 'continuity_outcome_unknown' : 'continuity_conflict'
    // 失败簿记不重发请求、不插资产：只经 entryRow → resolveUnit 复查项目/单元仍存在（不是
    // assertContinuityProjectWritable）。项目已删时这里整体失败，占位行保持原状，绝不复活。
    try {
      await documentTransaction(async ex => {
        await entryRow(projectId, id, ex)
        await ex.update(records).set({ status, errorCode: code, updatedAt: active.now() })
          .where(and(eq(records.id, id), eq(records.status, 'extracting')))
      })
    } catch { /* Missing project/record stays missing, without logging provider data. */ }
    throw new ContinuityError(code, status === 'failed' && e instanceof ContinuityError ? e.status : 409, id)
  }
}
