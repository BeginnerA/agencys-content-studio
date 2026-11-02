import { z } from 'zod'
import type { db } from '../../db'
import type { Template } from '../../pipeline/types'
import type { ChatMessage, LlmResult, chatCompleteDetailed, resolveLlmEndpoint } from '../llm'
import type { checkBudget } from '../budget'
import type { recordLlmUsage } from '../usage'

export const ContinuityCodeSchema = z.enum([
  'continuity_source_invalid', 'continuity_source_changed', 'continuity_conflict',
  'continuity_evidence_invalid', 'continuity_dependency_invalid', 'continuity_gaps_unaccepted',
  'continuity_context_too_large', 'continuity_context_changed', 'continuity_context_claimed',
  'continuity_unsupported', 'continuity_outcome_unknown',
  // Task10 生命周期面（设计 §12）：在途台账拒绝删项目 / 已确认登记拒绝删集
  'continuity_in_flight', 'continuity_entry_referenced',
])
export class ContinuityError extends Error {
  constructor(public readonly code: z.infer<typeof ContinuityCodeSchema>, public readonly status: 400 | 404 | 409 | 413,
    public readonly operationId?: number) {
    super(code)
    this.name = 'ContinuityError'
  }
}
export type Executor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>
export type ContinuityIO = {
  chat: typeof chatCompleteDetailed; endpoint: typeof resolveLlmEndpoint; budget: typeof checkBudget
  usage: typeof recordLlmUsage; now: () => number
  fault: (point: 'before_dispatch' | 'after_response' | 'before_publish') => void
}
const id = z.number().int().positive()
const count = z.number().int().nonnegative()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const key = z.string().min(1).refine(v => v.trim().length > 0, 'Must not be blank')
const operationKey = z.string().regex(/^[A-Za-z0-9_-]{8,120}$/)
const strings = z.array(z.string())
const jsonRecord = z.record(z.string(), z.json())
const boundedDocument = <T>(value: T) => JSON.stringify(value).length <= 200_000
export const ValiditySchema = z.enum(['valid', 'stale', 'missing', 'corrupt'])
export const HistorySchema = z.enum(['known', 'history_unavailable'])
export const UnitSchema = z.strictObject({
  projectId: id, scopeKind: z.literal('series'), scopeId: id,
  unitKind: z.literal('episode'), unitId: id, unitOrdinal: id,
})
export const DocRefSchema = z.strictObject({ assetId: id, versionId: id, hash })
export const EntryRefSchema = DocRefSchema.extend({ entryId: id, unitOrdinal: id })
export const ItemRefSchema = EntryRefSchema.extend({ itemId: key })
export const SourcePickSchema = z.strictObject({ runId: id, stepId: id, assetId: id, versionId: id })
export const SourceSchema = z.strictObject({
  ...SourcePickSchema.shape, ...UnitSchema.shape, templateKey: key, templateSnapshotHash: hash,
  stepKey: key, hash, outputHash: hash, gateHash: hash, fingerprint: hash,
  history: HistorySchema, inheritedViaRunId: id.nullable(),
})
export const SubjectSchema = z.strictObject({ key, label: key, entityId: id.nullable(), aliases: z.array(key) })
export const TopicSchema = z.strictObject({ key, label: key })
export const EvidenceSchema = z.strictObject({ start: count, end: count, quote: z.string().min(1) })
  .refine(e => e.end > e.start && e.end <= 120_000 && e.end - e.start === e.quote.length, 'Invalid UTF-16 evidence interval')
