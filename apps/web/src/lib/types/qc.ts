// 第四期 · 统一 QC 面板：只读核验报告的视图类型（与后端 services/qc/types.ts 逐字段对齐，camelCase）。
// 面板仅渲染后端返回的客观事实 / 一致性结论 / 缺项清单——不在前端推算 Σ、clamp 或 verdict（规格 §6）。

/** 检查项目录（规格 §4）。 */
export type QcCheckKey =
  | 'file_readable'
  | 'stream_spec'
  | 'duration_vs_timeline'
  | 'timeline_source'
  | 'rework_receipt_consistency'
  | 'shot_duration_applied'
  | 'subtitle_alignment_present'
  | 'audio_peak'
  | 'delivery_flag'
  | 'manual_quality_review'

/** 单条结论状态（复用第一期 result 词表）。 */
export type QcStatus = 'passed' | 'failed' | 'not_tested' | 'unsupported' | 'not_applicable' | 'stale'

/** 证据类型（复用第一期 evidenceType 词表）。 */
export type QcEvidenceType = 'metadata' | 'local_measurement' | 'offline_probe' | 'manual_review'

/** 测量/判定来源。 */
export type QcSource = 'ffprobe' | 'params.timeline' | 'rework_ledger' | '_compose' | 'asset_params' | 'manual'

/** 交付就绪三态。 */
export type QcVerdict = 'ready' | 'needs_review' | 'not_ready'

/** 单条核验结论。 */
export interface QcCheckView {
  key: QcCheckKey
  status: QcStatus
  evidenceType: QcEvidenceType
  source: QcSource
  value?: number | string | boolean | null
  reason?: string
}

/** 一次成片质量核验报告。 */
export interface QcReportView {
  runId: number
  finalAssetId: number
  checkedAt: number
  mediaSha256: string | null
  verdict: QcVerdict
  missing: string[]
  checks: QcCheckView[]
  fromCache?: boolean
}
