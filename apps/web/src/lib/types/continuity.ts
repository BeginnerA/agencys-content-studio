// ===== 此前连续性域类型（镜像 apps/server/src/routes/continuity.ts 的 HTTP 契约，camelCase）=====
// 只镜像前端必要面；不 import 服务端/DB。字段与 contract.ts 的 zod schema 一一对应。

export interface ContinuityUnit {
  projectId: number
  scopeKind: 'series'
  scopeId: number
  unitKind: 'episode'
  unitId: number
  unitOrdinal: number
}

export interface DocRef {
  assetId: number
  versionId: number
  hash: string
}

export interface EntryRef extends DocRef {
  entryId: number
  unitOrdinal: number
}

export interface ItemRef extends EntryRef {
  itemId: string
}

export interface SourcePick {
  runId: number
  stepId: number
  assetId: number
  versionId: number
}

export type ContinuityHistory = 'known' | 'history_unavailable'

export interface ContinuitySource extends SourcePick {
  templateKey: string
  templateSnapshotHash: string
  stepKey: string
  hash: string
  outputHash: string
  gateHash: string
  fingerprint: string
  history: ContinuityHistory
  inheritedViaRunId: number | null
}

export interface ContinuitySubject {
  key: string
  label: string
  entityId: number | null
  aliases: string[]
}

export interface ContinuityTopic {
  key: string
  label: string
}

export interface Evidence {
  start: number
  end: number
  quote: string
}

export interface ContinuityItem {
  id: string
  topicKey: string
  channel: 'fact' | 'plan' | 'knowledge'
  operation: 'set' | 'close' | 'retract'
  subjects: string[]
  value: string
  previous: ItemRef | null
  evidence: Evidence[]
  origin: 'extracted' | 'manual' | 'edited'
  editNote: string
  included: boolean
  knower?: string
  epistemic?: 'knows' | 'believes' | 'unaware' | 'unknown'
}

export interface EntryDoc {
  schemaVersion: 1
  unit: ContinuityUnit
  source: ContinuitySource
  basis: EntryRef[]
  history: ContinuityHistory
  subjects: ContinuitySubject[]
  topics: ContinuityTopic[]
  items: ContinuityItem[]
  warnings: string[]
  noChanges: boolean
  releasedBasis: Array<{ ref: EntryRef; reason: string }>
}

export interface EntryView {
  id: number
  revision: number
  status:
    'extracting' | 'failed' | 'unknown' | 'draft' | 'confirmed' | 'superseded'
  operationKey: string
  validity: 'valid' | 'stale' | 'missing' | 'corrupt'
  history: ContinuityHistory
  warningsHash: string
  currentConfirmedId: number | null
  errorCode: string | null
  document: DocRef | null
  doc: EntryDoc | null
}

export interface SourceCandidate {
  runId: number
  stepId: number
  stepKey: string
  title: string
  assetId: number
  versionId: number | null
  versions: DocRef[]
  currentHash: string
  confirmable: boolean
  reasons: string[]
  declaredRole: boolean
  inheritedViaRunId: number | null
}

export interface ExtractPreview {
  source: ContinuitySource
  basis: EntryRef[]
  previewHash: string
  inputChars: number
  warnings: string[]
  estimatedCost: number | null
}

export type TargetRequest =
  | {
      kind: 'manual'
      episodeId: number
      templateKey: string
      input: Record<string, unknown>
    }
  | {
      kind: 'route'
      sessionId: number
      decisionRevision: number
      decisionHash: string
    }
  | {
      kind: 'workflow'
      workflowId: number
      nextSeq: number
      previousRunId: number | null
    }
  | { kind: 'resume'; runId: number }

export interface Gap {
  key: string
  unitOrdinal: number
  kind: 'missing_entry' | 'invalid_entry' | 'history_unavailable'
  entryId: number | null
  fingerprint: string
}

export interface Acceptance {
  key: string
  fingerprint: string
  reason: string
}

export interface DuplicateCostAcceptance {
  useId: number
  accepted: true
}

export interface ContinuityTarget {
  unit: ContinuityUnit
  request: TargetRequest
  templateKey: string
  templateSnapshotHash: string
  stepKey: string
  inputHash: string
  configHash: string
}

export interface ContextDoc {
  schemaVersion: 1
  rendererVersion: 1
  target: ContinuityTarget
  entries: EntryRef[]
  dependencies: Array<{ from: EntryRef; to: EntryRef }>
  gaps: Gap[]
  acceptedGaps: Acceptance[]
  includePlans: boolean
  rendered: string
  renderedHash: string
  previewHash: string
  duplicateCostAcceptance: DuplicateCostAcceptance | null
}

export interface Preview {
  doc: ContextDoc
  chars: number
  maxChars: number
  canFreeze: boolean
  blockers: string[]
  unknownUseId: number | null
}

export interface Approval {
  contextId: number
  document: DocRef
  approvalHash: string
}

export interface ConfirmRequest {
  expectedRevision: number
  document: DocRef
  sourceFingerprint: string
  warningsHash: string
  expectedCurrentConfirmedId: number | null
  acceptedWarnings: string[]
  approvalKey: string
}

export interface ExtractRequestBody {
  source: SourcePick
  previewHash: string
  operationKey: string
  allowModelCall: true
  acceptUnpriced: boolean
}

export interface ReviewRequestBody {
  parentId: number
  source: SourcePick
  operationKey: string
}

export interface PatchRequestBody {
  expectedRevision: number
  doc: EntryDoc
}

export interface SnapshotRequestBody {
  runId: number
  stepId: number
  assetId: number
  seenHash: string
}

export interface ContinuityImpactRow {
  recordId: number
  kind: 'entry' | 'use'
  unitOrdinal: number
  runId: number | null
  stepId: number | null
  state: string
  document: DocRef | null
  reason: string
  inheritedViaRunId: number | null
}

export interface ContinuityImpactView {
  direct: ContinuityImpactRow[]
  indirect: ContinuityImpactRow[]
  unknown: ContinuityImpactRow[]
}
