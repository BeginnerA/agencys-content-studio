// [M29·R02] 内容/参考版本与下游影响追踪的前端领域类型（与 routes/versions.ts 响应对齐）
import type { Asset } from './base'

export type VersionPayloadKind = 'file' | 'json'
export type VersionSource =
  | 'baseline'
  | 'edit'
  | 'import'
  | 'generate'
  | 'ref-upload'
  | 'ref-gen'
  | 'polish'
  | 'restore'

/** 对象版本链条目（GET /assets/:id/versions、/entities/:id/versions） */
export interface ContentVersionView {
  id: number
  objKind: 'asset' | 'entity'
  objId: number
  revision: number
  payloadKind: VersionPayloadKind
  sha256: string | null
  label: string | null
  source: VersionSource
  isCurrent: boolean
  createdAt: number
}

export interface VersionListResult {
  items: ContentVersionView[]
  currentRevision: number
}

/** 下游影响行（GET /assets/:id/impact、/entities/:id/impact）——只报告，不生成 */
export interface ImpactRow {
  snapshotId: number
  execKind: 'pipeline_step' | 'canvas_task' | 'shot_task' | 'unknown'
  runId: number | null
  stepId: number | null
  taskId: number | null
  role: string
  shotId: string | null
  used: number
  versionRevision: number | null
  currentRevision: number
  /** upstream_changed=捕获版本落后当前；current=一致；no_history=旧数据无版本指针（不可恢复） */
  status: 'upstream_changed' | 'current' | 'no_history'
  frozenAt: number
}

export interface ImpactResult {
  items: ImpactRow[]
  total: number
}

/** 锁定的下次执行输入（GET/POST/DELETE /canvas/nodes/:id/input-lock[s]） */
export interface InputLockView {
  upstreamNodeId: number
  assetId: number
}

export interface RestoreAssetResult {
  asset: Asset
  revision: number
}
