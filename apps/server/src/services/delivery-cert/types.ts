/**
 * 第五期 · 交付包认证：数据契约（规格 2026-09-28 §3/§4）。
 *
 * 本模块是**纯类型 + 常量**，不触 DB、不触执行、不 import 引擎、不 IO——delivery-cert 全链路只读、零付费、零模型、零新依赖。
 * 结果词表（status）与证据口径（evidenceType）与第一期 production-baseline §5.3、第四期 qc/types.ts 逐字对齐，避免两套口径漂移；
 * source 按本期域特化（认证对象是**导出工程包**，非成片 mp4）；时间轴只读交叉核对成片 `params.timeline`（唯一真源），严禁反推重建第二套时轴。
 */

/** 认证项目录（规格 §4）。外部项仅 `editor_import_certified` 一项，恒不自动 passed。 */
export type CertCheckKey =
  | 'package_present'
  | 'project_file_wellformed'
  | 'duration_math_consistent'
  | 'cross_format_consistency'
  | 'media_refs_resolvable'
  | 'timeline_source_bound'
  | 'subtitle_delivery_bound'
  | 'editor_import_certified'

/** 单条结论状态：复用第一期/第四期 result 词表（passed/failed/not_tested/unsupported/not_applicable/stale）。 */
export type CertStatus = 'passed' | 'failed' | 'not_tested' | 'unsupported' | 'not_applicable' | 'stale'

/** 证据类型：复用第一期/第四期 evidenceType 词表（本期四类）。 */
export type CertEvidenceType = 'metadata' | 'local_measurement' | 'offline_probe' | 'manual_review'

/** 认证/解析来源（诚实可追溯）：交付包 zip / 工程文件 / manifest / 唯一真源快照 / 包内媒体文件系统 / 人工。 */
export type CertSource = 'zip' | 'project_file' | 'manifest' | 'params.timeline' | 'media_fs' | 'manual'

/** 三种工程交换格式（与 edit-exchange 同源）。 */
export type CertFormat = 'fcpxml' | 'edl' | 'otio'

/**
 * 交付可信四态（Q2：verdict 天花板 = 至多 needs_attention，editor_import 恒缺项）。
 * needs_package = 该 run 尚无已生成包（不为认证自动造包）；package_broken = 客观自动项有 failed/stale；
 * needs_attention = 无 failed 但存在 not_tested/manual（含 editor_import 恒此类）；package_sound = 全适用自动项 passed 且无 editor 缺项（实际不达，保留语义位）。
 */
export type CertVerdict = 'package_sound' | 'needs_attention' | 'package_broken' | 'needs_package'

/** 单条认证结论。缺测值用 null（禁 null→0 填充由消费侧保证）；除 passed 外 reason 必填。 */
export interface CertCheck {
  key: CertCheckKey
  status: CertStatus
  evidenceType: CertEvidenceType
  source: CertSource
  /** 实测/判定值；缺测 null。标量便于直接渲染；复合以字符串摘要承载。 */
  value?: number | string | boolean | null
  /** 除 passed 外必填：失败/未测/不支持/不适用/过期的原因。 */
  reason?: string
}

/** 一次交付包认证报告（可缓存进 export 资产 params.cert，零新列；镜像 params.qc 的 merge + checkedAt 范式）。 */
export interface DeliveryCert {
  runId: number
  /** 被认证的 edit_exchange archive 资产 id；无包 → null（verdict=needs_package）。 */
  packageAssetId: number | null
  format: CertFormat
  /** 毫秒时间戳，保留原值。 */
  checkedAt: number
  /** 交付包 zip 文件哈希；变化使旧报告 stale。缺失为 null。 */
  packageSha256: string | null
  verdict: CertVerdict
  /** 未满足/待人工项的机读键（对齐第一期 manifest.missing[]）。 */
  missing: string[]
  checks: CertCheck[]
  /** 端点 refresh=0 命中缓存时置 true；按需重算缺省 undefined。 */
  fromCache?: boolean
}

/** 时长/时码数学容差（帧）。有理秒与 NDF 时码取整会有 ±1 帧抖动，取保守带宽。 */
export const CERT_DURATION_TOLERANCE_FRAMES = 1

/** 门禁结果：run 不存在时不产报告（无包不阻断，产 needs_package 报告，见规格 §3/§7）。 */
export type CertGateBlock = 'run_not_found'

export type CertRunResult =
  | { outcome: 'ok'; cert: DeliveryCert }
  | { outcome: 'blocked'; code: CertGateBlock; message: string }