const itemFields = {
  id: key, topicKey: key, type: z.enum(['event', 'state', 'relationship', 'possession', 'thread']),
  operation: z.enum(['set', 'close', 'retract']), subjects: z.array(key), value: key.max(1000),
  previous: ItemRefSchema.nullable(), evidence: z.array(EvidenceSchema),
  origin: z.enum(['extracted', 'manual', 'edited']), editNote: z.string(), included: z.boolean(),
}
export const ItemSchema = z.discriminatedUnion('channel', [
  z.strictObject({ ...itemFields, channel: z.literal('fact') }),
  z.strictObject({ ...itemFields, channel: z.literal('plan') }),
  z.strictObject({ ...itemFields, channel: z.literal('knowledge'), knower: key, epistemic: z.enum(['knows', 'believes', 'unaware', 'unknown']) }),
]).superRefine((item, ctx) => {
  if (item.origin === 'extracted' && !item.evidence.length) ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Extracted items require evidence' })
  if (item.origin !== 'extracted' && !item.editNote.trim()) ctx.addIssue({ code: 'custom', path: ['editNote'], message: 'Manual or edited items require an explanation' })
})
export const GapSchema = z.strictObject({ key, unitOrdinal: id, kind: z.enum(['missing_entry', 'invalid_entry', 'history_unavailable']), entryId: id.nullable(), fingerprint: hash })
export const AcceptanceSchema = z.strictObject({ key, fingerprint: hash, reason: key })
export const EntryDocSchema = z.strictObject({
  schemaVersion: z.literal(1), unit: UnitSchema, source: SourceSchema, basis: z.array(EntryRefSchema),
  history: HistorySchema, subjects: z.array(SubjectSchema), topics: z.array(TopicSchema),
  items: z.array(ItemSchema).max(200), warnings: strings, noChanges: z.boolean(),
  releasedBasis: z.array(z.strictObject({ ref: EntryRefSchema, reason: key })),
}).superRefine((doc, ctx) => {
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message })
  const unique = (values: string[], field: string) => {
    if (new Set(values).size !== values.length) fail([field], 'Duplicate explicit key')
  }
  unique(doc.subjects.map(s => s.key), 'subjects')
  unique(doc.topics.map(t => t.key), 'topics')
  unique(doc.items.map(i => i.id), 'items')
  const subjects = new Set(doc.subjects.map(s => s.key))
  const topics = new Set(doc.topics.map(t => t.key))
  for (const field of ['projectId', 'scopeKind', 'scopeId', 'unitKind', 'unitId', 'unitOrdinal'] as const) {
    if (doc.source[field] !== doc.unit[field]) fail(['source', field], 'Source and unit identity differ')
  }
  if (doc.history !== doc.source.history) fail(['history'], 'Source history differs')
  if (doc.noChanges !== !doc.items.some(i => i.included)) fail(['noChanges'], 'Empty changes require explicit noChanges')
  const refKey = (r: EntryRef) => JSON.stringify([r.entryId, r.assetId, r.versionId, r.hash, r.unitOrdinal])
  unique(doc.basis.map(r => String(r.entryId)), 'basis')
  unique(doc.releasedBasis.map(r => String(r.ref.entryId)), 'releasedBasis')
  const basis = new Set(doc.basis.map(refKey))
  for (const [n, ref] of doc.basis.entries()) {
    if (ref.unitOrdinal >= doc.unit.unitOrdinal) fail(['basis', n], 'Basis must precede this episode')
  }
  for (const [n, release] of doc.releasedBasis.entries()) {
    if (release.ref.unitOrdinal >= doc.unit.unitOrdinal || doc.basis.some(r => r.entryId === release.ref.entryId)) {
      fail(['releasedBasis', n], 'Released basis must be prior and not still active')
    }
  }
  for (const [n, item] of doc.items.entries()) {
    if (!topics.has(item.topicKey)) fail(['items', n, 'topicKey'], 'Topic must be explicitly declared')
    if (new Set(item.subjects).size !== item.subjects.length || item.subjects.some(k => !subjects.has(k))) {
      fail(['items', n, 'subjects'], 'Subjects must be distinct explicit keys, not inferred aliases')
    }
    if (item.channel === 'knowledge' && !subjects.has(item.knower)) fail(['items', n, 'knower'], 'Knower must be explicitly declared')
    if (item.previous && (item.previous.unitOrdinal >= doc.unit.unitOrdinal || !basis.has(refKey(item.previous)))) {
      fail(['items', n, 'previous'], 'Previous must be an exact earlier basis version')
    }
  }
}).refine(boundedDocument, 'Entry document exceeds 200000 UTF-16 code units')

