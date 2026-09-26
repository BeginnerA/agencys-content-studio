/**
 * 精确返修（precision-rework）前端契约类型：与 apps/server/src/services/rework/ 的
 * 读模型投影（readmodel.ts）、结构化预览（preview.ts）、变更契约（contract.ts）、
 * 应用回执（apply.ts）逐字段对齐；前端不重新实现任何费用/影响/过期判断（规格 §4/§9）。
 */

/** 可编辑字幕 cue（最终成片绝对轴，整数毫秒；与后端 SubtitleCue 同形） */
export interface SubtitleCueView {
  id: string
  startMs: number
  endMs: number
  text: string
}

/** 领域错误（code 供程序分支；cueId 供 UI 定位到行） */
export interface ReworkErrorView {
  code: string
  message: string
  cueId?: string
}

/** 能力门禁判定（不支持时 code/message 即真实原因，UI 不伪造可编辑态） */
export interface SubtitleCapabilityView {
  supported: boolean
  code: string
  message: string
}

/** 字幕版本历史条目（每条固定 versionId 与不可变文件下载引用） */
export interface SubtitleVersionView {
  version_id: number
  revision: number
  sha256: string | null
  source: string
  label: string | null
  is_current: boolean
  parent_version_id: number | null
  request_id: string | null
  change_summary: string
  download_url: string
  created_at: number
}

/** 当前人工修订指针（run.input._subtitleEdits[stepKey]；stale 与合成期复验同一口径） */
export interface SubtitleEditRefView {
  assetId: number
  versionId: number
  sha256: string
  baseFingerprint: string
  requestId: string
  stale: boolean
  stale_reason: 'ok' | 'fingerprint_drift' | 'unverifiable'
}

/** GET /runs/:id/subtitles 读模型四态投影 */
export interface SubtitleReadModelView {
  capability: SubtitleCapabilityView
  step_key: string
  baseline: {
    run_id: number
    final_asset_id: number
    duration_ms: number
    origin: 'source' | 'manual'
    source_ref: { assetId: number | null; sha256: string; timingSource: string }
    cues: SubtitleCueView[]
  } | null
  current_edit: SubtitleEditRefView | null
  versions: SubtitleVersionView[]
  review: {
    gate_required: boolean
    decision: 'approve' | 'reject' | 'skip' | null
    state: string
    note: string
  }
  output: {
    compose_status: string | null
    final_asset_id: number | null
    current_version_in_final: boolean
    pending_recompose: boolean
  }
}

/** 单一变更契约（只改既有 cue；数量与顺序不变，服务端为唯一裁决） */
export type SubtitleChangeView =
  | { kind: 'subtitle-text'; cueId: string; text: string }
  | { kind: 'subtitle-time'; cueId: string; startMs: number; endMs: number }
  | { kind: 'subtitle-shift'; cueIds: string[]; deltaMs: number }

/** 单 cue 单字段前后差异（time 拆 start/end 两行，UI 就近显示） */
export interface SubtitleDiffView {
  cueId: string
  field: 'text' | 'startMs' | 'endMs'
  before: string | number
  after: string | number
}

/** 影响说明（服务端编译，前端只展示不推算） */
export interface SubtitleImpactView {
  localOnly: true
  modelCalls: 0
  resetSteps: string[]
  keepNotes: string[]
  newReviewRequired: true
  subtitleBurn: boolean
}

/** 固定预览（previewHash 为确认回执，逐字回传） */
export interface SubtitlePreviewView {
  stepKey: string
  baseFingerprint: string
  previewHash: string
  durationMs: number
  baseCues: SubtitleCueView[]
  finalCues: SubtitleCueView[]
  diffs: SubtitleDiffView[]
  effectiveSha256: string
  origin: 'manual'
  impact: SubtitleImpactView
  risks: string[]
}

/** POST preview 响应 */
export interface PreviewResponseView {
  outcome: 'ready' | 'replayed'
  request_id: string
  preview: SubtitlePreviewView
}

/** 应用回执（apply 成功/回放结果；enqueued=已入队本地续跑） */
export interface SubtitleApplyReceiptView {
  runId: number
  stepKey: string
  assetId: number
  versionId: number
  sha256: string
  revision: number
  baseFingerprint: string
  previewHash: string
  enqueued: true
  appliedAt: number
}

/** POST apply 响应 */
export interface ApplyResponseView {
  outcome: 'applied' | 'replayed'
  request_id: string
  result: SubtitleApplyReceiptView
}

/** GET /runs/:id/rework/:requestId 回放视图（刷新/响应丢失后恢复现场） */
export interface ReworkRequestView {
  id: string
  runId: number
  stepKey: string
  state: 'parsing' | 'uncertain' | 'ready' | 'blocked' | 'applied'
  baseFingerprint: string | null
  preview: SubtitlePreviewView | { errors?: ReworkErrorView[] } | Record<string, never>
  result: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/* ===== 合成输入本地返修（切片2）：与 apps/server services/rework/compose-input* 逐字段对齐 ===== */

/** 能力门禁判定（不支持时 code/message 即真实原因，UI 不伪造可返修态） */
export interface ComposeInputCapabilityView {
  supported: boolean
  code: string
  message: string
}

/** GET capability 响应 */
export interface ComposeInputCapabilityResponse {
  capability: ComposeInputCapabilityView
  final_asset_id: number | null
}

/** 单一变更契约（四类均本地重合成、零付费；服务端为唯一裁决） */
export type ComposeInputChangeView =
  | { kind: 'compose-config'; patch: Record<string, unknown> }
  | { kind: 'bgm'; assetId: number | null }
  | { kind: 'sfx'; shotId: string; assetId: number | null }
  | { kind: 'shot-select'; shotId: string; assetId: number }

/** 逐处旧→新差异（compose-config 按被改键一行；bgm/sfx/shot-select 按目标一行） */
export interface ComposeInputDiffView {
  kind: ComposeInputChangeView['kind']
  field: string
  before: unknown
  after: unknown
}

/** 影响声明（服务端编译，前端只展示不推算） */
export interface ComposeInputImpactView {
  localReencode: true
  modelCalls: 0
  charged: false
  resetSteps: string[]
  keepNotes: string[]
  newReviewRequired: true
}

/** 固定预览（previewHash 为确认回执，逐字回传） */
export interface ComposeInputPreviewView {
  stepKey: string
  baseFingerprint: string
  previewHash: string
  finalAssetId: number
  currentConfig: Record<string, unknown>
  bgmAssetId: number | null
  diffs: ComposeInputDiffView[]
  impact: ComposeInputImpactView
  risks: string[]
}

/** POST compose-input preview 响应 */
export interface ComposeInputPreviewResponse {
  outcome: 'ready' | 'replayed'
  request_id: string
  preview: ComposeInputPreviewView
}

/** 应用回执（applied 成功/回放结果；enqueued=已入队本地续跑） */
export interface ComposeInputApplyReceiptView {
  runId: number
  stepKey: string
  baseFingerprint: string
  previewHash: string
  resetSteps: string[]
  gateInvalidated: boolean
  bgmFrom: number | null
  bgmTo: number | null
  selections: Array<{ shotId: string; fromAssetId: number; toAssetId: number }>
  enqueued: true
  appliedAt: number
}

/** POST compose-input apply 响应 */
export interface ComposeInputApplyResponse {
  outcome: 'applied' | 'replayed'
  request_id: string
  result: ComposeInputApplyReceiptView
}
