/**
 * 第四期 · 统一 QC 面板：核验报告数据契约（规格 2026-09-28 §3/§4）。
 *
 * 本模块是**纯类型 + 常量**，不触 DB、不触执行、不 import 引擎——qc-panel 全链路只读、零付费、零模型。
 * 结果词表（status）与证据口径（evidenceType）与第一期 production-baseline §5.3 逐字对齐，避免两套口径漂移；
 * 时间轴一律读成片 `params.timeline`（唯一真源），严禁在此反推重建第二套时轴。
 */

/** 检查项目录（规格 §4）。主观项仅 `manual_quality_review` 一项，恒不自动 passed。 */
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

/** 单条结论状态：复用第一期 result 词表（passed/failed/not_tested/unsupported/not_applicable/stale）。 */
export type QcStatus = 'passed' | 'failed' | 'not_tested' | 'unsupported' | 'not_applicable' | 'stale'

/** 证据类型：复用第一期 evidenceType 词表（本期仅四类，无 editor_import / provider_measurement）。 */
export type QcEvidenceType = 'metadata' | 'local_measurement' | 'offline_probe' | 'manual_review'

/** 测量/判定来源（诚实可追溯）：本地 ffprobe / 唯一真源快照 / 返修台账 / run 级合成配置 / 成片 params / 人工。 */
export type QcSource = 'ffprobe' | 'params.timeline' | 'rework_ledger' | '_compose' | 'asset_params' | 'manual'

/** 交付就绪三态（Q1：只读判定，绝不反写 delivery_checked / 放行批准）。 */
export type QcVerdict = 'ready' | 'needs_review' | 'not_ready'

/** 单条核验结论。缺测值用 null（禁 null→0 填充由消费侧保证）；除 passed 外 reason 必填。 */
export interface QcCheck {
  key: QcCheckKey
  status: QcStatus
  evidenceType: QcEvidenceType
  source: QcSource
  /** 实测/判定值；缺测 null。标量便于直接渲染；复合测量以字符串摘要承载。 */
  value?: number | string | boolean | null
  /** 除 passed 外必填：失败/未测/不支持/过期的原因。 */
  reason?: string
}

/** 一次成片质量核验报告（可缓存进 assets.params.qc，零新列；镜像 params.quality 的 merge + checkedAt 范式）。 */
export interface QcReport {
  runId: number
  finalAssetId: number
  /** 毫秒时间戳，保留原值。 */
  checkedAt: number
  /** 测得成片文件哈希；变化使旧报告 stale。缺失（文件不可读）为 null。 */
  mediaSha256: string | null
  verdict: QcVerdict
  /** 未满足项的机读键（对齐第一期 manifest.missing[]）。 */
  missing: string[]
  checks: QcCheck[]
  /** 端点 refresh=0 命中缓存时置 true；按需重算缺省 undefined。 */
  fromCache?: boolean
}

/** 实测成片时长 vs params.timeline Σ 的容差（秒）。容器取整会有亚秒误差，取保守带宽。 */
export const QC_DURATION_TOLERANCE_SEC = 0.5

/** 门禁结果：能力不足时不产报告，只返回原因（no_final_video 与 no_timeline 语义分列，见规格 §6/§7）。 */
export type QcGateBlock = 'run_not_found' | 'no_final_video'

export type QcRunResult =
  | { outcome: 'ok'; report: QcReport }
  | { outcome: 'blocked'; code: QcGateBlock; message: string }