const entryViewFields = {
  id, revision: count, operationKey, validity: ValiditySchema, history: HistorySchema,
  warningsHash: hash, currentConfirmedId: id.nullable(), errorCode: key.nullable(),
}
const successfulView = { document: DocRefSchema, doc: EntryDocSchema }
const placeholderView = z.union([
  z.strictObject({ ...entryViewFields, ...successfulView, status: z.enum(['extracting', 'failed', 'unknown']) }),
  z.strictObject({ ...entryViewFields, document: z.null(), doc: z.null(), status: z.enum(['extracting', 'failed', 'unknown']) }),
])
export const EntryViewSchema = z.union([
  placeholderView,
  z.strictObject({ ...entryViewFields, ...successfulView, status: z.enum(['draft', 'confirmed', 'superseded']) }),
])
export const TargetRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual'), episodeId: id, templateKey: key, input: jsonRecord }),
  z.strictObject({ kind: z.literal('route'), sessionId: id, decisionRevision: count, decisionHash: hash }),
  z.strictObject({ kind: z.literal('workflow'), workflowId: id, nextSeq: count, previousRunId: id.nullable() }),
  z.strictObject({ kind: z.literal('resume'), runId: id }),
])
export const TargetSchema = z.strictObject({
  unit: UnitSchema, request: TargetRequestSchema, templateKey: key, templateSnapshotHash: hash,
  stepKey: key, inputHash: hash, configHash: hash,
})
export const PreviewRequestSchema = z.strictObject({ target: TargetRequestSchema, includePlans: z.boolean() })
export const DuplicateCostAcceptanceSchema = z.strictObject({ useId: id, accepted: z.literal(true) })
export const ContextDocSchema = z.strictObject({
  schemaVersion: z.literal(1), rendererVersion: z.literal(1), target: TargetSchema,
  entries: z.array(EntryRefSchema), dependencies: z.array(z.strictObject({ from: EntryRefSchema, to: EntryRefSchema })),
  gaps: z.array(GapSchema), acceptedGaps: z.array(AcceptanceSchema), includePlans: z.boolean(),
  rendered: z.string().max(24_000), renderedHash: hash, previewHash: hash,
  duplicateCostAcceptance: DuplicateCostAcceptanceSchema.nullable(),
})
export const PreviewSchema = z.strictObject({
  doc: ContextDocSchema, chars: count, maxChars: id.max(24_000), canFreeze: z.boolean(), blockers: strings, unknownUseId: id.nullable(),
})
export const ApprovalSchema = z.strictObject({ contextId: id, document: DocRefSchema, approvalHash: hash })
export const FreezeRequestSchema = PreviewRequestSchema.extend({
  previewHash: hash, acceptedGaps: z.array(AcceptanceSchema), operationKey,
  duplicateCostAcceptance: DuplicateCostAcceptanceSchema.optional(),
})
export const ConfirmRequestSchema = z.strictObject({
  expectedRevision: count, document: DocRefSchema, sourceFingerprint: hash, warningsHash: hash,
  expectedCurrentConfirmedId: id.nullable(), acceptedWarnings: strings, approvalKey: operationKey,
})
export const ExtractPreviewSchema = z.strictObject({
  source: SourceSchema, basis: z.array(EntryRefSchema), previewHash: hash, inputChars: count.max(160_000),
  warnings: strings, estimatedCost: z.number().nonnegative().nullable(),
})
export const ExtractRequestSchema = z.strictObject({ source: SourcePickSchema, previewHash: hash, operationKey, allowModelCall: z.literal(true), acceptUnpriced: z.boolean() })
export const ReviewRequestSchema = z.strictObject({ parentId: id, source: SourcePickSchema, operationKey })
export const PatchRequestSchema = z.strictObject({ expectedRevision: count, doc: EntryDocSchema })

