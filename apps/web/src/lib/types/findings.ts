// M69 审片问题单：与 apps/server/src/services/review/service.ts 的视图逐字段对齐。
// 前端不推算状态/证据/能力，全部以后端投影为准。

export type ReviewScopeKind = 'shot' | 'time' | 'global'
export type ReviewCategory =
  'visual' | 'prop' | 'lip_sync' | 'subtitle' | 'audio' | 'pacing' | 'other'
export type ReviewSeverity = 'blocker' | 'major' | 'minor'
export type ReviewStatus =
  'open' | 'in_rework' | 'pending_recheck' | 'verified' | 'dismissed'
export type RecheckState = 'changed' | 'unchanged' | 'unverifiable'

export interface FindingCan {
  link: boolean
  markRework: boolean
  recheck: boolean
  verify: boolean
  reopen: boolean
  dismiss: boolean
}

export interface FindingLocation {
  startMs: number
  endMs: number
  inRange: boolean
}

export interface FindingView {
  id: number
  stepKey: string
  baseFinalAssetId: number
  /** 基准成片资产行仍存在且未删（决定「看返修前」是否可用；文件缺失另由播放器 error 兜底） */
  baseAvailable: boolean
  scopeKind: ReviewScopeKind
  shotId: string | null
  startMs: number | null
  endMs: number | null
  category: ReviewCategory
  severity: ReviewSeverity
  note: string
  status: ReviewStatus
  reworkRequestId: string | null
  reworkNote: string | null
  createdAt: number
  updatedAt: number
  resolvedAt: number | null
  recheck: {
    state: RecheckState
    finalAssetId: number
    note: string
    at: number
  } | null
  resolutionNote: string | null
  needsRecheck: boolean
  staleRecheck: boolean
  currentLocation: FindingLocation | null
  can: FindingCan
}

export interface FindingsList {
  stepKey: string
  capability: {
    readable: boolean
    writable: boolean
    has_timeline: boolean
    code:
      | 'ok'
      | 'run_active'
      | 'run_cancelled'
      | 'no_final'
      | 'degraded_no_timeline'
    message: string
  }
  final: {
    assetId: number
    durationMs: number | null
    createdAt: number
  } | null
  timeline: {
    totalMs: number
    introMs: number
    outroMs: number
    segments: Array<{
      shotId: string | null
      assetId: number | null
      kind: string
      startMs: number
      endMs: number
      durMs: number
    }>
  } | null
  findings: FindingView[]
  summary: {
    total: number
    open: number
    in_rework: number
    pending_recheck: number
    verified: number
    dismissed: number
    blockers_open: number
  }
}

export interface FindingScopeInput {
  kind: ReviewScopeKind
  shot_id?: string
  start_ms?: number
  end_ms?: number
}
