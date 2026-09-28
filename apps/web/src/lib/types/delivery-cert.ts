// 第五期 · 交付包认证：只读认证报告的视图类型（与后端 services/delivery-cert/types.ts 逐字段对齐，camelCase）。
// 面板仅渲染后端返回的结构良构 / 时长数学 / 跨格式一致 / 媒体可定位 / 时轴绑定 / 字幕交付 客观结论 + 缺项清单
// ——不在前端推算帧 / 时长 / verdict（规格 §3/§6）。editor_import 恒列待人工实测，结构认证 ≠ 编辑器通过。

/** 认证项目录（规格 §4）。外部项仅 editor_import_certified，恒不自动 passed。 */
export type CertCheckKey =
  | 'package_present'
  | 'project_file_wellformed'
  | 'duration_math_consistent'
  | 'cross_format_consistency'
  | 'media_refs_resolvable'
  | 'timeline_source_bound'
  | 'subtitle_delivery_bound'
  | 'editor_import_certified'

/** 单条结论状态（复用第一期 result 词表）。 */
export type CertStatus = 'passed' | 'failed' | 'not_tested' | 'unsupported' | 'not_applicable' | 'stale'

/** 证据类型（复用第一期 evidenceType 词表）。 */
export type CertEvidenceType = 'metadata' | 'local_measurement' | 'offline_probe' | 'manual_review'

/** 认证/解析来源（本期域特化：认证对象是导出工程包，非成片 mp4）。 */
export type CertSource = 'zip' | 'project_file' | 'manifest' | 'params.timeline' | 'media_fs' | 'manual'

/** 三种工程交换格式（与 edit-exchange 同源）。 */
export type CertFormat = 'fcpxml' | 'edl' | 'otio'

/** 交付可信四态（规格 §3：verdict 天花板 = 至多 needs_attention，editor_import 恒缺项）。 */
export type CertVerdict = 'package_sound' | 'needs_attention' | 'package_broken' | 'needs_package'

/** 单条认证结论。 */
export interface CertCheckView {
  key: CertCheckKey
  status: CertStatus
  evidenceType: CertEvidenceType
  source: CertSource
  value?: number | string | boolean | null
  reason?: string
}

/** 一次交付包认证报告（与后端 DeliveryCert 对齐；缓存于 export 资产 params.cert，零新列）。 */
export interface DeliveryCertView {
  runId: number
  /** 被认证的 edit_exchange archive 资产 id；无包 → null（verdict=needs_package）。 */
  packageAssetId: number | null
  format: CertFormat
  checkedAt: number
  /** 交付包 zip 文件哈希；变化使旧报告 stale。缺失为 null。 */
  packageSha256: string | null
  verdict: CertVerdict
  /** 未满足/待人工项的机读键。 */
  missing: string[]
  checks: CertCheckView[]
  /** 端点 refresh=0 命中缓存时置 true。 */
  fromCache?: boolean
}