export const ChatMessageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant']), content: z.union([z.string(), z.array(z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), text: z.string() }),
    z.strictObject({ type: z.literal('image_url'), image_url: z.strictObject({ url: z.string() }) }),
  ]))]),
}) satisfies z.ZodType<ChatMessage>
export const UsageSchema = z.strictObject({ promptTokens: count, completionTokens: count, totalTokens: count }).nullable() satisfies z.ZodType<LlmResult['usage']>
const useFields = {
  schemaVersion: z.literal(1), context: DocRefSchema, entries: z.array(EntryRefSchema), runId: id, stepId: id,
  round: key, messages: z.array(ChatMessageSchema).min(1).refine(v => JSON.stringify(v).length <= 160_000, 'Messages exceed 160000 code units'),
  messagesHash: hash, provider: key, model: key, configHash: hash, sourceChangedAfterDispatch: z.boolean(),
}
export const UseDocSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...useFields, state: z.literal('prepared'), submitted: z.literal(false), billing: z.literal('not_submitted'),
    startedAt: z.null(), completedAt: z.null(), output: z.null(), usage: z.null(), errorCode: z.null(), sourceChangedAfterDispatch: z.literal(false) }),
  z.strictObject({ ...useFields, state: z.literal('dispatching'), submitted: z.null(), billing: z.literal('unknown'),
    startedAt: count, completedAt: z.null(), output: z.null(), usage: z.null(), errorCode: z.null(), sourceChangedAfterDispatch: z.literal(false) }),
  z.strictObject({ ...useFields, state: z.literal('completed'), submitted: z.literal(true), billing: z.enum(['recorded', 'unknown']),
    startedAt: count, completedAt: count, output: DocRefSchema, usage: UsageSchema, errorCode: z.null() }),
  z.strictObject({ ...useFields, state: z.literal('failed'), submitted: z.literal(false), billing: z.literal('not_submitted'),
    startedAt: count.nullable(), completedAt: count, output: z.null(), usage: z.null(), errorCode: key, sourceChangedAfterDispatch: z.literal(false) }),
  z.strictObject({ ...useFields, state: z.literal('unknown'), submitted: z.literal(true).nullable(), billing: z.enum(['recorded', 'unknown']),
    startedAt: count, completedAt: count.nullable(), output: z.null(), usage: UsageSchema, errorCode: key }),
]).refine(v => v.startedAt === null || v.completedAt === null || v.completedAt >= v.startedAt, 'Completion precedes dispatch')
export const SourceCandidateSchema = z.strictObject({
  runId: id, stepId: id, stepKey: key, title: z.string(), assetId: id, versionId: id.nullable(), versions: z.array(DocRefSchema),
  currentHash: hash, confirmable: z.boolean(), reasons: strings, declaredRole: z.boolean(), inheritedViaRunId: id.nullable(),
})
/** Downstream impact of one consumption row: direct pack consumers, indirect basis-descendants and missing-evidence rows. */
export const ImpactRowSchema = z.strictObject({
  recordId: id, kind: z.enum(['entry', 'use']), unitOrdinal: id, runId: id.nullable(), stepId: id.nullable(),
  state: key, document: DocRefSchema.nullable(), reason: key, inheritedViaRunId: id.nullable(),
})
export const ImpactViewSchema = z.strictObject({
  direct: z.array(ImpactRowSchema), indirect: z.array(ImpactRowSchema), unknown: z.array(ImpactRowSchema),
})
// Template is an existing in-process contract, not an unvalidated unknown placeholder.
export const TemplateSchema = z.strictObject({
  key, version: count, name: key, description: z.string().optional(), genre: key, scene: z.string().optional(), next: strings.optional(),
  inputs: z.array(z.strictObject({
    key, label: z.string().optional(), kind: z.enum(['text', 'files', 'int', 'float', 'bool', 'select', 'multi_select', 'date', 'publications']),
    required: z.boolean(), accept: strings.optional(), options: strings.optional(), option_labels: strings.optional(),
    default: z.union([z.string(), z.number(), z.boolean(), strings]).optional(),
  })), defaults: jsonRecord.optional(), steps: z.array(z.strictObject({
    key, action: key, title: z.string(), inputs: jsonRecord, params: jsonRecord.optional(),
    gate: z.strictObject({ mode: z.literal('required'), message: z.string(), skip_label: z.string().optional(), reject: z.literal('stop').optional(), when: z.union([z.string(), strings]).optional() }).optional(),
    batch: z.strictObject({ field: key, maxConcurrent: id.optional(), retry: count.optional() }).optional(),
    output: z.strictObject({ purpose: key }).optional(), when: z.union([z.string(), strings]).optional(), when_any: strings.optional(),
    after: strings.optional(), after_skipped: z.literal('continue').optional(),
  })),
}) satisfies z.ZodType<Template>
export const TargetMaterialSchema = z.strictObject({ unit: UnitSchema, templateKey: key, template: TemplateSchema, input: jsonRecord })

