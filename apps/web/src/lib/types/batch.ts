import type { RunStatus } from './base'

// ===== [M4] 批次 / 用量 / 统计 / 导出 / 发布 =====

export type BatchStatus =
  'running' | 'completed' | 'partial_failed' | 'failed' | 'cancelled'

export interface Batch {
  id: number
  projectId: number
  templateKey: string
  name: string
  status: BatchStatus
  schedule: { max_concurrent?: number }
  total: number
  finished: number
  succeeded: number
  failed: number
  createdAt: number
  updatedAt: number
}

export interface BatchRunLite {
  id: number
  batchSeq: number | null
  status: RunStatus
  error: string | null
  input: Record<string, unknown> | null
  cost: number | null
  startedAt: number | null
  completedAt: number | null
  createdAt: number
}

export interface BatchDetail {
  batch: Batch
  runs: BatchRunLite[]
}

/** GET /stats/usage 响应（用量聚合） */
export interface UsageItem {
  key: string
  quantity: number
  cost: number
  unpriced: number
  count: number
}

export interface UsageSummary {
  items: UsageItem[]
  totals: { quantity: number; cost: number; unpriced: number }
}

/** GET /stats/overview 响应（看板六区块） */
export interface Overview {
  projects: number
  runs: { total: number; byStatus: Record<string, number>; successRate: number }
  cost: { total: number; last30d: number }
  assets: { total: number; byKind: Record<string, number> }
  activity: Array<{ day: string; runs: number; cost: number }>
  activeDays: number
  publications: { total: number; views: number; interactions: number }
}

/** 导出包（POST /runs/:id/exports、GET /exports） */
export interface ExportAssetLite {
  id: number
  projectId: number
  runId: number | null
  kind: string
  purpose: string | null
  name: string
  mime: string | null
  ext: string | null
  fileSize: number | null
  width: number | null
  height: number | null
  duration: number | null
  tags: unknown
  createdAt: number
  updatedAt: number
}

/** run 产物（GET /runs/:id/assets，导出向导数据源） */
export interface RunAssetLite extends ExportAssetLite {
  stepId: number | null
  sha256: string | null
}

export interface Publication {
  id: number
  projectId: number
  runId: number | null
  assetId: number | null
  platform: string
  url: string | null
  publishedAt: number | null
  metrics: Record<string, number> | null
  title: string | null
  abGroup: string | null
  note: string | null
  createdAt: number
  updatedAt: number
}

// ===== [M14] 剧集实体（series → episodes 两级，一项目一剧） =====

/** [M14] 剧（系列） */
export interface SeriesInfo {
  id: number
  projectId: number
  name: string
  totalEpisodes: number
  contentAssetId: number | null
  createdAt: number
  updatedAt: number
}

/** [M14] 集（status 为派生展示态：最新 run 状态优先；rowStatus 为行原值，编辑回显用） */
export interface Episode {
  id: number
  projectId: number
  seriesId: number
  number: number
  title: string | null
  status: string
  rowStatus: string
  contentAssetId: number | null
  latestRunId: number | null
  runStatus: string | null
  createdAt: number
  updatedAt: number
}