export type Unit = z.infer<typeof UnitSchema>
export type DocRef = z.infer<typeof DocRefSchema>
export type EntryRef = z.infer<typeof EntryRefSchema>
export type ItemRef = z.infer<typeof ItemRefSchema>
export type Validity = z.infer<typeof ValiditySchema>
export type History = z.infer<typeof HistorySchema>
export type SourcePick = z.infer<typeof SourcePickSchema>
export type Source = z.infer<typeof SourceSchema>
export type Subject = z.infer<typeof SubjectSchema>
export type Topic = z.infer<typeof TopicSchema>
export type Item = z.infer<typeof ItemSchema>
export type Gap = z.infer<typeof GapSchema>
export type Acceptance = z.infer<typeof AcceptanceSchema>
export type EntryDoc = z.infer<typeof EntryDocSchema>
export type EntryView = z.infer<typeof EntryViewSchema>
export type TargetRequest = z.infer<typeof TargetRequestSchema>
export type Target = z.infer<typeof TargetSchema>
export type PreviewRequest = z.infer<typeof PreviewRequestSchema>
export type DuplicateCostAcceptance = z.infer<typeof DuplicateCostAcceptanceSchema>
export type ContextDoc = z.infer<typeof ContextDocSchema>
export type Preview = z.infer<typeof PreviewSchema>
export type Approval = z.infer<typeof ApprovalSchema>
export type FreezeRequest = z.infer<typeof FreezeRequestSchema>
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>
export type ExtractPreview = z.infer<typeof ExtractPreviewSchema>
export type ExtractRequest = z.infer<typeof ExtractRequestSchema>
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>
export type PatchRequest = z.infer<typeof PatchRequestSchema>
export type UseDoc = z.infer<typeof UseDocSchema>
export type SourceCandidate = z.infer<typeof SourceCandidateSchema>
export type TargetMaterial = z.infer<typeof TargetMaterialSchema>
export type ImpactRow = z.infer<typeof ImpactRowSchema>
export type ImpactView = z.infer<typeof ImpactViewSchema>

/** Caller supplies the selected immutable source version, never the current asset.
 * A matching quote proves the citation, not the interpretation; human confirmation remains mandatory.
 */
export function validateEntryEvidence(doc: EntryDoc, sourceText: string): void {
  if (sourceText.length > 120_000) throw new ContinuityError('continuity_context_too_large', 413)
  if (!EntryDocSchema.safeParse(doc).success) throw new ContinuityError('continuity_evidence_invalid', 400)
  for (const item of doc.items) {
    for (const evidence of item.evidence) {
      if (evidence.end > sourceText.length || sourceText.slice(evidence.start, evidence.end) !== evidence.quote) {
        throw new ContinuityError('continuity_evidence_invalid', 400)
      }
    }
  }
}
